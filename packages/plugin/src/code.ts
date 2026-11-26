// codesignflo plugin — main thread. Routes panel actions (designer) and bridge requests (developer's CLI).
import type { PropMap } from "@codesignflo/core";
import type * as protocol from "@codesignflo/core/protocol";
import * as ds from "./designsystem.js";
import { demoShotsFromLive, onProgress } from "./executor.js";
import { clearFile, fileContents, forgetProject, init, meta, migrateLegacy, resetDemoFile } from "./facts.js";
import { handlers } from "./handlers.js";
import type { GuidePrefs, MainToUi, UiToMain } from "./messages.js";
import * as panel from "./panel.js";
import type { Op } from "./rebase.js";
import * as reconcile from "./reconcile.js";
import { tourClear, tourMark } from "./tourmark.js";

declare const __VERSION__: string;
declare const __DEV__: boolean;
declare const __SERVICE__: { url: string; anon: string; web: string; mode?: "cloud" | "selfhost" } | null;

// A development hot-reload re-runs this file inside the running plugin: the UI is already shown then.
const g = globalThis as { __cdlUiShown?: boolean };
if (!g.__cdlUiShown) {
  figma.showUI(__html__, { width: 380, height: 560, themeColors: true });
  g.__cdlUiShown = true;
}
const post = (m: MainToUi) => figma.ui.postMessage(m);
// A file set up before the rename moves its data to the new namespace before anything reads it.
const migrated = migrateLegacy().catch(() => 0);

/** Requests that change what the panel shows; after them the panel refreshes. */
const CHANGES = new Set(["init", "writeIndex", "ackEvents", "reconcile", "cloneToProposals", "archiveProposal"]);

/** Timing of the last requests and panel actions (development: read with dev.eval `globalThis.__cdfLog`). */
const g2 = globalThis as { __cdfLog?: { at: number; what: string; ms?: number }[] };
if (!g2.__cdfLog) g2.__cdfLog = [];
const log = g2.__cdfLog;
async function timed<T>(what: string, f: () => Promise<T>): Promise<T> {
  const entry: { at: number; what: string; ms?: number } = { at: Date.now(), what };
  log.push(entry);
  if (log.length > 80) log.shift();
  try {
    return await f();
  } finally {
    entry.ms = Date.now() - entry.at;
  }
}

async function handleRequest(req: protocol.Request) {
  await migrated;
  try {
    const fn = handlers[req.method];
    if (!fn) throw new Error(`unknown method ${req.method}`);
    const key = (req.params as { spec?: { k?: string } } | undefined)?.spec?.k;
    onProgress((done) => post({ kind: "progress", msg: { t: "progress", id: req.id, done } }));
    const result = await timed(`req ${req.method}${key ? ` ${key}` : ""}`, async () => fn(req.params as never, req.id));
    onProgress(null);
    post({ kind: "res", msg: { t: "res", id: req.id, ok: true, result } });
    if (CHANGES.has(req.method)) post({ kind: "changed" });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    post({
      kind: "res",
      msg: { t: "res", id: req.id, ok: false, error: { message: err.message, ...(err.stack ? { stack: err.stack } : {}) } },
    });
  }
}

const actions: Record<string, (p: never) => Promise<unknown>> = {
  state: () => panel.state(),
  claim: (p: { component: string }) => panel.claim(p),
  preview: (p: { component: string }) => panel.preview(p),
  ready: (p: { component: string; note: string; scopes?: Record<string, "all" | "variants"> }) => panel.ready(p),
  reopen: (p: { component: string }) => panel.reopen(p),
  unclaim: (p: { component: string }) => panel.unclaim(p),
  seen: (p: { component: string }) => panel.seen(p),
  answerReview: (p: { component: string; answer: string }) => panel.answerReview(p),
  accept: (p: { component: string }) => panel.accept(p),
  ignore: (p: { component: string }) => panel.ignore(p),
  show: (p: { nodeId: string }) => panel.show(p),
  designNew: (p: { name: string; note: string; kind?: "component" | "page" }) => panel.designNew(p),
  designNewMany: (p: { items: { nodeId: string; name: string; kind: "component" | "page" }[]; note: string }) => panel.designNewMany(p),
  adopt: () => panel.adopt(),
  select: (p: { nodeIds: string[] }) => panel.select(p),
  undo: (p: { ops: Op[] }) => panel.undo(p),
  thumbs: (p: { components: { component: string; version: string; nodeId?: string }[] }) => panel.thumbs(p),
  acceptCode: (p: { component: string }) => panel.acceptCode(p),
  deleteRemoved: (p: { nodeIds: string[]; confirmUses?: boolean }) => panel.deleteRemoved(p),
  keepRemoved: (p: { nodeIds: string[] }) => panel.keepRemoved(p),
  scanDesigns: () => reconcile.scanDesigns(),
  compareDesigns: (p: { pairs: Record<string, string | null> }) => reconcile.compareDesigns(p),
  designWins: (p: { nodeId: string; key: string }) => reconcile.designWins(p),
  decide: async (p: { key: string; decision: "design" | "code" | "later" }) => reconcile.decide(p.key, p.decision),
  reviewInCode: (p: { keys: string[] }) => reconcile.reviewInCode(p),
  useLive: (p: { nodeId: string; key: string }) => reconcile.useLive(p),
  finishBringingIn: async () => reconcile.finishBringingIn(),
  keepDesign: (p: { component: string }) => panel.keepDesign(p),
  unpin: (p: { component: string; key: string; props: string[] }) => panel.unpin(p),
  // A designer started the project from the plugin: set this file up for it (what the CLI's init does).
  setUpFile: (p: { projectId: string }) => init(p),
  forgetProject: async () => forgetProject(),
  resetDemoFile: () => resetDemoFile(),
  clearFile: () => clearFile(),
  fileContents: () => fileContents(),
  // The demo walkthrough: outlining the layer a step is about.
  tourMark: (p: Parameters<typeof tourMark>[0]) => tourMark(p),
  tourClear: () => tourClear(),
  // The demo: screenshots made from Live after the simulated developer's update (he has no browser).
  demoShots: () => demoShotsFromLive(),
  // The Design System page (docs/DESIGN-SYSTEM.md).
  dsState: () => ds.state(),
  dsCreate: () => ds.create(),
  dsAccept: (p: { k: string; replace?: boolean }) => ds.accept(p),
  dsMatch: (p: { k: string; nodeId: string; replace?: boolean; map?: PropMap }) => ds.match(p),
  dsUnlink: (p: { nodeId: string }) => ds.unlink(p),
  dsIgnore: (p: { k: string; on: boolean }) => ds.ignore(p),
  dsReject: async (p: { k: string; nodeId: string }) => ds.reject(p),
  dsSetMap: (p: { nodeId: string; map: PropMap }) => ds.setMap(p),
  dsLinkToken: (p: { token: string; id: string | null }) => ds.linkToken(p),
  dsRejectToken: async (p: { token: string; id: string }) => ds.rejectToken(p),
  dsSendNew: (p: { nodeId: string; note: string }) => panel.sendLibraryNew(p),
};

// "New design" follows the canvas selection, and the row of what's selected is pointed at. (Through a global
// so a development hot-reload swaps in the new code: the listener is registered once.)
const gs = globalThis as { __cdlSelection?: boolean; __cdlSelected?: () => string | undefined };
gs.__cdlSelected = panel.selectedComponent;
if (!gs.__cdlSelection) {
  figma.on("selectionchange", () => {
    let component: string | undefined;
    try {
      component = gs.__cdlSelected?.();
    } catch {}
    figma.ui.postMessage({ kind: "selection", ...(component ? { component } : {}) } satisfies MainToUi);
  });
  gs.__cdlSelection = true;
  // Edits on the page in view (a copy being changed): the panel looks again, at most every 0.8 s, so Ready for
  // dev turns on once the copy differs from Live.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const edited = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      figma.ui.postMessage({ kind: "edited" } satisfies MainToUi);
    }, 800);
  };
  let watched: PageNode | null = null;
  const watch = () => {
    // The page watched may be gone (the demo's pages removed when quitting it): nothing to detach then.
    try {
      watched?.off("nodechange", edited);
    } catch {}
    watched = figma.currentPage;
    try {
      watched.on("nodechange", edited);
    } catch {}
  };
  watch();
  figma.on("currentpagechange", watch);
}

figma.ui.onmessage = async (m: UiToMain) => {
  await migrated;
  if (m.kind === "getContext") {
    post({
      kind: "context",
      context: {
        plugin: { version: __VERSION__, dev: __DEV__ },
        file: { name: figma.root.name, projectId: meta()?.projectId ?? null, editorType: figma.editorType },
        user: figma.currentUser ? { name: figma.currentUser.name } : null,
        savedSecret: (await figma.clientStorage.getAsync("bridgeSecret")) ?? null,
        collapsed: (await figma.clientStorage.getAsync("collapsed")) === true,
        guide: ((await figma.clientStorage.getAsync("guide")) as Record<string, GuidePrefs> | undefined) ?? {},
        service: __SERVICE__,
        serviceSession: (await figma.clientStorage.getAsync("serviceSession")) ?? null,
        figmaUserId: figma.currentUser?.id ?? null,
      },
    });
  } else if (m.kind === "collapse") {
    figma.ui.resize(380, m.collapsed ? 56 : 560);
    await figma.clientStorage.setAsync("collapsed", m.collapsed);
  } else if (m.kind === "loadSession") {
    post({
      kind: "session",
      id: m.id,
      refreshToken: ((await figma.clientStorage.getAsync("serviceSession")) as string | undefined) ?? null,
    });
  } else if (m.kind === "saveSession") {
    if (m.refreshToken) await figma.clientStorage.setAsync("serviceSession", m.refreshToken);
    else await figma.clientStorage.deleteAsync("serviceSession");
  } else if (m.kind === "guide") {
    const all = ((await figma.clientStorage.getAsync("guide")) as Record<string, GuidePrefs> | undefined) ?? {};
    all[m.projectId] = { ...all[m.projectId], ...m.prefs };
    await figma.clientStorage.setAsync("guide", all);
  } else if (m.kind === "openExternal") {
    figma.openExternal(m.url);
  } else if (m.kind === "saveSecret") {
    if (m.secret) await figma.clientStorage.setAsync("bridgeSecret", m.secret);
    else await figma.clientStorage.deleteAsync("bridgeSecret");
  } else if (m.kind === "req") {
    await handleRequest(m.msg);
  } else if (m.kind === "panel") {
    try {
      const fn = actions[m.action];
      if (!fn) throw new Error(`unknown action ${m.action}`);
      post({ kind: "panelResult", id: m.id, ok: true, result: await timed(`panel ${m.action}`, () => fn(m.params as never)) });
    } catch (e) {
      post({ kind: "panelResult", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
};
