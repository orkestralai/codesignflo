// Pictures as the browser draws them, in a real browser: CSS backgrounds (pictures, gradients, stacks), lazy
// pictures, and pictures from another site the page can't read itself. Skipped without Chromium.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IRNode } from "@codesignflo/core";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractInPage } from "./extract-in-page.js";
import { extractPage, picturesLoadedInPage } from "./render.js";

// A 2×2 PNG, solid blue.
const BLUE = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNgYPj/n4GBgYEBAA0ABAEEkqgFAAAAAElFTkSuQmCC";

let browser: Browser | null = null;
let page: Page;
let app: Server;
let cdn: Server;
let appUrl = "";
let cdnUrl = "";
const listen = (s: Server) =>
  new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
beforeAll(async () => {
  browser = await chromium.launch().catch(() => null);
  if (browser) page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  // The picture's site: no CORS headers, so the page can show the picture but not read it.
  cdn = createServer((_, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from(BLUE, "base64"));
  });
  cdnUrl = await listen(cdn);
  app = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><body style='margin:0'><div id='storybook-root'></div></body>");
  });
  appUrl = await listen(app);
});
afterAll(async () => {
  await browser?.close();
  app?.close();
  cdn?.close();
});

const find = (n: IRNode, f: (x: IRNode) => boolean): IRNode | undefined =>
  f(n) ? n : (n.children ?? []).reduce<IRNode | undefined>((a, c) => a ?? find(c, f), undefined);
async function show(body: string) {
  await page.goto(appUrl);
  await page.evaluate((b) => {
    document.querySelector("#storybook-root")!.innerHTML = `<div style="width:400px">${b}</div>`;
  }, body);
  await page.evaluate(picturesLoadedInPage);
}
/** The colour at (x, y) of a PNG (base64), read in the page. */
const pixel = (png: string, x: number, y: number) =>
  page.evaluate(
    async ([png, x, y]) => {
      const i = new Image();
      i.src = `data:image/png;base64,${png}`;
      await i.decode();
      const c = document.createElement("canvas");
      c.width = i.width;
      c.height = i.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(i, 0, 0);
      return Array.from(ctx.getImageData(x as number, y as number, 1, 1).data);
    },
    [png, x, y] as const,
  );

describe("backgrounds", () => {
  it("one linear gradient stays a gradient; stacks, radial gradients and pictures are drawn", async (t) => {
    if (!browser) return t.skip();
    await show(`<div data-cdf="One" style="height:20px;background:linear-gradient(red, blue)"></div>
      <div data-cdf="Two" style="height:20px;background:linear-gradient(red, red) top / 100% 50% no-repeat, radial-gradient(circle, #00ff00, #00ff00)"></div>`);
    const root = await page.evaluate(extractInPage);
    const one = find(root, (x) => x.name === "One")!;
    expect(one.gradient).toBeTruthy();
    expect(one.background).toBeUndefined();
    const two = find(root, (x) => x.name === "Two")!;
    expect(two.gradient).toBeUndefined();
    // Red on top (the first layer, its top half), green below: at × 2.
    expect((await pixel(two.background!.png!, 10, 5)).slice(0, 3)).toEqual([255, 0, 0]);
    expect((await pixel(two.background!.png!, 10, 35)).slice(0, 3)).toEqual([0, 255, 0]);
  });
  it("a cover picture from another site is drawn, fetched by the CLI", async (t) => {
    if (!browser) return t.skip();
    await show(`<div data-cdf="Hero" style="height:40px;background:#fff url('${cdnUrl}/cover.png') center / cover"></div>
      <img data-cdf="Avatar" width="20" height="20" src="${cdnUrl}/avatar.png">`);
    // The page alone can't read it: no background picture, the avatar a placeholder.
    const before = await page.evaluate(extractInPage);
    expect(find(before, (x) => x.name === "Hero")!.background).toBeUndefined();
    expect(find(before, (x) => x.name === "Avatar")!.image).toBeUndefined();
    const root = await extractPage(page);
    const hero = find(root, (x) => x.name === "Hero")!;
    expect(hero.fill?.value).toBe("#ffffff");
    expect((await pixel(hero.background!.png!, 100, 40)).slice(0, 3)).toEqual([0, 0, 255]);
    expect(find(root, (x) => x.name === "Avatar")!.image?.png).toBeTruthy();
  });
  it("a video without a frame yet shows its poster, from another site too", async (t) => {
    if (!browser) return t.skip();
    await show(`<video data-cdf="Clip" width="40" height="20" poster="${cdnUrl}/poster.png"></video>`);
    const root = await extractPage(page);
    const clip = find(root, (x) => x.name === "Clip")!;
    expect(clip.type).toBe("IMAGE");
    // Contained, as the browser draws a poster: blue in the middle, nothing at the sides (2:1 box, square picture).
    expect((await pixel(clip.image!.png!, 40, 20)).slice(0, 3)).toEqual([0, 0, 255]);
    expect((await pixel(clip.image!.png!, 2, 20))[3]).toBe(0);
  });
  it("a lazy picture far down the page is loaded", async (t) => {
    if (!browser) return t.skip();
    await page.goto(appUrl);
    await page.evaluate((src) => {
      document.querySelector("#storybook-root")!.innerHTML =
        `<div style="height:3000px"></div><img id="lazy" loading="lazy" width="10" height="10" data-src="${src}">`;
    }, `data:image/png;base64,${BLUE}`);
    await page.evaluate(picturesLoadedInPage);
    expect(await page.evaluate(() => (document.querySelector("#lazy") as HTMLImageElement).naturalWidth)).toBe(2);
  });
});
