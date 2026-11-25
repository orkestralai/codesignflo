import { diff, type Raw } from "@codesignflo/core";
import { describe, expect, it } from "vitest";
import { comparable } from "./sync.js";

const text = (name: string, extra: Record<string, unknown> = {}): Raw => ({ type: "TEXT", name, characters: name, ...extra });

describe("comparable (new design vs what was built from it)", () => {
  const design: Raw = {
    type: "FRAME",
    name: "Promo banner",
    constraints: { horizontal: "MIN", vertical: "MIN" },
    layout: { mode: "VERTICAL", itemSpacing: 8, strokesIncludedInLayout: true },
    children: [text("title"), text("description")],
  };
  const built = (spacing: number): Raw => ({
    type: "COMPONENT_SET",
    name: "promo-banner",
    k: "promo-banner",
    children: [
      {
        type: "COMPONENT",
        name: "story=default",
        k: "promo-banner/story=default",
        variantProperties: { story: "default" },
        layoutSizingHorizontal: "FIXED",
        layout: { mode: "VERTICAL", itemSpacing: spacing },
        children: [text("title", { k: "title" }), text("description", { k: "description" })],
      },
    ],
  });

  it("a frame built exactly as designed has no differences (set wrapper, keys and placement aside)", () => {
    expect(diff(...comparable(design, built(8)))).toEqual([]);
  });
  it("real differences still show", () => {
    expect(diff(...comparable(design, built(12))).map((i) => i.prop)).toEqual(["layout.itemSpacing"]);
  });
});
