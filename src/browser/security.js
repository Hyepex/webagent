const { createLogger } = require("../utils/logger");

const log = createLogger("security");

// ─── Blocked Domain Patterns ─────────────────────────────────────────────────

const BLOCKED_DOMAINS = [
  // Banking sites
  "*.sbi.co.in", "*.hdfcbank.com", "*.icicibank.com", "netbanking.*",
  "*.bankofamerica.com", "*.chase.com",
  // Payment sites
  "*.paypal.com", "*.stripe.com", "pay.google.com", "*.razorpay.com",
  // Auth/credential pages
  "accounts.google.com", "login.microsoft.com", "*.okta.com",
  // Internal/local
  "localhost", "127.0.0.1",
];

const BLOCKED_IP_PREFIXES = ["192.168.", "10.", "172.16.", "172.17.", "172.18.",
  "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
  "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31."];

const BLOCKED_PATH_PATTERNS = ["/admin", "/wp-admin", "/dashboard"];

const BLOCKED_PROTOCOLS = ["file:"];

// ─── Domain Matching ─────────────────────────────────────────────────────────

function domainMatchesPattern(hostname, pattern) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith("." + suffix);
  }
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return hostname === prefix || hostname.startsWith(prefix + ".");
  }
  return hostname === pattern;
}

// ─── isUrlAllowed ────────────────────────────────────────────────────────────

function isUrlAllowed(url) {
  try {
    // Normalize URL
    let normalizedUrl = url;
    if (!/^[a-zA-Z]+:\/\//.test(normalizedUrl)) {
      normalizedUrl = "https://" + normalizedUrl;
    }

    const parsed = new URL(normalizedUrl);

    // Block dangerous protocols
    for (const proto of BLOCKED_PROTOCOLS) {
      if (parsed.protocol === proto) {
        return { allowed: false, reason: `Blocked protocol: ${parsed.protocol}` };
      }
    }

    const hostname = parsed.hostname.toLowerCase();

    // Block local/internal IPs
    for (const prefix of BLOCKED_IP_PREFIXES) {
      if (hostname.startsWith(prefix)) {
        return { allowed: false, reason: `Blocked internal/local address: ${hostname}` };
      }
    }

    // Block known domains
    for (const pattern of BLOCKED_DOMAINS) {
      if (domainMatchesPattern(hostname, pattern)) {
        return { allowed: false, reason: `Blocked domain: ${hostname} (matches ${pattern})` };
      }
    }

    // Block admin/dashboard paths
    const pathname = parsed.pathname.toLowerCase();
    for (const pathPattern of BLOCKED_PATH_PATTERNS) {
      if (pathname === pathPattern || pathname.startsWith(pathPattern + "/")) {
        return { allowed: false, reason: `Blocked admin path: ${pathname}` };
      }
    }

    return { allowed: true, reason: "OK" };
  } catch (err) {
    return { allowed: false, reason: `Invalid URL: ${err.message}` };
  }
}

// ─── Prompt Injection Patterns ───────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /disregard\s+(the\s+)?(above|previous|prior)/gi,
  /you\s+are\s+now\s+/gi,
  /system\s*:\s*/gi,
  /\[system\]/gi,
  /\[INST\]/gi,
  /<<\s*SYS\s*>>/gi,
  /new\s+instructions?\s*:/gi,
  /override\s+(previous\s+)?instructions/gi,
  /forget\s+(everything|all|your|the)\s/gi,
  /act\s+as\s+(if|though)\s+you/gi,
  /pretend\s+(you\s+are|to\s+be)/gi,
  /from\s+now\s+on\s*,?\s*(you|ignore|forget)/gi,
];

// Zero-width characters used to hide text
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u2060\u2061\u2062\u2063\u2064]/g;

// HTML comments
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

const MAX_CONTENT_LENGTH = 2000;

function sanitizePageContent(text) {
  if (!text || typeof text !== "string") return "";

  let sanitized = text;

  // Remove zero-width characters
  sanitized = sanitized.replace(ZERO_WIDTH_RE, "");

  // Remove HTML comments
  sanitized = sanitized.replace(HTML_COMMENT_RE, "");

  // Remove prompt injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[filtered]");
  }

  // Truncate to max length
  if (sanitized.length > MAX_CONTENT_LENGTH) {
    sanitized = sanitized.substring(0, MAX_CONTENT_LENGTH) + "... [truncated]";
  }

  return sanitized;
}

module.exports = { isUrlAllowed, sanitizePageContent, BLOCKED_DOMAINS, BLOCKED_PATH_PATTERNS };
