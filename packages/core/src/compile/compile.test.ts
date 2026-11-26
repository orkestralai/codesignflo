import { describe, expect, it } from "vitest";
import { fixture, fixtureDir } from "../test-fixtures.js";
import { compile, compileScreens, type Registry, splitExamples, tokenNames } from "./compile.js";
import type { IRStory } from "./ir.js";

const registry = fixture<Registry & { screens: Record<string, string> }>("s4/registry.json");
const irs = new Map(
  fixtureDir("s4/ir").map((f) => {
    const ir = fixture<IRStory>(`s4/ir/${f}`);
    return [ir.story, ir] as const;
  }),
);
const tokens = tokenNames(fixture("s4/tokens.json"));
const json = (v: unknown) => JSON.stringify(v, null, 2);

describe("compile (golden: spike S4/S7 compiler on the demo app's IR)", () => {
  it("component sets are byte-identical to the golden output (spike compiler + data-text marks)", () => {
    expect(json(compile(registry, irs, tokens))).toBe(json(fixture("s4/spec.golden.json")));
  });

  it("screens (Home page) are byte-identical, with the right instance variants and coverage", () => {
    const screens = compileScreens(registry, irs, tokens);
    expect(json(screens)).toBe(json(fixture("s4/screens.golden.json")));
    expect(screens[0]?.coverage).toMatchObject({ nodes: 34, inInstances: 28 });
  });

  it("orders component sets after the sets they use as instances", () => {
    const order = compile(registry, irs, tokens).map((x) => x.k);
    expect(order.indexOf("card.product")).toBeGreaterThan(order.indexOf("button"));
    expect(order.indexOf("card.product")).toBeGreaterThan(order.indexOf("badge"));
  });

  it("is deterministic", () => {
    expect(json(compile(registry, irs, tokens))).toBe(json(compile(registry, irs, tokens)));
  });

  it("maps CSS custom properties to variable names", () => {
    expect(tokens.get("space-2")).toBe("space/2");
    expect(tokens.get("color-status-sale-surface")).toBe("color/status/sale-surface");
  });
});

describe("settleSizing (sizing Figma can express)", () => {
  it("a fill child along a hugging parent's main axis becomes fixed; all-fill children fix the parent's cross axis", async () => {
    const { settleSizing } = await import("./compile.js");
    const pad = { value: 0 };
    const layout = (direction: "HORIZONTAL" | "VERTICAL") =>
      ({ direction, gap: pad, padding: [pad, pad, pad, pad], align: "STRETCH", justify: "MIN" }) as never;
    const page = {
      type: "FRAME",
      name: "page",
      width: 1656,
      height: 1047,
      sizing: { w: "fill", h: "hug" },
      layout: layout("VERTICAL"),
      children: [
        { type: "FRAME", name: "top", width: 1656, height: 66, sizing: { w: "fill", h: "hug" } },
        {
          type: "FRAME",
          name: "columns",
          width: 1656,
          height: 981,
          sizing: { w: "fill", h: "fill" },
          layout: layout("HORIZONTAL"),
          children: [{ type: "FRAME", name: "list", width: 390, height: 981, sizing: { w: "fixed", h: "fill" } }],
        },
      ],
    } as never;
    const out = settleSizing(page) as { sizing: unknown; children: { sizing: unknown; children?: { sizing: unknown }[] }[] };
    expect(out.sizing).toEqual({ w: "fixed", h: "hug" });
    expect(out.children[1]!.sizing).toEqual({ w: "fill", h: "fixed" }); // main axis of a hugging page
    expect(out.children[1]!.children![0]!.sizing).toEqual({ w: "fixed", h: "fill" }); // its parent is fixed now: fill works
  });

  const pad = (n = 0) => ({ value: n });
  const box = (name: string, width: number, height: number, sizing: object, more: object = {}) =>
    ({ type: "FRAME", name, width, height, sizing, ...more }) as never;
  const lay = (direction: "HORIZONTAL" | "VERTICAL" | "GRID", padding = 0) =>
    ({
      direction,
      gap: pad(),
      padding: [pad(padding), pad(padding), pad(padding), pad(padding)],
      align: "STRETCH",
      justify: "MIN",
    }) as never;
  type Out = { sizing: unknown; children: Out[] };

  it("a hugging row whose filling column is taller than its fixed sidebar is fixed at its height (836 for 2,427)", async () => {
    const { settleSizing } = await import("./compile.js");
    const row = box(
      "Body",
      1200,
      2490,
      { w: "fill", h: "hug" },
      {
        layout: lay("HORIZONTAL"),
        children: [box("aside", 256, 900, { w: "fixed", h: "fixed" }), box("column", 944, 2490, { w: "fill", h: "fill" })],
      },
    );
    const page = box("page", 1200, 2490, { w: "fill", h: "hug" }, { layout: lay("VERTICAL"), children: [row] });
    const out = settleSizing(page) as Out;
    expect(out.children[0]!.sizing).toEqual({ w: "fill", h: "fixed" });
    expect(out.children[0]!.children[1]!.sizing).toEqual({ w: "fill", h: "fill" });
    // A row its fixed child already makes as tall keeps hugging.
    const even = box(
      "row",
      1200,
      900,
      { w: "fill", h: "hug" },
      {
        layout: lay("HORIZONTAL"),
        children: [box("aside", 256, 900, { w: "fixed", h: "fixed" }), box("column", 944, 900, { w: "fill", h: "fill" })],
      },
    );
    expect(
      (settleSizing(box("p", 1200, 900, { w: "fill", h: "hug" }, { layout: lay("VERTICAL"), children: [even] })) as Out).children[0]!
        .sizing,
    ).toEqual({
      w: "fill",
      h: "hug",
    });
  });

  it("a fill child clearly narrower than its room (max-width: 85%) is fixed at its width; padding and borders count", async () => {
    const { settleSizing } = await import("./compile.js");
    const column = box(
      "thread",
      1160,
      476,
      { w: "fill", h: "hug" },
      {
        layout: lay("VERTICAL"),
        children: [box("bubble", 986, 85, { w: "fill", h: "hug" }), box("full", 1160, 40, { w: "fill", h: "hug" })],
      },
    );
    const out = settleSizing(box("p", 1160, 476, { w: "fixed", h: "hug" }, { layout: lay("VERTICAL"), children: [column] })) as Out;
    expect(out.children[0]!.children.map((c) => c.sizing)).toEqual([
      { w: "fixed", h: "hug" },
      { w: "fill", h: "hug" },
    ]);
    // A card 320 wide with 1px borders gives its children 318: they fill it.
    const card = box(
      "card",
      320,
      200,
      { w: "fixed", h: "hug" },
      {
        layout: lay("VERTICAL"),
        stroke: { color: { value: "#000000" }, width: 1 },
        children: [box("image", 318, 160, { w: "fill", h: "fixed" })],
      },
    );
    expect((settleSizing(card) as Out).children[0]!.sizing).toEqual({ w: "fill", h: "fixed" });
  });

  it("in a hugging grid, children that fill their track are fixed at their size (95 for 319)", async () => {
    const { settleSizing } = await import("./compile.js");
    const grid = box(
      "Guided setup",
      593,
      319,
      { w: "fill", h: "hug" },
      {
        layout: lay("GRID"),
        children: [
          box("card", 593, 284, { w: "fill", h: "fill" }),
          { ...(box("skip", 263, 23, { w: "hug", h: "fill" }) as object), type: "TEXT" },
        ],
      },
    );
    const out = settleSizing(box("p", 593, 319, { w: "fixed", h: "hug" }, { layout: lay("VERTICAL"), children: [grid] })) as Out;
    expect(out.children[0]!.children.map((c) => c.sizing)).toEqual([
      { w: "fill", h: "fixed" },
      { w: "hug", h: "hug" }, // text sizes its own height
    ]);
  });
});

describe("text styles in Figma", () => {
  it("every CSS weight has its style (800 was Regular, so extra-bold buttons read thin), italic too", async () => {
    const { styleFor } = await import("./compile.js");
    expect(styleFor(800)).toBe("Extra Bold");
    expect(styleFor(900)).toBe("Black");
    expect(styleFor(300)).toBe("Light");
    expect(styleFor(650)).toBe("Bold");
    expect(styleFor(400, true)).toBe("Italic");
    expect(styleFor(700, true)).toBe("Bold Italic");
  });
});

describe("frames read without a layout", () => {
  it("compile as a plain column instead of stopping the sync (0.2.5 crashed on a ::after box)", async () => {
    const { compileScreens } = await import("./compile.js");
    const zero = { value: 0 };
    const root = {
      type: "FRAME",
      name: "page",
      width: 200,
      height: 100,
      sizing: { w: "fixed", h: "fixed" },
      layout: { direction: "VERTICAL", gap: zero, padding: [zero, zero, zero, zero], align: "MIN", justify: "MIN" },
      children: [
        {
          type: "FRAME",
          name: "after",
          width: 32,
          height: 3,
          sizing: { w: "fixed", h: "fixed" },
          absolute: { x: 4, y: 97 },
          fill: { value: "#2563eb" },
        },
      ],
    };
    const irs = new Map([["page--default", { story: "page--default", root }]]) as never;
    const [screen] = compileScreens({ components: {}, screens: { "pages.page": { story: "page--default" } } } as never, irs, new Map());
    const after = (screen as unknown as { spec: { children: { name: string; props: Record<string, unknown> }[] } }).spec.children[0]!;
    expect(after.name).toBe("after");
    expect(after.props.layoutMode).toBe("VERTICAL");
  });
});

describe("an icon out of the flow", () => {
  it("keeps its absolute place (an SVG checkbox at a row's corner)", async () => {
    const { compileScreens } = await import("./compile.js");
    const zero = { value: 0 };
    const root = {
      type: "FRAME",
      name: "row",
      width: 358,
      height: 127,
      sizing: { w: "fixed", h: "fixed" },
      layout: { direction: "VERTICAL", gap: zero, padding: [zero, zero, zero, zero], align: "MIN", justify: "MIN" },
      children: [
        {
          type: "SVG",
          name: "input",
          width: 16,
          height: 16,
          sizing: { w: "fixed", h: "fixed" },
          absolute: { x: 16, y: 15 },
          svg: "<svg/>",
        },
      ],
    };
    const irs = new Map([["row--default", { story: "row--default", root }]]) as never;
    const [screen] = compileScreens({ components: {}, screens: { "pages.row": { story: "row--default" } } } as never, irs, new Map());
    const icon = (screen as unknown as { spec: { children: { props: Record<string, unknown> }[] } }).spec.children[0]!;
    expect(icon.props).toMatchObject({ layoutPositioning: "ABSOLUTE", x: 16, y: 15 });
  });
});

describe("components styled with utility classes (Tailwind)", () => {
  const zero = { value: 0 };
  const box = (name: string, cls: string | undefined, children: unknown[] = [], extra: Record<string, unknown> = {}) => ({
    type: "FRAME",
    name,
    width: 200,
    height: 40,
    sizing: { w: "hug", h: "hug" },
    layout: { direction: "HORIZONTAL", gap: zero, padding: [zero, zero, zero, zero], align: "MIN", justify: "MIN" },
    ...(cls ? { cls } : {}),
    children,
    ...extra,
  });
  const text = (name: string, characters: string) => ({
    type: "TEXT",
    name,
    width: 80,
    height: 20,
    sizing: { w: "hug", h: "hug" },
    text: {
      characters,
      fontFamily: "Inter",
      fontSize: { value: 14 },
      fontWeight: 400,
      color: { value: "#111111" },
      lineHeight: 20,
      align: "LEFT",
    },
  });
  const alert = (type: string, msg: string, more = "") =>
    box(
      "div",
      `border flex gap-2 items-start px-3.5 py-3 rounded-lg ${type === "error" ? "bg-[#fef2f2]" : "bg-blue-50"}${more}`,
      [text("p", msg)],
      {
        fill: { value: type === "error" ? "#fef2f2" : "#eff6ff" },
      },
    );
  // The story's root is the preview decorator's bare div around the component.
  const story = (id: string, inner: unknown) => [id, { story: id, root: box("div", "font-sans", [inner]) }] as const;
  const registry = {
    components: {
      "components.alert-box": {
        module: "AlertBox",
        title: "Components/AlertBox",
        files: [],
        stories: { "alert--error": { type: "error" }, "alert--info": { type: "info" } },
      },
    },
    screens: { "pages.editor": { story: "page--default" } },
  };
  const page = box("main", "flex flex-col p-6", [
    box("header", "flex items-center", [text("h1", "Editor")]),
    alert("info", "Saved.", " mt-4"),
  ]);
  const irs = new Map([
    story("alert--error", alert("error", "Something failed.")),
    story("alert--info", alert("info", "All good.")),
    ["page--default", { story: "page--default", root: page }] as const,
  ]) as never;

  it("a component's variant is the component, not the decorator's wrapper around it", () => {
    const [set] = compile(registry as never, irs, new Map());
    const variant = set!.children![0]!;
    expect(variant.children?.map((c) => c.type)).toEqual(["TEXT"]);
    expect(variant.props.fills).toBeDefined();
  });

  it("an element with all of a component's root classes is placed as it, in the variant whose classes it has", () => {
    const [screen] = compileScreens(registry as never, irs, new Map());
    const placed = screen!.spec.children![1]!;
    expect(placed.type).toBe("INSTANCE");
    expect(placed.instance?.mainK).toBe("components.alert-box/type=info");
    expect(placed.instance?.overrides.find((o) => o.characters)?.characters).toBe("Saved.");
    // The header shares too few classes with anything to be a component.
    expect(screen!.spec.children![0]!.type).toBe("FRAME");
    expect(screen!.coverage.instances).toEqual({ "components.alert-box": 1 });
  });
});

describe("an icon component (a story whose root is an <svg>)", () => {
  it("each variant is a component its size with the drawing inside (Figma variants must be components)", () => {
    const svg = (size: number) => ({
      type: "SVG",
      name: "svg",
      width: size,
      height: size,
      sizing: { w: "fixed", h: "fixed" },
      svg: "<svg/>",
    });
    const registry = {
      components: {
        "star-icon": {
          module: "StarIcon",
          title: "StarIcon",
          files: [],
          stories: { "star--default": { size: 16 }, "star--large": { size: 24 } },
        },
      },
      screens: {},
    };
    const irs = new Map([
      ["star--default", { story: "star--default", root: svg(16) }],
      ["star--large", { story: "star--large", root: svg(24) }],
    ]) as never;
    const [set] = compile(registry as never, irs, new Map());
    for (const [i, size] of [16, 24].entries()) {
      const v = set!.children![i]!;
      expect(v.type).toBe("COMPONENT");
      expect(v.props).toMatchObject({ width: size, height: size });
      expect(v.children?.map((c) => [c.type, c.k])).toEqual([["SVG", `${v.k}/svg`]]);
    }
  });
});

describe("examples that look different (splitExamples)", () => {
  const card = (border: string, title: string) => ({
    type: "FRAME",
    name: "card",
    width: 300,
    height: 100,
    sizing: { w: "fixed", h: "fixed" },
    stroke: { color: { value: border }, width: 1 },
    children: [
      {
        type: "TEXT",
        name: "title",
        width: 100,
        height: 20,
        sizing: { w: "hug", h: "hug" },
        text: {
          characters: title,
          fontFamily: "Inter",
          fontWeight: { value: 600 },
          fontSize: { value: 16 },
          lineHeight: 20,
          letterSpacing: 0,
          color: { value: "#000000" },
        },
      },
    ],
  });
  const irs = new Map([
    ["plan--team", { story: "plan--team", root: card("#0f766e", "Team") }],
    ["plan--long-title", { story: "plan--long-title", root: card("#0f766e", "Team, with a much longer name") }],
    ["plan--free", { story: "plan--free", root: card("#e2e8f0", "Starter") }],
  ]) as never;
  const registry = {
    components: {
      plan: {
        module: "PricingCard",
        stories: { "plan--team": { billing: "monthly" } },
        examples: { "plan--long-title": "plan--team", "plan--free": "plan--team" },
      },
    },
  };

  it("makes an example that renders differently a variant of its own, told apart by story", () => {
    const out = splitExamples(registry, irs).components.plan!;
    expect(out.stories).toEqual({
      "plan--team": { billing: "monthly", story: "team" },
      "plan--free": { billing: "monthly", story: "free" },
    });
    // Other data only (a longer title): still an example of its variant.
    expect(out.examples).toEqual({ "plan--long-title": "plan--team" });
  });

  it("leaves a component whose examples differ only in data as it was", () => {
    const same = { components: { plan: { ...registry.components.plan, examples: { "plan--long-title": "plan--team" } } } };
    expect(splitExamples(same, irs)).toEqual(same);
  });
});

describe("colours bound to tokens only when the browser drew the token's colour", () => {
  const dtcg = {
    color: {
      status: { success: { border: { $value: "#a7f3d0" }, surface: { $value: "#ecfdf5" } } },
      brand: { $value: "{color.status.success.surface}" },
    },
  };
  const page = (stroke: string, fill: string) => {
    const zero = { value: 0 };
    return {
      type: "FRAME",
      name: "page",
      width: 200,
      height: 100,
      sizing: { w: "fixed", h: "fixed" },
      layout: { direction: "VERTICAL", gap: zero, padding: [zero, zero, zero, zero], align: "MIN", justify: "MIN" },
      fill: { value: fill, token: "color-brand" },
      stroke: { color: { value: stroke, token: "color-status-success-border" }, width: 1 },
      children: [],
    };
  };
  const build = async (stroke: string, fill: string, withColours = true) => {
    const { compileScreens, tokenColours } = await import("./compile.js");
    const irs = new Map([["page--default", { story: "page--default", root: page(stroke, fill) }]]) as never;
    const [screen] = compileScreens(
      { components: {}, screens: { "pages.page": { story: "page--default" } } } as never,
      irs,
      tokenNames(dtcg),
      withColours ? tokenColours(dtcg) : undefined,
    );
    return (screen as unknown as { spec: { paintBind?: Record<string, string>; props: Record<string, unknown> } }).spec;
  };
  it("reads each colour token's value, aliases followed", async () => {
    const { tokenColours } = await import("./compile.js");
    const c = tokenColours(dtcg);
    expect(c.get("color-status-success-border")).toMatchObject({ a: 1 });
    expect(c.get("color-brand")).toEqual(c.get("color-status-success-surface"));
  });
  it("the page doesn't define the token (the browser drew transparent): the drawn colour, not the token's", async () => {
    const spec = await build("#00000000", "#ecfdf5");
    expect(spec.paintBind?.strokes).toBeUndefined();
    expect(spec.props.strokes).toEqual(["#00000000"]);
    // The fill is the token's colour (through an alias): bound.
    expect(spec.paintBind?.fills).toBe("color/brand");
  });
  it("the same colour, give or take rounding: bound", async () => {
    expect((await build("#a7f3d1", "#ecfdf5")).paintBind?.strokes).toBe("color/status/success/border");
  });
  it("without the tokens' values (older callers), bound as before", async () => {
    expect((await build("#00000000", "#ecfdf5", false)).paintBind?.strokes).toBe("color/status/success/border");
  });
  it("a colour set without var(): bound when exactly one token has that value, not when two do", async () => {
    const { compileScreens, tokenColours } = await import("./compile.js");
    const bare = { ...page("#a7f3d0", "#ecfdf5"), fill: { value: "#ecfdf5" }, stroke: { color: { value: "#a7f3d0" }, width: 1 } };
    const irs = new Map([["page--default", { story: "page--default", root: bare }]]) as never;
    const [screen] = compileScreens(
      { components: {}, screens: { "pages.page": { story: "page--default" } } } as never,
      irs,
      tokenNames(dtcg),
      tokenColours(dtcg),
    );
    const spec = (screen as unknown as { spec: { paintBind?: Record<string, string> } }).spec;
    // One token is #a7f3d0; #ecfdf5 is two (the surface and the brand alias to it).
    expect(spec.paintBind?.strokes).toBe("color/status/success/border");
    expect(spec.paintBind?.fills).toBeUndefined();
  });
});
