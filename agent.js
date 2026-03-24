require("dotenv").config();
const puppeteer = require("puppeteer");
const Groq = require("groq-sdk");
const readline = require("readline");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Browser Controller ─────────────────────────────────────────────────────

const JUNK_PATTERNS = /cookie|consent|privacy|subscribe|newsletter|footer|nav|sidebar|banner|popup|modal|overlay|accept|dismiss|close/i;

class BrowserController {
  constructor() {
    this.browser = null;
    this.page = null;
    this.elements = []; // stored elements from last getPageInfo, for clickElement
  }

  async launch() {
    this.browser = await puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1280, height: 800 },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
      ],
    });
    this.page = (await this.browser.pages())[0];
    await this.page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    this.page.setDefaultTimeout(15000);
    console.log("[Browser] Launched Chrome (stealth mode)\n");
  }

  async goto(url) {
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this._settle();
    return await this.getPageInfo();
  }

  async clickElement(number) {
    const idx = Number(number) - 1;
    const el = this.elements[idx];
    if (!el) return `Invalid element number: ${number}. Use a number from the list.`;

    try {
      if (el.selector) {
        await this.page.waitForSelector(el.selector, { timeout: 5000 });
        await this.page.click(el.selector);
      } else {
        // Click by stored index using evaluate
        await this.page.evaluate((i) => {
          const all = document.querySelectorAll("a[href], button, [role=button], input[type=submit], input[type=button]");
          const visible = [...all].filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top < window.innerHeight;
          });
          if (visible[i]) visible[i].click();
        }, el._rawIndex);
      }
      await this._settle();
      return await this.getPageInfo();
    } catch {
      return `Failed to click element ${number}: "${el.label}"`;
    }
  }

  async type(selector, text) {
    try {
      await this.page.waitForSelector(selector, { timeout: 5000 });
      await this.page.click(selector, { clickCount: 3 });
      await this.page.type(selector, text, { delay: 30 });
      return `Typed "${text}" into ${selector}`;
    } catch {
      return `Could not find input: ${selector}`;
    }
  }

  async getText() {
    const text = await this.page.evaluate(() => document.body.innerText.substring(0, 800));
    return text || "(empty page)";
  }

  async scroll(direction = "down") {
    await this.page.evaluate((dir) => {
      window.scrollBy(0, dir === "up" ? -600 : 600);
    }, direction);
    await new Promise((r) => setTimeout(r, 500));
    return await this.getPageInfo();
  }

  async back() {
    await this.page.goBack({ waitUntil: "domcontentloaded" });
    await this._settle();
    return await this.getPageInfo();
  }

  async getPageInfo() {
    const title = await this.page.title();
    const url = this.page.url();

    const rawElements = await this.page.evaluate((junkStr) => {
      const junk = new RegExp(junkStr, "i");
      const seen = new Set();
      const results = [];
      const all = document.querySelectorAll("a[href], button, [role=button], input, textarea, select, input[type=submit]");

      let rawIndex = 0;
      for (const el of all) {
        const r = el.getBoundingClientRect();
        // Skip invisible elements
        if (r.width === 0 || r.height === 0 || r.top > window.innerHeight || r.bottom < 0) {
          rawIndex++;
          continue;
        }

        const tag = el.tagName.toLowerCase();
        const type = el.type || "";
        const id = el.id || "";
        const name = el.name || "";
        const text = el.textContent?.trim().substring(0, 60) || "";
        const placeholder = el.placeholder || "";
        const href = el.href || "";
        const ariaLabel = el.getAttribute("aria-label") || "";

        // Determine label
        let label = "";
        let kind = "";
        if (tag === "a") {
          kind = "link";
          label = text || ariaLabel;
        } else if (tag === "button" || type === "submit" || type === "button" || el.getAttribute("role") === "button") {
          kind = "button";
          label = text || ariaLabel;
        } else if (tag === "input" || tag === "textarea" || tag === "select") {
          kind = "input";
          label = placeholder || ariaLabel || name || type;
        }

        if (!label) { rawIndex++; continue; }

        // Filter junk
        const context = (el.closest("nav, footer, header") || {}).tagName || "";
        const fullText = `${label} ${id} ${name} ${context}`;
        if (junk.test(fullText) && kind !== "input") { rawIndex++; continue; }

        // Deduplicate
        const key = `${kind}:${label.toLowerCase().substring(0, 30)}`;
        if (seen.has(key)) { rawIndex++; continue; }
        seen.add(key);

        const selector = id ? `#${id}` : name ? `${tag}[name="${name}"]` : null;
        results.push({ kind, label: label.substring(0, 50), selector, href, rawIndex });
        rawIndex++;

        if (results.length >= 10) break;
      }
      return results;
    }, JUNK_PATTERNS.source);

    // Store elements for clickElement
    this.elements = rawElements.map((el, i) => ({
      ...el,
      _rawIndex: el.rawIndex,
    }));

    // Build compact element list
    const elementList = this.elements
      .map((el, i) => `[${i + 1}] ${el.kind}: ${el.label}`)
      .join("\n");

    const visibleText = await this.page.evaluate(() => document.body?.innerText?.substring(0, 400) || "");

    return `Page: ${title}\nURL: ${url}\nElements:\n${elementList || "(none)"}\n\nText: ${visibleText}`;
  }

  async _settle() {
    await new Promise((r) => setTimeout(r, 800));
    try {
      await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 });
    } catch {}
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

// ─── AI Planner ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a web browser agent. Respond with ONLY a JSON object, no other text.
Tools: goto(url), clickElement(number), type(selector, text), getText(), scroll(down/up), back(), done(result)
clickElement takes the number shown in brackets like [1], [2] etc.
Format: {"action":"tool_name","params":{"key":"value"}}
When finished: {"action":"done","params":{"result":"what was found/done"}}
Be direct. Use fewest steps possible.`;

class AIPlanner {
  constructor() {
    this.history = [];
  }

  reset(task) {
    this.history = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Task: ${task}` },
    ];
  }

  async getNextAction(observation) {
    if (observation) {
      this.history.push({ role: "user", content: observation });
    }

    // Keep history short: system + first user + last 14 messages
    if (this.history.length > 18) {
      this.history = [this.history[0], this.history[1], ...this.history.slice(-14)];
    }

    // Try up to 2 times for valid JSON
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this._callGroq(this.history);

      const raw = response.choices[0].message.content.trim();

      const parsed = this._parseJSON(raw);
      if (parsed) {
        this.history.push({ role: "assistant", content: raw });
        return parsed;
      }

      // First attempt failed — ask the model to fix it
      if (attempt === 0) {
        console.log(`  ⚠  Invalid JSON, retrying...`);
        this.history.push({ role: "assistant", content: raw });
        this.history.push({ role: "user", content: "Invalid JSON. Respond with ONLY a JSON object: {\"action\":\"...\",\"params\":{...}}" });
      }
    }

    // Both attempts failed — skip step
    return null;
  }

  async _callGroq(messages) {
    const models = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

    for (const model of models) {
      try {
        return await groq.chat.completions.create({
          model,
          messages,
          temperature: 0.1,
          max_tokens: 200,
        });
      } catch (err) {
        if (err.status === 429 || err.error?.type === "rate_limit_error") {
          // Extract wait time from error message (e.g. "try again in 1.5s" or "after 30 seconds")
          const match = String(err.message || err.error?.message || "").match(/([\d.]+)\s*s/i);
          const waitSec = match ? Math.ceil(parseFloat(match[1])) : 5;

          if (model === models[0]) {
            console.log(`  ⏳ Rate limited on ${model}, waiting ${waitSec}s then falling back to ${models[1]}...`);
            await new Promise((r) => setTimeout(r, waitSec * 1000));
            continue; // try fallback model
          } else {
            console.log(`  ⏳ Rate limited on ${model} too, waiting ${waitSec}s...`);
            await new Promise((r) => setTimeout(r, waitSec * 1000));
            // Retry same fallback model once after waiting
            return await groq.chat.completions.create({
              model,
              messages,
              temperature: 0.1,
              max_tokens: 200,
            });
          }
        }
        throw err; // non-rate-limit error, let it propagate
      }
    }
  }

  _parseJSON(raw) {
    // Strip markdown fences
    let json = raw;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) json = fence[1].trim();

    try {
      return JSON.parse(json);
    } catch {}

    // Extract first JSON object
    const match = raw.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }

    return null;
  }
}

// ─── Search Shortcut ────────────────────────────────────────────────────────

function detectSearchQuery(task) {
  const patterns = [
    /^(?:search|google|look up|find|what is|what are|who is|where is|when is|how to|how much|how many)\b(.+)/i,
    /^(.+?)(?:\?|$)/,
  ];
  const lower = task.toLowerCase().trim();
  // Only shortcut for simple search/lookup tasks
  if (/search|google|look up|find info|what is|who is|where is/i.test(lower)) {
    const query = task.replace(/^(search|google|look up|find)\s+(for\s+)?/i, "").trim();
    return query || null;
  }
  return null;
}

// ─── Action Loop ────────────────────────────────────────────────────────────

async function executeAction(browser, action, params) {
  const TIMEOUT = 120000;

  const actionFn = async () => {
    switch (action) {
      case "goto":         return browser.goto(params.url);
      case "clickElement":  return browser.clickElement(params.number);
      case "type":         return browser.type(params.selector, params.text);
      case "getText":      return browser.getText();
      case "scroll":       return browser.scroll(params.direction);
      case "back":         return browser.back();
      default:             return `Unknown action: ${action}`;
    }
  };

  return Promise.race([
    actionFn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Action timed out (2 min)")), TIMEOUT)),
  ]);
}

async function runTask(browser, planner, task) {
  const MAX_STEPS = 20;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Task: ${task}`);
  console.log(`${"═".repeat(60)}\n`);

  // Search shortcut: skip straight to Google results
  const searchQuery = detectSearchQuery(task);
  let observation = null;

  if (searchQuery) {
    console.log(`  [Shortcut] Direct Google search: "${searchQuery}"\n`);
    const encoded = encodeURIComponent(searchQuery);
    observation = await browser.goto(`https://www.google.com/search?q=${encoded}`);
    planner.reset(task);
    planner.history.push({ role: "user", content: `I already searched Google for you. Here's the page:\n${observation}` });
  } else {
    planner.reset(task);
  }

  for (let step = 1; step <= MAX_STEPS; step++) {
    try {
      const plan = await planner.getNextAction(step === 1 && searchQuery ? null : observation);

      if (!plan) {
        console.log(`  [Step ${step}] ⚠  Skipped (bad AI response)\n`);
        observation = await browser.getPageInfo();
        continue;
      }

      if (plan.action === "done") {
        const result = plan.params?.result || plan.result || "Task complete";
        console.log(`\n  ✅ [Done] ${result}\n`);
        return result;
      }

      // Display step
      const paramStr = plan.params ? JSON.stringify(plan.params) : "";
      console.log(`  [Step ${step}] ▶  ${plan.action}(${paramStr})`);

      observation = await executeAction(browser, plan.action, plan.params || {});

      // Show truncated result
      const preview = String(observation).substring(0, 150).replace(/\n/g, " ");
      console.log(`  [Step ${step}] ◀  ${preview}${observation.length > 150 ? "..." : ""}\n`);
    } catch (err) {
      observation = `Error: ${err.message}`;
      console.log(`  [Step ${step}] ❌ ${observation}\n`);
    }
  }

  console.log(`\n  ⚠️  Reached maximum steps (${MAX_STEPS}). Stopping.\n`);
  return "Task stopped — max steps reached.";
}

// ─── Console Interface ──────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║          🌐  WebAgent — AI Browser Agent            ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const browser = new BrowserController();
  await browser.launch();

  const planner = new AIPlanner();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  while (true) {
    const task = await ask("🔍 What would you like me to do? (type 'quit' to exit)\n> ");

    if (!task || task.trim().toLowerCase() === "quit") {
      console.log("\nShutting down...");
      await browser.close();
      rl.close();
      process.exit(0);
    }

    try {
      await runTask(browser, planner, task.trim());
    } catch (err) {
      console.error(`\n❌ Task failed: ${err.message}\n`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
