const mongoose = require("mongoose");

const scheduleSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true },
  instruction: { type: String, required: true },
  template_id: { type: mongoose.Schema.Types.ObjectId, ref: "Template", default: null },
  frequency: { type: String, enum: ["hourly", "daily", "weekly"], required: true },
  time: { type: String, default: "09:00" },
  day_of_week: { type: Number, min: 0, max: 6, default: null },
  active: { type: Boolean, default: true },
  last_run: { type: Date, default: null },
  next_run: { type: Date, required: true },
  run_count: { type: Number, default: 0 },
  notify: { type: Boolean, default: true },
  notify_method: { type: String, enum: ["email", "dashboard"], default: "dashboard" },
  created_at: { type: Date, default: Date.now },
});

scheduleSchema.index({ user_id: 1, active: 1 });
scheduleSchema.index({ active: 1, next_run: 1 });

module.exports = mongoose.model("Schedule", scheduleSchema);
