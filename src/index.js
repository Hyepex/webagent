const readline = require("readline");
const config = require("./config");
const BrowserController = require("./browser/controller");
const { matchRecipe, mergeVariables } = require("./recipes/matcher");
const { executeRecipe } = require("./recipes/executor");
const { createLogger } = require("./utils/logger");

const log = createLogger("main");

async function main() {
  console.log("\n+======================================================+");
  console.log("|     WebAgent — Recipe-Only Browser Automation         |");
  console.log("+======================================================+\n");

  log.info(`Mode: recipe-only`);
  log.info(`Browser: headless=${config.browser.headless}, max steps=${config.agent.maxSteps}`);

  const browser = new BrowserController();
  await browser.launch();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  while (true) {
    const task = await ask("\nWhat would you like me to do? (type 'quit' to exit)\n> ");

    if (!task || task.trim().toLowerCase() === "quit") {
      log.info("Shutting down...");
      await browser.close();
      rl.close();
      process.exit(0);
    }

    try {
      const match = await matchRecipe(task.trim());

      if (!match) {
        log.warn("No recipe found for this task. Please add a recipe or use a different instruction.");
        continue;
      }

      const vars = mergeVariables(match.variables, {}, match.recipe);
      log.info(`Matched recipe: "${match.recipe.name}" — variables: ${JSON.stringify(vars)}`);

      await browser.createTaskContext();
      const result = await executeRecipe(match.recipe, vars, browser, {});
      await browser.closeTaskContext().catch(() => {});

      if (result.success) {
        log.success(`Result:\n${result.result}`);
      } else {
        log.error(`Recipe failed at step ${result.failed_at_step}: ${result.result}`);
      }
    } catch (err) {
      log.error(`Task failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
