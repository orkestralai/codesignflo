// Branch previews: a feature branch's components and pages, built in a "Branch: <name>" section on the Live
// page so the designer can look at them before the branch is merged. Only what differs from Live is built
// (pages that place a changed component differ too: they're compared with their components' layers in). Live
// itself, the history and the proposals are left alone: a preview records nothing.
import type { SpecNode } from "../compile/compile.js";
import { inlineInstances } from "../compile/compile.js";
import type { Proposal } from "./apply.js";
import { designAgainst, type Figma, specHashOf, type UpdateInput } from "./apply.js";

/** What a preview built: the keys that differ from Live, and what's in Live but not on the branch. */
export type PreviewResult = { built: string[]; removed: string[]; notes: string[] };

/** The spec each item is built from, and its hash — the same ones a Live update uses (so they compare). */
export function previewItems(input: Pick<UpdateInput, "sets" | "screens">): { key: string; spec: SpecNode; hash: string; page: boolean }[] {
  const mains = new Map(input.sets.flatMap((x) => (x.children ?? []).map((v) => [v.k, v] as const)));
  return [
    ...input.sets.map((set) => ({ key: set.k, spec: set, hash: specHashOf(set), page: false })),
    ...input.screens.map((sc) => {
      const spec = inlineInstances(sc.spec, mains);
      return { key: sc.spec.k, spec, hash: specHashOf(spec), page: true };
    }),
  ];
}

export async function applyPreview(
  s: Figma,
  input: UpdateInput,
  branch: string,
  log: (line: string) => void,
  onStep?: (done: number, total: number, item: string) => void,
): Promise<PreviewResult> {
  const items = previewItems(input);
  const notes: string[] = [];
  // Which differ from Live (or aren't in it), and what Live has that the branch doesn't.
  const plan = await s.call<{ differ: string[]; onlyInLive: string[] }>("previewPlan", {
    hashes: Object.fromEntries(items.map((x) => [x.key, x.hash])),
  });
  const differ = new Set(plan.differ);
  const todo = items.filter((x) => differ.has(x.key));
  // Pictures the pages use (downloaded by the caller into input.images).
  if (input.images && Object.keys(input.images).length) await s.call("putImages", { images: input.images }, { timeoutMs: 120_000 });
  await s.call("previewStart", { branch, commit: input.commit, keep: todo.map((x) => x.key) });
  let done = 0;
  const built: string[] = [];
  /** What each item was built as in the lane (its layers), to check designs against. */
  const builtIds = new Map<string, string>();
  for (const x of todo) {
    const name = x.key.replace(/^screen:/, "");
    try {
      const r = await s.call<{ id: string; stats: { errors: string[] } }>(
        x.page ? "reconcileScreen" : "reconcile",
        { spec: x.spec, specHash: x.hash, preview: branch },
        { timeoutMs: 180_000 },
      );
      for (const e of r.stats.errors) if (!e.startsWith("bind grid")) notes.push(`${name}: ${e}`);
      built.push(name);
      builtIds.set(name, r.id);
      // A page's screenshot beside it in the lane, as Live has its pages': the app as the branch builds it.
      const shot = x.page ? input.shots?.[name] : undefined;
      if (shot)
        await s.call("placeShot", { k: x.key, ...shot, preview: branch }).catch((e: Error) => {
          notes.push(`${name}: couldn't show the app's screenshot beside the page in the preview (${e.message})`);
        });
      log(`${name.padEnd(16)} differs from Live — in the preview`);
    } catch (e) {
      notes.push(`${name}: couldn't be built in the preview (${(e as Error).message})`);
    }
    onStep?.(++done, todo.length, name);
  }
  // The designs this branch builds, checked against what the lane really has (the CLI can only predict it: removed
  // or added layers aren't counted before Figma builds them). Claimed from this branch, or being built on it.
  const designs = new Map((input.designs ?? []).map((d) => [d.claim, { ...d }]));
  const facts = await s.call<{ proposals: Proposal[] }>("readFacts").catch(() => ({ proposals: [] as Proposal[] }));
  for (const p of (facts?.proposals ?? []).filter((x) => x.role === "proposal" && x.claim.readyHash)) {
    const component = p.claim.component;
    const builtId = builtIds.get(component.replace(/^screen:/, ""));
    if (!builtId || (p.claim.branch !== branch && !designs.has(p.claim.id))) continue;
    try {
      const c = await designAgainst(s, {
        copyId: p.nodeId,
        builtId,
        dtcg: input.dtcg,
        ...(p.claim.scopes ? { scopes: p.claim.scopes } : {}),
      });
      designs.set(p.claim.id, { claim: p.claim.id, component, done: c.done, total: c.total });
      // Kept on the copy: its row and label say how far it is on this branch until it's merged.
      await s.call("laneCheck", { id: p.nodeId, branch, done: c.done, total: c.total, conflicts: c.conflicts, commit: input.commit });
      log(
        `${component.replace(/^screen:/, "")}: the designer's design — ${c.done} of ${c.total} changes in ${branch}${c.done === c.total ? " (looks done: closes when it's merged)" : ""}`,
      );
    } catch (e) {
      notes.push(`${component}: couldn't check the design against the lane (${(e as Error).message})`);
    }
  }
  await s.call("previewEnd", {
    branch,
    commit: input.commit,
    built,
    removed: plan.onlyInLive,
    ...(input.lane ? { lane: input.lane } : {}),
    designs: [...designs.values()],
  });
  if (!todo.length) log(`${branch}: nothing differs from Live`);
  if (plan.onlyInLive.length) log(`not on ${branch} (removed there): ${plan.onlyInLive.map((k) => k.replace(/^screen:/, "")).join(", ")}`);
  return { built, removed: plan.onlyInLive.map((k) => k.replace(/^screen:/, "")), notes };
}
