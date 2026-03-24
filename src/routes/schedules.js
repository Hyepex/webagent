const express = require("express");
const Schedule = require("../models/Schedule");
const Notification = require("../models/Notification");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function calculateNextRun(frequency, time, dayOfWeek) {
  const now = new Date();
  const [hours, minutes] = (time || "09:00").split(":").map(Number);

  if (frequency === "hourly") {
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next;
  }

  if (frequency === "daily") {
    const next = new Date(now);
    next.setHours(hours, minutes, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  if (frequency === "weekly") {
    const next = new Date(now);
    next.setHours(hours, minutes, 0, 0);
    const currentDay = next.getDay();
    const targetDay = dayOfWeek != null ? dayOfWeek : 1; // default Monday
    let daysUntil = targetDay - currentDay;
    if (daysUntil < 0 || (daysUntil === 0 && next <= now)) daysUntil += 7;
    next.setDate(next.getDate() + daysUntil);
    return next;
  }

  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

// POST /api/schedules — create a new schedule
router.post("/", requireAuth, async (req, res) => {
  try {
    const { name, instruction, template_id, frequency, time, day_of_week, notify } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
    if (!instruction || !instruction.trim()) return res.status(400).json({ error: "Instruction is required" });
    if (!["hourly", "daily", "weekly"].includes(frequency)) {
      return res.status(400).json({ error: "Frequency must be hourly, daily, or weekly" });
    }

    // Limit schedules per user
    const count = await Schedule.countDocuments({ user_id: req.user._id });
    if (count >= 10) {
      return res.status(400).json({ error: "Maximum 10 schedules per user" });
    }

    const nextRun = calculateNextRun(frequency, time, day_of_week);

    const schedule = await Schedule.create({
      user_id: req.user._id,
      name: name.trim(),
      instruction: instruction.trim(),
      template_id: template_id || null,
      frequency,
      time: time || "09:00",
      day_of_week: frequency === "weekly" ? (day_of_week != null ? day_of_week : 1) : null,
      active: true,
      next_run: nextRun,
      notify: notify !== false,
    });

    res.status(201).json({
      id: schedule._id,
      name: schedule.name,
      instruction: schedule.instruction,
      frequency: schedule.frequency,
      time: schedule.time,
      day_of_week: schedule.day_of_week,
      active: schedule.active,
      next_run: schedule.next_run,
      created_at: schedule.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to create schedule" });
  }
});

// GET /api/schedules — returns user's schedules
router.get("/", requireAuth, async (req, res) => {
  try {
    const schedules = await Schedule.find({ user_id: req.user._id }).sort({ created_at: -1 });

    const items = schedules.map((s) => ({
      id: s._id,
      name: s.name,
      instruction: s.instruction,
      template_id: s.template_id,
      frequency: s.frequency,
      time: s.time,
      day_of_week: s.day_of_week,
      active: s.active,
      last_run: s.last_run,
      next_run: s.next_run,
      run_count: s.run_count,
      notify: s.notify,
      created_at: s.created_at,
    }));

    res.json({ schedules: items });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch schedules" });
  }
});

// PUT /api/schedules/:id — update schedule
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const schedule = await Schedule.findOne({ _id: req.params.id, user_id: req.user._id });
    if (!schedule) return res.status(404).json({ error: "Schedule not found" });

    const { name, instruction, frequency, time, day_of_week, active, notify } = req.body;

    if (name !== undefined) schedule.name = name.trim();
    if (instruction !== undefined) schedule.instruction = instruction.trim();
    if (notify !== undefined) schedule.notify = notify;

    if (active !== undefined) {
      schedule.active = active;
      // Recalculate next_run when reactivating
      if (active) {
        const freq = frequency || schedule.frequency;
        const t = time || schedule.time;
        const dow = day_of_week != null ? day_of_week : schedule.day_of_week;
        schedule.next_run = calculateNextRun(freq, t, dow);
      }
    }

    if (frequency !== undefined) {
      schedule.frequency = frequency;
      schedule.next_run = calculateNextRun(frequency, time || schedule.time, day_of_week != null ? day_of_week : schedule.day_of_week);
    }
    if (time !== undefined) {
      schedule.time = time;
      schedule.next_run = calculateNextRun(schedule.frequency, time, schedule.day_of_week);
    }
    if (day_of_week !== undefined) {
      schedule.day_of_week = day_of_week;
      schedule.next_run = calculateNextRun(schedule.frequency, schedule.time, day_of_week);
    }

    await schedule.save();

    res.json({
      id: schedule._id,
      name: schedule.name,
      instruction: schedule.instruction,
      frequency: schedule.frequency,
      time: schedule.time,
      day_of_week: schedule.day_of_week,
      active: schedule.active,
      next_run: schedule.next_run,
      run_count: schedule.run_count,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to update schedule" });
  }
});

// DELETE /api/schedules/:id — delete schedule
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const schedule = await Schedule.findOne({ _id: req.params.id, user_id: req.user._id });
    if (!schedule) return res.status(404).json({ error: "Schedule not found" });

    await Schedule.deleteOne({ _id: schedule._id });
    res.json({ deleted: true, id: schedule._id });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete schedule" });
  }
});

// GET /api/notifications — returns user's notifications
router.get("/notifications", requireAuth, async (req, res) => {
  try {
    const notifications = await Notification.find({ user_id: req.user._id })
      .sort({ created_at: -1 })
      .limit(20);

    const unread = await Notification.countDocuments({ user_id: req.user._id, read: false });

    res.json({
      notifications: notifications.map((n) => ({
        id: n._id,
        type: n.type,
        title: n.title,
        message: n.message,
        task_id: n.task_id,
        schedule_id: n.schedule_id,
        read: n.read,
        created_at: n.created_at,
      })),
      unread,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// PUT /api/notifications/read — mark all as read
router.put("/notifications/read", requireAuth, async (req, res) => {
  try {
    await Notification.updateMany({ user_id: req.user._id, read: false }, { read: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark notifications as read" });
  }
});

module.exports = router;
module.exports.calculateNextRun = calculateNextRun;
