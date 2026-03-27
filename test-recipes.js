const fs = require("fs");
const path = require("path");
const config = require("./src/config");
const BrowserController = require("./src/browser/controller");
const { executeRecipe } = require("./src/recipes/executor");
const { mergeVariables } = require("./src/recipes/matcher");

async function runTests() {
  // Load recipes directly from JSON files (preserves test blocks that normalizeRecipe strips)
  const recipesDir = config.paths.recipes;
  const files = fs.readdirSync(recipesDir).filter((f) => f.endsWith(".json"));
  const recipes = files
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(recipesDir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.id && r.steps);

  const testable = recipes.filter((r) => r.test);

  if (testable.length === 0) {
    console.log("No recipes with test blocks found.");
    process.exit(0);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Recipe Test Runner — ${testable.length} recipes to test`);
  console.log(`${"=".repeat(60)}\n`);

  // Force headless for test runner
  config.browser.headless = true;

  const browser = new BrowserController();
  await browser.launch();

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const recipe of testable) {
    const testDef = recipe.test;
    const expect = testDef.expect || {};
    const recipeName = recipe.name || recipe.id;

    console.log(`\n--- Testing: ${recipeName} ---`);

    const vars = mergeVariables(testDef.variables || {}, {}, recipe);
    const startTime = Date.now();
    let result;
    let testPassed = true;
    const errors = [];

    try {
      await browser.createTaskContext();
      result = await executeRecipe(recipe, vars, browser, {});
      const duration = Date.now() - startTime;

      // Check expectations
      if (expect.success && !result.success) {
        errors.push(`Expected success but got failure at step ${result.failed_at_step}: ${result.result}`);
      }

      if (result.success && result.result) {
        const text = String(result.result);

        if (expect.result_min_length && text.length < expect.result_min_length) {
          errors.push(`Result too short: ${text.length} < ${expect.result_min_length}`);
        }

        if (expect.result_contains) {
          for (const pattern of expect.result_contains) {
            if (!new RegExp(pattern, "i").test(text)) {
              errors.push(`Result missing pattern: ${pattern}`);
            }
          }
        }

        if (expect.result_not_contains) {
          for (const pattern of expect.result_not_contains) {
            if (new RegExp(pattern, "i").test(text)) {
              errors.push(`Result contains blocked pattern: ${pattern}`);
            }
          }
        }

        if (expect.min_lines) {
          const lines = text.split("\n").filter((l) => l.trim()).length;
          if (lines < expect.min_lines) {
            errors.push(`Too few lines: ${lines} < ${expect.min_lines}`);
          }
        }
      }

      if (expect.max_duration_ms && duration > expect.max_duration_ms) {
        errors.push(`Too slow: ${duration}ms > ${expect.max_duration_ms}ms`);
      }
    } catch (err) {
      errors.push(`Exception: ${err.message}`);
    } finally {
      await browser.closeTaskContext().catch(() => {});

      // Restore test block that updateRecipeStats strips during normalization
      try {
        const filePath = path.join(recipesDir, `${recipe.id}.json`);
        const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!current.test && recipe.test) {
          current.test = recipe.test;
          fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
        }
      } catch { /* best-effort */ }
    }

    if (errors.length > 0) {
      testPassed = false;
      failed++;
      console.log(`  ❌ FAIL`);
      for (const err of errors) console.log(`     - ${err}`);
      if (result?.result) {
        console.log(`     Result preview: ${String(result.result).substring(0, 150)}...`);
      }
    } else {
      passed++;
      console.log(`  ✅ PASS (${Date.now() - startTime}ms)`);
      if (result?.result) {
        console.log(`     Preview: ${String(result.result).substring(0, 100)}...`);
      }
    }

    results.push({
      recipe: recipeName,
      passed: testPassed,
      errors,
      duration_ms: Date.now() - startTime,
    });
  }

  await browser.close();

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${testable.length} total`);
  console.log(`${"=".repeat(60)}\n`);

  // Save results to file
  const reportPath = path.join(config.paths.root, "test-results.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        summary: { passed, failed, total: testable.length },
        results,
      },
      null,
      2
    )
  );
  console.log(`Report saved to ${reportPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
