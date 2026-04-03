const fs = require("fs");
const path = require("path");
const config = require("../config");
const { createLogger } = require("../utils/logger");

const log = createLogger("recipe-store");

let RecipeModel = null;
let mongoReady = false;

// Try to load the Mongoose model — will be available once MongoDB connects
function getModel() {
  if (RecipeModel) return RecipeModel;
  try {
    RecipeModel = require("../models/Recipe");
    return RecipeModel;
  } catch {
    return null;
  }
}

function isMongoReady() {
  try {
    const mongoose = require("mongoose");
    mongoReady = mongoose.connection.readyState === 1;
  } catch {
    mongoReady = false;
  }
  return mongoReady;
}

// ─── File-based fallback helpers ────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(config.paths.recipes)) {
    fs.mkdirSync(config.paths.recipes, { recursive: true });
  }
}

function recipePath(id) {
  return path.join(config.paths.recipes, `${id}.json`);
}

function readFileRecipes() {
  ensureDir();
  const files = fs.readdirSync(config.paths.recipes).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(config.paths.recipes, f), "utf8"));
        return normalizeRecipe(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeFileRecipe(recipe) {
  ensureDir();
  fs.writeFileSync(recipePath(recipe.id), JSON.stringify(recipe, null, 2));
}

// ─── Schema Normalization ───────────────────────────────────────────────────
// Handles both old schema (instruction_pattern, instruction_example) and
// new schema (match.keywords, match.pattern). Also handles both recipe_id
// (MongoDB) and id (file) fields.

function normalizeRecipe(raw) {
  // Normalize the ID field
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

  // Copy over new-schema fields if present
  if (raw.version !== undefined) recipe.version = raw.version;
  if (raw.domain) recipe.domain = raw.domain;
  if (raw.tags) recipe.tags = raw.tags;
  if (raw.test) recipe.test = raw.test;

  // Normalize match block
  if (raw.match && raw.match.pattern) {
    // New schema — use as-is
    recipe.match = raw.match;
  } else if (raw.instruction_pattern) {
    // Old schema — convert to new match format
    recipe.match = {
      keywords: raw.instruction_pattern.split("|").map((k) => k.trim()).filter(Boolean),
      pattern: raw.instruction_pattern,
    };
    // Preserve old fields for reference
    recipe.instruction_pattern = raw.instruction_pattern;
    recipe.instruction_example = raw.instruction_example;
  }

  return recipe;
}

// ─── Unified store functions ────────────────────────────────────────────────

async function saveRecipe(recipe) {
  recipe.created_at = recipe.created_at || new Date().toISOString();

  // Always write to file as cache/fallback
  writeFileRecipe(recipe);

  if (isMongoReady()) {
    const Model = getModel();
    if (Model) {
      try {
        await Model.findOneAndUpdate(
          { recipe_id: recipe.id },
          {
            recipe_id: recipe.id,
            name: recipe.name,
            instruction_pattern: recipe.instruction_pattern || "",
            instruction_example: recipe.instruction_example || "",
            variables: recipe.variables || [],
            steps: recipe.steps || [],
            success_count: recipe.success_count || 0,
            fail_count: recipe.fail_count || 0,
            avg_duration_ms: recipe.avg_duration_ms || 0,
            last_used: recipe.last_used || null,
            created_at: recipe.created_at,
          },
          { upsert: true, new: true }
        );
      } catch (err) {
        log.warn(`MongoDB save failed, file fallback used: ${err.message}`);
      }
    }
  }

  log.success(`Saved recipe: ${recipe.name} (${recipe.steps.length} steps)`);
  return recipe;
}

async function getRecipes() {
  let mongoRecipes = [];
  if (isMongoReady()) {
    const Model = getModel();
    if (Model) {
      try {
        const docs = await Model.find().lean();
        mongoRecipes = docs.map(toPlainRecipe).map(normalizeRecipe).filter(Boolean);
      } catch (err) {
        log.warn(`MongoDB read failed, using file fallback: ${err.message}`);
      }
    }
  }

  // Always load file recipes and merge (file recipes fill gaps not in MongoDB)
  const fileRecipes = readFileRecipes();
  const seenIds = new Set(mongoRecipes.map((r) => r.id));
  for (const fr of fileRecipes) {
    if (!seenIds.has(fr.id)) {
      mongoRecipes.push(fr);
    }
  }

  return mongoRecipes;
}

async function getRecipeById(id) {
  if (isMongoReady()) {
    const Model = getModel();
    if (Model) {
      try {
        const doc = await Model.findOne({ recipe_id: id }).lean();
        if (doc) return normalizeRecipe(toPlainRecipe(doc));
      } catch {
        // fall through to file
      }
    }
  }
  const p = recipePath(id);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return normalizeRecipe(raw);
  } catch {
    return null;
  }
}

async function deleteRecipe(id) {
  let deleted = false;

  // Delete from file
  const p = recipePath(id);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    deleted = true;
  }

  // Delete from MongoDB
  if (isMongoReady()) {
    const Model = getModel();
    if (Model) {
      try {
        const result = await Model.deleteOne({ recipe_id: id });
        if (result.deletedCount > 0) deleted = true;
      } catch {
        // ignore
      }
    }
  }

  if (deleted) log.info(`Deleted recipe: ${id}`);
  return deleted;
}

async function updateRecipeStats(id, success, durationMs) {
  if (isMongoReady()) {
    const Model = getModel();
    if (Model) {
      try {
        const doc = await Model.findOne({ recipe_id: id });
        if (doc) {
          if (success) {
            doc.success_count += 1;
            const total = doc.success_count + doc.fail_count;
            doc.avg_duration_ms = Math.round(
              ((doc.avg_duration_ms || 0) * (total - 1) + durationMs) / total
            );
          } else {
            doc.fail_count += 1;
          }
          doc.last_used = new Date();
          await doc.save();
        }
      } catch {
        // fall through to file
      }
    }
  }

  // Also update file copy
  const recipe = await getRecipeById(id);
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

// Convert Mongoose lean doc to plain recipe object
function toPlainRecipe(doc) {
  return {
    id: doc.recipe_id || doc.id,
    recipe_id: doc.recipe_id,
    name: doc.name,
    instruction_pattern: doc.instruction_pattern,
    instruction_example: doc.instruction_example,
    variables: doc.variables || [],
    steps: doc.steps || [],
    success_count: doc.success_count || 0,
    fail_count: doc.fail_count || 0,
    avg_duration_ms: doc.avg_duration_ms || 0,
    last_used: doc.last_used,
    created_at: doc.created_at,
  };
}

module.exports = { saveRecipe, getRecipes, getRecipeById, deleteRecipe, updateRecipeStats };
