// JSON with object keys in a fixed order, for comparing values: the same design read from Figma, from a file
// or from the service (Postgres jsonb reorders keys) must compare equal.
export function stableStringify(v: unknown, omit?: (key: string) => boolean): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort())
        if (!omit?.(k) && (x as Record<string, unknown>)[k] !== undefined) out[k] = norm((x as Record<string, unknown>)[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v)) ?? "undefined";
}

/** Equal as values, whatever the order of object keys. */
export const sameValue = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/** Colour channels and opacities: the browser draws them in 8 bits, so values one step (1/255) apart are the same. */
const EIGHT_BIT = new Set(["r", "g", "b", "a", "opacity"]);
/**
 * The same design value, colours and opacities within one 8-bit step (a 14% tint is 36/255 = 0.1412 once the
 * browser has drawn it; the designer typed 0.14), everything else exactly.
 */
export function sameDesignValue(a: unknown, b: unknown, key?: string): boolean {
  if (typeof a === "number" && typeof b === "number") return key && EIGHT_BIT.has(key) ? Math.abs(a - b) <= 1 / 255 + 1e-9 : a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameDesignValue(x, b[i], key));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => kb.includes(k) && sameDesignValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], k));
  }
  return a === b || (a == null && b == null);
}
