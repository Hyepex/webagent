const mongoose = require("mongoose");

const stepSchema = new mongoose.Schema(
  {
    step_number: Number,
    thought: String,
    action: String,
    params: mongoose.Schema.Types.Mixed,
    result: String,
    screenshot_url: String,
    page_url: String,
    page_title: String,
    duration_ms: Number,
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const taskSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  instruction: { type: String, required: true },
  status: {
    type: String,
    enum: ["pending", "running", "completed", "failed", "cancelled"],
    default: "pending",
  },
  mode: { type: String, enum: ["recipe", null], default: null },
  recipe_id: { type: String, default: null },
  steps: [stepSchema],
  result: { type: String, default: null },
  error: { type: String, default: null },
  duration_ms: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now },
  completed_at: { type: Date, default: null },
});

taskSchema.index({ user_id: 1, created_at: -1 });

module.exports = mongoose.model("Task", taskSchema);
