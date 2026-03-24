const mongoose = require("mongoose");

const variableSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, enum: ["text", "url", "select"], default: "text" },
    placeholder: { type: String, default: "" },
    options: { type: [String], default: [] },
    required: { type: Boolean, default: true },
  },
  { _id: false }
);

const templateSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: "" },
  category: {
    type: String,
    enum: ["shopping", "research", "monitoring", "travel", "news", "utilities"],
    required: true,
  },
  instruction_template: { type: String, required: true },
  variables: [variableSchema],
  icon: { type: String, default: "" },
  usage_count: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Template", templateSchema);
