// Overlays fixed to the window, in a real browser: lifted onto the page (not clipped and shifted inside the
// panel that holds them), and covering the whole page when it is taller than the window. Skipped without
// Chromium.
import type { IRNode } from "@codesignflo/core";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractInPage } from "./extract-in-page.js";
import { coverPage } from "./render.js";

let browser: Browser | null = null;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch().catch(() => null);
  if (browser) page = await browser.newPage({ viewport: { width: 1728, height: 1080 } });
});
afterAll(async () => {
  await browser?.close();
});

async function extract(body: string): Promise<IRNode> {
  await page.setViewportSize({ width: 1728, height: 1080 });
  await page.setContent(`<body style="margin:0"><div id="storybook-root">${body}</div></body>`);
  await coverPage(page);
  return page.evaluate(extractInPage);
}

const app = (inner: string, tall = 0) =>
  `<div style="display:flex"><nav style="width:256px;height:${tall || 1080}px"></nav><main style="flex:1;padding-top:64px">${inner}</main></div>`;

describe("overlays fixed to the window", () => {
  it("a drawer on the right, opened from the content panel, lies on the page at the right", async (t) => {
    if (!browser) return t.skip();
    const drawer = `<div style="position:fixed;inset:0;display:flex;justify-content:flex-end;background:rgba(15,23,42,.3)"><aside style="width:420px;background:#fff"></aside></div>`;
    const root = await extract(app(drawer));
    const overlay = root.children!.at(-1)!;
    expect(overlay.absolute).toEqual({ x: 0, y: 0 });
    expect([overlay.width, overlay.height]).toEqual([1728, 1080]);
    expect(overlay.children![0]!.at).toEqual({ x: 1308, y: 0 });
    // Not left inside the panel as well.
    const inPanel = (n: IRNode): boolean =>
      (n.children ?? []).some((c) => c !== overlay && (c.absolute?.x ?? 0) < 0) || (n.children ?? []).some(inPanel);
    expect(inPanel(root)).toBe(false);
  });

  it("a modal over a page taller than the window covers the whole page, centred on it", async (t) => {
    if (!browser) return t.skip();
    const modal = `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.4)"><div style="width:600px;height:400px;background:#fff"></div></div>`;
    const root = await extract(app(modal, 2400));
    const overlay = root.children!.at(-1)!;
    expect([overlay.width, overlay.height]).toEqual([1728, 2400]);
    expect(overlay.children![0]!.at).toEqual({ x: 564, y: 1000 });
  });

  it("a small fixed badge doesn't grow the window", async (t) => {
    if (!browser) return t.skip();
    await extract(app(`<div style="position:fixed;right:16px;bottom:16px;width:56px;height:56px"></div>`, 2400));
    expect(page.viewportSize()!.height).toBe(1080);
  });
});
