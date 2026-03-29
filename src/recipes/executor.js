const config = require("../config");
const { updateRecipeStats } = require("./store");
const { createLogger } = require("../utils/logger");

const log = createLogger("recipe-exec");

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 3000];

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

// ─── Page Health Check ───────────────────────────────────────────────────────

async function checkPageAlive(page) {
  try {
    await page.evaluate(() => document.readyState);
    return true;
  } catch (err) {
    throw new Error(`Page not responsive: ${err.message}`);
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

// ─── Result Validation ───────────────────────────────────────────────────────

function validateResult(result, validate) {
  if (!validate) return { valid: true };
  const text = String(result);
  const errors = [];

  if (validate.min_length && text.length < validate.min_length) {
    errors.push(`Result too short: ${text.length} chars (min: ${validate.min_length})`);
  }

  if (validate.max_length && text.length > validate.max_length) {
    errors.push(`Result too long: ${text.length} chars (max: ${validate.max_length})`);
  }

  if (validate.min_lines) {
    const lineCount = text.split("\n").filter((l) => l.trim()).length;
    if (lineCount < validate.min_lines) {
      errors.push(`Too few result lines: ${lineCount} (min: ${validate.min_lines})`);
    }
  }

  if (validate.must_contain) {
    for (const pattern of validate.must_contain) {
      if (!new RegExp(pattern, "i").test(text)) {
        errors.push(`Result missing required pattern: ${pattern}`);
      }
    }
  }

  if (validate.must_not_contain) {
    for (const pattern of validate.must_not_contain) {
      if (new RegExp(pattern, "i").test(text)) {
        errors.push(`Result contains blocked pattern: ${pattern}`);
      }
    }
  }

  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true };
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

  // Check page is responsive before interacting
  await checkPageAlive(page);

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

    case "extractFlights": {
      // Extract flight data from Google Flights using stable aria-label selectors.
      // PRIMARY: Parse div[role="link"][aria-label*="flight with"] — each aria-label
      //   contains price, airline, times, duration, stops in one sentence.
      // FALLBACK: Per-field aria-label spans inside li cards.
      // Output: one line per flight, formatted for comparePrices compatibility.
      const maxFlights = params.max_results || 5;

      const flights = await page.evaluate((max) => {
        const links = document.querySelectorAll('div[role="link"][aria-label*="flight with"]');
        const results = [];
        const seen = new Set();

        for (const link of links) {
          if (results.length >= max) break;
          const label = link.getAttribute("aria-label") || "";
          if (/price is unavailable/i.test(label)) continue;
          if (!/Indian rupees/i.test(label)) continue;

          const priceMatch = label.match(/(\d[\d,]*)\s*Indian rupees/i);
          const priceNum = priceMatch ? parseInt(priceMatch[1].replace(/,/g, "")) : null;
          if (!priceNum) continue;

          const airlineMatch = label.match(/flight with\s+(.+?)\.\s/i);
          const airline = airlineMatch ? airlineMatch[1].trim() : "";

          const timeMatches = [...label.matchAll(/at\s+(\d{1,2}:\d{2}\s*(?:AM|PM))\s+on/gi)];
          const departure = timeMatches.length >= 1 ? timeMatches[0][1].trim() : "";
          const arrival = timeMatches.length >= 2 ? timeMatches[1][1].trim() : "";

          const durMatch = label.match(/Total duration\s+(.+?)\.?\s*(?:Select|$)/i);
          const duration = durMatch ? durMatch[1].trim().replace(/\..*/,"") : "";

          let stops = "";
          if (/nonstop/i.test(label)) stops = "Nonstop";
          else { const s = label.match(/(\d+)\s*stop/i); stops = s ? s[1] + " stop" : ""; }

          if (!departure) continue;
          const key = airline + departure;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({ airline, departure, arrival, duration, stops, priceNum });
        }
        return results;
      }, maxFlights);

      // FALLBACK: if primary found nothing, try per-field aria-label spans
      let finalFlights = flights;
      if (flights.length === 0) {
        log.warn("extractFlights: primary strategy found 0, trying fallback");
        finalFlights = await page.evaluate((max) => {
          const cards = document.querySelectorAll("li");
          const results = [];
          const seen = new Set();
          const knownAirlines = ["IndiGo","Air India Express","Air India","Akasa Air","SpiceJet","Vistara","GoFirst","Etihad","Emirates","Qatar Airways","Lufthansa","British Airways","Singapore Airlines","Alliance Air","AirAsia India","Flydubai","Oman Air"];
          for (const card of cards) {
            if (results.length >= max) break;
            const priceEl = card.querySelector('span[role="text"][aria-label*="rupees"]');
            if (!priceEl) continue;
            const priceNum = parseInt(priceEl.textContent.replace(/[^\d]/g,"")) || null;
            if (!priceNum) continue;
            const depEl = card.querySelector('[aria-label^="Departure time"]');
            const departure = depEl ? depEl.textContent.trim() : "";
            if (!departure) continue;
            const arrEl = card.querySelector('[aria-label^="Arrival time"]');
            const arrival = arrEl ? arrEl.textContent.trim() : "";
            const durEl = card.querySelector('[aria-label^="Total duration"]');
            const duration = durEl ? durEl.textContent.trim() : "";
            const stopsEl = card.querySelector('[aria-label*="Nonstop"]') || card.querySelector('[aria-label*="stop flight"]');
            const stops = stopsEl ? stopsEl.textContent.trim() : "";
            let airline = "";
            for (const sp of card.querySelectorAll("span")) {
              const t = sp.textContent.trim();
              if (knownAirlines.some(a => t === a)) { airline = t; break; }
            }
            const key = airline + departure;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({ airline, departure, arrival, duration, stops, priceNum });
          }
          return results;
        }, maxFlights);
      }

      // Format: one line per flight, compatible with comparePrices parser
      if (finalFlights.length > 0) {
        result = finalFlights.map((f, i) => {
          const price = "₹" + f.priceNum.toLocaleString("en-IN");
          return `[${i+1}] ${f.airline} ${f.departure} – ${f.arrival} ${f.duration} ${f.stops} ${price}`;
        }).join("\n");
      } else {
        result = "No flights found";
      }
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

    case "comparePrices": {
      // Parse a raw flight line into structured fields
      function parseFlight(raw, source) {
        // Extract price
        const priceMatch = raw.match(/₹\s?([\d,]+)/);
        if (!priceMatch) return null;
        const price = parseInt(priceMatch[1].replace(/,/g, ""));

        // Extract times (HH:MM AM/PM or HH:MM 24h)
        const timeMatch = raw.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*[\s|–-]+\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?(?:\+\d)?)/i);
        const departure = timeMatch ? timeMatch[1].trim() : "";
        const arrival = timeMatch ? timeMatch[2].trim() : "";

        // Extract airline
        const airlines = ["IndiGo", "Air India Express", "Air India", "Akasa Air", "SpiceJet", "Vistara", "GoFirst", "Etihad", "Emirates", "Qatar Airways", "Lufthansa", "British Airways", "Singapore Airlines"];
        let airline = "";
        for (const a of airlines) {
          if (raw.includes(a)) { airline = a; break; }
        }

        // Extract stops
        let stops = "Nonstop";
        if (/\bdirect\b/i.test(raw) || /\bNonstop\b/i.test(raw)) {
          stops = "Nonstop";
        } else {
          const stopMatch = raw.match(/(\d+)\s*stop/i);
          if (stopMatch) stops = stopMatch[1] + " stop";
        }

        // Extract duration — match "1h 20m", "1 hr 20 min", "4h 20m" etc
        // Use word boundary or capital letter after 'm' to avoid capturing airline names
        const durMatch = raw.match(/(\d+\s*h(?:r)?(?:\s*\d+\s*m(?:in)?)?)(?=[A-Z\s₹\d,.|]|$)/);
        const duration = durMatch ? durMatch[1].replace(/\s+/g, " ").trim() : "";

        return { price, departure, arrival, airline, stops, duration, source };
      }

      // Parse all flights from all sources
      const allFlights = [];
      for (const src of params.sources) {
        const raw = ctx[src.ctx_key] || "";
        const lines = raw.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          const parsed = parseFlight(line, src.name);
          if (parsed) allFlights.push(parsed);
        }
      }

      if (allFlights.length === 0) {
        result = "No flights with prices found.";
        break;
      }

      allFlights.sort((a, b) => a.price - b.price);

      // Format a single flight as a clean line
      function fmt(f, idx) {
        const parts = [`₹${f.price.toLocaleString("en-IN")}`];
        if (f.airline) parts.push(f.airline);
        if (f.departure && f.arrival) parts.push(`${f.departure} → ${f.arrival}`);
        if (f.duration) parts.push(f.duration);
        if (f.stops) parts.push(f.stops);
        parts.push(`(${f.source})`);
        return idx !== undefined ? `${idx}. ${parts.join("  |  ")}` : parts.join("  |  ");
      }

      const cheapest = allFlights[0];
      const output = [];
      output.push("CHEAPEST: " + fmt(cheapest));
      output.push("");

      // Deduplicate alternatives by airline+time
      const seen = new Set([`${cheapest.airline}${cheapest.departure}`]);
      const alts = allFlights.filter((f) => {
        const key = `${f.airline}${f.departure}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 4);

      if (alts.length > 0) {
        output.push("Other options:");
        alts.forEach((f, i) => output.push(fmt(f, i + 1)));
      }

      output.push("");
      const sourceSummary = params.sources.map((s) => {
        const best = allFlights.filter((f) => f.source === s.name)[0];
        return best ? `${s.name}: from ₹${best.price.toLocaleString("en-IN")}` : `${s.name}: no results`;
      });
      output.push(`Compared: ${sourceSummary.join("  vs  ")}`);

      result = output.join("\n");
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
    const stepId = step.id || `step_${stepNum}`;

    log.step(stepNum, `▶ ${step.action}${step.id ? ` [${step.id}]` : ""}`);

    try {
      // ── Per-step retry with backoff ──
      let result;
      let lastError;
      const maxAttempts = step.retry === false ? 1 : MAX_RETRIES;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const stepTimeout = step.timeout || 30000;
          let timeoutId;
          try {
            result = await Promise.race([
              execStep(browser.page, step, ctx, browser),
              new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`Step timed out after ${stepTimeout}ms`)), stepTimeout);
              }),
            ]);
          } finally {
            clearTimeout(timeoutId);
          }
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            log.warn(`Step ${stepNum} attempt ${attempt}/${maxAttempts} failed: ${err.message}. Retrying in ${RETRY_DELAYS[attempt - 1]}ms...`);
            const retryScreenshot = await takeScreenshot(browser);
            if (retryScreenshot) {
              steps.push({
                step_number: stepNum,
                step_id: `${stepId}_retry_${attempt}`,
                action: "retry_screenshot",
                params: {},
                result: `Retry ${attempt}: ${err.message}`,
                screenshot_base64: retryScreenshot,
                page_url: browser.page.url(),
                page_title: await browser.page.title().catch(() => ""),
                timestamp: new Date().toISOString(),
                source: "recipe",
              });
            }
            await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1]));
          }
        }
      }

      if (lastError) throw lastError;

      // ── Store result in context ──
      if (step.store_as) ctx[step.store_as] = String(result);

      // ── Validate result ──
      if (step.validate) {
        const validation = validateResult(result, step.validate);
        if (!validation.valid) {
          throw new Error(`Validation failed: ${validation.errors.join("; ")}`);
        }
      }

      // ── Success: screenshot + step data ──
      const screenshot = await takeScreenshot(browser);
      const stepData = {
        step_number: stepNum,
        step_id: stepId,
        thought: step.comment || null,
        action: step.action,
        params: interpolateDeep(step.params || {}, ctx),
        result: String(result).substring(0, 500),
        screenshot_base64: screenshot,
        page_url: browser.page.url(),
        page_title: await browser.page.title().catch(() => ""),
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
      // ── ALWAYS screenshot on failure ──
      const failScreenshot = await takeScreenshot(browser);

      if (step.optional) {
        log.warn(`Step ${stepNum} (optional) skipped: ${err.message}`);
        steps.push({
          step_number: stepNum,
          step_id: stepId,
          action: step.action,
          params: step.params || {},
          result: `Skipped: ${err.message}`,
          screenshot_base64: failScreenshot,
          page_url: browser.page.url(),
          page_title: await browser.page.title().catch(() => ""),
          timestamp: new Date().toISOString(),
          source: "recipe",
          failed: true,
          optional: true,
        });
        if (onStep) onStep(steps[steps.length - 1]);
        continue;
      }

      log.error(`Step ${stepNum} (${stepId}) FAILED: ${err.message}`);
      steps.push({
        step_number: stepNum,
        step_id: stepId,
        action: step.action,
        params: step.params || {},
        result: `FAILED: ${err.message}`,
        screenshot_base64: failScreenshot,
        page_url: browser.page.url(),
        page_title: await browser.page.title().catch(() => ""),
        timestamp: new Date().toISOString(),
        source: "recipe",
        failed: true,
      });
      if (onStep) onStep(steps[steps.length - 1]);

      updateRecipeStats(recipe.id, false, Date.now() - startTime).catch(() => {});
      return { success: false, failed_at_step: stepNum, result: err.message, steps, duration_ms: Date.now() - startTime };
    }
  }

  const durationMs = Date.now() - startTime;
  updateRecipeStats(recipe.id, true, durationMs).catch(() => {});
  return { success: true, result: "Recipe completed", steps, duration_ms: durationMs };
}

module.exports = { executeRecipe };
