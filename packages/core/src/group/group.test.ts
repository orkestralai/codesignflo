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
    const withoutItems = (c: Expected) => ({ ...c, items: undefined, design: undefined });
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

describe("colours with their opacity", () => {
  it("a fill at 14% of a variable, and a navy at 40%, say so (not the solid colour)", () => {
    const paint = (color: { r: number; g: number; b: number }, opacity: number, bound?: string) => ({
      type: "SOLID",
      color,
      opacity,
      visible: true,
      ...(bound ? { boundVariables: { color: bound } } : {}),
    });
    const item = {
      id: "i1",
      kind: "token",
      op: "change",
      target: "V[a=1]|c/a=1/price",
      path: "",
      prop: "fills",
      from: [paint({ r: 0.0431, g: 0.0627, b: 0.1255 }, 0.4)],
      to: [paint({ r: 1, g: 0.2196, b: 0.2353 }, 0.14, "var(Tokens/color/brand/red)")],
      match: "key",
    } as never;
    const [c] = group([item], {}, ["a=1"]);
    expect(c?.from).toBe("#0b1020 at 40% opacity");
    expect(c?.to).toBe("var(--color-brand-red) at 14% opacity");
  });
});

describe("nothing lost between the design and the developer", () => {
  const paint = (r: number, g: number, b: number, opacity: number, bound?: string) => ({
    type: "SOLID",
    color: { r, g, b },
    opacity,
    visible: true,
    ...(bound ? { boundVariables: { color: bound } } : {}),
  });
  const pill = (fill: unknown) => ({
    name: "c",
    type: "COMPONENT_SET",
    ds: { k: "c" },
    children: [
      {
        name: "a=1",
        type: "COMPONENT",
        ds: { k: "c/a=1" },
        variantProperties: { a: "1" },
        children: [{ name: "price", type: "FRAME", ds: { k: "c/a=1/price" }, fills: [fill], cornerRadius: 999, strokes: [], children: [] }],
      },
    ],
  });
  const base = pill(paint(0.0431, 0.0627, 0.1255, 0.4)) as never;
  const design = pill(paint(1, 0.2196, 0.2353, 0.14, "var(Tokens/color/brand/red)")) as never;

  it("each change carries the design's value whole, and its layer's other properties", async () => {
    const { describeChange } = await import("../apply/instructions.js");
    const { layerContext } = await import("./group.js");
    const [c] = group(diff(base, design), {}, ["a=1"]);
    const line = describeChange(c!);
    expect(line).toContain("var(--color-brand-red) at 14% opacity");
    expect(line).toContain("as designed, exactly:");
    expect(line).toContain('"opacity":0.14');
    expect(line).toContain('"color":"var(Tokens/color/brand/red)"');
    // On a real Figma snapshot: each changed layer found, with its own properties and without its layers.
    const s6Base = fixture<Raw>("s6/base.json");
    const s6Design = fixture<Raw>("s6/proposal.json");
    const layers = [...new Set(group(diff(s6Base, s6Design), {}, ["x"]).map((x) => x.layer))].filter((l) => l !== "(root)");
    const ctx = layerContext(s6Design, layers);
    expect(Object.keys(ctx).sort()).toEqual(layers.filter((l) => !l.includes(" > ")).sort());
    for (const props of Object.values(ctx)) {
      expect(props).not.toHaveProperty("children");
      expect(props).toHaveProperty("type");
    }
  });

  it("where the code drew something else, the check says what and what the design wants", async () => {
    const { merge } = await import("../merge/merge.js");
    const { conflictsOf } = await import("./group.js");
    // The code went to the token, solid: not the 14% tint.
    const code = pill(paint(1, 0.2196, 0.2353, 1, "var(Tokens/color/brand/red)")) as never;
    expect(conflictsOf(merge(base, design, code))).toMatchObject([
      { prop: "fills", design: "var(--color-brand-red) at 14% opacity", code: "var(--color-brand-red)" },
    ]);
  });
});

describe("a page's changes", () => {
  it("apply to the page (no 'ONLY when' with nothing after it: a page has no versions)", () => {
    const item = {
      id: "i1",
      kind: "style",
      op: "change",
      target: "screen:pages.p/content/price",
      path: "",
      prop: "opacity",
      from: 1,
      to: 0.5,
      match: "key",
    } as never;
    expect(group([item], {}, [])[0]?.variants).toBe("all");
  });
});
