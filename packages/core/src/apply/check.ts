// Checking Live against the browser beyond sizes: each property of a layer as Figma draws it (read back after
// building) against what the browser drew, colours compared as people see them (ΔE), positions inside a
// layer's parent. The plugin does the reading; this is the shared vocabulary and arithmetic, and how a
// difference reads in the update's log.

/** A property of a layer that Live, once built, doesn't draw as the browser did. */
export type PropDifference = {
  /** The layer's key. */
  k: string;
  /** What differs, in words ("colour", "font", "padding left", "text"). */
  prop: string;
  /** The value in Figma and in the app, as shown to people (#1f2937, "Inter Bold", 16). */
  figma: string;
  app: string;
  /** 3 = clearly visible (wrong text, a different font, a colour far off), 2 = noticeable, 1 = small. */
  severity: 1 | 2 | 3;
  /** A likely reason, where CoDesignFlo can tell. */
  why?: string;
  /** Other layers that differ the same way (the same layer in 12 cards): one cause, reported once. */
  alike?: number;
};

/** How much was checked: properties, on how many layers, and how many differ. */
export type PropCheck = { checked: number; layers: number; differ: number };

/** "#rrggbb" or "#rrggbbaa" → channels 0–1 (alpha 1 when absent); null when it isn't one. */
export function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } | null {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return null;
  const n = (s: string, i: number) => Number.parseInt(s.slice(i, i + 2), 16) / 255;
  return { r: n(m[1]!, 0), g: n(m[1]!, 2), b: n(m[1]!, 4), a: m[2] ? n(m[2], 0) : 1 };
}

/** sRGB (0–1) → CIE Lab (D65). */
function lab(c: { r: number; g: number; b: number }): [number, number, number] {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/**
 * How far apart two colours look (CIE76 ΔE): under about 2.3 people can't tell them apart. Translucent
 * colours are compared as they'd look over white, so a different alpha counts as much as it shows.
 */
export function deltaE(a: { r: number; g: number; b: number; a?: number }, b: { r: number; g: number; b: number; a?: number }): number {
  const over = (c: { r: number; g: number; b: number; a?: number }) => {
    const al = c.a ?? 1;
    return { r: c.r * al + (1 - al), g: c.g * al + (1 - al), b: c.b * al + (1 - al) };
  };
  const [l1, a1, b1] = lab(over(a));
  const [l2, a2, b2] = lab(over(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Below this ΔE two colours look the same. */
export const SAME_COLOUR = 2.3;

/** How visible a colour difference is: 3 far off, 2 noticeable, 1 small (0: the same to the eye). */
export const colourSeverity = (dE: number): 0 | 1 | 2 | 3 => (dE < SAME_COLOUR ? 0 : dE < 5 ? 1 : dE < 12 ? 2 : 3);

/**
 * What to report: the most visible differences first (then deeper layers, since fixing a child often fixes its
 * parent), one per layer and property, at most `max`.
 */
export function worstFirst(found: PropDifference[], max = 8): PropDifference[] {
  const seen = new Set<string>();
  // The same layer (by name) with the same property off by the same values, in several places: one cause.
  const groups = new Map<string, PropDifference>();
  for (const d of [...found].sort((a, b) => b.severity - a.severity || b.k.split("/").length - a.k.split("/").length)) {
    const id = `${d.k}|${d.prop}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const cause = `${d.k.split("/").pop()!.replace(/#\d+$/, "")}|${d.prop}|${d.figma}|${d.app}`;
    const g = groups.get(cause);
    if (g) g.alike = (g.alike ?? 0) + 1;
    else groups.set(cause, { ...d });
  }
  return [...groups.values()].slice(0, max);
}

/** "Card › Price: colour #1f2937 in Figma, #111827 in the app (ΔE 6.1)" — the layer's path below `root`. */
export function propDifferenceLine(root: string, d: PropDifference): string {
  const path =
    d.k
      .slice(root.length + 1)
      .split("/")
      .join(" › ") || "(the whole thing)";
  return `${path}: ${d.prop} ${d.figma} in Figma, ${d.app} in the app${d.why ? ` (${d.why})` : ""}${alikeNote(d.alike)}`;
}

/** " — and 11 more like it": the same difference elsewhere, reported once. */
export const alikeNote = (n?: number) => (n ? ` — and ${n} more like it` : "");

/** Where a layer sits in its parent, in Figma and in the app, beyond rounding (in-flow layers: auto layout). */
export const offBy = (figma: number, app: number, tolerance = 3) => Math.abs(figma - app) > tolerance;

/**
 * A page's look as a whole, for the designer's design and for the app: how many gradients, glows (shadows with
 * no offset, or spread out), blurs and large corners (16 px or more), the share of spacing (gaps and padding) off
 * the 4 px grid, and the widest row of equal columns. Differences here are about style, not one layer.
 */
export type StyleSignals = {
  gradients: number;
  glows: number;
  blurs: number;
  largeRadii: number;
  spacing: number;
  offGrid: number;
  columns: number;
};

/** An empty tally, to count into. */
export const noSignals = (): StyleSignals => ({ gradients: 0, glows: 0, blurs: 0, largeRadii: 0, spacing: 0, offGrid: 0, columns: 0 });

/** Counts one layer's look into `s` (the same rules for Figma's layers and the app's). */
export function countLook(
  s: StyleSignals,
  look: {
    fills?: string[];
    effects?: { type: string; radius?: number; spread?: number; offset?: { x: number; y: number } }[];
    radius?: number;
    spacing?: number[];
    columns?: number;
  },
) {
  s.gradients += (look.fills ?? []).filter((f) => f.startsWith("GRADIENT") || f.startsWith("gradient:")).length;
  for (const e of look.effects ?? []) {
    if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") s.blurs++;
    else if (/SHADOW/.test(e.type) && (e.radius ?? 0) >= 8 && ((e.spread ?? 0) > 0 || (!e.offset?.x && !e.offset?.y))) s.glows++;
  }
  if ((look.radius ?? 0) >= 16) s.largeRadii++;
  for (const v of look.spacing ?? [])
    if (v > 0) {
      s.spacing++;
      if (Math.round(v) % 4) s.offGrid++;
    }
  s.columns = Math.max(s.columns, look.columns ?? 0);
}

/**
 * Where the app's look as a whole differs from the design's, in words: counts that are clearly apart (two or
 * more, and half again as many), spacing off the grid 15 points apart, a different number of columns. Empty when
 * they're alike.
 */
export function signalDifferences(design: StyleSignals, app: StyleSignals): string[] {
  const out: string[] = [];
  const count = (what: string, d: number, a: number) => {
    if (Math.abs(d - a) >= 2 && Math.max(d, a) >= 1.5 * Math.max(1, Math.min(d, a)))
      out.push(`${what} ${d} in the design, ${a} in the app`);
  };
  count("gradients", design.gradients, app.gradients);
  count("glows", design.glows, app.glows);
  count("blurs", design.blurs, app.blurs);
  count("large corners", design.largeRadii, app.largeRadii);
  const off = (s: StyleSignals) => (s.spacing ? Math.round((100 * s.offGrid) / s.spacing) : 0);
  if (design.spacing >= 5 && app.spacing >= 5 && Math.abs(off(design) - off(app)) >= 15)
    out.push(`spacing off the 4 px grid ${off(design)}% in the design, ${off(app)}% in the app`);
  if (design.columns >= 2 && app.columns >= 2 && design.columns !== app.columns)
    out.push(`columns ${design.columns} in the design, ${app.columns} in the app`);
  return out;
}
