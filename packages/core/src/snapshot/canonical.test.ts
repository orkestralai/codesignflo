import { describe, expect, it } from "vitest";
import { fixture } from "../test-fixtures.js";
import { canonicalize, type Raw, stringify } from "./canonical.js";

type Snap = { tree: Raw; variables: Record<string, string> };

describe("canonicalize (golden: spike S2, real Figma snapshots)", () => {
  for (const name of ["s1Button", "s1ButtonOtherPageClone", "s1Card", "s2Card"]) {
    it(`${name}: raw → canonical is byte-identical to the spike output`, () => {
      const raw = fixture<Snap>(`s2/${name}.raw.json`);
      const expected = fixture(`s2/${name}.canon.json`);
      expect(stringify(canonicalize(raw.tree, { variables: raw.variables }))).toBe(stringify(expected));
    });
  }

  it("a copy canonicalizes like its source when the root name is ignored", () => {
    const a = fixture<Snap>("s2/s1Button.raw.json");
    const b = fixture<Snap>("s2/s1ButtonOtherPageClone.raw.json");
    expect(stringify(canonicalize(b.tree, { variables: b.variables, ignoreRootName: true }))).toBe(
      stringify(canonicalize(a.tree, { variables: a.variables, ignoreRootName: true })),
    );
  });

  it("replaces file-local ids with names", () => {
    const out = stringify(
      canonicalize(
        {
          id: "1:2",
          name: "x",
          boundVariables: { paddingTop: ["VariableID:5:7"] },
          componentPropertyDefinitions: { "Show#5:0": { type: "BOOLEAN" } },
        },
        { variables: { "VariableID:5:7": "Tokens/space/3" } },
      ),
    );
    expect(out).toContain("var(Tokens/space/3)");
    expect(out).toContain('"Show"');
    expect(out).not.toContain("1:2");
  });
});
