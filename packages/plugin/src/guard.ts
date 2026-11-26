// Live and the branch lanes are the code's: selectable (a designer clicks a component or page to claim it) but not
// edited. Everything inside a Live or lane item is locked (clicks go through to the item), and the item itself is
// watched: moved or resized, it's put back at once; any other change is undone by the next update, and the panel
// says so. (A locked item couldn't be clicked at all: only a right-click selected it.)
import { LAYOUT, NS } from "@codesignflo/core";

/** Plugin work in progress (requests, panel actions): its own changes aren't the designer's. */
let writing = 0;
export async function asPlugin<T>(f: () => Promise<T>): Promise<T> {
  writing++;
  try {
    return await f();
  } finally {
    writing--;
  }
}
export const pluginWriting = () => writing > 0;

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
  if (item.getSharedPluginData(NS, BUILT) !== raw) item.setSharedPluginData(NS, BUILT, raw);
}

/** The item back as it was laid out: in its section, at its size, its own properties as they were. */
/** Whether anything had to be put back (the plugin's own restore fires changes too: nothing to do for those). */
function restore(item: SceneNode, at: { section: SectionNode | null; built: Built | null }, relayout: (s: SectionNode) => void): boolean {
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
  // Its place in the section (moved within it): laid out again.
  const [x, y] = [item.x, item.y];
  if (at.section) relayout(at.section);
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
  if (pluginWriting()) return { restored: [], inside: [] };
  const touched = new Map<string, { item: SceneNode; section: SectionNode | null; built: Built | null; inside: boolean }>();
  for (const c of e.nodeChanges) {
    if (c.origin !== "LOCAL" || c.node.removed) continue;
    const at = await codeItemOf(c.node);
    if (!at) continue;
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
    writing--;
  }
  return { restored, inside };
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
