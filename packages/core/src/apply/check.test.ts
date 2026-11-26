import { describe, expect, it } from "vitest";
import { colourSeverity, deltaE, hexToRgba, type PropDifference, propDifferenceLine, worstFirst } from "./check.js";

const c = (hex: string) => hexToRgba(hex)!;

describe("colours compared as people see them", () => {
  it("the same colour, and rounding, look the same", () => {
    expect(deltaE(c("#3b82f6"), c("#3b82f6"))).toBe(0);
    expect(deltaE(c("#3b82f6"), c("#3b83f6"))).toBeLessThan(1);
    expect(colourSeverity(deltaE(c("#3b82f6"), c("#3b83f6")))).toBe(0);
  });
  it("black and white are as far apart as it gets", () => {
    expect(deltaE(c("#000000"), c("#ffffff"))).toBeCloseTo(100, 0);
    expect(colourSeverity(100)).toBe(3);
  });
  it("a shade off is noticeable, not far off", () => {
    const dE = deltaE(c("#1f2937"), c("#111827"));
    expect(dE).toBeGreaterThan(2.3);
    expect(colourSeverity(dE)).toBeLessThan(3);
  });
  it("alpha counts as much as it shows over white", () => {
    expect(deltaE(c("#00000000"), c("#ffffff"))).toBeLessThan(0.01);
    expect(deltaE(c("#000000"), c("#00000080"))).toBeGreaterThan(20);
  });
  it("only #rrggbb and #rrggbbaa are read", () => {
    expect(hexToRgba("#fff")).toBeNull();
    expect(hexToRgba("gradient:{}")).toBeNull();
    expect(hexToRgba("#11223344")).toEqual({ r: 0x11 / 255, g: 0x22 / 255, b: 0x33 / 255, a: 0x44 / 255 });
  });
});

describe("reporting property differences", () => {
  const d = (k: string, prop: string, severity: 1 | 2 | 3): PropDifference => ({ k, prop, figma: "a", app: "b", severity });
  it("most visible first, then deeper layers, one per layer and property", () => {
    const out = worstFirst([d("c/x", "padding left", 1), d("c/x/y", "colour", 2), d("c/z", "text", 3), d("c/x/y", "colour", 2)]);
    expect(out.map((x) => `${x.k} ${x.prop}`)).toEqual(["c/z text", "c/x/y colour", "c/x padding left"]);
  });
  it("the same layer off the same way in several places is one cause, reported once", () => {
    const out = worstFirst([
      d("page/card#0/title", "font", 2),
      d("page/card#1/title", "font", 2),
      d("page/card#2/title", "font", 2),
      d("page/card#0/price", "colour", 1),
    ]);
    expect(out.map((x) => [x.k, x.alike])).toEqual([
      ["page/card#0/title", 2],
      ["page/card#0/price", undefined],
    ]);
    expect(propDifferenceLine("page", out[0]!)).toMatch(/— and 2 more like it$/);
  });
  it("reads as the layer's path, both values and the reason", () => {
    expect(
      propDifferenceLine("card", { k: "card/body/price", prop: "colour", figma: "#1f2937", app: "#111827", severity: 2, why: "ΔE 6.1" }),
    ).toBe("body › price: colour #1f2937 in Figma, #111827 in the app (ΔE 6.1)");
    expect(propDifferenceLine("card", { k: "card", prop: "opacity", figma: "1", app: "0.5", severity: 2 })).toBe(
      "(the whole thing): opacity 1 in Figma, 0.5 in the app",
    );
  });
});

describe("the look as a whole", () => {
  it("counts gradients, glows, blurs, large corners, off-grid spacing and columns the same way on both sides", async () => {
    const { countLook, noSignals, signalDifferences } = await import("./check.js");
    const design = noSignals();
    for (let i = 0; i < 3; i++)
      countLook(design, { fills: ["GRADIENT_LINEAR"], effects: [{ type: "DROP_SHADOW", radius: 24, offset: { x: 0, y: 0 } }], radius: 24 });
    countLook(design, { spacing: [8, 16, 24, 12, 4], columns: 3 });
    const app = noSignals();
    countLook(app, { fills: ["#ffffff"], effects: [{ type: "DROP_SHADOW", radius: 4, offset: { x: 0, y: 2 } }], radius: 8 });
    countLook(app, { spacing: [7, 15, 22, 13, 8], columns: 4 });
    expect(signalDifferences(design, app)).toEqual([
      "gradients 3 in the design, 0 in the app",
      "glows 3 in the design, 0 in the app",
      "large corners 3 in the design, 0 in the app",
      "spacing off the 4 px grid 0% in the design, 80% in the app",
      "columns 3 in the design, 4 in the app",
    ]);
    expect(signalDifferences(design, design)).toEqual([]);
  });
});
