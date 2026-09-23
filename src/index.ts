/**
 * pi-openrouter-live-models
 *
 * Always-fresh OpenRouter model list for pi.
 *
 * Features:
 * - Fetches live models from https://openrouter.ai/api/v1/models at startup
 * - Caches locally with a configurable TTL (default 24h)
 * - Replaces the static model list via pi.registerProvider()
 * - Registers /ormodels command: enhanced model selector with provider
 *   filters, modality filters, sorting, and fuzzy search
 * - Force-refresh with /ormodels --refresh
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Image,
  getCapabilities,
  fuzzyFilter,
  matchesKey,
  Key,
  truncateToWidth,
  type Focusable,
} from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Constants ───────────────────────────────────────────────────────────────

const OR_API = "https://openrouter.ai/api/v1/models";
const CACHE_FILE = join(homedir(), ".pi", "agent", "openrouter-models-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MODELS_VISIBLE = 12; // max visible rows in model list

// ── OpenRouter API model shape ──────────────────────────────────────────────

interface ORModel {
  id: string;
  name: string;
  context_length: number;
  architecture: {
    modality: string;
    input_modalities: string[];
  };
  pricing: {
    prompt: string;
    completion: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  top_provider: {
    max_completion_tokens: number;
    is_moderated: boolean;
  };
  reasoning?: {
    supported_efforts?: string[];
  };
  supported_parameters: string[];
}

interface ORResponse {
  data: ORModel[];
}

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  fetchedAt: number;
  models: ORModel[];
}

function readCache(): CacheEntry | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(models: ORModel[]): void {
  try {
    const dir = join(homedir(), ".pi", "agent");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), models }, null, 2));
  } catch {
    // silently fail — cache is best-effort
  }
}

// ── API key resolution ──────────────────────────────────────────────────────

function resolveApiKey(): string | undefined {
  // 1. Environment variable
  const envKey = process.env["OPENROUTER_API_KEY"];
  if (envKey) return envKey;

  // 2. models.json
  try {
    const modelsPath = join(homedir(), ".pi", "agent", "models.json");
    if (existsSync(modelsPath)) {
      const config = JSON.parse(readFileSync(modelsPath, "utf-8")) as Record<string, unknown>;
      const providers = config["providers"] as Record<string, unknown> | undefined;
      const or = providers?.["openrouter"] as Record<string, unknown> | undefined;
      const key = or?.["apiKey"];
      if (typeof key === "string" && key.length > 0) return key;
    }
  } catch {
    /* ok */
  }

  return undefined;
}

// ── Model filtering & mapping ───────────────────────────────────────────────

/** True if the model should be included — exclude batch-only and known broken meta-models. */
function isStreamable(m: ORModel): boolean {
  // Batch variants don't support streaming
  if (m.id.endsWith(":batch")) return false;
  // Exclude specific OpenRouter routing meta-models that have no real endpoint
  const excludeIds = new Set([
    "openrouter/auto",
    "openrouter/auto-beta",
    "openrouter/free",
  ]);
  if (excludeIds.has(m.id)) return false;
  return true;
}

/** Extract the provider prefix from an OR model ID (e.g., "openai" from "openai/gpt-5-nano"). */
function providerPrefix(id: string): string {
  return id.split("/")[0] ?? "";
}

/** Map an OpenRouter API model to pi's ProviderModelConfig shape. */
function mapModel(m: ORModel) {
  const hasReasoning = m.supported_parameters.includes("reasoning");
  const hasImage = m.architecture.input_modalities.includes("image");

  const costInput = parseFloat(m.pricing.prompt || "0") * 1_000_000 || 0;
  const costOutput = parseFloat(m.pricing.completion || "0") * 1_000_000 || 0;
  const costCacheRead = parseFloat(m.pricing.input_cache_read || "0") * 1_000_000 || 0;
  const costCacheWrite = parseFloat(m.pricing.input_cache_write || "0") * 1_000_000 || 0;

  return {
    id: m.id,
    name: m.name,
    api: "openai-completions",
    reasoning: hasReasoning,
    input: hasImage ? ["text", "image"] as ("text" | "image")[] : ["text"] as ("text" | "image")[],
    cost: { input: costInput, output: costOutput, cacheRead: costCacheRead, cacheWrite: costCacheWrite },
    contextWindow: m.context_length || 128000,
    maxTokens: m.top_provider.max_completion_tokens || 4096,
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: "openrouter" as const,
    },
  };
}

// ── Fetch from API ──────────────────────────────────────────────────────────

async function fetchModels(apiKey: string): Promise<ORModel[]> {
  const res = await fetch(OR_API, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter API returned ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as ORResponse;
  return json.data.filter(isStreamable);
}

// ── Known zero-data-retention provider prefixes ───────────────────────────
// These providers have published policies of not retaining/training on API data.
// Source: OpenRouter provider docs. Keep this list updated.
const ZDR_PROVIDERS = new Set([
  "fireworks",
  "together",
  "groq",
  "deepinfra",
  "nvidia",
  "cerebras",
  "sambanova",
  "lepton",
  "novita",
  "hyperbolic",
  "inception",
  "kluster",
  "lambda",
  "arcee-ai",
  "ai21",
  "cohere",
  "mistralai",
]);

function isZdr(providerPrefix: string): boolean {
  return ZDR_PROVIDERS.has(providerPrefix);
}

// ── OpenRouter logo (base64 PNG, 80px tall for terminal rendering) ────────
const OR_LOGO_B64 = "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";

// ── TUI: Model selector component ───────────────────────────────────────────

interface ModelItem {
  id: string;
  name: string;
  providerPrefix: string;
  reasoning: boolean;
  hasImage: boolean;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxTokens: number;
  zdr: boolean;
}

type SortMode = "name" | "price-asc" | "price-desc" | "context";
type ModalityFilter = "all" | "text" | "image";
type ProviderFilter = "all" | Set<string>;

class OpenRouterModelSelector extends Container implements Focusable {
  // Focusable
  _focused = false;
  get focused() { return this._focused; }
  set focused(v: boolean) { this._focused = v; this.searchInput.focused = v; }

  private searchInput: Input;
  private logoImage: Image;
  private tui: any;
  private theme: any;
  private done: (id: string | null) => void;

  private allModels: ModelItem[] = [];
  private filteredModels: ModelItem[] = [];
  private selectedIdx = 0;

  // Filter state
  private searchQuery = "";
  private sortMode: SortMode = "name";
  private modalityFilter: ModalityFilter = "all";
  private providerFilter: ProviderFilter = "all";
  private showProviderPanel = false;
  private providerSelectedIdx = 0;
  private zdrOnly = false;

  // Derived — unique provider prefixes
  private allProviders: string[] = [];

  constructor(tui: any, theme: any, models: ModelItem[], done: (id: string | null) => void) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.done = done;

    this.allModels = models;
    this.allProviders = [...new Set(models.map(m => m.providerPrefix))].sort();
    this.providerFilter = "all";

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => this.selectCurrent();

    // OpenRouter logo — renders as image in supported terminals
    this.logoImage = new Image(OR_LOGO_B64, "image/png", {
      fallbackColor: (s: string) => theme.fg("accent", s),
    }, { maxWidthCells: 16, maxHeightCells: 4 });

    this.applyFilters();
  }

  // ── Filters ─────────────────────────────────────────────────────────────

  private applyFilters() {
    let models = this.allModels;

    // Provider filter + ZDR filter
    if (this.providerFilter !== "all") {
      models = models.filter(m => this.providerFilter.has(m.providerPrefix));
    }
    if (this.zdrOnly) {
      models = models.filter(m => m.zdr);
    }

    // Modality filter
    if (this.modalityFilter === "text") {
      models = models.filter(m => !m.hasImage);
    } else if (this.modalityFilter === "image") {
      models = models.filter(m => m.hasImage);
    }

    // Search (fuzzy)
    if (this.searchQuery) {
      models = fuzzyFilter(models, this.searchQuery, (m) =>
        `${m.id} ${m.name} ${m.providerPrefix} ${m.providerPrefix}/${m.id}`
      );
    }

    // Sort
    models = [...models];
    switch (this.sortMode) {
      case "name":
        models.sort((a, b) => a.id.localeCompare(b.id));
        break;
      case "price-asc":
        models.sort((a, b) => (a.inputPrice + a.outputPrice) - (b.inputPrice + b.outputPrice));
        break;
      case "price-desc":
        models.sort((a, b) => (b.inputPrice + b.outputPrice) - (a.inputPrice + a.outputPrice));
        break;
      case "context":
        models.sort((a, b) => b.contextWindow - a.contextWindow);
        break;
    }

    this.filteredModels = models;
    this.selectedIdx = Math.min(this.selectedIdx, Math.max(0, models.length - 1));
  }

  private selectCurrent() {
    const m = this.filteredModels[this.selectedIdx];
    if (m) this.done(m.id);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private _cachedWidth = 0;
  private _cachedLines: string[] = [];

  render(width: number): string[] {
    if (this._cachedWidth === width && this._cachedLines.length > 0) {
      return this._cachedLines;
    }
    this._cachedWidth = width;
    const t = this.theme;
    const lines: string[] = [];

    // ── Logo (terminal image if supported, otherwise text fallback) ───
    const caps = getCapabilities();
    if (caps.images) {
      // Render the OpenRouter logo PNG using terminal image protocol
      const logoLines = this.logoImage.render(Math.max(20, width - 2));
      for (const ll of logoLines) lines.push(ll);
      lines.push(t.fg("dim", `  OpenRouter — ${this.filteredModels.length} models`));
      lines.push("");
    } else {
      // Text-only fallback
      const orLogo = t.fg("accent", "⊗");
      const title = `${orLogo} OpenRouter Models`;
      const countStr = t.fg("dim", `(${this.filteredModels.length} models)`);
      const pad = Math.max(0, width - 26 - String(this.filteredModels.length).length);
      lines.push(t.fg("accent", `┌─ ${title} ${countStr} `) + t.fg("dim", "─".repeat(pad)));
    }

    // ── Search ──────────────────────────────────────────────────────────
    const inputLines = this.searchInput.render(width - 2);
    for (const il of inputLines) {
      lines.push(t.fg("muted", "│ ") + il);
    }

    // ── Filter bar ───────────────────────────────────────────────────────
    const sortLabels: Record<SortMode, string> = {
      "name": "name",
      "price-asc": "price ↑",
      "price-desc": "price ↓",
      "context": "context",
    };
    const modLabels: Record<ModalityFilter, string> = {
      "all": "all",
      "text": "text",
      "image": "img",
    };

    const sortStr = Object.entries(sortLabels).map(([k, v]) =>
      this.sortMode === k ? t.fg("accent", v) : t.fg("dim", v)
    ).join(" ");
    const modStr = Object.entries(modLabels).map(([k, v]) =>
      this.modalityFilter === k ? t.fg("accent", v) : t.fg("dim", v)
    ).join(" ");

    const provCount = this.providerFilter === "all"
      ? this.allProviders.length
      : this.providerFilter.size;
    const zdrTag = this.zdrOnly ? t.fg("success", " ZDR") : "";
    const provLabel = this.showProviderPanel
      ? t.fg("accent", `Providers (${provCount}/${this.allProviders.length})${zdrTag} ▾`)
      : t.fg("dim", `Providers ▸`);

    const filterBar = `${t.fg("muted", "│")} Sort: ${sortStr}  ${t.fg("muted", "|")} Modality: ${modStr}  ${t.fg("muted", "|")} ${provLabel} (P)`;
    lines.push(filterBar);
    lines.push(t.fg("muted", "├" + "─".repeat(Math.max(0, width - 1))));

    // ── Provider panel (replaces model list when open) ──────────────────
    if (this.showProviderPanel) {
      // Compact header
      const zdrIndicator = this.zdrOnly ? t.fg("success", " ZDR-only active") : "";
      lines.push(t.fg("muted", "│ ") + t.fg("dim", `Toggle providers — Space:toggle  a:all/none  z:zdr${zdrIndicator}  P/Esc:back`));
      lines.push("");

      const maxProv = 12;
      const provStart = Math.max(0, Math.min(
        this.providerSelectedIdx - Math.floor(maxProv / 2),
        this.allProviders.length - maxProv
      ));
      const provEnd = Math.min(provStart + maxProv, this.allProviders.length);

      for (let i = provStart; i < provEnd; i++) {
        const p = this.allProviders[i];
        const allEnabled = this.providerFilter === "all";
        const enabled = allEnabled || this.providerFilter.has(p);
        const modelCount = this.allModels.filter(m => m.providerPrefix === p).length;
        const sel = i === this.providerSelectedIdx;
        const cursor = sel ? t.fg("accent", "→") : " ";
        const check = enabled ? t.fg("success", "●") : t.fg("dim", "○");
        const name = sel ? t.fg("accent", p) : p;
        const count = t.fg("dim", `(${modelCount})`);
        const zdrBadge = isZdr(p) ? t.fg("success", " 🔒") : "";
        const line = `${cursor} ${check} ${name}  ${count}${zdrBadge}`;
        lines.push(truncateToWidth(line, width));
      }

      if (this.allProviders.length > maxProv) {
        lines.push(t.fg("dim", `  (${this.providerSelectedIdx + 1}/${this.allProviders.length})`));
      }
      lines.push("");
      lines.push(t.fg("muted", "├" + "─".repeat(Math.max(0, width - 1))));
      lines.push(t.fg("dim", "Provider filter active — P or Esc to return to model list"));
    } else {
    // ── Model list (only when provider panel is closed) ──────────────
    const maxVisible = MODELS_VISIBLE;
    const start = Math.max(0, Math.min(this.selectedIdx - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible));
    const end = Math.min(start + maxVisible, this.filteredModels.length);

    for (let i = start; i < end; i++) {
      const m = this.filteredModels[i];
      if (!m) continue;
      const sel = i === this.selectedIdx;
      const prefix = sel ? t.fg("accent", "→ ") : "  ";
      const idText = sel ? t.fg("accent", m.id) : m.id;
      const priceStr = `$${(m.inputPrice + m.outputPrice).toFixed(2)}/M`;
      const badges = [
        m.reasoning ? t.fg("warning", "R") : "",
        m.hasImage ? t.fg("accent", "I") : "",
        m.zdr ? t.fg("success", "Z") : "",
        t.fg("dim", `${(m.contextWindow / 1000).toFixed(0)}k`),
        t.fg("dim", priceStr),
      ].filter(Boolean).join(" ");
      const line = truncateToWidth(`${prefix}${idText}  ${badges}`, width);
      lines.push(line);
    }

    // ── Scroll indicator ────────────────────────────────────────────────
    if (this.filteredModels.length > maxVisible) {
      lines.push(t.fg("dim", `  (${this.selectedIdx + 1}/${this.filteredModels.length})`));
    }

    lines.push(t.fg("muted", "├" + "─".repeat(Math.max(0, width - 1))));

    // ── Model details ───────────────────────────────────────────────────
    const selected = this.filteredModels[this.selectedIdx];
    if (selected) {
      lines.push(t.fg("muted", "│ ") + t.fg("accent", t.bold(selected.name || selected.id)));
      lines.push(t.fg("muted", "│ ") + t.fg("dim", `id: ${selected.id}`));
      const ctxStr = `context: ${(selected.contextWindow / 1000).toFixed(0)}k`;
      const maxStr = `max out: ${(selected.maxTokens / 1000).toFixed(0)}k`;
      const inPrice = `$${selected.inputPrice.toFixed(2)}/M`;
      const outPrice = `$${selected.outputPrice.toFixed(2)}/M`;
      lines.push(t.fg("muted", "│ ") + t.fg("dim", `${ctxStr}  ${maxStr}  in:${inPrice}  out:${outPrice}`));
      const caps = [
        selected.reasoning ? "reasoning" : "",
        selected.hasImage ? "vision" : "",
      ].filter(Boolean).join(", ") || "text-only";
      lines.push(t.fg("muted", "│ ") + t.fg("dim", `caps: ${caps}`));
    } else {
      lines.push(t.fg("muted", "│ ") + t.fg("dim", "No models match filters"));
    }
    } // end else (model list mode)

    // ── Help bar ─────────────────────────────────────────────────────────
    lines.push(t.fg("muted", "└" + "─".repeat(Math.max(0, width - 1))));
    lines.push(t.fg("dim", "↑↓ nav  enter select  / search  S-sort  M-modality  P-providers  Z-zdr  esc cancel"));
    if (this.zdrOnly) {
      lines.push(t.fg("success", "  🔒 ZDR filter active — only zero-retention providers shown"));
    }

    this._cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    super.invalidate();
    this.logoImage?.invalidate();
    this._cachedWidth = 0;
    this._cachedLines = [];
  }

  // ── Input handling ─────────────────────────────────────────────────────

  handleInput(data: string): void {
    // ── Provider panel mode ─────────────────────────────────────────────
    if (this.showProviderPanel) {
      // Space = toggle current provider
      if (data === " ") {
        const p = this.allProviders[this.providerSelectedIdx];
        if (!p) return;
        if (this.providerFilter === "all") {
          // Switch to specific set — enable all except current
          this.providerFilter = new Set(this.allProviders.filter(x => x !== p));
        } else {
          if (this.providerFilter.has(p)) {
            this.providerFilter.delete(p);
          } else {
            this.providerFilter.add(p);
          }
          if (this.providerFilter.size === this.allProviders.length) {
            this.providerFilter = "all";
          }
          if (this.providerFilter.size === 0) {
            this.providerFilter = "all";
          }
        }
        this.applyFilters();
        this.invalidate();
        this.tui.requestRender();
        return;
      }

      // 'a' = toggle all / none
      if (data === "a") {
        this.providerFilter = this.providerFilter === "all" ? new Set() : "all";
        this.applyFilters();
        this.invalidate();
        this.tui.requestRender();
        return;
      }

      // 'z' = toggle ZDR-only filter
      if (data === "z") {
        this.zdrOnly = !this.zdrOnly;
        this.applyFilters();
        this.invalidate();
        this.tui.requestRender();
        return;
      }

      // Up in provider list
      if (matchesKey(data, Key.up)) {
        this.providerSelectedIdx = this.providerSelectedIdx === 0
          ? this.allProviders.length - 1
          : this.providerSelectedIdx - 1;
        this.invalidate();
        this.tui.requestRender();
        return;
      }

      // Down in provider list
      if (matchesKey(data, Key.down)) {
        this.providerSelectedIdx = this.providerSelectedIdx === this.allProviders.length - 1
          ? 0
          : this.providerSelectedIdx + 1;
        this.invalidate();
        this.tui.requestRender();
        return;
      }

      // P or Escape = close provider panel
      if (data === "P" || matchesKey(data, Key.escape)) {
        this.showProviderPanel = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }

      // Ignore other input in provider mode
      return;
    }

    // ── Model list mode ─────────────────────────────────────────────────

    // 'P' (capital) = toggle provider panel
    if (data === "P" && data.length === 1) {
      this.showProviderPanel = !this.showProviderPanel;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // 'S' (capital) = cycle sort
    if (data === "S" && data.length === 1) {
      const order: SortMode[] = ["name", "price-asc", "price-desc", "context"];
      const idx = order.indexOf(this.sortMode);
      this.sortMode = order[(idx + 1) % order.length];
      this.applyFilters();
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // 'M' (capital) = cycle modality
    if (data === "M" && data.length === 1) {
      const order: ModalityFilter[] = ["all", "text", "image"];
      const idx = order.indexOf(this.modalityFilter);
      this.modalityFilter = order[(idx + 1) % order.length];
      this.applyFilters();
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // 'Z' (capital) = toggle ZDR filter from model list
    if (data === "Z" && data.length === 1) {
      this.zdrOnly = !this.zdrOnly;
      this.applyFilters();
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // '/' = focus search (only when not already focused)
    if (data === "/" && !this.searchInput.focused) {
      this.searchInput.focused = true;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Up
    if (matchesKey(data, Key.up)) {
      if (this.filteredModels.length === 0) return;
      this.selectedIdx = this.selectedIdx === 0
        ? this.filteredModels.length - 1
        : this.selectedIdx - 1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Down
    if (matchesKey(data, Key.down)) {
      if (this.filteredModels.length === 0) return;
      this.selectedIdx = this.selectedIdx === this.filteredModels.length - 1
        ? 0
        : this.selectedIdx + 1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Enter
    if (matchesKey(data, Key.enter)) {
      this.selectCurrent();
      return;
    }

    // Escape
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }

    // Everything else → search input
    const prev = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    const next = this.searchInput.getValue();
    if (next !== prev) {
      this.searchQuery = next;
      this.applyFilters();
    }
    this.invalidate();
    this.tui.requestRender();
  }
}

// ── Extension ────────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    // Without an API key we can't fetch models. The static list still works.
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "openrouter-live-models: No OpenRouter API key found. Set OPENROUTER_API_KEY env var or configure in models.json.",
        "warning"
      );
    });
    // Still register /ormodels — it will show an error inside
  }

  let orModels: ORModel[] = [];

  // ── Load models (cache-first, then API) ───────────────────────────────────

  async function loadModels(forceRefresh = false): Promise<ORModel[]> {
    // Try cache first (unless forced)
    if (!forceRefresh) {
      const cached = readCache();
      if (cached) return cached.models;
    }

    // Fetch from API
    if (!apiKey) {
      throw new Error("No OpenRouter API key configured");
    }

    const models = await fetchModels(apiKey);
    writeCache(models);
    return models;
  }

  // ── Register all models with pi ────────────────────────────────────────

  function registerModels(models: ORModel[]) {
    const piModels = models.map(mapModel);
    // Sort by provider then id for sane ordering
    piModels.sort((a, b) => {
      const pa = a.id.split("/")[0] ?? "";
      const pb = b.id.split("/")[0] ?? "";
      return pa.localeCompare(pb) || a.id.localeCompare(b.id);
    });
    pi.registerProvider("openrouter", {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: apiKey,
      api: "openai-completions",
      models: piModels,
    });
    return piModels;
  }

  // ── Startup: fetch & register ──────────────────────────────────────────

  try {
    orModels = await loadModels();
    registerModels(orModels);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Don't throw — let the static models work as fallback.
    // Show a notification on session_start.
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(`openrouter-live-models: Failed to fetch models: ${msg}`, "warning");
    });
  }

  // ── /ormodels command ──────────────────────────────────────────────────

  pi.registerCommand("ormodels", {
    description: "Enhanced OpenRouter model selector with filters and search",
    handler: async (args, ctx) => {
      const forceRefresh = args?.trim() === "--refresh" || args?.trim() === "-r";

      // Refresh models if requested
      if (forceRefresh) {
        try {
          orModels = await loadModels(true);
          registerModels(orModels);
          ctx.ui.notify(`Loaded ${orModels.length} models from OpenRouter API`, "info");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Failed to refresh: ${msg}`, "error");
          return;
        }
      }

      // Build model items for the TUI
      const items: ModelItem[] = (orModels.length > 0 ? orModels : [])
        .map(m => ({
          id: m.id,
          name: m.name,
          providerPrefix: providerPrefix(m.id),
          reasoning: m.supported_parameters.includes("reasoning"),
          hasImage: m.architecture.input_modalities.includes("image"),
          inputPrice: parseFloat(m.pricing.prompt) * 1_000_000,
          outputPrice: parseFloat(m.pricing.completion) * 1_000_000,
          contextWindow: m.context_length,
          maxTokens: m.top_provider.max_completion_tokens,
          zdr: isZdr(providerPrefix(m.id)),
        }));

      if (items.length === 0) {
        ctx.ui.notify(
          "No OpenRouter models loaded. Try /ormodels --refresh or check your API key.",
          "warning"
        );
        return;
      }

      // Show the TUI selector
      const selectedId = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const selector = new OpenRouterModelSelector(tui, theme, items, done);
          return {
            render: (w: number) => selector.render(w),
            invalidate: () => selector.invalidate(),
            handleInput: (d: string) => selector.handleInput(d),
          };
        },
        { overlay: true }
      );

      if (!selectedId) return;

      // Set the selected model
      const model = ctx.modelRegistry.find("openrouter", selectedId);
      if (model) {
        const success = await pi.setModel(model);
        if (success) {
          ctx.ui.notify(`Model set to ${selectedId}`, "info");
        } else {
          ctx.ui.notify(`Could not set model ${selectedId} — check API key`, "error");
        }
      } else {
        ctx.ui.notify(`Model ${selectedId} not found in registry`, "error");
      }
    },
  });

  // ── Status indicator ──────────────────────────────────────────────────

  if (orModels.length > 0) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.setStatus("ormodels", ctx.ui.theme.fg("muted", `OR:${orModels.length} models`));
    });
  }
}