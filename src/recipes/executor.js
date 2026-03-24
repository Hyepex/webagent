const config = require("../config");
const actions = require("../browser/actions");
const { updateRecipeStats } = require("./store");
const { createLogger } = require("../utils/logger");

const log = createLogger("recipe-exec");

function interpolate(str, variables) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || `{{${key}}}`);
}

function interpolateParams(params, variables) {
  const result = {};
  for (const [key, value] of Object.entries(params)) {
    result[key] = interpolate(value, variables);
  }
  return result;
}

async function takeScreenshot(browser) {
  try {
    return await browser.page.screenshot({ encoding: "base64" });
  } catch {
    return null;
  }
}

async function executeRecipe(recipe, variables, browser, callbacks = {}) {
  const { onStep, isCancelled } = callbacks;
  const startTime = Date.now();
  const steps = [];
  let prevUrl = browser.page.url();

  log.info(`Replaying recipe: ${recipe.name} (${recipe.steps.length} steps)`);

  for (let i = 0; i < recipe.steps.length; i++) {
    if (isCancelled && isCancelled()) {
      log.warn("Recipe cancelled");
      updateRecipeStats(recipe.id, false, Date.now() - startTime).catch(() => {});
      return { success: false, failed_at_step: i + 1, result: "Cancelled", steps };
    }

    const step = recipe.steps[i];
    const params = interpolateParams(step.params || {}, variables);
    const stepNum = i + 1;

    log.step(stepNum, `▶ ${step.action}(${JSON.stringify(params)})`);

    try {
      let result;
      switch (step.action) {
        case "goto":
          prevUrl = browser.page.url();
          result = await browser.goto(params.url);
          // Verify navigation happened
          if (browser.page.url() === prevUrl && prevUrl !== "about:blank") {
            log.warn(`Step ${stepNum}: page URL didn't change after goto`);
          }
          break;

        case "clickElement":
          // Try by number first, fall back to text search
          result = await browser.clickElement(params.number);
          if (typeof result === "string" && (result.startsWith("Invalid element") || result.startsWith("Failed to click"))) {
            // Fallback: try clicking by text if we have context
            if (params.text || params.label) {
              log.warn(`clickElement(${params.number}) failed, trying by text: "${params.text || params.label}"`);
              try {
                await actions.clickByText(browser.page, params.text || params.label, () => browser._settle());
                result = await browser.getPageInfo();
              } catch {
                // Both methods failed
              }
            }
          }
          break;

        case "clickByText":
          try {
            await actions.clickByText(browser.page, params.text, () => browser._settle());
            result = await browser.getPageInfo();
          } catch (err) {
            log.warn(`clickByText("${params.text}") failed: ${err.message}`);
            result = `Could not find element with text: "${params.text}"`;
          }
          break;

        case "pressEnter":
          await actions.pressEnter(browser.page, () => browser._settle());
          result = await browser.getPageInfo();
          // Verify the page changed after pressing enter
          {
            const newUrl = browser.page.url();
            if (newUrl !== prevUrl) {
              log.info(`pressEnter navigated to: ${newUrl}`);
            }
            prevUrl = newUrl;
          }
          break;

        case "type":
          result = await browser.type(params.selector, params.text);
          break;

        case "getText":
          result = await browser.getText();
          break;

        case "scroll":
          result = await browser.scroll(params.direction);
          break;

        case "back":
          result = await browser.back();
          break;

        case "waitFor": {
          const ms = Math.min(Number(params.seconds) || 1, 10) * 1000;
          await new Promise((r) => setTimeout(r, ms));
          result = `Waited ${ms / 1000} seconds`;
          break;
        }

        case "done":
          result = interpolate(params.result || "Done", variables);
          break;

        default:
          result = `Unknown action: ${step.action}`;
      }

      const screenshot = await takeScreenshot(browser);
      const stepData = {
        step_number: stepNum,
        thought: null,
        action: step.action,
        params,
        result: String(result).substring(0, 300),
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

      // Check if a step clearly failed
      if (typeof result === "string" &&
          (result.startsWith("Could not find") || result.startsWith("Invalid element") || result.startsWith("Failed to click"))) {
        log.error(`Step ${stepNum} failed: ${result}`);
        updateRecipeStats(recipe.id, false, Date.now() - startTime).catch(() => {});
        return { success: false, failed_at_step: stepNum, result, steps };
      }
    } catch (err) {
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
