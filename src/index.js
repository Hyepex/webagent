const readline = require("readline");
const config = require("./config");
const BrowserController = require("./browser/controller");
const { runTask } = require("./agent/executor");
const { createLogger } = require("./utils/logger");

const log = createLogger("main");

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║          🌐  WebAgent — AI Browser Agent            ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  log.info(`LLM: ${config.llm.primaryModel} (fallback: ${config.llm.fallbackModel})`);
  log.info(`Browser: headless=${config.browser.headless}, max steps=${config.agent.maxSteps}`);

  const browser = new BrowserController();
  await browser.launch();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  while (true) {
    const task = await ask("\n🔍 What would you like me to do? (type 'quit' to exit)\n> ");

    if (!task || task.trim().toLowerCase() === "quit") {
      log.info("Shutting down...");
      await browser.close();
      rl.close();
      process.exit(0);
    }

    try {
      await runTask(browser, task.trim());
    } catch (err) {
      log.error(`Task failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
