import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { compare } from "./verify.js";

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
});
