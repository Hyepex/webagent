const config = require("../config");
const llm = require("../llm/client");
const { VARIABLE_EXTRACTION_PROMPT } = require("../agent/prompts");
const { getRecipes } = require("./store");
const { createLogger } = require("../utils/logger");

const log = createLogger("recipe-matcher");

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function scoreMatch(instruction, recipe) {
  // Check regex pattern match
  let patternMatch = false;
  try {
    const regex = new RegExp(recipe.instruction_pattern, "i");
    patternMatch = regex.test(instruction);
  } catch {}

  if (!patternMatch) return 0;

  // Score keyword overlap with example
  const instrTokens = new Set(tokenize(instruction));
  const exampleTokens = tokenize(recipe.instruction_example);
  if (exampleTokens.length === 0) return patternMatch ? 0.5 : 0;

  let overlap = 0;
  for (const token of exampleTokens) {
    if (instrTokens.has(token)) overlap++;
  }

  return overlap / exampleTokens.length;
}

async function matchRecipe(instruction) {
  const recipes = await getRecipes();
  if (recipes.length === 0) return null;

  let bestRecipe = null;
  let bestScore = 0;

  for (const recipe of recipes) {
    const score = scoreMatch(instruction, recipe);
    if (score > bestScore) {
      bestScore = score;
      bestRecipe = recipe;
    }
  }

  if (bestScore >= config.recipes.matchThreshold) {
    log.success(`Matched recipe "${bestRecipe.name}" (score: ${bestScore.toFixed(2)})`);
    return { recipe: bestRecipe, score: bestScore };
  }

  return null;
}

async function extractVariables(instruction, variables) {
  if (!variables || variables.length === 0) return {};

  // Try simple heuristic extraction first
  const extracted = {};
  for (const v of variables) {
    if (v.default) extracted[v.name] = v.default;
  }

  // Extract website/domain
  const domainMatch = instruction.match(/(?:on|from|at)\s+([\w]+\.(?:com|in|org|net|co\.[\w]+))/i);
  const siteMatch = instruction.match(/(?:on|from|at)\s+(amazon|flipkart|google|wikipedia|bbc|youtube|ebay)/i);

  for (const v of variables) {
    if (v.name === "site" || v.name === "website") {
      if (domainMatch) extracted[v.name] = domainMatch[1];
      else if (siteMatch) extracted[v.name] = siteMatch[1] + ".com";
    }
  }

  // For product/subject extraction, use a small LLM call
  const needsLLM = variables.some(
    (v) => !extracted[v.name] && v.name !== "site" && v.name !== "website"
  );

  if (needsLLM) {
    try {
      const varDefs = variables
        .map((v) => `- ${v.name}: ${v.extracted_from}`)
        .join("\n");

      const prompt = VARIABLE_EXTRACTION_PROMPT
        .replace("{{variable_definitions}}", varDefs)
        .replace("{{instruction}}", instruction);

      const response = await llm.complete(
        [
          { role: "system", content: "Extract variables. Respond with ONLY JSON." },
          { role: "user", content: prompt },
        ],
        { maxTokens: 100 }
      );

      const raw = response.choices[0].message.content.trim();
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        for (const [k, v] of Object.entries(parsed)) {
          if (v && typeof v === "string") extracted[k] = v;
        }
      }
    } catch (err) {
      log.warn(`Variable extraction LLM call failed: ${err.message}`);
    }
  }

  return extracted;
}

module.exports = { matchRecipe, extractVariables };
