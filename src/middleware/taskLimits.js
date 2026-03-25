const { createLogger } = require("../utils/logger");

const log = createLogger("taskLimits");

// ─── Configuration ───────────────────────────────────────────────────────────

const LIMITS = {
  maxTaskDuration: 5 * 60 * 1000, // 5 minutes
  maxStepsPerTask: 30,
  maxScreenshotsPerTask: 30,
  maxConcurrentTasks: 1,
  maxInstructionLength: 500,
};

// ─── Suspicious Instruction Patterns ─────────────────────────────────────────

const SUSPICIOUS_PATTERNS = [
  /\bpassword\b/i,
  /\blogin\s+to\s+my\b/i,
  /\bcredit\s*card\b/i,
  /\bbank\s*account\b/i,
  /\bsocial\s*security\b/i,
  /\bssn\b/i,
  /\btransfer\s+(money|funds)\b/i,
  /\bwire\s+transfer\b/i,
  /\bpayment\s+details?\b/i,
];

// ─── Input Sanitization ──────────────────────────────────────────────────────

function sanitizeInput(text) {
  if (typeof text !== "string") return "";
  // Strip HTML tags
  let clean = text.replace(/<[^>]*>/g, "");
  // Trim whitespace
  clean = clean.trim();
  return clean;
}

// ─── Validate Task Instruction ───────────────────────────────────────────────

function validateInstruction(instruction) {
  if (!instruction || typeof instruction !== "string") {
    return { valid: false, error: "instruction is required", status: 400 };
  }

  const cleaned = sanitizeInput(instruction);

  if (!cleaned) {
    return { valid: false, error: "instruction cannot be empty", status: 400 };
  }

  if (cleaned.length > LIMITS.maxInstructionLength) {
    return {
      valid: false,
      error: `instruction too long (max ${LIMITS.maxInstructionLength} characters, got ${cleaned.length})`,
      status: 400,
    };
  }

  // Check for suspicious patterns
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(cleaned)) {
      log.security(`Blocked suspicious instruction: "${cleaned.substring(0, 100)}..."`);
      return {
        valid: false,
        error: "This task contains sensitive keywords and cannot be executed for security reasons",
        status: 403,
      };
    }
  }

  return { valid: true, cleaned };
}

// ─── Per-Minute Rate Limiting (in-memory) ────────────────────────────────────

const minuteRateLimits = new Map(); // userId → { count, resetAt }

function checkPerMinuteLimit(userId, maxPerMinute = 2) {
  const now = Date.now();
  const entry = minuteRateLimits.get(userId);

  if (!entry || now >= entry.resetAt) {
    minuteRateLimits.set(userId, { count: 1, resetAt: now + 60000 });
    return { allowed: true };
  }

  if (entry.count >= maxPerMinute) {
    const waitSec = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, waitSec };
  }

  entry.count++;
  return { allowed: true };
}

// ─── IP-Based Rate Limiting ──────────────────────────────────────────────────

const ipRateLimits = new Map(); // ip → { count, resetAt }

function checkIpRateLimit(ip, maxPerMinute = 5) {
  const now = Date.now();
  const entry = ipRateLimits.get(ip);

  if (!entry || now >= entry.resetAt) {
    ipRateLimits.set(ip, { count: 1, resetAt: now + 60000 });
    return { allowed: true };
  }

  if (entry.count >= maxPerMinute) {
    const waitSec = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, waitSec };
  }

  entry.count++;
  return { allowed: true };
}

// ─── Consecutive Failure Tracking ────────────────────────────────────────────

const failureTracking = new Map(); // userId → { count, pausedUntil }

function recordTaskResult(userId, success) {
  if (!userId) return;

  const entry = failureTracking.get(userId) || { count: 0, pausedUntil: null };

  if (success) {
    entry.count = 0;
    entry.pausedUntil = null;
  } else {
    entry.count++;
    if (entry.count >= 5) {
      entry.pausedUntil = Date.now() + 60 * 60 * 1000; // 1 hour pause
      log.security(`User ${userId} paused for 1 hour after 5 consecutive failures`);
    }
  }

  failureTracking.set(userId, entry);
}

function isUserPaused(userId) {
  if (!userId) return { paused: false };

  const entry = failureTracking.get(userId);
  if (!entry || !entry.pausedUntil) return { paused: false };

  if (Date.now() >= entry.pausedUntil) {
    entry.pausedUntil = null;
    entry.count = 0;
    return { paused: false };
  }

  const remainMin = Math.ceil((entry.pausedUntil - Date.now()) / 60000);
  return { paused: true, remainMin };
}

// ─── Periodic cleanup of stale rate limit entries ────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of minuteRateLimits) {
    if (now >= val.resetAt) minuteRateLimits.delete(key);
  }
  for (const [key, val] of ipRateLimits) {
    if (now >= val.resetAt) ipRateLimits.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = {
  LIMITS,
  validateInstruction,
  sanitizeInput,
  checkPerMinuteLimit,
  checkIpRateLimit,
  recordTaskResult,
  isUserPaused,
};
