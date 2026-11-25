// Alex, the demo's simulated developer, builds the designer's changes into the app's compiled code: checked on a
// real proposal (the product card, packages/core/test-fixtures/s6: Live as claimed and the designer's copy) and
// the code that drew it (s4), with the same comparison the plugin makes before closing a design.
import { readFileSync } from "node:fs";
import { deltaFor, predictLive, type Raw, type SpecNode, withDataTags } from "@codesignflo/core";
import { describe, expect, it } from "vitest";
import { buildDesign } from "../mcp/alex.ts";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`../../packages/core/test-fixtures/${f}`, import.meta.url), "utf8"));
const unwrap = (x: { tree?: Raw } & Raw): Raw => (x.tree ?? x) as Raw;

describe("Alex builds a design", () => {
  const spec = (fixture("s4/spec.golden.json") as SpecNode[]).find((s) => s.k === "card.product")!;
  const base = unwrap(fixture("s6/base.json"));
  const copy = unwrap(fixture("s6/proposal.json"));
  const dtcg = fixture("s4/tokens.json");

  it("writes the designer's changes into the code, so Live rebuilt from it matches the copy", () => {
    const before = deltaFor({ base, ours: copy, theirs: base, dtcg }).changes;
    expect(before.length).toBeGreaterThan(0);
    const built = buildDesign({ spec, base, copy, live: base, dtcg });
    expect(built.total).toBe(before.length);
    // Live rebuilt from the code, as predicted: every change but the one inside the Button instance, which Figma
    // makes from the instance's overrides (the prediction doesn't model an instance's content).
    const after = deltaFor({ base: withDataTags(base, base), ours: withDataTags(copy, base), theirs: predictLive(base, built.spec).tree, dtcg }).changes;
    expect(after.map((c) => `${c.layer} ${c.prop}`)).toEqual(["body/button > text characters"]);
    const button = (n: SpecNode): SpecNode | undefined => (n.k.endsWith("Title=long/body/button") ? n : (n.children ?? []).map(button).find(Boolean));
    const label = (copy as Raw & { children: Raw[] });
    const text = JSON.stringify(label).match(/"characters":"(Add[^"]*)"/)?.[1];
    expect(button(built.spec)!.instance!.overrides).toContainEqual(expect.objectContaining({ path: ["text"], characters: text }));
    expect(built.missing).toBe(0);
  });

  it("fixes the demo's draft: Alex's Free shipping badge, restyled by the designer", async () => {
    const seed = (await import("../demo/seed.json", { with: { type: "json" } })).default as unknown as {
      update2: { sets: SpecNode[]; dtcg: Record<string, unknown> };
    };
    const badge = seed.update2.sets.find((x) => x.k === "shipping-badge")!;
    const variant = badge.children![0]!;
    const label = variant.children![0]!;
    const paint = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return [{ type: "SOLID", visible: true, opacity: 1, color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 } }];
    };
    const draft = (o: { fill: string; text: string; radius: number; px: number; py: number; font: string; size: number }): Raw =>
      ({
        k: badge.k,
        type: "COMPONENT_SET",
        name: badge.k,
        children: [
          {
            k: variant.k,
            type: "COMPONENT",
            name: "story=default",
            fills: paint(o.fill),
            cornerRadius: o.radius,
            layout: { mode: "HORIZONTAL", paddingTop: o.py, paddingBottom: o.py, paddingLeft: o.px, paddingRight: o.px, itemSpacing: 0 },
            children: [{ k: label.k, type: "TEXT", name: "label", characters: "Free shipping", fills: paint(o.text), fontName: { family: o.font, style: o.font === "Arial" ? "Regular" : "Semi Bold" }, fontSize: o.size }],
          },
        ],
      }) as unknown as Raw;
    const base = draft({ fill: "#d9d9d9", text: "#333333", radius: 0, px: 3, py: 1, font: "Arial", size: 10 });
    const copy = draft({ fill: "#2563eb", text: "#ffffff", radius: 6, px: 8, py: 4, font: "Inter", size: 11 });
    const built = buildDesign({ spec: badge, base, copy, live: base, dtcg: seed.update2.dtcg });
    expect(built.missing).toBe(0);
    expect(built.total).toBeGreaterThanOrEqual(5);
    const v = built.spec.children![0]!;
    expect(v.props).toMatchObject({ fills: ["#2563eb"], cornerRadius: 6, paddingLeft: 8, paddingTop: 4 });
    expect(v.children![0]!.props).toMatchObject({ fills: ["#ffffff"], fontSize: 11 });
  });

  it("leaves the code as it is when nothing changed", () => {
    const built = buildDesign({ spec, base, copy: base, live: base, dtcg });
    expect(built).toMatchObject({ missing: 0, total: 0 });
    expect(built.spec).toEqual(spec);
  });
});
