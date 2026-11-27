// Live and the branch lanes are the code's: selectable (a designer clicks a component or page to claim it) but not
// edited. Everything inside a Live or lane item is locked (clicks go through to the item), and the item itself is
// watched: moved or resized, it's put back at once; any other change is undone by the next update, and the panel
// says so. (A locked item couldn't be clicked at all: only a right-click selected it.)
//
// Anyone's changes count, not only this designer's: someone without the plugin open moves an item, and any open
// plugin puts it back once the file has been quiet for a few seconds (another plugin may be applying an update:
// those changes come in batches, and the item's record changes with them). What's laid out is recorded only by an
// update's build: laying sections out again (every panel refresh) keeps the record, so a designer's resize isn't
// taken as how the item was built.
import { LAYOUT, NODE, NS } from "@codesignflo/core";

/** Plugin work in progress (requests, panel actions): its own changes aren't the designer's. */
let writing = 0;
export async function asPlugin<T>(f: () => Promise<T>): Promise<T> {
  writing++;
  try {
    return await f();
  } finally {
    done();
  }
}
function done() {
  writing--;
}
export const pluginWriting = () => writing > 0;

/** An update's build in progress: what's laid out now is how the code draws it (see readOnly). */
let building = 0;
export async function asBuild<T>(f: () => Promise<T>): Promise<T> {
  building++;
  markBusy();
  try {
    return await f();
  } finally {
    building--;
  }
}

/**
 * Another plugin in this file is applying an update: kept on the file (so every open plugin sees it) for a minute
 * after its last build request. Its changes aren't a designer's, and the item records it writes come with them.
 */
const BUSY = "updatingUntil";
const me = Math.random().toString(36).slice(2);
function markBusy() {
  try {
    const [until, by] = figma.root.getSharedPluginData(NS, BUSY).split(" ");
    if (by === me && Number(until) - Date.now() > 30_000) return;
    figma.root.setSharedPluginData(NS, BUSY, `${Date.now() + 60_000} ${me}`);
  } catch {}
}
function othersBusy(): boolean {
  try {
    const [until, by] = figma.root.getSharedPluginData(NS, BUSY).split(" ");
    return by !== me && Number(until) > Date.now();
  } catch {
    return false;
  }
}

/** Where an item keeps how it was laid out: its section, size and own properties (what a change is put back to). */
export const BUILT = "builtAs";
/** The item's own properties restored when the designer changes them (its inside is locked: not reachable). */
const OWN = [
  "name",
  "visible",
  "opacity",
  "blendMode",
  "fills",
  "strokes",
  "strokeWeight",
  "strokeAlign",
  "dashPattern",
  "effects",
  "cornerRadius",
  "topLeftRadius",
  "topRightRadius",
  "bottomLeftRadius",
  "bottomRightRadius",
  "clipsContent",
  "rotation",
  "layoutMode",
  "itemSpacing",
  "counterAxisSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "layoutWrap",
] as const;
type Built = { section: string; w: number; h: number; own: Record<string, unknown> };

/** The Live or lane item a layer belongs to: the frame directly in a section of the Live page, or one laid out there
 * and since dragged out (it keeps where it belongs). */
export async function codeItemOf(n: BaseNode): Promise<{ item: SceneNode; section: SectionNode | null; built: Built | null } | null> {
  for (let c: BaseNode | null = n; c && c.type !== "PAGE" && c.type !== "DOCUMENT"; c = c.parent) {
    const raw = c.getSharedPluginData(NS, BUILT);
    if (raw) {
      const built = JSON.parse(raw) as Built;
      const section = await figma.getNodeByIdAsync(built.section);
      return { item: c as SceneNode, section: section?.type === "SECTION" ? section : null, built };
    }
    const p = c.parent;
    if (p?.type === "SECTION" && p.parent?.type === "PAGE" && p.parent.name === LAYOUT.live.page)
      return { item: c as SceneNode, section: p, built: null };
  }
  return null;
}

/**
 * Laid out (in a section of the Live page): everything inside the item locked, the item itself clickable, and how
 * it was laid out kept (its section, size and own properties).
 */
export function readOnly(item: SceneNode, section: SectionNode) {
  if (item.locked) item.locked = false;
  if ("children" in item) for (const c of item.children) if (!c.locked) c.locked = true;
  const own: Record<string, unknown> = {};
  const n = item as unknown as Record<string, unknown>;
  for (const k of OWN) {
    if (!(k in item)) continue;
    const v = n[k];
    if (v === figma.mixed || typeof v === "symbol" || v === undefined) continue;
    own[k] = v;
  }
  const built: Built = { section: section.id, w: Math.round(item.width * 100) / 100, h: Math.round(item.height * 100) / 100, own };
  const raw = JSON.stringify(built);
  const had = item.getSharedPluginData(NS, BUILT);
  // Recorded when an update builds it (or the first time it's laid out); laid out again otherwise, the record stays:
  // a designer's resize or move isn't how the code draws it.
  if (had && !building) return;
  if (had !== raw) item.setSharedPluginData(NS, BUILT, raw);
}

/** The item back as it was laid out: in its section, at its size, its own properties as they were. */
/** Whether anything had to be put back (the plugin's own restore fires changes too: nothing to do for those). */
function restore(
  item: SceneNode,
  at: { section: SectionNode | null; built: Built | null },
  relayout: (s: SectionNode) => void,
  always = true,
): boolean {
  let changed = false;
  if (at.section && item.parent !== at.section) {
    at.section.appendChild(item);
    changed = true;
  }
  const b = at.built;
  if (b && "resize" in item && (Math.abs(item.width - b.w) > 0.01 || Math.abs(item.height - b.h) > 0.01)) {
    (item as FrameNode).resize(b.w, b.h);
    changed = true;
  }
  const n = item as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(b?.own ?? {})) {
    if (JSON.stringify(n[k]) === JSON.stringify(v)) continue;
    try {
      n[k] = v;
      changed = true;
    } catch {
      // a value Figma won't take back as it was read (left to the next update)
    }
  }
  if ("children" in item)
    for (const c of item.children)
      if (!c.locked) {
        c.locked = true;
        changed = true;
      }
  // Its place in the section (moved within it): laid out again. A sweep (no change seen) lays out only what it fixed.
  const [x, y] = [item.x, item.y];
  if (at.section && (always || changed)) relayout(at.section);
  return changed || item.x !== x || item.y !== y;
}

/**
 * A designer's change to a Live or lane item, put back at once: moved (even out of its section), resized, its own
 * properties changed, its inside unlocked. Returns the items whose inside was changed (only reachable by unlocking a
 * layer): that goes at the next update.
 */
export async function guardChanges(
  e: NodeChangeEvent,
  relayout: (s: SectionNode) => void,
): Promise<{ restored: SceneNode[]; inside: SceneNode[] }> {
  const busy = pluginWriting();
  const touched = new Map<string, { item: SceneNode; section: SectionNode | null; built: Built | null; inside: boolean }>();
  for (const c of e.nodeChanges) {
    if (c.node.removed) continue;
    const at = await codeItemOf(c.node);
    if (!at) continue;
    // Someone else's change: looked at once the file is quiet. One of ours while the plugin works: looked at when
    // it's done (it can't tell its own changes from the designer's then; its own leave nothing to put back).
    if (c.origin !== "LOCAL") {
      later.remote.add(at.item.id);
      later.remoteAt = Date.now();
      continue;
    }
    if (busy) {
      later.local.add(at.item.id);
      continue;
    }
    const t = touched.get(at.item.id) ?? { ...at, inside: false };
    // A change below the item's own children (they're locked: only an unlocked layer gets there).
    // Layers inside move and resize with the item (its own resize): only other changes count as inside.
    const layout = new Set(["locked", "x", "y", "width", "height", "relativeTransform", "minWidth", "maxWidth", "minHeight", "maxHeight"]);
    if (c.node !== at.item && !(c.type === "PROPERTY_CHANGE" && c.properties.every((p) => layout.has(p)))) t.inside = true;
    touched.set(at.item.id, t);
  }
  const restored: SceneNode[] = [];
  const inside: SceneNode[] = [];
  writing++;
  try {
    for (const t of touched.values()) {
      if (!restore(t.item, t, relayout) && !t.inside) continue;
      restored.push(t.item);
      if (t.inside) inside.push(t.item);
    }
  } finally {
    done();
  }
  return { restored, inside };
}

/** A claim's owner is this designer (by Figma user id; claims from before lanes by name). No claim: anyone's. */
export function mine(r: { by: string; byId?: string } | null | undefined): boolean {
  if (!r) return true;
  const u = figma.currentUser;
  if (r.byId && u?.id) return r.byId === u.id;
  return r.by === (u?.name ?? "designer");
}

/**
 * The copy a layer is in, when it's another designer's open copy: its owner's name; else null. Another designer's
 * copy is theirs alone to change: this designer can look at it, not select it (see code.ts), so not change it.
 */
export function othersCopyOwner(n: BaseNode): string | null {
  for (let c: BaseNode | null = n; c && c.type !== "PAGE" && c.type !== "DOCUMENT"; c = c.parent) {
    // A placed component carries its main component's data: only the copy itself says whose it is.
    if (c.type === "INSTANCE") continue;
    const raw = c.getSharedPluginData(NS, NODE.claim);
    if (!raw) continue;
    if (c.getSharedPluginData(NS, NODE.role) !== "proposal") return null;
    try {
      const r = JSON.parse(raw) as { by: string; byId?: string };
      return mine(r) ? null : r.by;
    } catch {
      return null;
    }
  }
  return null;
}

/** Items to look at again: changed while the plugin was working, or by someone else. */
const later = { local: new Set<string>(), remote: new Set<string>(), remoteAt: 0 };

/** Every item on the Live page with a record of how it was laid out, in a section or dragged out of one. */
async function liveItems(): Promise<SceneNode[]> {
  const page = figma.root.children.find((p) => p.name === LAYOUT.live.page);
  if (!page) return [];
  await page.loadAsync();
  const out: SceneNode[] = [];
  for (const n of page.children) {
    if (n.getSharedPluginData(NS, BUILT)) out.push(n);
    if (n.type === "SECTION") for (const c of n.children) if (c.getSharedPluginData(NS, BUILT)) out.push(c);
  }
  return out;
}

async function putBack(ids: Iterable<string>, relayout: (s: SectionNode) => void, always: boolean): Promise<SceneNode[]> {
  const restored: SceneNode[] = [];
  writing++;
  try {
    for (const id of ids) {
      const n = await figma.getNodeByIdAsync(id);
      if (!n || n.removed || !("parent" in n)) continue;
      const at = await codeItemOf(n);
      if (at && restore(at.item, at, relayout, always)) restored.push(at.item);
    }
  } finally {
    done();
  }
  return restored;
}

/**
 * The checks that wait: this designer's changes made while the plugin worked (once it's done), someone else's (once
 * the file has been quiet for 5 s and no other plugin is applying an update), and with `all`, every Live item,
 * for what was changed while no plugin was open. Returns this designer's items put back (the panel says so).
 */
export async function sweep(relayout: (s: SectionNode) => void, all: boolean): Promise<SceneNode[]> {
  if (pluginWriting()) return [];
  const ours = later.local.size ? await putBack(take(later.local), relayout, true) : [];
  if (othersBusy() || Date.now() - later.remoteAt < 5_000) return ours;
  if (later.remote.size) await putBack(take(later.remote), relayout, true);
  if (all) {
    await putBack(
      (await liveItems()).map((n) => n.id),
      relayout,
      false,
    );
  }
  return ours;
}
function take(s: Set<string>): string[] {
  const ids = [...s];
  s.clear();
  return ids;
}

/**
 * A copy of a Live or lane item, the designer's to edit: unlocked, inside too (the original's inside is locked),
 * and no longer guarded (the record of how it was laid out goes).
 */
export function editable(copy: SceneNode) {
  copy.locked = false;
  if (copy.getSharedPluginData(NS, BUILT)) copy.setSharedPluginData(NS, BUILT, "");
  if ("children" in copy) for (const c of copy.children) if (c.locked) c.locked = false;
}
