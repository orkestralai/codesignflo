import { describe, expect, it } from "vitest";
import { diff } from "../diff/diff.js";
import type { Raw } from "../snapshot/canonical.js";
import { fixture } from "../test-fixtures.js";
import { merge } from "./merge.js";

const base = fixture<Raw>("s5/base.json");
const ours = fixture<Raw>("s5/ours.json");
const theirs = fixture<Raw>("s5/theirs.json");

describe("merge (golden: spike S5, real Figma)", () => {
  const m = merge(base, ours, theirs);
  const byProp = Object.fromEntries(m.ours.map((i) => [i.prop, i.merge]));

  it("classifies padding vs padding as conflict, token as clean, CTA text vs CTA removed as conflict", () => {
    expect(byProp).toEqual({ padding: "conflict", fills: "clean", characters: "conflict" });
    expect(m.summary).toEqual({ clean: 1, conflict: 2, convergent: 0, codeChanges: 3 });
  });

  it("the rebased copy differs from theirs by exactly the clean item", () => {
    const vs = diff(theirs, fixture<Raw>("s5/rebased.json"));
    expect(vs.map((i) => i.prop)).toEqual(["fills"]);
    expect(merge(theirs, fixture<Raw>("s5/rebased.json"), theirs).summary.conflict).toBe(0);
  });

  it("the same change on both sides is convergent", () => {
    const same = merge(base, ours, ours);
    expect(same.summary.conflict).toBe(0);
    expect(same.summary.convergent).toBe(3);
  });

  it("no code change → everything clean", () => {
    expect(merge(base, ours, base).summary).toMatchObject({ clean: 3, conflict: 0 });
  });
});
