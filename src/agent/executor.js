const config = require("../config");
const Planner = require("./planner");
const { isUrlAllowed, sanitizePageContent } = require("../browser/security");
const { createLogger } = require("../utils/logger");

const log = createLogger("executor");

function detectSearchQuery(task) {
  const lower = task.toLowerCase().trim();
  if (/search|google|look up|find info|what is|who is|where is/i.test(lower)) {
    const query = task.replace(/^(search|google|look up|find)\s+(for\s+)?/i, "").trim();
    return query || null;
  }
  return null;
}

// ─── Action Security Validator ───────────────────────────────────────────────

function validateAction(action, params) {
  // Check goto actions against URL blocklist
  if (action === "goto" && params?.url) {
    const check = isUrlAllowed(params.url);
    if (!check.allowed) {
      log.security(`Blocked LLM goto action: ${params.url} — ${check.reason}`);
      return { valid: false, reason: check.reason };
    }
  }

  // Block type actions that look like credentials
  if (action === "type" && params?.text) {
    const text = params.text.toLowerCase();
    // Don't block normal typing, only flag if combined with suspicious selectors
    if (params.selector && /password|passwd|pwd/i.test(params.selector)) {
      log.security(`Blocked password entry attempt into ${params.selector}`);
      return { valid: false, reason: "Cannot enter passwords for security" };
    }
  }

  return { valid: true };
}

async function executeAction(browser, action, params) {
  const timeout = config.agent.stepTimeout;

  // Validate action before execution
  const validation = validateAction(action, params);
  if (!validation.valid) {
    return `Blocked: ${validation.reason}`;
  }

  const actionFn = async () => {
    switch (action) {
      case "goto":          return browser.goto(params.url);
      case "clickElement":  return browser.clickElement(params.number);
      case "type":          return browser.type(params.selector, params.text);
      case "fill":          return browser.fill(params.label, params.text);
      case "clickByText":   return browser.clickByText(params.text);
      case "clickByRole":   return browser.clickByRole(params.role, params.name);
      case "selectOption":  return browser.selectOption(params.label, params.value);
      case "pickOption":    return browser.pickOption(params.text);
      case "waitForText":   return browser.waitForText(params.text);
      case "getText":       return browser.getText();
      case "scroll":        return browser.scroll(params.direction);
      case "pressEnter":    return browser.pressEnter();
      case "back":          return browser.back();
      default:              return `Unknown action: ${action}`;
    }
  };

  return Promise.race([
    actionFn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Action timed out")), timeout)),
  ]);
}

async function takeScreenshot(browser) {
  try {
    if (!browser.page) return null;
    const buf = await browser.page.screenshot();
    return buf.toString("base64");
  } catch {
    return null;
  }
}

async function runTask(browser, task, callbacks = {}) {
  const { onStep, onComplete, onError, isCancelled } = callbacks;
  const maxSteps = config.agent.maxSteps;
  const planner = new Planner();
  const steps = [];
  const startTime = Date.now();
  let consecutiveTimeouts = 0;
  const MAX_CONSECUTIVE_TIMEOUTS = 2;
  let retryCount = 0;
  const MAX_LLM_RETRIES = 3;

  log.raw(`\n${"=".repeat(60)}`);
  log.raw(`  Task: ${task}`);
  log.raw(`${"=".repeat(60)}\n`);

  log.taskLifecycle("started", { task: task.substring(0, 100) });

  try {
    // Search shortcut
    const searchQuery = detectSearchQuery(task);
    let observation = null;

    if (searchQuery) {
      log.success(`Shortcut: direct Google search for "${searchQuery}"`);
      const encoded = encodeURIComponent(searchQuery);
      observation = await browser.goto(`https://www.google.com/search?q=${encoded}`);
      planner.reset(task);
      planner.addContext(`I already searched Google for you. Here's the page:\n${observation}`);
    } else {
      planner.reset(task);
    }

    for (let step = 1; step <= maxSteps; step++) {
      // Check cancellation
      if (isCancelled && isCancelled()) {
        log.warn("Task cancelled by user");
        log.taskLifecycle("cancelled", { step, duration_ms: Date.now() - startTime });
        return { result: "Task cancelled", steps, duration_ms: Date.now() - startTime };
      }

      try {
        let plan;
        try {
          plan = await planner.getNextAction(step === 1 && searchQuery ? null : observation);
          consecutiveTimeouts = 0; // Reset on successful LLM call
          retryCount = 0;
        } catch (llmErr) {
          // Handle LLM rate limiting
          if (llmErr.status === 429 || llmErr.error?.type === "rate_limit_error") {
            retryCount++;
            if (retryCount >= MAX_LLM_RETRIES) {
              const errMsg = "LLM rate limited after 3 retries. Task stopped.";
              log.error(errMsg);
              if (onError) onError(new Error(errMsg), step);
              const taskResult = { result: errMsg, steps, duration_ms: Date.now() - startTime };
              if (onComplete) onComplete(taskResult);
              return taskResult;
            }
            log.warn(`LLM rate limited (attempt ${retryCount}/${MAX_LLM_RETRIES}), retrying...`);
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          throw llmErr;
        }

        if (!plan) {
          log.step(step, "Skipped (bad AI response)");
          observation = await browser.getPageInfo();
          continue;
        }

        if (plan.action === "done") {
          const result = plan.params?.result || plan.result || "Task complete";
          log.raw(`\n  [Done] ${result}\n`);

          const screenshot = await takeScreenshot(browser);
          const stepData = {
            step_number: step,
            thought: plan.thought || null,
            action: "done",
            params: plan.params,
            result,
            screenshot_base64: screenshot,
            page_url: browser.page ? browser.page.url() : "",
            page_title: browser.page ? await browser.page.title() : "",
            timestamp: new Date().toISOString(),
          };
          steps.push(stepData);
          if (onStep) onStep(stepData);

          log.taskLifecycle("completed", { steps: step, duration_ms: Date.now() - startTime });
          const taskResult = { result, steps, duration_ms: Date.now() - startTime };
          if (onComplete) onComplete(taskResult);
          return taskResult;
        }

        // Validate action before execution
        const validation = validateAction(plan.action, plan.params);
        if (!validation.valid) {
          log.step(step, `Blocked: ${validation.reason}`);
          observation = `Action blocked: ${validation.reason}. Choose a different action.`;
          continue;
        }

        const paramStr = plan.params ? JSON.stringify(plan.params) : "";
        log.step(step, `> ${plan.action}(${paramStr})`);

        // Sanitize any page content before sending to LLM
        observation = await executeAction(browser, plan.action, plan.params || {});

        if (typeof observation === "string") {
          observation = sanitizePageContent(observation);
        }

        const preview = String(observation).substring(0, 150).replace(/\n/g, " ");
        log.step(step, `< ${preview}${String(observation).length > 150 ? "..." : ""}`);

        // Reset timeout counter on successful action
        consecutiveTimeouts = 0;

        const screenshot = await takeScreenshot(browser);
        const stepData = {
          step_number: step,
          thought: plan.thought || null,
          action: plan.action,
          params: plan.params || {},
          result: String(observation).substring(0, 300),
          screenshot_base64: screenshot,
          page_url: browser.page ? browser.page.url() : "",
          page_title: browser.page ? await browser.page.title() : "",
          timestamp: new Date().toISOString(),
        };
        steps.push(stepData);
        if (onStep) onStep(stepData);
      } catch (err) {
        // Handle page load timeouts specifically
        if (err.message === "Action timed out" || err.message.includes("Navigation timeout") || err.message.includes("timeout")) {
          consecutiveTimeouts++;
          log.step(step, `Timeout (${consecutiveTimeouts}/${MAX_CONSECUTIVE_TIMEOUTS})`);

          if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
            const errMsg = `Task stopped after ${MAX_CONSECUTIVE_TIMEOUTS} consecutive timeouts`;
            log.error(errMsg);
            if (onError) onError(new Error(errMsg), step);
            const taskResult = { result: errMsg, steps, duration_ms: Date.now() - startTime };
            if (onComplete) onComplete(taskResult);
            return taskResult;
          }

          observation = `Error: Action timed out. Try a different approach.`;
        } else {
          observation = `Error: ${err.message}`;
          log.step(step, `Error: ${observation}`);
        }
        if (onError) onError(err, step);
      }
    }

    log.warn(`Reached maximum steps (${maxSteps}). Stopping.`);
    log.taskLifecycle("max_steps", { duration_ms: Date.now() - startTime });
    const taskResult = { result: "Task stopped — max steps reached.", steps, duration_ms: Date.now() - startTime };
    if (onComplete) onComplete(taskResult);
    return taskResult;

  } catch (fatalErr) {
    // Catch any unhandled error in the entire task loop
    log.error(`Fatal task error: ${fatalErr.message}`);
    log.taskLifecycle("failed", { error: fatalErr.message, duration_ms: Date.now() - startTime });
    if (onError) onError(fatalErr, 0);
    const taskResult = { result: `Task failed: ${fatalErr.message}`, steps, duration_ms: Date.now() - startTime };
    if (onComplete) onComplete(taskResult);
    return taskResult;
  }
}

module.exports = { runTask, executeAction };
