// Rebase applier: writes delta values (canonical form) onto nodes of a fresh copy, so a proposal's clean
// items can be carried onto the latest Live (S5). Values and variable bindings arrive separately.
type CanonPaint = {
  type: string;
  color?: { r: number; g: number; b: number };
  opacity?: number;
  visible?: boolean;
  boundVariables?: { color?: string };
};
export type Op = { nodeId: string; prop: string; value: unknown; bound?: Record<string, unknown> };

/** "var(Tokens/color/text/primary)" → the variable named color/text/primary in collection Tokens. */
async function variableByRef(ref: string): Promise<Variable> {
  const m = /^var\((.+)\)$/.exec(ref);
  if (!m) throw new Error(`not a variable reference: ${ref}`);
  const [collection, ...rest] = m[1]!.split("/");
  const name = rest.join("/");
  const col = (await figma.variables.getLocalVariableCollectionsAsync()).find((c) => c.name === collection);
  const v = (await figma.variables.getLocalVariablesAsync()).find((x) => x.name === name && x.variableCollectionId === col?.id);
  if (!v) throw new Error(`variable ${m[1]} not found`);
  return v;
}
const firstRef = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" ? x : null;
};

type Writable = {
  fills: Paint[];
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  cornerRadius: number;
  itemSpacing: number;
  fontName: FontName | PluginAPI["mixed"];
  characters: string;
  name: string;
  setBoundVariable: (field: string, v: Variable | null) => void;
};

export async function applyOps(p: { ops: Op[] }) {
  const results: { ok: boolean; error?: string }[] = [];
  for (const op of p.ops) {
    try {
      const node = (await figma.getNodeByIdAsync(op.nodeId)) as SceneNode | null;
      if (!node) throw new Error(`node ${op.nodeId} not found`);
      const n = node as unknown as Writable;
      switch (op.prop) {
        case "strokes":
        case "fills": {
          const paints: Paint[] = [];
          for (const cp of op.value as CanonPaint[]) {
            if (cp.type !== "SOLID" || !cp.color) throw new Error(`unsupported paint ${cp.type}`);
            let paint: SolidPaint = { type: "SOLID", color: cp.color, opacity: cp.opacity ?? 1, visible: cp.visible ?? true };
            if (cp.boundVariables?.color)
              paint = figma.variables.setBoundVariableForPaint(paint, "color", await variableByRef(cp.boundVariables.color));
            paints.push(paint);
          }
          (n as unknown as Record<string, Paint[]>)[op.prop] = paints;
          break;
        }
        case "padding": {
          [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft] = op.value as [number, number, number, number];
          break;
        }
        case "cornerRadius":
          if (typeof op.value === "number") n.cornerRadius = op.value;
          break;
        case "layout.itemSpacing":
          n.itemSpacing = op.value as number;
          break;
        case "characters": {
          // Mixed styles: fontName is figma.mixed, so load every font in the text.
          const t = n as unknown as TextNode;
          const fonts: FontName[] = t.characters.length
            ? t.getRangeAllFontNames(0, t.characters.length)
            : t.fontName === figma.mixed
              ? []
              : [t.fontName];
          await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
          n.characters = op.value as string;
          break;
        }
        case "fontName":
          await figma.loadFontAsync(op.value as FontName);
          n.fontName = op.value as FontName;
          break;
        case "name":
          n.name = op.value as string;
          break;
        case "size": {
          // { width, height, layoutSizingHorizontal, … }: sizing modes first, then the size.
          const v = op.value as Record<string, unknown>;
          const raw = node as unknown as Record<string, unknown>;
          for (const [k, x] of Object.entries(v)) if (k !== "width" && k !== "height" && k in raw) raw[k] = x;
          if (typeof v.width === "number" || typeof v.height === "number")
            (node as FrameNode).resize((v.width as number) ?? node.width, (v.height as number) ?? node.height);
          break;
        }
        default: {
          // Auto-layout settings ("layout.primaryAxisAlignItems") and plain properties (opacity, fontSize…).
          const raw = node as unknown as Record<string, unknown>;
          const key = op.prop.startsWith("layout.") ? (op.prop === "layout.mode" ? "layoutMode" : op.prop.slice(7)) : op.prop;
          if (!(key in raw)) throw new Error(`can't write ${op.prop}`);
          // Any write to a text layer needs its font loaded (alignment, case, size…).
          if (node.type === "TEXT" && node.fontName !== figma.mixed) await figma.loadFontAsync(node.fontName);
          raw[key] = op.value;
        }
      }
      // Bindings last: binding sets the value too, and an explicit null unbinds.
      for (const [field, ref] of Object.entries(op.bound ?? {})) {
        if (field === "fills" || field === "strokes") continue; // bound on the paints above
        const r = firstRef(ref);
        n.setBoundVariable(field, r ? await variableByRef(r) : null);
      }
      results.push({ ok: true });
    } catch (e) {
      results.push({ ok: false, error: String(e) });
    }
  }
  return { results };
}
