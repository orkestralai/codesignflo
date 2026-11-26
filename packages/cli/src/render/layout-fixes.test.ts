// Found by a fake app synced to Figma: a centred max-width section, an answer padded on two sides only, and an
// SVG coloured with a CSS custom property. Read in a real browser; skipped without Chromium.
import type { IRNode } from "@codesignflo/core";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPage } from "./render.js";

let browser: Browser | null = null;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch().catch(() => null);
  if (!browser) return;
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    (globalThis as unknown as { __name: unknown }).__name = (f: unknown) => f;
  });
});
afterAll(async () => {
  await browser?.close();
});

const read = async (html: string): Promise<IRNode> => {
  await page.setContent(`<body style="margin:0"><div id="storybook-root">${html}</div></body>`);
  return extractPage(page);
};
const find = (n: IRNode, name: string): IRNode | undefined =>
  n.name === name ? n : (n.children ?? []).map((c) => find(c, name)).find(Boolean);

describe("the browser read", () => {
  it("a column whose fixed-width children are centred (margin: 0 auto) centres them, block or flex", async (t) => {
    if (!browser) return t.skip();
    for (const display of ["block", "flex; flex-direction: column"]) {
      const root = await read(
        `<div data-cdf="page" style="display:${display}"><div data-cdf="nav" style="height:40px"></div><section data-cdf="narrow" style="max-width:800px;width:100%;margin:0 auto;height:100px"></section></div>`,
      );
      expect(find(root, "page")!.layout?.align, display).toBe("CENTER");
    }
  });

  it("keeps a column stretching when a fixed-width child sits at its left", async (t) => {
    if (!browser) return t.skip();
    const root = await read(
      `<div data-cdf="page"><div data-cdf="left" style="width:300px;height:40px"></div><section data-cdf="narrow" style="max-width:800px;margin:0 auto;height:100px"></section></div>`,
    );
    expect(find(root, "page")!.layout?.align).toBe("STRETCH");
  });

  it("text padded on any side is a frame with that padding around the text (not a text layer as tall as its box)", async (t) => {
    if (!browser) return t.skip();
    const root = await read(
      `<div data-cdf="item" style="width:600px"><p data-cdf="answer" style="margin:0;padding:0 40px 20px 0;font:14px/22px sans-serif">One line.</p></div>`,
    );
    const answer = find(root, "answer")!;
    expect(answer.type).toBe("FRAME");
    expect(answer.layout?.padding.map((p) => p.value)).toEqual([0, 40, 20, 0]);
    expect(answer.children?.[0]?.type).toBe("TEXT");
  });

  it("an SVG coloured with a CSS custom property gets the colour the browser drew", async (t) => {
    if (!browser) return t.skip();
    const root = await read(
      `<div data-cdf="logo" style="--brand:#0f766e"><svg data-cdf="mark" viewBox="0 0 24 24" width="24" height="24"><rect width="24" height="24" fill="var(--brand)"/><path d="M6 16l4-5" style="stroke: var(--brand)"/></svg></div>`,
    );
    const svg = find(root, "mark")!.svg!;
    expect(svg).not.toContain("var(");
    expect(svg).toContain('fill="rgb(15, 118, 110)"');
    // As an attribute, out of its style (Figma reads attributes).
    expect(svg).toMatch(/<path[^>]*stroke="rgb\(15, 118, 110\)"/);
  });

  it("reads the story inside nested wrappers (a story's decorator inside its component's)", async (t) => {
    if (!browser) return t.skip();
    await page.setContent(
      `<body style="margin:0"><div id="storybook-root"><div data-cdf-container style="width:600px"><div data-cdf-container style="height:200px"><nav data-cdf="navbar" style="height:64px"></nav></div></div></div></body>`,
    );
    const root = await extractPage(page);
    expect(root.name).toBe("navbar");
    expect(root.unnamed).toBeUndefined();
  });
});
