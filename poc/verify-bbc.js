/**
 * Phase 2 verification: BBC News headline selectors
 * Runs 3 times, logs what [data-testid='card-headline'] returns.
 * Also probes fallback selectors.
 */

const { chromium } = require("playwright");

const RUNS = 3;
const URL = "https://www.bbc.com/news";

async function extractHeadlines(page) {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    const results = {};

    // PRIMARY: data-testid='card-headline'
    const primary = document.querySelectorAll("[data-testid='card-headline']");
    results.primary = Array.from(primary).slice(0, 10).map(el => el.textContent.trim()).filter(Boolean);

    // FALLBACK A: main h2 elements
    const h2 = document.querySelectorAll("main h2");
    results.fallback_h2 = Array.from(h2).slice(0, 10).map(el => el.textContent.trim()).filter(Boolean);

    // FALLBACK B: role=heading inside article
    const articleHeadings = document.querySelectorAll("article [role='heading']");
    results.fallback_article_heading = Array.from(articleHeadings).slice(0, 10).map(el => el.textContent.trim()).filter(Boolean);

    return results;
  });
}

async function run() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  const page = await context.newPage();

  const runResults = [];

  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Run ${run}/${RUNS} — ${URL}`);
    console.log(`${"─".repeat(60)}`);

    try {
      const data = await extractHeadlines(page);

      console.log(`\n  PRIMARY [data-testid='card-headline']: ${data.primary.length} results`);
      data.primary.slice(0, 5).forEach((h, i) => console.log(`    [${i + 1}] ${h.substring(0, 80)}`));

      console.log(`\n  FALLBACK main h2: ${data.fallback_h2.length} results`);
      console.log(`  FALLBACK article[role=heading]: ${data.fallback_article_heading.length} results`);

      const ok = data.primary.length >= 3;
      const totalLen = data.primary.join("\n").length;
      console.log(`\n  primary count ≥ 3: ${ok ? "✅" : "❌"}`);
      console.log(`  total text length: ${totalLen} chars`);

      runResults.push({ ok, count: data.primary.length, totalLen });
    } catch (err) {
      console.log(`  Run ${run} ERROR: ${err.message}`);
      runResults.push({ ok: false, error: err.message });
    }

    if (run < RUNS) await page.waitForTimeout(2000);
  }

  await browser.close();

  console.log(`\n${"=".repeat(60)}`);
  console.log("BBC VERIFICATION SUMMARY");
  console.log(`${"=".repeat(60)}`);
  const passCount = runResults.filter(r => r.ok).length;
  console.log(`  ${passCount}/${RUNS} runs passed`);
  for (const r of runResults) {
    console.log(`  ${r.ok ? "✅" : "❌"} count=${r.count ?? "err"} length=${r.totalLen ?? r.error}`);
  }

  const allGreen = runResults.every(r => r.ok);
  console.log(`\nVERDICT: ${allGreen ? "✅ SELECTOR VERIFIED" : "❌ SELECTOR NEEDS REVIEW"}`);
  console.log(`Primary selector: [data-testid='card-headline']`);
  process.exit(allGreen ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
