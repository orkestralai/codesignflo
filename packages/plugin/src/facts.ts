// Where CoDesignFlo keeps things in the file: pages/sections (LAYOUT), the project meta and per-component
// index on the document root (written by sync), design-side events (written here, mirrored and
// acknowledged by sync), and claim records on proposal roots.
import {
  type ClaimRecord,
  ClaimRecordSchema,
  EventSchema,
  type IndexEntry,
  IndexEntrySchema,
  LAYOUT,
  LEGACY_NS,
  type LedgerEvent,
  type Meta,
  MetaSchema,
  NODE,
  NS,
  protocol,
  ROOT,
} from "@codesignflo/core";

const root = () => figma.root;
const readJson = (n: BaseNode, key: string): unknown => {
  const v = n.getSharedPluginData(NS, key);
  if (!v) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};
const writeJson = (n: BaseNode, key: string, v: unknown) => n.setSharedPluginData(NS, key, v === undefined ? "" : JSON.stringify(v));

// ---- meta ----------------------------------------------------------------------------------------

/**
 * Files set up before the rename to CoDesignFlo: every node's data moves from the old namespace to the new
 * one, once (keys, claims, generations, events — nothing is lost). Returns how many nodes moved.
 */
export async function migrateLegacy(): Promise<number> {
  if (!figma.root.getSharedPluginDataKeys(LEGACY_NS).length) return 0;
  await figma.loadAllPagesAsync();
  let moved = 0;
  const move = (n: BaseNode) => {
    const keys = n.getSharedPluginDataKeys(LEGACY_NS);
    if (!keys.length) return;
    for (const k of keys) {
      if (!n.getSharedPluginData(NS, k)) n.setSharedPluginData(NS, k, n.getSharedPluginData(LEGACY_NS, k));
      n.setSharedPluginData(LEGACY_NS, k, "");
    }
    moved++;
  };
  move(figma.root);
  for (const page of figma.root.children) {
    move(page);
    for (const n of page.findAll((x) => x.getSharedPluginDataKeys(LEGACY_NS).length > 0)) move(n);
  }
  return moved;
}

export function meta(): Meta | null {
  const r = MetaSchema.safeParse(readJson(root(), ROOT.meta));
  return r.success ? r.data : null;
}

/** The file's project was deleted: the file no longer belongs to it (its Live and Proposals pages stay). */
export function forgetProject() {
  root().setSharedPluginData(NS, ROOT.meta, "");
}

/**
 * "Quit demo": the file's CoDesignFlo pages (Live, Proposals, Design System) go and the file no longer belongs to
 * the demo. Only offered on a demo project's file.
 */
export async function resetDemoFile() {
  await figma.loadAllPagesAsync();
  const ours = new Set<string>([LAYOUT.live.page, LAYOUT.proposals.page, LAYOUT.system.page]);
  const gone = figma.root.children.filter((p) => ours.has(p.name));
  // A file keeps at least one page: an empty one when only ours were there.
  let keep = figma.root.children.find((p) => !ours.has(p.name));
  if (!keep) {
    keep = figma.createPage();
    keep.name = "Page 1";
  }
  await figma.setCurrentPageAsync(keep);
  for (const p of gone) p.remove();
  forgetProject();
}

export function writeMeta(m: Meta) {
  writeJson(root(), ROOT.meta, MetaSchema.parse(m));
}

// ---- layout --------------------------------------------------------------------------------------

async function page(name: string): Promise<PageNode> {
  // dynamic-page access: a page's contents can't be read until it is loaded.
  await figma.loadAllPagesAsync();
  const existing = figma.root.children.find((p) => p.name === name);
  if (existing) {
    await existing.loadAsync();
    return existing;
  }
  // Starter plan: at most 3 pages. A brand-new file has one empty page: reuse it for the first.
  const ours = new Set<string>([LAYOUT.live.page, LAYOUT.proposals.page, LAYOUT.system.page]);
  const blank =
    figma.root.children.length === 1 && figma.root.children[0]!.children.length === 0 && !ours.has(figma.root.children[0]!.name);
  if (blank) {
    const p = figma.root.children[0]!;
    p.name = name;
    return p;
  }
  const p = figma.createPage();
  p.name = name;
  return p;
}

/** The section if the file has it (doesn't create it). */
export async function sectionIfAny(pageName: string, name: string): Promise<SectionNode | null> {
  await figma.loadAllPagesAsync();
  const p = figma.root.children.find((x) => x.name === pageName);
  if (!p) return null;
  await p.loadAsync();
  return (p.findChild((n) => n.type === "SECTION" && n.name === name) as SectionNode | null) ?? null;
}

/** Sections renamed since: found by their old name, and renamed. */
const FORMERLY: Record<string, string> = { [LAYOUT.live.sections.screens]: "Screens", [LAYOUT.live.sections.components]: "Library" };

async function section(pageName: string, name: string, x: number, after?: string): Promise<SectionNode> {
  const p = await page(pageName);
  const named = (x: string) => p.findChild((n) => n.type === "SECTION" && n.name === x) as SectionNode | null;
  let s = named(name);
  const old = !s && FORMERLY[name] ? named(FORMERLY[name]!) : null;
  if (old) {
    old.name = name;
    s = old;
  }
  if (!s) {
    s = figma.createSection();
    s.name = name;
    // Right after its neighbour (stack() lines sections up left to right in this order).
    const prev = after ? named(after) : null;
    if (prev) p.insertChild(p.children.indexOf(prev) + 1, s);
    else p.appendChild(s);
    s.x = x;
    s.y = 0;
    s.resizeWithoutConstraints(1600, 1200);
  }
  return s;
}

export const sections = {
  /** The code's components, as the code renders them (was "Library": renamed in place). */
  components: () => section(LAYOUT.live.page, LAYOUT.live.sections.components, 0),
  screens: () => section(LAYOUT.live.page, LAYOUT.live.sections.screens, 1800),
  /** The app as built, each level with its page in Pages. */
  liveShots: () => section(LAYOUT.live.page, LAYOUT.live.sections.screenshots, 3600, LAYOUT.live.sections.screens),
  archive: () => section(LAYOUT.proposals.page, LAYOUT.proposals.sections.archive, 1800),
  /** Design System › Library: the designer's components (theirs to arrange: never re-stacked). */
  systemLibrary: () => section(LAYOUT.system.page, LAYOUT.system.sections.library, 0),
  /** Design System › From code: a copy of each code component the Library has no counterpart for yet. */
  fromCode: () => section(LAYOUT.system.page, LAYOUT.system.sections.fromCode, 1800, LAYOUT.system.sections.library),
};

// ---- designer lanes (Proposals) ------------------------------------------------------------------------

/** A designer: their Figma user id (stable) and name (shown). Claims from before lanes have only the name. */
export type Designer = { id: string; name: string };
/** A lane section: whose (Figma user id, name) and what it holds (their copies, or those copies' screenshots). */
export const LANE = { of: "laneOf", name: "laneName", kind: "laneKind" } as const;
type LaneKind = "active" | "shots";
const laneKind = (n: BaseNode) => n.getSharedPluginData(NS, LANE.kind);
/** The designer in front of the plugin. */
export const me = (): Designer => ({ id: figma.currentUser?.id ?? "", name: figma.currentUser?.name ?? "designer" });
/** Who a claim belongs to. */
export const designerOf = (c: Pick<ClaimRecord, "by" | "byId">): Designer => ({ id: c.byId ?? "", name: c.by });
/** Same designer: by Figma user id when both have one, else by name (lanes and claims from before ids). */
function sameDesigner(s: BaseNode, d: Designer) {
  const id = s.getSharedPluginData(NS, LANE.of);
  return id && d.id ? id === d.id : s.getSharedPluginData(NS, LANE.name) === d.name;
}
const sameLane = (a: BaseNode, b: BaseNode) =>
  sameDesigner(a, { id: b.getSharedPluginData(NS, LANE.of), name: b.getSharedPluginData(NS, LANE.name) });
const laneTitle = (d: Designer, kind: LaneKind) => `${d.name} — ${kind === "active" ? "active" : "screenshots"}`;

/**
 * A designer's lane on the Proposals page: the copies they claimed ("Ana — active"), and beside it the app's
 * screenshots of those that are pages ("Ana — screenshots"). Lanes go left to right before the Archive.
 */
export async function designerLane(d: Designer, kind: LaneKind = "active"): Promise<SectionNode> {
  const p = await page(LAYOUT.proposals.page);
  const found = p.children.find((n) => n.type === "SECTION" && laneKind(n) === kind && sameDesigner(n, d)) as SectionNode | undefined;
  if (found) {
    if (d.id && !found.getSharedPluginData(NS, LANE.of)) found.setSharedPluginData(NS, LANE.of, d.id);
    return found;
  }
  const s = figma.createSection();
  s.name = laneTitle(d, kind);
  s.setSharedPluginData(NS, LANE.kind, kind);
  s.setSharedPluginData(NS, LANE.name, d.name);
  if (d.id) s.setSharedPluginData(NS, LANE.of, d.id);
  const active = kind === "shots" ? await designerLane(d, "active") : null;
  const archive = p.findChild((n) => n.type === "SECTION" && n.name === LAYOUT.proposals.sections.archive && !laneKind(n));
  p.insertChild(active ? p.children.indexOf(active) + 1 : archive ? p.children.indexOf(archive) : p.children.length, s);
  s.y = 0;
  s.resizeWithoutConstraints(1600, 1200);
  return s;
}

/** Every designer's lane of copies (and the shared Active section of files from before lanes, while it's there). */
export async function activeLanes(): Promise<SectionNode[]> {
  await figma.loadAllPagesAsync();
  const p = figma.root.children.find((x) => x.name === LAYOUT.proposals.page);
  if (!p) return [];
  await p.loadAsync();
  return p.children.filter(
    (n): n is SectionNode =>
      n.type === "SECTION" && (laneKind(n) === "active" || (!laneKind(n) && n.name === LAYOUT.proposals.sections.active)),
  );
}

/** The lane of copies a node is in, if any. */
export function laneOf(n: BaseNode): SectionNode | null {
  for (let q = n.parent; q && q.type !== "PAGE"; q = q.parent) if (q.type === "SECTION" && laneKind(q) === "active") return q;
  return null;
}

/**
 * Files from before designer lanes: each claimed copy in the shared Active section moves to its designer's lane,
 * with its screenshot; the shared sections go once nothing else is in them.
 */
export async function splitActive() {
  const legacy = (await activeLanes()).find((n) => !laneKind(n));
  if (!legacy) return;
  const page = legacy.parent as PageNode;
  const legacyShots = page.findChild(
    (n) => n.type === "SECTION" && !laneKind(n) && n.name === LAYOUT.proposals.sections.screenshots,
  ) as SectionNode | null;
  const moved = new Set<SectionNode>();
  for (const n of [...legacy.children]) {
    const c = claimOf(n);
    if (!c) continue;
    const lane = await designerLane(designerOf(c));
    lane.appendChild(n);
    const shot = legacyShots?.children.find((x) => isShot(x) && x.getSharedPluginData(NS, SHOT.of) === n.id);
    if (shot) (await designerLane(designerOf(c), "shots")).appendChild(shot);
    moved.add(lane);
  }
  for (const l of moved) stack(l);
  if (legacy.children.some((x) => !isLabel(x))) return stack(legacy);
  legacy.remove();
  if (legacyShots && !legacyShots.children.length) legacyShots.remove();
  // The sections left close up (stack lines the page's sections up again).
  const first = [...moved][0];
  if (first) stack(first);
}

/** A label beside a Live component ("In your Library", "In From code"): laid out with it, not as an item. */
export const LABEL = { role: "dsLabel", for: "dsFor", lane: "labelLane", copy: "labelCopy" } as const;
const isLabel = (n: BaseNode) => n.getSharedPluginData(NS, NODE.role) === LABEL.role;

/**
 * A label beside an item of a section (by its key), linking to another node: laid out by stack, one per item.
 * `lane` / `copy`: the branch lane it's about and the designer's copy it's on (taken out with the lane).
 */
export async function linkLabel(sec: SectionNode, k: string, text: string, to: string | null, lane = "", copy = "") {
  await figma.loadFontAsync({ family: "Inter", style: "Medium" }).catch(() => undefined);
  let found = sec.children.find((c) => isLabel(c) && c.getSharedPluginData(NS, LABEL.for) === k) as SceneNode | undefined;
  // A pill (light, dark text): readable on any section colour.
  if (found && (found.type !== "FRAME" || found.children[0]?.type !== "TEXT")) {
    found.locked = false;
    found.remove();
    found = undefined;
  }
  let pill = found as FrameNode | undefined;
  if (!pill) {
    pill = figma.createFrame();
    pill.name = "CoDesignFlo label";
    pill.layoutMode = "HORIZONTAL";
    pill.primaryAxisSizingMode = "AUTO";
    pill.counterAxisSizingMode = "AUTO";
    pill.paddingLeft = pill.paddingRight = 12;
    pill.paddingTop = pill.paddingBottom = 6;
    pill.cornerRadius = 8;
    pill.fills = [{ type: "SOLID", color: { r: 0.93, g: 0.93, b: 1 } }];
    pill.strokes = [{ type: "SOLID", color: { r: 0.31, g: 0.27, b: 0.9 } }];
    pill.strokeWeight = 1;
    const t = figma.createText();
    t.fontName = { family: "Inter", style: "Medium" };
    t.fontSize = 14;
    t.fills = [{ type: "SOLID", color: { r: 0.2, g: 0.16, b: 0.6 } }];
    pill.appendChild(t);
    pill.setSharedPluginData(NS, NODE.role, LABEL.role);
    pill.setSharedPluginData(NS, LABEL.for, k);
    sec.appendChild(pill);
  }
  const label = pill.children[0] as TextNode;
  if (label.characters !== text) label.characters = text;
  if (pill.name !== text) pill.name = text;
  const cur = label.hyperlink;
  if (!to) {
    if (cur) label.hyperlink = null;
  } else if (cur === figma.mixed || cur?.type !== "NODE" || cur.value !== to) label.hyperlink = { type: "NODE", value: to };
  pill.setSharedPluginData(NS, LABEL.lane, lane);
  pill.setSharedPluginData(NS, LABEL.copy, copy);
  if (!pill.locked) pill.locked = true;
}

/** Takes out the labels a branch lane put on the designers' copies (all, or those not on `keep`'s copies). */
export async function dropLaneLabels(branch: string, keep: Set<string> = new Set()) {
  const lanes = await activeLanes();
  for (const lane of lanes) {
    let changed = false;
    for (const c of [...lane.children])
      if (isLabel(c) && c.getSharedPluginData(NS, LABEL.lane) === branch && !keep.has(c.getSharedPluginData(NS, LABEL.copy))) {
        c.locked = false;
        c.remove();
        changed = true;
      }
    if (changed) stack(lane);
  }
}

/**
 * Files set up before M6 have a "What's new" page; it was dropped (the designer found it useless). Deleted
 * when it holds nothing but CoDesignFlo's own cards and intro.
 */
export async function dropWhatsNewPage() {
  await figma.loadAllPagesAsync();
  const p = figma.root.children.find((x) => x.name === "What's new");
  if (!p || figma.root.children.length < 2) return;
  const ours = (n: SceneNode) => n.getSharedPluginData(NS, NODE.role) === "intro" || / · \d{4}-\d{2}-\d{2} /.test(n.name);
  if (p.children.every(ours)) p.remove();
}

/** `codesignflo init`: create the layout and record the project id. Idempotent. */
export async function init(p: { projectId: string; minPlugin?: string }) {
  const current = meta();
  if (current && current.projectId !== p.projectId) throw new Error(`this file already belongs to project ${current.projectId}`);
  await sections.components();
  await sections.screens();
  await sections.archive();
  writeMeta({ ...(current ?? { schema: 1 as const }), projectId: p.projectId, ...(p.minPlugin ? { minPlugin: p.minPlugin } : {}) });
  return { pages: figma.root.children.map((x) => x.name) };
}

// ---- index (mirrored by sync) --------------------------------------------------------------------

export function readIndex(): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const key of root().getSharedPluginDataKeys(NS)) {
    if (!key.startsWith(ROOT.indexPrefix)) continue;
    const r = IndexEntrySchema.safeParse(readJson(root(), key));
    if (r.success) out.push(r.data);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Replaces the index: entries not listed are removed. */
export function writeIndex(p: { entries: IndexEntry[]; lastSyncAt: string; lastSyncCommit?: string; updated?: string[] }) {
  const keep = new Set(p.entries.map((e) => ROOT.indexPrefix + e.component));
  for (const key of root().getSharedPluginDataKeys(NS))
    if (key.startsWith(ROOT.indexPrefix) && !keep.has(key)) root().setSharedPluginData(NS, key, "");
  const updated = p.updated ? new Set(p.updated) : null;
  for (const e of p.entries) {
    // An update of only some items: the others keep how they compared with the app (not rebuilt now).
    const before =
      updated && !updated.has(e.component) ? IndexEntrySchema.safeParse(readJson(root(), ROOT.indexPrefix + e.component)) : null;
    const kept = before?.success
      ? Object.fromEntries(
          (["differs", "score", "fitted", "warning", "designMatch"] as const).flatMap((f) =>
            before.data[f] !== undefined ? [[f, before.data[f]]] : [],
          ),
        )
      : {};
    writeJson(root(), ROOT.indexPrefix + e.component, IndexEntrySchema.parse({ ...kept, ...e }));
  }
  const m = meta();
  if (m) writeMeta({ ...m, lastSyncAt: p.lastSyncAt, ...(p.lastSyncCommit ? { lastSyncCommit: p.lastSyncCommit } : {}) });
  return { written: p.entries.length };
}

// ---- design-side events --------------------------------------------------------------------------

let seq = 0;
export function appendEvent(e: Omit<LedgerEvent, "id" | "at" | "by"> & { by?: string }): LedgerEvent {
  const at = new Date().toISOString();
  const by = e.by ?? figma.currentUser?.name ?? "designer";
  const id = `d${Date.now().toString(36)}${(seq++).toString(36)}`;
  const event = EventSchema.parse({ ...e, id, at, by });
  writeJson(root(), ROOT.eventPrefix + id, event);
  // Signed in to the service: the panel sends it there right away (the developer sees it without a sync).
  figma.ui.postMessage({ kind: "cloudEvents", events: [event] });
  return event;
}

export function events(): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const key of root().getSharedPluginDataKeys(NS)) {
    if (!key.startsWith(ROOT.eventPrefix)) continue;
    const r = EventSchema.safeParse(readJson(root(), key));
    if (r.success) out.push(r.data);
  }
  return out;
}

/** Sync calls this after mirroring events to git. */
export function ackEvents(p: { ids: string[] }) {
  for (const id of p.ids) root().setSharedPluginData(NS, ROOT.eventPrefix + id, "");
  return { removed: p.ids.length };
}

// ---- layout of sections: newest on top, nothing overlaps (M6) -------------------------------------

const PLACED_AT = "placedAt";
const GAP = 80;

/** Records when a node entered its section (the stacking order). */
export function enter(n: SceneNode) {
  n.setSharedPluginData(NS, PLACED_AT, new Date().toISOString());
}

/**
 * The app's screenshot of a page (role, what it belongs to, its picture ref). In Live → Screenshots it belongs
 * to a Live page (by key: the page's node is replaced when it's rebuilt); in Proposals → Screenshots to a
 * claimed copy of one (by node id).
 */
export const SHOT = { role: "asBuilt", of: "shotOf", ref: "shotRef" };
export const isShot = (n: BaseNode) => n.getSharedPluginData(NS, NODE.role) === SHOT.role;
/** Sections (by name, not lanes) whose items have their screenshot in a section beside them, and how they match. */
const SHOTS_BESIDE: Record<string, { shots: string; pair: (n: SceneNode) => string }> = {
  [LAYOUT.live.sections.screens]: { shots: LAYOUT.live.sections.screenshots, pair: (n) => n.getSharedPluginData(NS, NODE.k) },
  // Files from before designer lanes, until splitActive empties it.
  [LAYOUT.proposals.sections.active]: { shots: LAYOUT.proposals.sections.screenshots, pair: (n) => n.id },
};
const byId = (n: SceneNode) => n.id;
const siblingSection = (s: SectionNode, f: (n: SceneNode) => boolean) =>
  s.parent?.type === "PAGE" ? ((s.parent.findChild((n) => n.type === "SECTION" && f(n)) as SectionNode | null) ?? null) : null;
/** The section of screenshots beside a section of items, and how an item is matched with its screenshot. */
function besideOf(s: SectionNode): { shots: SectionNode | null; pair: (n: SceneNode) => string } | null {
  if (laneKind(s) === "active") return { shots: siblingSection(s, (n) => laneKind(n) === "shots" && sameLane(n, s)), pair: byId };
  const named = !laneKind(s) ? SHOTS_BESIDE[s.name] : undefined;
  return named ? { shots: siblingSection(s, (n) => !laneKind(n) && n.name === named.shots), pair: named.pair } : null;
}
/** For a section of screenshots: the section of items it's laid out with. */
function mirrorOf(s: SectionNode): SectionNode | null {
  if (laneKind(s) === "shots") return siblingSection(s, (n) => laneKind(n) === "active" && sameLane(n, s));
  if (laneKind(s)) return null;
  const items = Object.entries(SHOTS_BESIDE).find(([, v]) => v.shots === s.name)?.[0];
  return items ? siblingSection(s, (n) => !laneKind(n) && n.name === items) : null;
}
/** What a screenshot is matched with in the section beside it. */
export const pairOf = (n: SceneNode) => {
  const s = n.parent;
  return s?.type === "SECTION" ? (besideOf(s)?.pair(n) ?? "") : "";
};
/** A copy's section of screenshots (its lane's): made when it's first needed. */
export async function shotsFor(copy: SceneNode): Promise<{ shots: SectionNode; items: SectionNode } | null> {
  const lane = laneOf(copy);
  if (!lane) return null;
  return {
    shots: await designerLane({ id: lane.getSharedPluginData(NS, LANE.of), name: lane.getSharedPluginData(NS, LANE.name) }, "shots"),
    items: lane,
  };
}

/**
 * Stacks a section's items top to bottom, newest first, one gap apart, grows/shrinks the section to fit,
 * then lines the page's sections up left to right so a wider section never runs under the next one.
 * A page or claimed copy with a screenshot has it level with it in the Screenshots section beside.
 * Items placed before this existed keep their current order, below the dated ones.
 */
export function stack(section: SectionNode) {
  // A Screenshots section is laid out by the section it mirrors.
  const page = section.parent;
  const mirrored = mirrorOf(section);
  if (mirrored) return stack(mirrored);
  const beside = besideOf(section);
  const shotSection = beside?.shots ?? null;
  // Screenshots by what they belong to; a second one for the same item, or one whose item is gone, goes.
  const shots = new Map<string, SceneNode>();
  if (shotSection && beside) {
    const items = new Set(section.children.map(beside.pair));
    for (const c of [...shotSection.children]) {
      const of = c.getSharedPluginData(NS, SHOT.of);
      if (!isShot(c)) continue;
      if (shots.has(of) || !items.has(of)) c.remove();
      else shots.set(of, c);
    }
  }
  // Screenshots left in the section itself: before Screenshots had a section of their own (plugin 0.1, 12 Nov
  // 2026) they were placed beside their page here, and stayed as 37 unknown frames under the pages.
  if (beside) for (const c of [...section.children]) if (isShot(c)) c.remove();
  // Labels go beside the item they're for (by key); one whose item is gone goes too.
  const labels = new Map<string, SceneNode>();
  for (const c of [...section.children])
    if (isLabel(c)) {
      const of = c.getSharedPluginData(NS, LABEL.for);
      if (labels.has(of) || !section.children.some((x) => !isLabel(x) && x.getSharedPluginData(NS, NODE.k) === of)) c.remove();
      else labels.set(of, c);
    }
  const items = [...section.children].filter((c) => !isLabel(c)).map((c) => ({ c, at: c.getSharedPluginData(NS, PLACED_AT), y: c.y }));
  items.sort((a, b) => (a.at && b.at ? (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) : a.at ? -1 : b.at ? 1 : a.y - b.y));
  let y = GAP;
  let w = 0;
  let sw = 0;
  for (const { c } of items) {
    if (c.x !== GAP) c.x = GAP;
    if (c.y !== y) c.y = y;
    // What shows, not only the frame: content spilling out of a frame that doesn't clip mustn't overlap the next.
    const box = c.absoluteBoundingBox;
    // Not every node type has render bounds (stickies, connectors…): those use their frame.
    const seen = "absoluteRenderBounds" in c ? c.absoluteRenderBounds : null;
    let h = box && seen ? Math.max(c.height, seen.y + seen.height - box.y) : c.height;
    let wd = box && seen ? Math.max(c.width, seen.x + seen.width - box.x) : c.width;
    const label = labels.get(c.getSharedPluginData(NS, NODE.k));
    if (label) {
      if (label.x !== GAP + wd + 24) label.x = GAP + wd + 24;
      if (label.y !== y) label.y = y;
      wd += 24 + label.width;
    }
    // Its screenshot at the same height in the section beside it: the two read row by row.
    const shot = beside ? shots.get(beside.pair(c)) : undefined;
    if (shot) {
      if (shot.x !== GAP) shot.x = GAP;
      if (shot.y !== y) shot.y = y;
      h = Math.max(h, shot.height);
      sw = Math.max(sw, shot.width);
    }
    y += h + GAP;
    w = Math.max(w, wd);
  }
  if (shotSection) {
    const width = Math.max(480, sw + 2 * GAP);
    const height = Math.max(320, y);
    if (shotSection.width !== width || shotSection.height !== height) shotSection.resizeWithoutConstraints(width, height);
  }
  const width = Math.max(480, w + 2 * GAP);
  const height = Math.max(320, y);
  if (section.width !== width || section.height !== height) section.resizeWithoutConstraints(width, height);
  if (page?.type === "PAGE") {
    // Design System can be a page of the designer's own (adopted by name): its sections go right of what's there.
    const own = page.name === LAYOUT.system.page ? page.children.filter((n) => n.type !== "SECTION") : [];
    let x = own.length ? Math.max(...own.map((n) => n.x + n.width)) + 200 : 0;
    for (const s of page.children.filter((n): n is SectionNode => n.type === "SECTION")) {
      if (s.x !== x) s.x = x;
      if (s.y !== 0) s.y = 0;
      x += s.width + 200;
    }
  }
}

/** Every CoDesignFlo section re-stacked (items change size between syncs: variants, designer edits). */
export async function stackAll() {
  for (const s of [await sections.components(), await sections.screens(), ...(await activeLanes()), await sections.archive()]) stack(s);
  const fromCode = await sectionIfAny(LAYOUT.system.page, LAYOUT.system.sections.fromCode);
  if (fromCode) stack(fromCode);
}

/**
 * Moves a finished proposal to Proposals → Archive: newest on top, older ones pushed down (they used to
 * overlap). Not locked: the archive is the designer's to tidy or delete; the history is in git (M6).
 */
export async function toArchive(n: SceneNode) {
  const archive = await sections.archive();
  const from = n.parent;
  archive.appendChild(n);
  enter(n);
  n.setSharedPluginData(NS, NODE.role, "archive");
  n.locked = false;
  stack(archive);
  // Where it was closes the gap (and drops its screenshot, which belonged to it there).
  if (from?.type === "SECTION" && from !== archive) stack(from);
}

// ---- baseline snapshot on proposal roots ---------------------------------------------------------

const CHUNK = 90_000;
/** JSON in plugin data, split over `key`, `key.1`, … (100 kB per entry). */
export function writeChunked(n: BaseNode, name: string, raw: unknown) {
  const text = raw === null ? "" : JSON.stringify(raw);
  for (let i = 0; ; i++) {
    const key = i === 0 ? name : `${name}.${i}`;
    const part = text.slice(i * CHUNK, (i + 1) * CHUNK);
    if (!part && !n.getSharedPluginData(NS, key)) break;
    n.setSharedPluginData(NS, key, part);
  }
}
export function readChunked(n: BaseNode, name: string): unknown {
  let text = "";
  for (let i = 0; ; i++) {
    const part = n.getSharedPluginData(NS, i === 0 ? name : `${name}.${i}`);
    if (!part) break;
    text += part;
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
export const writeBase = (n: BaseNode, raw: unknown) => writeChunked(n, NODE.base, raw);
export const readBase = (n: BaseNode): unknown => readChunked(n, NODE.base);

// ---- claims on proposal roots --------------------------------------------------------------------

export function claimOf(n: BaseNode): ClaimRecord | null {
  const r = ClaimRecordSchema.safeParse(readJson(n, NODE.claim));
  return r.success ? r.data : null;
}

export function writeClaim(n: BaseNode, c: ClaimRecord | null) {
  writeJson(n, NODE.claim, c ?? undefined);
}

/** Every proposal root in the Proposals page (active and archived), with its claim. */
export async function proposals(): Promise<{ node: SceneNode; claim: ClaimRecord; role: string }[]> {
  const p = figma.root.children.find((x) => x.name === LAYOUT.proposals.page);
  if (!p) return [];
  await p.loadAsync();
  const out: { node: SceneNode; claim: ClaimRecord; role: string }[] = [];
  // Only the copies themselves: a placed component (instance) carries its main component's data — a Tag
  // placed inside a sent Plant card looked like the Tag design itself (and got archived out of the card).
  const inside = (n: BaseNode) => {
    for (let q = n.parent; q && q.type !== "SECTION" && q.type !== "PAGE"; q = q.parent)
      if (q.getSharedPluginData(NS, NODE.claim)) return true;
    return false;
  };
  for (const n of p.findAll((x) => x.type !== "INSTANCE" && !!x.getSharedPluginData(NS, NODE.claim) && !inside(x))) {
    const c = claimOf(n);
    if (c) out.push({ node: n as SceneNode, claim: c, role: n.getSharedPluginData(NS, NODE.role) });
  }
  return out;
}

export const PROTOCOL = protocol.PROTOCOL_VERSION;
