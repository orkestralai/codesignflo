// From a Figma-space delta to code-level changes. Ported from spike S6.
// Deterministic: grouping and token translation happen here; an LLM only edits files.
import type { Item } from "../diff/diff.js";
import { stableStringify } from "../util/stable.js";

/** Key used to store the designer's scope choice for a change. */
/**
 * Identifies a change for the designer's scope answer: layer, property, and — when made in only some
 * variants — which ones (the same property can change differently per variant; M6).
 */
export const changeKey = (c: { layer: string; prop: string; variants?: string[] | "all" }) =>
  `${c.layer}|${c.prop}${Array.isArray(c.variants) ? `|${[...c.variants].sort().join(";")}` : ""}`;

export type Change = {
  id: string; // C1, C2… stable by sort order
  layer: string; // layer path inside the component, e.g. "body/price" or "body/button > text"
  prop: string;
  kind: string;
  from: string;
  to: string;
  variants: string[] | "all";
  items: string[]; // delta item ids
  /** Designer's choice for changes made in only some variants (from the claim record). */
  scope?: "all" | "variants";
  /**
   * Figma variables the change uses that are not the project's tokens (another collection, e.g. a team
   * library): the code has no such token. `value` is what it resolves to in the designer's file.
   */
  foreign?: { variable: string; value: string; token: string }[];
};

/** The variable collection CoDesignFlo creates from the project's tokens (DTCG). */
export const TOKENS_COLLECTION = "Tokens";

/**
 * The project token a designer's other variable becomes (the designer decides; the code adds the token,
 * M6): "Colors/Accents/Red" → "color/accents/red" for a colour, "spacing/Gutter" → "spacing/gutter".
 */
export function tokenForVariable(variable: string, isColor: boolean): string {
  const segs = variable
    .split("/")
    .slice(1)
    .map((p) =>
      p
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase(),
    )
    .filter(Boolean);
  return (isColor && segs[0] !== "color" ? ["color", ...segs] : segs).join("/");
}

/**
 * Rewrites the designer's other variables to the project tokens made from them, where those exist, so a
 * delivered "Colors/Accents/Red" matches Live's "Tokens/color/accents/red" when verifying.
 */
export function adoptForeignVariables<T>(tree: T, projectTokens: Set<string>): T {
  return JSON.parse(JSON.stringify(tree), (_k, v) => {
    const m = typeof v === "string" ? /^var\(([^/)]+)\/(.+)\)$/.exec(v) : null;
    if (!m || m[1] === TOKENS_COLLECTION) return v;
    for (const isColor of [true, false]) {
      const t = tokenForVariable(`${m[1]}/${m[2]}`, isColor);
      if (projectTokens.has(t)) return `var(${TOKENS_COLLECTION}/${t})`;
    }
    return v;
  }) as T;
}

const hex2 = (n: number) =>
  Math.round(n * 255)
    .toString(16)
    .padStart(2, "0");
/** Variables outside the project's collection, with the value they resolve to, in one delta item. */
function foreignOf(i: Item): { variable: string; value: string; token: string }[] {
  const out: { variable: string; value: string; token: string }[] = [];
  const bound = (i.toBound ?? {}) as Record<string, unknown>;
  const values = (Array.isArray(i.to) ? i.to : [i.to]) as unknown[];
  JSON.stringify(bound, (_k, v) => {
    const m = typeof v === "string" ? /^var\(([^/)]+)\/(.+)\)$/.exec(v) : null;
    if (m && m[1] !== TOKENS_COLLECTION) {
      const paint = values.find((x) => typeof x === "object" && x && "color" in x) as
        | { color?: { r: number; g: number; b: number } }
        | undefined;
      const value = paint?.color ? `#${hex2(paint.color.r)}${hex2(paint.color.g)}${hex2(paint.color.b)}` : JSON.stringify(i.to);
      out.push({ variable: `${m[1]}/${m[2]}`, value, token: tokenForVariable(`${m[1]}/${m[2]}`, !!paint?.color) });
    }
    return v;
  });
  return out;
}

/** "V[Sale=false,Title=short]|card.product/Sale=false, Title=short/body/price" → "body/price". */
export function layerOf(target: string): string {
  const [, ...keys] = target.split("|");
  return (
    keys
      .map((k) => k.split("/").slice(2).join("/"))
      .filter(Boolean)
      .join(" > ") || "(root)"
  );
}
const variantOf = (target: string) => /^V\[([^\]]*)\]/.exec(target)?.[1] ?? "";

/** var(Tokens/color/text/primary) → var(--color-text-primary) */
export const cssVar = (ref: string) =>
  ref.replace(/var\((?:[^/)]+\/)?([^)]+)\)/g, (_, name: string) => `var(--${name.replace(/\//g, "-")})`);

/** Human/LLM-readable value, preferring token references (as CSS custom properties). */
function describe(prop: string, v: unknown, weightTokens: Map<number, string>, boundTo?: Record<string, unknown>): string {
  // Padding as CSS shorthand, side by side (a token where the side has one): "2px var(--space-4)", so a
  // change to the sides only doesn't read as a change to all four.
  if (prop === "padding" && Array.isArray(v) && v.length === 4) {
    const sides = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
    const side = (i: number) => {
      const b = boundTo?.[sides[i]!];
      const ref = (Array.isArray(b) ? b[0] : b) as string | undefined;
      return typeof ref === "string" && ref.startsWith("var(") ? cssVar(ref) : `${v[i]}px`;
    };
    const [t, r, b, l] = [0, 1, 2, 3].map(side);
    return t === r && r === b && b === l ? t! : t === b && r === l ? `${t} ${r}` : r === l ? `${t} ${r} ${b}` : `${t} ${r} ${b} ${l}`;
  }
  const bound = (x: unknown) =>
    JSON.stringify(x)
      .match(/var\([^)]+\)/g)
      ?.map(cssVar) ?? [];
  if (boundTo) {
    const b = [...new Set(bound(boundTo))];
    if (b.length) return b.join(" ");
  }
  if (v === undefined || v === null) return "(none)";
  if (prop === "fills" || prop === "strokes") {
    const b = [...new Set(bound(v))];
    if (b.length) return b.join(" ");
    return stableStringify((v as { color?: unknown }[]).map((p) => p.color));
  }
  if (prop === "fontName") {
    const style = (v as { style: string }).style;
    const w = { Regular: 400, Medium: 500, "Semi Bold": 600, Bold: 700 }[style] ?? 400;
    const t = weightTokens.get(w);
    return `font-weight ${w}${t ? ` (var(--${t}))` : ""}`;
  }
  return stableStringify(v);
}

/**
 * A token binding removed while the value stays the same (the designer typed the same number, or reset a
 * field) is not a design change: the code keeps its token (M6: resetting a gap to Auto unbound space-2).
 * Rebinding to a different token, or a different value, is still a change.
 */
function bindingDropped(i: Item): boolean {
  if (i.kind !== "token" || !i.fromBound) return false;
  const hasTo = i.toBound && JSON.stringify(i.toBound).includes("var(");
  if (hasTo) return false;
  const strip = (v: unknown) => stableStringify(v, (k) => k === "boundVariables");
  return strip(i.from) === strip(i.to);
}

export function group(items: Item[], dtcg: Record<string, unknown>, allVariants: string[]): Change[] {
  const weightTokens = new Map<number, string>();
  const walk = (n: Record<string, unknown>, path: string[]) => {
    if ("$value" in n) {
      if (path[0] === "font" && path[1] === "weight") weightTokens.set(Number(n.$value), path.join("-"));
      return;
    }
    for (const k of Object.keys(n).filter((x) => !x.startsWith("$"))) walk(n[k] as Record<string, unknown>, [...path, k]);
  };
  walk(dtcg, []);
  const groups = new Map<string, Omit<Change, "id">>();
  for (const i of items) {
    if (bindingDropped(i)) continue;
    const layer = layerOf(i.target);
    const prop = i.prop ?? i.op ?? "?";
    const from = describe(prop, i.from, weightTokens, i.fromBound);
    const to = describe(prop, i.to, weightTokens, i.toBound);
    const key = JSON.stringify([layer, prop, from, to]);
    const g = groups.get(key) ?? { layer, prop, kind: i.kind, from, to, variants: [] as string[], items: [] };
    (g.variants as string[]).push(variantOf(i.target));
    g.items.push(i.id);
    for (const f of foreignOf(i)) if (!g.foreign?.some((x) => x.variable === f.variable)) g.foreign = [...(g.foreign ?? []), f];
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => (a.layer + a.prop < b.layer + b.prop ? -1 : 1))
    .map((g, n) => ({
      ...g,
      id: `C${n + 1}`,
      variants: (g.variants as string[]).length === allVariants.length ? "all" : (g.variants as string[]).sort(),
    }));
}
