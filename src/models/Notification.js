const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["schedule_complete", "schedule_failed"], required: true },
  title: { type: String, required: true },
  message: { type: String, default: "" },
  task_id: { type: mongoose.Schema.Types.ObjectId, ref: "Task", default: null },
  schedule_id: { type: mongoose.Schema.Types.ObjectId, ref: "Schedule", default: null },
  read: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
});

notificationSchema.index({ user_id: 1, read: 1, created_at: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
