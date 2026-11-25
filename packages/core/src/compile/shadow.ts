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
