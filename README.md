# WebAgent

An autonomous AI-powered browser agent that navigates the web to complete tasks. It uses an LLM to plan actions and Puppeteer to execute them in a real browser you can watch.

## Quick Start

**Option 1: Local (Node.js)**
```bash
cp .env.example .env         # 1. Create config
# Edit .env — add your Groq API key
npm install                   # 2. Install dependencies
node src/index.js             # 3. Run
```

**Option 2: Docker**
```bash
./setup.sh                    # One command does everything
```

## Configuration

All configuration lives in `.env`. Every variable has a sensible default.

| Variable | Default | Description |
|---|---|---|
| `LLM_API_KEY` | *(required)* | Your Groq API key |
| `LLM_PROVIDER` | `groq` | LLM provider |
| `LLM_MODEL` | `llama-3.3-70b-versatile` | Primary model |
| `LLM_FALLBACK_MODEL` | `llama-3.1-8b-instant` | Fallback model (on rate limit) |
| `LLM_MAX_TOKENS` | `300` | Max response tokens |
| `BROWSER_HEADLESS` | `false` | Run browser without UI |
| `BROWSER_TIMEOUT` | `30000` | Navigation timeout (ms) |
| `MAX_STEPS` | `20` | Max actions per task |
| `MAX_ELEMENTS` | `10` | Max page elements shown to LLM |

## Architecture

```
src/
├── index.js              Entry point — CLI loop
├── config.js             SSOT for all configuration
├── agent/
│   ├── planner.js        AI planning — manages LLM conversation
│   ├── executor.js       Action loop — runs tasks step by step
│   └── prompts.js        SSOT for all LLM prompts
├── browser/
│   ├── controller.js     Puppeteer lifecycle and high-level API
│   ├── actions.js        Low-level browser actions (click, type, goto)
│   └── parser.js         DOM parsing and element extraction
├── llm/
│   ├── client.js         LLM client with rate limit handling + fallback
│   └── models.js         Model configuration
└── utils/
    ├── logger.js         Consistent color-coded logging
    └── retry.js          Reusable retry with exponential backoff
```

## Switching LLM Providers

To switch from Groq to another provider (OpenAI, Anthropic, etc.), only `src/llm/client.js` needs to change. Every other module calls `llm.complete(messages)` — the provider is abstracted away.
