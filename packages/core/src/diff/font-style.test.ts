import { describe, expect, it } from "vitest";
import type { Raw } from "../snapshot/canonical.js";
import { diff, fontStyle } from "./diff.js";

describe("font styles compare by meaning, not spelling", () => {
  it("one spelling per style", () => {
    expect(["SemiBold", "Semi Bold", "semibold", "Semi-Bold"].map(fontStyle)).toEqual(Array(4).fill("Semi Bold"));
    expect(fontStyle("ExtraBoldItalic")).toBe("Extra Bold Italic");
    expect(fontStyle("Italic")).toBe("Italic");
  });
  it("the same font spelled differently is no difference; another weight is", () => {
    const t = (style: string): Raw => ({ type: "TEXT", name: "t", k: "t", fontName: { family: "Hanken Grotesk", style } });
    expect(diff(t("Semi Bold"), t("SemiBold"))).toEqual([]);
    expect(diff(t("Semi Bold"), t("Bold")).map((i) => i.prop)).toEqual(["fontName"]);
  });
});
