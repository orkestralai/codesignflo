// What Live will look like once an update is applied, without Figma: the current Live version with the
// compiled code's properties laid over it, node by node (by sync key). Figma computes sizes from layout, and
// the diff already ignores hugging/filling sizes, so for property changes the prediction is what the plugin
// will read back. New or removed layers can't be predicted (Figma builds them): `exact` is false then.
import type { SpecNode } from "../compile/compile.js";
import { TOKENS_COLLECTION } from "../group/group.js";
import type { Raw } from "../snapshot/canonical.js";

const LAYOUT = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "itemSpacing",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "strokesIncludedInLayout",
] as const;
const PLAIN = [
  "layoutPositioning",
  "x",
  "y",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "width",
  "height",
  "cornerRadius",
  "opacity",
  "clipsContent",
  "characters",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "textAutoResize",
  "textAlignHorizontal",
  "textCase",
  "textTruncation",
  "maxLines",
  "strokeAlign",
] as const;
const WEIGHT: Record<string, number> = { Regular: 400, Medium: 500, "Semi Bold": 600, Bold: 700 };
const RADII = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"];

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const variable = (name: string) => `var(${TOKENS_COLLECTION}/${name})`;

/** "#rrggbb" / "#rrggbbaa" → a canonical solid paint (bound to a token when given). */
function solid(hex: string, token?: string): Raw {
  const h = hex.replace("#", "");
  const c = (i: number) => round4(Number.parseInt(h.slice(i, i + 2), 16) / 255);
  return {
    ...(token ? { boundVariables: { color: variable(token) } } : {}),
    color: { b: c(4), g: c(2), r: c(0) },
    opacity: h.length === 8 ? c(6) : 1,
    type: "SOLID",
    visible: true,
  };
}

/** Paints from the spec ("#hex" or "image:<ref>"); a picture keeps the paint Live has (Figma's image hash). */
function paints(want: string[], current: Raw[] | undefined, token?: string): Raw[] {
  return want.map((w, i) =>
    w.startsWith("image:")
      ? (current?.[i] ?? { type: "IMAGE" })
      : w.startsWith("gradient:")
        ? (current?.[i] ?? { type: "GRADIENT_LINEAR" })
        : solid(w, token),
  );
}

function overlay(node: Raw, spec: SpecNode): Raw {
  const out: Raw = { ...node };
  const p = spec.props;
  const bound = { ...((node.boundVariables ?? {}) as Record<string, unknown>) };
  for (const f of PLAIN) if (f in p) out[f] = p[f];
  if ("layoutMode" in p || LAYOUT.some((f) => f in p)) {
    const layout = { ...((node.layout ?? {}) as Record<string, unknown>) };
    if ("layoutMode" in p) layout.mode = p.layoutMode;
    for (const f of LAYOUT) if (f in p) layout[f] = p[f];
    // Figma's read-back leaves the flag out when it's off.
    if (layout.strokesIncludedInLayout === false && !(node.layout as Record<string, unknown> | undefined)?.strokesIncludedInLayout)
      delete layout.strokesIncludedInLayout;
    out.layout = layout;
  }
  // Figma: a frame that fills or has a fixed size along an axis has that axis's sizing mode FIXED (hug: AUTO).
  const mode = (out.layout as Record<string, unknown> | undefined)?.mode;
  if ((mode === "HORIZONTAL" || mode === "VERTICAL") && out.layoutSizingHorizontal && out.layoutSizingVertical) {
    const [primary, counter] = mode === "HORIZONTAL" ? ["Horizontal", "Vertical"] : ["Vertical", "Horizontal"];
    out.primaryAxisSizingMode = out[`layoutSizing${primary}`] === "HUG" ? "AUTO" : "FIXED";
    out.counterAxisSizingMode = out[`layoutSizing${counter}`] === "HUG" ? "AUTO" : "FIXED";
  }
  if ("fontName" in p) {
    const want = p.fontName as { family: string; style: string };
    const cur = (node.fontName ?? {}) as { family?: string; style?: string; variationSettings?: Record<string, number> };
    const same = cur.family === want.family && cur.style === want.style;
    out.fontName = {
      family: want.family,
      style: want.style,
      ...(cur.variationSettings
        ? { variationSettings: same ? cur.variationSettings : { ...cur.variationSettings, wght: WEIGHT[want.style] ?? 400 } }
        : {}),
    };
  }
  if ("fills" in p) out.fills = paints(p.fills as string[], node.fills as Raw[] | undefined, spec.paintBind?.fills);
  // No strokes: the read-back has no strokes field at all.
  if ("strokes" in p && !(node.strokes === undefined && (p.strokes as string[]).length === 0))
    out.strokes = paints(p.strokes as string[], node.strokes as Raw[] | undefined, spec.paintBind?.strokes);
  if ("strokeTopWeight" in p) {
    const w = { bottom: p.strokeBottomWeight, left: p.strokeLeftWeight, right: p.strokeRightWeight, top: p.strokeTopWeight };
    const all = new Set(Object.values(w));
    if (all.size === 1) {
      out.strokeWeight = w.top;
      delete out.strokeWeights;
    } else {
      out.strokeWeight = "mixed";
      out.strokeWeights = w;
    }
  } else if ("strokeWeight" in p) {
    out.strokeWeight = p.strokeWeight;
    delete out.strokeWeights;
  }
  // Token bindings: the spec decides every field it sets (a raw value in code unbinds the field).
  const fields = new Set<string>([...Object.keys(p), ...("cornerRadius" in p ? RADII : [])]);
  if ("layoutMode" in p || "itemSpacing" in p) fields.add("itemSpacing");
  for (const f of fields) if (f !== "fills" && f !== "strokes") delete bound[f];
  for (const [f, name] of Object.entries(spec.bind ?? {})) bound[f] = [variable(name)];
  for (const f of ["fills", "strokes"] as const) {
    if (!(f in p)) continue;
    delete bound[f];
    if (spec.paintBind?.[f]) bound[f] = [variable(spec.paintBind[f])];
  }
  if (Object.keys(bound).length) out.boundVariables = bound;
  else delete out.boundVariables;
  return out;
}

/**
 * Live as it will be after applying `spec`, from the Live version it is applied to. `exact` is false when
 * layers are added or removed (and for nested instances, whose content comes from their own component).
 */
export function predictLive(live: Raw, spec: SpecNode): { tree: Raw; exact: boolean } {
  const specs = new Map<string, SpecNode>();
  const collect = (s: SpecNode) => {
    specs.set(s.k, s);
    for (const c of s.children ?? []) collect(c);
  };
  collect(spec);
  const seen = new Set<string>();
  let exact = true;
  const walk = (n: Raw, top: boolean): Raw => {
    const k = typeof n.k === "string" ? n.k : null;
    const s = k ? specs.get(k) : undefined;
    if (k && s) seen.add(k);
    // A layer the code no longer has: Figma removes it.
    if (k && !s && !top && k.startsWith(`${spec.k}/`)) exact = false;
    const own = s && !(s.type === "INSTANCE") ? overlay(n, s) : n;
    if (s?.type === "INSTANCE") return own;
    return n.children ? { ...own, children: n.children.map((c) => walk(c, false)) } : own;
  };
  const tree = walk(live, true);
  // A layer new in code: Figma creates it.
  for (const k of specs.keys()) if (!seen.has(k)) exact = false;
  return { tree, exact };
}
