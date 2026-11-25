// Alex, the demo's simulated developer. While the designer's demo is open, their plugin asks the service to move
// Alex on (/api/demo/tick, every few seconds when something waits on him); each tick does at most one step:
//   1. A design was sent (Ready for dev): Alex reviews it (approved, with a plan), starts building, and uploads a
//      Live update of that component as it is, so the plugin shows the review and who's building at once (the
//      panel learns of a developer's events when an update is applied, as in any project).
//   2. A few seconds after that update is applied: Alex "builds" the design. The designer's changes are written
//      into the app's compiled code (the component's spec, the inverse of predictLive), checked the way the
//      plugin will check them, and uploaded as a Live update. The designer's plugin applies it, finds the code
//      matches the copy, and closes the design itself, archiving the copy — exactly as in a real project.
// Only changes to existing layers can be built this way (the demo's walkthrough asks for those).
import { gunzipSync, gzipSync } from "node:zlib";
import {
  type ComponentState,
  deltaFor,
  fold,
  type LedgerEvent,
  predictLive,
  type Raw,
  type SpecNode,
  TOKENS_COLLECTION,
  withDataTags,
} from "@codesignflo/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ALEX, alex, demoOf, shipFeature } from "./demo.ts";
import { append, generation, history } from "./tools.ts";

// ---- The designer's copy into the code ---------------------------------------------------------------------

const PLAIN = [
  "x",
  "y",
  "layoutPositioning",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "width",
  "height",
  "opacity",
  "clipsContent",
  "characters",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "textAutoResize",
  "textAlignHorizontal",
  "textCase",
  "textTruncation",
  "maxLines",
  "strokeAlign",
] as const;
const LAYOUT = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "itemSpacing",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "strokesIncludedInLayout",
] as const;
const RADII = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hex2 = (n: number) =>
  Math.round(Math.max(0, Math.min(1, n)) * 255)
    .toString(16)
    .padStart(2, "0");
/** A token binding "var(Tokens/space/2)" → "space/2" (bindings to other collections aren't the code's). */
const token = (v: unknown): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v;
  const m = typeof s === "string" ? /^var\((.+)\)$/.exec(s) : null;
  return m && m[1]!.startsWith(`${TOKENS_COLLECTION}/`) ? m[1]!.slice(TOKENS_COLLECTION.length + 1) : undefined;
};

/** Canonical paints → the spec's ("#rrggbb[aa]"; pictures and gradients keep what the code has). */
function paints(raw: Raw[], before: unknown): string[] {
  const had = Array.isArray(before) ? (before as string[]) : [];
  return raw
    .filter((p) => p.visible !== false)
    .map((p, i) => {
      if (p.type !== "SOLID") return had[i] ?? "#00000000";
      const c = p.color as { r: number; g: number; b: number };
      const a = typeof p.opacity === "number" ? p.opacity : 1;
      return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 1 ? hex2(a) : ""}`;
    });
}

/** Writes what differs between `base` and `copy` (one layer) into `spec`. Returns whether it changed anything. */
function carry(spec: SpecNode, base: Raw, copy: Raw): boolean {
  const props = { ...spec.props };
  const bind = { ...(spec.bind ?? {}) };
  const paintBind = { ...(spec.paintBind ?? {}) };
  let changed = false;
  const set = (f: string, v: unknown) => {
    if (v === undefined || same(props[f], v)) return;
    props[f] = v;
    changed = true;
  };
  for (const f of PLAIN) if (!same(copy[f], base[f])) set(f, copy[f]);
  const lb = (base.layout ?? {}) as Record<string, unknown>;
  const lc = (copy.layout ?? {}) as Record<string, unknown>;
  if (!same(lc.mode, lb.mode)) set("layoutMode", lc.mode);
  for (const f of LAYOUT) if (!same(lc[f], lb[f])) set(f, lc[f]);
  if (!same(copy.fontName, base.fontName) && copy.fontName) {
    const fn = copy.fontName as { family: string; style: string };
    set("fontName", { family: fn.family, style: fn.style });
  }
  if (typeof copy.cornerRadius === "number" && !same(copy.cornerRadius, base.cornerRadius)) set("cornerRadius", copy.cornerRadius);
  for (const f of ["fills", "strokes"] as const) {
    if (same(copy[f], base[f])) continue;
    set(f, paints((copy[f] ?? []) as Raw[], spec.props[f]));
    const first = ((copy[f] ?? []) as Raw[]).find((p) => p.visible !== false);
    const t = token((first?.boundVariables as Record<string, unknown> | undefined)?.color);
    if (t) paintBind[f] = t;
    else delete paintBind[f];
    changed = true;
  }
  if (!same(copy.strokeWeight, base.strokeWeight) && typeof copy.strokeWeight === "number") set("strokeWeight", copy.strokeWeight);
  // Token bindings of other fields (spacing, radius, font size…): the copy's, or none for a typed value.
  const bb = (base.boundVariables ?? {}) as Record<string, unknown>;
  const bc = (copy.boundVariables ?? {}) as Record<string, unknown>;
  for (const f of new Set([...Object.keys(bb), ...Object.keys(bc)])) {
    if (f === "fills" || f === "strokes" || same(bb[f], bc[f])) continue;
    const t = token(bc[f]);
    const fields = (RADII as readonly string[]).includes(f) ? RADII : [f];
    for (const g of fields) {
      if (t) bind[g] = t;
      else delete bind[g];
    }
    changed = true;
  }
  // A typed corner radius drops the token the code had for it.
  if ("cornerRadius" in props && !same(props.cornerRadius, spec.props.cornerRadius) && !RADII.some((f) => token(bc[f])))
    for (const f of RADII) delete bind[f];
  if (!changed) return false;
  spec.props = props;
  if (Object.keys(bind).length) spec.bind = bind;
  else delete spec.bind;
  if (Object.keys(paintBind).length) spec.paintBind = paintBind;
  else delete spec.paintBind;
  return true;
}

/**
 * Layers by sync key. An instance's own layers carry its main component's keys (the same in every instance), so
 * the walk stops at instances: what changes inside one is matched by position (`instanceOverrides`).
 */
const byKey = (t: Raw) => {
  const out = new Map<string, Raw>();
  const walk = (n: Raw) => {
    if (typeof n.k === "string") out.set(n.k, n);
    if (n.type === "INSTANCE") return;
    for (const c of (n.children ?? []) as Raw[]) walk(c);
  };
  walk(t);
  return out;
};

const solidHex = (paintsRaw: unknown): { fill?: string; fillToken?: string } => {
  const first = ((paintsRaw ?? []) as Raw[]).find((p) => p.visible !== false);
  if (!first || first.type !== "SOLID") return {};
  const [fill] = paints([first], []);
  const t = token((first.boundVariables as Record<string, unknown> | undefined)?.color);
  return { ...(fill ? { fill } : {}), ...(t ? { fillToken: t } : {}) };
};

/**
 * What the designer changed inside an instance (its text, its fill), as the code describes it: overrides on that
 * usage of the component, by the layers' names from the instance down (and their positions). Merged into `spec`.
 */
function instanceOverrides(spec: SpecNode, base: Raw, copy: Raw): boolean {
  if (!spec.instance) return false;
  const overrides = [...spec.instance.overrides];
  let changed = false;
  const walk = (b: Raw, c: Raw, path: string[], at: number[]) => {
    const bc = (b.children ?? []) as Raw[];
    const cc = (c.children ?? []) as Raw[];
    cc.forEach((child, i) => {
      const was = bc[i];
      if (!was) return;
      const p = [...path, String(child.name ?? "")];
      const a = [...at, i];
      const o: Partial<import("@codesignflo/core").InstanceOverride> = {};
      if (child.characters !== was.characters && typeof child.characters === "string") o.characters = child.characters;
      if (!same(child.fills, was.fills)) Object.assign(o, solidHex(child.fills));
      if (Object.keys(o).length) {
        const j = overrides.findIndex((x) => x.path.join("/") === p.join("/"));
        overrides[j >= 0 ? j : overrides.length] = { ...(j >= 0 ? overrides[j] : { path: p, at: a }), ...o };
        changed = true;
      }
      walk(was, child, p, a);
    });
  };
  walk(base, copy, [], []);
  if (changed) spec.instance = { ...spec.instance, overrides };
  return changed;
}

/**
 * The component's spec with the designer's changes built in (`base` → `copy`, canonical snapshots of the claimed
 * Live version and of the designer's copy), and how many of their changes the result still lacks, checked the
 * way the plugin checks before closing a design. "For every version" (scope all) changes go to every variant.
 */
export function buildDesign(p: {
  spec: SpecNode;
  base: Raw;
  copy: Raw;
  live: Raw;
  dtcg: Record<string, unknown>;
  scopes?: Record<string, "all" | "variants">;
}): { spec: SpecNode; missing: number; total: number } {
  const spec = structuredClone(p.spec) as SpecNode;
  const specs = new Map<string, SpecNode>();
  const index = (s: SpecNode) => {
    specs.set(s.k, s);
    for (const c of s.children ?? []) index(c);
  };
  index(spec);
  const base = byKey(p.base);
  const touched = new Set<string>();
  /** Instances whose content changed (written as overrides): what Figma rebuilds, which the prediction can't see. */
  const overridden = new Set<string>();
  const variants = (spec.children ?? []).map((v) => v.k);
  const everyVersion = Object.values(p.scopes ?? {}).includes("all");
  for (const [k, c] of byKey(p.copy)) {
    const b = base.get(k);
    if (!b) continue;
    // The same layer in the other variants, for changes meant for every version.
    const own = variants.find((v) => k === v || k.startsWith(`${v}/`));
    const targets = [k, ...(everyVersion && own ? variants.filter((v) => v !== own).map((v) => v + k.slice(own.length)) : [])];
    for (const t of targets) {
      const s = specs.get(t);
      if (!s) continue;
      if (carry(s, b, c)) touched.add(t);
      if (c.type === "INSTANCE" && instanceOverrides(s, b, c)) {
        touched.add(t);
        overridden.add(String(c.name ?? ""));
      }
    }
  }
  // Changed layers (and what holds them) lose the browser's measured sizes: Figma lays them out anew.
  for (const t of touched) {
    for (let k = t; k; k = k.includes("/") ? k.slice(0, k.lastIndexOf("/")) : "") {
      const s = specs.get(k);
      if (s) delete (s as { measured?: unknown }).measured;
      if (!k.includes("/")) break;
    }
  }
  const predicted = predictLive(p.live, spec).tree;
  const { changes } = deltaFor({
    base: withDataTags(p.base, p.live),
    ours: withDataTags(p.copy, p.live),
    theirs: predicted,
    dtcg: p.dtcg,
    ...(p.scopes ? { scopes: p.scopes } : {}),
  });
  const total = deltaFor({
    base: withDataTags(p.base, p.live),
    ours: withDataTags(p.copy, p.live),
    theirs: p.live,
    dtcg: p.dtcg,
    ...(p.scopes ? { scopes: p.scopes } : {}),
  }).changes.length;
  // Changes inside an instance ("body/button > text") written as overrides: built (Figma applies them on rebuild).
  const inOverride = (layer: string) => layer.includes(" > ") && overridden.has(layer.split(" > ")[0]!.split("/").pop()!);
  return { spec, missing: changes.filter((c) => !inOverride(c.layer)).length, total };
}

// ---- The tick ----------------------------------------------------------------------------------------------

type LiveRow = { id: number; status: string; commit: string; created_at: string; taken_at: string | null; payload: Record<string, unknown>; bundle: string | null };

/** Waits between Alex's steps, so the designer sees each one. */
const WAIT_MS = { build: 1_500 };

const now = () => new Date().toISOString();
const ev = (kind: string, component: string, claim: string, extra: Record<string, unknown> = {}) =>
  ({ id: `alex_${kind}_${claim}`, at: now(), by: ALEX.name, component, kind, claim, ...extra }) as unknown as LedgerEvent;

async function lastLive(db: SupabaseClient, project: string): Promise<LiveRow | null> {
  const { data } = await db
    .from("live_updates")
    .select("id, status, commit, created_at, taken_at, payload, bundle")
    .eq("project_id", project)
    .eq("kind", "live")
    .order("id", { ascending: false })
    .limit(5);
  return ((data ?? []) as LiveRow[]).find((r) => r.status === "applied" && r.bundle) ?? null;
}

async function upload(db: SupabaseClient, project: string, dev: string, from: LiveRow, sets: SpecNode[], screens: unknown[], commit: string, only: string[]) {
  const payload = { ...from.payload, commit, only, deliveries: [] };
  const { error } = await db.from("live_updates").insert({
    project_id: project,
    created_by: dev,
    commit,
    branch: "main",
    kind: "live",
    status: "pending",
    payload,
    bundle: gzipSync(JSON.stringify({ sets, screens })).toString("base64"),
  });
  if (error) throw new Error(`Alex couldn't upload: ${error.message}`);
}

/** A Live update's code larger than this unpacked isn't read (a small upload can unpack into gigabytes). */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/** The update's code, unpacked within MAX_BUNDLE_BYTES; null when it's too large or not readable. */
function unpack(b64: string): { sets: SpecNode[]; screens: unknown[] } | null {
  try {
    return JSON.parse(gunzipSync(Buffer.from(b64, "base64"), { maxOutputLength: MAX_BUNDLE_BYTES }).toString()) as { sets: SpecNode[]; screens: unknown[] };
  } catch (e) {
    console.error("demo: couldn't read the latest Live update's code", (e as Error).message);
    return null;
  }
}

/**
 * Moves Alex on in the person's demo, one step at most. Returns what he did ("" when nothing was due), and
 * whether anything waits on him still (the plugin keeps ticking while it does).
 */
export async function alexTick(db: SupabaseClient, userId: string): Promise<{ did: string; waiting: boolean }> {
  const project = await demoOf(db, userId);
  if (!project) return { did: "", waiting: false };
  // 0. His new feature, built before any design (once, after the sample shop is in the person's file).
  if (await shipFeature(db, project)) return { did: "shipped", waiting: true };
  const events = await history(db, project);
  const states = [...fold(events).values()].filter((s): s is ComponentState & { claim: NonNullable<ComponentState["claim"]> } => s.state === "ready_for_dev" && !!s.claim);
  if (!states.length) return { did: "", waiting: false };
  // An update of Alex's still waiting for the plugin: nothing until it's applied.
  const { data: pending } = await db.from("live_updates").select("id").eq("project_id", project).eq("kind", "live").in("status", ["pending", "applying"]).limit(1);
  if ((pending ?? []).length) return { did: "", waiting: true };
  const dev = await alex(db);
  const s = states[0]!;
  const claim = s.claim.id;
  const mine = (kind: string) => events.find((e) => e.kind === kind && (e as { claim?: string }).claim === claim && e.by === ALEX.name);
  const live = await lastLive(db, project);
  if (!live?.bundle) return { did: "", waiting: true };
  const bundle = unpack(live.bundle);
  if (!bundle) return { did: "", waiting: false };

  // 1. Review, start building, and show it: the component's update as it is.
  if (!mine("dev_reviewed")) {
    await append(db, project, [
      ev("dev_reviewed", s.component, claim, {
        decision: "approved",
        plan: "Looks good. I'll update the component's styles to match your copy, then sync so Live shows it.",
      }),
      ev("building", s.component, claim),
    ]);
    await upload(db, project, dev, live, bundle.sets, bundle.screens, `alex-${claim}-start`, [s.component]);
    return { did: "reviewed", waiting: true };
  }
  // 2. Build it, a few seconds after the start was applied.
  const started = mine("building");
  if (started && Date.now() - Date.parse(started.at) < WAIT_MS.build) return { did: "", waiting: true };
  if (live.commit === `alex-${claim}`) return { did: "", waiting: true };
  const { data: row } = await db.from("proposals").select("payload").eq("project_id", project).eq("claim_id", claim).maybeSingle();
  const payload = (row?.payload ?? {}) as { base?: Raw; copy?: Raw; scopes?: Record<string, "all" | "variants"> };
  const base = payload.base ?? (s.claim.baselineGen ? await generation(db, project, s.component, s.claim.baselineGen) : null);
  const liveGen = (s.lastGen ? await generation(db, project, s.component, s.lastGen) : null) ?? base;
  const spec = bundle.sets.find((x) => x.k === s.component);
  if (!payload.copy || !base || !liveGen || !spec) return { did: "", waiting: true };
  const built = buildDesign({
    spec,
    base,
    copy: payload.copy,
    live: liveGen,
    dtcg: (live.payload.dtcg ?? {}) as Record<string, unknown>,
    ...(payload.scopes ? { scopes: payload.scopes } : {}),
  });
  await upload(
    db,
    project,
    dev,
    live,
    bundle.sets.map((x) => (x.k === s.component ? built.spec : x)),
    bundle.screens,
    `alex-${claim}`,
    [s.component],
  );
  await db
    .from("proposals")
    .update({ code_check: { done: built.total - built.missing, total: built.total, conflicts: 0, exact: built.missing === 0, commit: `alex-${claim}`, at: now() } })
    .eq("project_id", project)
    .eq("claim_id", claim);
  return { did: built.missing ? `built (${built.missing} of ${built.total} not buildable in the demo)` : "built", waiting: true };
}
