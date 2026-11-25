import { describe, expect, it } from "vitest";
import { diff } from "../diff/diff.js";
import type { Raw } from "../snapshot/canonical.js";
import { fixture } from "../test-fixtures.js";
import { changeKey, cssVar, group, layerOf } from "./group.js";

describe("group (golden: spike S6, real Figma proposal on the Live ProductCard)", () => {
  const base = fixture<Raw>("s6/base.json");
  const items = diff(base, fixture<Raw>("s6/proposal.json"));
  const variants = (base.children ?? []).map((v) =>
    Object.entries(v.variantProperties as Record<string, string>)
      .sort()
      .map(([k, x]) => `${k}=${x}`)
      .join(","),
  );
  const changes = group(items, fixture("s4/tokens.json"), variants);

  it("12 items → the same 4 code changes as the spike (ids, layers, values, all variants)", () => {
    // Item ids differ from the spike (pure-JS hash instead of sha256), so compare everything else.
    type Expected = {
      id: string;
      layer: string;
      prop: string;
      kind: string;
      from: string;
      to: string;
      variants: unknown;
      items?: string[];
    };
    const withoutItems = (c: Expected) => ({ ...c, items: undefined });
    expect(changes.map(withoutItems)).toEqual(fixture<Expected[]>("s6/changes.json").map(withoutItems));
    expect(changes.every((c) => c.items.length === 3)).toBe(true);
  });

  it("translates tokens and layers", () => {
    expect(cssVar("var(Tokens/color/text/primary)")).toBe("var(--color-text-primary)");
    expect(layerOf("V[Sale=false,Title=short]|card.product/Sale=false, Title=short/body/price")).toBe("body/price");
  });
});

describe("changeKey", () => {
  it("tells apart the same property changed differently in different variants (M6)", () => {
    const a = changeKey({ layer: "body/price", prop: "fills", variants: ["onSale=true"] });
    const b = changeKey({ layer: "body/price", prop: "fills", variants: ["onSale=false"] });
    expect(a).not.toBe(b);
    expect(changeKey({ layer: "body", prop: "padding", variants: "all" })).toBe("body|padding");
  });
});

describe("group: dropped bindings", () => {
  const item = (to: unknown, toBound?: Record<string, unknown>) =>
    ({
      id: "i1",
      kind: "token",
      op: "change",
      target: "V[a=1]|c/a=1/header",
      path: "",
      prop: "layout.itemSpacing",
      from: 8,
      to,
      fromBound: { itemSpacing: "var(Tokens/space/2)" },
      ...(toBound ? { toBound } : {}),
      match: "key",
    }) as never;
  it("same value, binding removed → no change", () => expect(group([item(8)], {}, ["a=1"])).toEqual([]));
  it("different value → a change", () => expect(group([item(12)], {}, ["a=1"])).toHaveLength(1));
  it("rebound to another token → a change", () =>
    expect(group([item(8, { itemSpacing: "var(Tokens/space/3)" })], {}, ["a=1"])).toHaveLength(1));
});

describe("designer variables that aren't project tokens", () => {
  it("name the token they become", async () => {
    const { tokenForVariable } = await import("./group.js");
    expect(tokenForVariable("Colors/Accents/Red", true)).toBe("color/accents/red");
    expect(tokenForVariable("Spacing/Gutter Large", false)).toBe("gutter-large");
  });
  it("count as that token once it exists (verification)", async () => {
    const { adoptForeignVariables } = await import("./group.js");
    const tree = { fills: [{ boundVariables: { color: "var(Colors/Accents/Red)" } }], other: "var(Colors/Accents/Blue)" };
    expect(adoptForeignVariables(tree, new Set(["color/accents/red"]))).toEqual({
      fills: [{ boundVariables: { color: "var(Tokens/color/accents/red)" } }],
      other: "var(Colors/Accents/Blue)",
    });
  });
});
