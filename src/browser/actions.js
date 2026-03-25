const config = require("../config");
const { isUrlAllowed, sanitizePageContent } = require("./security");
const { createLogger } = require("../utils/logger");

const log = createLogger("actions");

async function goto(page, url, settle) {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  // Security check before navigating
  const check = isUrlAllowed(url);
  if (!check.allowed) {
    const domain = new URL(url).hostname;
    log.security(`Blocked navigation to ${domain}: ${check.reason}`);
    throw new Error(`Cannot visit ${domain} - blocked for security`);
  }

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.browser.timeout });
  await settle();
}

async function clickBySelector(page, selector, settle) {
  await page.waitForSelector(selector, { timeout: 5000 });
  await page.click(selector);
  await settle();
}

async function clickByIndex(page, rawIndex, settle) {
  await page.evaluate((i) => {
    const all = document.querySelectorAll("a[href], button, [role=button], input[type=submit], input[type=button]");
    const visible = [...all].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top < window.innerHeight;
    });
    if (visible[i]) visible[i].click();
  }, rawIndex);
  await settle();
}

async function typeText(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 5000 });
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, text, { delay: 30 });
}

async function getText(page) {
  const text = await page.evaluate(
    (max) => document.body.innerText.substring(0, max),
    config.agent.maxGetText
  );
  return sanitizePageContent(text || "(empty page)");
}

async function scroll(page, direction) {
  await page.evaluate((dir) => {
    window.scrollBy(0, dir === "up" ? -600 : 600);
  }, direction || "down");
  await new Promise((r) => setTimeout(r, 500));
}

async function pressEnter(page, settle) {
  await page.keyboard.press("Enter");
  await settle();
}

async function clickByText(page, text, settle) {
  const locator = page.getByText(text, { exact: false }).first();
  await locator.click({ timeout: 5000 });
  await settle();
}

async function goBack(page, settle) {
  await page.goBack({ waitUntil: "domcontentloaded" });
  await settle();
}

// ─── New Playwright-Native Actions ───────────────────────────────────────────

async function fillByLabel(page, label, text, settle) {
  // Try strategies in order of reliability
  const strategies = [
    () => page.getByLabel(label, { exact: false }),
    () => page.getByPlaceholder(label, { exact: false }),
    () => page.getByRole("textbox", { name: label }),
    () => page.getByRole("combobox", { name: label }),
    () => page.getByRole("searchbox", { name: label }),
  ];

  for (const getLocator of strategies) {
    const locator = getLocator();
    if (await locator.count() > 0) {
      await locator.first().click();
      await locator.first().fill(text);
      await settle();
      return;
    }
  }

  throw new Error(`No input found matching label: "${label}"`);
}

async function clickByRole(page, role, name, settle) {
  const locator = page.getByRole(role, { name, exact: false });
  await locator.first().click({ timeout: 5000 });
  await settle();
}

async function selectOption(page, label, value, settle) {
  const locator = page.getByLabel(label, { exact: false });
  await locator.first().selectOption({ label: value });
  await settle();
}

async function pickOption(page, text, settle) {
  // Wait briefly for dropdown to appear
  await new Promise((r) => setTimeout(r, 500));

  // Strategy 1: ARIA role-based (most reliable for autocomplete)
  const roleOption = page.locator(`[role="option"]`).filter({ hasText: text }).first();
  if (await roleOption.isVisible({ timeout: 2000 }).catch(() => false)) {
    await roleOption.click();
    await settle();
    return;
  }

  // Strategy 2: Listbox children
  const listItem = page.locator(`[role="listbox"] li, [role="listbox"] [role="option"], ul.suggestions li, .autocomplete-suggestion`).filter({ hasText: text }).first();
  if (await listItem.isVisible({ timeout: 1000 }).catch(() => false)) {
    await listItem.click();
    await settle();
    return;
  }

  // Strategy 3: Any visible element with matching text
  const textMatch = page.getByText(text, { exact: false }).first();
  await textMatch.click({ timeout: 3000 });
  await settle();
}

async function waitForText(page, text, timeout = 5000) {
  await page.getByText(text, { exact: false }).first().waitFor({
    state: "visible",
    timeout,
  });
}

module.exports = {
  goto, clickBySelector, clickByIndex, typeText, getText, scroll,
  pressEnter, clickByText, goBack,
  fillByLabel, clickByRole, selectOption, pickOption, waitForText,
};
