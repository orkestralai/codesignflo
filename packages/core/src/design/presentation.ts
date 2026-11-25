// Mockup framing is not app UI: designers often draw a page inside a browser window (a title bar with the
// three traffic lights). Built as app code, it ended up in every page of the app and of Live.

type Layer = { name?: string; type?: string; width?: number; height?: number; y?: number; children?: Layer[] };

/** A browser window's title bar: full width at the top, at most 60 tall, three equal round lights ≤ 20px. */
function windowBar(l: Layer, rootWidth: number): boolean {
  const w = l.width ?? 0;
  const h = l.height ?? 0;
  if (w < rootWidth * 0.9 || h <= 0 || h > 60 || (l.y ?? 0) > 1) return false;
  const lights = (l.children ?? []).filter((c) => (c.width ?? 99) <= 20 && Math.abs((c.width ?? 0) - (c.height ?? 0)) < 1);
  return lights.length === 3 && (l.children ?? []).length <= 4 && new Set(lights.map((c) => Math.round(c.width ?? 0))).size === 1;
}

/** A component that is itself a browser window's title bar (built from a design's framing). */
export const isWindowBar = (l: Layer) => windowBar({ ...l, y: 0 }, l.width ?? 0);

/** Layers in the first two levels of a page that only frame the screen (a browser window bar). */
export function presentationLayers<T extends Layer>(root: T): T[] {
  const found: T[] = [];
  const width = root.width ?? 0;
  for (const c of (root.children ?? []) as T[]) {
    if (windowBar(c, width)) found.push(c);
    else for (const g of (c.children ?? []) as T[]) if (windowBar(g, width)) found.push(g);
  }
  return found;
}

/** The design with its framing layers marked, for the developer: `presentation` says what it is. */
export function markPresentation<T extends Layer>(spec: T): T {
  const marked = new Set<Layer>(presentationLayers(spec));
  if (!marked.size) return spec;
  const walk = (l: Layer): Layer => ({
    ...l,
    ...(marked.has(l) ? { presentation: "the browser window the design is framed in: not app UI, don't build it" } : {}),
    ...(l.children ? { children: l.children.map(walk) } : {}),
  });
  return walk(spec) as T;
}
