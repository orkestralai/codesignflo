// Canonical snapshot: the raw serializer output minus everything that is not design intent,
// in a byte-stable form. Ported from spike S2.

export type Raw = Record<string, unknown> & { children?: Raw[] };

/** Bump when the canonical form changes; snapshots of different versions are not comparable. */
export const CANON_VERSION = 5;

/** Figma suffixes component property names with a file-local id: "Show image#5:0". */
const PROP_SUFFIX = /#\d+:\d+$/;
const stripProp = (s: string) => s.replace(PROP_SUFFIX, "");
/** Fields of `styleIds` whose values are file-local style ids. */
const STYLE_FIELDS: Record<string, true> = { fill: true, stroke: true, effect: true, text: true, grid: true };
const PROP_KEYED = new Set(["componentPropertyDefinitions", "componentProperties", "componentPropertyReferences"]);

/** Fields that identify or place a node in this file, not what it looks like. */
const VOLATILE = new Set([
  "id",
  "parentId",
  // UI state; the panel locks proposals on "ready", which must not show up as a design change.
  "locked",
]);
/** Fields inside instance/main-component references that point at file-local ids. */
const VOLATILE_REF = new Set(["id", "componentSetId"]);

const GEOMETRY_DECIMALS = 2;
const UNIT_DECIMALS = 4; // colors, opacity, ratios

const round = (n: number, d: number) => {
  const r = Math.round(n * 10 ** d) / 10 ** d;
  return Object.is(r, -0) ? 0 : r;
};

/** Numbers in [0,1] contexts (color channels, opacity) get more precision than pixel geometry. */
const UNIT_KEYS = new Set(["r", "g", "b", "a", "opacity", "position", "innerRadius"]);

/** Per-call context: variable id → "collection/name"; style id → style name. */
let variableNames: Record<string, string> = {};
let styleNames: Record<string, string> = {};

function canonValue(key: string, v: unknown, inProps = false): unknown {
  if (typeof v === "number") return round(v, UNIT_KEYS.has(key) ? UNIT_DECIMALS : GEOMETRY_DECIMALS);
  if (typeof v === "string") {
    if (v.startsWith("VariableID:")) return `var(${variableNames[v] ?? "unresolved"})`;
    if (key in STYLE_FIELDS && styleNames[v]) return `style(${styleNames[v]})`;
    return inProps ? stripProp(v) : v;
  }
  if (Array.isArray(v)) return v.map((x) => canonValue(key, x, inProps));
  if (v && typeof v === "object") return canonObject(v as Record<string, unknown>, new Set(), inProps || PROP_KEYED.has(key));
  return v;
}

function canonObject(o: Record<string, unknown>, drop: Set<string> = new Set(), inProps = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(o).map((k) => [inProps ? stripProp(k) : k, k] as const);
  for (const [key, original] of keys.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (drop.has(original)) continue;
    const v = o[original];
    if (v === undefined) continue;
    out[key] = canonValue(original, v, inProps || PROP_KEYED.has(original));
  }
  return out;
}

type Options = {
  /** Drop the root's name too (to compare a copy whose root was renamed against its source). */
  ignoreRootName?: boolean;
  /** Variable id → "collection/name", from the plugin. Bound variables are emitted as var(name). */
  variables?: Record<string, string>;
  /** Style id → style name, from the plugin. Linked styles are emitted as style(name). */
  styles?: Record<string, string>;
};

/**
 * - drops ids, parent ids, lock state, origId; keeps the sync key `k`
 * - replaces file-local ids with names: bound variables → var(collection/name),
 *   component property keys "Name#12:3" → "Name"
 * - drops x/y on the root (canvas placement) and on children of auto-layout parents
 *   unless absolutely positioned (their position is derived from layout)
 * - zero letter spacing is 0px whatever its unit
 * - rounds numbers, sorts object keys; children keep their order (order is meaningful)
 */
export function canonicalize(raw: Raw, opts: Options = {}): Raw {
  variableNames = opts.variables ?? {};
  styleNames = opts.styles ?? {};
  const walk = (node: Raw, isRoot: boolean, parentAutoLayout: boolean): Raw => {
    const drop = new Set(VOLATILE);
    if (isRoot || (parentAutoLayout && node.layoutPositioning !== "ABSOLUTE")) {
      drop.add("x");
      drop.add("y");
    }
    if (isRoot && opts.ignoreRootName) drop.add("name");
    drop.add("children");
    drop.add("ds");
    drop.add("mainComponent");
    drop.add("overrides");
    const out = canonObject(node, drop) as Raw;
    // No letter spacing is the same in any unit (Figma's default is 0%, text built from CSS has 0px).
    const ls = out.letterSpacing as { value?: number } | undefined;
    if (ls && ls.value === 0) out.letterSpacing = { unit: "PIXELS", value: 0 };
    const ds = node.ds as { k?: string; src?: string; pin?: string } | undefined;
    if (ds?.k) out.k = ds.k;
    // What the designer kept as design on this layer (diff leaves those properties alone).
    if (ds?.pin) out.pin = JSON.parse(ds.pin) as string[];
    // Text whose content comes from the component's data (differs between its stories), tagged at generation.
    if (ds?.src === "data") out.dataText = true;
    const main = node.mainComponent as Record<string, unknown> | undefined;
    if (main) out.mainComponent = canonObject(main, VOLATILE_REF);
    // Override entries point at sublayer ids; keep only which fields are overridden, in a stable order.
    const overrides = node.overrides as { fields: string[] }[] | undefined;
    if (overrides?.length) out.overriddenFields = [...new Set(overrides.flatMap((o) => o.fields))].sort();
    const isAutoLayout = typeof (node.layout as { mode?: string } | undefined)?.mode === "string";
    if (node.children) out.children = node.children.map((c) => walk(c, false, isAutoLayout));
    return out;
  };
  return walk(raw, true, false);
}

/** Stable serialization: keys already sorted by canonicalize; fixed indentation, trailing newline. */
export const stringify = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Paths where two canonical trees differ (for reporting; S3 builds the real diff). */
export function diffPaths(a: unknown, b: unknown, path = "$", out: string[] = []): string[] {
  if (a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: shape differs`);
    return out;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
  return out;
}
