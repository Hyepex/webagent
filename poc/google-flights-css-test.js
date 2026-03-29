/**
 * Standalone POC: CSS Selector Extraction on Google Flights
 *
 * Tests every selector strategy against a live Google Flights page,
 * logs which work, extracts flight data, and verifies consistency
 * across 3 consecutive runs.
 *
 * Usage: node poc/google-flights-css-test.js
 */

const { chromium } = require("playwright");
const path = require("path");

// ─── Reuse the existing URL builder ─────────────────────────────────────────
const { buildUrl } = require(path.resolve(
  __dirname,
  "../src/url-builders/google-flights.js"
));

// ─── Config ─────────────────────────────────────────────────────────────────
const ROUTE = {
  origin: "Mumbai",
  destination: "Goa",
  date: "2026-06-01",
  tripType: "one-way",
};
const TOTAL_RUNS = 3;

// ─── Selector strategies to test (card-level) ──────────────────────────────
const CARD_SELECTORS = [
  { name: "role-link-aria",       css: 'div[role="link"][aria-label*="flight with"]' },
  { name: "role-listitem",        css: '[role="listitem"]' },
  { name: "aria-flight",          css: '[aria-label*="flight"]' },
  { name: "aria-nonstop",         css: '[aria-label*="Nonstop"]' },
  { name: "aria-stop-flight",     css: '[aria-label*="stop flight"]' },
  { name: "aria-rupees",          css: '[aria-label*="rupees"]' },
  { name: "data-ved-div",         css: "div[data-ved]" },
  { name: "data-ved-li",          css: "li[data-ved]" },
  { name: "ul-gt-li",             css: "ul > li" },
  { name: "li-pIav2d",            css: "li.pIav2d" },
];

// ─── Field sub-selectors to try inside each card (fallback strategy) ────────
const FIELD_SELECTORS = {
  price: [
    { name: 'span[role="text"][aria-label*="rupees"]', css: 'span[role="text"][aria-label*="rupees"]' },
    { name: '[aria-label*="rupees"]',                  css: '[aria-label*="rupees"]' },
    { name: 'span[data-gs]',                           css: "span[data-gs]" },
  ],
  departure: [
    { name: '[aria-label^="Departure time"]', css: '[aria-label^="Departure time"]' },
    { name: '[aria-label*="Departure"]',      css: '[aria-label*="Departure"]' },
  ],
  arrival: [
    { name: '[aria-label^="Arrival time"]', css: '[aria-label^="Arrival time"]' },
    { name: '[aria-label*="Arrival"]',      css: '[aria-label*="Arrival"]' },
  ],
  duration: [
    { name: '[aria-label^="Total duration"]', css: '[aria-label^="Total duration"]' },
    { name: '[aria-label*="duration"]',       css: '[aria-label*="duration"]' },
  ],
  stops: [
    { name: '[aria-label*="Nonstop"]',     css: '[aria-label*="Nonstop"]' },
    { name: '[aria-label*="stop"]',        css: '[aria-label*="stop"]' },
    { name: '[aria-label*="stop flight"]', css: '[aria-label*="stop flight"]' },
  ],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function separator(title) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(70));
}

/**
 * Parse flight data from a div[role="link"] aria-label string.
 * Returns { airline, departure, arrival, duration, stops, price } or null.
 */
function parseAriaLabel(label) {
  if (!label) return null;

  // Price — Google marks some flights as "Total price is unavailable"
  const priceMatch = label.match(/(\d[\d,]*)\s*Indian rupees/i);
  let price;
  if (priceMatch) {
    price = `\u20B9${priceMatch[1]}`;
  } else if (/price is unavailable/i.test(label)) {
    price = "Unavailable";
  } else {
    price = null;
  }

  // Stops
  let stops = null;
  if (/nonstop/i.test(label)) stops = "Nonstop";
  else {
    const stopMatch = label.match(/(\d+)\s*stop/i);
    if (stopMatch) stops = `${stopMatch[1]} stop${stopMatch[1] !== "1" ? "s" : ""}`;
  }

  // Airline
  const airlineMatch = label.match(/flight with\s+(.+?)\.\s/i);
  const airline = airlineMatch ? airlineMatch[1] : null;

  // Times: "at HH:MM AM/PM on ..."
  const timeRe = /at\s+(\d{1,2}:\d{2}\s*(?:AM|PM))\s+on/gi;
  const times = [];
  let m;
  while ((m = timeRe.exec(label)) !== null) times.push(m[1]);
  const departure = times[0] || null;
  const arrival = times[1] || null;

  // Duration
  const durMatch = label.match(/Total duration\s+(.+?)\.?\s*(?:Select|$)/i);
  const duration = durMatch ? durMatch[1].trim() : null;

  if (!price && !airline) return null;
  return { airline, departure, arrival, duration, stops, price };
}

// ─── Single run ─────────────────────────────────────────────────────────────

async function singleRun(runNumber) {
  separator(`RUN ${runNumber} / ${TOTAL_RUNS}`);

  const url = buildUrl(ROUTE);
  log(`URL: ${url.slice(0, 100)}...`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();

  try {
    // ── Navigate ──────────────────────────────────────────────────────────
    log("Navigating to Google Flights...");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for flight results to load — look for price indicators
    log("Waiting for flight results to render...");
    try {
      await page.waitForSelector('[aria-label*="rupees"]', { timeout: 20000 });
      log("Price elements detected — results loaded.");
    } catch {
      log("WARN: No price elements found after 20s — trying longer wait...");
      await page.waitForTimeout(10000);
    }

    // Extra settle time for lazy-rendered content
    await page.waitForTimeout(2000);

    // ── Phase 1: Test all card selectors ────────────────────────────────
    separator(`RUN ${runNumber} — PHASE 1: Card Selector Survey`);

    const selectorResults = [];
    for (const sel of CARD_SELECTORS) {
      const count = await page.locator(sel.css).count();
      const status = count > 0 ? "OK" : "--";
      console.log(`  [${status}] ${sel.name.padEnd(22)} ${sel.css.padEnd(55)} → ${count} elements`);
      selectorResults.push({ ...sel, count });
    }

    // ── Phase 2: Primary strategy — aria-label parsing ──────────────────
    separator(`RUN ${runNumber} — PHASE 2: Primary Extraction (aria-label parsing)`);

    const primarySelector = 'div[role="link"][aria-label*="flight with"]';
    const cardElements = page.locator(primarySelector);
    const cardCount = await cardElements.count();
    log(`Primary selector found ${cardCount} cards`);

    if (cardCount > 0) {
      // Print first card's outerHTML (truncated)
      const firstHtml = await cardElements.first().evaluate((el) =>
        el.outerHTML.slice(0, 1000)
      );
      console.log(`\n  First card outerHTML (first 1000 chars):\n  ${firstHtml}\n`);
    }

    const flights = [];
    for (let i = 0; i < cardCount; i++) {
      const label = await cardElements.nth(i).getAttribute("aria-label");
      const parsed = parseAriaLabel(label);
      if (parsed) flights.push(parsed);
    }

    // Dedup by airline + departure
    const seen = new Set();
    const uniqueFlights = flights.filter((f) => {
      const key = `${f.airline}|${f.departure}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    log(`Parsed ${flights.length} cards → ${uniqueFlights.length} unique flights`);

    // ── Phase 3: Fallback sub-selector survey (inside first li card) ────
    separator(`RUN ${runNumber} — PHASE 3: Fallback Sub-Selector Survey`);

    // Find li cards that contain price info
    const liCards = page.locator('li:has([aria-label*="rupees"])');
    const liCount = await liCards.count();
    log(`li cards with price: ${liCount}`);

    if (liCount > 0) {
      const firstLi = liCards.first();
      for (const [field, selectors] of Object.entries(FIELD_SELECTORS)) {
        for (const sel of selectors) {
          const count = await firstLi.locator(sel.css).count();
          let text = "";
          if (count > 0) {
            text = await firstLi.locator(sel.css).first().innerText().catch(() => "");
          }
          const status = count > 0 ? "OK" : "--";
          console.log(
            `  [${status}] ${field.padEnd(12)} ${sel.name.padEnd(45)} → ${count} el  text="${text}"`
          );
        }
      }
    }

    // ── Phase 4: Formatted output ───────────────────────────────────────
    separator(`RUN ${runNumber} — EXTRACTED FLIGHTS`);

    if (uniqueFlights.length === 0) {
      log("ERROR: No flights extracted!");
    } else {
      for (const f of uniqueFlights) {
        const line = [
          (f.airline || "?").padEnd(25),
          `${f.departure || "?"} → ${f.arrival || "?"}`.padEnd(22),
          (f.duration || "?").padEnd(14),
          (f.stops || "?").padEnd(10),
          f.price || "?",
        ].join(" | ");
        console.log(`  ${line}`);
      }
    }

    log(`Run ${runNumber} complete: ${uniqueFlights.length} flights extracted`);
    return uniqueFlights;
  } finally {
    await browser.close();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  separator("GOOGLE FLIGHTS CSS SELECTOR POC");
  log(`Route: ${ROUTE.origin} → ${ROUTE.destination}`);
  log(`Date: ${ROUTE.date} | Trip: ${ROUTE.tripType}`);

  const allRuns = [];
  for (let i = 1; i <= TOTAL_RUNS; i++) {
    const flights = await singleRun(i);
    allRuns.push(flights);
  }

  // ── Consistency check ─────────────────────────────────────────────────
  separator("CONSISTENCY CHECK");

  const counts = allRuns.map((r) => r.length);
  log(`Flight counts across runs: ${counts.join(", ")}`);

  const allNonZero = counts.every((c) => c > 0);
  log(`All runs returned flights: ${allNonZero ? "YES" : "NO — FAILURE"}`);

  // Check that the same airlines appear across runs
  const airlineSets = allRuns.map((r) =>
    new Set(r.map((f) => f.airline).filter(Boolean))
  );
  const commonAirlines = [...airlineSets[0]].filter((a) =>
    airlineSets.every((s) => s.has(a))
  );
  log(`Common airlines across all runs: ${commonAirlines.join(", ") || "NONE"}`);

  // Check all fields populated
  let allFieldsOk = true;
  for (let i = 0; i < allRuns.length; i++) {
    for (const f of allRuns[i]) {
      const missing = Object.entries(f)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (missing.length > 0) {
        log(`WARN: Run ${i + 1} flight "${f.airline}" missing: ${missing.join(", ")}`);
        allFieldsOk = false;
      }
    }
  }
  log(`All fields populated: ${allFieldsOk ? "YES" : "NO — some missing"}`);

  separator("RESULT");
  if (allNonZero && allFieldsOk) {
    log("PASS — All 3 runs extracted flights with all fields populated.");
  } else {
    log("FAIL — See warnings above.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
