// Snapshots: the vendored figwright serializer plus what CoDesignFlo needs on top (keys, component
// property definitions, variant properties, axis sizing modes, overrides, description, corner smoothing),
// and lookup tables that let the canonicalizer replace file-local ids with names. Ported from S2/S3.
import { codeProps, NODE, NS, type PropMap } from "@codesignflo/core";
import { loadLinks, tokenLinks } from "./designsystem.js";
import { serializeFlat } from "./vendor/figwright/serializer.js";

/** Variant (main component) id → the code component its Library component is linked to (Design System). */
let linkedMains = new Map<string, { k: string; map: PropMap; name: string; props: Record<string, string> }>();
let linkedAt = 0;

export type RawNode = Record<string, unknown> & { children?: RawNode[] };
export type Snapshot = { tree: RawNode; variables: Record<string, string>; styles: Record<string, string> };

async function serialize(node: SceneNode): Promise<RawNode> {
  const out = (await serializeFlat(node)) as unknown as RawNode;
  const k = node.getSharedPluginData(NS, NODE.k);
  if (k) {
    const src = node.getSharedPluginData(NS, NODE.src);
    const pin = node.getSharedPluginData(NS, NODE.pin);
    out.ds = { k, origId: node.getSharedPluginData(NS, NODE.origId), ...(src ? { src } : {}), ...(pin ? { pin } : {}) };
  }
  if (node.type === "COMPONENT_SET" || (node.type === "COMPONENT" && node.parent?.type !== "COMPONENT_SET")) {
    // A set Figma flags as broken (e.g. a version with an empty value) throws here: read what can be read,
    // so the update that repairs it can run.
    try {
      out.componentPropertyDefinitions = JSON.parse(JSON.stringify(node.componentPropertyDefinitions));
    } catch {
      out.componentPropertyDefinitions = {};
    }
  }
  if (node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET") {
    try {
      out.variantProperties = { ...node.variantProperties };
    } catch {
      out.variantProperties = {}; // in a set Figma flags as broken
    }
  }
  if ((node.type === "COMPONENT" || node.type === "COMPONENT_SET") && node.description) out.description = node.description;
  // Hug vs fixed per axis of an auto-layout frame (figwright reports layoutSizing* only relative to the parent).
  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    out.primaryAxisSizingMode = node.primaryAxisSizingMode;
    out.counterAxisSizingMode = node.counterAxisSizingMode;
  }
  if ("cornerSmoothing" in node && typeof node.cornerSmoothing === "number" && node.cornerSmoothing > 0)
    out.cornerSmoothing = node.cornerSmoothing;
  if (node.type === "INSTANCE") {
    out.overrides = node.overrides.map((o) => ({ id: o.id, fields: [...o.overriddenFields].sort() }));
    // A design-system component: which code component it stands for, with the code's props (instructions
    // say "use <Button variant=primary>" instead of describing its layers).
    if (linkedMains.size) {
      const main = await node.getMainComponentAsync().catch(() => null);
      const l = main ? linkedMains.get(main.id) : undefined;
      if (l) out.uses = { k: l.k, name: l.name, props: codeProps(l.props, l.map) };
    }
  }
  if ("children" in node) out.children = await Promise.all(node.children.map(serialize));
  return out;
}

/** Collect every string in the tree that matches `test`. */
function collect(tree: unknown, test: (s: string) => boolean, into = new Set<string>()): Set<string> {
  if (typeof tree === "string") {
    if (test(tree)) into.add(tree);
  } else if (Array.isArray(tree)) for (const x of tree) collect(x, test, into);
  else if (tree && typeof tree === "object") for (const x of Object.values(tree)) collect(x, test, into);
  return into;
}

export async function snapshot(node: SceneNode): Promise<Snapshot> {
  // Read once per burst of snapshots (a sync takes one per component and page).
  if (Date.now() - linkedAt > 3000) {
    linkedMains = new Map();
    for (const [k, l] of await loadLinks().catch(() => new Map() as Awaited<ReturnType<typeof loadLinks>>))
      for (const v of l.variants) linkedMains.set(v.node.id, { k, map: l.map, name: l.name, props: v.props });
    linkedAt = Date.now();
  }
  const tree = await serialize(node);
  const variables: Record<string, string> = {};
  // The designer's variables linked to code tokens read as those tokens: diffs and instructions stay in the
  // code's terms whichever of the two a layer binds to.
  const asToken = new Map(Object.entries(tokenLinks()).map(([token, id]) => [id, token]));
  for (const id of [...collect(tree, (s) => s.startsWith("VariableID:"))].sort()) {
    if (asToken.has(id)) {
      variables[id] = `Tokens/${asToken.get(id)}`;
      continue;
    }
    const v = await figma.variables.getVariableByIdAsync(id);
    if (!v) continue;
    const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    variables[id] = `${c?.name ?? "?"}/${v.name}`;
  }
  const styles: Record<string, string> = {};
  for (const id of [...collect(tree, (s) => s.startsWith("S:"))].sort()) {
    const st = await figma.getStyleByIdAsync(id);
    if (st) styles[id] = st.name;
  }
  return { tree, variables, styles };
}
