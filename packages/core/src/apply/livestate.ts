// Where Live stands, in one line, for the CLI's status and the hosted MCP's: the newest Live update and what
// the plugin is doing with it — waiting for the file to be opened, about to take it, applying it (how far),
// stalled, or failed — and which commit Live shows meanwhile.

export type LiveRow = {
  commit: string;
  status: string;
  created_at: string;
  taken_at?: string | null;
  /** How far the plugin is; `background`: Figma's window can't be seen (Figma and macOS slow plugins then). */
  progress?: { done: number; total: number; item?: string; background?: boolean } | null;
  log?: string | null;
  /** The CLI version that made the update (saved with it since 0.2.4). */
  cli?: string | null;
};

/**
 * The plugin saves its progress while it works (at least every 20 s since plugin 2026-11-13, also before the
 * first page and inside a long one); this long without it, it has stopped.
 */
export const STALLED_MS = 2 * 60_000;
/** After this long without a sign from the plugin, any open plugin takes the update over (take_update). */
export const RETAKE_MS = 10 * 60_000;

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const short = (c: string) => c.slice(0, 7);
const by = (r: LiveRow | null) => (r?.cli ? ` (CLI ${r.cli})` : "");

/**
 * @param newest the newest Live update that isn't superseded (any status)
 * @param applied the newest applied one (what Live shows)
 * @param pluginSeenAt when a plugin last checked in for this project
 */
export function liveStateLine(
  branch: string,
  newest: LiveRow | null,
  applied: LiveRow | null,
  pluginSeenAt: string | null,
  now = Date.now(),
): string {
  if (!newest) return `Live: nothing uploaded from ${branch} yet — sync on ${branch}`;
  const shows = applied ? `${branch} @${short(applied.commit)}${by(applied)}` : "nothing applied yet";
  if (newest.status === "applied") return `Live: ${branch} @${short(newest.commit)}${by(newest)}`;
  const which = `the update @${short(newest.commit)}${by(newest)} (uploaded ${ago(now - Date.parse(newest.created_at))})`;
  if (newest.status === "pending") {
    const open = !!pluginSeenAt && now - Date.parse(pluginSeenAt) < 60_000;
    return `Live: ${shows}; ${which} ${open ? "is about to be applied: the plugin is open and takes it within a minute" : "waits for the Figma file to be opened with the CoDesignFlo plugin"}`;
  }
  if (newest.status === "applying") {
    const p = newest.progress;
    const howFar = p ? `${p.done} of ${p.total} components and pages` : "starting";
    const quiet = newest.taken_at ? now - Date.parse(newest.taken_at) : 0;
    const slow = p?.background ? " — Figma is in the background, which slows the plugin down: bring the Figma window to the front" : "";
    if (quiet < STALLED_MS) return `Live: ${shows}; ${which} is being applied in Figma: ${howFar}${p?.item ? ` (${p.item})` : ""}${slow}`;
    const retake = RETAKE_MS - quiet;
    // Not "reopen the plugin" while it may still be working: closing it stops the update halfway, and it
    // starts over. Only once it's surely gone (another plugin may take it over) is reopening the way on.
    return quiet < RETAKE_MS
      ? `Live: ${shows}; applying ${which} has had no sign from the plugin for ${Math.round(quiet / 60_000)} min, at ${howFar}${slow || " — if Figma is open, bring its window to the front and wait (closing the plugin would start the update over)"}; if Figma was closed, the update starts over ${retake > 0 ? `in ${Math.ceil(retake / 60_000)} min` : "soon"} when the plugin is open`
      : `Live: ${shows}; applying ${which} stopped at ${howFar}: no sign from the plugin for ${Math.round(quiet / 60_000)} min — open the CoDesignFlo plugin in the Figma file and it starts the update over`;
  }
  if (newest.status === "failed") {
    const lines = (newest.log ?? "").split("\n").filter(Boolean);
    const why = lines.reverse().find((l) => l.startsWith("couldn't")) ?? lines[0] ?? "no reason recorded";
    return `Live: ${shows}; applying ${which} failed in Figma: ${why} — sync again to retry`;
  }
  return `Live: ${shows}`;
}
