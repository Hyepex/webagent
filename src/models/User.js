const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, default: null },
  google_id: { type: String, default: null },
  profile_picture: { type: String, default: null },
  plan: { type: String, default: "free" },
  tasks_today: { type: Number, default: 0 },
  tasks_today_reset: { type: Date, default: Date.now },
  created_at: { type: Date, default: Date.now },
});

// Reset daily task counter if the stored date is not today
userSchema.methods.checkDailyReset = function () {
  const now = new Date();
  const resetDate = this.tasks_today_reset ? new Date(this.tasks_today_reset) : null;
  if (!resetDate || resetDate.toDateString() !== now.toDateString()) {
    this.tasks_today = 0;
    this.tasks_today_reset = now;
  }
};

userSchema.methods.toProfile = function () {
  return {
    id: this._id,
    username: this.username,
    email: this.email,
    profile_picture: this.profile_picture,
    plan: this.plan,
    tasks_today: this.tasks_today,
    created_at: this.created_at,
  };
};

module.exports = mongoose.model("User", userSchema);
