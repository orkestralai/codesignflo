// Executor: reconcile Live (the Components and Pages sections) to a compiled spec, idempotently.
// Nodes are found by sync key (originals only: id == origId). Every property is
// read-compared-written; the returned stats count actual writes, so a no-op run reports zeros.
// Ported from spikes S4/S7 (11/11 and 8/8 checks in real Figma).
import {
  hash,
  LAYOUT,
  type LaneDesign,
  mapVariant,
  NODE,
  NS,
  parseVariant,
  type SpecNode,
  specChanges,
  specsByKey,
} from "@codesignflo/core";
import { DS, type LibraryLinks, linksSignature, loadLinks, tokenLinks } from "./designsystem.js";
import {
  dropLaneLabels,
  enter,
  isShot,
  laneOf,
  linkLabel,
  proposals,
  readChunked,
  SHOT,
  sectionIfAny,
  sections,
  stack,
  toArchive,
  writeChunked,
} from "./facts.js";

const COLLECTION = "Tokens";

type Stats = {
  created: number;
  deleted: number;
  moved: number;
  writes: Record<string, number>;
  errors: string[];
  /** Layers whose size in Figma differs from the browser's (after building), with a likely reason. */
  differs?: Difference[];
  /** Share of measured layers matching the app, before and after fitting (0–100), and how many were checked. */
  score?: { before: number; after: number; checked: number };
  /** Layers fitted to the app's size or place after building (CoDesignFlo gaps: the build alone was off). */
  fitted?: string[];
  /** Live is built on the designer's design: its differences from the app are the app's, not CoDesignFlo's. */
  anchored?: boolean;
  /** Built on a design: how many of the design's layers are paired with the app's elements. */
  pairing?: { paired: number; layers: number };
  /** How closely the app follows the designer's design (%), and last time. */
  designMatch?: { now: number; was?: number };
};
export type Difference = { k: string; figma: [number, number]; app: [number, number]; why?: string; at?: true };
const newStats = (): Stats => ({ created: 0, deleted: 0, moved: 0, writes: {}, errors: [] });
const wrote = (s: Stats, prop: string) => (s.writes[prop] = (s.writes[prop] ?? 0) + 1);

export const keyOf = (n: BaseNode) => n.getSharedPluginData(NS, NODE.k);
export const isOriginal = (n: BaseNode) => n.getSharedPluginData(NS, NODE.origId) === n.id;
export const tag = (n: SceneNode, k: string) => {
  n.setSharedPluginData(NS, NODE.k, k);
  n.setSharedPluginData(NS, NODE.origId, n.id);
};

// ---- helpers --------------------------------------------------------------------------------------

/** Key-order-independent JSON (Figma returns {value, unit}, the spec may say {unit, value}). */
const stable = (v: unknown): string =>
  v && typeof v === "object" && !Array.isArray(v)
    ? `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
        .join(",")}}`
    : Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : JSON.stringify(typeof v === "number" ? Math.round(v * 100) / 100 : v);
const near = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.01 : stable(a) === stable(b);
const rgb = (hex: string) => ({
  r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255,
  b: parseInt(hex.slice(5, 7), 16) / 255,
});
const alpha = (hex: string) => (hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1);
const toHex = (c: RGB, opacity = 1) => {
  const h = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${opacity < 0.999 ? h(opacity) : ""}`;
};

let variablesByName = new Map<string, Variable>();
async function loadVariables() {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const col = cols.find((c) => c.name === COLLECTION);
  const vars = await figma.variables.getLocalVariablesAsync();
  variablesByName = new Map(vars.filter((v) => v.variableCollectionId === col?.id).map((v) => [v.name, v]));
  // Tokens linked to the designer's own variables (Design System): layers bind to theirs instead.
  for (const [token, id] of Object.entries(tokenLinks())) {
    const mine = variablesByName.get(token);
    const theirs = await figma.variables.getVariableByIdAsync(id).catch(() => null);
    if (theirs && (!mine || mine.resolvedType === theirs.resolvedType)) variablesByName.set(token, theirs);
  }
}
/** Whether a binding is to the variable a token binds to now (the code's, or the designer's linked one). */
const boundTo = (a: unknown, token: string): boolean => {
  const x = Array.isArray(a) ? a[0] : a;
  const id = x && typeof x === "object" && "id" in x ? (x as { id: string }).id : null;
  return !!id && id === variablesByName.get(token)?.id;
};
/** What the token links are, so Live is rebuilt when one changes. */
const tokensSignature = () => {
  const t = Object.entries(tokenLinks()).sort();
  return t.length ? JSON.stringify(t) : "";
};

// ---- tokens: DTCG → variables in collection "Tokens" ----------------------------------------------

export async function tokensPush(p: { dtcg: Record<string, unknown> }) {
  const stats = newStats();
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const col = cols.find((c) => c.name === COLLECTION) ?? figma.variables.createVariableCollection(COLLECTION);
  const existing = new Map(
    (await figma.variables.getLocalVariablesAsync()).filter((v) => v.variableCollectionId === col.id).map((v) => [v.name, v]),
  );
  const walk = (node: Record<string, unknown>, path: string[], type?: string) => {
    const t = (node.$type as string | undefined) ?? type;
    if ("$value" in node) {
      const name = path.join("/");
      const raw = node.$value;
      let rtype: VariableResolvedDataType;
      let value: VariableValue;
      if (t === "color") {
        rtype = "COLOR";
        // With its alpha: a scrim or a 10% tint drawn solid hid what's behind it.
        value = { ...rgb(String(raw)), a: alpha(String(raw)) };
      } else if (t === "dimension" || t === "fontWeight") {
        rtype = "FLOAT";
        value = Number.parseFloat(String(raw));
      } else return; // fontFamily etc.: no Figma variable binding needed for these
      let v = existing.get(name);
      if (!v) {
        v = figma.variables.createVariable(name, col, rtype);
        stats.created++;
      }
      const cur = v.valuesByMode[col.defaultModeId];
      if (
        !near(
          JSON.stringify(
            cur && typeof cur === "object"
              ? {
                  r: (cur as RGBA).r.toFixed(4),
                  g: (cur as RGBA).g.toFixed(4),
                  b: (cur as RGBA).b.toFixed(4),
                  a: ((cur as RGBA).a ?? 1).toFixed(4),
                }
              : cur,
          ),
          JSON.stringify(
            typeof value === "object"
              ? {
                  r: (value as RGBA).r.toFixed(4),
                  g: (value as RGBA).g.toFixed(4),
                  b: (value as RGBA).b.toFixed(4),
                  a: (value as RGBA).a.toFixed(4),
                }
              : value,
          ),
        )
      ) {
        v.setValueForMode(col.defaultModeId, value);
        wrote(stats, "variable");
      }
      return;
    }
    for (const k of Object.keys(node).filter((x) => !x.startsWith("$"))) walk(node[k] as Record<string, unknown>, [...path, k], t);
  };
  walk(p.dtcg, []);
  return stats;
}

// ---- reconcile ------------------------------------------------------------------------------------

/**
 * A branch preview being built: its "Branch: <name>" section stands in for Live's Components and Pages while
 * reconcile / reconcileScreen run with `preview` (see inPreview).
 */
let previewSec: SectionNode | null = null;
const section = () => (previewSec ? Promise.resolve(previewSec) : sections.components());
const screensSection = () => (previewSec ? Promise.resolve(previewSec) : sections.screens());
/** What a root was last built from (the spec's hash, whether or not the build was clean): previews compare with it. */
const SRC_HASH = "srcHash";
const setSrc = (root: BaseNode, h: string | undefined) => {
  if (h && root.getSharedPluginData(NS, SRC_HASH) !== h) root.setSharedPluginData(NS, SRC_HASH, h);
};
/** Prefix of a branch preview's section on the Live page. */
export const BRANCH_PREFIX = "Branch: ";
const BRANCH = { of: "previewOf", commit: "previewCommit", lane: "previewLane" } as const;

async function branchSection(branch: string, create = true): Promise<SectionNode | null> {
  await figma.loadAllPagesAsync();
  const live = figma.root.children.find((x) => x.name === LAYOUT.live.page);
  if (!live) return null;
  await live.loadAsync();
  const found = live.findChild((n) => n.type === "SECTION" && n.getSharedPluginData(NS, BRANCH.of) === branch) as SectionNode | null;
  if (found || !create) return found;
  const sec = figma.createSection();
  sec.name = `${BRANCH_PREFIX}${branch}`;
  sec.setSharedPluginData(NS, BRANCH.of, branch);
  live.appendChild(sec);
  sec.y = 0;
  sec.resizeWithoutConstraints(1600, 1200);
  return sec;
}

async function inPreview<T>(branch: string, f: () => Promise<T>): Promise<T> {
  previewSec = await branchSection(branch);
  try {
    return await f();
  } finally {
    previewSec = null;
  }
}

/**
 * Which of a branch's items differ from Live: by the hash of the spec each was built from (Live roots built
 * before previews have none: compared by their clean-build mark, else counted as differing).
 */
export async function previewPlan(p: { hashes: Record<string, string> }) {
  const live = new Map([...indexKeyed(await sections.components()), ...indexKeyed(await sections.screens())]);
  const roots = new Map([...live].filter(([k]) => !k.includes("/")));
  const differ = Object.entries(p.hashes)
    .filter(([k, h]) => {
      const n = roots.get(k);
      if (!n) return true;
      const src = n.getSharedPluginData(NS, SRC_HASH);
      return src ? src !== h : !n.getSharedPluginData(NS, NODE.specHash).startsWith(`${BUILD}:${h}`);
    })
    .map(([k]) => k);
  const onlyInLive = [...roots.keys()].filter((k) => !(k in p.hashes));
  return { differ, onlyInLive };
}

/** Before building a preview: its section, emptied of what no longer differs from Live. */
export async function previewStart(p: { branch: string; commit: string; keep: string[] }) {
  const sec = (await branchSection(p.branch))!;
  const keep = new Set(p.keep);
  for (const n of [...sec.children]) {
    if (keep.has(keyOf(n))) continue;
    n.locked = false;
    n.remove();
  }
  return { id: sec.id };
}

/**
 * After building a preview: its name says the branch, who connected it (a lane), the commit and what it shows;
 * the designs it builds are marked, both ways: beside the item here ("Ana's design · 2 of 3 changes in the
 * code →", to her copy) and beside the designer's copy in her lane ("Being built on feat/x · … →", to here).
 * Laid out; an empty one goes.
 */
export async function previewEnd(p: {
  branch: string;
  commit: string;
  built: string[];
  removed: string[];
  lane?: { by?: string };
  designs?: LaneDesign[];
}) {
  const sec = await branchSection(p.branch, false);
  if (!sec?.children.some((c) => keyOf(c))) {
    sec?.remove();
    await dropLaneLabels(p.branch);
    return { removed: !!sec };
  }
  sec.setSharedPluginData(NS, BRANCH.commit, p.commit);
  sec.setSharedPluginData(NS, BRANCH.lane, p.lane ? "1" : "");
  const who = p.lane?.by ? ` · ${p.lane.by}` : "";
  sec.name = `${BRANCH_PREFIX}${p.branch}${who} @${p.commit.slice(0, 7)} — ${p.built.length} differ from Live${p.removed.length ? `, ${p.removed.length} removed` : ""}`;
  const items = new Map(sec.children.filter((c) => keyOf(c)).map((c) => [keyOf(c).replace(/^screen:/, ""), c] as const));
  const copies = new Map((await proposals()).filter((x) => x.role === "proposal").map((x) => [x.claim.id, x] as const));
  const marked = new Set<string>();
  for (const d of p.designs ?? []) {
    const item = items.get(d.component.replace(/^screen:/, ""));
    if (!item) continue;
    const copy = copies.get(d.claim);
    const how = d.done === d.total ? "looks done" : `${d.done} of ${d.total} changes in the code`;
    await linkLabel(sec, keyOf(item), `${copy?.claim.by ?? "The designer"}'s design · ${how}${copy ? " →" : ""}`, copy?.node.id ?? null);
    const lane = copy ? laneOf(copy.node) : null;
    const k = copy?.node.getSharedPluginData(NS, NODE.k);
    if (!copy || !lane || !k) continue;
    await linkLabel(lane, k, `Being built on ${p.branch} · ${how} →`, item.id, p.branch, copy.node.id);
    marked.add(copy.node.id);
    stack(lane);
  }
  await dropLaneLabels(p.branch, marked);
  stack(sec);
  return { removed: false };
}

/** Branches merged into the Live branch: their previews go, with their marks on the designers' copies. */
export async function previewRemove(p: { branches: string[] }) {
  let removed = 0;
  for (const b of p.branches) {
    await dropLaneLabels(b);
    const sec = await branchSection(b, false);
    if (!sec) continue;
    for (const n of sec.children) n.locked = false;
    sec.remove();
    removed++;
  }
  // The sections left close up (stack lines the page's sections up again).
  if (removed) stack(await sections.components());
  return { removed };
}

/** The connected branches now: lanes of branches disconnected since go (one-off previews stay). */
export async function lanesKeep(p: { branches: string[] }) {
  await figma.loadAllPagesAsync();
  const live = figma.root.children.find((x) => x.name === LAYOUT.live.page);
  if (!live) return { removed: [] as string[] };
  await live.loadAsync();
  const keep = new Set(p.branches);
  const gone = live.children
    .filter(
      (n) => n.type === "SECTION" && n.getSharedPluginData(NS, BRANCH.lane) === "1" && !keep.has(n.getSharedPluginData(NS, BRANCH.of)),
    )
    .map((n) => n.getSharedPluginData(NS, BRANCH.of));
  if (gone.length) await previewRemove({ branches: gone });
  return { removed: gone };
}

export function indexKeyed(root: BaseNode & ChildrenMixin): Map<string, SceneNode> {
  const out = new Map<string, SceneNode>();
  for (const n of root.findAll((x) => !!keyOf(x) && isOriginal(x))) out.set(keyOf(n), n);
  return out;
}

/**
 * Pictures: content hash → Figma image hash. Uploaded by a local sync and remembered in the file, so an update
 * through the service (which stores no pictures) reuses the ones the file already has.
 */
const imageHashes = new Map<string, string>();
const IMG = "img.";
export function putImages(p: { images: Record<string, string> }) {
  for (const [ref, png] of Object.entries(p.images)) {
    if (imageHash(ref)) continue;
    const h = figma.createImage(figma.base64Decode(png)).hash;
    imageHashes.set(ref, h);
    figma.root.setSharedPluginData(NS, IMG + ref, h);
  }
  return { images: imageHashes.size };
}
/** Of these pictures, the ones this file doesn't have yet (the panel downloads only those). */
export function missingImages(p: { refs: string[] }) {
  return { refs: p.refs.filter((r) => !imageHash(r)) };
}
function imageHash(ref: string): string | undefined {
  if (!imageHashes.has(ref)) {
    const h = figma.root.getSharedPluginData(NS, IMG + ref);
    if (h) imageHashes.set(ref, h);
  }
  return imageHashes.get(ref);
}
const imageRef = (want: string) => (want.startsWith("image:") ? want.slice(6) : null);

async function paintsEqual(node: SceneNode & MinimalFillsMixin, field: "fills" | "strokes", want: string[], bindTo?: string) {
  const cur = (node as unknown as Record<string, unknown>)[field] as readonly Paint[] | typeof figma.mixed;
  if (cur === figma.mixed || cur.length !== want.length) return false;
  for (let i = 0; i < want.length; i++) {
    const p = cur[i]!;
    const ref = imageRef(want[i]!);
    if (ref) {
      // A picture this file has never received (update through the service): keep the one that's there.
      const h = imageHash(ref);
      if (p.type !== "IMAGE" || (h && p.imageHash !== h)) return false;
      continue;
    }
    const grad = gradientPaint(want[i]!);
    if (grad) {
      if (
        p.type !== "GRADIENT_LINEAR" ||
        stable(p.gradientStops.map((x) => [x.position, x.color])) !== stable(grad.gradientStops.map((x) => [x.position, x.color]))
      )
        return false;
      if (stable(p.gradientTransform) !== stable(grad.gradientTransform)) return false;
      continue;
    }
    if (p.type !== "SOLID") return false;
    if (bindTo) {
      if (!boundTo(p.boundVariables?.color, bindTo)) return false;
    } else if (toHex(p.color, p.opacity ?? 1) !== want[i]!.toLowerCase()) return false;
  }
  return true;
}

/** "gradient:{angle, stops: [[hex, position]…]}" (a CSS linear-gradient) → Figma's linear gradient paint. */
function gradientPaint(want: string): GradientPaint | null {
  if (!want.startsWith("gradient:")) return null;
  const g = JSON.parse(want.slice(9)) as { angle: number; stops: [string, number][] };
  // CSS 90deg (to the right) is Figma's untransformed gradient (left → right); rotate about the centre.
  const r = ((g.angle - 90) * Math.PI) / 180;
  const [c, s] = [Math.cos(r), Math.sin(r)];
  return {
    type: "GRADIENT_LINEAR",
    gradientTransform: [
      [c, s, 0.5 - 0.5 * c - 0.5 * s],
      [-s, c, 0.5 + 0.5 * s - 0.5 * c],
    ],
    gradientStops: g.stops.map(([hex, position]) => ({ position, color: { ...rgb(hex), a: alpha(hex) } })),
  };
}

/**
 * Pictures drawn as a placeholder (the file didn't have them) since the component or page started building:
 * then it isn't marked built, so it's drawn again once they arrive (the same code would be skipped).
 */
let placeholders = 0;
function paints(want: string[], bindTo?: string): Paint[] {
  return want.map((hex): Paint => {
    const grad = gradientPaint(hex);
    if (grad) return grad;
    const ref = imageRef(hex);
    if (ref) {
      const h = imageHash(ref);
      if (h) return { type: "IMAGE", imageHash: h, scaleMode: "FILL" };
      placeholders++;
      return { type: "SOLID", color: rgb("#e0e7ff") };
    }
    let p: SolidPaint = { type: "SOLID", color: rgb(hex), opacity: alpha(hex) };
    const v = bindTo ? variablesByName.get(bindTo) : undefined;
    if (v) p = figma.variables.setBoundVariableForPaint(p, "color", v);
    return p;
  });
}

const STROKE_WEIGHT = /^stroke(Top|Right|Bottom|Left)?Weight$/;
const PADDING = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];

/**
 * The family's own name for the style: fonts spell it differently ("Semi Bold" in Inter, "SemiBold" in
 * Hanken Grotesk) and a wrong spelling fell back to Inter for every text in that weight.
 */
let fontList: Promise<Font[]> | null = null;
/** Monospace fonts to use when the app's isn't in Figma (code, tool names), in order of preference. */
const MONO = ["SF Mono", "Menlo", "Monaco", "Consolas", "JetBrains Mono", "Roboto Mono", "Source Code Pro", "Courier New"];
/** Serif fonts, likewise (Georgia, Times…), to use when the app's isn't in Figma. */
const SERIF = /serif|georgia|times|garamond|cambria|baskerville|palatino|merriweather|playfair|lora/i;
const SERIFS = ["Georgia", "Times New Roman", "Noto Serif", "Source Serif 4", "Merriweather", "PT Serif", "Lora"];
const STYLE_WEIGHT: Record<string, number> = {
  thin: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  heavy: 800,
  black: 900,
};
async function fontInFigma(want: FontName): Promise<FontName> {
  fontList ??= figma.listAvailableFontsAsync();
  const list = await fontList;
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
  const stylesOf = (family: string) => list.filter((f) => f.fontName.family === family).map((f) => f.fontName.style);
  let family = want.family;
  let styles = stylesOf(family);
  // Not in Figma under the app's name ("SFMono-Regular", the CSS name of SF Mono): a monospace font Figma has,
  // for monospace text (else it fell back to Inter, and code read as prose).
  // Likewise a serif (Georgia on a machine without it): a serif Figma has, not Inter.
  const kin = /mono|menlo|monaco|consolas|courier/i.test(family) ? MONO : SERIF.test(family) ? SERIFS : null;
  if (!styles.length && kin) {
    const alt = kin.find((f) => stylesOf(f).length);
    if (alt) {
      family = alt;
      styles = stylesOf(alt);
    }
  }
  if (!styles.length) return want;
  const exact = styles.find((st) => st === want.style) ?? styles.find((st) => norm(st) === norm(want.style));
  if (exact) return { family, style: exact };
  // The nearest weight the family has, italic if asked (Menlo has Regular and Bold: Semi Bold → Bold).
  const italic = /italic/i.test(want.style);
  const weightOf = (st: string) => STYLE_WEIGHT[norm(st).replace("italic", "") || "regular"] ?? 400;
  const target = weightOf(want.style);
  const pool = styles.filter((st) => /italic/i.test(st) === italic && norm(st).replace("italic", "") in { ...STYLE_WEIGHT, "": 1 });
  const best = (pool.length ? pool : styles).reduce((a, b) => (Math.abs(weightOf(b) - target) < Math.abs(weightOf(a) - target) ? b : a));
  return { family, style: best };
}

/** A text's styled runs as Figma has them now equal the spec's (so an unchanged text isn't written again). */
function runsMatch(t: TextNode, spec: SpecNode, base: FontName): boolean {
  if (!spec.runs?.length || t.characters !== spec.props.characters) return false;
  const n = t.characters.length;
  const font = (i: number): FontName => {
    const r = spec.runs!.find((x) => x.start <= i && i < x.end && x.fontName);
    return (r?.fontName as FontName | undefined) ?? base;
  };
  for (const seg of t.getStyledTextSegments(["fontName", "fills", "textDecoration", "fontSize"])) {
    for (const i of [seg.start, seg.end - 1]) {
      if (i < 0 || i >= n) continue;
      const f = font(i);
      if (seg.fontName.family !== f.family || seg.fontName.style !== f.style) return false;
    }
  }
  for (const r of spec.runs) {
    if (r.fill) {
      const f = t.getRangeFills(r.start, r.end);
      if (f === figma.mixed || !paintIs(f as Paint[], r.fill)) return false;
    }
    if (r.underline !== undefined && t.getRangeTextDecoration(r.start, r.end) !== (r.underline ? "UNDERLINE" : "NONE")) return false;
    if (r.fontSize !== undefined && t.getRangeFontSize(r.start, r.end) !== r.fontSize) return false;
  }
  return true;
}
const paintIs = (ps: Paint[], hexColor: string) => {
  const p = ps[0];
  if (ps.length !== 1 || p?.type !== "SOLID") return false;
  const h = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(p.color.r)}${h(p.color.g)}${h(p.color.b)}`.toLowerCase() === hexColor.slice(0, 7).toLowerCase();
};

/** The spec's styled runs onto a text whose base font and colour were just written. */
async function writeRuns(t: TextNode, spec: SpecNode, stats: Stats) {
  for (const r of spec.runs ?? []) {
    const end = Math.min(r.end, t.characters.length);
    if (r.start >= end) continue;
    try {
      if (r.fontName) {
        let f = await fontInFigma(r.fontName as FontName);
        await figma.loadFontAsync(f).catch(async () => {
          f = { family: "Inter", style: f.style };
          await figma.loadFontAsync(f);
        });
        t.setRangeFontName(r.start, end, f);
      }
      if (r.fontSize !== undefined) t.setRangeFontSize(r.start, end, r.fontSize);
      if (r.fill) t.setRangeFills(r.start, end, paints([r.fill]));
      if (r.underline !== undefined) t.setRangeTextDecoration(r.start, end, r.underline ? "UNDERLINE" : "NONE");
    } catch (e) {
      stats.errors.push(`${spec.k}: styled text ${r.start}–${end}: ${String(e)}`);
    }
  }
  wrote(stats, "textRuns");
}

/** `full`: spec is the layer's whole description (not only what changed): what it leaves out isn't wanted. */
async function applyProps(node: SceneNode, spec: SpecNode, stats: Stats, full = true) {
  const n = node as unknown as Record<string, unknown> & SceneNode;
  const props = { ...spec.props };
  const bind = spec.bind ?? {};
  // Inside an auto-layout parent the spec gives layoutSizing*, which implies the axis sizing modes.
  const sizedByParent = "layoutSizingHorizontal" in props;
  // Tag data-driven text so a later diff classifies its changes as content, not code.
  const src = spec.data ? "data" : "";
  if (node.getSharedPluginData(NS, NODE.src) !== src) node.setSharedPluginData(NS, NODE.src, src);
  if (node.name !== spec.name) {
    node.name = spec.name;
    wrote(stats, "name");
  }

  let runsDone = false;
  if (node.type === "TEXT" && !props.fontName) {
    // A change onto a designer's text: keep its fonts (possibly several), load them to write.
    const t = node as TextNode;
    const fonts = t.characters.length ? t.getRangeAllFontNames(0, t.characters.length) : t.fontName === figma.mixed ? [] : [t.fontName];
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f).catch(() => undefined)));
    if (typeof props.characters === "string" && t.characters !== props.characters) {
      t.characters = props.characters;
      wrote(stats, "characters");
    }
    delete props.characters;
  } else if (
    node.type === "TEXT" &&
    spec.runs?.length &&
    runsMatch(node as TextNode, spec, await fontInFigma(props.fontName as FontName))
  ) {
    // Styled runs already as the code has them: the base font and fills are part of that (a mixed font
    // would otherwise be rewritten on every update).
    delete props.fontName;
    delete props.characters;
    delete props.fills;
    if (spec.runs.some((r) => r.fontSize !== undefined)) delete props.fontSize;
    runsDone = true;
  } else if (node.type === "TEXT") {
    const t = node as TextNode;
    let font = await fontInFigma(props.fontName as FontName);
    try {
      await figma.loadFontAsync(font);
    } catch {
      // Not available to Figma (not installed, not a Google font): Inter in the same weight, and say so.
      const missing = `font missing in Figma: ${font.family} ${font.style} (Inter used; install the font for the designer)`;
      if (!stats.errors.includes(missing)) stats.errors.push(missing);
      font = { family: "Inter", style: font.style };
      try {
        await figma.loadFontAsync(font);
      } catch {
        font = { family: "Inter", style: "Regular" };
        await figma.loadFontAsync(font);
      }
    }
    // Variable fonts (Inter) report variationSettings too; family + style is what we set.
    const cur = t.fontName === figma.mixed ? null : { family: t.fontName.family, style: t.fontName.style };
    if (!near(cur, font)) {
      t.fontName = font;
      wrote(stats, "fontName");
    }
    if (t.characters !== props.characters) {
      t.characters = props.characters as string;
      wrote(stats, "characters");
    }
    delete props.fontName;
    delete props.characters;
  }

  // Back in the flow: a layer that was absolute stays absolute until told otherwise, and an absolute layer can't
  // fill (an overlay's frame reused for the row that took its place kept the page's 1728×1080: the column in it
  // was drawn 948 wide instead of 692). The code doesn't place it out of the flow: it isn't.
  if (
    full &&
    !("layoutPositioning" in props) &&
    "layoutPositioning" in node &&
    (node as FrameNode).layoutPositioning === "ABSOLUTE" &&
    node.parent &&
    "layoutMode" in node.parent &&
    (node.parent as FrameNode).layoutMode !== "NONE"
  ) {
    (node as FrameNode).layoutPositioning = "AUTO";
    wrote(stats, "layoutPositioning");
  }
  // Likewise a row that wrapped once stays wrapping until told otherwise (the code only says so when it wraps):
  // "Delete" kept dropping onto a line of its own after the app stopped wrapping that row.
  if (
    full &&
    spec.type !== "INSTANCE" &&
    !("layoutWrap" in props) &&
    "layoutWrap" in node &&
    (node as FrameNode).layoutWrap === "WRAP" &&
    props.layoutMode !== "GRID"
  ) {
    (node as FrameNode).layoutWrap = "NO_WRAP";
    wrote(stats, "layoutWrap");
  }
  // Order matters: layout mode before padding/sizing; sizing modes are implied by layoutSizing* inside auto-layout.
  const order = [
    "layoutMode",
    "layoutWrap",
    ...Object.keys(props).filter(
      (k) => !["layoutMode", "layoutWrap", "width", "height", "fills", "strokes", "x", "y"].includes(k) && !STROKE_WEIGHT.test(k),
    ),
    "width",
    "height",
  ];
  // Grids flow their children row by row, like CSS (grid-auto-flow: row). Figma otherwise keeps each child
  // in the cell it was first given: a grid that went from 2 columns to 4 (the page drawn wider) kept its
  // cards in two rows of two, half of them squeezed under the first row.
  const autoFlow = props.layoutMode === "GRID" && "gridItemsPositioning" in node;
  if (autoFlow) {
    const g = node as FrameNode & { gridItemsPositioning: string; gridAutoTracks: string };
    if (g.layoutMode !== "GRID") g.layoutMode = "GRID";
    if (g.gridItemsPositioning !== "ROW_AUTO_FLOW") {
      g.gridItemsPositioning = "ROW_AUTO_FLOW";
      wrote(stats, "gridItemsPositioning");
    }
    if (g.gridAutoTracks !== "ROWS") g.gridAutoTracks = "ROWS";
  }
  for (const prop of order) {
    if (!(prop in props)) continue;
    // Rows follow the children when they flow (Figma manages the count).
    if (autoFlow && prop === "gridRowCount") continue;
    const want = props[prop];
    if (sizedByParent && (prop === "primaryAxisSizingMode" || prop === "counterAxisSizingMode")) continue;
    // Never resize an axis that hugs or fills: resizing would switch it to FIXED.
    if (prop === "width" && (props.layoutSizingHorizontal === "FILL" || props.layoutSizingHorizontal === "HUG")) continue;
    if (prop === "height" && (props.layoutSizingVertical === "FILL" || props.layoutSizingVertical === "HUG")) continue;
    if (bind[prop]) continue; // bound fields: handled below
    if (prop === "cornerRadius" && bind.topLeftRadius) continue;
    if (prop === "width" || prop === "height") {
      const w = prop === "width" ? (want as number) : node.width;
      const h = prop === "height" ? (want as number) : node.height;
      if (!near(prop === "width" ? node.width : node.height, want)) {
        (node as FrameNode).resize(Math.max(w, 0.01), Math.max(h, 0.01));
        wrote(stats, prop);
      }
      continue;
    }
    if (!(prop in n)) {
      stats.errors.push(`${spec.k}: ${node.type} has no ${prop}`);
      continue;
    }
    if (prop === "gridColumnSizes") {
      // Tracks are changed through the objects Figma hands back (one per column, after gridColumnCount).
      const tracks = n.gridColumnSizes as GridTrackSize[];
      const wantTracks = want as GridTrackSize[];
      if (
        tracks.length === wantTracks.length &&
        wantTracks.some((t, i) => tracks[i]!.type !== t.type || !near(tracks[i]!.value, t.value))
      ) {
        try {
          wantTracks.forEach((t, i) => {
            tracks[i]!.type = t.type;
            if (t.value !== undefined) tracks[i]!.value = t.value;
          });
          wrote(stats, prop);
        } catch (e) {
          stats.errors.push(`${spec.k}: ${prop}: ${String(e)}`);
        }
      }
      continue;
    }
    if (prop === "effects") {
      // Compare what CSS can express; Figma adds its own fields (showShadowBehindNode, boundVariables).
      const pick = (e: Record<string, unknown>) => {
        const c = e.color as RGBA | undefined;
        const r = (x: number) => Math.round(x * 1000) / 1000;
        return [e.type, c && [r(c.r), r(c.g), r(c.b), r(c.a)], e.offset, e.radius, e.spread ?? 0];
      };
      const cur = (n.effects as Record<string, unknown>[]).map(pick);
      if (stable(cur) !== stable((want as Record<string, unknown>[]).map(pick))) {
        n.effects = want;
        wrote(stats, "effects");
      }
      continue;
    }
    if (!near(n[prop], want)) {
      try {
        n[prop] = want;
        wrote(stats, PADDING.includes(prop) ? "padding" : prop);
      } catch (e) {
        stats.errors.push(`${spec.k}: ${prop}: ${String(e)}`);
      }
    }
  }

  // A border that is no longer dashed in code becomes solid again.
  if ("strokes" in props && !("dashPattern" in props) && "dashPattern" in node && (node as GeometryMixin).dashPattern.length) {
    (node as GeometryMixin).dashPattern = [];
    wrote(stats, "dashPattern");
  }

  // Out of the flow: its place, written last and read back. A layer that had just become absolute kept
  // its in-flow place (the scrim at x=376, the overlay at 0 instead of 64).
  if (typeof props.x === "number" && typeof props.y === "number") {
    for (let i = 0; i < 2 && (!near(node.x, props.x) || !near(node.y, props.y)); i++) {
      node.x = props.x;
      node.y = props.y;
      if (i === 0) wrote(stats, "position");
    }
  }

  // Paints (fills / strokes), bound to variables by name when the CSS used a token.
  for (const field of ["fills", "strokes"] as const) {
    if (!(field in props)) continue;
    const want = props[field] as string[];
    const bindTo = spec.paintBind?.[field];
    if (
      !(await paintsEqual(node as SceneNode & MinimalFillsMixin, field, want, bindTo && variablesByName.has(bindTo) ? bindTo : undefined))
    ) {
      (n as unknown as Record<string, unknown>)[field] = paints(want, bindTo);
      wrote(stats, field);
    }
  }

  if (node.type === "TEXT" && spec.runs?.length && !runsDone) await writeRuns(node as TextNode, spec, stats);

  // Stroke weights. Figma quirk (M6): while all four sides are equal, setting one side sets all four
  // (a new node is 1,1,1,1; "right = 0" makes it 0,0,0,0 and the top border is lost). So when any side
  // differs, write every side, zeros first, then the others.
  const weights = Object.keys(props).filter((k) => STROKE_WEIGHT.test(k));
  if (weights.some((k) => !near(n[k], props[k]))) {
    for (const k of [...weights].sort((a, b) => (props[a] as number) - (props[b] as number))) n[k] = props[k];
    wrote(stats, "strokeWeights");
  }

  // Node-level variable bindings (padding, gap, radius, font size). If a field can't be bound
  // (e.g. a newer property), fall back to writing its raw value so the result is still right.
  const unbindable: string[] = [];
  for (const [field, varName] of Object.entries(bind)) {
    const v = variablesByName.get(varName);
    if (!v) {
      stats.errors.push(`${spec.k}: variable ${varName} not found`);
      continue;
    }
    const cur = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables?.[field];
    if (boundTo(cur, varName)) continue;
    try {
      (node as unknown as { setBoundVariable: (f: string, v: Variable) => void }).setBoundVariable(field, v);
      wrote(stats, PADDING.includes(field) ? "padding(bind)" : `${field}(bind)`);
    } catch (e) {
      unbindable.push(field);
      if (!stats.errors.some((x) => x.startsWith(`bind ${field}:`))) stats.errors.push(`bind ${field}: ${String(e)}`);
    }
  }
  for (const field of unbindable) {
    if (field in props && field in n && !near(n[field], props[field])) {
      n[field] = props[field];
      wrote(stats, field);
    }
  }
}

async function create(spec: SpecNode, index: Map<string, SceneNode>, stats: Stats): Promise<SceneNode> {
  let n: SceneNode;
  switch (spec.type) {
    case "COMPONENT":
      n = figma.createComponent();
      break;
    case "FRAME":
      n = figma.createFrame();
      (n as FrameNode).fills = [];
      break;
    case "TEXT":
      n = figma.createText();
      break;
    case "RECTANGLE":
      n = figma.createRectangle();
      break;
    case "SVG":
      n = figma.createNodeFromSvg(spec.svg!);
      scaleSvgStrokes(n as FrameNode, spec.svg!);
      n.setSharedPluginData(NS, "svgHash", svgHash(spec.svg!));
      break;
    case "INSTANCE": {
      const main = libraryMain(spec.instance!.mainK) ?? index.get(spec.instance!.mainK);
      if (main?.type !== "COMPONENT") throw new Error(`main component ${spec.instance!.mainK} not found (compile dependencies first)`);
      n = main.createInstance();
      break;
    }
    default:
      throw new Error(`cannot create ${spec.type}`);
  }
  tag(n, spec.k);
  index.set(spec.k, n);
  stats.created++;
  return n;
}

async function reconcileInstance(node: InstanceNode, spec: SpecNode, index: Map<string, SceneNode>, stats: Stats) {
  const lib = libraryMain(spec.instance!.mainK);
  const main = lib ?? (index.get(spec.instance!.mainK) as ComponentNode | undefined);
  const cur = await node.getMainComponentAsync();
  if (main && cur?.id !== main.id) {
    node.swapComponent(main);
    // Onto the designer's component: what the code's set on it (its size, fills) doesn't carry over.
    if (lib) node.resetOverrides();
    wrote(stats, "mainComponent");
  }
  // Drawn with the designer's component (linked in Design System): shown as they made it, with the code's
  // texts. A link removed swaps it back to Live's (above), and the code's overrides apply again.
  const isLib = lib ? "1" : "";
  if (node.getSharedPluginData(NS, DS.lib) !== isLib) node.setSharedPluginData(NS, DS.lib, isLib);
  if (lib) return libraryTexts(node, spec, stats);
  for (const o of spec.instance!.overrides) {
    let t: SceneNode | undefined = node;
    // Segments are unique among siblings: "link", "link#1", "link#2".
    for (const [depth, seg] of o.path.entries()) {
      // A layer on the path that isn't there ends the walk (reported below) — it used to crash the update.
      if (!t || !("children" in t)) {
        t = undefined;
        break;
      }
      const m = /^(.*)#(\d+)$/.exec(seg);
      const [name, nth] = m ? [m[1]!, Number(m[2])] : [seg, 0];
      const kids: readonly SceneNode[] = (t as ChildrenMixin & SceneNode).children;
      // By name; when the name differs (layer names that carry data, "Agent-Card-<name>"), by position.
      t = kids.filter((c) => c.name === name)[nth] ?? (o.at?.[depth] !== undefined ? kids[o.at[depth]!] : undefined);
    }
    if (!t) {
      stats.errors.push(`${spec.k}: override path ${o.path.join("/")} not found`);
      continue;
    }
    if (o.characters !== undefined) {
      if (t.type !== "TEXT") {
        stats.errors.push(`${spec.k}: override path ${o.path.join("/")} is not a text layer`);
        continue;
      }
      if (t.characters !== o.characters) {
        await figma.loadFontAsync(t.fontName as FontName);
        t.characters = o.characters;
        wrote(stats, "override.characters");
      }
    }
    if (o.fill !== undefined && "fills" in t) {
      const bindTo = o.fillToken && variablesByName.has(o.fillToken) ? o.fillToken : undefined;
      if (!(await paintsEqual(t as SceneNode & MinimalFillsMixin, "fills", [o.fill], bindTo))) {
        (t as unknown as { fills: Paint[] }).fills = paints([o.fill], bindTo);
        wrote(stats, "override.fills");
      }
    }
    // The page's own spacing on a frame of the component (padding, gap, corner radius).
    for (const [f, v] of Object.entries(o.layout ?? {})) {
      const rec = t as unknown as Record<string, unknown>;
      if (!(f in rec) || near(rec[f], v)) continue;
      try {
        rec[f] = v;
        wrote(stats, "override.layout");
      } catch (e) {
        stats.errors.push(`${spec.k}: override ${f}: ${String(e)}`);
      }
    }
  }
}

// ---- the designer's Library components on Live pages (Design System) --------------------------------

let libraryLinks: LibraryLinks = new Map();

/** The Library component that draws this code variant ("components.button/size=sm"), if it's linked. */
function libraryMain(mainK: string): ComponentNode | null {
  const i = mainK.indexOf("/");
  const link = libraryLinks.get(i < 0 ? mainK : mainK.slice(0, i));
  if (!link) return null;
  const at =
    link.variants.length === 1 && !Object.keys(link.variants[0]!.props).length
      ? 0
      : mapVariant(
          parseVariant(i < 0 ? "" : mainK.slice(i + 1)),
          link.map,
          link.variants.map((v) => v.props),
        );
  // No variant for what the code passes: the code's component there (the pair's differences say so).
  if (at < 0) return null;
  const n = link.variants[at]!.node;
  return n.removed ? null : n;
}

/** The code's texts on the designer's component: its text properties, else its text layers, in order. */
async function libraryTexts(node: InstanceNode, spec: SpecNode, stats: Stats) {
  const texts = spec.instance!.overrides.filter((o) => o.characters !== undefined).map((o) => o.characters!);
  if (!texts.length) return;
  let props: [string, ComponentProperties[string]][] = [];
  try {
    props = Object.entries(node.componentProperties).filter(([, v]) => v.type === "TEXT");
  } catch {}
  if (props.length) {
    const want: Record<string, string> = {};
    props.forEach(([name, v], i) => {
      if (texts[i] !== undefined && v.value !== texts[i]) want[name] = texts[i]!;
    });
    if (Object.keys(want).length) {
      try {
        node.setProperties(want);
        wrote(stats, "override.characters");
      } catch (e) {
        stats.errors.push(`${spec.k}: the Library component's text: ${String(e)}`);
      }
    }
    return;
  }
  const layers = node.findAll((n) => n.type === "TEXT" && n.visible) as TextNode[];
  for (const [i, t] of layers.entries()) {
    if (texts[i] === undefined || t.characters === texts[i]) continue;
    try {
      const fonts = t.characters.length ? t.getRangeAllFontNames(0, t.characters.length) : t.fontName === figma.mixed ? [] : [t.fontName];
      await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
      t.characters = texts[i]!;
      wrote(stats, "override.characters");
    } catch (e) {
      stats.errors.push(`${spec.k}: the Library component's text: ${String(e)}`);
    }
  }
}

/** A linked Library instance keeps the designer's size: only where it sits and how it fills its row follow the code. */
function libraryProps(spec: SpecNode): SpecNode {
  const { width: _w, height: _h, ...props } = spec.props;
  for (const f of ["layoutSizingHorizontal", "layoutSizingVertical"]) if (props[f] === "FIXED") delete props[f];
  return { ...spec, props };
}

/**
 * Rename detection: a layer whose key is no longer wanted, sitting where a new key is expected, with the
 * same layer type, is the same element renamed in code (e.g. a class renamed). Re-key it and its
 * descendants instead of deleting and recreating, so proposals and instances keep pointing at it.
 */
function renamed(candidate: SceneNode | undefined, s: SpecNode, wanted: Set<string>, index: Map<string, SceneNode>, stats: Stats) {
  if (!candidate || !isOriginal(candidate)) return undefined;
  const old = keyOf(candidate);
  const sameType = candidate.type === s.type || (s.type === "SVG" && candidate.type === "FRAME");
  if (!old || wanted.has(old) || !sameType || s.type === "INSTANCE") return undefined;
  // A frame with content isn't the same element as one the code gives none (a card isn't a margin's spacer).
  if ("children" in candidate && (candidate as ChildrenMixin).children.length && !s.children?.length) return undefined;
  const nodes: SceneNode[] = [
    candidate,
    ...("findAll" in candidate ? (candidate as ChildrenMixin).findAll((n) => keyOf(n).startsWith(`${old}/`) && isOriginal(n)) : []),
  ];
  // Not when a new key is another layer's already: two layers with one key, and the update kept both (a
  // step's old summary row drawn over its new title: "How it guides customers" twice).
  if (
    nodes.some((n) => {
      const other = index.get(s.k + keyOf(n).slice(old.length));
      return !!other && other !== n && !other.removed;
    })
  )
    return undefined;
  for (const n of nodes) {
    const k = keyOf(n);
    const next = s.k + k.slice(old.length);
    index.delete(k);
    n.setSharedPluginData(NS, NODE.k, next);
    index.set(next, n);
  }
  wrote(stats, "renamed");
  return candidate;
}

/** What an SVG layer was drawn from ("2:": drawn with its strokes scaled, so every icon is drawn again once). */
const svgHash = (svg: string) => `2:${svg.length}${svg.slice(-64)}`;

/**
 * Lines as thick as the browser draws them. An icon drawn bigger than its own coordinates (24 units shown at
 * 176px, stroke-width 1.5) has its lines scaled with it in the browser (11px); Figma's import scales the shape
 * but not the line (it drew 0.75px). Each stroke is set to its stroke-width times the scale.
 */
function scaleSvgStrokes(n: FrameNode, svg: string) {
  const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
  if (!vb || !(Number(vb[1]) > 0)) return;
  const k = Math.min(n.width / Number(vb[1]), n.height / Number(vb[2]));
  if (!Number.isFinite(k) || Math.abs(k - 1) < 0.01) return;
  const width = (attrs: string) => /stroke-width="([\d.]+)"/.exec(attrs)?.[1];
  const rootWidth = width(/<svg\b([^>]*)>/.exec(svg)?.[1] ?? "") ?? "1";
  // Shapes in the order Figma imports them, each with its own stroke-width or the one it inherits.
  const own = [...svg.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*)>/g)].map((m) => width(m[2]!) ?? rootWidth);
  const stroked = n.findAll(
    (x) => "strokes" in x && Array.isArray((x as GeometryMixin).strokes) && (x as GeometryMixin).strokes.length > 0,
  );
  stroked.forEach((x, i) => {
    const w = Number(own[i] ?? rootWidth);
    if (w > 0) (x as GeometryMixin & MinimalStrokesMixin).strokeWeight = Math.round(w * k * 100) / 100;
  });
}

async function reconcileChildren(parent: SceneNode & ChildrenMixin, specs: SpecNode[], index: Map<string, SceneNode>, stats: Stats) {
  const wanted = new Set(specs.map((s) => s.k));
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!;
    let node = index.get(s.k);
    // A layer kept as design is left exactly as it is (not even recreated when the code changes its type).
    const keep = !!node && pinsOf(node).includes("*");
    // SVG content changed → recreate in place (Figma can't patch vector markup).
    if (node && !keep && s.type === "SVG" && node.getSharedPluginData(NS, "svgHash") !== svgHash(s.svg!)) {
      node.remove();
      index.delete(s.k);
      stats.deleted++;
      node = undefined;
    }
    if (node && !keep && s.type !== node.type && !(s.type === "SVG" && node.type === "FRAME")) {
      node.remove();
      index.delete(s.k);
      stats.deleted++;
      node = undefined;
    }
    if (!node) node = renamed(parent.children[i], s, wanted, index, stats);
    if (!node) node = await create(s, index, stats);
    if (node.parent !== parent || parent.children.indexOf(node) !== i) {
      const wasHere = node.parent === parent;
      parent.insertChild(i, node);
      if (wasHere) stats.moved++;
    }
    await reconcileNode(node, s, index, stats);
  }
  // Owned (keyed) children that are no longer in the spec, or a second layer with a key the spec has (only the
  // one the update just placed is it: an older one with the same key was left over and drawn twice).
  for (const c of [...parent.children]) {
    const k = keyOf(c);
    const stale = !wanted.has(k) || index.get(k) !== c;
    // Kept as design (pinned) layers stay even when the code doesn't have them.
    if (k && isOriginal(c) && stale && !pinsOf(c).includes("*")) {
      c.remove();
      if (index.get(k) === c) index.delete(k);
      stats.deleted++;
    }
  }
  placeInGrid(parent, stats);
}

/**
 * A grid without automatic flow (an older Figma): each child in the cell its order gives it, row by row.
 * Moved through rows below the grid first, so no child is put in a cell another still holds.
 */
function placeInGrid(parent: SceneNode & ChildrenMixin, stats: Stats) {
  const g = parent as FrameNode;
  if (!("layoutMode" in g) || g.layoutMode !== "GRID") return;
  if ((g as unknown as { gridItemsPositioning?: string }).gridItemsPositioning === "ROW_AUTO_FLOW") return;
  const kids = g.children.filter((c) => !("layoutPositioning" in c && c.layoutPositioning === "ABSOLUTE")) as (SceneNode &
    GridChildrenMixin)[];
  const cols = Math.max(1, g.gridColumnCount);
  const at = (i: number) => [Math.floor(i / cols), i % cols] as const;
  if (kids.every((c, i) => c.gridRowAnchorIndex === at(i)[0] && c.gridColumnAnchorIndex === at(i)[1])) return;
  const rows = Math.max(1, Math.ceil(kids.length / cols));
  try {
    g.gridRowCount = rows + kids.length;
    for (const [i, c] of kids.entries()) c.setGridChildPosition(rows + i, 0);
    for (const [i, c] of kids.entries()) c.setGridChildPosition(...at(i));
    g.gridRowCount = rows;
    wrote(stats, "gridChildPosition");
  } catch (e) {
    stats.errors.push(`${parent.name}: couldn't place the grid's children: ${String(e)}`);
  }
}

/**
 * Progress while a long reconcile runs (the CLI's timeout is "without progress"): Figma in the background
 * can run plugins far slower (macOS App Nap), and a slow sync should finish, not fail.
 */
let progress: ((done: number) => void) | null = null;
let progressDone = 0;
let progressAt = 0;
export function onProgress(f: ((done: number) => void) | null) {
  progress = f;
  progressDone = 0;
  progressAt = Date.now();
}
const tick = () => {
  progressDone++;
  if (progress && Date.now() - progressAt > 1000) {
    progressAt = Date.now();
    progress(progressDone);
  }
};

/** The properties (diff names) the designer kept as design on this layer; ["*"]: the whole layer. */
export const pinsOf = (n: BaseNode): string[] => {
  const raw = n.getSharedPluginData(NS, NODE.pin);
  return raw ? (JSON.parse(raw) as string[]) : [];
};

/** The Figma fields behind a diff property name. */
function fieldsOf(prop: string): string[] {
  if (prop === "padding") return ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
  if (prop === "cornerRadius") return ["cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"];
  if (prop === "size")
    return ["layoutSizingHorizontal", "layoutSizingVertical", "primaryAxisSizingMode", "counterAxisSizingMode", "width", "height"];
  if (prop === "strokeWeights") return ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];
  if (prop === "layout.mode") return ["layoutMode"];
  if (prop.startsWith("layout.")) return [prop.slice(7)];
  return [prop];
}

/**
 * Kept as design: remember the pinned properties (values and token bindings) before the code's are written,
 * and put them back after — the update writes everything else as usual.
 */
async function keepPinned(node: SceneNode, pins: string[]): Promise<() => Promise<void>> {
  const raw = node as unknown as Record<string, unknown>;
  const bound = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables ?? {};
  const saved = pins
    .flatMap(fieldsOf)
    .filter((f) => f in raw)
    .map((f) => ({ f, v: raw[f], b: bound[f] }));
  return async () => {
    if (node.type === "TEXT" && node.fontName !== figma.mixed) await figma.loadFontAsync(node.fontName);
    for (const { f, v } of saved) {
      if (v === figma.mixed) continue;
      if (f === "width" || f === "height") continue;
      if (f === "fontName") await figma.loadFontAsync(v as FontName);
      if (JSON.stringify(raw[f]) !== JSON.stringify(v)) raw[f] = v;
    }
    const w = saved.find((x) => x.f === "width")?.v as number | undefined;
    const h = saved.find((x) => x.f === "height")?.v as number | undefined;
    if ((w !== undefined && w !== node.width) || (h !== undefined && h !== node.height))
      (node as FrameNode).resize(w ?? node.width, h ?? node.height);
    const setBound = (node as unknown as { setBoundVariable: (f: string, v: Variable | null) => void }).setBoundVariable.bind(node);
    for (const { f, b } of saved) {
      if (f === "fills" || f === "strokes") continue; // the paints carry their own bindings
      const alias = (Array.isArray(b) ? b[0] : b) as { id?: string } | undefined;
      const now = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables?.[f];
      if (alias?.id) setBound(f, await figma.variables.getVariableByIdAsync(alias.id));
      else if (now) setBound(f, null);
    }
  };
}

async function reconcileNode(node: SceneNode, spec: SpecNode, index: Map<string, SceneNode>, stats: Stats) {
  tick();
  const pins = pinsOf(node);
  if (pins.includes("*")) return; // the whole layer is kept as design
  const restore = pins.length ? await keepPinned(node, pins) : null;
  try {
    await reconcileOwn(node, spec, index, stats);
  } finally {
    await restore?.();
  }
}

async function reconcileOwn(node: SceneNode, spec: SpecNode, index: Map<string, SceneNode>, stats: Stats) {
  if (spec.type === "INSTANCE") {
    const own = libraryMain(spec.instance!.mainK) ? libraryProps(spec) : spec;
    await applyProps(node, own, stats);
    await reconcileInstance(node as InstanceNode, spec, index, stats);
    // Swapping the main component or setting its content can resize it: its size here is the app's.
    await applyProps(node, own, stats);
    return;
  }
  if (spec.type === "SVG") {
    await applyProps(node, spec, stats);
    return;
  }
  // Own layout first (children's FILL/HUG need an auto-layout parent), then children.
  await applyProps(node, spec, stats);
  // No children in the code: none of Live's own stay either (a frame reused for a spacer kept a whole profile
  // card inside it, spilling over the page). A designer's own layers in it stay.
  if ("children" in node) await reconcileChildren(node as SceneNode & ChildrenMixin, spec.children ?? [], index, stats);
}

/** Reconcile one component set. Variants are reconciled before the set is (re)combined. `gen` is recorded on the set. */
/**
 * Adopting a designer's design (Phase 2): their copy becomes the Live node instead of a fresh one, so what
 * the code doesn't define (Figma-only settings) survives. Layers are matched to the code by name and type,
 * top-down, and get the code's keys; layers the code doesn't have are removed (the designer's original
 * stays in Archive); missing ones are created by the normal reconcile that follows.
 */
function adoptTree(n: SceneNode, s: SpecNode) {
  tag(n, s.k);
  // A placed component's layers come from its main component (Figma won't let them be removed): the
  // reconcile that follows points it at the right Live component.
  if (n.type === "INSTANCE" || !("children" in n)) return;
  const kids = [...(n as ChildrenMixin).children] as SceneNode[];
  const used = new Set<SceneNode>();
  const fits = (c: SceneNode, sc: SpecNode) =>
    sc.type !== "SVG" && (c.type === sc.type || (sc.type === "FRAME" && (c.type === "GROUP" || c.type === "COMPONENT")));
  for (const sc of s.children ?? []) {
    const match = kids.find((c) => !used.has(c) && c.name === sc.name && fits(c, sc));
    if (match) {
      used.add(match);
      if (match.type === "GROUP" && sc.type === "FRAME") continue; // groups have no auto layout: rebuilt
      adoptTree(match, sc);
    }
  }
  for (const c of kids) if (!used.has(c) || c.type === "GROUP") c.remove();
}

/** A copy of the designer's node, cleared of proposal data, ready to adopt into a Live section. */
function adoptable(src: SceneNode, into: SectionNode): SceneNode {
  const copy = src.clone();
  into.appendChild(copy);
  for (const k of copy.getSharedPluginDataKeys(NS)) copy.setSharedPluginData(NS, k, "");
  copy.locked = false;
  return copy;
}

// ---- Live built on the designer's design --------------------------------------------------------------
//
// A component or page the designer drew is the base of Live: its layers are matched to the code's (kept
// for the next updates), and an update writes only what the code changed since the last one. Layers only
// the design has stay; layers only the code has are added. Generated from code only when there's no design.

/**
 * Bumped when building on a design changes: every page with a design is looked at again once (2: nothing
 * inserted; 3: paired by text and place; 4: Live shows the app — built on the design only when the app follows it).
 */
const ANCHOR_V = 4;
/** Live is built on the design only when the app follows it this closely; otherwise Live is generated from the app. */
const FOLLOWS = 0.8;
/** The design a page was compared with: whether Live is built on it, and how closely the app followed it (%). */
type Anchor = { id: string; at: string; v?: number; used?: boolean; match?: number };
const anchorOf = (n: BaseNode): Anchor | null => {
  try {
    return JSON.parse(n.getSharedPluginData(NS, NODE.anchor) || "null") as Anchor | null;
  } catch {
    return null;
  }
};

/** The designer's latest design for a component or page that the code has implemented (an archived proposal). */
async function latestDesign(component: string, closed: Set<string>): Promise<{ node: SceneNode; at: string } | null> {
  const archive = await sections.archive();
  let best: { node: SceneNode; at: string } | null = null;
  for (const n of archive.children) {
    let c: { id?: string; component?: string; at?: string } = {};
    try {
      c = JSON.parse(n.getSharedPluginData(NS, NODE.claim) || "{}");
    } catch {}
    // Only a design the code implemented (its proposal closed): a withdrawn copy is archived too.
    if (c.component !== component || !c.at || !c.id || !closed.has(c.id) || n.getSharedPluginData(NS, NODE.removedFromCode)) continue;
    if (!best || c.at > best.at) best = { node: n, at: c.at };
  }
  return best;
}

/** A placed component the designer drew as plain layers follows the component's layers, inlined. */
const follow = (s: SpecNode, n: BaseNode | undefined) => (s.type === "INSTANCE" && s.inlined && n && n.type !== "INSTANCE" ? s.inlined : s);

const SHAPES = ["VECTOR", "ELLIPSE", "RECTANGLE", "LINE", "STAR", "POLYGON", "BOOLEAN_OPERATION"];
/** The only text inside a chain of single-child wrappers (a heading the design wraps in a frame). */
const soleText = (n: SceneNode): TextNode | undefined =>
  n.type === "TEXT" ? n : "children" in n && n.type !== "INSTANCE" && n.children.length === 1 ? soleText(n.children[0]!) : undefined;
const soleTextSpec = (s: SpecNode): SpecNode | undefined =>
  s.type === "TEXT" ? s : s.type !== "INSTANCE" && s.children?.length === 1 ? soleTextSpec(s.children[0]!) : undefined;

/** Can this layer of the design be that layer of the code? (Leaves: any shape draws a dot or an icon.) */
const designFits = (c: SceneNode, sc: SpecNode) =>
  sc.type === "TEXT"
    ? !!soleText(c)
    : c.type === "TEXT"
      ? !!soleTextSpec(sc)
      : sc.type === "SVG"
        ? [...SHAPES, "FRAME", "GROUP", "INSTANCE"].includes(c.type)
        : sc.type === "RECTANGLE" || !sc.children?.length
          ? [...SHAPES, "FRAME", "GROUP", "COMPONENT", "INSTANCE"].includes(c.type)
          : ["FRAME", "GROUP", "COMPONENT", "INSTANCE"].includes(c.type);

/**
 * Matches the design's layers to the code's, top-down: by name, then by position among the layers left of a
 * compatible type. Matched layers get the code's keys; the others are kept as the designer drew them.
 */
function matchDesign(n: SceneNode, s0: SpecNode, counts: { matched: number }) {
  const s = follow(s0, n);
  tag(n, s.k);
  counts.matched++;
  if (n.type === "INSTANCE" || !("children" in n) || s.type === "INSTANCE" || s.type === "SVG") return;
  const kids = [...(n as ChildrenMixin).children] as SceneNode[];
  const used = new Set<SceneNode>();
  const pairs: [SpecNode, SceneNode | undefined][] = (s.children ?? []).map((sc) => {
    // The same name: the same element, however the designer drew it (a logo as vectors, the code as text).
    const m = kids.find((c) => !used.has(c) && c.name === sc.name);
    if (m) used.add(m);
    return [sc, m];
  });
  // The rest in order, by compatible type and a similar size: the same element named differently in the
  // design. (By type alone, a margin spacer paired with a nav link, and the page's layout went wrong.)
  const similar = (c: SceneNode, sc: SpecNode) => {
    const m = sc.measured;
    if (!m || !("width" in c)) return false;
    const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(12, 0.25 * Math.max(a, b));
    return near(c.width, m.w) && near(c.height, m.h);
  };
  for (const pair of pairs) {
    if (pair[1]) continue;
    const m = kids.find((c) => !used.has(c) && designFits(c, pair[0]) && similar(c, follow(pair[0], c)));
    if (m) {
      used.add(m);
      pair[1] = m;
    }
  }
  for (const [sc, m] of pairs) {
    if (!m) continue;
    // A text and its wrapper on one side only: the texts are the same layer.
    if (sc.type === "TEXT" && m.type !== "TEXT" && soleText(m)) matchDesign(soleText(m)!, sc, counts);
    else if (m.type === "TEXT" && sc.type !== "TEXT" && soleTextSpec(sc)) matchDesign(m, soleTextSpec(sc)!, counts);
    else matchDesign(m, sc, counts);
  }
}

/** Names that say nothing about which element it is (an element's tag, Figma's default names). */
const GENERIC_NAME =
  /^(div|span|p|a|li|ul|ol|section|main|header|footer|nav|article|aside|form|input|select|textarea|button|label|text|value|placeholder|svg|img|image|vector|frame( \d+)?|group( \d+)?|rectangle( \d+)?|ellipse( \d+)?|container|wrapper|content|inner|.*-margin(-top|-left)?)(#\d+)?$/i;

/**
 * The code wraps or nests elements differently from the design (an extra div here and there): what pairing
 * level by level missed is paired by a distinctive name the design uses once, wherever it is on the page.
 */
function matchByName(copy: SceneNode, spec: SpecNode, counts: { matched: number }) {
  if (!("findAll" in copy)) return;
  const all = (copy as FrameNode).findAll(() => true);
  const seen = new Map<string, number>();
  for (const n of all) seen.set(n.name, (seen.get(n.name) ?? 0) + 1);
  const free = new Map(all.filter((n) => !keyOf(n) && seen.get(n.name) === 1).map((n) => [n.name, n]));
  const taken = new Set(all.flatMap((n) => (keyOf(n) ? [keyOf(n)] : [])));
  const walk = (s0: SpecNode, inPaired: boolean) => {
    const s = s0.type === "INSTANCE" && s0.inlined ? s0.inlined : s0;
    const paired = taken.has(s.k);
    if (!paired && !inPaired && !GENERIC_NAME.test(s.name)) {
      const n = free.get(s.name);
      if (n && designFits(n, s0) && !n.removed) {
        free.delete(s.name);
        matchDesign(n, s0, counts);
        for (const d of [n, ...("findAll" in n ? (n as FrameNode).findAll(() => true) : [])]) {
          if (keyOf(d)) taken.add(keyOf(d));
          free.delete(d.name);
        }
        return;
      }
    }
    if (s.type !== "INSTANCE") for (const c of s.children ?? []) walk(c, false);
  };
  walk(spec, false);
}

/**
 * Pairing without names, now that the app is rendered at the design's size: a text found once on both sides
 * is the same element wherever it moved, and a layer where the app has an element of the same kind, place
 * and size (mostly overlapping) is that element.
 */
function matchByPlace(copy: SceneNode, spec: SpecNode, counts: { matched: number }) {
  if (!("findAll" in copy) || !copy.absoluteBoundingBox) return;
  const o = copy.absoluteBoundingBox;
  const norm = (t: string | undefined) => (t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  type Box = { x: number; y: number; w: number; h: number; text: string | null };
  const design = (copy as FrameNode)
    .findAll((n) => !keyOf(n))
    .flatMap((n) => {
      const b = n.absoluteBoundingBox;
      return b
        ? [
            { n, x: b.x - o.x, y: b.y - o.y, w: b.width, h: b.height, text: n.type === "TEXT" ? norm(n.characters) : null } as Box & {
              n: SceneNode;
            },
          ]
        : [];
    });
  const taken = new Set((copy as FrameNode).findAll((n) => !!keyOf(n)).map((n) => keyOf(n)));
  taken.add(keyOf(copy));
  const app: (Box & { s: SpecNode })[] = [];
  const walk = (s0: SpecNode) => {
    const s = s0.inlined ?? s0;
    const m = s.measured;
    if (m?.x !== undefined && m.y !== undefined && !taken.has(s.k))
      app.push({ s, x: m.x, y: m.y, w: m.w, h: m.h, text: s.type === "TEXT" ? norm(s.props.characters as string | undefined) : null });
    for (const c of s.children ?? []) walk(c);
  };
  walk(spec);
  const pairs: { a: (typeof app)[number]; b: (typeof design)[number]; score: number }[] = [];
  // Texts found once on both sides.
  const once = (xs: { text: string | null }[]) => {
    const c = new Map<string, number>();
    for (const x of xs) if (x.text) c.set(x.text, (c.get(x.text) ?? 0) + 1);
    return c;
  };
  const [ca, cb] = [once(app), once(design)];
  for (const a of app)
    if (a.text && ca.get(a.text) === 1 && cb.get(a.text) === 1) {
      const b = design.find((x) => x.text === a.text)!;
      pairs.push({ a, b, score: 2 });
    }
  // The same kind of layer, mostly overlapping.
  const iou = (a: Box, b: Box) => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const i = ix * iy;
    const u = a.w * a.h + b.w * b.h - i;
    return u > 0 ? i / u : 0;
  };
  for (const a of app)
    for (const b of design) {
      if ((a.text === null) !== (b.text === null) || !designFits(b.n, a.s)) continue;
      const v = iou(a, b);
      if (v >= 0.75) pairs.push({ a, b, score: v + (a.text && a.text === b.text ? 0.5 : 0) });
    }
  pairs.sort((p, q) => q.score - p.score);
  const usedA = new Set<SpecNode>();
  const usedB = new Set<SceneNode>();
  for (const { a, b } of pairs) {
    if (usedA.has(a.s) || usedB.has(b.n) || taken.has(a.s.k) || keyOf(b.n)) continue;
    usedA.add(a.s);
    usedB.add(b.n);
    tag(b.n, a.s.k);
    taken.add(a.s.k);
    counts.matched++;
  }
}

/** Writes what the code changed on one layer of the design (only the fields that layer has). */
async function applyChanges(n: SceneNode, s: SpecNode, prev: SpecNode, stats: Stats, skipped: { n: number }) {
  const ch = specChanges(prev, s);
  if (!ch) return;
  const props = Object.fromEntries(Object.entries(ch.props).filter(([f]) => f in n || f === "width" || f === "height"));
  skipped.n += Object.keys(ch.props).length - Object.keys(props).length;
  if (!Object.keys(props).length) return;
  await applyProps(n, { k: s.k, type: s.type, name: n.name, props, bind: ch.bind, paintBind: ch.paintBind }, stats, false);
}

/**
 * Brings Live built on a design up to date with the code: `prev` is the code of the last update (null: the
 * design was just matched — nothing to change, only what the design lacks is added). Returns the keys of
 * layers it created (generated from code, so they can be fitted to the app).
 */
async function patchDesign(root: SceneNode, prevSpec: SpecNode | null, spec: SpecNode, index: Map<string, SceneNode>, stats: Stats) {
  const created = new Set<string>();
  const skipped = { n: 0 };
  /** Parts of the app the design doesn't have, left out (the design is the base). */
  const notInDesign: string[] = [];
  const prev = prevSpec ? specsByKey(prevSpec, (x) => follow(x, index.get(x.k))) : null;
  const walk = async (parent: (SceneNode & ChildrenMixin) | null, s0: SpecNode, siblings: SpecNode[]) => {
    let n = index.get(s0.k);
    // A layer removed meanwhile (an earlier step of this update) is gone: as if missing.
    if (n?.removed) {
      index.delete(s0.k);
      n = undefined;
    }
    const s = follow(s0, n);
    if (!n) {
      if (!parent) return;
      // Matched further down (a wrapper the design doesn't have): its layers are there — go on with them.
      const inner = specsByKey(s);
      if ([...inner.keys()].some((k) => k !== s.k && index.has(k))) {
        for (const c of s.children ?? []) await walk(parent, c, s.children ?? []);
        return;
      }
      // Margin spacers are how CoDesignFlo draws CSS margins; a designer's layers have their own spacing.
      if (/-margin(-top|-left)?$/.test(s.name) && !s.children?.length) return;
      // Only what the code added since the last update is added to the design. What the app has and the
      // design never had stays out (inserted into the designer's layout, it squeezed and broke it).
      if (!prev || prev.has(s.k)) {
        notInDesign.push(s.name);
        return;
      }
      // New in code: generated where the code has it — after the layer before it.
      const before = siblings
        .slice(0, siblings.indexOf(s0))
        .reverse()
        .map((x) => index.get(x.k))
        .find((x) => x && !x.removed && x.parent === parent);
      n = await create(s, index, stats);
      parent.insertChild(before ? parent.children.indexOf(before) + 1 : 0, n);
      if ("layoutMode" in parent && parent.layoutMode === "NONE" && before) {
        n.x = before.x;
        n.y = before.y + before.height;
      }
      await reconcileNode(n, s, index, stats);
      const mark = (x: SpecNode) => {
        created.add(x.k);
        if (x.type !== "INSTANCE") for (const c of x.children ?? []) mark(c);
      };
      mark(s);
      return;
    }
    const p = prev?.get(s.k);
    if (p && !pinsOf(n).includes("*")) {
      await applyChanges(n, s, p, stats, skipped);
      if (s.type === "INSTANCE" && n.type === "INSTANCE" && JSON.stringify(p.instance) !== JSON.stringify(s.instance))
        await reconcileInstance(n, s, index, stats);
    }
    if (s.type === "INSTANCE" || n.type === "INSTANCE" || !("children" in n)) return;
    for (const c of s.children ?? []) await walk(n as SceneNode & ChildrenMixin, c, s.children ?? []);
  };
  await walk(null, spec, []);
  // Gone from the code: its layer goes (the designer's original is in Archive).
  if (prev) {
    const now = specsByKey(spec, (x) => follow(x, index.get(x.k)));
    for (const k of prev.keys()) {
      const n = index.get(k);
      if (!now.has(k) && n && n !== root && isOriginal(n) && !pinsOf(n).includes("*") && !n.removed) {
        n.remove();
        index.delete(k);
        stats.deleted++;
      }
    }
  }
  if (notInDesign.length)
    stats.errors.push(
      `${spec.k}: ${notInDesign.length} part(s) of the app aren't in the design, so they're not added to Live (the design is its base): ${notInDesign.slice(0, 6).join(", ")}${notInDesign.length > 6 ? "…" : ""}`,
    );
  if (skipped.n)
    stats.errors.push(
      `${spec.k}: ${skipped.n} code change(s) have no place in the design's layers (a group or a layer without auto layout)`,
    );
  return created;
}

/**
 * Live from the designer's design: a copy of it, matched to the code, takes the place of what Live had.
 * Instances of a replaced component now point at the new one.
 */
/**
 * A copy of the designer's design, its layers paired with the app's (scratch until it's kept): how closely the
 * app follows it — paired layers over the larger of the two — decides whether Live is built on it.
 */
async function designCopy(design: { node: SceneNode; at: string }, spec: SpecNode, into: SectionNode) {
  let copy = adoptable(design.node, into);
  if (copy.type === "INSTANCE") copy = copy.detachInstance();
  // Keys the design's layers carried before (a copy of Live the designer edited) are matched afresh.
  if ("findAll" in copy)
    for (const d of (copy as FrameNode).findAll(() => true)) {
      if (d.getSharedPluginData(NS, NODE.k)) d.setSharedPluginData(NS, NODE.k, "");
      if (d.getSharedPluginData(NS, NODE.origId)) d.setSharedPluginData(NS, NODE.origId, "");
    }
  const counts = { matched: 0 };
  matchDesign(copy, spec, counts);
  matchByName(copy, spec, counts);
  matchByPlace(copy, spec, counts);
  copy.name = spec.name;
  const layers = 1 + ("findAll" in copy ? (copy as FrameNode).findAll(() => true).length : 0);
  const appLayers = specsByKey(spec, (x) => x.inlined ?? x).size;
  return { copy, paired: counts.matched, layers, match: counts.matched / Math.max(layers, appLayers) };
}

/** The designer's own instances of the component they designed now point at the Live component. */
async function swapInstances(from: ComponentNode, to: ComponentNode) {
  await figma.loadAllPagesAsync();
  for (const inst of figma.root.findAll((n) => n.type === "INSTANCE") as InstanceNode[]) {
    if ((await inst.getMainComponentAsync())?.id === from.id) inst.swapComponent(to);
  }
}

/**
 * Live against the browser, layer by layer, after building: sizes that differ beyond rounding (2 px or 3%).
 * Only the deepest layer of a chain (a parent grows with its child), the largest first, at most 5, each with
 * a likely reason where CoDesignFlo can tell.
 */
type Found = Difference & { size: number };
/** Every layer whose size (or place, for absolute layers) differs from the app's, and how many were checked. */
function measure(spec: SpecNode, index: Map<string, SceneNode>, stats: Stats): { found: Found[]; checked: number } {
  let checked = 0;
  const off = (a: number, b: number) => Math.abs(a - b) > Math.max(2, 0.03 * Math.max(a, b));
  const fontMissing = stats.errors.some((e) => e.startsWith("font missing"));
  const found: Found[] = [];
  const walk = (s0: SpecNode) => {
    const n = index.get(s0.k);
    const s = follow(s0, n);
    // The designer's component, as they made it: not measured against the app (its differences are the pair's).
    if (n && n.type === "INSTANCE" && n.getSharedPluginData(NS, DS.lib)) return;
    if (s.measured && n && "width" in n && s.type !== "COMPONENT_SET") {
      checked++;
      const [w, h] = [Math.round(n.width), Math.round(n.height)];
      // Text that hugs its words is narrower than the row it fills in the browser, and looks the same:
      // only wider (overflowing) counts.
      const hugs = s.type === "TEXT" && s.props.textAutoResize === "WIDTH_AND_HEIGHT";
      const wOff = hugs ? w > s.measured.w + Math.max(2, 0.03 * s.measured.w) : off(w, s.measured.w);
      if (wOff || off(h, s.measured.h)) {
        const unset = stats.errors.some((e) => e.startsWith(`${s.k}:`) && e.includes("override"));
        const why =
          s.type === "TEXT"
            ? fontMissing
              ? "a font Figma doesn't have (drawn with Inter)"
              : "the text wraps or breaks differently"
            : s.type === "INSTANCE"
              ? unset
                ? "a placed component whose content couldn't all be set"
                : "a placed component: its size comes from the component"
              : undefined;
        found.push({
          k: s.k,
          figma: [w, h],
          app: [s.measured.w, s.measured.h],
          ...(why ? { why } : {}),
          size: Math.abs(w - s.measured.w) + Math.abs(h - s.measured.h),
        });
      }
    }
    // Absolute layers: where they sit, not only their size (x, y in "figma" / "app").
    if (n && "x" in n && typeof s.props.x === "number" && typeof s.props.y === "number") {
      const [x, y] = [Math.round(n.x), Math.round(n.y)];
      if (off(x, s.props.x) || off(y, s.props.y))
        found.push({
          k: s.k,
          figma: [x, y],
          app: [s.props.x, s.props.y],
          why: "placed elsewhere",
          at: true,
          size: Math.abs(x - s.props.x) + Math.abs(y - s.props.y),
        });
    }
    if (s.type !== "INSTANCE") for (const c of s.children ?? []) walk(c);
  };
  walk(spec);
  return { found, checked };
}

/** The innermost differing layers (fixing a child often fixes its parent). */
const deepestOf = (found: Found[]) => found.filter((d) => !found.some((o) => o !== d && o.k.startsWith(`${d.k}/`)));

/** What's left to report: the innermost differences, misplaced layers first, largest first. */
function differences(found: Found[]): Difference[] {
  return deepestOf(found)
    .sort((a, b) => Number(!!b.at) - Number(!!a.at) || b.size - a.size)
    .slice(0, 5)
    .map(({ size: _, ...d }) => d);
}

const ROUNDS = 3;
/**
 * The self-correcting loop: after building, every layer is measured against the app; the innermost ones
 * that differ are fitted to it (size, lines, place), and Live is measured again — up to ROUNDS times,
 * while it keeps improving. Fitted layers are marked and reported: each is a gap in how CoDesignFlo builds,
 * to fix at its cause. Layers the designer kept as design are left alone.
 */
async function fitToApp(spec: SpecNode, index: Map<string, SceneNode>, stats: Stats, only?: Set<string>) {
  const specs = new Map<string, SpecNode>();
  const collect = (s0: SpecNode) => {
    const s = follow(s0, index.get(s0.k));
    specs.set(s.k, s);
    if (s.type !== "INSTANCE") for (const c of s.children ?? []) collect(c);
  };
  collect(spec);
  const pct = (m: { found: Found[]; checked: number }) =>
    m.checked ? Math.round((1000 * (m.checked - new Set(m.found.map((d) => d.k)).size)) / m.checked) / 10 : 100;
  let m = measure(spec, index, stats);
  const before = pct(m);
  const fitted = new Set<string>();
  for (let round = 0; round < ROUNDS && m.found.length; round++) {
    let changed = 0;
    for (const d of deepestOf(m.found)) {
      const n = index.get(d.k);
      const s = specs.get(d.k);
      const pins = n ? pinsOf(n) : [];
      if (!n || !s || (only && !only.has(d.k)) || pins.includes("*") || pins.includes("width") || pins.includes("height")) continue;
      try {
        if (await fit(n, s, d)) {
          fitted.add(d.k);
          changed++;
        }
      } catch (e) {
        stats.errors.push(`${d.k}: couldn't fit to the app: ${String(e)}`);
      }
    }
    if (!changed) break;
    const next = measure(spec, index, stats);
    const better = next.found.length < m.found.length;
    m = next;
    if (!better) break;
  }
  for (const k of fitted) {
    const n = index.get(k);
    if (n && n.getSharedPluginData(NS, "fitted") !== "1") n.setSharedPluginData(NS, "fitted", "1");
  }
  stats.score = { before, after: pct(m), checked: m.checked };
  if (fitted.size) stats.fitted = [...fitted];
  stats.differs = differences(m.found);
}

/** Fits one layer to the app: its place, or its size on the axes that are off (text: width, then lines). */
async function fit(n: SceneNode, s: SpecNode, d: Found): Promise<boolean> {
  if (d.at) {
    n.x = d.app[0];
    n.y = d.app[1];
    return true;
  }
  const [aw, ah] = d.app;
  const offW = Math.abs(n.width - aw) > 1;
  const offH = Math.abs(n.height - ah) > 1;
  const inLayout = "layoutSizingHorizontal" in n && !!n.parent && "layoutMode" in n.parent && n.parent.layoutMode !== "NONE";
  const fix = (axis: "Horizontal" | "Vertical") => {
    if (inLayout) (n as FrameNode)[`layoutSizing${axis}`] = "FIXED";
  };
  if (n.type === "TEXT") {
    const t = n;
    if (t.fontName !== figma.mixed) await figma.loadFontAsync(t.fontName);
    // One line in the app, a few pixels wider in Figma (its glyphs differ slightly): kept whole on its line,
    // a little wider, rather than narrowed to the app's width and cut with "…" (Live: "greenthumbgardens.co…").
    const lh0 = t.lineHeight !== figma.mixed && t.lineHeight.unit === "PIXELS" ? t.lineHeight.value : (t.fontSize as number) * 1.2;
    if (ah <= lh0 * 1.5 && !t.characters.includes("\n")) {
      const was = { resize: t.textAutoResize, trunc: t.textTruncation, lines: t.maxLines, w: t.width, h: t.height };
      t.textTruncation = "DISABLED";
      t.textAutoResize = "WIDTH_AND_HEIGHT";
      const natural = t.width;
      if (natural >= aw - 1 && natural - aw <= Math.max(8, aw * 0.05)) {
        if (inLayout) (t as TextNode).layoutSizingHorizontal = "HUG";
        return true;
      }
      t.textAutoResize = was.resize;
      t.textTruncation = was.trunc;
      if (was.lines !== null) t.maxLines = was.lines;
      if (was.resize !== "WIDTH_AND_HEIGHT") t.resize(was.w, was.h);
    }
    if (offW) {
      fix("Horizontal");
      t.textAutoResize = "HEIGHT";
      t.resize(Math.max(1, aw), t.height);
    }
    // Wraps onto more lines than in the browser (wider glyphs): as many lines as the app, cut with "…".
    if (Math.abs(t.height - ah) > 1 && t.height > ah) {
      const lh = t.lineHeight !== figma.mixed && t.lineHeight.unit === "PIXELS" ? t.lineHeight.value : (t.fontSize as number) * 1.2;
      t.textAutoResize = "HEIGHT";
      t.textTruncation = "ENDING";
      t.maxLines = Math.max(1, Math.round(ah / lh));
    }
    if (Math.abs(t.height - ah) > 1) {
      fix("Vertical");
      t.textAutoResize = "NONE";
      t.resize(t.width, Math.max(1, ah));
    }
    return offW || offH;
  }
  if (!("resize" in n)) return false;
  if (offW) fix("Horizontal");
  if (offH) fix("Vertical");
  (n as FrameNode).resize(Math.max(0.01, offW ? aw : n.width), Math.max(0.01, offH ? ah : n.height));
  return offW || offH;
}

/** Built from exactly this code already (and not touched since): nothing to rewrite. */
/**
 * Bumped when the plugin builds differently: everything is rebuilt once (2: positions; 3: fitted to the app;
 * 4: pictures that were placeholders, built before the service carried them; 5: layers stuck out of the flow; 6: leftovers inside childless layers; 7: rows stuck wrapping).
 */
const BUILD = "7";
/** The spec's hash with what else a build depends on: token links (everywhere), Library links (pages). */
const builtHash = (specHash: string | undefined, links?: LibraryLinks) => {
  if (!specHash) return specHash;
  const extra = [tokensSignature(), links ? linksSignature(links) : ""].filter(Boolean).join("|");
  return extra ? `${specHash}+${hash(extra)}` : specHash;
};
const builtFrom = (root: BaseNode | undefined, specHash: string | undefined) =>
  !!root && !!specHash && root.getSharedPluginData(NS, NODE.specHash) === `${BUILD}:${specHash}`;
/** Remembers what the root was built from — only after a clean build (a failed write must be retried). */
function markBuilt(root: BaseNode, specHash: string | undefined, stats: Stats) {
  // A layer placed elsewhere than the code says is retried next time, like a failed write.
  // (Built on a design: its layers sit where the designer put them, and a change without a place in them is
  // only reported.)
  const clean =
    !stats.errors.some(
      (e) => !e.startsWith("bind grid") && !e.includes("have no place in the design's layers") && !e.includes("aren't in the design"),
    ) &&
    (stats.anchored || !stats.differs?.some((d) => d.at)) &&
    placeholders === 0;
  const value = specHash && clean ? `${BUILD}:${specHash}` : "";
  if (root.getSharedPluginData(NS, NODE.specHash) !== value) root.setSharedPluginData(NS, NODE.specHash, value);
}

export async function reconcile(p0: { spec: SpecNode; gen?: string; adoptFrom?: string; specHash?: string; preview?: string }): Promise<{
  id: string;
  stats: Stats;
  skipped?: boolean;
}> {
  // A branch preview: in its section, from the code alone (no design adopted, no generation).
  if (p0.preview) {
    const { preview, adoptFrom: _a, gen: _g, ...rest } = p0;
    return inPreview(preview, () => reconcile(rest));
  }
  const stats = newStats();
  placeholders = 0;
  // Live › Components is the code as it draws it: never the Library's components.
  libraryLinks = new Map();
  const p = { ...p0, specHash: builtHash(p0.specHash) };
  {
    const existing = indexKeyed(await section()).get(p.spec.k);
    if (existing && builtFrom(existing, p.specHash)) {
      if (p.gen && existing.getSharedPluginData(NS, NODE.gen) !== p.gen) existing.setSharedPluginData(NS, NODE.gen, p.gen);
      setSrc(existing, p0.specHash);
      return { id: existing.id, stats, skipped: true };
    }
  }
  await loadVariables();
  await Promise.all(
    ["Regular", "Medium", "Semi Bold", "Bold"].map((style) => figma.loadFontAsync({ family: "Inter", style }).catch(() => undefined)),
  );
  const sec = await section();
  const spec = p.spec;
  // A preview's components are built beside Live's: the other components they place are Live's, unless the
  // branch changed those too (built earlier in the same preview).
  const own = (k: string) => k === spec.k || k.startsWith(`${spec.k}/`);
  const index = previewSec
    ? new Map([...[...indexKeyed(await sections.components())].filter(([k]) => !own(k)), ...indexKeyed(sec)])
    : indexKeyed(sec);
  let set = index.get(spec.k) as ComponentSetNode | undefined;

  const src = !set && p.adoptFrom ? ((await figma.getNodeByIdAsync(p.adoptFrom)) as SceneNode | null) : null;
  if (!set && src && src.type !== "COMPONENT_SET") {
    // The designer's design becomes the first variant; the others (if any) are built from code.
    let copy = adoptable(src, sec);
    if (copy.type === "INSTANCE") copy = copy.detachInstance();
    const comp = copy.type === "COMPONENT" ? copy : figma.createComponentFromNode(copy);
    adoptTree(comp, spec.children![0]!);
    set = figma.combineAsVariants([comp], sec);
    tag(set, spec.k);
    stats.created++;
    enter(set);
    for (const [k, n] of indexKeyed(sec)) index.set(k, n);
    await reconcileChildren(set, spec.children!, index, stats);
    if (src.type === "COMPONENT") await swapInstances(src, set.children[0] as ComponentNode);
  } else if (!set) {
    const comps: ComponentNode[] = [];
    for (const v of spec.children!) {
      const c = (await create(v, index, stats)) as ComponentNode;
      sec.appendChild(c);
      await reconcileNode(c, v, index, stats);
      comps.push(c);
    }
    set = figma.combineAsVariants(comps, sec);
    tag(set, spec.k);
    index.set(spec.k, set);
    stats.created++;
    enter(set);
  } else {
    await reconcileChildren(set, spec.children!, index, stats);
  }
  await applyProps(set, spec, stats);
  // Only write what differs: any write to a main component makes Figma refresh all its instances.
  const role = previewSec ? "preview" : "live";
  if (set.getSharedPluginData(NS, NODE.role) !== role) set.setSharedPluginData(NS, NODE.role, role);
  // Live is generated: locked against accidental edits (M6). Deliberate edits after unlocking are still
  // saved as a proposal by sync (W11). The plugin API ignores locks.
  if (!set.locked) set.locked = true;
  if (p.gen && set.getSharedPluginData(NS, NODE.gen) !== p.gen) set.setSharedPluginData(NS, NODE.gen, p.gen);
  await fitToApp(spec, index, stats);
  markBuilt(set, p.specHash, stats);
  setSrc(set, p0.specHash);
  stack(sec); // newest on top; a set that grew pushes the others down
  return { id: set.id, stats };
}

/** Reconcile a screen (FRAME root) in the Pages section; instances point at Live components. */
export async function reconcileScreen(p0: {
  spec: SpecNode;
  adoptFrom?: string;
  specHash?: string;
  closedClaims?: string[];
  preview?: string;
}): Promise<{ id: string; stats: Stats; skipped?: boolean }> {
  // A branch preview: in its section, generated from the app (not built on the designer's design).
  if (p0.preview) {
    const { preview, adoptFrom: _a, closedClaims: _c, ...rest } = p0;
    return inPreview(preview, () => reconcileScreen(rest));
  }
  const stats = newStats();
  placeholders = 0;
  // Pages use the designer's components where they're linked to the code's (Design System).
  libraryLinks = await loadLinks().catch(() => new Map());
  const p = { ...p0, specHash: builtHash(p0.specHash, libraryLinks) };
  const component = p.spec.k.replace(/^screen:/, "");
  const screens = await screensSection();
  const existing = indexKeyed(screens).get(p.spec.k);
  // Live shows what the app draws. The designer's design (the newest one the code implemented) is what it's
  // compared with — and its base only while the app follows it closely.
  const fresh = p.adoptFrom ? ((await figma.getNodeByIdAsync(p.adoptFrom)) as SceneNode | null) : null;
  const found = previewSec
    ? null
    : fresh
      ? { node: fresh, at: new Date().toISOString() }
      : await latestDesign(component, new Set(p.closedClaims ?? []));
  const design = found && (found.node.type === "FRAME" || found.node.type === "COMPONENT") ? found : null;
  const anchor = existing ? anchorOf(existing) : null;
  const onDesign = !!anchor && anchor.used !== false;
  const newDesign = !!design && (!anchor || anchor.id !== design.node.id || design.at > anchor.at || (anchor.v ?? 1) < ANCHOR_V);
  if (!newDesign && existing && builtFrom(existing, p.specHash)) {
    setSrc(existing, p0.specHash);
    return { id: existing.id, stats, skipped: true };
  }
  await loadVariables();
  await Promise.all(
    ["Regular", "Medium", "Semi Bold", "Bold"].map((style) => figma.loadFontAsync({ family: "Inter", style }).catch(() => undefined)),
  );
  const live = await section();
  const prune = (m: Map<string, SceneNode>) => {
    for (const [k, n] of m) if (n.removed) m.delete(k);
    return m;
  };
  // A preview's pages place Live's components, or the branch's where it changed them.
  const index = prune(
    new Map([...(previewSec ? indexKeyed(await sections.components()) : []), ...indexKeyed(live), ...indexKeyed(screens)]),
  );
  let root = index.get(p.spec.k);
  let created: Set<string> | null = null;
  // How closely the app follows the design (a scratch copy, paired with the app, every time the code changed).
  const tried = design ? await designCopy(design, p.spec, screens) : null;
  const follows = !!tried && tried.match >= FOLLOWS;
  if (tried) stats.designMatch = { now: Math.round(100 * tried.match), ...(anchor?.match !== undefined ? { was: anchor.match } : {}) };
  if (follows && (newDesign || !onDesign)) {
    // The app follows the design: Live is the design with the code's changes on top (drawn as the designer did).
    const copy = tried!.copy;
    if (root) {
      screens.insertChild(screens.children.indexOf(root), copy);
      root.remove();
    }
    root = copy;
    enter(root);
    stats.created++;
    stats.pairing = { paired: tried!.paired, layers: tried!.layers };
    for (const [k, n] of indexKeyed(screens)) index.set(k, n);
    prune(index);
    created = await patchDesign(root, null, p.spec, index, stats);
  } else {
    tried?.copy.remove();
    prune(index);
    if (follows && root && onDesign) {
      // Still built on the same design, and the app still follows it: only what the code changed.
      const prev = readChunked(root, NODE.lastSpec) as SpecNode | null;
      created = await patchDesign(root, prev, p.spec, index, stats);
    } else {
      // The app has moved away from the design (or there's none): Live is generated from the app. A page that
      // was built on the design is replaced (the design stays in Archive, compared with on every update).
      if (root && onDesign) {
        const at = screens.children.indexOf(root);
        root.remove();
        prune(index);
        root = await create(p.spec, index, stats);
        screens.insertChild(at, root);
        enter(root);
      } else if (!root) {
        root = await create(p.spec, index, stats);
        screens.appendChild(root);
        enter(root);
      }
      await reconcileNode(root, p.spec, index, stats);
    }
  }
  if (design)
    root.setSharedPluginData(
      NS,
      NODE.anchor,
      JSON.stringify({
        id: design.node.id,
        at: design.at,
        v: ANCHOR_V,
        used: !!created,
        ...(stats.designMatch ? { match: stats.designMatch.now } : {}),
      }),
    );
  // Layers removed while building (replaced, gone from the code) are no longer there to measure.
  prune(index);
  // A page is a viewport: what's taller than it (a scrolling page) doesn't spill over the pages below.
  if (!created && "clipsContent" in root && !root.clipsContent) root.clipsContent = true;
  if (created) {
    // Built on the design: what the code added is fitted to the app; the rest is the designer's, and where
    // it differs from the app, the app differs from the design.
    writeChunked(root, NODE.lastSpec, p.spec);
    stats.anchored = true;
    await fitToApp(p.spec, index, stats, created);
  } else await fitToApp(p.spec, index, stats);
  markBuilt(root, p.specHash, stats);
  setSrc(root, p0.specHash);
  if (previewSec && root.getSharedPluginData(NS, NODE.role) !== "preview") root.setSharedPluginData(NS, NODE.role, "preview");
  if (!root.locked) root.locked = true;
  stack(screens);
  return { id: root.id, stats };
}

/** PNG (base64) of a node, by id or by sync key (originals only). */
export async function exportNode(p: { k?: string; id?: string }) {
  await figma.loadAllPagesAsync();
  const n = (p.id ? await figma.getNodeByIdAsync(p.id) : figma.root.findOne((x) => keyOf(x) === p.k && isOriginal(x))) as SceneNode | null;
  if (!n) throw new Error(`no node ${p.id ?? p.k}`);
  return figma.base64Encode(await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 }, useAbsoluteBounds: true }));
}

/** Map key → node id for every original keyed node in the section (to prove ids are stable across runs). */
/**
 * The app as the browser draws it, level with its Live page in Live → Screenshots: a locked picture the
 * designer compares Live with (Live is the editable copy, built from the code; this is what the code really
 * draws). Replaced when the screenshot changes; stack() keeps it level with its page and drops it when the
 * page is gone.
 */
export async function placeShot(p: { k: string; ref: string; w: number; h: number }) {
  const screens = await screensSection();
  const page = indexKeyed(screens).get(p.k);
  if (!page) return { placed: false };
  const hash = imageHash(p.ref);
  if (!hash) throw new Error("its picture didn't reach this file");
  const shots = await sections.liveShots();
  let shot = shotOf(shots, p.k);
  if (shot && shot.getSharedPluginData(NS, SHOT.ref) === p.ref && shot.name === shotName(page)) {
    // Unchanged, but screenshots left among the pages by plugin 0.1 still go (stack removes them).
    if (screens.children.some(isShot)) stack(screens);
    return { placed: true };
  }
  if (!shot) {
    shot = figma.createFrame();
    shots.appendChild(shot);
    shot.setSharedPluginData(NS, NODE.role, SHOT.role);
    shot.setSharedPluginData(NS, SHOT.of, p.k);
  }
  shot.locked = false;
  shot.name = shotName(page);
  shot.resizeWithoutConstraints(Math.max(1, p.w), Math.max(1, p.h));
  shot.fills = [{ type: "IMAGE", imageHash: hash, scaleMode: "FILL" }];
  shot.clipsContent = true;
  shot.setSharedPluginData(NS, SHOT.ref, p.ref);
  shot.locked = true;
  stack(screens);
  return { placed: true };
}
const shotName = (page: SceneNode) => `${page.name} — as built (browser)`;

/**
 * The demo only: its simulated developer has no browser, so after his update the pages' screenshots are made
 * from Live itself (each Live page exported as a picture into its screenshot), to show the app as now built.
 * A real update's screenshot replaces it (its picture differs).
 */
export async function demoShotsFromLive() {
  const screens = await sections.screens();
  const shots = await sections.liveShots();
  let made = 0;
  for (const [k, page] of indexKeyed(screens)) {
    if (!k.startsWith("screen:") || k.includes("/") || !("exportAsync" in page)) continue;
    const shot = shotOf(shots, k);
    if (!shot) continue;
    const bytes = await (page as FrameNode).exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
    const image = figma.createImage(bytes);
    shot.locked = false;
    shot.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
    shot.setSharedPluginData(NS, SHOT.ref, `live:${image.hash}`);
    shot.locked = true;
    made++;
  }
  return { made };
}
/** The screenshot in a Screenshots section that belongs to `of` (a Live page's key, a claimed copy's id). */
export function shotOf(shots: SectionNode, of: string): FrameNode | null {
  return (shots.children.find((c) => isShot(c) && c.getSharedPluginData(NS, SHOT.of) === of) as FrameNode | undefined) ?? null;
}

/** The code no longer has this component or page: its Live copy moves to Archive, marked with the commit. */
export async function archiveLive(p: { k: string; commit: string }) {
  const sec = await (p.k.startsWith("screen:") ? screensSection() : section());
  const n = indexKeyed(sec).get(p.k);
  if (!n) return { archived: false };
  n.setSharedPluginData(NS, NODE.removedFromCode, p.commit);
  n.setSharedPluginData(NS, NODE.specHash, "");
  await toArchive(n);
  return { archived: true };
}

/**
 * What Live's Pages and Screenshots sections hold, read only (for diagnosing from the CLI): every frame with
 * its key, whether it's Live's own (not a copy), and for each screenshot the page it belongs to and whether
 * its picture is in the file.
 */
export async function liveReport() {
  const pages = await sectionIfAny(LAYOUT.live.page, LAYOUT.live.sections.screens);
  const shots = await sectionIfAny(LAYOUT.live.page, LAYOUT.live.sections.screenshots);
  if (!pages) return { pages: [], shots: [], note: "no Pages section in Live" };
  const pageRows = pages.children.map((n) => ({
    name: n.name,
    id: n.id,
    type: n.type,
    k: n.getSharedPluginData(NS, NODE.k),
    own: isOriginal(n),
    origId: n.getSharedPluginData(NS, NODE.origId),
    y: Math.round(n.y),
    h: Math.round(n.height),
  }));
  const shotRows = (shots?.children ?? []).map((n) => {
    const ref = n.getSharedPluginData(NS, SHOT.ref);
    return {
      name: n.name,
      id: n.id,
      shot: isShot(n),
      of: n.getSharedPluginData(NS, SHOT.of),
      ref,
      inFile: ref ? !!imageHash(ref) : null,
      y: Math.round(n.y),
    };
  });
  return { pages: pageRows, shots: shotRows };
}

export async function ids(p: { screens?: boolean } = {}) {
  const sec = await (p.screens ? screensSection() : section());
  return Object.fromEntries([...indexKeyed(sec)].map(([k, n]) => [k, n.id]).sort());
}

/** PNG per variant (base64), keyed by sync key, for per-variant visual diffs. */
export async function exportVariants(p: { setKeys?: string[] } = {}) {
  const sec = await section();
  const out: Record<string, string> = {};
  for (const set of sec.children) {
    if (set.type !== "COMPONENT_SET" || !keyOf(set) || (p.setKeys && !p.setKeys.includes(keyOf(set)))) continue;
    for (const v of set.children) {
      if (!keyOf(v)) continue;
      out[keyOf(v)] = figma.base64Encode(
        await v.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 }, useAbsoluteBounds: true }),
      );
    }
  }
  return out;
}
