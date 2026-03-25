const express = require("express");
const Template = require("../models/Template");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /api/templates — returns all templates grouped by category
router.get("/", async (_req, res) => {
  try {
    const templates = await Template.find().sort({ category: 1, usage_count: -1 });

    // Group by category
    const grouped = {};
    for (const t of templates) {
      if (!grouped[t.category]) grouped[t.category] = [];
      grouped[t.category].push({
        id: t._id,
        name: t.name,
        description: t.description,
        category: t.category,
        icon: t.icon,
        recipe_id: t.recipe_id,
        instruction_template: t.instruction_template,
        variables: t.variables,
        usage_count: t.usage_count,
      });
    }

    res.json({ templates: grouped });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch templates" });
  }
});

// GET /api/templates/:id — returns single template
router.get("/:id", async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ error: "Template not found" });

    res.json({
      id: template._id,
      name: template.name,
      description: template.description,
      category: template.category,
      icon: template.icon,
      instruction_template: template.instruction_template,
      variables: template.variables,
      usage_count: template.usage_count,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch template" });
  }
});

// POST /api/templates/:id/run — fill template and create task
// The actual task creation is proxied to POST /api/tasks by the server
router.post("/:id/run", requireAuth, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ error: "Template not found" });

    const { variables } = req.body;
    if (!variables || typeof variables !== "object") {
      return res.status(400).json({ error: "Variables object is required" });
    }

    // Validate required variables
    for (const v of template.variables) {
      if (v.required !== false && (!variables[v.name] || !variables[v.name].trim())) {
        return res.status(400).json({ error: `Variable "${v.label}" is required` });
      }
    }

    // Fill in the template
    let instruction = template.instruction_template;
    for (const [key, value] of Object.entries(variables)) {
      instruction = instruction.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value.trim());
    }

    // Increment usage count
    template.usage_count += 1;
    await template.save().catch(() => {});

    // Return the filled instruction + raw variables for recipe execution
    res.json({
      instruction,
      template_id: template._id,
      template_name: template.name,
      recipe_id: template.recipe_id || null,
      variables,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to run template" });
  }
});

module.exports = router;
