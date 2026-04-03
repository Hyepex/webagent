/**
 * Phase 2 verification: Wikipedia REST API JSON structure
 * Tests 3 topics to confirm all JSON paths are correct.
 */

const { chromium } = require("playwright");

const TOPICS = ["India", "Python_(programming_language)", "Albert_Einstein"];

function buildUrl(topic) {
  return `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const summary = [];

  for (const topic of TOPICS) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Topic: "${topic}"`);
    console.log(`${"─".repeat(60)}`);

    try {
      const url = buildUrl(topic);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      const bodyText = await page.innerText("body", { timeout: 3000 });
      const json = JSON.parse(bodyText);

      // Verify all fields the recipe uses
      const title = json.title || "";
      const description = json.description || "";
      const extract = json.extract || "";

      console.log(`  title: "${title}"`);
      console.log(`  description: "${description.substring(0, 80)}"`);
      console.log(`  extract length: ${extract.length} chars`);

      const ok = title.length > 0 && extract.length >= 100;
      console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}`);
      summary.push({ topic, ok, titleLen: title.length, extractLen: extract.length });
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      summary.push({ topic, ok: false, error: err.message });
    }
  }

  await browser.close();

  console.log(`\n${"=".repeat(60)}`);
  console.log("WIKIPEDIA VERIFICATION SUMMARY");
  console.log(`${"=".repeat(60)}`);
  for (const s of summary) {
    console.log(`  ${s.ok ? "✅" : "❌"} ${s.topic} — extract=${s.extractLen ?? s.error} chars`);
  }

  const allGreen = summary.every(s => s.ok);
  console.log(`\nVERDICT: ${allGreen ? "✅ API STRUCTURE VERIFIED" : "❌ NEEDS REVIEW"}`);
  console.log(`JSON paths: title, description, extract`);
  process.exit(allGreen ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
