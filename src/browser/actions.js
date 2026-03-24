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
  const clicked = await page.evaluate((searchText) => {
    const els = [...document.querySelectorAll("a, button, [role=button], input[type=submit]")];
    const match = els.find((e) => {
      const t = e.textContent?.trim().toLowerCase() || "";
      const aria = (e.getAttribute("aria-label") || "").toLowerCase();
      return t.includes(searchText.toLowerCase()) || aria.includes(searchText.toLowerCase());
    });
    if (match) { match.click(); return match.textContent?.trim().substring(0, 60) || true; }
    return null;
  }, text);
  if (!clicked) throw new Error(`No element found with text: "${text}"`);
  await settle();
  return clicked;
}

async function goBack(page, settle) {
  await page.goBack({ waitUntil: "domcontentloaded" });
  await settle();
}

module.exports = { goto, clickBySelector, clickByIndex, typeText, getText, scroll, pressEnter, clickByText, goBack };
