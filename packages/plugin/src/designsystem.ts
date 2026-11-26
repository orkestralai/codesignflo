// The Design System page (docs/DESIGN-SYSTEM.md): the designer's components (Library), and a copy of each
// code component the Library has no counterpart for yet (From code), waiting for the designer to accept it,
// match it to one of theirs, or ignore it. A link is the code component's key, stored on the Library
// component (on its instance, for a team library's component: the component itself is read-only here). Live
// pages draw linked components with the designer's (executor), and each pair lists where it differs.

import {
  compareComponents,
  LAYOUT,
  mapProps,
  NODE,
  NS,
  type PropMap,
  type Props,
  parseVariant,
  suggestLinks,
  suggestTokens,
  type VariantLook,
} from "@codesignflo/core";
import { LABEL, sectionIfAny, sections, stack } from "./facts.js";
import { editable } from "./guard.js";

export const DS = {
  /** On a Library component: { k, map, at } — the code component it is linked to. */
  link: "dsLink",
  /** On a From-code copy: the code component it copies, and the generation it was copied from. */
  of: "dsOf",
  gen: "dsGen",
  /** On a Library component: when CoDesignFlo first saw it there (copies drift from a real library). */
  seen: "dsSeen",
  /** On a design-only Library component sent to the developer: the key its code will have. */
  pending: "dsPending",
  /** On a Live page's instance drawn with a Library component. */
  lib: "dsLib",
  /** Root: code keys the designer ignored, suggestions they rejected ("<k>|<id>"), token links. */
  ignored: "dsIgnored",
  rejected: "dsRejected",
  tokens: "dsTokens",
  tokensRejected: "dsTokensRejected",
} as const;

export type Link = { k: string; map: PropMap; at: string };
type Top = ComponentSetNode | ComponentNode;
export type LibItem = { node: SceneNode; top: Top | null; remote: boolean; kind: "set" | "component" | "instance" };

const readJson = <T>(n: BaseNode, key: string, fallback: T): T => {
  try {
    const raw = n.getSharedPluginData(NS, key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (n: BaseNode, key: string, v: unknown) => {
  const raw = v === undefined || v === null ? "" : JSON.stringify(v);
  if (n.getSharedPluginData(NS, key) !== raw) n.setSharedPluginData(NS, key, raw);
};
export const linkOf = (n: BaseNode): Link | null => {
  const l = readJson<Link | null>(n, DS.link, null);
  return l?.k ? l : null;
};
const rootList = (key: string) => new Set(readJson<string[]>(figma.root, key, []));
const saveList = (key: string, s: Set<string>) => writeJson(figma.root, key, [...s].sort());

export const systemPage = () => figma.root.children.find((p) => p.name === LAYOUT.system.page) ?? null;

// ---- what there is -------------------------------------------------------------------------------

/** A component's variant properties and values; {} for a single component (or one Figma flags as broken). */
function propsOf(top: Top | null): Props {
  if (top?.type !== "COMPONENT_SET") return {};
  try {
    const out: Props = {};
    for (const [name, d] of Object.entries(top.componentPropertyDefinitions))
      if (d.type === "VARIANT") out[name.replace(/#.*$/, "")] = [...(d.variantOptions ?? [])];
    return out;
  } catch {
    return {};
  }
}
function variantsOf(top: Top | null): { node: ComponentNode; props: Record<string, string> }[] {
  if (!top) return [];
  if (top.type === "COMPONENT") return [{ node: top, props: {} }];
  return top.children
    .filter((c): c is ComponentNode => c.type === "COMPONENT")
    .map((c) => {
      try {
        return { node: c, props: { ...(c.variantProperties ?? {}) } };
      } catch {
        return { node: c, props: parseVariant(c.name) };
      }
    });
}

/** The code's components: Live › Components' sets, by key. */
async function liveComponents(): Promise<Map<string, ComponentSetNode>> {
  const sec = await sectionIfAny(LAYOUT.live.page, LAYOUT.live.sections.components);
  const out = new Map<string, ComponentSetNode>();
  for (const n of sec?.children ?? []) {
    const k = n.getSharedPluginData(NS, NODE.k);
    if (n.type === "COMPONENT_SET" && k && n.getSharedPluginData(NS, NODE.origId) === n.id) out.set(k, n);
  }
  return out;
}

/**
 * The Library's components: sets and components the file owns, and instances (a team library's components,
 * placed here; the designer's own components' example uses aren't separate entries).
 */
export async function libraryItems(lib: SectionNode): Promise<LibItem[]> {
  const out: LibItem[] = [];
  const own = new Set<string>();
  const nested = (n: BaseNode) => {
    for (let q = n.parent; q && q !== lib; q = q.parent)
      if (q.type === "COMPONENT" || q.type === "COMPONENT_SET" || q.type === "INSTANCE") return true;
    return false;
  };
  for (const n of lib.findAll((x) => (x.type === "COMPONENT_SET" || x.type === "COMPONENT") && !nested(x)) as Top[]) {
    out.push({ node: n, top: n, remote: n.remote, kind: n.type === "COMPONENT_SET" ? "set" : "component" });
    own.add(n.id);
  }
  for (const n of lib.findAll((x) => x.type === "INSTANCE" && !nested(x)) as InstanceNode[]) {
    let main: ComponentNode | null = null;
    try {
      main = await n.getMainComponentAsync();
    } catch {}
    const top: Top | null = main?.parent?.type === "COMPONENT_SET" ? main.parent : main;
    if (top && own.has(top.id)) continue;
    // One entry per component: the first instance of it carries the link.
    if (top && out.some((o) => o.top?.id === top.id)) continue;
    out.push({ node: n, top, remote: !!main?.remote, kind: "instance" });
  }
  return out;
}

const fromCodeCopies = (sec: SectionNode | null) =>
  new Map((sec?.children ?? []).filter((c) => c.getSharedPluginData(NS, DS.of)).map((c) => [c.getSharedPluginData(NS, DS.of), c] as const));

/** Everything CoDesignFlo knows on a node of a copy goes: a From-code copy is nobody's original. */
function strip(n: SceneNode) {
  for (const key of n.getSharedPluginDataKeys(NS)) n.setSharedPluginData(NS, key, "");
  if ("children" in n) for (const c of n.children) strip(c);
}

const genOf = (set: BaseNode) => set.getSharedPluginData(NS, NODE.gen) || set.getSharedPluginData(NS, NODE.specHash);

function linksByKey(items: LibItem[]): Map<string, { item: LibItem; link: Link }> {
  const out = new Map<string, { item: LibItem; link: Link }>();
  for (const item of items) {
    const link = linkOf(item.node);
    if (link && !out.has(link.k)) out.set(link.k, { item, link });
  }
  return out;
}

function setLink(n: SceneNode, k: string, map: PropMap) {
  writeJson(n, DS.link, { k, map, at: new Date().toISOString() } satisfies Link);
  n.setSharedPluginData(NS, DS.of, "");
  n.setSharedPluginData(NS, DS.gen, "");
  n.setSharedPluginData(NS, DS.pending, "");
}

// ---- keeping it in step --------------------------------------------------------------------------

/**
 * After the code's components are built: links made by dragging a From-code copy into Library, design-only
 * components whose code has landed, the From-code copies (new, updated, gone), and the labels beside Live's
 * components. Nothing happens without a Design System page.
 */
export async function refresh(): Promise<{ notes: string[] }> {
  const page = systemPage();
  if (!page) return { notes: [] };
  await page.loadAsync();
  const lib = await sections.systemLibrary();
  const from = await sections.fromCode();
  const live = await liveComponents();
  const ignored = rootList(DS.ignored);
  const notes: string[] = [];
  let items = await libraryItems(lib);
  const now = new Date().toISOString();
  for (const it of items) if (!it.node.getSharedPluginData(NS, DS.seen)) it.node.setSharedPluginData(NS, DS.seen, now);

  // Dragged into Library: accepted (unless its code component is already linked to another one).
  const linked = linksByKey(items);
  for (const it of items) {
    const k = it.node.getSharedPluginData(NS, DS.of);
    if (!k) continue;
    if (linked.has(k)) continue; // the panel asks: replace the link, or keep the current one
    setLink(it.node, k, identity(live.get(k)));
    linked.set(k, { item: it, link: linkOf(it.node)! });
  }
  // A design-only component sent to the developer: linked once its code is in Live.
  for (const it of items) {
    const k = it.node.getSharedPluginData(NS, DS.pending);
    if (!k || linkOf(it.node) || !live.has(k) || linked.has(k)) continue;
    setLink(it.node, k, mapProps(propsOf(live.get(k)!), propsOf(it.top)));
    notes.push(`${k}: now in code — linked to the designer's "${it.node.name}" in their Library`);
  }
  items = await libraryItems(lib);
  const links = linksByKey(items);
  for (const [k, { item }] of links)
    if (!live.has(k)) notes.push(`${k}: no longer in code — the designer's "${item.node.name}" in their Library is still linked to it`);

  // From code: one copy per code component without a counterpart, as the code draws it now.
  const copies = fromCodeCopies(from);
  for (const [k, c] of copies) if (!live.has(k) || links.has(k) || ignored.has(k)) c.remove();
  for (const [k, set] of live) {
    if (links.has(k) || ignored.has(k)) continue;
    const have = copies.get(k);
    if (have && !have.removed && have.getSharedPluginData(NS, DS.gen) === genOf(set)) continue;
    const copy = set.clone();
    strip(copy);
    editable(copy);
    from.appendChild(copy);
    if (have && !have.removed) {
      copy.x = have.x;
      copy.y = have.y;
      have.remove();
    }
    copy.name = readable(k);
    copy.setSharedPluginData(NS, DS.of, k);
    copy.setSharedPluginData(NS, DS.gen, genOf(set));
  }
  stack(from);
  await labels(live, links, fromCodeCopies(from));
  return { notes };
}

/** "components.alert-box" → "AlertBox": a copy's name the designer can keep. */
const readable = (k: string) =>
  (k.split(".").pop() ?? k)
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join("");

/** A copy of the code's component links with the same properties and values. */
function identity(set: ComponentSetNode | undefined): PropMap {
  const p = propsOf(set ?? null);
  return mapProps(p, p);
}

/** "In your Library" / "In From code" beside each Live component, linking to its counterpart. */
async function labels(live: Map<string, ComponentSetNode>, links: Map<string, { item: LibItem }>, copies: Map<string, SceneNode>) {
  const sec = await sections.components();
  await figma.loadFontAsync({ family: "Inter", style: "Medium" }).catch(() => undefined);
  const existing = new Map(
    sec.children
      .filter((c) => c.getSharedPluginData(NS, NODE.role) === LABEL.role)
      .map((c) => [c.getSharedPluginData(NS, LABEL.for), c] as const),
  );
  for (const k of live.keys()) {
    const to = links.get(k)?.item.node ?? copies.get(k);
    let t = existing.get(k) as TextNode | undefined;
    if (!to) {
      t?.remove();
      continue;
    }
    const text = links.has(k) ? `In your Library: ${to.name} →` : "In From code →";
    if (t?.type !== "TEXT") {
      t?.remove();
      t = figma.createText();
      t.fontName = { family: "Inter", style: "Medium" };
      t.fontSize = 14;
      t.fills = [{ type: "SOLID", color: { r: 0.31, g: 0.27, b: 0.9 } }];
      t.setSharedPluginData(NS, NODE.role, LABEL.role);
      t.setSharedPluginData(NS, LABEL.for, k);
      sec.appendChild(t);
    }
    if (t.characters !== text) t.characters = text;
    const want = { type: "NODE" as const, value: to.id };
    const cur = t.hyperlink;
    if (cur === figma.mixed || cur?.type !== "NODE" || cur.value !== to.id) t.hyperlink = want;
    if (!t.locked) t.locked = true;
  }
  stack(sec);
}

// ---- the designer's decisions ----------------------------------------------------------------------

async function sectionsOrThrow() {
  if (!systemPage()) throw new Error("this file has no Design System page yet");
  return { lib: await sections.systemLibrary(), from: await sections.fromCode() };
}

/** Below what's already in the Library: the designer arranges it from there. */
function placeInLibrary(lib: SectionNode, n: SceneNode) {
  const others = lib.children.filter((c) => c !== n);
  const bottom = others.reduce((y, c) => Math.max(y, c.y + c.height), 0);
  lib.appendChild(n);
  n.x = 80;
  n.y = bottom + 80;
  if (lib.height < n.y + n.height + 80) lib.resizeWithoutConstraints(Math.max(lib.width, n.width + 160), n.y + n.height + 80);
}

type Conflict = { conflict: { k: string; linkedTo: string; nodeId: string } };

/** Accept a From-code copy into the Library, linked. A key already linked asks first (replace, or keep it). */
export async function accept(p: { k: string; replace?: boolean }): Promise<{ id: string } | Conflict> {
  const { lib, from } = await sectionsOrThrow();
  const items = await libraryItems(lib);
  const copy = fromCodeCopies(from).get(p.k) ?? items.find((i) => i.node.getSharedPluginData(NS, DS.of) === p.k && !linkOf(i.node))?.node;
  if (!copy) throw new Error(`${p.k} has no copy in From code`);
  const current = linksByKey(items).get(p.k);
  if (current && current.item.node !== copy) {
    if (!p.replace) return { conflict: { k: p.k, linkedTo: current.item.node.name, nodeId: current.item.node.id } };
    writeJson(current.item.node, DS.link, null);
  }
  if (copy.parent !== lib) placeInLibrary(lib, copy);
  setLink(copy, p.k, identity((await liveComponents()).get(p.k)));
  await refresh();
  return { id: copy.id };
}

/** Link a Library component to a code component (a confirmed suggestion, or "match to…"). One to one. */
export async function match(p: { k: string; nodeId: string; replace?: boolean; map?: PropMap }): Promise<{ ok: true } | Conflict> {
  const { lib } = await sectionsOrThrow();
  const items = await libraryItems(lib);
  const item = items.find((i) => i.node.id === p.nodeId);
  if (!item) throw new Error("that component isn't in Design System › Library");
  const current = linksByKey(items).get(p.k);
  if (current && current.item !== item) {
    if (!p.replace) return { conflict: { k: p.k, linkedTo: current.item.node.name, nodeId: current.item.node.id } };
    writeJson(current.item.node, DS.link, null);
  }
  const set = (await liveComponents()).get(p.k);
  setLink(item.node, p.k, p.map ?? mapProps(propsOf(set ?? null), propsOf(item.top)));
  await refresh(); // its From-code copy goes
  return { ok: true };
}

/** The designer corrects how a pair's properties correspond. */
export async function setMap(p: { nodeId: string; map: PropMap }) {
  const n = (await figma.getNodeByIdAsync(p.nodeId)) as SceneNode | null;
  const link = n ? linkOf(n) : null;
  if (!n || !link) throw new Error("that component isn't linked");
  writeJson(n, DS.link, { ...link, map: p.map });
  return { ok: true };
}

/** The link goes; the code component's copy comes back to From code (unless ignored). */
export async function unlink(p: { nodeId: string }) {
  const n = (await figma.getNodeByIdAsync(p.nodeId)) as SceneNode | null;
  if (n) writeJson(n, DS.link, null);
  await refresh();
  return { ok: true };
}

export async function ignore(p: { k: string; on: boolean }) {
  const s = rootList(DS.ignored);
  if (p.on) s.add(p.k);
  else s.delete(p.k);
  saveList(DS.ignored, s);
  await refresh();
  return { ok: true };
}

export function reject(p: { k: string; nodeId: string }) {
  const s = rootList(DS.rejected);
  s.add(`${p.k}|${p.nodeId}`);
  saveList(DS.rejected, s);
  return { ok: true };
}

/** A design-only Library component goes to the developer as a new design; linked by key when it lands. */
export function markPending(nodeId: string, k: string) {
  return figma.getNodeByIdAsync(nodeId).then((n) => {
    if (n) n.setSharedPluginData(NS, DS.pending, k);
  });
}

// ---- setting it up --------------------------------------------------------------------------------

/** What the plugin can tell for the setup's advice (it can't see the account's plan). */
export async function setup() {
  const pages = figma.root.children.length;
  let libraries: number | null = null;
  try {
    libraries = (await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()).length;
  } catch {}
  return { pages, hasPage: !!systemPage(), libraries };
}

/** Creates the Design System page (or adopts one with that name), its sections and the From-code copies. */
export async function create() {
  try {
    // Library first, From code after it (an adopted page of the designer's has neither yet).
    await sections.systemLibrary();
  } catch (e) {
    throw new Error(
      `Figma didn't add a page (${e instanceof Error ? e.message : String(e)}). On Figma's free plan a file has 3 pages, and Live and Proposals take two: remove a page of your own (it can move to Proposals or another file), or use a paid plan.`,
    );
  }
  await sections.fromCode();
  return refresh();
}

// ---- for the panel -------------------------------------------------------------------------------

/** What a variant draws: through wrappers with nothing of their own (Live's story root around the button). */
function content(n: SceneNode): SceneNode {
  let c = n;
  const bare = (x: SceneNode) =>
    "children" in x &&
    x.children.length === 1 &&
    (!("fills" in x) || (Array.isArray(x.fills) && !(x.fills as Paint[]).some((p) => p.visible !== false))) &&
    (!("strokes" in x) || !(x.strokes as Paint[]).length);
  while (bare(c)) c = (c as ChildrenMixin & SceneNode).children[0]!;
  return c;
}

function look(variant: ComponentNode, props: Record<string, string>): VariantLook {
  const c = content(variant) as SceneNode & Partial<MinimalFillsMixin & CornerMixin & ChildrenMixin>;
  const fill = Array.isArray(c.fills) ? (c.fills as Paint[]).find((p) => p.type === "SOLID" && p.visible !== false) : undefined;
  const hex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, "0");
  const text = (c.type === "TEXT" ? c : "findOne" in c && c.findOne ? c.findOne((n) => n.type === "TEXT") : null) as TextNode | null;
  const font = text && text.fontName !== figma.mixed ? text.fontName.family : undefined;
  const solid = (paints: unknown) =>
    Array.isArray(paints) ? (paints as Paint[]).find((p): p is SolidPaint => p.type === "SOLID" && p.visible !== false) : undefined;
  const rgbHex = (p: SolidPaint) => `#${hex(p.color.r)}${hex(p.color.g)}${hex(p.color.b)}`;
  const g = c as SceneNode & Partial<GeometryMixin & BlendMixin & AutoLayoutMixin>;
  const stroke = solid(g.strokes);
  const weight = typeof g.strokeWeight === "number" ? g.strokeWeight : 0;
  const shadow = g.effects?.find((e): e is DropShadowEffect => e.type === "DROP_SHADOW" && e.visible);
  const textFill = text ? solid(text.fills) : undefined;
  const laidOut = g.layoutMode && g.layoutMode !== "NONE";
  return {
    props,
    w: c.width,
    h: c.height,
    ...(typeof c.cornerRadius === "number" ? { radius: c.cornerRadius } : {}),
    ...(fill?.type === "SOLID" ? { fill: `#${hex(fill.color.r)}${hex(fill.color.g)}${hex(fill.color.b)}` } : {}),
    ...(font ? { font } : {}),
    ...(stroke && weight > 0 ? { stroke: { color: rgbHex(stroke), width: weight } } : {}),
    ...(shadow ? { shadow: `${Math.round(shadow.offset.x)} ${Math.round(shadow.offset.y)} ${Math.round(shadow.radius)}` } : {}),
    ...(laidOut
      ? {
          padding: [g.paddingTop ?? 0, g.paddingRight ?? 0, g.paddingBottom ?? 0, g.paddingLeft ?? 0] as [number, number, number, number],
          gap: g.itemSpacing ?? 0,
        }
      : {}),
    ...(textFill ? { textColor: rgbHex(textFill) } : {}),
  };
}

/** Where each linked Library component differs from what the code draws. */
export async function report(): Promise<{ k: string; lines: string[] }[]> {
  if (!systemPage()) return [];
  const lib = await sections.systemLibrary();
  const live = await liveComponents();
  const out: { k: string; lines: string[] }[] = [];
  for (const [k, { item, link }] of linksByKey(await libraryItems(lib))) {
    const set = live.get(k);
    if (!set) continue;
    try {
      const lines = compareComponents(
        variantsOf(set).map((v) => look(v.node, v.props)),
        variantsOf(item.top).map((v) => look(v.node, v.props)),
        link.map,
      );
      if (lines.length) out.push({ k, lines });
    } catch {}
  }
  return out;
}

export type SystemState = {
  page: boolean;
  setup: { pages: number; libraries: number | null };
  library: {
    id: string;
    name: string;
    kind: LibItem["kind"];
    remote: boolean;
    props: Props;
    seen?: string;
    pending?: string;
    link?: { k: string; map: PropMap; gone: boolean; differs: string[]; codeProps: Props };
    copied?: string;
  }[];
  fromCode: { k: string; id: string; inLibrary?: string }[];
  suggestions: { k: string; id: string; name: string; why: string; map: PropMap }[];
  ignored: string[];
  /** Code components (for "match to…"), with their properties. */
  code: { k: string; props: Props; linked: boolean }[];
  tokens: {
    suggestions: { token: string; id: string; name: string; collection: string; why: string }[];
    linked: { token: string; id: string; name: string }[];
  };
};

export async function state(): Promise<SystemState> {
  const s = await setup();
  const live = await liveComponents();
  const empty: SystemState = {
    page: false,
    setup: s,
    library: [],
    fromCode: [],
    suggestions: [],
    ignored: [],
    code: [...live].map(([k, set]) => ({ k, props: propsOf(set), linked: false })),
    tokens: { suggestions: [], linked: [] },
  };
  const page = systemPage();
  if (!page) return empty;
  await page.loadAsync();
  const lib = await sections.systemLibrary();
  const from = await sections.fromCode();
  const items = await libraryItems(lib);
  const links = linksByKey(items);
  const differs = new Map((await report()).map((r) => [r.k, r.lines]));
  const library: SystemState["library"] = items.map((it) => {
    const link = linkOf(it.node);
    const set = link ? live.get(link.k) : undefined;
    const seen = it.node.getSharedPluginData(NS, DS.seen);
    const pending = it.node.getSharedPluginData(NS, DS.pending);
    const copied = it.node.getSharedPluginData(NS, DS.of);
    return {
      id: it.node.id,
      name: it.node.name,
      kind: it.kind,
      remote: it.remote,
      props: propsOf(it.top),
      ...(seen ? { seen } : {}),
      ...(pending ? { pending } : {}),
      ...(copied && !link ? { copied } : {}),
      ...(link
        ? { link: { k: link.k, map: link.map, gone: !set, differs: differs.get(link.k) ?? [], codeProps: propsOf(set ?? null) } }
        : {}),
    };
  });
  const fromCode: SystemState["fromCode"] = [...fromCodeCopies(from)].map(([k, c]) => ({ k, id: c.id }));
  // Dragged into Library while its code component is linked to another: the panel asks.
  for (const it of items) {
    const k = it.node.getSharedPluginData(NS, DS.of);
    if (k && !linkOf(it.node)) fromCode.push({ k, id: it.node.id, inLibrary: links.get(k)?.item.node.name ?? "" });
  }
  const unlinkedCode = [...live].filter(([k]) => !links.has(k) && !rootList(DS.ignored).has(k));
  const unlinkedLib = items.filter((i) => !linkOf(i.node) && !i.node.getSharedPluginData(NS, DS.of));
  const suggestions = suggestLinks(
    unlinkedCode.map(([k, set]) => ({ k, name: set.name, props: propsOf(set) })),
    unlinkedLib.map((i) => ({ id: i.node.id, name: i.node.name, props: propsOf(i.top) })),
    rootList(DS.rejected),
  ).map((x) => ({ k: x.k, id: x.id, name: unlinkedLib.find((i) => i.node.id === x.id)!.node.name, why: x.why, map: x.map }));
  return {
    page: true,
    setup: s,
    library,
    fromCode,
    suggestions,
    ignored: [...rootList(DS.ignored)],
    code: [...live].map(([k, set]) => ({ k, props: propsOf(set), linked: links.has(k) })),
    tokens: await tokenState(),
  };
}

// ---- tokens (step 6) -----------------------------------------------------------------------------

const COLLECTION = "Tokens";

/** Code token → the designer's variable (id, or a team library variable's key once imported). */
export const tokenLinks = () => readJson<Record<string, string>>(figma.root, DS.tokens, {});

async function designerVariables() {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const ours = cols.find((c) => c.name === COLLECTION);
  const names = new Map(cols.map((c) => [c.id, c.name]));
  const vars = (await figma.variables.getLocalVariablesAsync()).filter((v) => v.variableCollectionId !== ours?.id);
  const valueIn = (v: Variable): string | number | undefined => {
    const col = cols.find((c) => c.id === v.variableCollectionId);
    const x = col ? v.valuesByMode[col.defaultModeId] : undefined;
    if (typeof x === "number") return x;
    if (x && typeof x === "object" && "r" in x) {
      const h = (n: number) =>
        Math.round(n * 255)
          .toString(16)
          .padStart(2, "0");
      return `#${h(x.r)}${h(x.g)}${h(x.b)}`;
    }
    return typeof x === "string" ? x : undefined;
  };
  const local = vars.map((v) => ({
    id: v.id,
    name: v.name,
    collection: names.get(v.variableCollectionId) ?? "",
    value: valueIn(v) as string | number | undefined,
    type: v.resolvedType as string,
  }));
  // A team library's variables (enabled for this file): by name only (their values come once imported).
  const library: typeof local = [];
  try {
    for (const c of await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync())
      for (const v of await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key))
        library.push({
          id: `lib:${v.key}`,
          name: v.name,
          collection: `${c.libraryName} › ${c.name}`,
          value: undefined,
          type: v.resolvedType,
        });
  } catch {}
  return [...local, ...library];
}

async function codeTokens() {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const ours = cols.find((c) => c.name === COLLECTION);
  if (!ours) return [];
  const vars = (await figma.variables.getLocalVariablesAsync()).filter((v) => v.variableCollectionId === ours.id);
  return vars.map((v) => {
    const x = v.valuesByMode[ours.defaultModeId];
    const h = (n: number) =>
      Math.round(n * 255)
        .toString(16)
        .padStart(2, "0");
    const value = typeof x === "number" ? x : x && typeof x === "object" && "r" in x ? `#${h(x.r)}${h(x.g)}${h(x.b)}` : String(x);
    return { name: v.name, value, type: v.resolvedType };
  });
}

async function tokenState(): Promise<SystemState["tokens"]> {
  const links = tokenLinks();
  const vars = await designerVariables();
  const code = await codeTokens();
  const byId = new Map(vars.map((v) => [v.id, v]));
  const linked: SystemState["tokens"]["linked"] = [];
  for (const [token, id] of Object.entries(links)) {
    // A team library's variable, imported: not among the file's own.
    const name = byId.get(id)?.name ?? (await figma.variables.getVariableByIdAsync(id).catch(() => null))?.name;
    if (name) linked.push({ token, id, name });
  }
  // Only same-type pairs, and only tokens and variables not linked yet.
  const free = vars.filter((v) => !Object.values(links).includes(v.id));
  const suggestions = suggestTokens(
    code.filter((t) => !links[t.name]),
    free,
    rootList(DS.tokensRejected),
  )
    .filter((s) => code.find((t) => t.name === s.token)?.type === byId.get(s.id)?.type)
    .map((s) => ({ ...s, name: byId.get(s.id)!.name, collection: byId.get(s.id)!.collection }));
  return { suggestions, linked };
}

export async function linkToken(p: { token: string; id: string | null }) {
  const links = tokenLinks();
  // A team library's variable is imported into the file first (layers can only bind to what's in it).
  if (p.id?.startsWith("lib:")) p.id = (await figma.variables.importVariableByKeyAsync(p.id.slice(4))).id;
  if (p.id) links[p.token] = p.id;
  else delete links[p.token];
  writeJson(figma.root, DS.tokens, links);
  return { ok: true };
}

export function rejectToken(p: { token: string; id: string }) {
  const s = rootList(DS.tokensRejected);
  s.add(`${p.token}|${p.id}`);
  saveList(DS.tokensRejected, s);
  return { ok: true };
}

// ---- for building Live pages (executor) ------------------------------------------------------------

export type LibraryLinks = Map<string, { variants: { node: ComponentNode; props: Record<string, string> }[]; map: PropMap; name: string }>;

/** The linked Library components, ready to place: each code key's variants and property mapping. */
export async function loadLinks(): Promise<LibraryLinks> {
  const out: LibraryLinks = new Map();
  const page = systemPage();
  if (!page) return out;
  await page.loadAsync();
  const lib = await sectionIfAny(LAYOUT.system.page, LAYOUT.system.sections.library);
  if (!lib) return out;
  for (const [k, { item, link }] of linksByKey(await libraryItems(lib))) {
    const variants = variantsOf(item.top);
    if (variants.length) out.set(k, { variants, map: link.map, name: item.node.name });
  }
  return out;
}

/** What the links are, so a page is rebuilt when one is made, changed or removed. */
export const linksSignature = (links: LibraryLinks) =>
  [...links]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, l]) => `${k}:${l.variants.map((v) => v.node.id).join(",")}:${JSON.stringify(l.map)}`)
    .join(";");
