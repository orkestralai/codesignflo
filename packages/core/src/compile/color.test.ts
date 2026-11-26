import { describe, expect, it } from "vitest";
import { parseTokenColor } from "./color.js";

const r4 = (c: ReturnType<typeof parseTokenColor>) =>
  c && Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));

describe("parseTokenColor", () => {
  it("reads hex in every length", () => {
    expect(r4(parseTokenColor("#0f766e"))).toEqual({ r: 0.059, g: 0.463, b: 0.431, a: 1 });
    expect(r4(parseTokenColor("#fff"))).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(r4(parseTokenColor("#0008"))).toEqual({ r: 0, g: 0, b: 0, a: 0.533 });
    expect(r4(parseTokenColor("#00000080"))).toEqual({ r: 0, g: 0, b: 0, a: 0.502 });
    expect(r4(parseTokenColor(" #FFFFFF "))).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  it("reads rgb() and rgba(), comma and space syntax", () => {
    expect(r4(parseTokenColor("rgba(15, 23, 42, 0.5)"))).toEqual({ r: 0.059, g: 0.09, b: 0.165, a: 0.5 });
    expect(r4(parseTokenColor("rgb(255, 0, 0)"))).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(r4(parseTokenColor("rgb(255 0 0 / 25%)"))).toEqual({ r: 1, g: 0, b: 0, a: 0.25 });
    expect(r4(parseTokenColor("rgb(100% 50% 0%)"))).toEqual({ r: 1, g: 0.5, b: 0, a: 1 });
  });

  it("reads DTCG colour objects in sRGB", () => {
    expect(r4(parseTokenColor({ colorSpace: "srgb", components: [1, 0.5, 0], alpha: 0.4 }))).toEqual({ r: 1, g: 0.5, b: 0, a: 0.4 });
    expect(r4(parseTokenColor({ colorSpace: "display-p3", components: [1, 0, 0], hex: "#ff0000" }))).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });

  it("returns null for what it can't read, never NaN", () => {
    for (const bad of [
      "red",
      "hsl(0 100% 50%)",
      "#12",
      "#ggg",
      "rgba(1, 2)",
      "rgb(1 2 3 4 / 5)",
      "",
      null,
      3,
      { colorSpace: "oklch", components: [1, 2, 3] },
    ]) {
      expect(parseTokenColor(bad)).toBeNull();
    }
  });
});
