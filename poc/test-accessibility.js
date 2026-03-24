const { chromium } = require("playwright");

// ─── Config ──────────────────────────────────────────────────────────────────

const TEST_SITES = [
  {
    name: "Wikipedia",
    url: "https://www.wikipedia.org",
    searchHint: /search/i,
  },
  {
    name: "Amazon India",
    url: "https://www.amazon.in",
    searchHint: /search/i,
  },
  {
    name: "React Docs",
    url: "https://react.dev",
    searchHint: /search/i,
  },
  {
    name: "Flipkart",
    url: "https://www.flipkart.com",
    searchHint: /search/i,
  },
  {
    name: "Hacker News",
    url: "https://news.ycombinator.com",
    searchHint: /search|input/i,
  },
];

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "option",
]);

const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function separator(title) {
  const line = "=".repeat(70);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(`${line}\n`);
}

function pad(str, len) {
  const s = String(str || "");
  return s.length >= len ? s.substring(0, len) : s + " ".repeat(len - s.length);
}

// ─── Get accessibility tree via Chrome DevTools Protocol ─────────────────────

async function getAccessibilityTree(page) {
  const client = await page.context().newCDPSession(page);
  const { nodes } = await client.send("Accessibility.getFullAXTree");
  await client.detach();
  return nodes;
}

// ─── Test a single site ──────────────────────────────────────────────────────

async function testSite(browser, site) {
  const result = {
    name: site.name,
    url: site.url,
    searchFound: false,
    navLinksFound: false,
    mainContentFound: false,
    interactionWorked: false,
    totalInteractive: 0,
    assessment: "UNRELIABLE",
    error: null,
  };

  let context, page;

  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page = await context.newPage();

    separator(`Testing: ${site.name} (${site.url})`);

    // 1. Navigate
    console.log("  Navigating...");
    try {
      await page.goto(site.url, { waitUntil: "networkidle", timeout: 20000 });
    } catch {
      // Fallback: some sites never fully reach networkidle
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 20000 });
    }
    await page.waitForTimeout(2000); // extra settle time for SPAs

    const title = await page.title();
    console.log(`  Page title: ${title}`);
    console.log(`  Final URL:  ${page.url()}`);

    // 2. Close any popups / dismiss overlays
    try {
      const dismissSelectors = [
        'button:has-text("Accept")',
        'button:has-text("Got it")',
        'button:has-text("Close")',
        'button:has-text("No thanks")',
        'button:has-text("Dismiss")',
        '[aria-label="Close"]',
      ];
      for (const sel of dismissSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(500);
          break;
        }
      }
    } catch {}

    // 3. Get CDP accessibility tree
    console.log("\n  --- CDP Accessibility Tree ---");
    const axNodes = await getAccessibilityTree(page);
    console.log(`  Total AX nodes: ${axNodes.length}`);

    const interactive = axNodes.filter((n) => INTERACTIVE_ROLES.has(n.role?.value));
    const inputs = axNodes.filter((n) => INPUT_ROLES.has(n.role?.value));
    const buttons = axNodes.filter((n) => n.role?.value === "button");
    const links = axNodes.filter((n) => n.role?.value === "link");
    const headings = axNodes.filter((n) => n.role?.value === "heading");

    result.totalInteractive = interactive.length;

    console.log(`  Interactive elements:   ${interactive.length}`);
    console.log(`    - Text inputs:        ${inputs.length}`);
    console.log(`    - Buttons:            ${buttons.length}`);
    console.log(`    - Links:              ${links.length}`);
    console.log(`    - Headings:           ${headings.length}`);

    // 4. Print interactive elements (capped at 25)
    console.log("\n  --- Interactive Elements (up to 25) ---");
    const shown = interactive.slice(0, 25);
    for (let i = 0; i < shown.length; i++) {
      const el = shown[i];
      const role = el.role?.value || "?";
      const name = (el.name?.value || "").substring(0, 50);
      const marker = INPUT_ROLES.has(role) ? " <<< INPUT" : "";
      console.log(`  [${pad(i + 1, 3)}] ${pad(role, 12)} | ${name}${marker}`);
    }
    if (interactive.length > 25) {
      console.log(`  ... and ${interactive.length - 25} more`);
    }

    // 5. Check: can we find search/input?
    const searchInput = inputs.find(
      (n) =>
        site.searchHint.test(n.name?.value || "") ||
        /search/i.test(n.name?.value || "") ||
        /search/i.test(n.description?.value || "")
    );
    const anyInput = inputs[0];
    const targetInput = searchInput || anyInput;

    result.searchFound = !!targetInput;
    console.log(
      `\n  Search/input found:     ${result.searchFound ? "YES" : "NO"}${
        targetInput
          ? ` (role: ${targetInput.role?.value}, name: "${targetInput.name?.value || ""}")`
          : ""
      }`
    );

    // 6. Check: navigation links?
    result.navLinksFound = links.length >= 3;
    console.log(
      `  Navigation links found: ${result.navLinksFound ? "YES" : "NO"} (${links.length} links)`
    );

    // 7. Check: main content (headings or significant text)?
    result.mainContentFound = headings.length > 0 || axNodes.length > 50;
    console.log(
      `  Main content found:     ${result.mainContentFound ? "YES" : "NO"} (${
        headings.length
      } headings, ${axNodes.length} total nodes)`
    );

    // 8. ARIA snapshot (Playwright's built-in)
    console.log("\n  --- ARIA Snapshot (first 600 chars) ---");
    try {
      const ariaSnap = await page.locator("body").ariaSnapshot();
      const lines = ariaSnap.substring(0, 600).split("\n").slice(0, 15);
      for (const line of lines) {
        console.log(`  ${line}`);
      }
      if (ariaSnap.length > 600) {
        console.log(`  ... (${ariaSnap.length} chars total)`);
      }
    } catch (ariaErr) {
      console.log(`  ARIA snapshot failed: ${ariaErr.message}`);
    }

    // 9. Interaction test: try typing into the search/input
    console.log("\n  --- Interaction Test ---");
    if (targetInput) {
      try {
        let typed = false;
        const inputName = targetInput.name?.value || "";
        const inputRole = targetInput.role?.value || "textbox";

        // Strategy 1: getByRole with name
        try {
          const roleMap = { combobox: "combobox", searchbox: "searchbox", textbox: "textbox" };
          const pwRole = roleMap[inputRole] || "textbox";
          const locator = inputName
            ? page.getByRole(pwRole, { name: inputName })
            : page.getByRole(pwRole).first();

          if (await locator.isVisible({ timeout: 3000 })) {
            await locator.click({ timeout: 3000 });
            await locator.fill("playwright test", { timeout: 3000 });
            const value = await locator.inputValue({ timeout: 2000 }).catch(() => null);
            if (value && value.includes("playwright")) {
              typed = true;
              console.log(`  Typed via getByRole("${pwRole}", "${inputName}"): SUCCESS`);
              console.log(`  Input value: "${value}"`);
            }
          }
        } catch {}

        // Strategy 2: CSS selectors
        if (!typed) {
          const selectors = [
            'input[type="search"]',
            'input[type="text"]',
            "input[name*='search' i]",
            "input[placeholder*='search' i]",
            "input:not([type='hidden']):not([type='submit']):not([type='checkbox']):not([type='radio'])",
          ];
          for (const sel of selectors) {
            try {
              const el = page.locator(sel).first();
              if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
                await el.click({ timeout: 2000 });
                await el.fill("playwright test", { timeout: 2000 });
                const value = await el.inputValue({ timeout: 1000 }).catch(() => null);
                if (value && value.includes("playwright")) {
                  typed = true;
                  console.log(`  Typed via selector "${sel}": SUCCESS`);
                  console.log(`  Input value: "${value}"`);
                  break;
                }
              }
            } catch {}
          }
        }

        if (!typed) {
          console.log("  Interaction: FAILED (could not type into input)");
        }
        result.interactionWorked = typed;
      } catch (intErr) {
        console.log(`  Interaction error: ${intErr.message}`);
        result.interactionWorked = false;
      }
    } else {
      console.log("  No input found to test interaction");
      result.interactionWorked = false;
    }

    // 10. Assessment
    const score =
      (result.searchFound ? 1 : 0) +
      (result.navLinksFound ? 1 : 0) +
      (result.mainContentFound ? 1 : 0) +
      (result.interactionWorked ? 1 : 0) +
      (result.totalInteractive >= 10 ? 1 : 0);

    if (score >= 4) result.assessment = "RELIABLE";
    else if (score >= 2) result.assessment = "PARTIAL";
    else result.assessment = "UNRELIABLE";

    console.log(`\n  Assessment: ${result.assessment} (score: ${score}/5)`);
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    result.error = err.message;
    result.assessment = "ERROR";
  } finally {
    if (context) await context.close().catch(() => {});
  }

  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("  Playwright Accessibility Tree — Proof of Concept");
  console.log("  Testing on 5 real websites (CDP + ARIA snapshot)");
  console.log("=".repeat(70));

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const results = [];

  for (const site of TEST_SITES) {
    const result = await testSite(browser, site);
    results.push(result);
  }

  await browser.close();

  // ─── Summary Table ───────────────────────────────────────────────────────
  separator("SUMMARY TABLE");

  const hdr = [
    pad("Site", 16),
    pad("Search", 8),
    pad("Nav", 8),
    pad("Content", 9),
    pad("Interact", 10),
    pad("Elements", 10),
    pad("Assessment", 12),
  ].join("| ");
  const divider = "-".repeat(hdr.length + 4);

  console.log(`  ${hdr}`);
  console.log(`  ${divider}`);

  for (const r of results) {
    const row = [
      pad(r.name, 16),
      pad(r.searchFound ? "YES" : "NO", 8),
      pad(r.navLinksFound ? "YES" : "NO", 8),
      pad(r.mainContentFound ? "YES" : "NO", 9),
      pad(r.interactionWorked ? "YES" : "NO", 10),
      pad(String(r.totalInteractive), 10),
      pad(r.assessment, 12),
    ].join("| ");
    console.log(`  ${row}`);
  }

  console.log(`\n  ${divider}`);

  const reliable = results.filter((r) => r.assessment === "RELIABLE").length;
  const partial = results.filter((r) => r.assessment === "PARTIAL").length;
  const unreliable = results.filter(
    (r) => r.assessment === "UNRELIABLE" || r.assessment === "ERROR"
  ).length;

  console.log(
    `\n  Reliable: ${reliable}/5  |  Partial: ${partial}/5  |  Unreliable: ${unreliable}/5`
  );

  if (reliable >= 3) {
    console.log("\n  VERDICT: Accessibility tree parsing is VIABLE for the agent.");
  } else if (reliable + partial >= 3) {
    console.log("\n  VERDICT: Accessibility tree works but needs fallbacks for some sites.");
  } else {
    console.log(
      "\n  VERDICT: Accessibility tree alone is insufficient. Need supplementary approach."
    );
  }

  console.log("");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
