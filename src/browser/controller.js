const { chromium } = require("playwright");
const config = require("../config");
const actions = require("./actions");
const parser = require("./parser");
const { sanitizePageContent } = require("./security");
const { createLogger } = require("../utils/logger");

const log = createLogger("browser");

const TASK_CONTEXT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

class BrowserController {
  constructor() {
    this.browser = null;
    this._defaultContext = null;
    this.page = null;
    this.elements = [];
    this._taskContext = null;
    this._contextTimer = null;
  }

  _contextOptions() {
    return {
      viewport: { width: config.browser.viewportWidth, height: config.browser.viewportHeight },
      userAgent: config.browser.userAgent,
    };
  }

  async launch() {
    const launchOptions = {
      headless: config.browser.headless,
      args: config.browser.launchArgs,
    };

    if (config.browser.executablePath) {
      launchOptions.executablePath = config.browser.executablePath;
    }

    this.browser = await chromium.launch(launchOptions);
    this._defaultContext = await this.browser.newContext(this._contextOptions());
    await this._applyStealthScripts(this._defaultContext);

    this.page = await this._defaultContext.newPage();
    this.page.setDefaultTimeout(config.browser.defaultTimeout);

    log.success(`Launched Chromium (headless=${config.browser.headless}, stealth mode)`);
  }

  async _applyStealthScripts(context) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
  }

  // Create an isolated browser context for a task
  async createTaskContext() {
    try {
      if (!this.browser) {
        throw new Error("Browser not launched");
      }

      this._taskContext = await this.browser.newContext(this._contextOptions());
      await this._applyStealthScripts(this._taskContext);
      this.page = await this._taskContext.newPage();
      this.page.setDefaultTimeout(config.browser.defaultTimeout);

      // Set hard timeout — auto-close context after 5 minutes
      this._contextTimer = setTimeout(() => {
        log.warn("Task context timed out (5 min limit), force-closing");
        this.closeTaskContext().catch(() => {});
      }, TASK_CONTEXT_TIMEOUT);

      log.debug("Created isolated task context");
    } catch (err) {
      log.error(`Failed to create task context: ${err.message}`);
      // Fallback to default page
      if (this._defaultContext) {
        const pages = this._defaultContext.pages();
        this.page = pages[0] || await this._defaultContext.newPage();
        this.page.setDefaultTimeout(config.browser.defaultTimeout);
      }
    }
  }

  // Close the task's isolated context and all its pages
  async closeTaskContext() {
    if (this._contextTimer) {
      clearTimeout(this._contextTimer);
      this._contextTimer = null;
    }

    if (this._taskContext) {
      try {
        await this._taskContext.close();
        log.debug("Closed isolated task context");
      } catch (err) {
        log.warn(`Error closing task context: ${err.message}`);
      }
      this._taskContext = null;
    }

    // Reset to a default page from the default context
    try {
      if (this._defaultContext) {
        const pages = this._defaultContext.pages();
        this.page = pages[0] || await this._defaultContext.newPage();
      }
    } catch {
      this.page = null;
    }

    this.elements = [];
  }

  async goto(url) {
    await actions.goto(this.page, url, () => this._settle());
    return await this.getPageInfo();
  }

  async clickElement(number) {
    const idx = Number(number) - 1;
    const el = this.elements[idx];
    if (!el) return `Invalid element number: ${number}. Use a number from the list.`;

    try {
      if (el.selector) {
        await actions.clickBySelector(this.page, el.selector, () => this._settle());
      } else {
        await actions.clickByIndex(this.page, el._rawIndex, () => this._settle());
      }
      return await this.getPageInfo();
    } catch {
      return `Failed to click element ${number}: "${el.label}"`;
    }
  }

  async type(selector, text) {
    try {
      await actions.typeText(this.page, selector, text);
      return `Typed "${text}" into ${selector}`;
    } catch {
      return `Could not find input: ${selector}`;
    }
  }

  async getText() {
    const text = await actions.getText(this.page);
    return sanitizePageContent(text);
  }

  async scroll(direction) {
    await actions.scroll(this.page, direction);
    return await this.getPageInfo();
  }

  async pressEnter() {
    await actions.pressEnter(this.page, () => this._settle());
    return await this.getPageInfo();
  }

  async clickByText(text) {
    try {
      await actions.clickByText(this.page, text, () => this._settle());
      return await this.getPageInfo();
    } catch {
      return `Could not find element with text: "${text}"`;
    }
  }

  async fill(label, text) {
    try {
      await actions.fillByLabel(this.page, label, text, () => this._settle());
      return await this.getPageInfo();
    } catch {
      return `Could not find input labeled "${label}"`;
    }
  }

  async clickByRole(role, name) {
    try {
      await actions.clickByRole(this.page, role, name, () => this._settle());
      return await this.getPageInfo();
    } catch {
      return `Could not find ${role} named "${name}"`;
    }
  }

  async selectOption(label, value) {
    try {
      await actions.selectOption(this.page, label, value, () => this._settle());
      return await this.getPageInfo();
    } catch {
      return `Could not select "${value}" in "${label}"`;
    }
  }

  async pickOption(text) {
    try {
      await actions.pickOption(this.page, text, () => this._settle());
      return await this.getPageInfo();
    } catch {
      return `Could not find option: "${text}"`;
    }
  }

  async waitForText(text) {
    try {
      await actions.waitForText(this.page, text);
      return `Found text: "${text}"`;
    } catch {
      return `Text "${text}" did not appear`;
    }
  }

  async back() {
    await actions.goBack(this.page, () => this._settle());
    return await this.getPageInfo();
  }

  async getPageInfo() {
    const title = await this.page.title();
    const url = this.page.url();
    const rawElements = await parser.extractElements(this.page);
    const visibleText = await parser.extractVisibleText(this.page, config.agent.maxVisibleText);

    this.elements = rawElements.map((el) => ({ ...el, _rawIndex: el.rawIndex }));

    // Sanitize visible text before returning to LLM
    const sanitizedText = sanitizePageContent(visibleText);

    return parser.formatPageInfo(title, url, this.elements, sanitizedText);
  }

  async _settle() {
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await new Promise((r) => setTimeout(r, config.agent.settleDelay));
    try {
      await this.page.waitForLoadState("networkidle", { timeout: config.agent.networkIdleTimeout });
    } catch {
      // Expected for SPA/polling sites — not an error
    }
  }

  // Check if browser is still alive
  isAlive() {
    try {
      return this.browser && this.browser.isConnected();
    } catch {
      return false;
    }
  }

  async close() {
    if (this._contextTimer) {
      clearTimeout(this._contextTimer);
      this._contextTimer = null;
    }
    this._defaultContext = null;
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
    }
  }
}

module.exports = BrowserController;
