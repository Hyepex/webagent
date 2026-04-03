"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const ROOT = path.resolve(__dirname, "..");

const config = {
  browser: {
    headless: process.env.BROWSER_HEADLESS === "true",
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null,
    timeout: parseInt(process.env.BROWSER_TIMEOUT) || 30000,
    defaultTimeout: parseInt(process.env.BROWSER_DEFAULT_TIMEOUT) || 15000,
    viewportWidth: parseInt(process.env.BROWSER_WIDTH) || 1280,
    viewportHeight: parseInt(process.env.BROWSER_HEIGHT) || 800,
    userAgent:
      process.env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    launchArgs: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
    ],
  },
  agent: {
    maxSteps: parseInt(process.env.MAX_STEPS) || 30,
    stepTimeout: parseInt(process.env.STEP_TIMEOUT) || 120000,
    settleDelay: parseInt(process.env.SETTLE_DELAY) || 300,
    networkIdleTimeout: parseInt(process.env.NETWORK_IDLE_TIMEOUT) || 1500,
    maxElements: parseInt(process.env.MAX_ELEMENTS) || 30,
    maxVisibleText: parseInt(process.env.MAX_VISIBLE_TEXT) || 1500,
    maxGetText: parseInt(process.env.MAX_GET_TEXT) || 3000,
    maxHistoryMessages: parseInt(process.env.MAX_HISTORY) || 14,
  },
  // SSE transport port (used when started with --sse)
  server: {
    port: parseInt(process.env.PORT) || 3000,
  },
  paths: {
    root: ROOT,
    screenshots: path.join(ROOT, "screenshots"),
    recipes: path.join(ROOT, "recipes"),
  },
  recipes: {
    matchThreshold: parseFloat(process.env.RECIPE_MATCH_THRESHOLD) || 0.6,
  },
};

module.exports = config;
