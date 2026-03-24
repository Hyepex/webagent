const express = require("express");
const TaskModel = require("../models/Task");
const { requireAuth } = require("../middleware/auth");
const { validateInstruction } = require("../middleware/taskLimits");

const router = express.Router();

const DAILY_LIMITS = { free: 5, pro: 50, unlimited: Infinity };

// POST /api/tasks — create a new task (auth required)
router.post("/", requireAuth, async (req, res) => {
  // Validate and sanitize instruction
  const validation = validateInstruction(req.body.instruction);
  if (!validation.valid) {
    return res.status(validation.status).json({ error: validation.error });
  }
  const instruction = validation.cleaned;

  const user = req.user;
  user.checkDailyReset();

  const limit = DAILY_LIMITS[user.plan] || DAILY_LIMITS.free;
  if (user.tasks_today >= limit) {
    return res.status(429).json({
      error: `Daily task limit reached (${limit} tasks). Upgrade your plan for more.`,
      tasks_today: user.tasks_today,
      limit,
    });
  }

  try {
    const task = await TaskModel.create({
      user_id: user._id,
      instruction,
      status: "pending",
    });

    // Increment daily counter
    user.tasks_today += 1;
    await user.save();

    // The server.js processTask function will pick this up via the returned task
    res.status(201).json({
      id: task._id,
      instruction: task.instruction,
      status: task.status,
      created_at: task.created_at,
      tasks_remaining: limit - user.tasks_today,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to create task" });
  }
});

// GET /api/tasks — list user's tasks (auth required, paginated)
router.get("/", requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const tasks = await TaskModel.find({ user_id: req.user._id })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .select("instruction status mode recipe_id result error duration_ms created_at completed_at steps");

    const total = await TaskModel.countDocuments({ user_id: req.user._id });

    const items = tasks.map((t) => ({
      id: t._id,
      instruction: t.instruction,
      status: t.status,
      mode: t.mode,
      duration_ms: t.duration_ms,
      created_at: t.created_at,
      completed_at: t.completed_at,
      step_count: t.steps ? t.steps.length : 0,
    }));

    res.json({ tasks: items, total, page, limit });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

// GET /api/tasks/:id — get single task (auth required, must be owner)
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const task = await TaskModel.findOne({ _id: req.params.id, user_id: req.user._id });
    if (!task) return res.status(404).json({ error: "Task not found" });

    const clean = {
      id: task._id,
      instruction: task.instruction,
      status: task.status,
      mode: task.mode,
      recipe_id: task.recipe_id,
      result: task.result,
      error: task.error,
      tokens_used: task.tokens_used,
      duration_ms: task.duration_ms,
      created_at: task.created_at,
      completed_at: task.completed_at,
      steps: task.steps.map((s) => ({
        step_number: s.step_number,
        thought: s.thought,
        action: s.action,
        params: s.params,
        result: s.result,
        screenshot_url: s.screenshot_url,
        page_url: s.page_url,
        page_title: s.page_title,
        duration_ms: s.duration_ms,
        timestamp: s.timestamp,
      })),
    };
    res.json(clean);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch task" });
  }
});

// DELETE /api/tasks/:id — cancel/delete task (auth required, must be owner)
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const task = await TaskModel.findOne({ _id: req.params.id, user_id: req.user._id });
    if (!task) return res.status(404).json({ error: "Task not found" });

    if (task.status === "pending" || task.status === "running") {
      task.status = "cancelled";
      task.completed_at = new Date();
      await task.save();
      return res.json({ cancelled: true, id: task._id });
    }

    // Already completed/failed — allow deletion
    await TaskModel.deleteOne({ _id: task._id });
    res.json({ deleted: true, id: task._id });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete task" });
  }
});

module.exports = router;
