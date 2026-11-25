// The page's screenshot shown beside its Live page, in a real browser: the story's root as drawn, all of it
// (a page taller than the window too), as JPEG. Skipped without Chromium.
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { screenshot } from "./render.js";

let browser: Browser | null = null;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch().catch(() => null);
  if (browser) page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
});
afterAll(async () => {
  await browser?.close();
});

describe("page screenshots", () => {
  it("is the story's root, all of it, even taller than the window", async (t) => {
    if (!browser) return t.skip();
    await page.setContent(
      `<body style="margin:0"><div id="storybook-root" style="padding:16px"><div style="width:900px;height:2400px;background:linear-gradient(#f00,#00f)"></div></div></body>`,
    );
    const shot = (await screenshot(page))!;
    expect([shot.w, shot.h]).toEqual([900, 2400]);
    const bytes = Buffer.from(shot.jpeg, "base64");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    // The real pixel size: decode the JPEG's frame header (SOF0/SOF2).
    let i = 2;
    while (i < bytes.length && !(bytes[i] === 0xff && (bytes[i + 1] === 0xc0 || bytes[i + 1] === 0xc2))) i += 2 + bytes.readUInt16BE(i + 2);
    expect([bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)]).toEqual([900, 2400]);
  });

  it("prefers the CoDesignFlo container's root, and gives nothing for an empty story", async (t) => {
    if (!browser) return t.skip();
    await page.setContent(
      `<body style="margin:0"><div id="storybook-root"><div style="padding:40px"><div data-cdf-container><section style="width:300px;height:120px;background:#0a0"></section></div></div></div></body>`,
    );
    expect(await screenshot(page)).toMatchObject({ w: 300, h: 120 });
    await page.setContent(`<body style="margin:0"><div id="storybook-root"></div></body>`);
    expect(await screenshot(page)).toBeNull();
  });

  it("shows the page as it first appears: a sticky sidebar at the top, not where scrolling left it", async (t) => {
    if (!browser) return t.skip();
    await page.setContent(
      `<body style="margin:0"><div id="storybook-root"><div style="display:flex;width:900px"><aside style="position:sticky;top:0;align-self:flex-start;width:200px;height:100vh;background:#000"></aside><main style="width:700px;height:2400px;background:#fff"></main></div></div></body>`,
    );
    const shot = (await screenshot(page))!;
    // Read the pixels back in the browser: the sidebar's black is at the top left, white below it.
    const at = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${src}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return [g.getImageData(100, 20, 1, 1).data[0], g.getImageData(100, 1500, 1, 1).data[0]];
    }, shot.jpeg);
    expect(at[0]).toBeLessThan(40);
    expect(at[1]).toBeGreaterThan(215);
  });
});
