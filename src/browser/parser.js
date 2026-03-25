const config = require("../config");

const JUNK_PATTERNS = /cookie|consent|privacy|subscribe|newsletter|footer|nav|sidebar|banner|popup|modal|overlay|accept|dismiss|close/i;

async function extractElements(page) {
  const maxElements = config.agent.maxElements;

  return await page.evaluate(
    ({ junkStr, max }) => {
      const junk = new RegExp(junkStr, "i");
      const seen = new Set();
      const results = [];
      const all = document.querySelectorAll(
        "a[href], button, [role=button], input, textarea, select, input[type=submit], [role=combobox], [role=searchbox], [contenteditable=true]"
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
        const role = el.getAttribute("role") || "";

        // Find associated <label> element
        const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null;
        const labelText = labelEl ? labelEl.textContent.trim().substring(0, 40) : "";

        // Get current value for inputs
        const currentValue = (tag === "input" || tag === "textarea" || tag === "select")
          ? (el.value || "").substring(0, 30) : "";

        let label = "";
        let kind = "";
        let priority = 0;

        if (tag === "input" || tag === "textarea" || tag === "select" || role === "combobox" || role === "searchbox" || el.contentEditable === "true") {
          kind = "input";
          label = labelText || ariaLabel || placeholder || name || type;
          priority = 3; // Inputs first
        } else if (tag === "button" || type === "submit" || type === "button" || role === "button") {
          kind = "button";
          label = text || ariaLabel;
          priority = (type === "submit" || /search|submit|go|book|find/i.test(text)) ? 2 : 1;
        } else if (tag === "a") {
          kind = "link";
          label = text || ariaLabel;
          priority = 0;
        }

        if (!label) { rawIndex++; continue; }

        const context = (el.closest("nav, footer, header") || {}).tagName || "";
        const fullText = `${label} ${id} ${name} ${context}`;
        if (junk.test(fullText) && kind !== "input") { rawIndex++; continue; }

        const key = `${kind}:${label.toLowerCase().substring(0, 30)}`;
        if (seen.has(key)) { rawIndex++; continue; }
        seen.add(key);

        const selector = id ? `#${id}` : name ? `${tag}[name="${name}"]` : null;
        results.push({
          kind,
          label: label.substring(0, 50),
          selector,
          href: el.href || "",
          rawIndex,
          placeholder,
          currentValue,
          inputType: (kind === "input") ? (type || tag) : "",
          priority,
        });
        rawIndex++;
      }

      // Sort by priority (inputs first, then primary buttons, then other buttons, then links)
      results.sort((a, b) => b.priority - a.priority);
      return results.slice(0, max);
    },
    { junkStr: JUNK_PATTERNS.source, max: maxElements }
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
    .map((el, i) => {
      let line = `[${i + 1}] ${el.kind}: "${el.label}"`;
      if (el.placeholder) line += ` placeholder="${el.placeholder}"`;
      if (el.currentValue) line += ` value="${el.currentValue}"`;
      if (el.inputType) line += ` type=${el.inputType}`;
      if (el.selector) line += ` ${el.selector}`;
      return line;
    })
    .join("\n");

  return `Page: ${title}\nURL: ${url}\n\nElements:\n${elementList || "(none)"}\n\nVisible text:\n${visibleText}`;
}

module.exports = { extractElements, extractVisibleText, formatPageInfo };
