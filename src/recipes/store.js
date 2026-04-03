"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { createLogger } = require("../utils/logger");

const log = createLogger("recipe-store");

// ─── Filesystem helpers ──────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(config.paths.recipes)) {
    fs.mkdirSync(config.paths.recipes, { recursive: true });
  }
}

function recipePath(id) {
  return path.join(config.paths.recipes, `${id}.json`);
}

function writeFileRecipe(recipe) {
  ensureDir();
  fs.writeFileSync(recipePath(recipe.id), JSON.stringify(recipe, null, 2));
}

// ─── Schema normalization ────────────────────────────────────────────────────
// Accepts both old schema (instruction_pattern) and new schema (match.pattern).

function normalizeRecipe(raw) {
  const id = raw.id || raw.recipe_id;
  if (!id) return null;

  const recipe = {
    id,
    name: raw.name || id,
    variables: raw.variables || [],
    steps: raw.steps || [],
    success_count: raw.success_count || 0,
    fail_count: raw.fail_count || 0,
    avg_duration_ms: raw.avg_duration_ms || 0,
    last_used: raw.last_used,
    created_at: raw.created_at,
  };

  // Preserve new-schema fields
  if (raw.version !== undefined) recipe.version = raw.version;
  if (raw.domain) recipe.domain = raw.domain;
  if (raw.tags) recipe.tags = raw.tags;
  if (raw.test) recipe.test = raw.test;

  // Normalize match block
  if (raw.match && raw.match.pattern) {
    recipe.match = raw.match;
  } else if (raw.instruction_pattern) {
    recipe.match = {
      keywords: raw.instruction_pattern.split("|").map((k) => k.trim()).filter(Boolean),
      pattern: raw.instruction_pattern,
    };
  }

  return recipe;
}

// ─── Public API ──────────────────────────────────────────────────────────────

function getRecipes() {
  ensureDir();
  const files = fs.readdirSync(config.paths.recipes).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        return normalizeRecipe(JSON.parse(fs.readFileSync(path.join(config.paths.recipes, f), "utf8")));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getRecipeById(id) {
  const p = recipePath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return normalizeRecipe(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

function saveRecipe(recipe) {
  recipe.created_at = recipe.created_at || new Date().toISOString();
  writeFileRecipe(recipe);
  log.success(`Saved recipe: ${recipe.name} (${recipe.steps.length} steps)`);
  return recipe;
}

function deleteRecipe(id) {
  const p = recipePath(id);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    log.info(`Deleted recipe: ${id}`);
    return true;
  }
  return false;
}

async function updateRecipeStats(id, success, durationMs) {
  const recipe = getRecipeById(id);
  if (!recipe) return;

  if (success) {
    recipe.success_count = (recipe.success_count || 0) + 1;
    const total = recipe.success_count + (recipe.fail_count || 0);
    recipe.avg_duration_ms = Math.round(
      ((recipe.avg_duration_ms || 0) * (total - 1) + durationMs) / total
    );
  } else {
    recipe.fail_count = (recipe.fail_count || 0) + 1;
  }
  recipe.last_used = new Date().toISOString();
  writeFileRecipe(recipe);
}

module.exports = { getRecipes, getRecipeById, saveRecipe, deleteRecipe, updateRecipeStats };
