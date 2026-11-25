import { describe, expect, it } from "vitest";
import type { SpecNode } from "../compile/compile.js";
import { diff } from "../diff/diff.js";
import type { Raw } from "../snapshot/canonical.js";
import { predictLive } from "./predict.js";

// Live as Figma reads it back (canonical), and the compiled code for the same component.
const live: Raw = {
  type: "COMPONENT_SET",
  name: "Row",
  k: "row",
  children: [
    {
      type: "COMPONENT",
      name: "story=default",
      k: "row/story=default",
      variantProperties: { story: "default" },
      boundVariables: { paddingTop: ["var(Tokens/space/3)"], paddingBottom: ["var(Tokens/space/3)"] },
      layout: { mode: "HORIZONTAL", itemSpacing: 8, paddingTop: 12, paddingBottom: 12, paddingLeft: 0, paddingRight: 0 },
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "HUG",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "AUTO",
      children: [
        {
          type: "TEXT",
          name: "title",
          k: "row/story=default/title",
          characters: "Tote",
          fontSize: 14,
          fills: [{ color: { b: 0, g: 0, r: 0 }, opacity: 1, type: "SOLID", visible: true }],
        },
      ],
    },
  ],
};
const spec = (padding: number, token: string, color = "#000000", extra: SpecNode[] = []): SpecNode => ({
  k: "row",
  type: "COMPONENT_SET",
  name: "Row",
  props: {},
  children: [
    {
      k: "row/story=default",
      type: "COMPONENT",
      name: "story=default",
      props: { layoutMode: "HORIZONTAL", itemSpacing: 8, paddingTop: padding, paddingBottom: padding, paddingLeft: 0, paddingRight: 0 },
      bind: { paddingTop: token, paddingBottom: token },
      children: [
        { k: "row/story=default/title", type: "TEXT", name: "title", props: { characters: "Tote", fontSize: 14, fills: [color] } },
        ...extra,
      ],
    },
  ],
});

describe("predictLive (Live after an update, without Figma)", () => {
  it("the same code predicts the same Live", () => {
    const p = predictLive(live, spec(12, "space/3"));
    expect(diff(live, p.tree)).toEqual([]);
    expect(p.exact).toBe(true);
  });

  it("a padding token changed in code shows up as the designer would see it in Live", () => {
    const p = predictLive(live, spec(16, "space/4", "#ff0000"));
    const changed = diff(live, p.tree).map((i) => `${i.prop}`);
    expect(changed).toEqual(["padding", "fills"]);
    const v = (p.tree.children![0] as Raw).boundVariables as Record<string, string[]>;
    expect(v.paddingTop).toEqual(["var(Tokens/space/4)"]);
  });

  it("layers added in code can't be predicted exactly", () => {
    const badge: SpecNode = { k: "row/story=default/badge", type: "TEXT", name: "badge", props: { characters: "Sale" } };
    expect(predictLive(live, spec(12, "space/3", "#000000", [badge])).exact).toBe(false);
  });
});
