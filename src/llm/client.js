const Groq = require("groq-sdk");
const config = require("../config");
const { getModelList } = require("./models");
const { parseRetryAfter } = require("../utils/retry");
const { createLogger } = require("../utils/logger");

const log = createLogger("llm");

let client;

function getClient() {
  if (!client) {
    client = new Groq({ apiKey: config.llm.apiKey });
  }
  return client;
}

function isRateLimitError(err) {
  return err.status === 429 || err.error?.type === "rate_limit_error";
}

async function complete(messages, options = {}) {
  const {
    maxTokens = config.llm.maxTokens,
    temperature = config.llm.temperature,
  } = options;

  const models = getModelList();
  const groq = getClient();

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const response = await groq.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      });
      return response;
    } catch (err) {
      if (isRateLimitError(err)) {
        const waitSec = parseRetryAfter(err);

        if (i < models.length - 1) {
          log.warn(`Rate limited on ${model}, waiting ${waitSec}s then falling back to ${models[i + 1]}...`);
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          continue;
        }

        // Last model — wait and retry once
        log.warn(`Rate limited on ${model} too, waiting ${waitSec}s...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        return await groq.chat.completions.create({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        });
      }
      throw err;
    }
  }
}

module.exports = { complete };
