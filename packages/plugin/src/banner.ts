// A banner on the Live page, shown while the plugin is closed: Live is only kept as the code draws it (edits put
// back, updates applied, claims from a click) while the plugin runs, and a designer working with it closed would
// lose all that without knowing. The plugin hides it while it's open and shows it when it closes; a file opened
// without the plugin shows it from the start. With several people in the file, any open plugin keeps it hidden.
import { LAYOUT, NS } from "@codesignflo/core";

const ROLE = "pluginBanner";
let banner: FrameNode | null = null;

async function livePage(): Promise<PageNode | null> {
  const p = figma.root.children.find((x) => x.name === LAYOUT.live.page) ?? null;
  if (p) await p.loadAsync();
  return p;
}

/** The banner (made the first time), hidden: the plugin is open. */
export async function bannerOpen(): Promise<void> {
  const page = await livePage();
  if (!page) return;
  banner = (page.findChild((n) => n.type === "FRAME" && n.getSharedPluginData(NS, "role") === ROLE) as FrameNode | null) ?? null;
  if (!banner) banner = await make(page);
  fit(banner);
  await scaleText(banner);
  fit(banner);
  if (banner.visible) banner.visible = false;
}

/**
 * Its text sized for its width, so it reads with all the sections in view (fixed sizes were a few pixels at that
 * zoom): the title about 1/22 of the width, the line under it about 1/55. Needs the fonts, so only while open.
 */
async function scaleText(b: FrameNode) {
  const texts = b.children.filter((n): n is TextNode => n.type === "TEXT");
  if (texts.length < 2) return;
  await Promise.all(texts.map((t) => (t.fontName === figma.mixed ? Promise.resolve() : figma.loadFontAsync(t.fontName))));
  const [title, line] = texts as [TextNode, TextNode];
  const big = Math.round(Math.max(56, b.width / 22));
  const small = Math.round(Math.max(26, b.width / 55));
  if (title.fontSize !== big) title.fontSize = big;
  if (line.fontSize !== small) line.fontSize = small;
  const pad = Math.round(big * 0.6);
  if (b.paddingTop !== pad) b.paddingTop = b.paddingBottom = b.paddingLeft = b.paddingRight = pad;
  if (b.itemSpacing !== Math.round(small * 0.6)) b.itemSpacing = Math.round(small * 0.6);
  const r = Math.round(big * 0.4);
  if (b.cornerRadius !== r) b.cornerRadius = r;
  const sw = Math.max(6, Math.round(big / 20));
  if (b.strokeWeight !== sw) b.strokeWeight = sw;
}

/**
 * Across all of the page's sections (Live and every lane, from the leftmost to the rightmost), just above them;
 * its height follows its text.
 */
function fit(b: FrameNode) {
  const page = b.parent;
  if (page?.type !== "PAGE") return;
  const secs = page.children.filter((n) => n.type === "SECTION");
  if (b.primaryAxisSizingMode !== "AUTO") b.primaryAxisSizingMode = "AUTO";
  if (!secs.length) return;
  const left = Math.min(...secs.map((n) => n.x));
  const right = Math.max(...secs.map((n) => n.x + n.width));
  const top = Math.min(...secs.map((n) => n.y));
  const w = Math.max(800, right - left);
  if (Math.abs(b.width - w) > 0.5) b.resize(w, b.height);
  // resize() fixes the height: it follows the text again.
  if (b.primaryAxisSizingMode !== "AUTO") b.primaryAxisSizingMode = "AUTO";
  if (b.x !== left) b.x = left;
  // Clear of the sections' title tabs (drawn above each section at screen size: far taller when zoomed out).
  const y = top - b.height - Math.max(200, Math.round(b.height * 0.6));
  if (b.y !== y) b.y = y;
}

/** Shown: the plugin is closing (synchronous: Figma allows no waiting in its close handler). */
export function bannerClosed(): void {
  try {
    if (!banner || banner.removed) return;
    // Lanes may have come or gone while the plugin was open: across all of them again.
    fit(banner);
    if (!banner.visible) banner.visible = true;
  } catch {
    // the file is closing too
  }
}

/** While open: hidden again if another person's plugin closed and showed it. */
export function bannerKeepHidden(): void {
  try {
    if (banner && !banner.removed && banner.visible) banner.visible = false;
  } catch {}
}

async function make(page: PageNode): Promise<FrameNode> {
  const fonts = [
    { family: "Inter", style: "Bold" },
    { family: "Inter", style: "Regular" },
  ];
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
  const f = figma.createFrame();
  f.name = "CoDesignFlo plugin is closed";
  f.setSharedPluginData(NS, "role", ROLE);
  f.layoutMode = "VERTICAL";
  f.primaryAxisSizingMode = "AUTO";
  f.counterAxisSizingMode = "FIXED";
  f.resize(1400, 100);
  // After resize(), which fixes the height: it follows the text.
  f.primaryAxisSizingMode = "AUTO";
  f.itemSpacing = 12;
  f.paddingTop = f.paddingBottom = 36;
  f.paddingLeft = f.paddingRight = 48;
  f.cornerRadius = 24;
  f.fills = [{ type: "SOLID", color: { r: 1, g: 0.93, b: 0.8 } }];
  f.strokes = [{ type: "SOLID", color: { r: 0.96, g: 0.62, b: 0.04 } }];
  f.strokeWeight = 6;
  const line = (text: string, style: "Bold" | "Regular", size: number) => {
    const t = figma.createText();
    t.fontName = { family: "Inter", style };
    t.fontSize = size;
    t.characters = text;
    t.fills = [{ type: "SOLID", color: { r: 0.27, g: 0.16, b: 0.02 } }];
    t.layoutSizingHorizontal = "FIXED";
    f.appendChild(t);
    t.layoutSizingHorizontal = "FILL";
    return t;
  };
  line("Open the CoDesignFlo plugin", "Bold", 56);
  line(
    "While it's closed, Live isn't looked after: changes made here aren't put back, the developer's updates wait, and clicking a component or page doesn't pick it to claim. Plugins → CoDesignFlo.",
    "Regular",
    26,
  );
  page.appendChild(f);
  f.locked = true;
  return f;
}
