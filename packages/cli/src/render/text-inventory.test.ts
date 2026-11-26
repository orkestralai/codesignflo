// Text the page shows that Live won't have, in a real browser. Skipped without Chromium.
import type { IRNode } from "@codesignflo/core";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractInPage } from "./extract-in-page.js";
import { droppedTexts, pageTextsInPage } from "./text-inventory.js";

let browser: Browser | null = null;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch().catch(() => null);
  if (browser) page = await browser.newPage({ viewport: { width: 800, height: 600 } });
});
afterAll(async () => {
  await browser?.close();
});

const show = (body: string) =>
  page.setContent(`<body style="margin:0"><div id="storybook-root"><div style="width:400px">${body}</div></div></body>`);

describe("text the page shows", () => {
  it("visible text only: not hidden, not for screen readers only, not inside SVG drawings or a select's options", async (t) => {
    if (!browser) return t.skip();
    await show(`
      <h1>Your cart</h1>
      <p>Two <b>items</b> ready</p>
      <span style="display:none">Hidden away</span>
      <span style="visibility:hidden">Invisible too</span>
      <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Screen readers only</span>
      <svg width="40" height="20"><text x="0" y="15">Logo</text></svg>
      <select><option>First choice</option><option>Second choice</option></select>`);
    expect(await page.evaluate(pageTextsInPage)).toEqual(["Your cart", "Two", "items", "ready"]);
  });

  it("nothing is reported when the extractor read it all (inline pieces are one paragraph there)", async (t) => {
    if (!browser) return t.skip();
    await show(`<h1 style="text-transform:uppercase">Your cart</h1><p>Two <b>items</b> ready</p><button>Check out</button>`);
    const root = await page.evaluate(extractInPage);
    expect(droppedTexts(await page.evaluate(pageTextsInPage), root)).toEqual([]);
  });

  it("text the extractor didn't read is reported, each once", () => {
    const root = {
      name: "root",
      type: "FRAME",
      width: 1,
      height: 1,
      sizing: { w: "fixed", h: "fixed" },
      children: [{ name: "title", type: "TEXT", width: 1, height: 1, sizing: { w: "hug", h: "hug" }, text: { characters: "Your cart" } }],
    } as unknown as IRNode;
    expect(droppedTexts(["Your cart", "Free shipping", "Free shipping", "YOUR CART"], root)).toEqual(["Free shipping"]);
    // Pieces of two different texts don't join into a match.
    const two = { ...root, children: [...(root.children ?? []), { ...root.children![0]!, text: { characters: "shipping" } }] } as IRNode;
    expect(droppedTexts(["cart shipping"], two)).toEqual(["cart shipping"]);
  });
});
