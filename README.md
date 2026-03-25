# WebAgent — Deterministic Browser Automation

A recipe-driven browser automation agent that executes pre-authored JSON recipes using Playwright. No LLM required — all actions are deterministic and reproducible.

## Quick Start

```bash
cp .env.example .env
npm install
node src/server.js
```

Open `http://localhost:3000` to access the dashboard.

**CLI mode:**
```bash
node src/index.js
```

**Docker:**
```bash
docker compose build
docker compose up
```

## Configuration

All configuration lives in `.env`. Every variable has a sensible default.

| Variable | Default | Description |
|---|---|---|
| `BROWSER_HEADLESS` | `false` | Run browser without UI |
| `BROWSER_TIMEOUT` | `30000` | Navigation timeout (ms) |
| `BROWSER_WIDTH` | `1280` | Viewport width |
| `BROWSER_HEIGHT` | `800` | Viewport height |
| `MAX_STEPS` | `30` | Max actions per task |
| `SETTLE_DELAY` | `300` | Delay after navigation (ms) |
| `NETWORK_IDLE_TIMEOUT` | `1500` | Network idle wait (ms) |
| `MONGODB_URI` | `mongodb://localhost:27017/webagent` | MongoDB connection URI |
| `JWT_SECRET` | *(dev default)* | JWT signing secret |
| `GOOGLE_CLIENT_ID` | *(empty)* | Google OAuth client ID |

## Architecture

```
src/
├── index.js              CLI entry point
├── server.js             Express + Socket.IO dashboard server
├── config.js             Centralized configuration
├── browser/
│   ├── controller.js     Playwright lifecycle and high-level API
│   ├── actions.js        Low-level browser actions
│   ├── parser.js         DOM parsing and element extraction
│   └── security.js       URL and input validation
├── recipes/
│   ├── executor.js       Recipe step execution engine
│   ├── matcher.js        Regex-based recipe matching (zero LLM)
│   └── store.js          Dual storage (MongoDB + JSON files)
├── models/               Mongoose schemas (Task, User, Recipe)
├── routes/               Express API routes
├── middleware/            Rate limiting and auth middleware
├── seeds/                Template seeding
├── scheduler.js          Scheduled task runner
└── utils/
    ├── logger.js         Color-coded logging
    ├── monitor.js        Health metrics
    └── retry.js          Retry with exponential backoff

recipes/                  JSON recipe files (the core automation logic)
```

## Recipes

Recipes are JSON files in the `recipes/` directory. Each recipe defines a sequence of browser actions with variable interpolation, target resolution, and assertions.

### Recipe Schema

```json
{
  "id": "unique_recipe_id",
  "name": "Human-readable name",
  "version": 1,
  "domain": "example.com",
  "tags": ["category"],
  "variables": {
    "varName": { "label": "Display label", "required": true, "example": "default" }
  },
  "match": {
    "keywords": ["word1", "word2"],
    "pattern": "regex with (?<named> groups)"
  },
  "steps": [
    {
      "id": "step_id",
      "action": "goto|fill|click|pickOption|pressEnter|scroll|back|waitForText|waitForAny|getText|extract|waitFor|done",
      "params": { "url": "https://..." },
      "target": [
        { "strategy": "label|placeholder|role|text|selector|role_nested", "value": "..." }
      ],
      "assert": { "url_contains": "...", "title_contains": "...", "text_visible": "..." },
      "store_as": "variableName",
      "optional": true,
      "delay_before": 500,
      "delay_after": 300
    }
  ]
}
```

### Creating Recipes

1. Create a JSON file in `recipes/` following the schema above
2. Define `match.keywords` and `match.pattern` for automatic instruction matching
3. Use `{{variableName}}` for dynamic values in step params
4. Use `target` arrays with multiple strategies for resilient element selection
5. Add `optional: true` to steps that may fail without breaking the flow
6. Use `store_as` to save step results for use in later steps
