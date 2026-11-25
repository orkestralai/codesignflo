// Compiler: IR (per story) + registry → declarative spec of one Figma component set per component.
// Deterministic: same IR in, byte-identical spec out. The plugin executor reconciles Figma to it.

import type { IRNode, IRStory, Tokened } from "./ir.js";
import { parseBoxShadow } from "./shadow.js";

export type Registry = {
  components: Record<
    string,
    {
      module: string;
      stories: Record<string, Record<string, string>>;
      /** Stories that differ from a variant only in example data: example story id → variant story id. */
      examples?: Record<string, string>;
    }
  >;
};

/** Children with a segment name unique among siblings: "link", "link#1", "link#2" (same scheme as keys). */
const segments = (children: IRNode[] = []) => {
  const seen = new Map<string, number>();
  return children.map((c) => {
    const i = seen.get(c.name) ?? 0;
    seen.set(c.name, i + 1);
    return [c, `${c.name}${i ? `#${i}` : ""}`] as const;
  });
};
const childAt = (n: IRNode | undefined, seg: string) => n && segments(n.children).find(([, s]) => s === seg)?.[0];

/** A styled range of a text layer: `start`/`end` index its characters. */
export type SpecRun = {
  start: number;
  end: number;
  fontName?: { family: string; style: string };
  fontSize?: number;
  fill?: string;
  underline?: boolean;
};

/** Desired Figma node. `k` is the sync key; the executor matches existing nodes by it. */
export type SpecNode = {
  k: string;
  type: "COMPONENT_SET" | "COMPONENT" | "FRAME" | "TEXT" | "RECTANGLE" | "SVG" | "INSTANCE";
  name: string;
  props: Record<string, unknown>;
  /** Node-level variable bindings: field → variable name ("space/2"). */
  bind?: Record<string, string>;
  /** Paint bindings: "fills" | "strokes" → variable name. */
  paintBind?: Record<string, string>;
  svg?: string;
  /** TEXT only: content differs between the component's stories, i.e. it comes from data, not code. */
  data?: true;
  /** TEXT only: parts styled differently from the rest (a bold email in a sentence), as Figma ranges. */
  runs?: SpecRun[];
  /** The size the browser rendered it at (pixels): Live is compared with it after building. */
  measured?: { w: number; h: number; x?: number; y?: number };
  instance?: { mainK: string; overrides: InstanceOverride[] };
  /**
   * INSTANCE only: the same layer as a plain frame — its main component's layers with this usage's
   * overrides, keyed under this layer. Live built on a designer's page follows this where the designer
   * drew the component's look as frames rather than placing the component (see inlineInstances).
   */
  inlined?: SpecNode;
  children?: SpecNode[];
};

/**
 * What an instance changes on its main component: text content, and fill colours (the instance's own
 * background, or a text colour) when the code styles this usage differently (e.g. a grey button in a card).
 */
export type InstanceOverride = {
  path: string[];
  /** The same layers by position among their siblings: used when a name differs (names that carry data). */
  at?: number[];
  characters?: string;
  fill?: string;
  fillToken?: string;
  /** Spacing this usage gives a frame of the component (a page's own padding on it): padding*, itemSpacing, cornerRadius. */
  layout?: Record<string, number>;
};

const WEIGHT_STYLE: Record<number, string> = {
  100: "Thin",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semi Bold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
};
/** Figma's style name for a CSS weight (the nearest hundred: 800 was "Regular" before, so bold text read thin). */
export const styleFor = (weight: number, italic?: boolean): string => {
  const w = WEIGHT_STYLE[Math.min(900, Math.max(100, Math.round(weight / 100) * 100))] ?? "Regular";
  return italic ? (w === "Regular" ? "Italic" : `${w} Italic`) : w;
};

/** "space-2" (CSS custom property) → "space/2" (Figma variable), using the DTCG tree for the split. */
export function tokenNames(dtcg: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: Record<string, unknown>, path: string[]) => {
    if ("$value" in node) return void out.set(path.join("-"), path.join("/"));
    for (const k of Object.keys(node).filter((x) => !x.startsWith("$"))) walk(node[k] as Record<string, unknown>, [...path, k]);
  };
  walk(dtcg, []);
  return out;
}

export type Screen = {
  spec: SpecNode;
  coverage: { nodes: number; inInstances: number; instances: Record<string, number>; unmapped: string[] };
};

/**
 * Text layers whose content differs between a component's variants come from data (story args / props),
 * e.g. a product title. Changing them in a proposal is a content change with no code impact.
 */
/**
 * `examples`: stories that differ from a variant only in data (a long title); their texts count too —
 * a title that is the same in every variant but differs in an example is still data (M6).
 */
function markDataText(variants: SpecNode[], examples: SpecNode[] = []) {
  const texts = new Map<string, Set<string>>();
  const rel = (k: string) => k.split("/").slice(2).join("/");
  const walk = (n: SpecNode, f: (n: SpecNode) => void) => {
    f(n);
    for (const c of n.children ?? []) walk(c, f);
  };
  for (const v of [...variants, ...examples])
    walk(v, (n) => {
      if (n.type !== "TEXT") return;
      const set = texts.get(rel(n.k)) ?? new Set<string>();
      set.add(String(n.props.characters));
      texts.set(rel(n.k), set);
    });
  for (const v of variants)
    walk(v, (n) => {
      if (n.type === "TEXT" && (texts.get(rel(n.k))?.size ?? 0) > 1) n.data = true;
    });
}

export function compile(registry: Registry, irs: Map<string, IRStory>, tokens: Map<string, string>): SpecNode[] {
  return dependencyOrder(compiler(registry, irs, tokens).sets());
}

/**
 * Component sets ordered so that every set comes after the sets it uses as instances (CartItem after
 * QuantityStepper): the executor needs the main component to exist before creating an instance of it.
 * Stable: otherwise keeps the registry order.
 */
export function dependencyOrder(sets: SpecNode[]): SpecNode[] {
  const deps = new Map<string, Set<string>>();
  for (const set of sets) {
    const d = new Set<string>();
    const walk = (n: SpecNode) => {
      if (n.instance) d.add(n.instance.mainK.split("/")[0]!);
      for (const c of n.children ?? []) walk(c);
    };
    walk(set);
    d.delete(set.k);
    deps.set(set.k, d);
  }
  const out: SpecNode[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (set: SpecNode) => {
    if (done.has(set.k)) return;
    if (visiting.has(set.k)) throw new Error(`components use each other in a cycle: ${[...visiting, set.k].join(" → ")}`);
    visiting.add(set.k);
    for (const k of deps.get(set.k) ?? []) {
      const dep = sets.find((x) => x.k === k);
      if (dep) visit(dep);
    }
    visiting.delete(set.k);
    done.add(set.k);
    out.push(set);
  };
  for (const set of sets) visit(set);
  return out;
}

/** Screens: a story rendered as a page, compiled to a frame built from Live instances where possible. */
export function compileScreens(
  registry: Registry & { screens?: Record<string, string | { story: string }> },
  irs: Map<string, IRStory>,
  tokens: Map<string, string>,
): Screen[] {
  const c = compiler(registry, irs, tokens);
  return Object.entries(registry.screens ?? {}).map(([key, entry]) => {
    const story = typeof entry === "string" ? entry : entry.story;
    const ir = irs.get(story);
    if (!ir) throw new Error(`no IR for screen story ${story}`);
    let spec: SpecNode;
    try {
      spec = c.node(settleSizing(ir.root), `screen:${key}`, null, true, "FRAME");
    } catch (e) {
      // Which page: the first thing to know (the message alone said only "reading 'direction'").
      throw new Error(`compiling ${key} (${story}): ${(e as Error).message}`, { cause: e });
    }
    spec.name = key;
    // Coverage: share of IR nodes rendered by library instances; frames outside instances are "unmapped".
    let nodes = 0;
    let inInstances = 0;
    const instances: Record<string, number> = {};
    const unmapped: string[] = [];
    const count = (n: IRNode): number => 1 + (n.children ?? []).reduce((a, x) => a + count(x), 0);
    const walk = (n: IRNode, path: string) => {
      const placedKey = c.placed(n);
      if (placedKey) {
        const k = count(n);
        nodes += k;
        inInstances += k;
        const name = n.component?.module ?? placedKey;
        instances[name] = (instances[name] ?? 0) + 1;
        return;
      }
      nodes++;
      if (n.type === "FRAME" && path) unmapped.push(path);
      for (const ch of n.children ?? []) walk(ch, path ? `${path}/${ch.name}` : ch.name);
    };
    walk(ir.root, "");
    return { spec, coverage: { nodes, inInstances, instances, unmapped } };
  });
}

/**
 * Sizing Figma can express (M6: a designed page collapsed to 60px in Live). CSS can size a box by things
 * Figma has no equivalent for (min-height, a flex: 1 child of a container sized by its content); there a
 * "fill" child of a hugging parent has nothing to fill and collapses. So, top-down:
 * - along the parent's main axis, a fill child of a hugging parent becomes fixed at its measured size;
 * - across it, a parent that hugs becomes fixed at its size when its children that don't fill wouldn't make
 *   it that big: a filling child sets its size (a row whose stretched column is taller than its fixed
 *   sidebar: Figma hugged the sidebar, 836 px for 2,427);
 * - across it, a "fill" child clearly narrower than the room it would fill (a bubble with max-width: 85%)
 *   doesn't fill: it becomes fixed at its size;
 * - in a grid that hugs, a child that fills its track becomes fixed at its size (the rows are sized by
 *   their content, which Figma's fill children don't give: a card 319 px tall drew 95).
 * The root's own "fill" is fixed (it has no parent).
 */
export function settleSizing(root: IRNode): IRNode {
  const fixRoot = (s: IRNode["sizing"]) => ({ w: s.w === "fill" ? "fixed" : s.w, h: s.h === "fill" ? "fixed" : s.h }) as IRNode["sizing"];
  // One line of text, not cut: filling a box only as wide as itself adds nothing, and Figma's glyphs are a
  // fraction wider than the browser's, so a box of exactly its width wraps it ("Zucchini Expert Bot" on 2 lines).
  const oneLine = (c: IRNode) => c.type === "TEXT" && !c.text?.maxLines && c.height < (c.text?.lineHeight || c.height) * 1.5;
  const walk = (n: IRNode, sizing: IRNode["sizing"]): IRNode => {
    const dir = n.layout?.direction;
    const main = dir === "HORIZONTAL" ? "w" : dir === "VERTICAL" ? "h" : null;
    const cross = dir === "HORIZONTAL" ? "h" : dir === "VERTICAL" ? "w" : null;
    // Across a column (or inside a box that hugs) a left-aligned line hugging looks the same and can't wrap.
    const loose = (c: IRNode) => oneLine(c) && c.sizing.w === "fill" && (sizing.w === "hug" || (dir === "VERTICAL" && !c.text?.align));
    if (n.children) n = { ...n, children: n.children.map((c) => (loose(c) ? { ...c, sizing: { ...c.sizing, w: "hug" } } : c)) };
    // In a wrapping row an item stretches to its own line, not the whole block: keep the size it has.
    if (n.layout?.wrap && cross && n.children)
      n = { ...n, children: n.children.map((c) => (c.sizing[cross] === "fill" ? { ...c, sizing: { ...c.sizing, [cross]: "fixed" } } : c)) };
    const size = (c: IRNode, a: "w" | "h") => (a === "w" ? c.width : c.height);
    // The room inside the box as CSS lays it out: its measured size less its padding and borders (top right
    // bottom left). A card 320 wide with a 1px border gives its children 318.
    const room = (a: "w" | "h") => {
      const p = n.layout?.padding;
      const b = n.stroke ? (n.stroke.sides ?? [n.stroke.width, n.stroke.width, n.stroke.width, n.stroke.width]) : [0, 0, 0, 0];
      const v = (i: number) => (p?.[i]?.value ?? 0) + (b[i] ?? 0);
      return a === "w" ? n.width - v(1) - v(3) : n.height - v(0) - v(2);
    };
    // (Margin spacers, 0 across, have no size to keep; text sizes its own height, as Figma measures it.)
    const narrower = (c: IRNode, a: "w" | "h") => !c.absolute && c.sizing[a] === "fill" && size(c, a) > 1 && size(c, a) < room(a) - 1;
    if (cross && !n.layout?.wrap && n.children)
      n = {
        ...n,
        children: n.children.map((c) =>
          narrower(c, cross) ? { ...c, sizing: { ...c.sizing, [cross]: c.type === "TEXT" && cross === "h" ? "hug" : "fixed" } } : c,
        ),
      };
    const kids = (n.children ?? []).filter((c) => (c.type !== "TEXT" || c.width > 0) && !c.absolute);
    const own = { ...sizing };
    if (cross && own[cross] === "hug" && kids.some((c) => c.sizing[cross] === "fill")) {
      const others = Math.max(0, ...kids.filter((c) => c.sizing[cross] !== "fill").map((c) => size(c, cross)));
      if (others < room(cross) - 1) own[cross] = "fixed";
    }
    const children = (n.children ?? []).map((c) => {
      const cs = { ...c.sizing };
      if (main && own[main] === "hug" && cs[main] === "fill") cs[main] = "fixed";
      if (dir === "GRID")
        for (const a of ["w", "h"] as const)
          if (own[a] === "hug" && cs[a] === "fill") cs[a] = c.type === "TEXT" && a === "h" ? "hug" : "fixed";
      return walk(c, cs);
    });
    return { ...n, sizing: own, ...(n.children ? { children } : {}) };
  };
  return walk(root, fixRoot(root.sizing));
}

/** A variant's name in Figma from its props: "size=sm, tone=sale" (its sync key is `<component>/<name>`). */
/**
 * "size=md, variant=primary". Figma rejects a component set with an empty value or "=" / "," inside one
 * ("variant=" broke a whole update): empty becomes "default", those characters a space.
 */
export const variantName = (props: Record<string, string>) =>
  Object.keys(props)
    .sort()
    .map(
      (p) =>
        `${p}=${
          String(props[p] ?? "")
            .replace(/[=,]/g, " ")
            .trim() || "default"
        }`,
    )
    .join(", ");

/**
 * A component story's root without the bare wrappers around it (a Storybook decorator's div: no fill,
 * border, shadow or corners of its own, and one child): the component is what's inside. Otherwise Live's
 * Button was a 1168 px box holding the button, and pages couldn't place it.
 */
export function unwrap(root: IRNode): IRNode {
  let n = root;
  while (
    n.type === "FRAME" &&
    n.children?.length === 1 &&
    n.children[0]!.type === "FRAME" &&
    !n.fill &&
    !n.gradient &&
    !n.stroke &&
    !n.shadow &&
    !n.radius?.value &&
    !n.image &&
    !n.component &&
    !n.module
  )
    n = n.children[0]!;
  return n;
}

/** Fewer classes than this on a component's root can't tell it apart on a page ("flex items-center"). */
const MIN_CLASSES = 4;
const classSet = (n: IRNode) => new Set((n.cls ?? "").split(" ").filter(Boolean));

function compiler(registry: Registry, irs0: Map<string, IRStory>, tokens: Map<string, string>) {
  const v = (t?: Tokened<unknown>) => (t?.token ? tokens.get(t.token) : undefined);
  const byModule = new Map(Object.entries(registry.components).map(([key, c]) => [c.module, { key, ...c }]));
  const byKey = new Map(Object.entries(registry.components).map(([key, c]) => [key, { key, ...c }]));
  // Components' stories start at the component itself (see unwrap); pages keep their whole tree.
  const componentStories = new Set(
    Object.values(registry.components).flatMap((c) => [...Object.keys(c.stories), ...Object.keys(c.examples ?? {})]),
  );
  const irs = new Map([...irs0].map(([s, ir]) => [s, componentStories.has(s) ? { ...ir, root: unwrap(ir.root) } : ir] as const));
  const layers = (n: IRNode): number => 1 + (n.children ?? []).reduce((a, c) => a + layers(c), 0);
  /** Each component's root classes per story, and its size in layers (a component only contains smaller ones). */
  const rootClasses = [...byKey.values()].flatMap((c) =>
    Object.keys(c.stories).flatMap((story) => {
      const r = irs.get(story)?.root;
      const cls = r ? classSet(r) : new Set<string>();
      return r && cls.size >= MIN_CLASSES ? [{ key: c.key, story, cls, size: layers(r) }] : [];
    }),
  );
  const sizeOf = new Map<string, number>();
  for (const r of rootClasses) sizeOf.set(r.key, Math.max(sizeOf.get(r.key) ?? 0, r.size));
  /**
   * A component without a CSS module (Tailwind): an element carrying every class of its root in one of its
   * stories is it (the page may add its own: a margin). The story with the most of them is the variant;
   * the structure check below still has to agree. Inside a component only smaller components count, so two
   * can never contain each other.
   */
  const byClasses = (n: IRNode, within?: string) => {
    const mine = classSet(n);
    if (mine.size < MIN_CLASSES) return undefined;
    let best: { key: string; stories: string[]; n: number } | null = null;
    for (const r of rootClasses) {
      if (r.key === within) continue;
      if (within && sizeOf.has(within) && r.size >= sizeOf.get(within)!) continue;
      if (![...r.cls].every((c) => mine.has(c))) continue;
      if (!best || r.cls.size > best.n) best = { key: r.key, stories: [r.story], n: r.cls.size };
      else if (r.key === best.key && r.cls.size === best.n) best.stories.push(r.story);
    }
    return best ? { target: byKey.get(best.key)!, stories: best.stories } : undefined;
  };

  // Text that wraps in an example story (a longer title) but not in its variant must be able to wrap in
  // Figma too: width FILL, height growing. Keys of those text layers, built like node keys.
  const wraps = new Set<string>();
  for (const [key, c] of Object.entries(registry.components)) {
    for (const [example, variantStory] of Object.entries(c.examples ?? {})) {
      const props = c.stories[variantStory];
      const a = irs.get(variantStory)?.root;
      const b = irs.get(example)?.root;
      if (!props || !a || !b) continue;
      const walk = (x: IRNode | undefined, y: IRNode | undefined, k: string) => {
        if (!x || !y) return;
        if (x.type === "TEXT" && y.type === "TEXT" && x.sizing.w === "hug" && y.height > x.height + 2) wraps.add(k);
        for (const [cx, s] of segments(x.children)) walk(cx, childAt(y, s), `${k}/${s}`);
      };
      walk(a, b, `${key}/${variantName(props)}`);
    }
  }

  /** Pick the variant of a nested component whose property values best match the element's classes. */
  const instanceOf = (n: IRNode, within?: string): SpecNode["instance"] | undefined => {
    let target = n.component && byModule.get(n.component.module);
    let only: string[] | null = null;
    if (target) {
      // Its root element, not one of its inner parts (a modal's header carries the modal's module too).
      const moduleRoot = new Set(Object.keys(target.stories).flatMap((st) => irs.get(st)?.root.component?.classes ?? []));
      if (moduleRoot.size && !n.component!.classes.some((c) => moduleRoot.has(c))) return undefined;
    } else {
      const hit = byClasses(n, within);
      if (!hit) return undefined;
      target = hit.target;
      only = hit.stories;
    }
    const classes = new Set(n.component?.classes ?? []);
    // Score each variant: class names that match its property values + how similar its layer structure is
    // (e.g. a card with a badge is the Sale=true variant even though both use the same root class).
    // Layer path + width sizing: a wrapping title (fill) vs a one-line title (hug) is a real variant difference.
    const shape = (m: IRNode, path = ""): string[] => [
      `${path}${m.name}:${m.sizing.w}`,
      ...(m.children ?? []).flatMap((c) => shape(c, `${path}${m.name}/`)),
    ];
    const mine = new Set(shape(n));
    // Content the page puts inside it (a modal's form, a popup's URL bar) is markup of another module than
    // the component's: an instance only shows its main component's layers, so only a variant made of the
    // same modules will do; with none, it's built as a frame with the page's content.
    const modules = (m: IRNode): string[] => [...(m.module ? [m.module] : []), ...(m.children ?? []).flatMap(modules)];
    const needed = [...new Set(modules(n))].filter((x) => !byModule.has(x));
    let best: { props: Record<string, string>; score: number; story: string } | null = null;
    for (const [story, props] of Object.entries(target.stories)) {
      if (only && !only.includes(story)) continue;
      const has = new Set(modules(irs.get(story)!.root));
      if (needed.some((x) => !has.has(x))) continue;
      const theirs = new Set(shape(irs.get(story)!.root));
      const jaccard = [...mine].filter((x) => theirs.has(x)).length / new Set([...mine, ...theirs]).size;
      const score = Object.values(props).filter((x) => classes.has(x)).length + jaccard;
      if (!best || score > best.score + 1e-9) best = { props, score, story };
    }
    if (!best) return undefined;
    const main = irs.get(best.story)?.root;
    const overrides: InstanceOverride[] = [];
    // The main component's layer at the same path (by layer names), to see what this usage changes.
    const mainAt = (path: string[]) => path.reduce<IRNode | undefined>((m, seg) => childAt(m, seg), main);
    if (main && n.fill?.value !== main.fill?.value && n.fill) {
      const t = v(n.fill);
      overrides.push({ path: [], fill: n.fill.value, ...(t ? { fillToken: t } : {}) });
    }
    // Padding, gap and corner radius where this usage differs from the main component's layer.
    const spacing = (m: IRNode | undefined) =>
      m?.layout && m.layout.direction !== "GRID"
        ? {
            paddingTop: m.layout.padding[0].value,
            paddingRight: m.layout.padding[1].value,
            paddingBottom: m.layout.padding[2].value,
            paddingLeft: m.layout.padding[3].value,
            itemSpacing: m.layout.gap.value,
            cornerRadius: m.radius?.value ?? 0,
          }
        : undefined;
    const layoutOverride = (m: IRNode, mm: IRNode | undefined) => {
      const [a, b] = [spacing(m), spacing(mm)];
      if (!a || !b) return undefined;
      const diff = Object.fromEntries(Object.entries(a).filter(([f, x]) => Math.abs(x - b[f as keyof typeof b]) > 0.01));
      return Object.keys(diff).length ? diff : undefined;
    };
    const rootLayout = layoutOverride(n, main);
    if (rootLayout) overrides.push({ path: [], layout: rootLayout });
    // Paths use segments unique among siblings, so three "link"s in a nav get three different overrides.
    const texts = (m: IRNode, path: string[], seg: string, at: number[]) => {
      if (m.type === "TEXT" && m.text) {
        const p = [...path, seg];
        const o: InstanceOverride = { path: p, at, characters: m.text.characters };
        const mt = mainAt(p);
        if (mt?.text && mt.text.color.value !== m.text.color.value) {
          o.fill = m.text.color.value;
          const t = v(m.text.color);
          if (t) o.fillToken = t;
        }
        overrides.push(o);
      } else if (m !== n && m.type === "FRAME") {
        const p = [...path, seg];
        const layout = layoutOverride(m, mainAt(p));
        if (layout) overrides.push({ path: p, at, layout });
      }
      for (const [i, [c, s]] of segments(m.children).entries()) texts(c, m === n ? [] : [...path, seg], s, [...at, i]);
    };
    texts(n, [], n.name, []);
    // Every override must find its layer in the main component, as the plugin looks for it (by name, then
    // by position), and a text one a text layer: otherwise the page's content has another structure (a
    // button the page fills with a label and a badge) and an instance would show the wrong content.
    const target_ = (o: InstanceOverride) =>
      o.path.reduce<IRNode | undefined>(
        (m, seg, d) => childAt(m, seg) ?? (o.at?.[d] !== undefined ? m?.children?.[o.at[d]!] : undefined),
        main,
      );
    if (main && overrides.some((o) => o.path.length && (!target_(o) || (o.characters !== undefined && target_(o)!.type !== "TEXT"))))
      return undefined;
    return { mainK: `${target.key}/${variantName(best.props)}`, overrides };
  };

  /** Every layer carries its size as the browser measured it: after building, Live is checked against it. */
  const node = (
    n: IRNode,
    k: string,
    parentLayout: IRNode["layout"] | null,
    isVariantRoot: boolean,
    rootType: "COMPONENT" | "FRAME" = "COMPONENT",
  ): SpecNode => ({
    ...build(n, k, parentLayout, isVariantRoot, rootType),
    // Margin spacers (and anything else the page didn't measure) have no size of their own to check.
    ...(n.width > 0 && n.height > 0
      ? { measured: { w: Math.round(n.width), h: Math.round(n.height), ...(n.at ? { x: Math.round(n.at.x), y: Math.round(n.at.y) } : {}) } }
      : {}),
  });

  const build = (
    n: IRNode,
    k: string,
    parentLayout: IRNode["layout"] | null,
    isVariantRoot: boolean,
    rootType: "COMPONENT" | "FRAME" = "COMPONENT",
  ): SpecNode => {
    const props: Record<string, unknown> = {};
    const bind: Record<string, string> = {};
    const paintBind: Record<string, string> = {};
    // Out of the flow: an absolutely positioned layer in the auto-layout parent, at its offset (set first:
    // Figma takes x/y only once the layer is absolute).
    // CSS rotates clockwise, Figma counter-clockwise.
    if (n.rotation) props.rotation = -n.rotation;
    if (n.absolute) {
      if (parentLayout) props.layoutPositioning = "ABSOLUTE";
      props.x = n.absolute.x;
      props.y = n.absolute.y;
    }
    // Size: in an auto-layout parent, sizing per axis; at a variant root, "fill" has no parent → fixed.
    const axis = (s: "fixed" | "hug" | "fill") =>
      isVariantRoot && s === "fill" ? "FIXED" : s === "fill" ? "FILL" : s === "hug" ? "HUG" : "FIXED";
    if (parentLayout) {
      props.layoutSizingHorizontal = axis(n.sizing.w);
      props.layoutSizingVertical = axis(n.sizing.h);
    }
    const fixedW = n.sizing.w === "fixed" || (isVariantRoot && n.sizing.w === "fill");
    const fixedH = n.sizing.h === "fixed" || (isVariantRoot && n.sizing.h === "fill");
    if (fixedW) props.width = n.width;
    if (fixedH) props.height = n.height;
    // A margin spacer's size comes from its token (e.g. margin-bottom: var(--space-2)).
    if (n.spaceToken && tokens.get(n.spaceToken)) bind[fixedH ? "height" : "width"] = tokens.get(n.spaceToken)!;

    if (n.type === "TEXT" && n.text && wraps.has(k)) {
      if (parentLayout) props.layoutSizingHorizontal = "FILL";
      delete props.width;
      n = { ...n, sizing: { ...n.sizing, w: "fill" } };
    }
    if (n.type === "TEXT" && n.text) {
      const t = n.text;
      props.characters = t.characters;
      props.fontName = { family: t.fontFamily, style: styleFor(t.fontWeight.value, t.italic) };
      props.fontSize = t.fontSize.value;
      props.lineHeight = t.lineHeight > 0 ? { unit: "PIXELS", value: t.lineHeight } : { unit: "AUTO" };
      props.letterSpacing = { unit: "PIXELS", value: t.letterSpacing };
      props.fills = [t.color.value];
      // A text box with its own width (fill, or fixed like a centred min-width) wraps; otherwise it hugs.
      props.textAutoResize = n.sizing.w === "hug" ? "WIDTH_AND_HEIGHT" : "HEIGHT";
      if (t.align) props.textAlignHorizontal = t.align;
      if (t.case) props.textCase = t.case;
      if (t.maxLines) {
        props.textTruncation = "ENDING";
        props.maxLines = t.maxLines;
      }
      const c = v(t.color);
      if (c) paintBind.fills = c;
      const fs = v(t.fontSize);
      if (fs) bind.fontSize = fs;
      const runs = t.runs?.map((r) => ({
        start: r.start,
        end: r.end,
        ...(r.fontFamily || r.fontWeight !== undefined || r.italic !== undefined
          ? {
              fontName: {
                family: r.fontFamily ?? t.fontFamily,
                style: styleFor(r.fontWeight ?? t.fontWeight.value, r.italic ?? t.italic),
              },
            }
          : {}),
        ...(r.fontSize !== undefined ? { fontSize: r.fontSize } : {}),
        ...(r.color ? { fill: r.color } : {}),
        ...(r.underline !== undefined ? { underline: r.underline } : {}),
      }));
      return {
        k,
        type: "TEXT",
        name: n.name,
        props,
        ...(Object.keys(bind).length ? { bind } : {}),
        ...(Object.keys(paintBind).length ? { paintBind } : {}),
        ...(runs?.length ? { runs } : {}),
      };
    }
    if (n.type === "IMAGE") {
      // A picture is an image fill ("image:<content hash>", resolved by the plugin); else a placeholder colour.
      props.fills = [n.image?.ref ? `image:${n.image.ref}` : (n.fill?.value ?? "#e0e7ff")];
      if (!parentLayout || n.sizing.w === "fixed") props.width = n.width;
      if (!parentLayout || n.sizing.h === "fixed") props.height = n.height;
      return { k, type: "RECTANGLE", name: n.name, props };
    }
    if (n.type === "SVG") {
      return {
        k,
        type: "SVG",
        name: n.name,
        props: {
          width: n.width,
          height: n.height,
          ...(parentLayout ? { layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED" } : {}),
          // Out of the flow and where it sits, like any layer (a checkbox at a row's corner was put in the row's
          // flow, under its content, and only the last row's showed, below the list).
          ...Object.fromEntries(
            ["rotation", "layoutPositioning", "x", "y"].filter((f) => props[f] !== undefined).map((f) => [f, props[f]]),
          ),
        },
        svg: n.svg,
      };
    }

    const instance = !isVariantRoot ? instanceOf(n, k.startsWith("screen:") ? undefined : k.split("/")[0]) : undefined;
    if (instance) {
      // The size it has here, as rendered: a placed component hugging its own content took the main
      // component's size instead (a chat bubble whose text wraps differently, a wider button label). Where
      // it fills, its parent sizes it (settleSizing fixed what a hugging parent can't give).
      const fills = (a: "w" | "h") => n.sizing[a] === "fill" && !!parentLayout;
      const sized = {
        ...(parentLayout
          ? { layoutSizingHorizontal: fills("w") ? "FILL" : "FIXED", layoutSizingVertical: fills("h") ? "FILL" : "FIXED" }
          : {}),
        ...(fills("w") ? {} : { width: n.width }),
        ...(fills("h") ? {} : { height: n.height }),
      };
      // Out of the flow like any layer (an overlay that is a component).
      const placed = Object.fromEntries(
        ["rotation", "layoutPositioning", "x", "y"].filter((f) => props[f] !== undefined).map((f) => [f, props[f]]),
      );
      return { k, type: "INSTANCE", name: n.name, props: { ...placed, ...sized }, instance };
    }

    // Frame / component with auto-layout. A frame read without one (a box drawn by CSS's ::after) is a plain
    // column with no padding: one odd layer mustn't stop the whole sync (0.2.5 crashed on six pages).
    const zero = { value: 0 };
    const l: NonNullable<IRNode["layout"]> = n.layout ?? {
      direction: "VERTICAL",
      gap: zero,
      padding: [zero, zero, zero, zero],
      align: "MIN",
      justify: "MIN",
    };
    const hugW0 = !fixedW && n.sizing.w !== "fill";
    props.layoutMode = l.direction;
    [props.paddingTop, props.paddingRight, props.paddingBottom, props.paddingLeft] = l.padding.map((p) => p.value);
    if (l.direction === "GRID") {
      props.gridColumnCount = l.columns;
      // Column proportions as rendered (1fr 2fr); a grid sized by its content can't have flexible tracks.
      // Tracks narrower than the grid (repeat(2, 56px) in a 277px card) keep their width; equal flexible
      // columns would spread the cells across it.
      const inner = n.width - l.padding[1].value - l.padding[3].value;
      const fixedTracks = !!l.columnSizes && l.columnSizes.reduce((a, b) => a + b, 0) + l.gap.value * (l.columns! - 1) < inner - 1;
      if (l.columnSizes && l.columnSizes.length === l.columns && (fixedTracks || new Set(l.columnSizes).size > 1))
        props.gridColumnSizes = l.columnSizes.map((w) =>
          hugW0 || fixedTracks ? { type: "FIXED", value: w } : { type: "FLEX", value: Math.round(w) },
        );
      props.gridRowCount = l.rows;
      props.gridColumnGap = l.gap.value;
      props.gridRowGap = l.rowGap?.value ?? l.gap.value;
      const cg = v(l.gap);
      if (cg) bind.gridColumnGap = cg;
      const rg = v(l.rowGap);
      if (rg) bind.gridRowGap = rg;
    } else {
      props.itemSpacing = l.gap.value;
      if (l.wrap) {
        props.layoutWrap = "WRAP";
        props.counterAxisSpacing = l.rowGap?.value ?? l.gap.value;
        const rg = v(l.rowGap);
        if (rg) bind.counterAxisSpacing = rg;
      }
      props.primaryAxisAlignItems = l.justify;
      props.counterAxisAlignItems = l.align === "STRETCH" ? "MIN" : l.align === "BASELINE" && l.direction === "VERTICAL" ? "MIN" : l.align;
    }
    const hugW = !fixedW && n.sizing.w !== "fill";
    const hugH = !fixedH;
    if (l.direction !== "GRID") {
      props.primaryAxisSizingMode = (l.direction === "HORIZONTAL" ? hugW : hugH) ? "AUTO" : "FIXED";
      props.counterAxisSizingMode = (l.direction === "HORIZONTAL" ? hugH : hugW) ? "AUTO" : "FIXED";
    }
    // A gradient paints over the background colour (Figma: the last fill is on top).
    props.fills = [
      ...(n.fill ? [n.fill.value] : []),
      ...(n.gradient
        ? [`gradient:${JSON.stringify({ angle: n.gradient.angle, stops: n.gradient.stops.map((x) => [x.color.value, x.position]) })}`]
        : []),
    ];
    if (n.stroke) {
      props.strokes = [n.stroke.color.value];
      if (n.stroke.sides)
        [props.strokeTopWeight, props.strokeRightWeight, props.strokeBottomWeight, props.strokeLeftWeight] = n.stroke.sides;
      else props.strokeWeight = n.stroke.width;
      props.strokeAlign = "INSIDE";
      if (n.stroke.dash) props.dashPattern = n.stroke.dash;
    } else props.strokes = [];
    // CSS borders are part of the box (border-box); Figma strokes only take layout space with this flag.
    props.strokesIncludedInLayout = !!n.stroke;
    props.cornerRadius = n.radius?.value ?? 0;
    props.opacity = n.opacity ?? 1;
    props.clipsContent = !!n.clip;
    // Shadows → effects (always written, so a shadow removed in code is removed in Live).
    props.effects = parseBoxShadow(n.shadow);
    // Figma draws a shadow's spread (a ring: 0 0 0 3px) only on a frame that clips its content; nothing
    // sticks out of a laid-out frame without absolute children, so clipping changes nothing else.
    if ((props.effects as { spread: number }[]).some((e) => e.spread > 0) && !(n.children ?? []).some((c) => c.absolute))
      props.clipsContent = true;
    const gap = l.direction === "GRID" ? undefined : v(l.gap);
    if (gap) bind.itemSpacing = gap;
    (["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const).forEach((f, i) => {
      const t = v(l.padding[i]);
      if (t) bind[f] = t;
    });
    const r = v(n.radius);
    if (r) for (const f of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]) bind[f] = r;
    const fill = v(n.fill);
    if (fill) paintBind.fills = fill;
    const stroke = n.stroke && v(n.stroke.color);
    if (stroke) paintBind.strokes = stroke;

    // Children keys: parent key + layer name, with an index suffix only when names repeat.
    const seen = new Map<string, number>();
    const children = (n.children ?? []).map((c) => {
      const i = seen.get(c.name) ?? 0;
      seen.set(c.name, i + 1);
      return node(c, `${k}/${c.name}${i ? `#${i}` : ""}`, l, false);
    });
    return {
      k,
      type: isVariantRoot ? rootType : "FRAME",
      name: n.name,
      props,
      ...(Object.keys(bind).length ? { bind } : {}),
      ...(Object.keys(paintBind).length ? { paintBind } : {}),
      ...(children.length ? { children } : {}),
    };
  };

  const sets = () =>
    Object.entries(registry.components).map(([key, c]) => {
      const variants = Object.entries(c.stories)
        .map(([story, vprops]) => {
          const ir = irs.get(story);
          if (!ir) throw new Error(`no IR for story ${story}`);
          const name = variantName(vprops);
          return { ...node(settleSizing(ir.root), `${key}/${name}`, null, true), name };
        })
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const examples = Object.entries(c.examples ?? {}).flatMap(([story, variantStory]) => {
        const ir = irs.get(story);
        const vprops = c.stories[variantStory];
        return ir && vprops ? [node(settleSizing(ir.root), `${key}/${variantName(vprops)}`, null, true)] : [];
      });
      markDataText(variants, examples);
      return {
        k: key,
        type: "COMPONENT_SET" as const,
        name: key,
        props: {
          layoutMode: "HORIZONTAL",
          layoutWrap: "WRAP",
          itemSpacing: 24,
          counterAxisSpacing: 24,
          paddingTop: 24,
          paddingRight: 24,
          paddingBottom: 24,
          paddingLeft: 24,
          primaryAxisSizingMode: "FIXED",
          counterAxisSizingMode: "AUTO",
          // Wide variants (a full-width header) fit inside the set instead of spilling past its border.
          width: Math.max(1000, ...variants.map((v) => Math.ceil(v.measured?.w ?? 0) + 48)),
        },
        children: variants,
      };
    });
  /** The component placed at this layer of a page, if one is. */
  const placed = (n: IRNode): string | undefined => {
    const i = instanceOf(n);
    return i ? i.mainK.split("/")[0] : undefined;
  };
  return { node, sets, placed };
}

/**
 * Every placed component in `spec` gets `inlined`: its main component's layers (from `mains`, by variant
 * key), re-keyed under the instance and with the instance's overrides applied (texts, fills, spacing) and
 * its own size and place. Nested placed components are inlined too.
 */
export function inlineInstances(spec: SpecNode, mains: Map<string, SpecNode>, depth = 0): SpecNode {
  const kids = spec.children ? { children: spec.children.map((c) => inlineInstances(c, mains, depth)) } : {};
  if (spec.type !== "INSTANCE" || !spec.instance || depth > 8) return { ...spec, ...kids };
  const main = mains.get(spec.instance.mainK);
  if (!main) return spec;
  const rekey = (n: SpecNode, k: string): SpecNode => ({
    ...n,
    k,
    ...(n.children ? { children: n.children.map((c) => rekey(c, k + c.k.slice(n.k.length))) } : {}),
  });
  const frame = rekey(JSON.parse(JSON.stringify(main)) as SpecNode, spec.k);
  // Where the main component's layers are on this page: moved to the instance's place.
  const dx = (spec.measured?.x ?? 0) - (main.measured?.x ?? 0);
  const dy = (spec.measured?.y ?? 0) - (main.measured?.y ?? 0);
  const shift = (n: SpecNode) => {
    if (n.measured?.x !== undefined && n.measured.y !== undefined)
      n.measured = { ...n.measured, x: n.measured.x + dx, y: n.measured.y + dy };
    for (const c of n.children ?? []) shift(c);
  };
  if (spec.measured?.x !== undefined) shift(frame);
  frame.type = "FRAME";
  frame.name = spec.name;
  // Its size and place in the page, not the main component's.
  for (const f of ["layoutSizingHorizontal", "layoutSizingVertical", "width", "height", "layoutPositioning", "x", "y"])
    if (spec.props[f] !== undefined) frame.props[f] = spec.props[f];
  if (spec.props.layoutSizingHorizontal === "FILL") delete frame.props.width;
  if (spec.props.layoutSizingVertical === "FILL") delete frame.props.height;
  if (spec.measured) frame.measured = spec.measured;
  // The overrides, found as the plugin finds them: by name, then by position.
  const at = (o: InstanceOverride): SpecNode | undefined =>
    o.path.reduce<SpecNode | undefined>(
      (n, seg, d) => n?.children?.find((c) => c.k === `${n.k}/${seg}`) ?? (o.at?.[d] !== undefined ? n?.children?.[o.at[d]!] : undefined),
      frame,
    );
  for (const o of spec.instance.overrides) {
    const t = at(o);
    if (!t) continue;
    if (o.characters !== undefined && t.type === "TEXT") t.props.characters = o.characters;
    if (o.fill !== undefined) {
      t.props.fills = [o.fill];
      t.paintBind = { ...(t.paintBind ?? {}) };
      if (o.fillToken) t.paintBind.fills = o.fillToken;
      else delete t.paintBind.fills;
    }
    for (const [f, v] of Object.entries(o.layout ?? {})) {
      t.props[f] = v;
      if (t.bind) delete t.bind[f];
    }
  }
  return { ...spec, inlined: inlineInstances(frame, mains, depth + 1) };
}
