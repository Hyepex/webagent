const { getRecipes } = require("./store");
const { createLogger } = require("../utils/logger");

const log = createLogger("recipe-matcher");

const MATCH_THRESHOLD = 0.5;

// ─── Score a single recipe against an instruction ────────────────────────────

function scoreRecipe(instruction, recipe) {
  const match = recipe.match;
  if (!match) return { score: 0, variables: {} };

  const lower = instruction.toLowerCase();

  // Step 1: keyword check — at least one keyword must appear
  const keywords = match.keywords || [];
  let keywordHits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) keywordHits++;
  }
  if (keywordHits === 0) return { score: 0, variables: {} };

  const keywordScore = keywordHits / keywords.length;

  // Step 2: regex pattern match
  let patternScore = 0;
  let variables = {};

  if (match.pattern) {
    try {
      const regex = new RegExp(match.pattern, "i");
      const result = regex.exec(instruction);
      if (result) {
        patternScore = 1;
        // Extract named capture groups
        if (result.groups) {
          for (const [key, value] of Object.entries(result.groups)) {
            if (value) variables[key] = value.trim();
          }
        }
      }
    } catch {
      // Invalid regex — skip pattern scoring
    }
  }

  // Step 3: combined score
  const score = keywordScore * 0.4 + patternScore * 0.6;

  return { score, variables };
}

// ─── Find best matching recipe ───────────────────────────────────────────────

async function matchRecipe(instruction) {
  const recipes = await getRecipes();
  if (recipes.length === 0) return null;

  let bestRecipe = null;
  let bestScore = 0;
  let bestVariables = {};

  for (const recipe of recipes) {
    const { score, variables } = scoreRecipe(instruction, recipe);
    if (score > bestScore) {
      bestScore = score;
      bestRecipe = recipe;
      bestVariables = variables;
    }
  }

  if (bestScore >= MATCH_THRESHOLD && bestRecipe) {
    log.success(`Matched recipe "${bestRecipe.name}" (score: ${bestScore.toFixed(2)})`);
    return { recipe: bestRecipe, score: bestScore, variables: bestVariables };
  }

  return null;
}

// ─── Merge variables from regex extraction + template vars + recipe defaults ─

function mergeVariables(extracted, templateVars, recipeDef) {
  const merged = { ...extracted };

  // Template variables (from UI form) override regex-extracted ones
  if (templateVars && typeof templateVars === "object") {
    for (const [key, value] of Object.entries(templateVars)) {
      if (value !== undefined && value !== null && value !== "") {
        merged[key] = value;
      }
    }
  }

  // Apply defaults from recipe definition for missing required vars
  const varDefs = recipeDef.variables || {};
  for (const [key, def] of Object.entries(varDefs)) {
    if (!(key in merged) || merged[key] === undefined || merged[key] === "") {
      if (def.default) {
        merged[key] = def.default;
      } else if (def.example && def.required) {
        // Use example as last resort for required vars
        merged[key] = def.example;
      }
    }
  }

  return merged;
}

module.exports = { matchRecipe, mergeVariables, scoreRecipe };
