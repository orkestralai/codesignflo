import { describe, expect, it } from "vitest";
import type { Raw } from "../snapshot/canonical.js";
import { fixture } from "../test-fixtures.js";
import { diff, locate } from "./diff.js";

// Spike S3 scenarios, simulated on the real S3 baseline (a canonical snapshot from Figma).
const base = fixture<Raw>("s3/baseline.json");
const v = (r: Raw, size: string) => r.children!.find((c) => (c.variantProperties as Record<string, string>)?.Size === size)!;
const child = (n: Raw, name: string) => n.children!.find((c) => c.name === name)!;
const edit = (...fns: ((r: Raw) => void)[]) => {
  const r = structuredClone(base);
  for (const f of fns) f(r);
  return r;
};
const pad = (r: Raw, size: string, n: number) =>
  Object.assign(v(r, size).layout as object, { paddingTop: n, paddingRight: n, paddingBottom: n, paddingLeft: n });
const token = (r: Raw) => {
  const p = child(v(r, "md"), "Price") as { fills: { boundVariables: { color: string }; color: object }[] };
  p.fills[0]!.boundVariables.color = "var(S2 Tokens/color/text/primary)";
  p.fills[0]!.color = { r: 0.09, g: 0.09, b: 0.11 };
};
const ctaText = (r: Raw) => {
  (child(v(r, "md"), "CTA").children!.find((x) => x.type === "TEXT") as { characters: string }).characters = "Add";
};

const cases: [string, number, (r: Raw) => void][] = [
  ["no edit", 0, () => {}],
  ["padding 8→12", 1, (r) => pad(r, "compact", 12)],
  ["token swap", 1, token],
  ["font weight", 1, (r) => Object.assign(child(v(r, "md"), "Price"), { fontName: { family: "Inter", style: "Semi Bold" }, width: 30 })],
  ["instance text override", 1, ctaText],
  ["add a layer", 1, (r) => v(r, "md").children!.splice(2, 0, { type: "RECTANGLE", name: "Divider", height: 1 } as Raw)],
  ["remove a layer", 1, (r) => (v(r, "compact").children = v(r, "compact").children!.filter((x) => x.name !== "Image"))],
  [
    "reorder",
    1,
    (r) => {
      const c = v(r, "md").children!;
      const t = c.splice(
        c.findIndex((x) => x.name === "Title"),
        1,
      )[0]!;
      c.splice(c.findIndex((x) => x.name === "Price") + 1, 0, t);
    },
  ],
  ["rename", 1, (r) => (child(v(r, "md"), "Title").name = "Heading")],
  [
    "new variant",
    1,
    (r) => {
      const n = structuredClone(v(r, "md"));
      n.name = "Size=large";
      n.variantProperties = { Size: "large" };
      (n.layout as { itemSpacing: number }).itemSpacing = 12;
      r.children!.push(n);
    },
  ],
  [
    "wrap",
    1,
    (r) => {
      const kids = v(r, "md").children!;
      const [t, p] = [kids[1]!, kids[2]!];
      kids.splice(1, 2, { type: "FRAME", name: "Text", layout: { mode: "VERTICAL" }, children: [t, p] } as Raw);
    },
  ],
  [
    "fixed frame grows by exactly the padding change",
    1,
    (r) => {
      pad(r, "compact", 12);
      Object.assign(v(r, "compact"), { height: ((v(r, "compact").height as number) ?? 18) + 8, layoutSizingVertical: "FIXED" });
    },
  ],
  ["lock (ready for dev)", 0, (r) => ((r as { locked?: boolean }).locked = true)],
];

describe("diff (S3 scenarios on a real baseline)", () => {
  for (const [name, expected, fn] of cases) it(`${name} → ${expected} item(s)`, () => expect(diff(base, edit(fn))).toHaveLength(expected));

  it("seven edits at once → exactly 7 items", () => {
    const items = diff(base, edit(...cases.slice(1, 8).map(([, , f]) => f)));
    expect(items).toHaveLength(7);
  });

  it("a token change keeps value and binding apart", () => {
    const [item] = diff(
      base,
      edit((r) => {
        const m = v(r, "md") as { boundVariables: Record<string, unknown>; layout: Record<string, number> };
        for (const f of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
          delete m.boundVariables[f];
          m.layout[f] = 16;
        }
      }),
    );
    expect(item).toMatchObject({ kind: "token", prop: "padding", from: [12, 12, 12, 12], to: [16, 16, 16, 16] });
    expect(item?.toBound).toEqual({ paddingTop: null, paddingRight: null, paddingBottom: null, paddingLeft: null });
  });

  it("item ids are stable", () => {
    const a = diff(base, edit(token)).map((i) => i.id);
    const b = diff(base, edit(token)).map((i) => i.id);
    expect(a).toEqual(b);
  });

  it("locate maps identities to child-index paths", () => {
    const where = locate(base);
    expect(where.get("ROOT")).toEqual([]);
    expect([...where.keys()].some((k) => k.startsWith("V[Size=md]"))).toBe(true);
  });
});

describe("delta quality (first designer test)", () => {
  it("a resize is one change, not four", () => {
    const items = diff(
      base,
      edit((r) => Object.assign(v(r, "md"), { width: 425, height: 391, layoutSizingVertical: "FIXED", primaryAxisSizingMode: "FIXED" })),
    );
    expect(items.map((i) => [i.kind, i.prop])).toEqual([["layout", "size"]]);
    expect(items[0]?.to).toMatchObject({ width: 425, height: 391 });
  });

  it("instance override bookkeeping is not a change", () => {
    const items = diff(
      base,
      edit((r) => Object.assign(child(v(r, "md"), "CTA"), { overriddenFields: ["characters", "fills"] })),
    );
    expect(items).toHaveLength(0);
  });

  it("text that comes from data is classified as data, not content", () => {
    const tagged = edit((r) => Object.assign(child(v(r, "md"), "Title"), { dataText: true }));
    const changed = structuredClone(tagged);
    Object.assign(child(v(changed, "md"), "Title"), { characters: "Something else" });
    expect(diff(tagged, changed).map((i) => i.kind)).toEqual(["data"]);
    expect(diff(tagged, tagged)).toHaveLength(0);
  });
});

describe("diff on real proposals", () => {
  it("S6: 4 edits in each of 3 variants of the Live ProductCard → 12 items", () => {
    const items = diff(fixture<Raw>("s6/base.json"), fixture<Raw>("s6/proposal.json"));
    expect(items).toHaveLength(12);
    expect(new Set(items.map((i) => i.prop))).toEqual(new Set(["padding", "fills", "fontName", "characters"]));
  });

  it("S5: designer copy → 3 items, code copy → 3 items", () => {
    expect(diff(fixture<Raw>("s5/base.json"), fixture<Raw>("s5/ours.json"))).toHaveLength(3);
    expect(diff(fixture<Raw>("s5/base.json"), fixture<Raw>("s5/theirs.json"))).toHaveLength(3);
  });
});

describe("Figma-only aids", () => {
  it("a layout grid added in Figma is not a change", () => {
    const a = { type: "FRAME", name: "x", width: 10 } as never;
    const b = { type: "FRAME", name: "x", width: 10, layoutGrids: [{ pattern: "GRID", sectionSize: 10, visible: true }] } as never;
    expect(diff(a, b)).toEqual([]);
  });
});
