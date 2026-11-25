// Three-way merge in Figma space. Ported from spike S5.
// base = baseline generation, ours = designer's proposal, theirs = latest generation from code.
// Every proposal item is classified before any code is touched. Candidate for packages/core.
import { diff, type Item } from "../diff/diff.js";
import type { Raw } from "../snapshot/canonical.js";
import { sameValue, stableStringify } from "../util/stable.js";

export type Classified = Item & {
  merge: "clean" | "conflict" | "convergent";
  /** The code-side item(s) it collides with. */
  against?: { kind: string; op?: string; prop?: string; path: string; to?: unknown; toBound?: Record<string, unknown> }[];
};

export type MergeReport = {
  ours: Classified[];
  /** Code-side changes since the baseline, for context ("what changed under you"). */
  theirs: Item[];
  summary: { clean: number; conflict: number; convergent: number; codeChanges: number };
};

const eq = sameValue;
const usesToken = (i: Item) => `${JSON.stringify(i.to ?? null)}${JSON.stringify(i.toBound ?? null)}`.includes("var(");
const sameIgnoringTokens = (a: unknown, b: unknown) =>
  stableStringify(a, (k) => k === "boundVariables") === stableStringify(b, (k) => k === "boundVariables");

/** Is `target` the node `other` or inside it? Identities nest by "|" (variant/instance scope) and keys by "/". */
const within = (target: string, other: string) => target === other || target.startsWith(`${other}|`) || target.startsWith(`${other}/`);

export function merge(base: Raw, ours: Raw, theirs: Raw): MergeReport {
  const mine = diff(base, ours);
  const code = diff(base, theirs);
  const classified: Classified[] = mine.map((item) => {
    const against = code.filter((c) => {
      // Code removed the node (or an ancestor) the designer changed.
      if (c.op === "remove" && within(item.target, c.target)) return true;
      // Designer removed a node code changed.
      if (item.op === "remove" && within(c.target, item.target)) return true;
      // Same node, same property.
      if (c.target === item.target && c.prop !== undefined && c.prop === item.prop) return true;
      // Same structural slot (both moved / reordered / wrapped the same node).
      if (c.target === item.target && c.op && item.op && c.op === item.op && c.op !== "change") return true;
      return false;
    });
    if (against.length === 0) return { ...item, merge: "clean" };
    const c = against[0];
    const sameResult =
      against.length === 1 &&
      c !== undefined &&
      c.prop === item.prop &&
      ((eq(c.to, item.to) && eq(c.toBound, item.toBound)) ||
        // The designer typed a value; the code reached the same value through a token (the rule for raw
        // values): done, the code's way.
        (!usesToken(item) && sameIgnoringTokens(c.to, item.to)));
    return {
      ...item,
      merge: sameResult ? "convergent" : "conflict",
      against: against.map((x) => ({ kind: x.kind, op: x.op, prop: x.prop, path: x.path, to: x.to, toBound: x.toBound })),
    };
  });
  return {
    ours: classified,
    theirs: code,
    summary: {
      clean: classified.filter((c) => c.merge === "clean").length,
      conflict: classified.filter((c) => c.merge === "conflict").length,
      convergent: classified.filter((c) => c.merge === "convergent").length,
      codeChanges: code.length,
    },
  };
}
