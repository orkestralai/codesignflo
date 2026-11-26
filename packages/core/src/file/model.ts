// How CoDesignFlo lives inside a Figma file: shared-plugin-data keys, the page/section layout, and the
// records stored on nodes and on the document root. One model for the plugin (writer) and CLI (reader).
// zod/mini: the same schemas at a fraction of the size (the plugin bundles them).
import * as z from "zod/mini";
import { EventSchema } from "../ledger/events.js";

/** Shared plugin data namespace (readable by any plugin, survives every copy path — S1). */
export const NS = "codesignflo";
/** Files set up before the rename to CoDesignFlo keep their data under this namespace until migrated. */
export const LEGACY_NS = "codesignloop";

/** Keys on nodes. */
export const NODE = {
  /** Sync key: stable identity (component/variant/layer path). */
  k: "k",
  /** Node id at tagging time; a node is the original iff id === origId (S1). */
  origId: "origId",
  /** Generation id on Live component-set roots. */
  gen: "gen",
  /** "live" | "proposal" | "archive" on roots. */
  role: "role",
  /** ClaimRecord JSON on proposal roots. */
  claim: "claim",
  /** "data" on text layers whose content comes from the component's data (props / story args). */
  src: "src",
  /**
   * On Live layers: JSON list of the properties the designer kept as design (diff names: "padding", "fills",
   * "layout.itemSpacing"…), or ["*"] for the whole layer. Updates from code leave them as they are.
   */
  pin: "pin",
  /**
   * On Live roots: a hash of the compiled code this component (or page) was last built from. The same code
   * again → nothing to rewrite (an update then takes seconds, even with Figma in the background).
   */
  specHash: "specHash",
  /** On a Live root moved to Archive because the code no longer has it: the commit that removed it. */
  removedFromCode: "removedFromCode",
  /**
   * On proposal roots: the canonical snapshot of the Live component the copy was made from (chunked as
   * base, base.1, …; 100 kB per entry), so the designer's changes are measured against it (M6).
   */
  base: "base",
  /**
   * On Live roots built on a designer's design: JSON {id, at} of that design (an archived proposal) — a newer
   * one (the designer improved it, the code caught up) becomes the new base.
   */
  anchor: "anchor",
  /** On Live roots built on a design: the compiled code of the last update (chunked like base): the next update writes only what changed. */
  lastSpec: "spec",
} as const;

/** Keys on the document root. Each entry ≤ 100 kB (Figma limit, S0), so the index is one key per component. */
export const ROOT = {
  meta: "meta",
  /** Per component: `idx:<component>` → IndexEntry (written by sync). */
  indexPrefix: "idx:",
  /** Per design-side event: `evt:<id>` → LedgerEvent (written by the plugin, removed after sync mirrors it). */
  eventPrefix: "evt:",
} as const;

/**
 * Starter plan: max 3 pages per file (S0). Layout: Live (sections Components, Pages, Screenshots), Design System (sections Library, From code), Proposals (sections
 * Active, Archive). (A "What's new" page existed until M6: the designer found it useless; the panel row says what changed.)
 */
export const LAYOUT = {
  live: { page: "Live", sections: { components: "Components", screens: "Pages", screenshots: "Screenshots" } },
  /** The designer's own components (Library), and the code's not yet in it (From code): see docs/DESIGN-SYSTEM.md. */
  system: { page: "Design System", sections: { library: "Library", fromCode: "From code" } },
  proposals: { page: "Proposals", sections: { active: "Active", screenshots: "Screenshots", archive: "Archive" } },
} as const;

export const MetaSchema = z.object({
  schema: z.literal(1),
  projectId: z.string(),
  lastSyncAt: z.optional(z.string()),
  lastSyncCommit: z.optional(z.string()),
  /** Minimum plugin version the project's CLI expects (shown to the designer when outdated). */
  minPlugin: z.optional(z.string()),
});
export type Meta = z.infer<typeof MetaSchema>;

export const ClaimRecordSchema = z.object({
  id: z.string(),
  component: z.string(),
  by: z.string(),
  /** The designer's Figma user id (their lane on the Proposals page); claims from before lanes have only `by`. */
  byId: z.optional(z.string()),
  at: z.string(),
  /** Generation the copy was made from (the merge base). */
  baselineGen: z.string(),
  /** Claimed from this branch's lane (not in Live yet): the design is of that branch's version. */
  branch: z.optional(z.string()),
  note: z.optional(z.string()),
  readyHash: z.optional(z.string()),
  /** New design only: the component's name as the designer typed it (the code name derives from it). */
  name: z.optional(z.string()),
  /** New design only: a component (default) or a whole page (built as a page with a story and a route). */
  kind: z.optional(z.enum(["component", "page"])),
  /**
   * Designer's answer per change that touches only some variants: "all" = apply to every variant (default),
   * "variants" = only to the variants edited (a condition in code). Keyed by `${layer}|${prop}`.
   */
  scopes: z.optional(z.record(z.string(), z.enum(["all", "variants"]))),
});
export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

const StateSchema = z.enum(["in_sync", "in_design", "ready_for_dev", "design_new", "code_new", "ignored"]);

/** What the panel needs per component, mirrored by sync (state as of the last sync). */
export const IndexEntrySchema = z.object({
  component: z.string(),
  name: z.string(),
  state: StateSchema,
  unseen: z.boolean(),
  conflict: z.boolean(),
  lastGen: z.optional(z.string()),
  /** Node id of the Live component set (for Claim and "show"). */
  liveNodeId: z.optional(z.string()),
  claim: z.optional(
    z.object({
      id: z.string(),
      by: z.string(),
      baselineGen: z.string(),
      note: z.optional(z.string()),
      question: z.optional(z.string()),
      proposalNodeId: z.optional(z.string()),
      /** Of the designer's changes, how many the code already has (closing by observation). */
      done: z.optional(z.number()),
      total: z.optional(z.number()),
    }),
  ),
  /** One-line summary of what changed in code since the designer last looked. */
  whatsNew: z.optional(z.string()),
  /** Kept as design in Live: layer key → properties (or ["*"]). */
  pins: z.optional(z.record(z.string(), z.array(z.string()))),
  /** Where Live can't look like the app (a font missing in Figma, drawn with another). */
  warning: z.optional(z.string()),
  /** Where Live, once built, differs from the app as the browser drew it (layer: sizes, likely reason). */
  differs: z.optional(z.array(z.string())),
  /** Share of its layers matching the app (0–100) after the plugin fitted what the build got wrong. */
  score: z.optional(z.number()),
  /** Layers the plugin fitted to the app after building (CoDesignFlo gaps). */
  fitted: z.optional(z.number()),
  /** How closely the app follows the designer's design (%), and the previous update's figure. */
  designMatch: z.optional(z.object({ now: z.number(), was: z.optional(z.number()) })),
});
export type IndexEntry = z.infer<typeof IndexEntrySchema>;

export const DesignEventSchema = EventSchema;
