/**
 * Phase 2 verification: Amazon India price search selectors
 * Tests with 3 different products using fresh BrowserContext per run
 * (matching how the recipe executor works — anti-bot avoidance).
 */

const path = require("path");
const config = require("../src/config");
const BrowserController = require("../src/browser/controller");
const { executeRecipe } = require("../src/recipes/executor");

// Load recipe directly
const recipe = JSON.parse(require("fs").readFileSync(
  path.join(config.paths.recipes, "amazon_in_price_search.json"), "utf8"
));

const PRODUCTS = ["iPhone 15", "Samsung Galaxy S24", "Sony WH-1000XM5"];

async function run() {
  config.browser.headless = true;

  const browser = new BrowserController();
  await browser.launch();

  const summary = [];

  for (const product of PRODUCTS) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Product: "${product}"`);
    console.log(`${"─".repeat(60)}`);

    await browser.createTaskContext();
    try {
      const result = await executeRecipe(recipe, { product }, browser, {});
      const text = result.result || "";
      const ok = result.success && text.includes("₹") && text.length >= 30;

      console.log(`  success: ${result.success}`);
      console.log(`  result length: ${text.length}`);
      console.log(`  preview: ${text.substring(0, 200)}`);
      console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}`);

      // Inspect titles in result — check for brand-only lines
      const lines = text.split("\n").filter(l => l.trim());
      const brandOnlyLines = lines.filter(l => {
        // A title is "brand-only" if the title field is very short (≤ 10 chars)
        const m = l.match(/title:\s*([^|]+)/);
        return m && m[1].trim().length <= 10;
      });
      if (brandOnlyLines.length > 0) {
        console.log(`  [NOTE] ${brandOnlyLines.length} brand-only title(s) — h2 a span selector may improve this`);
      }

      summary.push({ product, ok, len: text.length });
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      summary.push({ product, ok: false, error: err.message });
    } finally {
      await browser.closeTaskContext().catch(() => {});
    }
  }

  await browser.close();

  console.log(`\n${"=".repeat(60)}`);
  console.log("AMAZON VERIFICATION SUMMARY (fresh context per product)");
  console.log(`${"=".repeat(60)}`);
  for (const s of summary) {
    console.log(`  ${s.ok ? "✅" : "❌"} ${s.product} — ${s.ok ? `${s.len} chars` : s.error}`);
  }

  const allGreen = summary.every(s => s.ok);
  console.log(`\nVERDICT: ${allGreen ? "✅ SELECTORS VERIFIED" : "❌ SELECTORS NEED REVIEW"}`);
  console.log(`Scope: [data-component-type='s-search-result']`);
  console.log(`Title: h2 a span (improved from h2 span — avoids brand badges)`);
  console.log(`Price: .a-price .a-offscreen`);
  process.exit(allGreen ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
