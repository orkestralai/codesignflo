// "Bring your designs in": a file that already has the designer's own components and screens, joined to a
// project whose code already exists. Their designs are matched with Live, compared, and the designer decides
// per component: the design wins (a proposal, carried into a copy for them to check and send), the code
// wins, or later. What only the code has goes to them as "New in code"; what only the design has goes to the
// developer as new designs. Their screens can switch to the Live components.
import { comparable, diff, type Item, locate, matchByName, NODE, NS, type Raw } from "@codesignflo/core";
import { appendEvent, readIndex } from "./facts.js";
import { canonOf, check, claim, designPages, liveSet, RECONCILE } from "./panel.js";
import { applyOps, type Op } from "./rebase.js";

export type DesignItem = { nodeId: string; name: string; kind: "component" | "screen"; page: string };
type Saved = { at: string; pairs: Record<string, string | null>; decisions: Record<string, "design" | "code" | "later">; done?: boolean };

const saved = (): Saved | null => {
  const raw = figma.root.getSharedPluginData(NS, RECONCILE);
  return raw ? (JSON.parse(raw) as Saved) : null;
};
const save = (s: Saved) => figma.root.setSharedPluginData(NS, RECONCILE, JSON.stringify(s));

/** The designer's components (any depth) and screens (top-level frames, also inside top-level sections). */
async function designsInPages(): Promise<DesignItem[]> {
  const out: DesignItem[] = [];
  const ours = (n: BaseNode) => !!n.getSharedPluginData(NS, NODE.role) || !!n.getSharedPluginData(NS, NODE.k);
  for (const page of designPages()) {
    await page.loadAsync();
    for (const n of page.findAll((x) => x.type === "COMPONENT_SET" || (x.type === "COMPONENT" && x.parent?.type !== "COMPONENT_SET")))
      if (!ours(n)) out.push({ nodeId: n.id, name: n.name, kind: "component", page: page.name });
    const tops = page.children.flatMap((n) => (n.type === "SECTION" ? [...n.children] : [n]));
    for (const n of tops) if (n.type === "FRAME" && !ours(n)) out.push({ nodeId: n.id, name: n.name, kind: "screen", page: page.name });
  }
  return out;
}

/** What there is to bring in: the designer's items, Live's, suggested matches (or the ones saved last time). */
export async function scanDesigns() {
  const designs = await designsInPages();
  const live = readIndex()
    .filter((e) => e.liveNodeId)
    .map((e) => ({ key: e.component, kind: e.component.startsWith("pages.") ? ("screen" as const) : ("component" as const) }));
  const s = saved();
  const suggested = matchByName(
    designs.map((d) => ({ id: d.nodeId, name: d.name })),
    live.map((l) => l.key),
  );
  return { designs, live, pairs: { ...suggested, ...(s?.pairs ?? {}) }, decisions: s?.decisions ?? {} };
}

/** What differs in what one sees (token bindings for the same value aren't a difference). */
function visual(items: Item[]): Item[] {
  const unbound = (v: unknown) => JSON.stringify(v, (k, x) => (k === "boundVariables" ? undefined : x));
  return items.filter((i) => unbound(i.from) !== unbound(i.to));
}

/** The designer's item and its Live counterpart, made comparable (layers matched by name, placement aside). */
async function pairOf(nodeId: string, key: string) {
  const node = (await figma.getNodeByIdAsync(nodeId)) as SceneNode | null;
  if (!node) throw new Error("that design is no longer in the file");
  const live = await liveSet(key);
  const design = await canonOf(node);
  const [d, l] = comparable(design, await canonOf(live));
  return { node, live, design, d, l, reduced: live.type === "COMPONENT_SET" && design.type !== "COMPONENT_SET" };
}

/** Compares each matched pair; records the result in the history (the developer's status shows it). */
export async function compareDesigns(p: { pairs: Record<string, string | null> }) {
  const out: { nodeId: string; key: string; differences: number; examples: string[] }[] = [];
  for (const [nodeId, key] of Object.entries(p.pairs)) {
    if (!key) continue;
    const { d, l } = await pairOf(nodeId, key);
    const found = visual(diff(l, d));
    out.push({
      nodeId,
      key,
      differences: found.length,
      examples: found.slice(0, 3).map((i) => `${i.path.split(" / ").slice(1).join(" / ") || "(root)"} ${i.prop ?? i.op}`),
    });
    appendEvent({ kind: "compared", component: key, result: found.length ? "differs" : "matches", differences: found.length } as never);
  }
  const s = saved() ?? { at: "", pairs: {}, decisions: {} };
  save({ ...s, at: new Date().toISOString(), pairs: { ...s.pairs, ...p.pairs } });
  return { results: out };
}

/**
 * The design wins: the Live component is claimed and the designer's values are carried into the copy, so
 * they check it and send it like any proposal. Adding, removing or moving layers is listed, not carried.
 */
export async function designWins(p: { nodeId: string; key: string }) {
  const { d, l, reduced } = await pairOf(p.nodeId, p.key);
  const { proposalNodeId } = (await claim({ component: p.key })) as { proposalNodeId: string };
  const copy = (await figma.getNodeByIdAsync(proposalNodeId)) as SceneNode;
  const base = reduced && "children" in copy ? ((copy as ChildrenMixin).children[0] as SceneNode) : copy;
  const at = locate(l as Raw);
  const ops: Op[] = [];
  const left: string[] = [];
  for (const i of visual(diff(l, d))) {
    const path = at.get(i.target);
    let n: SceneNode | undefined = base;
    for (const x of path ?? []) n = n && "children" in n ? ((n as ChildrenMixin).children[x] as SceneNode) : undefined;
    if ((i.op ?? "change") === "change" && i.prop && path && n)
      ops.push({ nodeId: n.id, prop: i.prop, value: i.to, ...(i.toBound ? { bound: i.toBound } : {}) });
    else left.push(`${i.path.split(" / ").slice(1).join(" / ") || "(root)"}: ${i.op ?? i.prop}`);
  }
  const results = (await applyOps({ ops })).results;
  left.push(...results.flatMap((r, j) => (r.ok ? [] : [`${ops[j]!.prop}: ${r.error}`])));
  decide(p.key, "design");
  return { proposalNodeId, carried: results.filter((r) => r.ok).length, left };
}

/** The code's version stands, or the designer decides later. */
export function decide(key: string, decision: "design" | "code" | "later") {
  const s = saved() ?? { at: new Date().toISOString(), pairs: {}, decisions: {} };
  save({ ...s, decisions: { ...s.decisions, [key]: decision } });
  appendEvent({ kind: "compared", component: key, result: "differs", decision } as never);
  return { ok: true };
}

/** Built in code, not in the designer's files: back to "New in code" so they review each. */
export async function reviewInCode(p: { keys: string[] }) {
  for (const key of p.keys) {
    await check(key, { kind: "review_requested", component: key } as never);
    appendEvent({ kind: "review_requested", component: key } as never);
  }
  return { ok: true, count: p.keys.length };
}

/** The designer's screens use the Live component instead of their own (variants matched by their values). */
export async function useLive(p: { nodeId: string; key: string }) {
  const mine = (await figma.getNodeByIdAsync(p.nodeId)) as ComponentNode | ComponentSetNode | null;
  if (!mine) throw new Error("that design is no longer in the file");
  const live = await liveSet(p.key);
  const liveVariants = live.type === "COMPONENT_SET" ? (live.children as ComponentNode[]) : [live as ComponentNode];
  const props = (c: ComponentNode) => JSON.stringify(Object.entries(c.variantProperties ?? {}).sort());
  const target = (from: ComponentNode) =>
    liveVariants.find((v) => props(v) === props(from)) ?? liveVariants.find((v) => v.name === from.name) ?? liveVariants[0]!;
  const mains = new Set(mine.type === "COMPONENT_SET" ? mine.children.map((c) => c.id) : [mine.id]);
  let swapped = 0;
  for (const page of designPages()) {
    await page.loadAsync();
    // Instances the designer placed (layers inside other instances follow their own main component).
    for (const inst of page.findAll((n) => n.type === "INSTANCE" && !n.id.startsWith("I")) as InstanceNode[]) {
      if (inst.removed) continue;
      const main = await inst.getMainComponentAsync().catch(() => null);
      if (main && mains.has(main.id)) {
        inst.swapComponent(target(main));
        swapped++;
      }
    }
  }
  return { swapped };
}

/** Done for now: the guide's step is ticked (it can be run again any time). */
export function finishBringingIn() {
  const s = saved() ?? { at: "", pairs: {}, decisions: {} };
  save({ ...s, at: new Date().toISOString(), done: true });
  return { ok: true };
}
