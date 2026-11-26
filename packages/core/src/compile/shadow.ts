// CSS box-shadow (computed form) → Figma effects.

export type ShadowEffect = {
  type: "DROP_SHADOW" | "INNER_SHADOW";
  color: { r: number; g: number; b: number; a: number };
  offset: { x: number; y: number };
  radius: number;
  spread: number;
  visible: true;
  blendMode: "NORMAL";
};

/** Splits on commas outside parentheses. */
const layers = (css: string) => css.split(/,(?![^(]*\))/).map((s) => s.trim());

/**
 * Parses a computed box-shadow ("rgba(0, 0, 0, 0.1) 0px 1px 2px 0px, rgb(…) 0px 0px 0px 1px inset").
 * Browsers list CSS layers top-first; Figma's effects list is bottom-first, so the order is reversed.
 */
export function parseBoxShadow(css: string | undefined): ShadowEffect[] {
  if (!css || css === "none") return [];
  const out: ShadowEffect[] = [];
  for (const layer of layers(css)) {
    const color = /rgba?\(([^)]+)\)/.exec(layer);
    const rest = layer.replace(/rgba?\([^)]+\)/, "").trim();
    const inset = /\binset\b/.test(rest);
    const lengths = rest
      .replace(/\binset\b/, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((v) => parseFloat(v));
    if (lengths.length < 2 || lengths.some(Number.isNaN)) continue;
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    const c = (color?.[1] ?? "0, 0, 0")
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    out.push({
      type: inset ? "INNER_SHADOW" : "DROP_SHADOW",
      color: { r: (c[0] ?? 0) / 255, g: (c[1] ?? 0) / 255, b: (c[2] ?? 0) / 255, a: c[3] ?? 1 },
      offset: { x, y },
      radius: blur,
      spread,
      visible: true,
      blendMode: "NORMAL",
    });
  }
  return out.reverse();
}

export type BlurEffect = { type: "LAYER_BLUR" | "BACKGROUND_BLUR"; blurType: "NORMAL"; radius: number; visible: true };

/** The functions of a computed filter ("blur(4px) drop-shadow(rgba(0, 0, 0, 0.2) 0px 2px 4px)"), nested parentheses kept. */
function filterFunctions(css: string): { name: string; arg: string }[] {
  const out: { name: string; arg: string }[] = [];
  const re = /([a-z-]+)\(/gi;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth; i++) depth += css[i] === "(" ? 1 : css[i] === ")" ? -1 : 0;
    out.push({ name: m[1]!.toLowerCase(), arg: css.slice(re.lastIndex, i - 1).trim() });
    re.lastIndex = i;
  }
  return out;
}

/**
 * CSS filter and backdrop-filter (computed) → Figma effects: blur() a layer blur, drop-shadow() a drop shadow,
 * a backdrop's blur() a background blur (frosted bars and dialogs). Figma's blur radius is on box-shadow's scale,
 * twice CSS blur()'s (a standard deviation). Other filters (grayscale, brightness…) have no Figma effect.
 */
export function parseFilters(filter: string | undefined, backdrop: string | undefined): (ShadowEffect | BlurEffect)[] {
  const out: (ShadowEffect | BlurEffect)[] = [];
  for (const f of filter && filter !== "none" ? filterFunctions(filter) : []) {
    if (f.name === "blur" && parseFloat(f.arg) > 0)
      out.push({ type: "LAYER_BLUR", blurType: "NORMAL", radius: 2 * parseFloat(f.arg), visible: true });
    if (f.name === "drop-shadow") out.push(...parseBoxShadow(f.arg));
  }
  for (const f of backdrop && backdrop !== "none" ? filterFunctions(backdrop) : [])
    if (f.name === "blur" && parseFloat(f.arg) > 0)
      out.push({ type: "BACKGROUND_BLUR", blurType: "NORMAL", radius: 2 * parseFloat(f.arg), visible: true });
  return out;
}

/** CSS mix-blend-mode → Figma's blend mode (undefined: normal, or one Figma doesn't have). */
export function blendModeOf(css: string | undefined): string | undefined {
  const m: Record<string, string> = {
    multiply: "MULTIPLY",
    screen: "SCREEN",
    overlay: "OVERLAY",
    darken: "DARKEN",
    lighten: "LIGHTEN",
    "color-dodge": "COLOR_DODGE",
    "color-burn": "COLOR_BURN",
    "hard-light": "HARD_LIGHT",
    "soft-light": "SOFT_LIGHT",
    difference: "DIFFERENCE",
    exclusion: "EXCLUSION",
    hue: "HUE",
    saturation: "SATURATION",
    color: "COLOR",
    luminosity: "LUMINOSITY",
  };
  return css ? m[css] : undefined;
}
