// Semantic diff between two canonical snapshots (baseline vs proposal). Ported from spike S3.
// Matching follows S1: nodes are identified by sync key within a scope (variant / instance),
// variants by their variant properties, unkeyed nodes are additions.
import type { Raw } from "../snapshot/canonical.js";
import { hash } from "../util/hash.js";
import { sameValue } from "../util/stable.js";

export type Kind =
  | "layout"
  | "token"
  | "style"
  | "typography"
  | "content"
  | "name"
  | "structure"
  | "variant"
  | "prop"
  | "instance"
  /** Text that comes from the component's data (story args / props), not from its code. */
  | "data"
  | "other";

export type Item = {
  id: string;
  kind: Kind;
  op?: "add" | "remove" | "move" | "reorder" | "wrap" | "change";
  target: string; // node identity in the proposal (or baseline for removals)
  path: string; // human-readable layer path
  prop?: string;
  from?: unknown;
  to?: unknown;
  /** Variable bindings for the property, by field (e.g. paddingTop → ["var(Tokens/space/3)"]). Kept apart from the value. */
  fromBound?: Record<string, unknown>;
  toBound?: Record<string, unknown>;
  match: "key" | "variant" | "unkeyed";
  details?: Item[]; // for a new variant: how it differs from the variant it was derived from
};

type Entry = { id: string; node: Raw; parent: string | null; path: string; index: number; at: number[] };

const variantId = (n: Raw) => {
  const vp = (n.variantProperties ?? {}) as Record<string, string>;
  return `V[${Object.keys(vp)
    .sort()
    .map((k) => `${k}=${vp[k]}`)
    .join(",")}]`;
};

/** Identity per node. Keys are scoped by variant and by instance (instance sublayers carry their main component's keys). */
function index(root: Raw): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const add = (e: Entry) => {
    let id = e.id;
    for (let n = 2; out.has(id); n++) id = `${e.id}#dup${n}`;
    out.set(id, { ...e, id });
    return id;
  };
  const walk = (node: Raw, parent: string | null, scope: string, path: string, index: number, isSetChild: boolean, at: number[] = []) => {
    let id: string;
    if (parent === null) id = "ROOT";
    else if (isSetChild && node.type === "COMPONENT") id = variantId(node);
    else if (typeof node.k === "string") id = `${scope}|${node.k}`;
    else id = `${scope}|~${parent}/${String(node.name)}`;
    const p = parent === null ? String(node.name) : `${path} / ${String(node.name)}`;
    id = add({ id, node, parent, path: p, index, at });
    const childScope = node.type === "INSTANCE" || (isSetChild && node.type === "COMPONENT") ? id : scope;
    for (const [i, c] of (node.children ?? []).entries())
      walk(c, id, childScope, p, i, parent === null && node.type === "COMPONENT_SET", [...at, i]);
  };
  walk(root, null, "ROOT", "", 0, false);
  return out;
}

/** Identity → sync key of that layer (to find which layer a delta item is about). */
export function keysById(root: Raw): Map<string, string> {
  return new Map([...index(root)].filter(([, e]) => typeof e.node.k === "string").map(([id, e]) => [id, e.node.k as string]));
}

/** Identity → child-index path, to find the Figma node for a delta item in a raw snapshot (same tree shape). */
export function locate(root: Raw): Map<string, number[]> {
  return new Map([...index(root)].map(([id, e]) => [id, e.at]));
}

// ---- property normalization ------------------------------------------------------------------

const PADDING = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
const RADII = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"];

/** One spelling per font style: families name them differently ("Semi Bold" in Inter, "SemiBold" elsewhere). */
const STYLES = ["Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black"];
export function fontStyle(style: string): string {
  const italic = /italic/i.test(style);
  const base = style
    .replace(/italic/i, "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  const canon = STYLES.find((s) => s.toLowerCase().replace(/\s/g, "") === base) ?? (base ? style.replace(/italic/i, "").trim() : "Regular");
  return italic ? `${canon === "Regular" ? "" : `${canon} `}Italic` : canon;
}

/** Removes values Figma derives from other properties, so they never show up as edits. */
function normalize(n: Raw, isRoot: boolean): Record<string, unknown> {
  const o: Record<string, unknown> = { ...n };
  delete o.children;
  delete o.k;
  delete o.dataText; // a tag, not a design property
  delete o.pin; // which properties the designer kept as design (see `pinned`)
  // Font styles compare by meaning, not spelling ("SemiBold" = "Semi Bold"); variation settings follow the style.
  if (o.fontName && typeof o.fontName === "object") {
    const f = o.fontName as { family?: string; style?: string };
    o.fontName = { family: f.family, style: fontStyle(f.style ?? "Regular") };
  }
  delete o.locked; // UI state (proposals are locked on "ready"); canonicalize drops it too
  // Figma-only drawing aids with no meaning in code (M6: a layout grid toggled with Ctrl+G was listed as a
  // change): never a design change to deliver.
  delete o.layoutGrids;
  delete o.guides;

  // A single text segment repeats the node-level text properties.
  if (Array.isArray(o.segments) && o.segments.length <= 1) delete o.segments;
  const hug = (v: unknown) => v === "HUG" || v === "FILL";
  const auto = o.textAutoResize as string | undefined;
  // An auto-layout frame hugs its content on an axis whose sizing mode is AUTO.
  const mode = (o.layout as { mode?: string } | undefined)?.mode;
  const primaryAuto = o.primaryAxisSizingMode === "AUTO";
  const counterAuto = o.counterAxisSizingMode === "AUTO";
  const hugW = (mode === "HORIZONTAL" && primaryAuto) || (mode === "VERTICAL" && counterAuto);
  const hugH = (mode === "VERTICAL" && primaryAuto) || (mode === "HORIZONTAL" && counterAuto);
  if (hug(o.layoutSizingHorizontal) || hugW || auto === "WIDTH_AND_HEIGHT" || (isRoot && o.type === "COMPONENT_SET")) delete o.width;
  if (hug(o.layoutSizingVertical) || hugH || auto === "WIDTH_AND_HEIGHT" || auto === "HEIGHT" || (isRoot && o.type === "COMPONENT_SET"))
    delete o.height;
  // VARIANT entries in property definitions are derived from the variants themselves (options, default).
  if (o.componentPropertyDefinitions) {
    const defs = o.componentPropertyDefinitions as Record<string, { type?: string }>;
    o.componentPropertyDefinitions = Object.fromEntries(Object.entries(defs).filter(([, d]) => d.type !== "VARIANT"));
  }
  // Instances: which fields are overridden is a consequence of the override values themselves;
  // width/height and our own pluginData tagging are never design edits.
  // Which fields an instance overrides is bookkeeping: the override values themselves are diffed (first designer test).
  delete o.overriddenFields;
  // Flatten auto-layout so each field is its own property; group padding.
  const layout = o.layout as Record<string, unknown> | undefined;
  if (layout) {
    delete o.layout;
    for (const [k, v] of Object.entries(layout)) if (!PADDING.includes(k)) o[`layout.${k}`] = v;
    if (PADDING.some((k) => k in layout)) o.padding = PADDING.map((k) => layout[k] ?? 0);
  }
  if (o.cornerRadii) {
    o.cornerRadius = o.cornerRadii;
    delete o.cornerRadii;
  }
  return o;
}

/** Which property group a bound-variable field belongs to. */
const bindingGroup = (field: string) =>
  PADDING.includes(field) ? "padding" : RADII.includes(field) ? "cornerRadius" : field === "itemSpacing" ? "layout.itemSpacing" : field;

const KIND: Record<string, Kind> = {
  size: "layout",
  padding: "layout",
  width: "layout",
  height: "layout",
  x: "layout",
  y: "layout",
  layoutSizingHorizontal: "layout",
  layoutSizingVertical: "layout",
  layoutGrow: "layout",
  layoutAlign: "layout",
  layoutPositioning: "layout",
  minWidth: "layout",
  maxWidth: "layout",
  minHeight: "layout",
  maxHeight: "layout",
  constraints: "layout",
  primaryAxisSizingMode: "layout",
  counterAxisSizingMode: "layout",
  fills: "style",
  strokes: "style",
  strokeWeight: "style",
  strokeAlign: "style",
  effects: "style",
  cornerRadius: "style",
  opacity: "style",
  visible: "style",
  blendMode: "style",
  clipsContent: "style",
  rotation: "style",
  fontName: "typography",
  fontSize: "typography",
  lineHeight: "typography",
  letterSpacing: "typography",
  textCase: "typography",
  textDecoration: "typography",
  textAlignHorizontal: "typography",
  textAlignVertical: "typography",
  textAutoResize: "typography",
  segments: "typography",
  characters: "content",
  name: "name",
  componentPropertyDefinitions: "prop",
  componentPropertyReferences: "prop",
  componentProperties: "instance",
  mainComponent: "instance",
  overriddenFields: "instance",
};
const kindOf = (prop: string): Kind => (prop.startsWith("layout.") ? "layout" : (KIND[prop] ?? "other"));

const eq = sameValue;
const itemId = (...parts: unknown[]) => hash(JSON.stringify(parts)).slice(0, 10);

type Group = { from: unknown; to: unknown; token: boolean; fromBound?: Record<string, unknown>; toBound?: Record<string, unknown> };

function propItems(a: Entry, b: Entry, isRoot: boolean, opts: { ignore?: string[] } = {}): Item[] {
  const na = normalize(a.node, isRoot);
  const nb = normalize(b.node, isRoot);
  const ignore = new Set(["boundVariables", ...(opts.ignore ?? [])]);
  const groups = new Map<string, Group>();
  for (const key of new Set([...Object.keys(na), ...Object.keys(nb)])) {
    if (ignore.has(key) || eq(na[key], nb[key])) continue;
    groups.set(key, { from: na[key], to: nb[key], token: hasBinding(na[key]) || hasBinding(nb[key]) });
  }
  // Node-level bindings (padding, radius, spacing…): a binding change is a token change of its group.
  const ba = (na.boundVariables ?? {}) as Record<string, unknown>;
  const bb = (nb.boundVariables ?? {}) as Record<string, unknown>;
  const bindingChanges = new Map<string, { from: Record<string, unknown>; to: Record<string, unknown> }>();
  for (const field of new Set([...Object.keys(ba), ...Object.keys(bb)])) {
    if (eq(ba[field], bb[field])) continue;
    const g = bindingGroup(field);
    const c = bindingChanges.get(g) ?? { from: {}, to: {} };
    c.from[field] = ba[field] ?? null;
    c.to[field] = bb[field] ?? null;
    bindingChanges.set(g, c);
  }
  for (const [g, c] of bindingChanges) {
    const cur = groups.get(g) ?? { from: na[g], to: nb[g], token: true };
    groups.set(g, { ...cur, token: true, fromBound: c.from, toBound: c.to });
  }
  explainSizeByPadding(groups);
  groupSize(groups);
  // Either side may carry the tag (a copy made before the tag existed only has it on the Live side).
  const dataText = !!a.node.dataText || !!b.node.dataText;
  return [...groups].map(([prop, g]) => ({
    id: itemId(b.id, prop),
    kind: g.token ? "token" : dataText && prop === "characters" ? "data" : kindOf(prop),
    op: "change",
    target: b.id,
    path: b.path,
    prop,
    from: g.from,
    to: g.to,
    ...(g.fromBound ? { fromBound: g.fromBound, toBound: g.toBound } : {}),
    match: b.id.includes("|~") ? "unkeyed" : b.id.startsWith("V[") && !b.id.includes("|") ? "variant" : "key",
  }));
}

/** Properties that together say how big a layer is; one resize in Figma changes several of them. */
const SIZE_PROPS = [
  "width",
  "height",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "layoutAlign",
  "layoutGrow",
];

/** One action = one change: fold all size-related properties of a layer into a single "size" item. */
function groupSize(groups: Map<string, Group>) {
  const changed = SIZE_PROPS.filter((p) => groups.has(p));
  if (changed.length < 2) return;
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  let token = false;
  for (const p of changed) {
    const g = groups.get(p)!;
    if (g.from !== undefined) from[p] = g.from;
    if (g.to !== undefined) to[p] = g.to;
    token ||= g.token;
    groups.delete(p);
  }
  groups.set("size", { from, to, token });
}

/**
 * Figma keeps the content box when padding changes, so even a fixed-size frame grows or shrinks by
 * exactly the padding delta (seen in S3, both via the Plugin API and in the UI). Such a size change
 * is a consequence of the padding edit, not a separate edit: fold it away.
 */
function explainSizeByPadding(groups: Map<string, Group>) {
  const pad = groups.get("padding");
  if (!pad) return;
  const values = (v: unknown): number[] | null =>
    Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number") ? (v as number[]) : null;
  const from = values(pad.from);
  const to = values(pad.to);
  if (!from || !to) return;
  const [t0, r0, b0, l0] = from as [number, number, number, number];
  const [t1, r1, b1, l1] = to as [number, number, number, number];
  const check = (prop: string, delta: number) => {
    const g = groups.get(prop);
    if (g && typeof g.from === "number" && typeof g.to === "number" && Math.abs(g.to - g.from - delta) < 0.01) groups.delete(prop);
  };
  check("height", t1 + b1 - (t0 + b0));
  check("width", l1 + r1 - (l0 + r0));
}

/** Does a value (e.g. a paint list) contain a variable binding? */
const hasBinding = (v: unknown): boolean => JSON.stringify(v ?? null).includes('"var(');

/** Longest common subsequence of two id lists (for minimal reorder reporting). */
function lcs(a: string[], b: string[]): Set<string> {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const keep = new Set<string>();
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      keep.add(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return keep;
}

export function diff(base: Raw, proposal: Raw, opts: { ignoreRootName?: boolean; pins?: boolean } = {}): Item[] {
  const A = index(base);
  const B = index(proposal);
  const items: Item[] = [];
  const covered = new Set<string>(); // B ids explained by a higher-level item
  const coveredA = new Set<string>();
  const descendants = (M: Map<string, Entry>, id: string) => [...M.values()].filter((e) => isDescendant(M, e.id, id));

  // Variants added / removed. A new variant is reported once, with its differences from the variant it was copied from.
  for (const e of B.values()) {
    if (!e.id.startsWith("V[") || e.id.includes("|") || A.has(e.id)) continue;
    const source = [...A.values()].find((a) => a.id.startsWith("V[") && !a.id.includes("|") && a.node.k === e.node.k);
    const details = source
      ? diff(asRoot(source.node), asRoot(e.node), { ignoreRootName: true }).filter((d) => d.prop !== "variantProperties")
      : undefined;
    items.push({
      id: itemId("variant+", e.id),
      kind: "variant",
      op: "add",
      target: e.id,
      path: e.path,
      to: e.node.variantProperties,
      from: source ? source.node.variantProperties : undefined,
      match: "variant",
      details,
    });
    covered.add(e.id);
    for (const d of descendants(B, e.id)) covered.add(d.id);
  }
  for (const e of A.values()) {
    if (!e.id.startsWith("V[") || e.id.includes("|") || B.has(e.id)) continue;
    items.push({
      id: itemId("variant-", e.id),
      kind: "variant",
      op: "remove",
      target: e.id,
      path: e.path,
      from: e.node.variantProperties,
      match: "variant",
    });
    coveredA.add(e.id);
    for (const d of descendants(A, e.id)) coveredA.add(d.id);
  }

  // Additions: top-most only. An unkeyed node that adopted existing nodes is a wrap.
  const wraps = new Set<string>();
  for (const e of B.values()) {
    if (A.has(e.id) || covered.has(e.id)) continue;
    // Parent is itself new (an added node or a wrap) → explained by the parent's item.
    if (e.parent && !A.has(e.parent)) continue;
    const adopted = (e.node.children ?? []).length > 0 && [...B.values()].filter((c) => c.parent === e.id && A.has(c.id));
    if (adopted && adopted.length > 0) {
      wraps.add(e.id);
      items.push({
        id: itemId("wrap", e.id),
        kind: "structure",
        op: "wrap",
        target: e.id,
        path: e.path,
        to: adopted.map((c) => c.path),
        match: "unkeyed",
      });
    } else {
      items.push({
        id: itemId("add", e.id),
        kind: "structure",
        op: "add",
        target: e.id,
        path: e.path,
        to: summarize(e.node),
        match: "unkeyed",
      });
    }
  }
  // Removals: top-most only.
  for (const e of A.values()) {
    if (B.has(e.id) || coveredA.has(e.id)) continue;
    if (e.parent && !B.has(e.parent)) continue;
    items.push({
      id: itemId("remove", e.id),
      kind: "structure",
      op: "remove",
      target: e.id,
      path: e.path,
      from: summarize(e.node),
      match: "key",
    });
  }

  // Matched nodes: property changes and moves.
  for (const b of B.values()) {
    const a = A.get(b.id);
    if (!a) continue;
    const isRoot = b.id === "ROOT";
    items.push(...propItems(a, b, isRoot, { ignore: isRoot && opts.ignoreRootName ? ["name"] : [] }));
    if (!isRoot && a.parent !== b.parent && !(b.parent && wraps.has(b.parent))) {
      items.push({
        id: itemId("move", b.id),
        kind: "structure",
        op: "move",
        target: b.id,
        path: b.path,
        from: A.get(a.parent!)?.path,
        to: B.get(b.parent!)?.path,
        match: "key",
      });
    }
  }
  // Reorders among siblings that stayed under the same parent.
  for (const parent of new Set([...B.values()].map((e) => e.parent).filter((p): p is string => !!p && A.has(p)))) {
    const kids = (M: Map<string, Entry>) =>
      [...M.values()]
        .filter((e) => e.parent === parent)
        .sort((x, y) => x.index - y.index)
        .map((e) => e.id)
        .filter((id) => A.get(id)?.parent === parent && B.get(id)?.parent === parent);
    const ka = kids(A);
    const kb = kids(B);
    const keep = lcs(ka, kb);
    for (const id of kb.filter((x) => !keep.has(x)))
      items.push({
        id: itemId("reorder", id),
        kind: "structure",
        op: "reorder",
        target: id,
        path: B.get(id)!.path,
        from: ka.indexOf(id),
        to: kb.indexOf(id),
        match: "key",
      });
  }
  // What the designer kept as design in Live (pins) isn't a difference: the code doesn't do it, by agreement.
  return opts.pins === false ? items : items.filter((i) => !pinned(A, i) && !pinned(B, i));
}

/** Pins on a layer ("pin": the properties kept as design, or ["*"] for the whole layer and its content). */
const pinsOf = (n: Raw) => (Array.isArray(n.pin) ? (n.pin as string[]) : []);
function pinned(M: Map<string, Entry>, i: Item): boolean {
  for (let e = M.get(i.target); e; e = e.parent ? M.get(e.parent) : undefined) {
    const p = pinsOf(e.node);
    if (p.includes("*")) return true;
    if (e.id === i.target && i.prop && p.includes(i.prop)) return true;
  }
  return false;
}

function isDescendant(M: Map<string, Entry>, id: string, ancestor: string): boolean {
  for (let p = M.get(id)?.parent; p; p = M.get(p)?.parent) if (p === ancestor) return true;
  return false;
}

/** Treat a variant subtree as a standalone root (for comparing a new variant with its source). */
function asRoot(n: Raw): Raw {
  return { ...n, type: "FRAME_ROOT" } as Raw;
}

const summarize = (n: Raw) => ({ type: n.type, name: n.name, ...(n.characters ? { characters: n.characters } : {}) });
