# pi-openrouter-live-models

Always-fresh OpenRouter model list for [pi](https://pi.dev).

Every time pi starts, this extension fetches the latest models from the [OpenRouter API](https://openrouter.ai/api/v1/models) and replaces pi's static snapshot. No more stale model lists.

## Features

- **Live model fetching** — pulls from OpenRouter's API at startup (cached for 24h)
- **Enhanced model selector** — `/ormodels` opens a rich TUI with:
  - Fuzzy search across model ID + name
  - Provider filtering (toggle specific providers on/off with single-letter keys)
  - Sort by name, price, or context window
  - Filter by modality (text-only vs text+image)
  - Model detail preview showing pricing, context window, and capabilities
- **Automatic caching** — avoids hitting the API every launch
- **Force refresh** — `/ormodels --refresh` re-fetches instantly

## Installation

```bash
pi install git:github.com/dtmirizzi/pi-openrouter-live-models
```

Or install from a local path:

```bash
pi install /path/to/pi-openrouter-live-models
```

## Requirements

An OpenRouter API key must be configured. Any of these work:

1. Environment variable: `OPENROUTER_API_KEY`
2. pi's `models.json`:
```json
{
  "providers": {
    "openrouter": {
      "apiKey": "$OPENROUTER_API_KEY"
    }
  }
}
```
3. pi's `/login` flow (if logged in to OpenRouter)

## Usage

Open the enhanced model selector:

```
/ormodels
```

Force a refresh from the API:

```
/ormodels --refresh
```

### Keyboard shortcuts in the selector

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate models |
| `Enter` | Select model |
| `Esc` | Cancel |
| `/` | Focus search bar |
| `s` | Cycle sort mode (name → price↑ → price↓ → context) |
| `m` | Cycle modality filter (all → text → image) |
| `p` | Toggle provider filter panel |
| `a` | Toggle all providers (in provider panel) |
| provider keys | Toggle individual providers (e.g., `o` for openai) |

### Provider letters

Each provider is toggled by its first letter in the provider panel (`p` to open/close):

| Letter | Provider |
|--------|----------|
| a | Toggle all |
| o | openai |
| n | anthropic |
| g | google |
| m | meta-llama |
| d | deepseek |
| c | cohere |
| ... | (varies by available models) |

## How it works

1. On startup, reads cache from `~/.pi/agent/openrouter-models-cache.json`
2. If cache is older than 24h, fetches fresh from `https://openrouter.ai/api/v1/models`
3. Maps API models to pi's model format
4. Registers them via `pi.registerProvider("openrouter", ...)` — replacing the static list
5. Filters out batch-only (`:batch`) variants that don't support streaming

If the API is unreachable at startup, the extension falls back to cached data or pi's built-in static models.

## License

MIT