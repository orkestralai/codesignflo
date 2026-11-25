// fullHeight in a real browser: an app shell 100vh tall grows until its scrolling panel shows everything; a list
// capped at a fixed height and a page that grows with the window don't grow it. Skipped without Chromium.
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { growToFit } from "./render.js";

let browser: Browser | null = null;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch().catch(() => null);
  if (browser) page = await browser.newPage({ viewport: { width: 1728, height: 1080 } });
});
afterAll(async () => {
  await browser?.close();
});

async function grown(html: string): Promise<number> {
  await page.setViewportSize({ width: 1728, height: 1080 });
  await page.setContent(`<body style="margin:0">${html}</body>`);
  await growToFit(page, 1728, 1080);
  return page.viewportSize()!.height;
}

describe("fullHeight", () => {
  it("grows a 100vh shell until its main panel shows everything", async (t) => {
    if (!browser) return t.skip();
    const shell = `<div style="height:100vh;display:flex;flex-direction:column"><header style="height:64px"></header><main style="flex:1;overflow-y:auto"><div style="height:2400px"></div></main></div>`;
    expect(await grown(shell)).toBe(64 + 2400);
    expect(await page.evaluate(() => document.querySelector("main")!.scrollHeight - document.querySelector("main")!.clientHeight)).toBe(0);
  });

  it("doesn't grow for a list capped at a fixed height", async (t) => {
    if (!browser) return t.skip();
    expect(
      await grown(`<div style="max-height:272px;overflow-y:auto"><div style="height:406px"></div></div><div style="height:2000px"></div>`),
    ).toBe(1080);
  });

  it("doesn't grow a page that grows with the window (its full height is read anyway)", async (t) => {
    if (!browser) return t.skip();
    const page = `<div style="min-height:calc(100vh + 500px)"></div><div style="height:200px;overflow:auto"><div style="height:300px"></div></div>`;
    expect(await grown(page)).toBe(1080);
  });
});
