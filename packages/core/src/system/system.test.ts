// Linking the designer's design system to the code's components: suggestions, the property mapping, which
// variant draws what, the differences of a pair, token suggestions, and what a design uses in code terms.
import { describe, expect, it } from "vitest";
import {
  type CodeComponent,
  codeProps,
  compareComponents,
  type LibraryComponent,
  mapProps,
  mapVariant,
  normName,
  parseVariant,
  suggestLinks,
  suggestTokens,
  systemUses,
  usesLines,
} from "./system.js";

describe("names", () => {
  it("normalises keys, titles, plurals and groups", () => {
    expect(normName("components.button")).toBe("button");
    expect(normName("Button")).toBe("button");
    expect(normName("Buttons")).toBe("button");
    expect(normName("components.button-group")).toBe("buttongroup");
    expect(normName("Button Group")).toBe("buttongroup");
    expect(normName("Forms/Text Input")).toBe("textinput");
    expect(normName("Progress")).toBe("progress");
  });
});

describe("the property mapping", () => {
  it("maps names and values through synonyms", () => {
    const m = mapProps(
      { size: ["sm", "md", "lg"], variant: ["primary", "secondary", "danger"] },
      { Size: ["Small", "Medium", "Large"], Type: ["Primary", "Secondary", "Destructive"] },
    );
    expect(m.props).toEqual({ size: "Size", variant: "Type" });
    expect(m.values.size).toEqual({ sm: "Small", md: "Medium", lg: "Large" });
    expect(m.values.variant).toEqual({ primary: "Primary", secondary: "Secondary", danger: "Destructive" });
  });
  it("pairs properties by their values when the names differ", () => {
    const m = mapProps({ look: ["primary", "ghost"] }, { Hierarchy: ["Primary", "Tertiary"], Icon: ["true", "false"] });
    expect(m.props).toEqual({ look: "Hierarchy" });
  });
});

describe("yes/no properties as a state", () => {
  it("disabled=true ↔ State=Disabled, false ↔ State=Default", () => {
    const m = mapProps(
      { variant: ["flat", "slim"], disabled: ["false", "true"], loading: ["false", "true"] },
      { Type: ["Flat", "Slim"], State: ["Default", "Disabled"] },
    );
    expect(m.props).toEqual({ variant: "Type", disabled: "State" });
    expect(m.values.disabled).toEqual({ true: "Disabled", false: "Default" });
    const lib = [
      { Type: "Flat", State: "Default" },
      { Type: "Flat", State: "Disabled" },
      { Type: "Slim", State: "Default" },
    ];
    expect(mapVariant({ variant: "flat", disabled: "true", loading: "false" }, m, lib)).toBe(1);
    expect(mapVariant({ variant: "slim", disabled: "true", loading: "false" }, m, lib)).toBe(-1);
    expect(codeProps({ Type: "Flat", State: "Disabled" }, m)).toEqual({ variant: "flat", disabled: "true" });
  });
});

describe("suggested links", () => {
  const code: CodeComponent[] = [
    { k: "components.button", name: "Button", props: { size: ["sm", "md"], variant: ["primary", "ghost"] } },
    { k: "components.badge", name: "Badge", props: { tone: ["sale", "new"] } },
    { k: "components.agent-card", name: "AgentCard", props: {} },
  ];
  const lib: LibraryComponent[] = [
    { id: "1:1", name: "Buttons", props: { Size: ["Small", "Medium"], Style: ["Primary", "Ghost"] } },
    { id: "1:2", name: "Badge", props: { Color: ["Sale", "New"] } },
    { id: "1:3", name: "Avatar", props: {} },
  ];
  it("pairs the obvious ones, one to one, with the mapping", () => {
    const s = suggestLinks(code, lib);
    expect(s.map((x) => [x.k, x.id])).toEqual([
      ["components.button", "1:1"],
      ["components.badge", "1:2"],
    ]);
    expect(s[0]!.map.values.size).toEqual({ sm: "Small", md: "Medium" });
    expect(s[0]!.why).toContain("same name");
  });
  it("leaves out what the designer rejected", () => {
    expect(suggestLinks(code, lib, new Set(["components.badge|1:2"])).map((x) => x.k)).toEqual(["components.button"]);
  });
  it("one Library component for one code component", () => {
    const s = suggestLinks([...code, { k: "components.buttons", name: "Buttons", props: {} }], lib);
    expect(s.filter((x) => x.id === "1:1")).toHaveLength(1);
  });
});

describe("variants", () => {
  const map = mapProps({ size: ["sm", "lg"], variant: ["primary", "danger"] }, { Size: ["Small", "Large"], Type: ["Primary"] });
  const lib = [
    { Size: "Small", Type: "Primary" },
    { Size: "Large", Type: "Primary" },
  ];
  it("picks the Library variant for a code variant", () => {
    expect(mapVariant(parseVariant("size=lg, variant=primary"), map, lib)).toBe(1);
    expect(mapVariant({ size: "sm", variant: "primary" }, map, lib)).toBe(0);
  });
  it("-1 when the Library hasn't got it (the code's version stays)", () => {
    expect(mapVariant({ size: "sm", variant: "danger" }, map, lib)).toBe(-1);
  });
  it("a single component draws every variant", () => {
    expect(mapVariant({ size: "sm" }, map, [])).toBe(0);
  });
  it("back in the code's terms", () => {
    expect(codeProps({ Size: "Large", Type: "Primary" }, map)).toEqual({ size: "lg", variant: "primary" });
  });
});

describe("a linked pair's differences", () => {
  it("sizes, corners, fills, and the variants the Library lacks", () => {
    const map = mapProps({ size: ["sm", "lg"] }, { Size: ["Small"] });
    const lines = compareComponents(
      [
        { props: { size: "sm" }, w: 80, h: 32, radius: 6, fill: "#2563eb" },
        { props: { size: "lg" }, w: 120, h: 44 },
      ],
      [{ props: { Size: "Small" }, w: 81, h: 36, radius: 8, fill: "#2563EB" }],
      map,
    );
    expect(lines).toEqual([
      "no Library variant for size=lg — pages use the code's version there",
      "size=sm: 81×36 in your Library, 80×32 in the app; corners 8 vs 6",
    ]);
  });
  it("says which code properties the Library has nothing for", () => {
    const map = mapProps({ variant: ["flat"], loading: ["false", "true"] }, { Type: ["Flat"] });
    expect(
      compareComponents(
        [
          { props: { variant: "flat", loading: "false" }, w: 10, h: 10 },
          { props: { variant: "flat", loading: "true" }, w: 10, h: 10 },
        ],
        [{ props: { Type: "Flat" }, w: 10, h: 10 }],
        map,
      ),
    ).toEqual(["nothing for loading in your Library — its versions all show the same variant"]);
  });
  it("nothing when they agree", () => {
    const map = mapProps({}, {});
    expect(compareComponents([{ props: {}, w: 10, h: 10 }], [{ props: {}, w: 11, h: 10 }], map)).toEqual([]);
  });
});

describe("tokens", () => {
  it("by name, then by a value only one variable has", () => {
    const s = suggestTokens(
      [
        { name: "color.primary", value: "#2563eb" },
        { name: "space.4", value: 16 },
        { name: "radius.md", value: 8 },
      ],
      [
        { id: "V:1", name: "Colors/Primary", collection: "Brand", value: "#2563EB" },
        { id: "V:2", name: "spacing/4", collection: "Brand", value: 16 },
        { id: "V:3", name: "corner-medium", collection: "Brand", value: 8 },
      ],
    );
    expect(s).toEqual([
      { token: "color.primary", id: "V:1", why: "same name" },
      { token: "space.4", id: "V:2", why: "same name" },
      { token: "radius.md", id: "V:3", why: "same value (8)" },
    ]);
  });
  it("no guess by value when several share it", () => {
    expect(
      suggestTokens(
        [{ name: "a", value: 4 }],
        [
          { id: "1", name: "x", collection: "c", value: 4 },
          { id: "2", name: "y", collection: "c", value: 4 },
        ],
      ),
    ).toEqual([]);
  });
});

describe("what a design uses", () => {
  it("lists linked instances in code terms, grouped", () => {
    const tree = {
      name: "Card",
      children: [
        { name: "cta", uses: { k: "components.button", props: { variant: "primary" }, name: "Buttons" }, children: [{ name: "label" }] },
        { name: "footer", children: [{ name: "more", uses: { k: "components.button", props: { variant: "primary" }, name: "Buttons" } }] },
      ],
    };
    const uses = systemUses(tree as never);
    expect(uses.map((u) => u.layer)).toEqual(["cta", "footer/more"]);
    expect(usesLines(uses)[1]).toBe('- `cta`, `footer/more`: their "Buttons" = components.button with variant="primary"');
  });
});
