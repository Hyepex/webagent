const fs = require("fs");
const path = require("path");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const config = require("./config");
const BrowserController = require("./browser/controller");
const { runTask, executeAction } = require("./agent/executor");
const { matchRecipe, extractVariables } = require("./recipes/matcher");
const { executeRecipe } = require("./recipes/executor");
const { captureRecipe } = require("./recipes/capture");
const { getRecipes, getRecipeById, deleteRecipe } = require("./recipes/store");
const { createLogger } = require("./utils/logger");
const monitor = require("./utils/monitor");
const {
  validateInstruction,
  sanitizeInput,
  checkPerMinuteLimit,
  checkIpRateLimit,
  recordTaskResult,
  isUserPaused,
} = require("./middleware/taskLimits");

// Models (must be required after mongoose is loaded)
const TaskModel = require("./models/Task");
const User = require("./models/User");

// Routes
const authRoutes = require("./routes/auth");
const taskRoutes = require("./routes/tasks");
const recipeRoutes = require("./routes/recipes");
const templateRoutes = require("./routes/templates");
const scheduleRoutes = require("./routes/schedules");

// Seeds & Scheduler
const { seedTemplates } = require("./seeds/templates");
const { startScheduler, setTaskRunner } = require("./scheduler");

const log = createLogger("server");

// ─── State ──────────────────────────────────────────────────────────────────

const taskQueue = [];
let currentTaskId = null;
let cancelledTasks = new Set();
let browser = null;

// Map of socket.id → userId for authenticated socket connections
const socketUsers = new Map();

function genId() {
  return "task_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 6);
}

// ─── Ensure directories ─────────────────────────────────────────────────────

function ensureDirs() {
  for (const dir of [config.paths.screenshots, config.paths.recipes]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Screenshot helpers ─────────────────────────────────────────────────────

function saveScreenshot(taskId, stepNum, base64) {
  if (!base64) return null;
  const filename = `${taskId}_${stepNum}.png`;
  const filepath = path.join(config.paths.screenshots, filename);
  fs.writeFileSync(filepath, Buffer.from(base64, "base64"));
  return filename;
}

// ─── Browser Recovery ────────────────────────────────────────────────────────

async function ensureBrowser() {
  if (browser && browser.isAlive()) return;

  log.warn("Browser not alive, relaunching...");
  try {
    if (browser) await browser.close().catch(() => {});
  } catch {}

  browser = new BrowserController();
  const origHeadless = config.browser.headless;
  config.browser.headless = true;
  await browser.launch();
  config.browser.headless = origHeadless;
  log.success("Browser relaunched successfully");
}

// ─── Task Runner ────────────────────────────────────────────────────────────

async function processTask(task, io, dbTask) {
  currentTaskId = task.id;
  task.status = "running";
  task.started_at = new Date().toISOString();

  monitor.recordTaskStart();

  // Update DB status
  if (dbTask) {
    dbTask.status = "running";
    await dbTask.save().catch(() => {});
  }

  const isCancelled = () => cancelledTasks.has(task.id);

  try {
    // Ensure browser is alive before starting
    await ensureBrowser();

    // Create isolated browser context for this task
    await browser.createTaskContext();

    // Check for matching recipe
    const match = await matchRecipe(task.instruction);

    if (match) {
      task.mode = "recipe";
      task.recipe_id = match.recipe.id;
      io.emit("task:start", { taskId: task.id, mode: "recipe", recipeName: match.recipe.name });
      log.info(`Using recipe "${match.recipe.name}" for task ${task.id}`);

      const variables = await extractVariables(task.instruction, match.recipe.variables);

      const recipeResult = await executeRecipe(match.recipe, variables, browser, {
        isCancelled,
        onStep: (stepData) => {
          const filename = saveScreenshot(task.id, stepData.step_number, stepData.screenshot_base64);
          stepData.screenshot_file = filename;
          task.steps.push(stepData);
          io.emit("task:step", { taskId: task.id, step: stepData });

          // Save step to DB
          if (dbTask) {
            dbTask.steps.push({
              step_number: stepData.step_number,
              thought: stepData.thought,
              action: stepData.action,
              params: stepData.params,
              result: stepData.result,
              screenshot_url: filename ? `/screenshots/${filename}` : null,
              page_url: stepData.page_url,
              page_title: stepData.page_title,
              duration_ms: stepData.duration_ms,
              timestamp: new Date(),
            });
            dbTask.mode = "recipe";
            dbTask.recipe_id = match.recipe.id;
            dbTask.save().catch(() => {});
          }
        },
      });

      if (recipeResult.success) {
        task.status = "completed";
        task.result = recipeResult.result;
        task.duration_ms = recipeResult.duration_ms;
        task.completed_at = new Date().toISOString();
        io.emit("task:complete", {
          taskId: task.id,
          result: task.result,
          recipe_saved: false,
          mode: "recipe",
          duration_ms: task.duration_ms,
        });

        if (dbTask) {
          dbTask.status = "completed";
          dbTask.result = recipeResult.result;
          dbTask.duration_ms = recipeResult.duration_ms;
          dbTask.completed_at = new Date();
          await dbTask.save().catch(() => {});
        }

        monitor.recordTaskComplete(recipeResult.duration_ms);
        recordTaskResult(dbTask?.user_id?.toString(), true);
        log.success(`Task ${task.id} completed via recipe`);
      } else {
        // Recipe failed — fall back to LLM
        log.warn(`Recipe failed at step ${recipeResult.failed_at_step}, falling back to LLM`);
        task.mode = "llm";
        task.steps = [];
        if (dbTask) {
          dbTask.steps = [];
          dbTask.mode = "llm";
        }
        await runLLMTask(task, io, isCancelled, dbTask);
      }
    } else {
      task.mode = "llm";
      io.emit("task:start", { taskId: task.id, mode: "llm" });
      await runLLMTask(task, io, isCancelled, dbTask);
    }
  } catch (err) {
    task.status = "error";
    task.error = err.message;
    task.completed_at = new Date().toISOString();
    io.emit("task:error", { taskId: task.id, error: err.message });

    if (dbTask) {
      dbTask.status = "failed";
      dbTask.error = err.message;
      dbTask.completed_at = new Date();
      await dbTask.save().catch(() => {});
    }

    monitor.recordTaskFailed();
    monitor.recordError();
    recordTaskResult(dbTask?.user_id?.toString(), false);
    log.error(`Task ${task.id} failed: ${err.message}`);
  } finally {
    // ALWAYS clean up browser context
    try {
      await browser.closeTaskContext();
    } catch (cleanupErr) {
      log.warn(`Task context cleanup error: ${cleanupErr.message}`);
    }
  }

  currentTaskId = null;
  cancelledTasks.delete(task.id);

  // Process next in queue
  if (taskQueue.length > 0) {
    const next = taskQueue.shift();
    io.emit("task:start", { taskId: next.task.id, mode: "pending" });
    processTask(next.task, io, next.dbTask);
  }
}

async function runLLMTask(task, io, isCancelled, dbTask) {
  const result = await runTask(browser, task.instruction, {
    isCancelled,
    onStep: (stepData) => {
      const filename = saveScreenshot(task.id, stepData.step_number, stepData.screenshot_base64);
      stepData.screenshot_file = filename;
      task.steps.push(stepData);
      io.emit("task:step", { taskId: task.id, step: stepData });

      // Save step to DB
      if (dbTask) {
        dbTask.steps.push({
          step_number: stepData.step_number,
          thought: stepData.thought,
          action: stepData.action,
          params: stepData.params,
          result: stepData.result,
          screenshot_url: filename ? `/screenshots/${filename}` : null,
          page_url: stepData.page_url,
          page_title: stepData.page_title,
          duration_ms: stepData.duration_ms,
          timestamp: new Date(),
        });
        dbTask.mode = "llm";
        dbTask.save().catch(() => {});
      }
    },
    onComplete: () => {},
    onError: (err, stepNum) => {
      log.warn(`Step ${stepNum} error: ${err.message}`);
    },
  });

  task.status = "completed";
  task.result = result.result;
  task.duration_ms = result.duration_ms;
  task.completed_at = new Date().toISOString();

  // Try to capture recipe from successful LLM task
  let recipeSaved = false;
  if (result.steps && result.steps.length > 0) {
    try {
      const captured = captureRecipe(task.instruction, result);
      if (captured) recipeSaved = true;
    } catch (err) {
      log.warn(`Recipe capture failed: ${err.message}`);
    }
  }

  if (dbTask) {
    dbTask.status = "completed";
    dbTask.result = result.result;
    dbTask.duration_ms = result.duration_ms;
    dbTask.completed_at = new Date();
    await dbTask.save().catch(() => {});
  }

  monitor.recordTaskComplete(result.duration_ms);
  recordTaskResult(dbTask?.user_id?.toString(), true);

  io.emit("task:complete", {
    taskId: task.id,
    result: task.result,
    recipe_saved: recipeSaved,
    mode: "llm",
    duration_ms: task.duration_ms,
  });
  log.success(`Task ${task.id} completed via LLM${recipeSaved ? " (recipe saved)" : ""}`);
}

// ─── Express + Socket.IO ────────────────────────────────────────────────────

async function startServer() {
  ensureDirs();

  // ─── Connect to MongoDB ─────────────────────────────────────────────────
  try {
    await mongoose.connect(config.db.uri);
    log.success("Connected to MongoDB");

    // Seed templates on first startup
    await seedTemplates();
  } catch (err) {
    log.warn(`MongoDB connection failed: ${err.message} — running without database`);
  }

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(config.paths.public));
  app.use("/screenshots", express.static(config.paths.screenshots));

  // ─── Register Routes ──────────────────────────────────────────────────

  app.use("/api/auth", authRoutes);
  app.use("/api/recipes", recipeRoutes);
  app.use("/api/templates", templateRoutes);
  app.use("/api/schedules", scheduleRoutes);

  // Config endpoint (public) — returns google client ID for frontend
  app.get("/api/config", (_req, res) => {
    res.json({ googleClientId: config.auth.googleClientId });
  });

  // ─── Health Check Endpoint ────────────────────────────────────────────

  app.get("/api/health", async (_req, res) => {
    const recipes = await getRecipes().catch(() => []);
    const health = monitor.getMetrics(currentTaskId, taskQueue.length);
    health.recipe_count = recipes.length;
    health.mongodb = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
    health.browser_alive = browser ? browser.isAlive() : false;
    res.json(health);
  });

  // ─── Task creation endpoint (integrated with server task runner) ──────

  app.post("/api/tasks", async (req, res) => {
    // IP-based rate limiting for all requests
    const clientIp = req.ip || req.connection.remoteAddress;
    const ipCheck = checkIpRateLimit(clientIp);
    if (!ipCheck.allowed) {
      return res.status(429).json({
        error: `Too many requests. Try again in ${ipCheck.waitSec} seconds.`,
      });
    }

    // Validate and sanitize instruction
    const validation = validateInstruction(req.body.instruction);
    if (!validation.valid) {
      return res.status(validation.status).json({ error: validation.error });
    }
    const instruction = validation.cleaned;

    // Check for auth token — optional for backwards compat, required for persistence
    let user = null;
    let dbTask = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(authHeader.slice(7), config.auth.jwtSecret);
        user = await User.findById(payload.userId);
      } catch {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
    }

    // Rate limit checks for authenticated users
    if (user) {
      // Check if user is paused due to consecutive failures
      const pauseCheck = isUserPaused(user._id.toString());
      if (pauseCheck.paused) {
        return res.status(429).json({
          error: `Too many failed tasks. Please try again in ${pauseCheck.remainMin} minutes.`,
        });
      }

      // Per-minute rate limit
      const minuteCheck = checkPerMinuteLimit(user._id.toString());
      if (!minuteCheck.allowed) {
        return res.status(429).json({
          error: `Rate limit: max 2 tasks per minute. Try again in ${minuteCheck.waitSec} seconds.`,
        });
      }

      // Daily rate limit
      user.checkDailyReset();
      const DAILY_LIMITS = { free: 5, pro: 50, unlimited: Infinity };
      const limit = DAILY_LIMITS[user.plan] || DAILY_LIMITS.free;
      if (user.tasks_today >= limit) {
        return res.status(429).json({
          error: `Daily task limit reached (${limit} tasks). Upgrade your plan for more.`,
          tasks_today: user.tasks_today,
          limit,
        });
      }
    }

    const taskId = genId();
    const task = {
      id: taskId,
      instruction,
      status: "pending",
      steps: [],
      result: null,
      error: null,
      mode: null,
      recipe_id: null,
      tokens_used: 0,
      duration_ms: 0,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    // Create DB task if user is authenticated and MongoDB is available
    if (user && mongoose.connection.readyState === 1) {
      try {
        dbTask = await TaskModel.create({
          user_id: user._id,
          instruction,
          status: "pending",
        });
        task.id = dbTask._id.toString();
        user.tasks_today += 1;
        await user.save();
      } catch (err) {
        log.warn(`DB task creation failed: ${err.message}`);
      }
    }

    if (currentTaskId) {
      taskQueue.push({ task, dbTask });
      const position = taskQueue.length;
      io.emit("task:queued", { taskId: task.id, position });
      log.info(`Task ${task.id} queued at position ${position}`);
      return res.json({
        ...task,
        queue_position: position,
        tasks_remaining: user ? (({ free: 5, pro: 50 })[user.plan] || 5) - user.tasks_today : null,
      });
    }

    processTask(task, io, dbTask);
    return res.json({
      ...task,
      tasks_remaining: user ? (({ free: 5, pro: 50 })[user.plan] || 5) - user.tasks_today : null,
    });
  });

  // Task list — returns user's tasks from DB if authenticated, else empty
  app.get("/api/tasks", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.json({ tasks: [], total: 0 });
    }

    try {
      const payload = jwt.verify(authHeader.slice(7), config.auth.jwtSecret);
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
      const skip = (page - 1) * limit;

      const tasks = await TaskModel.find({ user_id: payload.userId })
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .select("instruction status mode recipe_id result error duration_ms created_at completed_at steps");

      const total = await TaskModel.countDocuments({ user_id: payload.userId });

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
    } catch {
      res.json({ tasks: [], total: 0 });
    }
  });

  // Task detail — returns task if owned by authenticated user
  app.get("/api/tasks/:id", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const payload = jwt.verify(authHeader.slice(7), config.auth.jwtSecret);
      const task = await TaskModel.findOne({ _id: req.params.id, user_id: payload.userId });
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
    } catch {
      res.status(500).json({ error: "Failed to fetch task" });
    }
  });

  // Cancel/delete task
  app.delete("/api/tasks/:id", async (req, res) => {
    const taskId = req.params.id;

    // Check in-memory running task
    if (currentTaskId === taskId) {
      cancelledTasks.add(taskId);
      log.info(`Cancelling task ${taskId}`);
      return res.json({ cancelled: true });
    }

    // Check queue
    const qIdx = taskQueue.findIndex((t) => t.task.id === taskId);
    if (qIdx !== -1) {
      const removed = taskQueue.splice(qIdx, 1)[0];
      if (removed.dbTask) {
        removed.dbTask.status = "cancelled";
        removed.dbTask.completed_at = new Date();
        await removed.dbTask.save().catch(() => {});
      }
      return res.json({ cancelled: true });
    }

    // Check DB
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(authHeader.slice(7), config.auth.jwtSecret);
        const task = await TaskModel.findOne({ _id: taskId, user_id: payload.userId });
        if (task) {
          if (task.status === "pending" || task.status === "running") {
            task.status = "cancelled";
            task.completed_at = new Date();
            await task.save();
            cancelledTasks.add(taskId);
            return res.json({ cancelled: true });
          }
          await TaskModel.deleteOne({ _id: task._id });
          return res.json({ deleted: true });
        }
      } catch {}
    }

    return res.status(404).json({ error: "Task not found or already completed" });
  });

  app.get("/api/status", async (_req, res) => {
    const recipes = await getRecipes().catch(() => []);
    res.json({
      agent: currentTaskId ? "running" : "idle",
      current_task: currentTaskId,
      queue_length: taskQueue.length,
      recipe_count: recipes.length,
    });
  });

  // ─── Global Error Handler ─────────────────────────────────────────────

  app.use((err, _req, res, _next) => {
    log.error(`Unhandled route error: ${err.message}`);
    monitor.recordError();
    res.status(500).json({ error: "Internal server error" });
  });

  // ─── Socket.IO ──────────────────────────────────────────────────────────

  io.on("connection", (socket) => {
    log.info(`Client connected: ${socket.id}`);

    // Authenticate socket connection
    socket.on("auth", (token) => {
      try {
        const payload = jwt.verify(token, config.auth.jwtSecret);
        socketUsers.set(socket.id, payload.userId);
        log.debug(`Socket ${socket.id} authenticated as user ${payload.userId}`);
      } catch {
        log.debug(`Socket ${socket.id} auth failed`);
      }
    });

    socket.on("task:cancel", ({ taskId }) => {
      if (currentTaskId === taskId) {
        cancelledTasks.add(taskId);
        log.info(`Cancel requested for ${taskId}`);
      }
    });

    socket.on("disconnect", () => {
      socketUsers.delete(socket.id);
      log.debug(`Client disconnected: ${socket.id}`);
    });
  });

  // ─── Process-Level Error Handlers ─────────────────────────────────────

  process.on("uncaughtException", (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    log.error(err.stack || "");
    monitor.recordError();
    // Keep running — don't crash
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error(`Unhandled rejection: ${msg}`);
    monitor.recordError();
    // Keep running — don't crash
  });

  // ─── Launch browser and start listening ────────────────────────────────

  // Server mode always runs headless
  const origHeadless = config.browser.headless;
  config.browser.headless = true;

  browser = new BrowserController();
  await browser.launch();

  config.browser.headless = origHeadless;

  // ─── Scheduled Task Runner ───────────────────────────────────────────
  // This function is called by the scheduler to run tasks for schedules
  setTaskRunner(async (instruction, userId, dbTask) => {
    const taskId = dbTask._id.toString();
    const task = {
      id: taskId,
      instruction,
      status: "pending",
      steps: [],
      result: null,
      error: null,
      mode: null,
      recipe_id: null,
      tokens_used: 0,
      duration_ms: 0,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    // Queue the scheduled task like a regular task
    if (currentTaskId) {
      return new Promise((resolve, reject) => {
        const wrappedTask = { task, dbTask, _resolve: resolve, _reject: reject, _scheduled: true };
        taskQueue.push(wrappedTask);
        log.info(`Scheduled task ${taskId} queued at position ${taskQueue.length}`);
      });
    }

    await processTask(task, io, dbTask);
    return task;
  });

  httpServer.listen(config.server.port, config.server.host, async () => {
    const recipes = await getRecipes().catch(() => []);
    log.raw("\n+------------------------------------------------------+");
    log.raw("|          WebAgent — Dashboard Server                  |");
    log.raw("+------------------------------------------------------+\n");
    log.success(`Server running at http://localhost:${config.server.port}`);
    log.info(`LLM: ${config.llm.primaryModel} (fallback: ${config.llm.fallbackModel})`);
    log.info(`MongoDB: ${mongoose.connection.readyState === 1 ? "connected" : "not connected"}`);
    log.info(`Recipes loaded: ${recipes.length}`);
    log.info(`Health check: http://localhost:${config.server.port}/api/health`);

    // Start scheduler if MongoDB is connected
    if (mongoose.connection.readyState === 1) {
      startScheduler();
    }
  });
}

startServer().catch((err) => {
  log.error(`Failed to start server: ${err.message}`);
  console.error(err);
  process.exit(1);
});
