const { createLogger } = require("./logger");
const log = createLogger("retry");

async function retry(fn, options = {}) {
  const {
    maxRetries = 3,
    backoff = 1000,
    maxBackoff = 30000,
    onRetry = null,
    retryIf = () => true,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !retryIf(err)) {
        throw err;
      }

      const delay = Math.min(backoff * Math.pow(2, attempt), maxBackoff);

      if (onRetry) {
        onRetry(err, attempt + 1, delay);
      } else {
        log.warn(`Attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms...`);
      }

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

function parseRetryAfter(err) {
  const msg = String(err.message || err.error?.message || "");
  const match = msg.match(/([\d.]+)\s*s/i);
  return match ? Math.ceil(parseFloat(match[1])) : 5;
}

module.exports = { retry, parseRetryAfter };
