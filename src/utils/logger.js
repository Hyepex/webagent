const COLORS = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const LEVELS = {
  debug: { color: COLORS.gray, label: "DBG" },
  info: { color: COLORS.blue, label: "INF" },
  success: { color: COLORS.green, label: "OK " },
  warn: { color: COLORS.yellow, label: "WRN" },
  error: { color: COLORS.red, label: "ERR" },
  step: { color: COLORS.cyan, label: "STP" },
  security: { color: COLORS.magenta, label: "SEC" },
  task: { color: COLORS.cyan, label: "TSK" },
};

function timestamp() {
  return new Date().toISOString().substring(11, 19);
}

function createLogger(module) {
  const log = (level, message) => {
    const { color, label } = LEVELS[level] || LEVELS.info;
    console.log(`${COLORS.gray}${timestamp()}${COLORS.reset} ${color}[${label}]${COLORS.reset} ${COLORS.gray}[${module}]${COLORS.reset} ${message}`);
  };

  return {
    debug: (msg) => log("debug", msg),
    info: (msg) => log("info", msg),
    success: (msg) => log("success", msg),
    warn: (msg) => log("warn", msg),
    error: (msg) => log("error", msg),
    step: (stepNum, msg) => log("step", `[Step ${stepNum}] ${msg}`),
    security: (msg) => log("security", msg),
    taskLifecycle: (event, details = {}) => {
      const detailStr = Object.entries(details).map(([k, v]) => `${k}=${v}`).join(" ");
      log("task", `[${event}] ${detailStr}`);
    },
    raw: (msg) => console.log(msg),
  };
}

module.exports = { createLogger };
