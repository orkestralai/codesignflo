import { describe, expect, it } from "vitest";
import { diff } from "../diff/diff.js";
import { merge } from "../merge/merge.js";
import type { Raw } from "../snapshot/canonical.js";

/** Postgres jsonb gives objects back with their keys in another order. */
const reorder = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(reorder)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .reverse()
            .map(([k, x]) => [k, reorder(x)]),
        )
      : v;

const live: Raw = {
  type: "FRAME",
  name: "Badge",
  k: "badge",
  constraints: { horizontal: "MIN", vertical: "MIN" },
  fills: [
    {
      boundVariables: { color: "var(Tokens/color/surface/muted)" },
      color: { b: 0.96, g: 0.95, r: 0.95 },
      opacity: 1,
      type: "SOLID",
      visible: true,
    },
  ],
  children: [{ type: "TEXT", name: "label", k: "badge/label", characters: "Sale", fontName: { family: "Inter", style: "Medium" } }],
};

describe("values compare by content, not key order (snapshots stored in the service)", () => {
  it("a snapshot and its reordered copy have no differences", () => {
    expect(diff(live, reorder(live) as Raw)).toEqual([]);
  });

  it("a change the code also made is convergent even when one side came back reordered", () => {
    const ours = { ...live, constraints: { horizontal: "CENTER", vertical: "MIN" } };
    const m = merge(reorder(live) as Raw, ours, reorder(ours) as Raw);
    expect(m.summary.convergent).toBe(1);
  });

  it("a value the designer typed and the code reached through a token is convergent", () => {
    const ours = { ...live, cornerRadius: 16 } as Raw;
    const theirs = { ...live, cornerRadius: 16, boundVariables: { topLeftRadius: ["var(Tokens/radius/xl)"] } } as Raw;
    const m = merge(live, ours, theirs);
    expect(m.summary).toMatchObject({ convergent: 1, conflict: 0 });
  });
});

describe("the same design value", () => {
  it("colours and opacities within one 8-bit step are the same; other numbers must match", async () => {
    const { sameDesignValue } = await import("./stable.js");
    const paint = (opacity: number, r = 1) => [{ type: "SOLID", color: { r, g: 0.2196, b: 0.2353 }, opacity }];
    expect(sameDesignValue(paint(0.14), paint(0.1412))).toBe(true);
    expect(sameDesignValue(paint(0.14), paint(0.2))).toBe(false);
    expect(sameDesignValue(paint(1, 1), paint(1, 0.99))).toBe(false);
    expect(sameDesignValue({ cornerRadius: 8 }, { cornerRadius: 8.001 })).toBe(false);
  });
});
