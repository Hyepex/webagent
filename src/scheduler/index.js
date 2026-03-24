const mongoose = require("mongoose");
const Schedule = require("../models/Schedule");
const Notification = require("../models/Notification");
const TaskModel = require("../models/Task");
const User = require("../models/User");
const { createLogger } = require("../utils/logger");
const { calculateNextRun } = require("../routes/schedules");

const log = createLogger("scheduler");

let taskRunner = null; // Will be set by server.js: (instruction, userId) => Promise<result>
let intervalHandle = null;

function setTaskRunner(fn) {
  taskRunner = fn;
}

async function checkSchedules() {
  if (mongoose.connection.readyState !== 1) return;
  if (!taskRunner) return;

  try {
    const now = new Date();
    const dueSchedules = await Schedule.find({
      active: true,
      next_run: { $lte: now },
    }).limit(5); // Process max 5 at a time

    for (const schedule of dueSchedules) {
      try {
        const user = await User.findById(schedule.user_id);
        if (!user) {
          log.warn(`Schedule "${schedule.name}": user not found, deactivating`);
          schedule.active = false;
          await schedule.save();
          continue;
        }

        // Check daily limits
        user.checkDailyReset();
        const DAILY_LIMITS = { free: 5, pro: 50, unlimited: Infinity };
        const limit = DAILY_LIMITS[user.plan] || DAILY_LIMITS.free;
        if (user.tasks_today >= limit) {
          log.warn(`Schedule "${schedule.name}": user ${user.email} at daily limit, skipping`);
          // Still advance next_run so it doesn't retry immediately
          schedule.next_run = calculateNextRun(schedule.frequency, schedule.time, schedule.day_of_week);
          await schedule.save();
          continue;
        }

        log.info(`Running scheduled task: "${schedule.name}" for user ${user.email}`);

        // Create DB task
        const dbTask = await TaskModel.create({
          user_id: user._id,
          instruction: schedule.instruction,
          status: "pending",
        });

        // Increment daily counter
        user.tasks_today += 1;
        await user.save();

        // Run the task (async — don't block other schedules)
        runScheduledTask(schedule, dbTask, user).catch((err) => {
          log.error(`Scheduled task "${schedule.name}" error: ${err.message}`);
        });

        // Update schedule timing immediately
        schedule.last_run = now;
        schedule.run_count += 1;
        schedule.next_run = calculateNextRun(schedule.frequency, schedule.time, schedule.day_of_week);
        await schedule.save();
      } catch (err) {
        log.error(`Error processing schedule "${schedule.name}": ${err.message}`);
        // Still advance next_run to prevent infinite loop
        schedule.next_run = calculateNextRun(schedule.frequency, schedule.time, schedule.day_of_week);
        await schedule.save().catch(() => {});
      }
    }
  } catch (err) {
    log.error(`Scheduler check error: ${err.message}`);
  }
}

async function runScheduledTask(schedule, dbTask, user) {
  try {
    const result = await taskRunner(schedule.instruction, user._id.toString(), dbTask);

    // Create notification on completion
    if (schedule.notify) {
      const success = dbTask.status === "completed";
      await Notification.create({
        user_id: user._id,
        type: success ? "schedule_complete" : "schedule_failed",
        title: `${schedule.name} ${success ? "completed" : "failed"}`,
        message: success
          ? (dbTask.result || "Task completed successfully").substring(0, 200)
          : (dbTask.error || "Task failed").substring(0, 200),
        task_id: dbTask._id,
        schedule_id: schedule._id,
      });
    }
  } catch (err) {
    log.error(`Scheduled task execution error: ${err.message}`);

    // Update task as failed
    dbTask.status = "failed";
    dbTask.error = err.message;
    dbTask.completed_at = new Date();
    await dbTask.save().catch(() => {});

    // Still create notification
    if (schedule.notify) {
      await Notification.create({
        user_id: user._id,
        type: "schedule_failed",
        title: `${schedule.name} failed`,
        message: err.message.substring(0, 200),
        task_id: dbTask._id,
        schedule_id: schedule._id,
      }).catch(() => {});
    }
  }
}

function startScheduler() {
  if (intervalHandle) return;

  log.info("Scheduler started — checking every 60 seconds");
  intervalHandle = setInterval(checkSchedules, 60 * 1000);

  // Also run an initial check after a short delay
  setTimeout(checkSchedules, 5000);
}

function stopScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info("Scheduler stopped");
  }
}

module.exports = { startScheduler, stopScheduler, setTaskRunner };
