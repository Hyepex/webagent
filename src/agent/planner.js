const config = require("../config");
const llm = require("../llm/client");
const { SYSTEM_PROMPT, JSON_CORRECTION } = require("./prompts");
const { createLogger } = require("../utils/logger");

const log = createLogger("planner");

class Planner {
  constructor() {
    this.history = [];
  }

  reset(task) {
    this.history = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Task: ${task}` },
    ];
  }

  addContext(message) {
    this.history.push({ role: "user", content: message });
  }

  async getNextAction(observation) {
    if (observation) {
      this.history.push({ role: "user", content: observation });
    }

    const maxHist = config.agent.maxHistoryMessages;
    if (this.history.length > maxHist + 4) {
      this.history = [this.history[0], this.history[1], ...this.history.slice(-(maxHist))];
    }

    // Try up to 2 times for valid JSON
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await llm.complete(this.history);
      const raw = response.choices[0].message.content.trim();
      const parsed = _parseJSON(raw);

      if (parsed) {
        this.history.push({ role: "assistant", content: raw });
        return parsed;
      }

      if (attempt === 0) {
        log.warn("Invalid JSON from LLM, retrying...");
        this.history.push({ role: "assistant", content: raw });
        this.history.push({ role: "user", content: JSON_CORRECTION });
      }
    }

    return null;
  }
}

function _parseJSON(raw) {
  let json = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) json = fence[1].trim();

  try {
    return JSON.parse(json);
  } catch {}

  const match = raw.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  return null;
}

module.exports = Planner;
