// Text the page shows that Live won't have: every visible piece of text in the story, checked against the
// texts the extractor read. What's missing is a CoDesignFlo gap (the extractor dropped it), reported at sync.
import type { IRNode } from "@codesignflo/core";

/**
 * Runs in the page: each visible piece of text in the story's root, as the browser shows it. Left out on purpose,
 * as the extractor leaves them out: text for screen readers only (a box 1 px or smaller), SVG drawings (kept whole,
 * as pictures), the options of a native select, and anything hidden.
 */
export function pageTextsInPage(): string[] {
  const container = (document.querySelector("[data-cdf-container], [data-cdl-container]") ??
    document.querySelector("#storybook-root")) as HTMLElement | null;
  const root = container?.firstElementChild;
  if (!root) return [];
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!/[\p{L}\p{N}].*[\p{L}\p{N}]/u.test(text)) continue;
    const el = n.parentElement;
    if (!el || el.closest("svg, script, style, noscript, template, select, option, iframe")) continue;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }))
      continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    out.push(text);
  }
  return out;
}

/** For comparing: Unicode-normalised, spaces collapsed, lower case (text-transform changes only the look). */
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** The texts in an extracted story, joined (a paragraph's inline pieces are one text there). */
function textsOf(n: IRNode, out: string[] = []): string[] {
  const t = (n as IRNode & { text?: { characters?: string } }).text?.characters;
  if (t) out.push(norm(t));
  for (const c of n.children ?? []) textsOf(c, out);
  return out;
}

/** The page's texts that none of the extracted texts contain, each once, in the page's order. */
export function droppedTexts(pageTexts: string[], root: IRNode): string[] {
  const haystack = ` ${textsOf(root).join(" \u0000 ")} `;
  const missing: string[] = [];
  for (const t of pageTexts) {
    const n = norm(t);
    if (!n || haystack.includes(n) || missing.includes(t)) continue;
    missing.push(t);
  }
  return missing;
}
