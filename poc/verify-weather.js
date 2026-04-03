/**
 * Phase 2 verification: wttr.in JSON API structure
 * Tests 3 cities to confirm all JSON paths the recipe uses are correct.
 */

const { chromium } = require("playwright");

const CITIES = ["Mumbai", "Delhi", "Bangalore"];

function buildUrl(city) {
  return `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
}

const PATHS = [
  { path: "nearest_area.0.areaName.0.value", label: "Location" },
  { path: "current_condition.0.weatherDesc.0.value", label: "Condition" },
  { path: "current_condition.0.temp_C", label: "Temperature (C)" },
  { path: "current_condition.0.FeelsLikeC", label: "Feels Like (C)" },
  { path: "current_condition.0.humidity", label: "Humidity (%)" },
  { path: "current_condition.0.windspeedKmph", label: "Wind Speed (kmph)" },
  { path: "current_condition.0.winddir16Point", label: "Wind Direction" },
  { path: "weather.0.maxtempC", label: "Today High (C)" },
  { path: "weather.0.mintempC", label: "Today Low (C)" },
  { path: "weather.0.astronomy.0.sunrise", label: "Sunrise" },
  { path: "weather.0.astronomy.0.sunset", label: "Sunset" },
];

function resolvePath(obj, dotPath) {
  return dotPath.split(".").reduce((o, key) => {
    if (o == null) return undefined;
    if (/^\d+$/.test(key)) return o[parseInt(key)];
    return o[key];
  }, obj);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const summary = [];

  for (const city of CITIES) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`City: "${city}"`);
    console.log(`${"─".repeat(60)}`);

    try {
      const url = buildUrl(city);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      const bodyText = await page.innerText("body", { timeout: 3000 });
      const json = JSON.parse(bodyText);

      const fields = {};
      let missingPaths = [];

      for (const f of PATHS) {
        const val = resolvePath(json, f.path);
        fields[f.label] = val;
        if (val === undefined) missingPaths.push(f.path);
        console.log(`  ${f.label}: ${val !== undefined ? val : "❌ MISSING"}`);
      }

      const ok = missingPaths.length === 0;
      console.log(`\n  ${ok ? "✅ ALL PATHS PRESENT" : "❌ MISSING: " + missingPaths.join(", ")}`);
      summary.push({ city, ok, missingPaths });
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      summary.push({ city, ok: false, error: err.message });
    }
  }

  await browser.close();

  console.log(`\n${"=".repeat(60)}`);
  console.log("WEATHER VERIFICATION SUMMARY");
  console.log(`${"=".repeat(60)}`);
  for (const s of summary) {
    const detail = s.ok ? "all paths present" : (s.error || `missing: ${s.missingPaths.join(", ")}`);
    console.log(`  ${s.ok ? "✅" : "❌"} ${s.city} — ${detail}`);
  }

  const allGreen = summary.every(s => s.ok);
  console.log(`\nVERDICT: ${allGreen ? "✅ API STRUCTURE VERIFIED" : "❌ NEEDS REVIEW"}`);
  process.exit(allGreen ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
