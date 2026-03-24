const mongoose = require("mongoose");

const recipeVariableSchema = new mongoose.Schema(
  {
    name: String,
    extracted_from: String,
    default: String,
  },
  { _id: false }
);

const recipeStepSchema = new mongoose.Schema(
  {
    action: String,
    params: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const recipeSchema = new mongoose.Schema({
  recipe_id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  instruction_pattern: { type: String, default: "" },
  instruction_example: { type: String, default: "" },
  variables: [recipeVariableSchema],
  steps: [recipeStepSchema],
  success_count: { type: Number, default: 0 },
  fail_count: { type: Number, default: 0 },
  avg_duration_ms: { type: Number, default: 0 },
  last_used: { type: Date, default: null },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Recipe", recipeSchema);
