// Methods the developer's CLI calls over the bridge. Nothing here runs unless the CLI is connected.
import { type ClaimRecord, NODE, NS } from "@codesignflo/core";
import * as ds from "./designsystem.js";
import * as executor from "./executor.js";
import * as facts from "./facts.js";
import { ackEvents, events, init, meta, proposals, writeClaim, writeIndex } from "./facts.js";
import * as panel from "./panel.js";
import { applyOps } from "./rebase.js";
import * as reconcile from "./reconcile.js";
import { snapshot } from "./serialize.js";

declare const __DEV__: boolean;

type Handler = (params: never, requestId: string) => unknown;

async function nodeFor(p: { id?: string; k?: string }): Promise<SceneNode> {
  if (p.id) {
    const n = await figma.getNodeByIdAsync(p.id);
    if (n && "visible" in n) return n as SceneNode;
    throw new Error(`no node ${p.id}`);
  }
  await figma.loadAllPagesAsync();
  const n = figma.root.findOne((x) => executor.keyOf(x) === p.k && executor.isOriginal(x));
  if (!n || n.type === "PAGE") throw new Error(`no node with key ${p.k}`);
  return n as SceneNode;
}

export const handlers: Record<string, Handler> = {
  ping: () => ({ now: Date.now() }),
  fileInfo: () => ({
    name: figma.root.name,
    projectId: meta()?.projectId ?? null,
    pages: figma.root.children.map((p) => p.name),
    user: figma.currentUser?.name ?? null,
  }),
  init: (p: { projectId: string; minPlugin?: string }) => init(p),
  snapshot: async (p: { id?: string; k?: string }) => snapshot(await nodeFor(p)),
  tokensPush: (p: { dtcg: Record<string, unknown> }) => executor.tokensPush(p),
  putImages: (p: { images: Record<string, string> }) => executor.putImages(p),
  missingImages: (p: { refs: string[] }) => executor.missingImages(p),
  placeShot: (p: Parameters<typeof executor.placeShot>[0]) => executor.placeShot(p),
  reconcile: (p: Parameters<typeof executor.reconcile>[0]) => executor.reconcile(p),
  reconcileScreen: (p: Parameters<typeof executor.reconcileScreen>[0]) => executor.reconcileScreen(p),
  ids: (p: { screens?: boolean }) => executor.ids(p),
  previewPlan: (p: Parameters<typeof executor.previewPlan>[0]) => executor.previewPlan(p),
  previewStart: (p: Parameters<typeof executor.previewStart>[0]) => executor.previewStart(p),
  previewEnd: (p: Parameters<typeof executor.previewEnd>[0]) => executor.previewEnd(p),
  previewRemove: (p: Parameters<typeof executor.previewRemove>[0]) => executor.previewRemove(p),
  lanesKeep: (p: Parameters<typeof executor.lanesKeep>[0]) => executor.lanesKeep(p),
  liveReport: () => executor.liveReport(),
  /** Design System: From-code copies and links after the components are built; then each pair's differences. */
  dsRefresh: () => ds.refresh(),
  dsReport: () => ds.report(),
  archiveLive: (p: { k: string; commit: string }) => executor.archiveLive(p),
  /** The generation each Live component shows (as tagged by the last sync that updated it). */
  gens: async () => {
    const out: Record<string, string> = {};
    for (const [k, id] of Object.entries(await executor.ids({}))) {
      if (k.includes("/")) continue;
      const n = await figma.getNodeByIdAsync(id as string);
      const g = n?.getSharedPluginData(NS, NODE.gen);
      if (g) out[k] = g;
    }
    return out;
  },
  exportVariants: (p: { setKeys?: string[] }) => executor.exportVariants(p),
  /** A developer's sync telling the panel how far its update is (the panel shows it; nothing to do here). */
  updateProgress: async () => null,
  exportNode: (p: { k?: string; id?: string; width?: number }) => executor.exportNode(p),
  applyOps: (p: Parameters<typeof applyOps>[0]) => applyOps(p),
  readFacts: async () => ({
    meta: meta(),
    events: events(),
    proposals: (await proposals()).map((x) => ({ nodeId: x.node.id, claim: x.claim, role: x.role, locked: x.node.locked })),
  }),
  writeIndex: async (p: Parameters<typeof writeIndex>[0]) => {
    await facts.dropWhatsNewPage(); // files set up before M6
    await facts.splitActive(); // files set up before designer lanes
    await facts.stackAll(); // proposals change size while the designer works
    return writeIndex(p);
  },
  ackEvents: (p: { ids: string[] }) => ackEvents(p),
  /** Record the generation a Live component now shows (computed by the CLI from the read-back snapshot). */
  setGen: async (p: { id: string; gen: string }) => {
    const n = await nodeFor({ id: p.id });
    if (n.getSharedPluginData(NS, NODE.gen) !== p.gen) n.setSharedPluginData(NS, NODE.gen, p.gen);
    return { ok: true };
  },
  /** Closed (or replaced) proposal: to the top of Proposals → Archive (newest first, not locked). */
  archiveProposal: async (p: { nodeId: string }) => {
    await facts.toArchive(await nodeFor({ id: p.nodeId }));
    return { ok: true };
  },
  /** Clone a node into the Proposals page (rebase: a fresh copy of the latest Live to carry clean items onto). */
  cloneToProposals: async (p: { id: string; claim: unknown; base?: unknown }) => {
    const src = await nodeFor({ id: p.id });
    const copy = (src as ComponentSetNode).clone();
    copy.locked = false;
    if (p.base) facts.writeBase(copy, p.base);
    const claim = p.claim as ClaimRecord;
    (await facts.designerLane(facts.designerOf(claim))).appendChild(copy);
    copy.setSharedPluginData(NS, NODE.role, "proposal");
    writeClaim(copy, p.claim as never);
    await panel.shotForCopy(src, copy);
    return { id: copy.id };
  },
};

if (__DEV__) {
  // Development builds only: run code sent by the CLI (lets the developer iterate without reopening the plugin).
  // Modules reachable from dev.eval (automated end-to-end tests drive the designer's panel through these).
  (globalThis as { __cdl?: unknown }).__cdl = { panel, facts, executor, reconcile, ds, serialize: { snapshot } };
  handlers["dev.eval"] = async (p: { code: string; args?: unknown }) =>
    new Function("figma", "args", "cdl", `return (async () => { ${p.code} })()`)(figma, p.args, (globalThis as { __cdl?: unknown }).__cdl);
  /**
   * Hot-reload: replace this plugin's code and panel with a new build, without the designer reopening it.
   * Answers first, then swaps: the new code takes over message handling and redraws the panel.
   */
  handlers["dev.reload"] = (p: { code: string; html: string }) => {
    setTimeout(() => {
      new Function(p.code)();
      figma.ui.postMessage({ kind: "reloadUi", html: p.html });
    }, 50);
    return { ok: true };
  };
}
