// The demo walkthrough on the canvas: plugins can't draw over Figma's own interface, so a step points at a layer
// by bringing it into view and outlining it with a dashed frame and a short label, on the layer's page. One mark
// at a time; it goes when the step changes, the walkthrough ends, or the plugin starts again (a mark left behind
// by a closed plugin is cleared then). Marks are locked and carry our plugin data, so they're never mistaken for
// the designer's layers (snapshots, proposals and the index ignore them: they're top-level, outside our sections).
import { NS } from "@codesignflo/core";

const ROLE = "tour-mark";
const BLUE = { r: 0.051, g: 0.6, b: 1 };
const PAD = 12;

async function clear() {
  await figma.loadAllPagesAsync();
  for (const page of figma.root.children) for (const n of page.children) if (n.getSharedPluginData(NS, "role") === ROLE) n.remove();
}

type Mark = { nodeId: string; label?: string };

/** Outlines one layer with a label, on its page. */
async function outline(n: SceneNode & { absoluteBoundingBox: Rect }, page: PageNode, label?: string) {
  const b = n.absoluteBoundingBox;
  const frame = figma.createFrame();
  frame.name = "CoDesignFlo guide";
  frame.fills = [];
  frame.clipsContent = false;
  frame.strokes = [{ type: "SOLID", color: BLUE }];
  frame.strokeWeight = 3;
  frame.dashPattern = [10, 6];
  frame.cornerRadius = 8;
  frame.x = b.x - PAD;
  frame.y = b.y - PAD;
  frame.resize(Math.max(1, b.width + 2 * PAD), Math.max(1, b.height + 2 * PAD));
  if (label) {
    await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
    const tag = figma.createFrame();
    tag.name = "label";
    tag.layoutMode = "HORIZONTAL";
    tag.primaryAxisSizingMode = "AUTO";
    tag.counterAxisSizingMode = "AUTO";
    tag.paddingLeft = tag.paddingRight = 10;
    tag.paddingTop = tag.paddingBottom = 6;
    tag.cornerRadius = 6;
    tag.fills = [{ type: "SOLID", color: BLUE }];
    const text = figma.createText();
    text.fontName = { family: "Inter", style: "Semi Bold" };
    text.fontSize = 14;
    text.characters = label;
    text.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    tag.appendChild(text);
    frame.appendChild(tag);
    tag.x = 0;
    tag.y = -tag.height - 8;
  }
  frame.setSharedPluginData(NS, "role", ROLE);
  frame.locked = true;
  page.appendChild(frame);
  return frame;
}

/**
 * Points at layers: brings them into view and outlines each with its label (one layer, or several on the same
 * page, like Live's rebuilt pages). No node: just clears.
 */
/** The newest request: an older one still drawing (the walkthrough moved on meanwhile) stops, and doesn't move the view. */
let latest = 0;

export async function tourMark(p: { nodeId?: string; label?: string; marks?: Mark[]; select?: boolean }) {
  const mine = ++latest;
  const stale = () => mine !== latest;
  await clear();
  if (stale()) return { ok: true, stale: true };
  const marks: Mark[] = p.marks ?? (p.nodeId ? [{ nodeId: p.nodeId, label: p.label }] : []);
  let page: PageNode | null = null;
  const frames: FrameNode[] = [];
  let first: SceneNode | null = null;
  for (const m of marks) {
    const n = (await figma.getNodeByIdAsync(m.nodeId)) as SceneNode | null;
    if (stale()) return { ok: true, stale: true };
    if (!n || !("absoluteBoundingBox" in n) || !n.absoluteBoundingBox) continue;
    let pg: BaseNode | null = n;
    while (pg && pg.type !== "PAGE") pg = pg.parent;
    if (!pg || (page && pg !== page)) continue;
    if (!page) {
      page = pg as PageNode;
      await figma.setCurrentPageAsync(page);
    }
    first ??= n;
    // One that can't be outlined doesn't stop the others.
    const f = await outline(n as SceneNode & { absoluteBoundingBox: Rect }, page, m.label).catch(() => null);
    if (f) frames.push(f);
  }
  if (stale()) {
    for (const f of frames) f.remove();
    return { ok: true, stale: true };
  }
  if (!page || !frames.length) return { ok: !marks.length, found: frames.length };
  if (p.select && first) page.selection = [first];
  figma.viewport.scrollAndZoomIntoView(frames);
  return { ok: true };
}

/** The plugin started: a mark left by a previous run goes. */
export const tourClear = () => clear().then(() => ({ ok: true }));
