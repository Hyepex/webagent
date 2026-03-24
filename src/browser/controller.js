const puppeteer = require("puppeteer");
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
    this.page = null;
    this.elements = [];
    this._taskContext = null;
    this._contextTimer = null;
  }

  async launch() {
    const launchOptions = {
      headless: config.browser.headless,
      defaultViewport: {
        width: config.browser.viewportWidth,
        height: config.browser.viewportHeight,
      },
      args: config.browser.launchArgs,
    };

    if (config.browser.executablePath) {
      launchOptions.executablePath = config.browser.executablePath;
    }

    this.browser = await puppeteer.launch(launchOptions);
    this.page = (await this.browser.pages())[0];

    await this._setupPage(this.page);

    log.success(`Launched Chrome (headless=${config.browser.headless}, stealth mode)`);
  }

  async _setupPage(page) {
    await page.setUserAgent(config.browser.userAgent);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    page.setDefaultTimeout(config.browser.defaultTimeout);
  }

  // Create an isolated browser context for a task
  async createTaskContext() {
    try {
      if (!this.browser) {
        throw new Error("Browser not launched");
      }

      this._taskContext = await this.browser.createBrowserContext();
      this.page = await this._taskContext.newPage();
      await this._setupPage(this.page);

      // Set hard timeout — auto-close context after 5 minutes
      this._contextTimer = setTimeout(() => {
        log.warn("Task context timed out (5 min limit), force-closing");
        this.closeTaskContext().catch(() => {});
      }, TASK_CONTEXT_TIMEOUT);

      log.debug("Created isolated task context");
    } catch (err) {
      log.error(`Failed to create task context: ${err.message}`);
      // Fallback to default page
      if (this.browser) {
        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();
        await this._setupPage(this.page);
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
        const pages = await this._taskContext.pages();
        for (const p of pages) {
          await p.close().catch(() => {});
        }
        await this._taskContext.close();
        log.debug("Closed isolated task context");
      } catch (err) {
        log.warn(`Error closing task context: ${err.message}`);
      }
      this._taskContext = null;
    }

    // Reset to a default page from the browser
    try {
      if (this.browser) {
        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();
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
    await new Promise((r) => setTimeout(r, config.agent.settleDelay));
    try {
      await this.page.waitForNetworkIdle({ idleTime: 500, timeout: config.agent.networkIdleTimeout });
    } catch {}
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
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
    }
  }
}

module.exports = BrowserController;
