const config = require("../config");
const { updateRecipeStats } = require("./store");
const { createLogger } = require("../utils/logger");

const log = createLogger("recipe-exec");

// ─── Variable Interpolation ──────────────────────────────────────────────────

function interpolate(str, ctx) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in ctx ? ctx[key] : `{{${key}}}`));
}

function interpolateDeep(obj, ctx) {
  if (typeof obj === "string") return interpolate(obj, ctx);
  if (Array.isArray(obj)) return obj.map((item) => interpolateDeep(item, ctx));
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateDeep(value, ctx);
    }
    return result;
  }
  return obj;
}

// ─── Screenshot Helper ───────────────────────────────────────────────────────

async function takeScreenshot(browser) {
  try {
    const buf = await browser.page.screenshot();
    return buf.toString("base64");
  } catch {
    return null;
  }
}

// ─── Settle Helper ───────────────────────────────────────────────────────────

async function settle(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    const delay = config.agent.settleDelay || 300;
    await new Promise((r) => setTimeout(r, delay));
    await page.waitForLoadState("networkidle", { timeout: config.agent.networkIdleTimeout || 1500 }).catch(() => {});
  } catch {
    // settle is best-effort
  }
}

// ─── Target Resolution ───────────────────────────────────────────────────────

async function resolveTarget(page, targets) {
  const attempted = [];

  for (const t of targets) {
    try {
      let locator;

      switch (t.strategy) {
        case "label":
          locator = page.getByLabel(t.value, { exact: false });
          break;
        case "placeholder":
          locator = page.getByPlaceholder(t.value, { exact: false });
          break;
        case "role":
          locator = page.getByRole(t.value, { name: t.name, exact: false });
          break;
        case "text":
          locator = page.getByText(t.value, { exact: false });
          break;
        case "selector":
          locator = page.locator(t.value);
          break;
        case "role_nested": {
          let nested = page.getByRole(t.parent_role).getByRole(t.child_role);
          if (t.pick === "first") nested = nested.first();
          else if (t.pick === "last") nested = nested.last();
          else if (typeof t.pick === "number") nested = nested.nth(t.pick);
          locator = nested;
          break;
        }
        case "role_filtered": {
          const options = page.getByRole(t.parent_role).getByRole(t.child_role);
          const filterText = t.filter_text;
          if (filterText) {
            // Start with strict match: option text starts with the filter text
            const escaped = filterText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            let candidates = options.filter({ hasText: new RegExp("^\\s*" + escaped, "i") });
            // Apply exclude pattern if provided
            if (t.exclude_text) {
              candidates = candidates.filter({ hasNotText: new RegExp(t.exclude_text, "i") });
            }
            if (await candidates.count() > 0) {
              locator = candidates.first();
              break;
            }
            // Fallback: any option containing the text (with exclude)
            let loose = options.filter({ hasText: filterText });
            if (t.exclude_text) {
              loose = loose.filter({ hasNotText: new RegExp(t.exclude_text, "i") });
            }
            if (await loose.count() > 0) {
              locator = loose.first();
              break;
            }
          }
          locator = options.first();
          break;
        }
        default:
          attempted.push(`${t.strategy}: unknown strategy`);
          continue;
      }

      // Check if element is visible (wait up to 7s)
      await locator.first().waitFor({ state: "visible", timeout: 7000 });
      return locator.first();
    } catch {
      attempted.push(`${t.strategy}: ${t.value || t.child_role || "?"}`);
    }
  }

  throw new Error(`No target resolved. Tried: ${attempted.join(", ")}`);
}

// ─── Assertions ──────────────────────────────────────────────────────────────

async function checkAssert(page, assert) {
  if (!assert) return;

  if (assert.url_contains) {
    const url = page.url();
    if (!url.includes(assert.url_contains)) {
      throw new Error(`Assertion failed: URL "${url}" does not contain "${assert.url_contains}"`);
    }
  }

  if (assert.title_contains) {
    const title = await page.title();
    if (!title.includes(assert.title_contains)) {
      throw new Error(`Assertion failed: title "${title}" does not contain "${assert.title_contains}"`);
    }
  }

  if (assert.text_visible) {
    try {
      await page.getByText(assert.text_visible, { exact: false }).first().waitFor({ state: "visible", timeout: 5000 });
    } catch {
      throw new Error(`Assertion failed: text "${assert.text_visible}" not visible on page`);
    }
  }
}

// ─── Structured Extraction ───────────────────────────────────────────────────

async function extractStructured(page, params) {
  const { scope, fields, max_results = 5, fallback_action } = params;

  const cards = page.locator(scope);
  const count = await cards.count();

  if (count === 0) {
    if (fallback_action === "getText") {
      const maxLen = config.agent.maxGetText || 3000;
      const text = await page.innerText("body").catch(() => "");
      return text.substring(0, maxLen);
    }
    return "No results found";
  }

  const results = [];
  const limit = Math.min(count, max_results);

  for (let i = 0; i < limit; i++) {
    const card = cards.nth(i);
    const row = {};

    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      let text = "";
      try {
        const sel = fieldDef.selector;
        if (fieldDef.index !== undefined) {
          text = await card.locator(sel).nth(fieldDef.index).innerText({ timeout: 2000 });
        } else {
          text = await card.locator(sel).first().innerText({ timeout: 2000 });
        }
      } catch {
        // Try fallback selector
        if (fieldDef.fallback) {
          try {
            text = await card.locator(fieldDef.fallback).first().innerText({ timeout: 2000 });
          } catch {
            text = "";
          }
        }
      }
      row[fieldName] = text.trim();
    }

    results.push(row);
  }

  // Format as readable text
  return results
    .map((row, idx) => {
      const parts = Object.entries(row)
        .map(([k, v]) => `${k}: ${v || "N/A"}`)
        .join(" | ");
      return `[${idx + 1}] ${parts}`;
    })
    .join("\n");
}

// ─── Wait For Any ────────────────────────────────────────────────────────────

async function waitForAny(page, params) {
  const { selectors, timeout = 10000 } = params;

  const promises = selectors.map((sel) => {
    if (sel.startsWith("text=")) {
      const text = sel.slice(5);
      return page
        .getByText(text, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout })
        .then(() => sel);
    }
    return page
      .locator(sel)
      .first()
      .waitFor({ state: "visible", timeout })
      .then(() => sel);
  });

  try {
    const matched = await Promise.any(promises);
    return `Matched: ${matched}`;
  } catch {
    return `None of ${selectors.length} selectors appeared within ${timeout}ms`;
  }
}

// ─── Step Execution ──────────────────────────────────────────────────────────

async function execStep(page, step, ctx, browser) {
  const params = interpolateDeep(step.params || {}, ctx);
  const action = step.action;

  // delay_before
  if (step.delay_before) {
    await new Promise((r) => setTimeout(r, step.delay_before));
  }

  let result;

  switch (action) {
    case "buildUrl": {
      const builder = require(`../url-builders/${params.builder}`);
      result = builder.buildUrl(params.args || params);
      break;
    }

    case "goto":
      await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: config.browser.timeout || 30000 });
      await settle(page);
      result = `Navigated to ${params.url}`;
      break;

    case "fill": {
      const el = step.target ? await resolveTarget(page, interpolateDeep(step.target, ctx)) : page.locator(params.selector);
      if (params.slow_type) {
        // Clear then type character-by-character to trigger autocomplete
        // Do NOT click here — use a separate click step if focusing is needed
        await el.fill("");
        await el.pressSequentially(params.text, { delay: 80 });
      } else {
        // Playwright fill() already clears existing text
        await el.fill(params.text);
      }
      result = `Filled with "${params.text}"`;
      break;
    }

    case "keyboardType": {
      // Type into whatever is currently focused — no locator needed
      // Use after a click step that focuses the target input
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await new Promise((r) => setTimeout(r, 200));
      await page.keyboard.type(params.text, { delay: params.delay || 80 });
      result = `Typed "${params.text}" via keyboard`;
      break;
    }

    case "click": {
      const el = step.target ? await resolveTarget(page, interpolateDeep(step.target, ctx)) : page.locator(params.selector);
      await el.click();
      await settle(page);
      result = `Clicked`;
      break;
    }

    case "pickOption": {
      const el = step.target ? await resolveTarget(page, interpolateDeep(step.target, ctx)) : page.locator(params.selector);
      await el.click();
      await settle(page);
      result = `Picked option`;
      break;
    }

    case "selectDialogDate": {
      // Pick a date button inside a dialog
      // Tries buttons with prices first (₹/$/€), falls back to gridcell date buttons
      const dialog = page.getByRole("dialog");
      let dateBtns = dialog.getByRole("button").filter({ hasText: /[\u20B9$€]/ });
      let count = await dateBtns.count();
      if (count === 0) {
        // No price buttons — use gridcell date buttons (just day numbers)
        dateBtns = dialog.locator("gridcell button");
        count = await dateBtns.count();
      }
      const idx = Math.min(params.offset || 0, Math.max(count - 1, 0));
      if (count > 0) {
        const text = await dateBtns.nth(idx).getAttribute("aria-label") || await dateBtns.nth(idx).innerText();
        await dateBtns.nth(idx).click();
        result = `Selected date: ${text.replace(/\n/g, " ")}`;
      } else {
        result = "No date buttons found in dialog";
      }
      break;
    }

    case "clickDialogButton": {
      // Click a named button inside a dialog
      const dlg = page.getByRole("dialog");
      const btn = dlg.getByRole("button", { name: params.name });
      await btn.click();
      await settle(page);
      result = `Clicked dialog button "${params.name}"`;
      break;
    }

    case "pressEnter":
      await page.keyboard.press("Enter");
      await settle(page);
      result = "Pressed Enter";
      break;

    case "scroll": {
      const dir = params.direction || "down";
      const delta = dir === "up" ? -500 : 500;
      await page.mouse.wheel(0, delta);
      await new Promise((r) => setTimeout(r, 500));
      result = `Scrolled ${dir}`;
      break;
    }

    case "back":
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      await settle(page);
      result = "Went back";
      break;

    case "waitForText":
      try {
        await page.getByText(params.text, { exact: false }).first().waitFor({ state: "visible", timeout: params.timeout || 10000 });
        result = `Text "${params.text}" found`;
      } catch {
        result = `Text "${params.text}" not found within timeout`;
      }
      break;

    case "waitForAny":
      result = await waitForAny(page, params);
      break;

    case "getText": {
      const maxLen = config.agent.maxGetText || 3000;
      const text = await page.innerText("body").catch(() => "");
      result = text.substring(0, maxLen);
      break;
    }

    case "extract":
      result = await extractStructured(page, params);
      break;

    case "extractList": {
      // Extract text from listitem elements within a heading-labeled section
      const maxResults = params.max_results || 5;
      const container = params.heading
        ? page.getByRole("heading", { name: params.heading, exact: false }).locator("..")
        : page.locator("main");
      const items = container.getByRole("listitem");
      const count = await items.count();
      const limit = Math.min(count, maxResults);
      const rows = [];
      for (let i = 0; i < limit; i++) {
        const text = await items.nth(i).innerText({ timeout: 3000 }).catch(() => "");
        if (text.trim()) rows.push(`[${i + 1}] ${text.trim().replace(/\n+/g, " | ")}`);
      }
      result = rows.length > 0 ? rows.join("\n") : "No items found";
      break;
    }

    case "fetchJson": {
      // Try to parse the current page body as JSON first (for API endpoints we already navigated to)
      // Fall back to fetch if a different URL is provided
      let data;
      try {
        const bodyText = await page.innerText("body", { timeout: 3000 });
        data = JSON.parse(bodyText);
      } catch {
        // Body isn't JSON — try fetching the URL
        data = await page.evaluate(async (u) => {
          const res = await fetch(u);
          return res.json();
        }, params.url);
      }
      result = JSON.stringify(data);
      break;
    }

    case "formatJson": {
      const json = JSON.parse(ctx[params.source] || "{}");
      const lines = [];
      for (const field of params.fields) {
        const value = field.path.split(".").reduce((obj, key) => {
          if (obj == null) return undefined;
          if (/^\d+$/.test(key)) return obj[parseInt(key)];
          return obj[key];
        }, json);
        lines.push(`${field.label}: ${value !== undefined ? value : "N/A"}`);
      }
      result = lines.join("\n");
      break;
    }

    case "extractDom": {
      // Extract data directly via page.evaluate with CSS selectors
      // params.selector: CSS selector for items, params.text_selector: inner selector for text, params.max_results
      const maxR = params.max_results || 10;
      const items = await page.evaluate(({ selector, textSelector, linkSelector, max }) => {
        const els = document.querySelectorAll(selector);
        const results = [];
        for (let i = 0; i < Math.min(els.length, max); i++) {
          const textEl = textSelector ? els[i].querySelector(textSelector) : els[i];
          const text = textEl?.textContent?.trim() || "";
          const linkEl = linkSelector ? els[i].querySelector(linkSelector) : els[i].closest("a");
          const href = linkEl?.href || "";
          if (text) results.push({ text, href });
        }
        return results;
      }, { selector: params.selector, textSelector: params.text_selector || null, linkSelector: params.link_selector || null, max: maxR });
      result = items.map((item, i) => `[${i + 1}] ${item.text}`).join("\n") || "No items found";
      break;
    }

    case "waitFor": {
      const ms = Math.min(Number(params.seconds) || 1, 10) * 1000;
      await new Promise((r) => setTimeout(r, ms));
      result = `Waited ${ms / 1000} seconds`;
      break;
    }

    case "done":
      result = interpolate(params.result || "Done", ctx);
      break;

    default:
      result = `Unknown action: ${action}`;
  }

  // delay_after
  if (step.delay_after) {
    await new Promise((r) => setTimeout(r, step.delay_after));
  }

  // Post-action assertion
  await checkAssert(page, step.assert);

  return result;
}

// ─── Main Executor ───────────────────────────────────────────────────────────

async function executeRecipe(recipe, variables, browser, callbacks = {}) {
  const { onStep, isCancelled } = callbacks;
  const startTime = Date.now();
  const steps = [];
  const ctx = { ...variables };

  log.info(`Executing recipe: ${recipe.name} (${recipe.steps.length} steps)`);

  for (let i = 0; i < recipe.steps.length; i++) {
    if (isCancelled && isCancelled()) {
      log.warn("Recipe cancelled");
      updateRecipeStats(recipe.id, false, Date.now() - startTime).catch(() => {});
      return { success: false, failed_at_step: i + 1, result: "Cancelled", steps };
    }

    const step = recipe.steps[i];
    const stepNum = i + 1;

    log.step(stepNum, `▶ ${step.action}${step.id ? ` [${step.id}]` : ""}`);

    try {
      const result = await execStep(browser.page, step, ctx, browser);

      // Store result in context if requested
      if (step.store_as) {
        ctx[step.store_as] = String(result);
      }

      const screenshot = await takeScreenshot(browser);
      const stepData = {
        step_number: stepNum,
        thought: step.comment || null,
        action: step.action,
        params: interpolateDeep(step.params || {}, ctx),
        result: String(result).substring(0, 500),
        screenshot_base64: screenshot,
        page_url: browser.page.url(),
        page_title: await browser.page.title(),
        timestamp: new Date().toISOString(),
        source: "recipe",
      };
      steps.push(stepData);
      if (onStep) onStep(stepData);

      if (step.action === "done") {
        const durationMs = Date.now() - startTime;
        updateRecipeStats(recipe.id, true, durationMs).catch(() => {});
        log.success(`Recipe completed in ${durationMs}ms`);
        return { success: true, result: String(result), steps, duration_ms: durationMs };
      }
    } catch (err) {
      if (step.optional) {
        log.warn(`Optional step ${stepNum} failed (continuing): ${err.message}`);
        const screenshot = await takeScreenshot(browser);
        const stepData = {
          step_number: stepNum,
          thought: step.comment || null,
          action: step.action,
          params: interpolateDeep(step.params || {}, ctx),
          result: `[SKIPPED] ${err.message}`,
          screenshot_base64: screenshot,
          page_url: browser.page.url(),
          page_title: await browser.page.title(),
          timestamp: new Date().toISOString(),
          source: "recipe",
        };
        steps.push(stepData);
        if (onStep) onStep(stepData);
        continue;
      }

      log.error(`Recipe step ${stepNum} failed: ${err.message}`);
      updateRecipeStats(recipe.id, false, Date.now() - startTime).catch(() => {});
      return { success: false, failed_at_step: stepNum, result: err.message, steps };
    }
  }

  const durationMs = Date.now() - startTime;
  updateRecipeStats(recipe.id, true, durationMs).catch(() => {});
  return { success: true, result: "Recipe completed", steps, duration_ms: durationMs };
}

module.exports = { executeRecipe };
