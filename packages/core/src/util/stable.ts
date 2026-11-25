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
