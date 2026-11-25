// Ledger events. Code-side events are written by the CLI (git); design-side events are written by the
// plugin (Figma file) and mirrored into git by sync. Each fact is written where it originates (brief §5).
// zod/mini: the same schemas at a fraction of the size (the plugin bundles them).
import * as z from "zod/mini";

const base = {
  /** Content-derived id, so re-mirroring an event is a no-op. */
  id: z.string(),
  /** ISO timestamp. */
  at: z.string(),
  /** Who caused it: a user name, "ci", or "sync". */
  by: z.string(),
  component: z.string(),
};

export const EventSchema = z.discriminatedUnion("kind", [
  // code side
  z.object({ ...base, kind: z.literal("generated"), gen: z.string(), commit: z.string(), fingerprint: z.string() }),
  z.object({ ...base, kind: z.literal("registered"), reviewed: z.boolean() }),
  z.object({
    ...base,
    kind: z.literal("delivered"),
    claim: z.string(),
    mode: z.enum(["track", "patch", "pr", "ticket"]),
    ref: z.optional(z.string()),
  }),
  z.object({ ...base, kind: z.literal("sent_back"), claim: z.string(), question: z.string() }),
  /**
   * The developer reviewed what the designer sent, before building it: approved (with the plan), questions
   * for the designer, later, or skipped (with why). Doesn't move the proposal; a new "ready" clears it.
   */
  z.object({
    ...base,
    kind: z.literal("dev_reviewed"),
    claim: z.string(),
    decision: z.enum(["approved", "questions", "later", "skipped"]),
    plan: z.optional(z.string()),
    question: z.optional(z.string()),
  }),
  /**
   * A developer is building what the designer sent (so another developer doesn't start on it too, and the
   * designer sees who's on it); stopped_building hands it back. Doesn't move the proposal.
   */
  z.object({ ...base, kind: z.literal("building"), claim: z.string() }),
  z.object({ ...base, kind: z.literal("stopped_building"), claim: z.string() }),
  /** A clash between the designer's copy and code changes made meanwhile, settled by the developer (M6). */
  z.object({ ...base, kind: z.literal("resolved"), claim: z.string(), take: z.enum(["design", "code"]), reason: z.optional(z.string()) }),
  z.object({
    ...base,
    kind: z.literal("closed"),
    claim: z.string(),
    commit: z.string(),
    items: z.array(z.string()),
    /** Closed by the designer: the code's version accepted as it is, or the rest kept as design in Live. */
    how: z.optional(z.enum(["accepted", "kept"])),
  }),
  z.object({ ...base, kind: z.literal("proposal_changed_after_ready"), claim: z.string() }),
  /** The code no longer has this component or page: Live's copy moved to Archive (the designer decides). */
  z.object({ ...base, kind: z.literal("removed_in_code"), commit: z.string() }),
  // design side
  z.object({ ...base, kind: z.literal("claimed"), claim: z.string(), baselineGen: z.string() }),
  z.object({ ...base, kind: z.literal("unclaimed"), claim: z.string() }),
  /** "Keep editing" after Ready for dev: back to In design at once (not only at the next sync; M6). */
  z.object({ ...base, kind: z.literal("reopened"), claim: z.string() }),
  z.object({ ...base, kind: z.literal("ready"), claim: z.string(), note: z.string().check(z.minLength(1)), readyHash: z.string() }),
  z.object({ ...base, kind: z.literal("seen") }),
  z.object({ ...base, kind: z.literal("accepted") }),
  z.object({ ...base, kind: z.literal("ignored") }),
  /**
   * Bringing existing designs in: how the designer's design compares with the code for this component, and
   * what they decided (design: they'll send it as a proposal; code: the code's version stands; later).
   */
  z.object({
    ...base,
    kind: z.literal("compared"),
    result: z.enum(["matches", "differs", "design_only"]),
    differences: z.optional(z.number()),
    decision: z.optional(z.enum(["design", "code", "later"])),
  }),
  /** Built in code, never seen by the designer: back to "New in code" for them to review. */
  z.object({ ...base, kind: z.literal("review_requested") }),
  /** Kept as design in Live: these properties (or whole layers, "*") stay the designer's, whatever the code does. */
  z.object({
    ...base,
    kind: z.literal("kept"),
    claim: z.string(),
    pins: z.array(z.object({ key: z.string(), props: z.array(z.string()) })),
  }),
  /** A kept property (or layer) goes back to following the code. */
  z.object({ ...base, kind: z.literal("unkept"), key: z.string(), props: z.array(z.string()) }),
  z.object({ ...base, kind: z.literal("designed_new"), claim: z.string(), note: z.string().check(z.minLength(1)) }),
  /** The designer answers the developer's review questions (the proposal stays as it is). */
  z.object({ ...base, kind: z.literal("review_answered"), claim: z.string(), answer: z.string().check(z.minLength(1)) }),
]);

export type LedgerEvent = z.infer<typeof EventSchema>;
export type EventKind = LedgerEvent["kind"];

/**
 * An event from the history, or null when it can't be read — a kind added by a newer version (an older
 * MCP server or CLI then carries on without it instead of failing).
 */
export function readEvent(raw: unknown): LedgerEvent | null {
  const r = EventSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Events in a stable order: by time, then id (two sources may write at the same instant). */
export const ordered = (events: LedgerEvent[]) =>
  [...events].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? -1 : 1));
