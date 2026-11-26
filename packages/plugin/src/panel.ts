// Designer actions (main thread). They work with no CLI running: each one writes its fact into the file
// (a design-side event, and the claim record on the proposal) and the developer's next sync picks it up.

import {
  type Change,
  type ComponentState,
  canonicalize,
  changeKey,
  group,
  hash,
  type IndexEntry,
  initialState,
  keyOfTitle,
  keysById,
  LAYOUT,
  type LedgerEvent,
  locate,
  merge,
  NODE,
  NS,
  pageNames,
  step,
  stringify,
} from "@codesignflo/core";
import { markPending } from "./designsystem.js";
import { isOriginal, keyOf, pinsOf, shotOf, tag } from "./executor.js";
import {
  appendEvent,
  claimOf,
  designerLane,
  enter,
  events,
  isLabel,
  laneCheckOf,
  me,
  meta,
  PREVIEW,
  proposals,
  readBase,
  readIndex,
  SHOT,
  sectionIfAny,
  sections,
  shotsFor,
  stack,
  toArchive,
  writeBase,
  writeClaim,
} from "./facts.js";
import { editable } from "./guard.js";
import { applyOps, type Op } from "./rebase.js";
import { snapshot } from "./serialize.js";

export type PanelRow = {
  component: string;
  name: string;
  state: ComponentState["state"];
  unseen: boolean;
  conflict: boolean;
  note?: string;
  question?: string;
  /** The developer's review of what was sent, before building it (and the designer's answer). */
  review?: NonNullable<ComponentState["claim"]>["review"];
  /** Who claimed it (the designer working on it). */
  claimedBy?: string;
  /** The developer building what was sent. */
  builder?: string;
  whatsNew?: string;
  liveNodeId?: string;
  /** Only on this branch's lane, not in Live yet: claimed as that branch's version. */
  branch?: string;
  /** Sent, and being built on a branch: how far, as that branch's lane last found it. */
  onBranch?: { branch: string; done: number; total: number };
  proposalNodeId?: string;
  /** Designer actions recorded since the last sync (not yet seen by the developer). */
  pending: number;
  /** Sent proposals: how many of the designer's changes the code already has. */
  progress?: { done: number; total: number };
  /** The current claim (proposal), if any. */
  claim?: string;
  /** Kept as design in Live: layer key → properties (or ["*"]). */
  pins?: Record<string, string[]>;
  /** Where Live can't look like the app (a font missing in Figma). */
  warning?: string;
  /** Where Live differs from the app as the browser drew it. */
  differs?: string[];
  /** Share of its layers matching the app (0–100), and how many layers were fitted to it after building. */
  score?: number;
  fitted?: number;
  /** How closely the app follows the designer's design (%), and the previous update's figure. */
  designMatch?: { now: number; was?: number };
  /** Changes when the picture changes (Live generation, or the proposal): the panel refetches its thumbnail. */
  version: string;
  /** In design: whether the copy differs from the Live version it was claimed from (else nothing to send yet). */
  edited?: boolean;
};

export type PanelState = {
  setUp: boolean;
  /** The designer's own designs in this file (outside Live and Proposals): top-level frames and components. */
  ownDesigns?: { components: number; frames: number; pages: number };
  /** Live components and pages the code no longer has, moved to Archive: the designer deletes or keeps them. */
  removedFromCode?: { nodeId: string; name: string; commit: string }[];
  /** "Bring your designs in" was done in this file (existing designs matched with Live). */
  reconciled?: boolean;
  /** Pages left in this file (Starter plan: 3 per file). */
  pagesLeft?: number;
  projectId?: string;
  lastSyncAt?: string;
  /** The commit Live was last updated from. */
  lastSyncCommit?: string;
  user: string | null;
  rows: PanelRow[];
  /** Several frames selected: each can be sent as a new design (names from the frames). */
  many?: { nodeId: string; name: string; key: string; taken: boolean; wide: boolean }[];
  /** What the designer has selected on the canvas (for "New design"), if it can be sent as one. */
  selection?: {
    name: string;
    key: string;
    exists: boolean;
    copyOf?: string;
    claimable?: boolean;
    /** Who has it claimed, when it isn't claimable. */
    claimedBy?: string;
    /** This frame was already sent as a new design (it is the proposal itself). */
    sent?: boolean;
    /** Keys of every component and new design, so the panel can check a typed name as it changes. */
    taken?: string[];
    /** Wide enough to be a whole page (the panel then suggests "Page"). */
    wide?: boolean;
  } | null;
};

const fromIndex = (e: IndexEntry): ComponentState => ({
  ...initialState(e.component),
  state: e.state,
  unseen: e.unseen,
  conflict: e.conflict,
  ...(e.lastGen ? { lastGen: e.lastGen } : {}),
  ...(e.pins ? { pins: e.pins } : {}),
  ...(e.claim
    ? {
        claim: {
          id: e.claim.id,
          by: e.claim.by,
          baselineGen: e.claim.baselineGen,
          ...(e.claim.note ? { note: e.claim.note } : {}),
          ...(e.claim.question ? { question: e.claim.question } : {}),
        },
      }
    : {}),
});

/** State as of the last sync (index), with the designer's own unsynced events applied on top. */
async function current(): Promise<{ index: IndexEntry[]; states: Map<string, ComponentState>; pending: LedgerEvent[] }> {
  const index = readIndex();
  const states = new Map(index.map((e) => [e.component, fromIndex(e)]));
  const pending = events().sort((a, b) => (a.at < b.at ? -1 : 1));
  for (const e of pending) {
    const s = states.get(e.component) ?? initialState(e.component);
    states.set(e.component, step(s, e));
  }
  return { index, states, pending };
}

export async function state(): Promise<PanelState> {
  const m = meta();
  if (!m) return { setUp: false, user: figma.currentUser?.name ?? null, rows: [], ...(await designsInFile()) };
  const { index, states, pending } = await current();
  const openCopies = (await proposals()).filter((p) => p.role === "proposal");
  const open = new Map(openCopies.map((p) => [p.claim.component, p.node.id]));
  // Sent designs a branch builds: how far, as its lane last found it (kept on the copy).
  const onBranch = new Map(
    openCopies.flatMap((p) => {
      const c = p.claim.readyHash ? laneCheckOf(p.node) : null;
      return c ? [[p.claim.component, { branch: c.branch, done: c.done, total: c.total }] as const] : [];
    }),
  );
  // A copy being changed: has anything changed yet? (The same comparison as the send screen's.)
  const edited = new Map<string, boolean>();
  for (const s of states.values()) {
    const id = s.state === "in_design" ? open.get(s.component) : undefined;
    if (!id) continue;
    try {
      const node = (await figma.getNodeByIdAsync(id)) as SceneNode | null;
      const base = node ? (readBase(node) as Parameters<typeof merge>[0] | null) : null;
      if (node && base) edited.set(s.component, merge(base, await canonOf(node), base).ours.length > 0);
    } catch {
      // Can't tell: as before (Ready for dev stays available).
    }
  }
  const rows: PanelRow[] = [...states.values()]
    // A withdrawn new design leaves nothing behind (no code, no claim).
    .filter((s) => s.lastGen || s.claim || s.state !== "in_sync" || index.some((x) => x.component === s.component))
    .map((s) => {
      const e = index.find((x) => x.component === s.component);
      return {
        component: s.component,
        name: e?.name ?? s.component,
        state: s.state,
        unseen: s.unseen,
        conflict: s.conflict,
        ...(s.claim?.note ? { note: s.claim.note } : {}),
        ...(s.claim?.question ? { question: s.claim.question } : {}),
        ...(s.claim?.review ? { review: s.claim.review } : {}),
        ...(s.claim?.by ? { claimedBy: s.claim.by } : {}),
        ...(s.claim?.builder ? { builder: s.claim.builder.by } : {}),
        ...(e?.whatsNew ? { whatsNew: e.whatsNew } : {}),
        ...(e?.liveNodeId ? { liveNodeId: e.liveNodeId } : {}),
        ...(open.get(s.component) ? { proposalNodeId: open.get(s.component) } : {}),
        ...(onBranch.get(s.component) ? { onBranch: onBranch.get(s.component) } : {}),
        ...(edited.has(s.component) ? { edited: edited.get(s.component) } : {}),
        pending: pending.filter((p) => p.component === s.component).length,
        version: `${s.lastGen ?? ""}|${s.claim?.id ?? ""}`,
        ...(s.claim?.id ? { claim: s.claim.id } : {}),
        ...(s.pins ? { pins: s.pins } : {}),
        ...(e?.warning ? { warning: e.warning } : {}),
        ...(e?.differs?.length ? { differs: e.differs } : {}),
        ...(e?.score !== undefined ? { score: e.score } : {}),
        ...(e?.fitted ? { fitted: e.fitted } : {}),
        ...(e?.designMatch ? { designMatch: e.designMatch } : {}),
        ...(e?.claim?.done && e.claim.total ? { progress: { done: e.claim.done, total: e.claim.total } } : {}),
      };
    });
  // Components and pages only on a branch (its lane): claimable as that branch's version.
  for (const [component, [first]] of await laneItems()) {
    if (rows.some((r) => r.component === component) || !first) continue;
    rows.push({
      component,
      name: first.node.name,
      state: "in_sync",
      unseen: false,
      conflict: false,
      liveNodeId: first.node.id,
      branch: first.branch,
      pending: 0,
      version: `lane:${first.branch}`,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return {
    setUp: true,
    projectId: m.projectId,
    ...(m.lastSyncAt ? { lastSyncAt: m.lastSyncAt } : {}),
    ...(m.lastSyncCommit ? { lastSyncCommit: m.lastSyncCommit } : {}),
    user: figma.currentUser?.name ?? null,
    rows,
    selection: newDesignSelection(states),
    ...manySelected(states),
    ...(await removedFromCode()),
    ...(await designsInFile()),
    reconciled: /"done":true/.test(figma.root.getSharedPluginData(NS, RECONCILE)),
  };
}

/** Where "Bring your designs in" keeps its matches and decisions (on the file's root). */
export const RECONCILE = "reconcile";

/** The designer's pages: everything but CoDesignFlo's own (Live, Proposals, Design System). */
export const designPages = () =>
  figma.root.children.filter((p) => p.name !== LAYOUT.live.page && p.name !== LAYOUT.proposals.page && p.name !== LAYOUT.system.page);

let designsCache: { at: number; value: Pick<PanelState, "ownDesigns" | "pagesLeft"> } | null = null;
/** Counted at most every 30 s: other pages have to be loaded to look inside them. */
async function designsInFile(): Promise<Pick<PanelState, "ownDesigns" | "pagesLeft">> {
  if (designsCache && Date.now() - designsCache.at < 30_000) return designsCache.value;
  let components = 0;
  let frames = 0;
  const pages = designPages();
  for (const page of pages) {
    await page.loadAsync();
    for (const n of page.children) {
      if (n.getSharedPluginData(NS, NODE.role)) continue; // CoDesignFlo's own (intro cards…)
      if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") components++;
      else if (n.type === "FRAME" || n.type === "SECTION") frames++;
    }
  }
  const value = { ownDesigns: { components, frames, pages: pages.length }, pagesLeft: Math.max(0, 3 - figma.root.children.length) };
  designsCache = { at: Date.now(), value };
  return value;
}

/** The single top-level frame/component the designer selected, outside CoDesignFlo's own sections. */
function newDesignSelection(states: Map<string, ComponentState>): PanelState["selection"] {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) return null;
  const n = sel[0]!;
  if (!["FRAME", "COMPONENT", "COMPONENT_SET", "GROUP", "INSTANCE"].includes(n.type)) return null;
  // A copy of a Live component (e.g. Cmd+D) made without Claim: offer to claim that copy. It carries
  // the original's data (role "live" too); it is a copy because it isn't the original node.
  const role = n.getSharedPluginData(NS, NODE.role);
  if (role === "proposal") {
    const c = claimOf(n);
    return c && states.get(c.component)?.state === "design_new" ? { name: n.name, key: c.component, exists: true, sent: true } : null;
  }
  if (role && role !== "live") return null;
  const k = n.getSharedPluginData(NS, NODE.k);
  if (k) {
    if (isOriginal(n) || k.includes("/")) return null;
    const st = states.get(k) ?? initialState(k);
    const claimable = st.state === "in_sync" || st.state === "code_new" || st.state === "ignored";
    return { name: n.name, key: k, exists: true, copyOf: k, claimable, ...(!claimable && st.claim?.by ? { claimedBy: st.claim.by } : {}) };
  }
  const key = keyOfTitle(n.name);
  if (!key) return null;
  const st = states.get(key);
  const taken = [...states.values()].filter((s) => s.lastGen || s.claim).map((s) => s.component);
  return { name: n.name, key, exists: !!(st && (st.lastGen || st.claim)), taken, wide: n.width >= 900 };
}

/** Several of the designer's own frames selected: they can go to the developer together. */
function manySelected(states: Map<string, ComponentState>): Pick<PanelState, "many"> {
  const sel = figma.currentPage.selection;
  if (sel.length < 2) return {};
  const ok = sel.filter(
    (n) =>
      ["FRAME", "COMPONENT", "COMPONENT_SET", "GROUP"].includes(n.type) &&
      !n.getSharedPluginData(NS, NODE.role) &&
      !n.getSharedPluginData(NS, NODE.k),
  );
  if (ok.length < 2) return {};
  return {
    many: ok.map((n) => {
      const key = keyOfTitle(n.name);
      const st = states.get(key);
      return { nodeId: n.id, name: n.name, key, taken: !key || !!(st && (st.lastGen || st.claim)), wide: n.width >= 900 };
    }),
  };
}

/** Rejects an action the state machine would not accept (same rules as the developer's ledger). */
export async function check(component: string, e: Omit<LedgerEvent, "id" | "at" | "by">) {
  const { states } = await current();
  const before = states.get(component) ?? initialState(component);
  const after = step(
    JSON.parse(JSON.stringify(before)) as ComponentState,
    { ...e, id: "check", at: new Date().toISOString(), by: "check" } as LedgerEvent,
  );
  if (after.warnings.length > before.warnings.length) throw new Error(after.warnings[after.warnings.length - 1]);
  return before;
}

/**
 * What the branches' lanes hold, by component or page: each lane's own items (a new component on feat/x, or its
 * version of one Live has). The first lane that has an item wins for rows; a claim names the lane it's from.
 */
async function laneItems(): Promise<Map<string, { node: SceneNode; branch: string }[]>> {
  const page = (await sections.components()).parent;
  const out = new Map<string, { node: SceneNode; branch: string }[]>();
  if (page?.type !== "PAGE") return out;
  for (const sec of page.children) {
    const branch = sec.type === "SECTION" ? sec.getSharedPluginData(NS, PREVIEW.of) : "";
    if (!branch) continue;
    for (const n of (sec as SectionNode).children) {
      const k = keyOf(n);
      if (!k || k.includes("/") || !isOriginal(n)) continue;
      const component = k.replace(/^screen:/, "");
      out.set(component, [...(out.get(component) ?? []), { node: n, branch }]);
    }
  }
  return out;
}

/**
 * What a claim copies: the lane item that was clicked (`from`: a branch's version), else Live's, else — a
 * component or page only on a branch — that branch's.
 */
async function claimSource(component: string, from?: string): Promise<{ node: SceneNode; branch?: string }> {
  if (from) {
    const n = (await figma.getNodeByIdAsync(from)) as SceneNode | null;
    const branch = n?.parent?.type === "SECTION" ? n.parent.getSharedPluginData(NS, PREVIEW.of) : "";
    if (n && branch && keyOf(n).replace(/^screen:/, "") === component) return { node: n, branch };
  }
  try {
    return { node: await liveSet(component) };
  } catch (e) {
    const lane = (await laneItems()).get(component)?.[0];
    if (lane) return lane;
    throw e;
  }
}

export async function liveSet(component: string): Promise<ComponentSetNode | ComponentNode> {
  const e = readIndex().find((x) => x.component === component);
  const byId = e?.liveNodeId ? await figma.getNodeByIdAsync(e.liveNodeId) : null;
  if (byId && (byId.type === "COMPONENT_SET" || byId.type === "COMPONENT" || byId.type === "FRAME")) return byId as ComponentSetNode;
  const lib = await sections.components();
  const found = lib.findOne((n) => keyOf(n) === component && isOriginal(n));
  if (!found || (found.type !== "COMPONENT_SET" && found.type !== "COMPONENT"))
    throw new Error(`Live component ${component} not found — ask the developer to sync`);
  return found;
}

/** The designer's open copy: the one of the current claim (several copies can exist), else the newest. */
async function openProposal(component: string): Promise<SceneNode> {
  const open = (await proposals()).filter((x) => x.role === "proposal" && x.claim.component === component);
  if (!open.length) throw new Error(`no open proposal for ${component}`);
  const claimId = (await current()).states.get(component)?.claim?.id;
  const p = open.find((x) => x.claim.id === claimId) ?? [...open].sort((a, b) => (a.claim.at < b.claim.at ? 1 : -1))[0]!;
  return p.node;
}

/** Puts a node on top of a section (newest first; the rest moves down). */
function place(section: SectionNode, node: SceneNode) {
  section.appendChild(node);
  enter(node);
  stack(section);
}

/**
 * The component or page the canvas selection belongs to (its Live root, a proposal or archived copy), so the
 * panel can point at its row — the other way round from clicking a row.
 */
export function selectedComponent(): { component?: string; from?: string; branch?: string; why?: string } {
  const first = figma.currentPage.selection[0];
  if (!first) return {};
  for (let n: BaseNode | null = first; n && n.type !== "PAGE" && n.type !== "DOCUMENT"; n = n.parent) {
    const claim = claimOf(n);
    if (claim) return { component: claim.component };
    // A screenshot: the page it shows (in a lane's screenshots, that branch's page).
    const of = n.getSharedPluginData(NS, NODE.role) === SHOT.role ? n.getSharedPluginData(NS, SHOT.of) : "";
    if (of && !of.includes("/") && of.startsWith("screen:")) {
      const lane = n.parent?.type === "SECTION" ? n.parent.getSharedPluginData(NS, PREVIEW.shotsOf) : "";
      const laneSec = lane
        ? ((n.parent?.parent as PageNode | null)?.findChild(
            (s) => s.type === "SECTION" && s.getSharedPluginData(NS, PREVIEW.of) === lane,
          ) as SectionNode | null)
        : null;
      const page = laneSec?.findChild((x) => keyOf(x) === of && isOriginal(x)) ?? null;
      return { component: of.replace(/^screen:/, ""), ...(page ? { from: page.id, branch: lane } : {}) };
    }
    const k = keyOf(n);
    if (k && !k.includes("/")) {
      // In a branch's lane: that branch's version.
      const lane = n.parent?.type === "SECTION" ? n.parent.getSharedPluginData(NS, PREVIEW.of) : "";
      return { component: k.replace(/^screen:/, ""), ...(lane && isOriginal(n as SceneNode) ? { from: n.id, branch: lane } : {}) };
    }
  }
  // Something that isn't a component or page: say why it can't be claimed.
  if (first.type === "SECTION") return { why: "That's a section: click a component or page inside it to claim it." };
  if (isLabel(first)) return { why: "That's a label: click the component or page beside it." };
  return { why: "Not a component or page from the code: send your own design with New design instead." };
}

export async function show(p: { nodeId: string }) {
  const n = (await figma.getNodeByIdAsync(p.nodeId)) as SceneNode | null;
  if (!n) throw new Error("that layer no longer exists");
  let pageNode: BaseNode | null = n;
  while (pageNode && pageNode.type !== "PAGE") pageNode = pageNode.parent;
  if (pageNode) await figma.setCurrentPageAsync(pageNode as PageNode);
  figma.currentPage.selection = [n];
  figma.viewport.scrollAndZoomIntoView([n]);
  return { ok: true };
}

export const canonOf = async (n: SceneNode) => {
  const s = await snapshot(n);
  return canonicalize(s.tree, { variables: s.variables, styles: s.styles, ignoreRootName: true });
};

/**
 * A claimed page's copy gets the app's screenshot of it too: a copy of Live's, level with it in Proposals →
 * Screenshots (so the designer redesigns with the app as built beside it). Gone when the copy leaves Active.
 */
export async function shotForCopy(live: SceneNode, copy: SceneNode) {
  const liveShots = await sectionIfAny(LAYOUT.live.page, LAYOUT.live.sections.screenshots);
  const shot = liveShots ? shotOf(liveShots, keyOf(live)) : null;
  if (!shot) return;
  const lane = await shotsFor(copy);
  if (!lane) return;
  const c = shot.clone();
  lane.shots.appendChild(c);
  c.setSharedPluginData(NS, SHOT.of, copy.id);
  editable(c);
  stack(lane.items);
}

export async function claim(p: { component: string; from?: string }) {
  const before = await check(p.component, { kind: "claimed", component: p.component, claim: "check", baselineGen: "check" } as never);
  // Live's version, or a branch's (a lane item clicked, or a component or page only on a branch).
  const source = await claimSource(p.component, p.from);
  const live = source.node as ComponentSetNode;
  // A branch's version has no Live generation: the copy's own snapshot (written below) is its baseline.
  const baselineGen = source.branch ? "" : live.getSharedPluginData(NS, NODE.gen) || before.lastGen || "";
  const base = await canonOf(live);
  const copy = live.clone();
  editable(copy); // Live's inside is locked; the designer's copy is theirs to edit
  writeBase(copy, base);
  place(await designerLane(me()), copy);
  const record = {
    id: `c${Date.now().toString(36)}`,
    component: p.component,
    by: me().name,
    ...(me().id ? { byId: me().id } : {}),
    at: new Date().toISOString(),
    baselineGen,
    ...(source.branch ? { branch: source.branch } : {}),
  };
  copy.setSharedPluginData(NS, NODE.role, "proposal");
  writeClaim(copy, record);
  if (!source.branch) await shotForCopy(live, copy);
  appendEvent({
    kind: "claimed",
    component: p.component,
    claim: record.id,
    baselineGen,
    ...(source.branch ? { branch: source.branch } : {}),
  } as never);
  await show({ nodeId: copy.id });
  return { proposalNodeId: copy.id };
}

/** Claim a copy the designer already made (Cmd+D) instead of a fresh one: it moves to your lane in Proposals. */
export async function adopt() {
  const sel = figma.currentPage.selection;
  const n = sel.length === 1 ? sel[0]! : null;
  const k = n?.getSharedPluginData(NS, NODE.k);
  const role = n?.getSharedPluginData(NS, NODE.role);
  if (!n || !k || isOriginal(n) || (role && role !== "live")) throw new Error("select a copy of a Live component");
  const before = await check(k, { kind: "claimed", component: k, claim: "check", baselineGen: "check" } as never);
  // The copy carries the generation of the Live component it was made from: that is its merge base.
  const baselineGen = n.getSharedPluginData(NS, NODE.gen) || before.lastGen || "";
  place(await designerLane(me()), n);
  n.locked = false;
  // The copy was made from Live at some point; today's Live is the best baseline we have.
  writeBase(n, await canonOf(await liveSet(k)));
  const record = {
    id: `c${Date.now().toString(36)}`,
    component: k,
    by: me().name,
    ...(me().id ? { byId: me().id } : {}),
    at: new Date().toISOString(),
    baselineGen,
  };
  n.setSharedPluginData(NS, NODE.role, "proposal");
  writeClaim(n, record);
  // The copy has the Live page's key: its screenshot is found by it.
  await shotForCopy(n, n);
  appendEvent({ kind: "claimed", component: k, claim: record.id, baselineGen } as never);
  await show({ nodeId: n.id });
  return { proposalNodeId: n.id };
}

export type PreviewChange = Change & {
  key: string;
  conflict?: boolean;
  /** The layers in the designer's copy this change is on (to select them). */
  nodeIds?: string[];
  /** Writes the claimed version's values back (undo this change); absent when it can't be undone here. */
  undo?: Op[];
};
export type Preview = { changes: PreviewChange[]; content: Change[]; already: Change[]; variants: string[]; codeMoved: boolean };

/**
 * What the designer changed, computed here in Figma with the same three-way merge as the developer's
 * `delta`: the copy against the Live version it was made from (stored on the copy), with today's Live to
 * flag overlaps. Changes the developer already made the same way are listed apart ("already in code").
 */
/**
 * The version a copy was claimed from, as it is now: Live's, or — claimed from a branch's lane — that lane's (the
 * copy's own starting point when the lane is gone: merged, or disconnected).
 */
async function claimedVersion(component: string, copy: SceneNode) {
  const branch = claimOf(copy)?.branch;
  if (!branch) return canonOf(await liveSet(component));
  const lane = (await laneItems()).get(component)?.find((x) => x.branch === branch);
  if (lane) return canonOf(lane.node);
  const base = readBase(copy) as Awaited<ReturnType<typeof canonOf>> | null;
  if (base) return base;
  return canonOf(await liveSet(component));
}

export async function preview(p: { component: string }): Promise<Preview> {
  const node = await openProposal(p.component);
  const live = await claimedVersion(p.component, node);
  const base = (readBase(node) as ReturnType<typeof canonicalize> | null) ?? live;
  const m = merge(base, await canonOf(node), live);
  const variants = (live.children ?? []).map((v) =>
    Object.entries((v.variantProperties ?? {}) as Record<string, string>)
      .sort()
      .map(([k, x]) => `${k}=${x}`)
      .join(","),
  );
  const conflicting = new Set(m.ours.filter((i) => i.merge === "conflict").map((i) => i.id));
  const mine = m.ours.filter((i) => i.merge !== "convergent");
  // Where each change is in the copy (child-index paths in the same tree shape as the snapshot).
  const at = locate(await canonOf(node));
  const nodeOf = (target: string): SceneNode | null => {
    const path = at.get(target);
    if (!path) return null;
    let n: SceneNode = node;
    for (const i of path) {
      const kids = "children" in n ? (n.children as readonly SceneNode[]) : [];
      if (!kids[i]) return null;
      n = kids[i]!;
    }
    return n;
  };
  const byId = new Map(m.ours.map((i) => [i.id, i]));
  const place = (c: Change): Pick<PreviewChange, "nodeIds" | "undo"> => {
    const items = c.items.map((id) => byId.get(id)).filter((i) => !!i);
    const nodes = items.map((i) => nodeOf(i.target));
    const nodeIds = [...new Set(nodes.filter((n) => !!n).map((n) => n!.id))];
    // Undo: property changes only (adding, removing or moving layers is undone in Figma itself).
    const undoable = items.length && items.every((i, j) => (i.op ?? "change") === "change" && i.prop && nodes[j]);
    const undo = undoable
      ? items.map((i, j) => ({ nodeId: nodes[j]!.id, prop: i.prop!, value: i.from, ...(i.fromBound ? { bound: i.fromBound } : {}) }))
      : undefined;
    return { ...(nodeIds.length ? { nodeIds } : {}), ...(undo ? { undo } : {}) };
  };
  return {
    changes: group(
      mine.filter((i) => i.kind !== "data"),
      {},
      variants,
    ).map((c) => ({ ...c, key: changeKey(c), ...(c.items.some((id) => conflicting.has(id)) ? { conflict: true } : {}), ...place(c) })),
    content: group(
      mine.filter((i) => i.kind === "data"),
      {},
      variants,
    ),
    already: group(
      m.ours.filter((i) => i.merge === "convergent" && i.kind !== "data"),
      {},
      variants,
    ),
    variants,
    codeMoved: m.summary.codeChanges > 0,
  };
}

/** Selects the layers of a change in the designer's copy and zooms to them. */
export async function select(p: { nodeIds: string[] }) {
  const nodes = (await Promise.all(p.nodeIds.map((id) => figma.getNodeByIdAsync(id)))).filter((n): n is SceneNode => !!n && "visible" in n);
  if (!nodes.length) throw new Error("that layer is no longer in your copy");
  let page: BaseNode | null = nodes[0]!;
  while (page && page.type !== "PAGE") page = page.parent;
  if (page) await figma.setCurrentPageAsync(page as PageNode);
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
  return { ok: true };
}

/** Undoes one change in the designer's copy (writes back the values of the version they claimed). */
export async function undo(p: { ops: Op[] }) {
  const { results } = await applyOps({ ops: p.ops });
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(`couldn't undo everything: ${failed.map((f) => f.error).join("; ")}`);
  return { ok: true };
}

export async function ready(p: { component: string; note: string; scopes?: Record<string, "all" | "variants"> }) {
  const note = p.note.trim();
  if (!note) throw new Error("add a short note for the developer");
  const node = await openProposal(p.component);
  const record = claimOf(node);
  if (!record) throw new Error("this copy has no claim");
  await check(p.component, { kind: "ready", component: p.component, claim: record.id, note, readyHash: "check" } as never);
  // The hash of the proposal as it is now; if it changes after "ready", sync moves it back to "in design".
  const snap = await snapshot(node);
  const readyHash = hash(stringify(canonicalize(snap.tree, { variables: snap.variables, styles: snap.styles })));
  writeClaim(node, { ...record, note, readyHash, ...(p.scopes && Object.keys(p.scopes).length ? { scopes: p.scopes } : {}) });
  appendEvent({ kind: "ready", component: p.component, claim: record.id, note, readyHash } as never);
  // The proposal itself for the service (signed in): the developer gets it without Figma. Layer snapshots
  // only — no pictures.
  figma.ui.postMessage({
    kind: "cloudProposal",
    component: p.component,
    claim: record.id,
    payload: { note, by: record.by, scopes: p.scopes ?? {}, base: readBase(node), copy: await canonOf(node), figma: whereInFigma(node) },
  });
  return { ok: true };
}

export async function reopen(p: { component: string }) {
  // Designer wants to keep editing after "ready": unlock; the hash mismatch tells sync it changed.
  const node = await openProposal(p.component);
  const record = claimOf(node);
  node.locked = false;
  const { states } = await current();
  if (record && states.get(p.component)?.state === "ready_for_dev")
    appendEvent({ kind: "reopened", component: p.component, claim: record.id } as never);
  return { ok: true };
}

export async function unclaim(p: { component: string }) {
  const node = await openProposal(p.component);
  const record = claimOf(node);
  if (!record) throw new Error("this copy has no claim");
  await check(p.component, { kind: "unclaimed", component: p.component, claim: record.id } as never);
  await toArchive(node);
  appendEvent({ kind: "unclaimed", component: p.component, claim: record.id } as never);
  return { ok: true };
}

/** "New in code": the designer accepts it as is (→ In sync) or ignores it (no design review needed). */
export async function accept(p: { component: string }) {
  await check(p.component, { kind: "accepted", component: p.component } as never);
  appendEvent({ kind: "accepted", component: p.component } as never);
  return { ok: true };
}

export async function ignore(p: { component: string }) {
  await check(p.component, { kind: "ignored", component: p.component } as never);
  appendEvent({ kind: "ignored", component: p.component } as never);
  return { ok: true };
}

/**
 * "New design": a component that doesn't exist in code yet. A copy of the selected frame goes to
 * your lane in Proposals as the reference (the designer's original stays where it is); the developer's sync
 * turns it into a spec, `deliver` builds it, and it closes when it shows up in Storybook.
 */
export async function designNew(p: { name: string; note: string; kind?: "component" | "page" }) {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) throw new Error("select the frame with your design first");
  return designNewFrom(sel[0]!, p);
}

/**
 * Several designs at once (the designer usually starts with a page of them): components first in the
 * developer's queue, pages after, so pages can reuse the components. Stops at the first that can't go.
 */
/**
 * A design-only Library component (Design System) to the developer as a new design: a copy goes to Proposals
 * (the Library keeps the designer's), and once its code lands the Library component is linked to it by key.
 */
export async function sendLibraryNew(p: { nodeId: string; note: string }) {
  const n = (await figma.getNodeByIdAsync(p.nodeId)) as SceneNode | null;
  if (!n || !("clone" in n)) throw new Error("that component is no longer in the file");
  const copy = n.clone();
  const r = await designNewMany({ items: [{ nodeId: copy.id, name: n.name.split("/").pop()!.trim(), kind: "component" }], note: p.note });
  await markPending(n.id, r.sent[0]!);
  return r;
}

/** Where the design is, so the developer can open it in Figma (the file key only where Figma gives it). */
const whereInFigma = (n: SceneNode) => ({ nodeId: n.id, fileName: figma.root.name, ...(figma.fileKey ? { fileKey: figma.fileKey } : {}) });

export async function designNewMany(p: { items: { nodeId: string; name: string; kind: "component" | "page" }[]; note: string }) {
  const sent: string[] = [];
  // Components before pages; a component that uses another of these (an instance of it) after that one.
  const ids = new Set(p.items.map((i) => i.nodeId));
  const uses = new Map<string, Set<string>>();
  for (const it of p.items) {
    const node = (await figma.getNodeByIdAsync(it.nodeId)) as SceneNode | null;
    const used = new Set<string>();
    if (node && "findAll" in node)
      for (const inst of node.findAll((n) => n.type === "INSTANCE") as InstanceNode[]) {
        const main = await inst.getMainComponentAsync();
        const top = main?.parent?.type === "COMPONENT_SET" ? main.parent : main;
        if (top && ids.has(top.id) && top.id !== it.nodeId) used.add(top.id);
      }
    uses.set(it.nodeId, used);
  }
  const order: typeof p.items = [];
  const visit = (it: (typeof p.items)[number], seen = new Set<string>()) => {
    if (order.includes(it) || seen.has(it.nodeId)) return;
    seen.add(it.nodeId);
    for (const dep of uses.get(it.nodeId) ?? []) visit(p.items.find((x) => x.nodeId === dep)!, seen);
    order.push(it);
  };
  for (const it of [...p.items].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "component" ? -1 : 1))) visit(it);
  for (const it of order) {
    const node = (await figma.getNodeByIdAsync(it.nodeId)) as SceneNode | null;
    if (!node) throw new Error(`${it.name} is no longer in the file`);
    sent.push((await designNewFrom(node, { name: it.name, note: p.note, kind: it.kind })).component);
  }
  return { sent };
}

async function designNewFrom(node: SceneNode, p: { name: string; note: string; kind?: "component" | "page" }) {
  const name = p.name.trim();
  const note = p.note.trim();
  const kind = p.kind ?? "component";
  // A page gets the key its Storybook page story will produce ("Checkout" → pages.checkout-page).
  const key = kind === "page" ? (keyOfTitle(name) ? pageNames(name).key : "") : keyOfTitle(name);
  if (!key) throw new Error("give the component a name");
  if (!note) throw new Error("add a short note for the developer");
  const { states } = await current();
  const st = states.get(key);
  if (st && (st.lastGen || st.claim)) throw new Error(`${name} already exists — claim it instead, or pick another name`);
  const id = `n${Date.now().toString(36)}`;
  await check(key, { kind: "designed_new", component: key, claim: id, note } as never);
  // The frame itself moves to your lane in Proposals (M6: a copy left two frames to keep in step; Withdraw
  // gives it back). Unlocked first: a locked frame can't be moved by the designer later.
  const copy = node;
  copy.locked = false;
  copy.name = name;
  place(await designerLane(me()), copy);
  const snap = await snapshot(copy);
  const readyHash = hash(stringify(canonicalize(snap.tree, { variables: snap.variables, styles: snap.styles })));
  copy.setSharedPluginData(NS, NODE.role, "proposal");
  writeClaim(copy, {
    id,
    component: key,
    by: me().name,
    ...(me().id ? { byId: me().id } : {}),
    at: new Date().toISOString(),
    baselineGen: "",
    note,
    readyHash,
    name,
    kind,
  });
  appendEvent({ kind: "designed_new", component: key, claim: id, note } as never);
  figma.ui.postMessage({
    kind: "cloudProposal",
    component: key,
    claim: id,
    payload: {
      note,
      name,
      kind,
      spec: canonicalize(snap.tree, { variables: snap.variables, styles: snap.styles }),
      figma: whereInFigma(copy),
    },
  });
  return { proposalNodeId: copy.id, component: key };
}

/** Small pictures for the panel's rows: the Live component's first version, or the designer's copy. */
const thumbCache = new Map<string, string>();
export async function thumbs(p: { components: { component: string; version: string; nodeId?: string }[] }) {
  const out: Record<string, string> = {};
  for (const c of p.components) {
    const key = `${c.component}|${c.version}`;
    let png = thumbCache.get(key);
    if (!png && c.nodeId) {
      const n = (await figma.getNodeByIdAsync(c.nodeId)) as SceneNode | null;
      const target = n && n.type === "COMPONENT_SET" && n.children[0] ? (n.children[0] as SceneNode) : n;
      if (target && "exportAsync" in target && target.width > 0 && target.height > 0) {
        // About 96×64 at 2× for a crisp 48×32 thumbnail.
        const scale = Math.min(64 / target.height, 96 / target.width, 2);
        png = figma.base64Encode(
          await target.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale }, useAbsoluteBounds: true }),
        );
        thumbCache.set(key, png);
      }
    }
    if (png) out[c.component] = png;
  }
  return out;
}

/** The designer answers the developer's review question (the proposal itself stays as it is). */
export async function answerReview(p: { component: string; answer: string }) {
  const answer = p.answer.trim();
  if (!answer) throw new Error("write an answer first");
  const { states } = await current();
  const claim = states.get(p.component)?.claim?.id;
  if (!claim) throw new Error("nothing to answer here");
  await check(p.component, { kind: "review_answered", component: p.component, claim, answer } as never);
  appendEvent({ kind: "review_answered", component: p.component, claim, answer } as never);
  return { ok: true };
}

export async function seen(p: { component: string }) {
  appendEvent({ kind: "seen", component: p.component } as never);
  return { ok: true };
}

// ---- when the code can't do everything: accept the code's version, or keep the rest as design ----

/** The designer accepts the code as it is: the proposal closes; Live keeps showing the code. */
export async function acceptCode(p: { component: string }) {
  const node = await openProposal(p.component);
  const record = claimOf(node);
  if (!record) throw new Error("this copy has no claim");
  const e = { kind: "closed", component: p.component, claim: record.id, commit: "", items: [], how: "accepted" } as const;
  await check(p.component, e as never);
  await toArchive(node);
  appendEvent(e as never);
  return { ok: true };
}

/**
 * The designer keeps what the code doesn't do as design: each of their changes the code hasn't made is
 * written into Live and pinned there (updates from code leave it alone; the developer sees the list), and
 * the proposal closes. Layers the designer added are copied into Live and pinned whole. Removing or moving
 * layers can't be kept this way: those are reported, not kept.
 */
export async function keepDesign(p: { component: string }) {
  const node = await openProposal(p.component);
  const record = claimOf(node);
  if (!record) throw new Error("this copy has no claim");
  const closing = { kind: "closed", component: p.component, claim: record.id, commit: "", items: [], how: "kept" } as const;
  await check(p.component, closing as never);
  const live = await liveSet(p.component);
  const liveCanon = await canonOf(live);
  const copyCanon = await canonOf(node);
  const base = (readBase(node) as ReturnType<typeof canonicalize> | null) ?? liveCanon;
  const left = merge(base, copyCanon, liveCanon).ours.filter((i) => i.merge !== "convergent" && i.kind !== "data");
  const keys = keysById(copyCanon);
  const at = locate(copyCanon);
  const inCopy = (target: string): SceneNode | null => {
    let n: SceneNode = node;
    for (const i of at.get(target) ?? []) {
      const kids = "children" in n ? (n.children as readonly SceneNode[]) : [];
      if (!kids[i]) return null;
      n = kids[i]!;
    }
    return at.has(target) ? n : null;
  };
  const inLive = (key: string | undefined): SceneNode | null =>
    !key ? null : keyOf(live) === key ? live : (live.findOne((n) => keyOf(n) === key && isOriginal(n)) as SceneNode | null);
  const pins = new Map<string, Set<string>>();
  const pin = (key: string, prop: string) => pins.set(key, (pins.get(key) ?? new Set()).add(prop));
  const ops: Op[] = [];
  const notKept: string[] = [];
  for (const i of left) {
    const op = i.op ?? "change";
    if (op === "change" && i.prop) {
      const key = keys.get(i.target);
      const target = inLive(key);
      if (!key || !target) {
        notKept.push(`${i.path} ${i.prop}`);
        continue;
      }
      ops.push({ nodeId: target.id, prop: i.prop, value: i.to, ...(i.toBound ? { bound: i.toBound } : {}) });
      pin(key, i.prop);
    } else if (op === "add") {
      // A layer only the design has: a copy goes into Live, in the same place, kept whole.
      const added = inCopy(i.target);
      const parent = added?.parent ? inLive(keyOf(added.parent)) : null;
      if (!added || !parent || !("insertChild" in parent)) {
        notKept.push(`${i.path} (added layer)`);
        continue;
      }
      const copy = added.clone();
      const index = (added.parent as ChildrenMixin).children.indexOf(added);
      (parent as ChildrenMixin).insertChild(Math.min(index, (parent as ChildrenMixin).children.length), copy);
      for (const n of [copy, ...("findAll" in copy ? (copy as ChildrenMixin).findAll() : [])])
        for (const k of n.getSharedPluginDataKeys(NS)) n.setSharedPluginData(NS, k, "");
      const key = `${keyOf(parent)}/+${copy.name}`;
      tag(copy, key);
      pin(key, "*");
    } else notKept.push(`${i.path} (${op})`);
  }
  const results = (await applyOps({ ops })).results;
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(`couldn't keep everything: ${failed.map((f) => f.error).join("; ")}`);
  for (const [key, props] of pins) {
    const n = inLive(key);
    if (n) n.setSharedPluginData(NS, NODE.pin, JSON.stringify([...new Set([...pinsOf(n), ...props])]));
  }
  await toArchive(node);
  if (pins.size)
    appendEvent({
      kind: "kept",
      component: p.component,
      claim: record.id,
      pins: [...pins].map(([key, props]) => ({ key, props: [...props] })),
    } as never);
  appendEvent(closing as never);
  return { kept: [...pins.values()].reduce((n, s) => n + s.size, 0), notKept };
}

/** A kept property (or layer) follows the code again from the next update. */
export async function unpin(p: { component: string; key: string; props: string[] }) {
  const live = await liveSet(p.component);
  // The next update rebuilds it (the same code as last time would otherwise be skipped).
  live.setSharedPluginData(NS, NODE.specHash, "");
  const n = keyOf(live) === p.key ? live : live.findOne((x) => keyOf(x) === p.key && isOriginal(x));
  if (n) {
    const left = pinsOf(n).filter((x) => !p.props.includes(x));
    n.setSharedPluginData(NS, NODE.pin, left.length ? JSON.stringify(left) : "");
  }
  appendEvent({ kind: "unkept", component: p.component, key: p.key, props: p.props } as never);
  return { ok: true };
}

// ---- removed from the code: Live's copies in Archive, waiting for the designer's decision ----

async function removedFromCode(): Promise<Pick<PanelState, "removedFromCode">> {
  const archive = await sections.archive();
  const list = archive.children
    .filter((n) => n.getSharedPluginData(NS, NODE.removedFromCode))
    .map((n) => ({ nodeId: n.id, name: n.name, commit: n.getSharedPluginData(NS, NODE.removedFromCode) }));
  return list.length ? { removedFromCode: list } : {};
}

/** Instances in the file (outside CoDesignFlo's own pages) whose main component is in `root`. */
async function usesOf(root: SceneNode): Promise<number> {
  const mains = new Set(root.type === "COMPONENT_SET" ? root.children.map((c) => c.id) : [root.id]);
  let n = 0;
  for (const page of designPages()) {
    await page.loadAsync();
    for (const inst of page.findAll((x) => x.type === "INSTANCE" && !x.id.startsWith("I")) as InstanceNode[]) {
      const main = await inst.getMainComponentAsync().catch(() => null);
      if (main && mains.has(main.id)) n++;
    }
  }
  return n;
}

/** The designer deletes what the code removed (all, or some); instances of it in their screens are reported. */
export async function deleteRemoved(p: { nodeIds: string[]; confirmUses?: boolean }) {
  const nodes = (await Promise.all(p.nodeIds.map((id) => figma.getNodeByIdAsync(id)))).filter((n): n is SceneNode => !!n);
  if (!p.confirmUses) {
    const uses = (await Promise.all(nodes.map(usesOf))).reduce((a, b) => a + b, 0);
    if (uses) return { deleted: 0, uses };
  }
  for (const n of nodes) {
    n.locked = false;
    n.remove();
  }
  return { deleted: nodes.length, uses: 0 };
}

/** The designer keeps them in Archive: no longer asked about. */
export async function keepRemoved(p: { nodeIds: string[] }) {
  for (const id of p.nodeIds) (await figma.getNodeByIdAsync(id))?.setSharedPluginData(NS, NODE.removedFromCode, "");
  return { ok: true };
}
