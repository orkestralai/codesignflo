// Live built on the designer's design: an update writes only what the code changed since the last one,
// onto the designer's layers — everything else stays as they drew it.
import type { SpecNode } from "../compile/compile.js";
import { stableStringify } from "../util/stable.js";

export type SpecChanges = { props: Record<string, unknown>; bind: Record<string, string>; paintBind: Record<string, string> };

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/** What the code changed on one layer between two compiled versions (null: nothing). */
export function specChanges(prev: SpecNode, next: SpecNode): SpecChanges | null {
  const pick = (a: Record<string, unknown> = {}, b: Record<string, unknown> = {}) =>
    Object.fromEntries(Object.entries(b).filter(([f, v]) => !same(a[f], v)));
  const props = pick(prev.props, next.props);
  const bind = pick(prev.bind, next.bind) as Record<string, string>;
  const paintBind = pick(prev.paintBind, next.paintBind) as Record<string, string>;
  // A token that changed is written with its value (the binding alone doesn't say what the value is).
  for (const f of Object.keys(bind)) if (next.props[f] !== undefined) props[f] = next.props[f];
  for (const f of Object.keys(paintBind)) if (next.props[f] !== undefined) props[f] = next.props[f];
  return Object.keys(props).length || Object.keys(bind).length || Object.keys(paintBind).length ? { props, bind, paintBind } : null;
}

/** Every layer of a compiled tree by key (placed components as `pick` chooses: instance or inlined). */
export function specsByKey(spec: SpecNode, pick: (s: SpecNode) => SpecNode = (s) => s): Map<string, SpecNode> {
  const out = new Map<string, SpecNode>();
  const walk = (s0: SpecNode) => {
    const s = pick(s0);
    out.set(s.k, s);
    if (s.type !== "INSTANCE") for (const c of s.children ?? []) walk(c);
  };
  walk(spec);
  return out;
}
