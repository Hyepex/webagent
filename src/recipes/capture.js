const config = require("../config");
const { saveRecipe } = require("./store");
const { createLogger } = require("../utils/logger");

const log = createLogger("recipe-capture");

function isGenericValue(value) {
  if (typeof value !== "string") return true;
  if (value.length <= 3) return true;
  if (["up", "down", "left", "right"].includes(value.toLowerCase())) return true;
  return false;
}

function generateId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .substring(0, 40)
    .replace(/_+$/, "") + "_" + Date.now().toString(36);
}

function extractKeywords(instruction) {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
    "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "and", "but", "or", "nor", "not", "so", "yet", "both",
    "each", "few", "more", "most", "other", "some", "such", "no",
    "only", "own", "same", "than", "too", "very", "just", "because",
    "find", "search", "get", "show", "me", "please", "look", "up",
    "what", "how", "where", "when", "who", "which", "i", "my", "it",
  ]);

  return instruction
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

function detectVariables(steps, instruction) {
  const variables = [];
  const variableValues = {};

  // Detect typed text as potential product/query variable
  for (const step of steps) {
    if (step.action === "type" && step.params?.text) {
      const text = step.params.text;
      if (!isGenericValue(text)) {
        const name = "query";
        variables.push({
          name,
          extracted_from: "the main search query or subject in the instruction",
        });
        variableValues[name] = text;
        break;
      }
    }
  }

  // Detect site from goto URLs
  for (const step of steps) {
    if (step.action === "goto" && step.params?.url) {
      try {
        const url = new URL(step.params.url.startsWith("http") ? step.params.url : "https://" + step.params.url);
        const host = url.hostname.replace(/^www\./, "");
        if (/amazon|flipkart|ebay|walmart|google|youtube|wikipedia|bbc/i.test(instruction)) {
          variables.push({
            name: "site",
            extracted_from: "the website mentioned in the instruction",
            default: host,
          });
          variableValues["site"] = host;
        }
      } catch {}
      break;
    }
  }

  return { variables, variableValues };
}

// Convert raw LLM steps into resilient recipe steps.
// The key insight: clickElement with hardcoded numbers breaks when page layout changes.
// Instead, we produce: goto → type → pressEnter → waitFor → getText → done
function buildResilientSteps(steps, variableValues) {
  const resilient = [];
  let prevAction = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const action = step.action;
    const params = { ...(step.params || {}) };

    // Templatize variable values in params
    for (const [varName, varValue] of Object.entries(variableValues)) {
      for (const [paramKey, paramVal] of Object.entries(params)) {
        if (typeof paramVal === "string" && paramVal.includes(varValue)) {
          params[paramKey] = paramVal.replace(varValue, `{{${varName}}}`);
        }
      }
    }

    if (action === "clickElement") {
      // If the previous action was "type", replace the click with pressEnter
      // (user typed a search query, now submit it)
      if (prevAction === "type") {
        resilient.push({ action: "pressEnter", params: {} });
        // Add a short wait after pressing enter for page to load
        resilient.push({ action: "waitFor", params: { seconds: "2" } });
      } else {
        // For navigation clicks, try to save the link text or target URL instead
        const linkText = step._elementLabel || null;
        const targetUrl = step.page_url || null;

        if (linkText) {
          resilient.push({ action: "clickByText", params: { text: linkText } });
        } else if (targetUrl && targetUrl !== "about:blank") {
          // Skip the click entirely if we can just goto the target URL
          resilient.push({ action: "goto", params: { url: targetUrl } });
        }
        // If neither is available, skip this step entirely — it's not replayable
      }
    } else if (action === "done") {
      resilient.push({ action: "done", params });
    } else if (action === "goto" || action === "type" || action === "getText" ||
               action === "scroll" || action === "back" || action === "waitFor" ||
               action === "pressEnter") {
      resilient.push({ action, params });
    }
    // Skip unknown/non-replayable actions

    prevAction = action;
  }

  // Ensure there's a getText before done if we have a done step
  const doneIdx = resilient.findIndex((s) => s.action === "done");
  if (doneIdx > 0) {
    const hasGetText = resilient.slice(Math.max(0, doneIdx - 2), doneIdx).some((s) => s.action === "getText");
    if (!hasGetText) {
      resilient.splice(doneIdx, 0, { action: "getText", params: {} });
    }
  }

  return resilient;
}

function captureRecipe(task, taskResult) {
  const { steps, result } = taskResult;

  if (!steps || steps.length === 0) return null;

  // Skip capture if the task was blocked by security rules
  const resultText = (result || "").toLowerCase();
  if (resultText.includes("security rules") || resultText.includes("not able to perform")) {
    log.info("Skipping capture: task was blocked by security rules");
    return null;
  }

  // Skip capture if task completed too quickly with minimal steps (likely blocked, not executed)
  if (steps.length <= 1 && taskResult.duration_ms != null && taskResult.duration_ms < 2000) {
    log.info("Skipping capture: task completed too quickly with only 1 step (likely blocked)");
    return null;
  }

  if (steps.length > config.recipes.maxCaptureSteps) {
    log.info(`Skipping capture: task used ${steps.length} steps (max ${config.recipes.maxCaptureSteps})`);
    return null;
  }

  const keywords = extractKeywords(task);
  if (keywords.length === 0) return null;

  const pattern = keywords.slice(0, 5).join("|");
  const { variables, variableValues } = detectVariables(steps, task);

  // Enrich steps with element labels before converting
  const enrichedSteps = steps.map((step) => {
    const enriched = { ...step };
    // If this was a clickElement, try to find what was clicked from the result text
    if (step.action === "clickElement" && step.result) {
      const labelMatch = step.result.match(/(?:link|button): (.+?)(?:\n|$)/);
      if (labelMatch) enriched._elementLabel = labelMatch[1].trim();
    }
    return enriched;
  });

  const recipeSteps = buildResilientSteps(enrichedSteps, variableValues);

  if (recipeSteps.length === 0) {
    log.info("Skipping capture: no replayable steps");
    return null;
  }

  const name = task.length > 60 ? task.substring(0, 57) + "..." : task;

  const recipe = {
    id: generateId(name),
    name,
    instruction_pattern: pattern,
    instruction_example: task,
    variables,
    steps: recipeSteps,
    success_count: 1,
    fail_count: 0,
    avg_duration_ms: taskResult.duration_ms || 0,
    last_used: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  saveRecipe(recipe).catch((err) => log.warn(`Async recipe save error: ${err.message}`));
  log.success(`Captured recipe: "${name}" (${recipeSteps.length} resilient steps, ${variables.length} variables)`);
  return recipe;
}

module.exports = { captureRecipe };
