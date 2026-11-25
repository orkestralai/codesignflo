// How a story asks to be rendered: its size (Storybook's viewport, or `parameters.codesignflo.size`), whether
// to grow the window until nothing scrolls (`fullHeight`), and the date its clock shows (`date`). Parameters set
// in .storybook/preview apply to every story, as in Storybook.

/** The parts of a story CoDesignFlo reads, as Storybook's preview hands them out. */
export type RawStoryOptions = {
  parameters?: { viewport?: unknown; codesignflo?: unknown };
  /** viewportRotated: Storybook 8's separate rotation flag. */
  globals?: { viewport?: unknown; viewportRotated?: unknown };
};

export type StoryRenderOptions = {
  /** The window's size, when the story says (else the default, or the designer's frame). */
  size?: { w: number; h: number };
  /** Grow the window's height until no scrolling panel hides content, before reading the layout. */
  fullHeight?: boolean;
  /** The clock's time (default: DEFAULT_DATE), so stories with dates draw the same on every run. */
  date?: Date;
};

/** The fixed clock when a story doesn't set one. */
export const DEFAULT_DATE = new Date("2026-01-01T12:00:00Z");

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** "1728px" or 1728 → 1728; anything else (a percentage, "auto") → undefined. */
function px(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*(px)?\s*$/.test(v) ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The viewport a story picks, in either of Storybook's shapes: 8 (`viewport.viewports` + `defaultViewport`)
 * or 9 and later (`viewport.options` + `globals.viewport` = name or { value, isRotated }).
 */
function viewportSize(
  viewport: unknown,
  globals: unknown,
  projectGlobals: unknown,
  rotated8?: unknown,
): { w: number; h: number } | undefined {
  const v = obj(viewport);
  if (!v || v.disable === true) return undefined;
  const list = obj(v.options) ?? obj(v.viewports);
  const pick = (g: unknown) => {
    const p = typeof g === "string" ? { value: g } : obj(g);
    // Storybook 8 says "reset" (or nothing) when no viewport is chosen: not a name in the list.
    return typeof p?.value === "string" && list?.[p.value] ? { name: p.value, rotated: p.isRotated === true } : undefined;
  };
  const picked = pick(globals) ?? pick(projectGlobals);
  const name = picked?.name ?? (typeof v.defaultViewport === "string" ? v.defaultViewport : undefined);
  if (!name) return undefined;
  const styles = obj(obj(list?.[name])?.styles);
  const w = px(styles?.width);
  const h = px(styles?.height);
  if (!w || !h) return undefined;
  const rotated = picked?.rotated === true || rotated8 === true || v.defaultOrientation === "landscape";
  return rotated ? { w: h, h: w } : { w, h };
}

/** A story's render options. `projectGlobals` is the preview's initialGlobals (Storybook 9: the default viewport). */
export function renderOptions(raw: RawStoryOptions, projectGlobals?: { viewport?: unknown }): StoryRenderOptions {
  const own = obj(raw.parameters?.codesignflo) ?? {};
  const out: StoryRenderOptions = {};
  const size = obj(own.size);
  const w = px(size?.width ?? size?.w);
  const h = px(size?.height ?? size?.h);
  const chosen =
    w && h
      ? { w, h }
      : viewportSize(raw.parameters?.viewport, raw.globals?.viewport, projectGlobals?.viewport, raw.globals?.viewportRotated);
  if (chosen) out.size = chosen;
  if (own.fullHeight === true) out.fullHeight = true;
  if (typeof own.date === "string" || typeof own.date === "number") {
    const d = new Date(own.date);
    if (Number.isNaN(d.getTime()))
      throw new Error(`parameters.codesignflo.date isn't a date: ${String(own.date)} (e.g. "2026-11-10" or "2026-11-10T09:30:00Z")`);
    out.date = d;
  }
  return out;
}
