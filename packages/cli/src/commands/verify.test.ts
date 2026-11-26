import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { compare, ssim, trends, type VerifyRow } from "./verify.js";

/** A w×h image filled with one colour (alpha 0–255). */
const solid = (w: number, h: number, [r, g, b, a]: [number, number, number, number]) => {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) p.data.set([r, g, b, a], i * 4);
  return p;
};
const paint = (p: PNG, x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) p.data.set([...c, 255], (y * p.width + x) * 4);
  return p;
};

describe("verify compare", () => {
  it("structure: the same picture is 1, a box moved by a few pixels is clearly less, a faint tint barely changes it", () => {
    const base = () => paint(solid(64, 64, [255, 255, 255, 255]), 16, 16, 40, 40, [30, 30, 30]);
    expect(compare(base(), base()).ssim).toBe(1);
    const moved = paint(solid(64, 64, [255, 255, 255, 255]), 22, 16, 46, 40, [30, 30, 30]);
    expect(compare(base(), moved).ssim).toBeLessThan(0.9);
    const tinted = paint(solid(64, 64, [250, 250, 250, 255]), 16, 16, 40, 40, [34, 34, 34]);
    expect(compare(base(), tinted).ssim).toBeGreaterThan(0.97);
  });
  it("windows that are mostly text are left out of the structure", () => {
    const a = paint(solid(16, 16, [255, 255, 255, 255]), 0, 0, 16, 16, [0, 0, 0]);
    const b = solid(16, 16, [255, 255, 255, 255]);
    expect(ssim(a.data, b.data, 16, 16, new Uint8Array(256).fill(1))).toBe(1);
  });
  it("a transparent Figma background equals the browser's white", () => {
    expect(compare(solid(20, 10, [255, 255, 255, 255]), solid(20, 10, [0, 0, 0, 0])).mismatch).toBe(0);
  });
  it("differences inside text boxes are reported apart and don't count as mismatch", () => {
    const browser = paint(solid(40, 20, [255, 255, 255, 255]), 5, 5, 15, 12, [0, 0, 0]);
    const figma = paint(solid(40, 20, [255, 255, 255, 255]), 6, 5, 16, 12, [0, 0, 0]);
    const r = compare(browser, figma, [{ x: 5, y: 5, width: 10, height: 7 }]);
    expect(r.mismatch).toBe(0);
    expect(r.textMismatch).toBeGreaterThan(0);
  });
  it("a real difference outside text counts", () => {
    const browser = solid(20, 20, [255, 255, 255, 255]);
    const figma = paint(solid(20, 20, [255, 255, 255, 255]), 0, 0, 20, 5, [79, 70, 229]);
    expect(compare(browser, figma).mismatch).toBeCloseTo(0.25, 2);
  });
  it("a missing button on a big page is under 3% overall, but its region shows it", () => {
    // 600×400 page; a 60×32 button drawn in the browser, missing in Figma: 0.8% of the page.
    const browser = paint(solid(600, 400, [255, 255, 255, 255]), 400, 300, 460, 332, [37, 99, 235]);
    const figma = solid(600, 400, [255, 255, 255, 255]);
    const r = compare(browser, figma);
    expect(r.mismatch).toBeLessThan(0.03);
    expect(r.hotspots).toHaveLength(1);
    const [hs] = r.hotspots;
    // The region covers the button (whole 32 px cells around it), and most of it differs.
    expect(hs!.x).toBeLessThanOrEqual(400);
    expect(hs!.y).toBeLessThanOrEqual(300);
    expect(hs!.x + hs!.width).toBeGreaterThanOrEqual(460);
    expect(hs!.share).toBeGreaterThan(0.3);
    // Boxed in red on the difference panel.
    const left = 2 * 600 + 32;
    const i = (hs!.y * r.image.width + left + hs!.x + 5) * 4;
    expect([r.image.data[i], r.image.data[i + 1], r.image.data[i + 2]]).toEqual([220, 38, 38]);
  });
  it("scattered specks make no region; neighbouring hot cells join into one", () => {
    const specks = solid(320, 320, [255, 255, 255, 255]);
    for (let k = 0; k < 40; k++) paint(specks, (k * 37) % 316, (k * 53) % 316, ((k * 37) % 316) + 2, ((k * 53) % 316) + 2, [0, 0, 0]);
    expect(compare(solid(320, 320, [255, 255, 255, 255]), specks).hotspots).toEqual([]);
    const band = paint(solid(320, 320, [255, 255, 255, 255]), 0, 64, 320, 96, [0, 0, 0]);
    const r = compare(solid(320, 320, [255, 255, 255, 255]), band);
    expect(r.hotspots).toHaveLength(1);
    expect(r.hotspots[0]).toMatchObject({ x: 0, y: 64, width: 320, height: 32 });
  });
  it("differences inside text make no region", () => {
    const browser = paint(solid(200, 100, [255, 255, 255, 255]), 10, 10, 120, 40, [0, 0, 0]);
    const figma = solid(200, 100, [255, 255, 255, 255]);
    expect(compare(browser, figma, [{ x: 10, y: 10, width: 110, height: 30 }]).hotspots).toEqual([]);
  });

  it("against the last verify: newly flagged, more pixels or a worse region is worse; the reverse is better", () => {
    const row = (variant: string, mismatch: number | null, flagged: boolean, region = 0): VerifyRow => ({
      component: "card",
      variant,
      story: "s",
      browser: { width: 10, height: 10 },
      figma: mismatch === null ? null : { width: 10, height: 10 },
      mismatch,
      flagged,
      ...(region ? { hotspots: [{ x: 0, y: 0, width: 32, height: 32, share: region }] } : {}),
    });
    const before = [row("a", 0.001, false), row("b", 0.05, true), row("c", 0.01, false, 0.1), row("d", 0.01, false), row("e", null, true)];
    const now = [
      row("a", 0.002, true),
      row("b", 0.01, false),
      row("c", 0.01, false, 0.5),
      row("d", 0.012, false),
      row("e", 0.01, false),
      row("f", 0.2, true),
    ];
    expect(trends(before, now)).toEqual({ worse: 2, better: 1 });
    expect(now.map((r) => r.trend)).toEqual(["worse", "better", "worse", undefined, undefined, undefined]);
  });
});
