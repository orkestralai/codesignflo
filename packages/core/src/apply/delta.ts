// The designer's changes as code-level changes: three-way merge (base = the version they claimed, ours = their
// copy, theirs = Live now), grouped, with their version answers. Pure: used by the CLI and the plugin.
import { type Change, changeKey, group } from "../group/group.js";
import { merge } from "../merge/merge.js";
import type { Raw } from "../snapshot/canonical.js";

const variantsOf = (r: Raw) =>
  (r.children ?? []).map((v) =>
    Object.entries((v.variantProperties ?? {}) as Record<string, string>)
      .sort()
      .map(([k, x]) => `${k}=${x}`)
      .join(","),
  );

/**
 * Which texts come from data is knowledge about the code, so the current Live decides it for all three
 * trees: a baseline or a designer's copy made before a text was known to be data still gets it (M6).
 */
export function withDataTags(tree: Raw, live: Raw): Raw {
  const data = new Set<string>();
  const collect = (n: Raw) => {
    if ((n as { dataText?: boolean }).dataText && typeof n.k === "string") data.add(n.k);
    for (const c of n.children ?? []) collect(c);
  };
  collect(live);
  const tag = (n: Raw): Raw => ({
    ...n,
    ...(typeof n.k === "string" && data.has(n.k) ? { dataText: true } : {}),
    ...(n.children ? { children: n.children.map(tag) } : {}),
  });
  return tag(tree);
}

/**
 * The designer's changes (three-way: base = the version they claimed, ours = their copy, theirs = Live now),
 * grouped into code-level changes with their version answers, and the example-text changes apart.
 */
export function deltaFor(p: {
  base: Raw;
  ours: Raw;
  theirs: Raw;
  dtcg: Record<string, unknown>;
  scopes?: Record<string, "all" | "variants">;
  designWins?: boolean;
}) {
  const m = merge(p.base, p.ours, p.theirs);
  // The developer settled the clash in the designer's favour: the clashing changes are delivered too.
  const clean = m.ours.filter((i) => i.merge === "clean" || (p.designWins && i.merge === "conflict"));
  // Text that comes from data (titles, prices…) is reported, but never sent to the code step.
  const changes: Change[] = group(
    clean.filter((i) => i.kind !== "data"),
    p.dtcg,
    variantsOf(p.theirs),
  );
  // The designer's answer for changes made in only some variants ("all" when not asked).
  for (const c of changes) if (c.variants !== "all") c.scope = p.scopes?.[changeKey(c)] ?? "all";
  const content = group(
    clean.filter((i) => i.kind === "data"),
    p.dtcg,
    variantsOf(p.theirs),
  );
  return { m, changes, content };
}
