// The designer's design system next to the code's components (docs/DESIGN-SYSTEM.md): suggested links
// between Library components and the code's, the property mapping between them (`size=sm` ↔ `Size=Small`),
// which Library variant draws a code variant, where a linked pair differs, token suggestions, and the code
// components a design uses (for the developer's instructions). Pure: the plugin gathers the facts.
import { deltaE, hexToRgba, SAME_COLOUR } from "../apply/check.js";
import type { Raw } from "../snapshot/canonical.js";

/** A component's variant properties and their values ("size" → ["sm", "md"]). */
export type Props = Record<string, string[]>;
export type CodeComponent = { k: string; name: string; props: Props };
export type LibraryComponent = { id: string; name: string; props: Props };
/** Code property → Library property, and per code property, code value → Library value. */
export type PropMap = { props: Record<string, string>; values: Record<string, Record<string, string>> };
export type Suggestion = { k: string; id: string; score: number; map: PropMap; why: string };

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const singular = (s: string) => (s.length > 3 && s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s);

/** "components.button-group", "Button Group", "Buttons/Primary" (the last part) → "buttongroup"/"primary". */
export function normName(name: string): string {
  const last = name.split("/").pop() ?? name;
  const bare = last.includes(".") && !last.includes(" ") ? last.slice(last.lastIndexOf(".") + 1) : last;
  return singular(squash(bare));
}

/** Names a Library component goes by: its own, and the group before a slash ("Buttons/Primary" → button). */
function libraryNames(name: string): { name: string; weight: number }[] {
  const parts = name
    .split("/")
    .map((p) => singular(squash(p)))
    .filter(Boolean);
  const out = [{ name: normName(name), weight: 1 }];
  if (parts.length > 1) out.push({ name: parts[0]!, weight: 0.8 });
  return out;
}

function nameScore(code: CodeComponent, lib: LibraryComponent): { score: number; why: string } {
  const c = normName(code.k.startsWith("components.") || !code.name ? code.k : code.name);
  const c2 = normName(code.name || code.k);
  let best = { score: 0, why: "" };
  for (const l of libraryNames(lib.name))
    for (const n of [c, c2]) {
      const s =
        n === l.name ? l.weight : n.length >= 4 && l.name.length >= 4 && (n.includes(l.name) || l.name.includes(n)) ? 0.5 * l.weight : 0;
      if (s > best.score) best = { score: s, why: s === l.weight ? "same name" : "similar name" };
    }
  return best;
}

const PROP_GROUPS = [
  ["variant", "type", "kind", "style", "appearance", "hierarchy", "emphasis"],
  ["size", "scale"],
  ["state", "status", "interaction"],
  ["tone", "color", "colour", "intent", "theme"],
];
const VALUE_GROUPS = [
  ["sm", "small", "s"],
  ["md", "medium", "m", "regular", "base"],
  ["lg", "large", "l"],
  ["xs", "xsmall", "extrasmall"],
  ["xl", "xlarge", "extralarge"],
  ["true", "on", "yes"],
  ["false", "off", "no"],
  ["primary", "main", "brand"],
  ["destructive", "danger", "error", "critical", "negative"],
  ["ghost", "tertiary", "subtle", "text"],
  ["outline", "outlined", "bordered", "stroke"],
  ["disabled", "inactive"],
  ["hover", "hovered"],
  ["pressed", "active"],
  ["default", "rest", "enabled", "normal", "idle"],
];
const groupsOf = (groups: string[][], s: string) => groups.flatMap((g, i) => (g.includes(squash(s)) ? [i] : []));
const sameWord = (groups: string[][], a: string, b: string) =>
  squash(a) === squash(b) || groupsOf(groups, a).some((g) => groupsOf(groups, b).includes(g));

/** Which Library property and values stand for each code property and value. Unmatched ones are left out. */
export function mapProps(code: Props, lib: Props): PropMap {
  const map: PropMap = { props: {}, values: {} };
  const taken = new Set<string>();
  const valuesFor = (cv: string[], lv: string[]) => {
    const out: Record<string, string> = {};
    for (const v of cv) {
      const hit = lv.find((x) => squash(x) === squash(v)) ?? lv.find((x) => sameWord(VALUE_GROUPS, x, v));
      if (hit !== undefined) out[v] = hit;
    }
    return out;
  };
  // By name first, then by the values they share (a "kind" whose values are the code's "variant" ones).
  for (const pass of ["name", "values"] as const)
    for (const [p, cv] of Object.entries(code)) {
      if (map.props[p]) continue;
      let best: { q: string; n: number } | null = null;
      for (const [q, lv] of Object.entries(lib)) {
        if (taken.has(q)) continue;
        const named = sameWord(PROP_GROUPS, p, q);
        if (pass === "name" && !named) continue;
        const n = Object.keys(valuesFor(cv, lv)).length;
        if (pass === "values" && n < Math.max(2, Math.ceil(cv.length / 2))) continue;
        if (!best || n > best.n) best = { q, n };
      }
      if (!best) continue;
      taken.add(best.q);
      map.props[p] = best.q;
      map.values[p] = valuesFor(cv, lib[best.q]!);
    }
  // A yes/no property in code is often one value of a "State" property in Figma: disabled=true ↔
  // State=Disabled, disabled=false ↔ State=Default. Several can share that property (loading, disabled).
  for (const [p, cv] of Object.entries(code)) {
    if (map.props[p] || !cv.every((v) => v === "true" || v === "false")) continue;
    for (const [q, lv] of Object.entries(lib)) {
      if (
        Object.values(map.props).includes(q) &&
        !Object.keys(map.props).some(
          (x) => map.props[x] === q && Object.keys(map.values[x] ?? {}).every((v) => v === "true" || v === "false"),
        )
      )
        continue;
      const on = lv.find((x) => sameWord(VALUE_GROUPS, x, p));
      const off =
        lv.find((x) => groupsOf(VALUE_GROUPS, x).includes(VALUE_GROUPS.findIndex((g) => g.includes("default")))) ??
        lv.find((x) => x !== on);
      if (!on || !off) continue;
      map.props[p] = q;
      map.values[p] = { true: on, false: off };
      break;
    }
  }
  return map;
}

/** Share of the code's property values the mapping covers (1 when the code has none and neither has the Library). */
function coverage(code: Props, lib: Props, map: PropMap): number {
  const all = Object.entries(code).flatMap(([p, vs]) => vs.map((v) => [p, v] as const));
  if (!all.length) return Object.keys(lib).length ? 0.5 : 1;
  return all.filter(([p, v]) => map.values[p]?.[v] !== undefined).length / all.length;
}

/**
 * Suggested links: each code component with its likeliest Library component (by name, then by how many of
 * its variants the Library one has), one to one. Only for components without a link yet; `rejected` holds
 * the pairs the designer turned down ("<k>|<id>").
 */
export function suggestLinks(code: CodeComponent[], lib: LibraryComponent[], rejected: Set<string> = new Set()): Suggestion[] {
  const all: Suggestion[] = [];
  for (const c of code)
    for (const l of lib) {
      if (rejected.has(`${c.k}|${l.id}`)) continue;
      const n = nameScore(c, l);
      if (!n.score) continue;
      const map = mapProps(c.props, l.props);
      const cov = coverage(c.props, l.props, map);
      const score = Math.round(100 * (0.75 * n.score + 0.25 * cov)) / 100;
      if (score < 0.45) continue;
      const props = Object.entries(map.props).map(([p, q]) => (p === q ? p : `${p} → ${q}`));
      all.push({ k: c.k, id: l.id, score, map, why: `${n.why}${props.length ? `; ${props.join(", ")}` : ""}` });
    }
  all.sort((a, b) => b.score - a.score);
  const usedK = new Set<string>();
  const usedId = new Set<string>();
  return all.filter((s) => {
    if (usedK.has(s.k) || usedId.has(s.id)) return false;
    usedK.add(s.k);
    usedId.add(s.id);
    return true;
  });
}

/** "size=sm, variant=primary" → { size: "sm", variant: "primary" } (Figma's variant names). */
export function parseVariant(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of name.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Which Library variant draws this code variant: the first with every mapped value (properties the mapping
 * leaves out don't choose). -1 when a mapped value has no counterpart, or no variant combines them: the Library
 * doesn't support what the code passes, and Live keeps the code's version there.
 */
export function mapVariant(code: Record<string, string>, map: PropMap, lib: Record<string, string>[]): number {
  if (!lib.length) return 0;
  const want: Record<string, string> = {};
  for (const [p, v] of Object.entries(code)) {
    const q = map.props[p];
    if (!q) continue;
    const lv = map.values[p]?.[v];
    if (lv === undefined) return -1;
    want[q] = lv;
  }
  let best = { i: 0, n: -1 };
  lib.forEach((props, i) => {
    const n = Object.entries(want).filter(([q, v]) => props[q] === v).length;
    if (n > best.n) best = { i, n };
  });
  return best.n === Object.keys(want).length ? best.i : Object.keys(want).length ? -1 : best.i;
}

/** Library variant properties back in the code's terms ({ Size: "Small" } → { size: "sm" }), for instructions. */
export function codeProps(lib: Record<string, string>, map: PropMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, q] of Object.entries(map.props)) {
    if (lib[q] === undefined) continue;
    const back = Object.entries(map.values[p] ?? {}).find(([, lv]) => lv === lib[q]);
    if (back) out[p] = back[0];
  }
  return out;
}

/** What a variant looks like, for comparing a linked pair. */
export type VariantLook = {
  props: Record<string, string>;
  w: number;
  h: number;
  radius?: number;
  fill?: string;
  font?: string;
  /** Its border: colour and width. */
  stroke?: { color: string; width: number };
  /** Its shadow, in words ("0 4 12"): offset x, y and blur of the first. */
  shadow?: string;
  /** Padding (top, right, bottom, left) and gap, when it lays out its content. */
  padding?: [number, number, number, number];
  gap?: number;
  /** The colour of its (first) text. */
  textColor?: string;
};

/** Colours that look the same (ΔE under 2.3) aren't a difference; "#abc" vs "#abd" isn't one. */
const sameColour = (a: string, b: string) => {
  const x = hexToRgba(a.slice(0, 7));
  const y = hexToRgba(b.slice(0, 7));
  return x && y ? deltaE(x, y) < SAME_COLOUR : a.toLowerCase() === b.toLowerCase();
};

/**
 * A link between the code's component and the designer's that no longer holds: a Library property or value it
 * maps to that's gone (renamed or removed in Figma), or a code property it maps that the code no longer has.
 */
export function lintLink(code: VariantLook[], lib: VariantLook[], map: PropMap): string[] {
  const out: string[] = [];
  const libProps = new Set(lib.flatMap((l) => Object.keys(l.props)));
  const codeProps = new Set(code.flatMap((c) => Object.keys(c.props)));
  for (const [p, q] of Object.entries(map.props)) {
    if (!codeProps.has(p)) out.push(`the code has no ${p} any more (linked to your ${q})`);
    if (!libProps.has(q)) {
      out.push(`your Library has no ${q} any more (the code's ${p} is linked to it): renamed? link the component again`);
      continue;
    }
    for (const [v, lv] of Object.entries(map.values[p] ?? {}))
      if (!lib.some((l) => l.props[q] === lv)) out.push(`your Library has no ${q}=${lv} any more (the code's ${p}=${v} shows it)`);
  }
  return out;
}

/**
 * Where the designer's component differs from what the code draws, per code variant (option (a): Live shows
 * the designer's as it is and lists these). At most `max` lines.
 */
export function compareComponents(code: VariantLook[], lib: VariantLook[], map: PropMap, max = 6): string[] {
  const out: string[] = [];
  const unsupported: string[] = [];
  const words = (p: Record<string, string>) =>
    Object.entries(p)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ") || "default";
  for (const c of code) {
    const i = mapVariant(
      c.props,
      map,
      lib.map((l) => l.props),
    );
    if (i < 0) {
      unsupported.push(words(c.props));
      continue;
    }
    const l = lib[i]!;
    const parts: string[] = [];
    if (Math.abs(l.w - c.w) > 2 || Math.abs(l.h - c.h) > 2)
      parts.push(`${Math.round(l.w)}×${Math.round(l.h)} in your Library, ${Math.round(c.w)}×${Math.round(c.h)} in the app`);
    if (c.radius !== undefined && l.radius !== undefined && Math.abs(c.radius - l.radius) > 0.5)
      parts.push(`corners ${l.radius} vs ${c.radius}`);
    if (c.fill && l.fill && !sameColour(c.fill, l.fill)) parts.push(`fill ${l.fill} vs ${c.fill}`);
    if (c.font && l.font && c.font !== l.font) parts.push(`font ${l.font} vs ${c.font}`);
    if (c.textColor && l.textColor && !sameColour(c.textColor, l.textColor)) parts.push(`text colour ${l.textColor} vs ${c.textColor}`);
    if (!!c.stroke !== !!l.stroke)
      parts.push(l.stroke ? `a border in your Library, none in the app` : `no border in your Library, one in the app`);
    else if (c.stroke && l.stroke && (!sameColour(c.stroke.color, l.stroke.color) || Math.abs(c.stroke.width - l.stroke.width) > 0.5))
      parts.push(`border ${l.stroke.color} ${l.stroke.width} vs ${c.stroke.color} ${c.stroke.width}`);
    if ((c.shadow ?? "") !== (l.shadow ?? "")) parts.push(`shadow ${l.shadow ?? "none"} vs ${c.shadow ?? "none"}`);
    if (c.padding && l.padding && c.padding.some((x, i) => Math.abs(x - l.padding![i]!) > 1))
      parts.push(`padding ${l.padding.join(" ")} vs ${c.padding.join(" ")}`);
    if (c.gap !== undefined && l.gap !== undefined && Math.abs(c.gap - l.gap) > 1) parts.push(`gap ${l.gap} vs ${c.gap}`);
    if (parts.length) out.push(`${words(c.props)}: ${parts.join("; ")}`);
  }
  // Code properties the Library component has nothing for: every value of it shows the same Library variant.
  const unmapped = [...new Set(code.flatMap((c) => Object.keys(c.props)))].filter(
    (p) => !map.props[p] && new Set(code.map((c) => c.props[p])).size > 1,
  );
  if (unmapped.length) out.unshift(`nothing for ${unmapped.join(", ")} in your Library — its versions all show the same variant`);
  out.unshift(...lintLink(code, lib, map));
  if (unsupported.length)
    out.unshift(
      `no Library variant for ${unsupported.slice(0, 4).join(" / ")}${unsupported.length > 4 ? ` (+${unsupported.length - 4})` : ""} — pages use the code's version there`,
    );
  return out.length > max ? [...out.slice(0, max - 1), `… and ${out.length - max + 1} more`] : out;
}

export type CodeToken = { name: string; value: string | number };
export type DesignerVariable = { id: string; name: string; collection: string; value?: string | number };
export type TokenSuggestion = { token: string; id: string; why: string };

const CATEGORY = /^(colou?rs?|space|spacing|sizes?|radius|radii|fonts?|typography)/;
const tokenNorm = (s: string) => squash(s);
const withoutCategory = (s: string) => tokenNorm(s).replace(CATEGORY, "");
const valueNorm = (v: string | number | undefined) =>
  v === undefined
    ? undefined
    : typeof v === "number"
      ? String(Math.round(v * 100) / 100)
      : v.toLowerCase().replace(/^#([0-9a-f]{6})ff$/, "#$1");

/**
 * The designer's variable each code token likely is: the same name (separators and a category prefix aside),
 * else the only variable with the token's value. One to one; the designer confirms each.
 */
export function suggestTokens(code: CodeToken[], vars: DesignerVariable[], rejected: Set<string> = new Set()): TokenSuggestion[] {
  const out: TokenSuggestion[] = [];
  const used = new Set<string>();
  const pick = (t: CodeToken, v: DesignerVariable | undefined, why: string) => {
    if (!v || used.has(v.id) || rejected.has(`${t.name}|${v.id}`) || out.some((s) => s.token === t.name)) return;
    used.add(v.id);
    out.push({ token: t.name, id: v.id, why });
  };
  for (const t of code)
    pick(
      t,
      vars.find((v) => tokenNorm(v.name) === tokenNorm(t.name)),
      "same name",
    );
  for (const t of code) {
    const n = withoutCategory(t.name);
    if (n)
      pick(
        t,
        vars.find((v) => withoutCategory(v.name) === n),
        "same name",
      );
  }
  const byValue = (v: string | number | undefined) => vars.filter((x) => x.value !== undefined && valueNorm(x.value) === valueNorm(v));
  for (const t of code) {
    const same = byValue(t.value);
    const tokensWithIt = code.filter((c) => valueNorm(c.value) === valueNorm(t.value));
    if (same.length === 1 && tokensWithIt.length === 1) pick(t, same[0], `same value (${t.value})`);
  }
  return out;
}

/** A design-system component placed in a design: the code component it is linked to, in the code's terms. */
export type SystemUse = { layer: string; k: string; props: Record<string, string>; name: string };

/** The linked Library components a design places (the plugin tags each such instance with `uses`). */
export function systemUses(tree: Raw | null | undefined): SystemUse[] {
  const out: SystemUse[] = [];
  const walk = (n: Raw, path: string[]) => {
    const here = [...path, String(n.name ?? "")];
    const u = n.uses as { k?: string; props?: Record<string, string>; name?: string } | undefined;
    if (u?.k) {
      out.push({ layer: here.slice(1).join("/") || "(root)", k: u.k, props: u.props ?? {}, name: u.name ?? u.k });
      return; // what's inside is the component's own
    }
    for (const c of (n.children as Raw[] | undefined) ?? []) walk(c, here);
  };
  if (tree) walk(tree, []);
  return out;
}

/** The instructions' lines about them: use the code's component with these props, don't rebuild it from layers. */
export function usesLines(uses: SystemUse[]): string[] {
  if (!uses.length) return [];
  const groups = new Map<string, SystemUse[]>();
  for (const u of uses) {
    const id = `${u.k}|${JSON.stringify(Object.entries(u.props).sort())}`;
    groups.set(id, [...(groups.get(id) ?? []), u]);
  }
  return [
    "Components from the designer's design system (each is linked to a code component): use that component with these props — don't rebuild it from its layers:",
    ...[...groups.values()].map((g) => {
      const u = g[0]!;
      const props = Object.entries(u.props)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      const layers = g.map((x) => `\`${x.layer}\``);
      return `- ${layers.slice(0, 3).join(", ")}${layers.length > 3 ? ` (+${layers.length - 3} more)` : ""}: their "${u.name}" = ${u.k}${props ? ` with ${props}` : ""}`;
    }),
  ];
}
