/** An sRGB colour with channels 0–1, as Figma takes it. */
export type TokenRGBA = { r: number; g: number; b: number; a: number };

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const channel = (s: string) => (s.endsWith("%") ? Number.parseFloat(s) / 100 : Number.parseFloat(s) / 255);
const alphaOf = (s: string | undefined) => (s === undefined ? 1 : s.endsWith("%") ? Number.parseFloat(s) / 100 : Number.parseFloat(s));
const ok = (c: TokenRGBA): TokenRGBA | null =>
  [c.r, c.g, c.b, c.a].every(Number.isFinite) ? { r: clamp(c.r), g: clamp(c.g), b: clamp(c.b), a: clamp(c.a) } : null;

/**
 * A design token's colour value as Figma's RGBA, or null when it can't be read.
 * Reads hex (#rgb, #rgba, #rrggbb, #rrggbbaa), rgb()/rgba() (comma or space syntax, alpha as 0–1 or %),
 * and DTCG colour objects in sRGB ({ colorSpace: "srgb", components: [r, g, b], alpha }).
 */
export function parseTokenColor(raw: unknown): TokenRGBA | null {
  if (raw && typeof raw === "object") {
    const o = raw as { colorSpace?: string; components?: unknown[]; alpha?: number; hex?: string };
    if ((o.colorSpace === undefined || o.colorSpace === "srgb") && Array.isArray(o.components) && o.components.length === 3) {
      const [r, g, b] = o.components.map(Number) as [number, number, number];
      return ok({ r, g, b, a: o.alpha ?? 1 });
    }
    return typeof o.hex === "string" ? parseTokenColor(o.hex) : null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (i: number) => Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return ok({ r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 });
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(s)?.[1];
  if (fn) {
    // rgb(1, 2, 3) / rgba(1, 2, 3, 0.5) / rgb(1 2 3 / 50%)
    const [rgbPart, slashAlpha] = fn.split("/").map((p) => p.trim());
    const parts = (rgbPart ?? "").split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4 || (parts.length === 4 && slashAlpha !== undefined)) return null;
    const [r, g, b, a] = parts as [string, string, string, string | undefined];
    return ok({ r: channel(r), g: channel(g), b: channel(b), a: alphaOf(slashAlpha ?? a) });
  }
  return null;
}
