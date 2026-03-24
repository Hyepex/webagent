const { createLogger } = require("./logger");

const log = createLogger("monitor");

// ─── Metrics Store ───────────────────────────────────────────────────────────

const metrics = {
  startedAt: Date.now(),
  tasksToday: 0,
  tasksCompleted: 0,
  tasksFailed: 0,
  totalDurationMs: 0,
  llmTokensUsed: 0,
  errors: 0,
  securityBlocks: 0,
  _todayDate: new Date().toDateString(),
};

function _resetIfNewDay() {
  const today = new Date().toDateString();
  if (today !== metrics._todayDate) {
    metrics.tasksToday = 0;
    metrics.tasksCompleted = 0;
    metrics.tasksFailed = 0;
    metrics.totalDurationMs = 0;
    metrics.llmTokensUsed = 0;
    metrics.errors = 0;
    metrics.securityBlocks = 0;
    metrics._todayDate = today;
  }
}

// ─── Record Events ───────────────────────────────────────────────────────────

function recordTaskStart() {
  _resetIfNewDay();
  metrics.tasksToday++;
}

function recordTaskComplete(durationMs) {
  _resetIfNewDay();
  metrics.tasksCompleted++;
  metrics.totalDurationMs += durationMs || 0;
}

function recordTaskFailed() {
  _resetIfNewDay();
  metrics.tasksFailed++;
}

function recordError() {
  _resetIfNewDay();
  metrics.errors++;
}

function recordSecurityBlock() {
  _resetIfNewDay();
  metrics.securityBlocks++;
}

function recordTokenUsage(tokens) {
  _resetIfNewDay();
  metrics.llmTokensUsed += tokens || 0;
}

// ─── Get Metrics ─────────────────────────────────────────────────────────────

function getMetrics(activeTaskId, queueLength) {
  _resetIfNewDay();

  const uptimeMs = Date.now() - metrics.startedAt;
  const avgDuration = metrics.tasksCompleted > 0
    ? Math.round(metrics.totalDurationMs / metrics.tasksCompleted)
    : 0;
  const successRate = metrics.tasksToday > 0
    ? Math.round((metrics.tasksCompleted / metrics.tasksToday) * 100)
    : 100;

  return {
    status: "ok",
    uptime: Math.round(uptimeMs / 1000),
    uptime_human: formatUptime(uptimeMs),
    active_tasks: activeTaskId ? 1 : 0,
    queue_length: queueLength || 0,
    today: {
      tasks_total: metrics.tasksToday,
      tasks_completed: metrics.tasksCompleted,
      tasks_failed: metrics.tasksFailed,
      success_rate: `${successRate}%`,
      avg_duration_ms: avgDuration,
      llm_tokens_used: metrics.llmTokensUsed,
      errors: metrics.errors,
      security_blocks: metrics.securityBlocks,
    },
    memory_usage: {
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  };
}

function formatUptime(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

// ─── Hourly Summary Log ──────────────────────────────────────────────────────

setInterval(() => {
  _resetIfNewDay();
  const m = metrics;
  const avgDur = m.tasksCompleted > 0 ? Math.round(m.totalDurationMs / m.tasksCompleted / 1000) : 0;
  log.info(
    `Hourly: ${m.tasksToday} tasks (${m.tasksCompleted} ok, ${m.tasksFailed} fail), ` +
    `avg ${avgDur}s, ${m.llmTokensUsed} tokens, ${m.errors} errors, ${m.securityBlocks} blocked`
  );
}, 60 * 60 * 1000);

module.exports = {
  recordTaskStart,
  recordTaskComplete,
  recordTaskFailed,
  recordError,
  recordSecurityBlock,
  recordTokenUsage,
  getMetrics,
};
