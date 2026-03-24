const config = require("../config");

const JUNK_PATTERNS = /cookie|consent|privacy|subscribe|newsletter|footer|nav|sidebar|banner|popup|modal|overlay|accept|dismiss|close/i;

async function extractElements(page) {
  const maxElements = config.agent.maxElements;

  return await page.evaluate(
    (junkStr, max) => {
      const junk = new RegExp(junkStr, "i");
      const seen = new Set();
      const results = [];
      const all = document.querySelectorAll(
        "a[href], button, [role=button], input, textarea, select, input[type=submit]"
      );

      let rawIndex = 0;
      for (const el of all) {
        const r = el.getBoundingClientRect();
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
        const ariaLabel = el.getAttribute("aria-label") || "";

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

        const context = (el.closest("nav, footer, header") || {}).tagName || "";
        const fullText = `${label} ${id} ${name} ${context}`;
        if (junk.test(fullText) && kind !== "input") { rawIndex++; continue; }

        const key = `${kind}:${label.toLowerCase().substring(0, 30)}`;
        if (seen.has(key)) { rawIndex++; continue; }
        seen.add(key);

        const selector = id ? `#${id}` : name ? `${tag}[name="${name}"]` : null;
        results.push({ kind, label: label.substring(0, 50), selector, href: el.href || "", rawIndex });
        rawIndex++;

        if (results.length >= max) break;
      }
      return results;
    },
    JUNK_PATTERNS.source,
    maxElements
  );
}

async function extractVisibleText(page, maxLength) {
  return await page.evaluate(
    (max) => document.body?.innerText?.substring(0, max) || "",
    maxLength
  );
}

function formatPageInfo(title, url, elements, visibleText) {
  const elementList = elements
    .map((el, i) => `[${i + 1}] ${el.kind}: ${el.label}`)
    .join("\n");

  return `Page: ${title}\nURL: ${url}\nElements:\n${elementList || "(none)"}\n\nText: ${visibleText}`;
}

module.exports = { extractElements, extractVisibleText, formatPageInfo };
