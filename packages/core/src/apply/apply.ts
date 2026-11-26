// Updating Live from compiled code — the Figma half of sync, shared by the CLI (through the bridge) and the
// plugin (applying an update uploaded to the service, when the file is opened). Steps:
//  1. tokens and pictures
//  2. protect hand edits in Live (W11): if Live differs from its last generation, save it as a proposal first
//  3. update Live in place; store each new generation's snapshot; record "generated"; close built new designs
//  4. pick up the designer's facts (claims, ready notes) and acknowledge them in the file
//  5. verify deliveries that name a proposal (commit line), close or send back
//  6. three-way deltas for ready proposals; close the ones the code now satisfies (close by observation)
//  7. refresh the panel's index (with "what's new")
import type { Screen, SpecNode } from "../compile/compile.js";
import { inlineInstances, tokenNames } from "../compile/compile.js";
import { isWindowBar } from "../design/presentation.js";
import { diff, keysById } from "../diff/diff.js";
import type { IndexEntry } from "../file/model.js";
import { adoptForeignVariables, type Change } from "../group/group.js";
import type { LedgerEvent } from "../ledger/events.js";
import { type ComponentState, fold } from "../ledger/state.js";
import type { MergeReport } from "../merge/merge.js";
import { canonicalize, type Raw, stringify } from "../snapshot/canonical.js";
import { type SystemUse, systemUses } from "../system/system.js";
import { hash } from "../util/hash.js";
import { stableStringify } from "../util/stable.js";
import { alikeNote, type PropCheck, type PropDifference, propDifferenceLine, type StyleSignals, signalDifferences } from "./check.js";
import { deltaFor, withDataTags } from "./delta.js";
import { designerText } from "./instructions.js";
import { predictLive } from "./predict.js";

export type Snap = { tree: Raw; variables: Record<string, string>; styles: Record<string, string> };
type Stats = {
  created: number;
  deleted: number;
  moved: number;
  writes: Record<string, number>;
  errors: string[];
  differs?: { k: string; figma: [number, number]; app: [number, number]; why?: string; at?: true; inFlow?: true; alike?: number }[];
  score?: { before: number; after: number; checked: number; skipped?: number };
  /** Properties that differ from the browser's (colours, fonts, text, padding…), the most visible first. */
  props?: PropDifference[];
  /** How many properties were checked, on how many layers, and how many differ. */
  propCheck?: PropCheck;
  fitted?: string[];
  anchored?: boolean;
  pairing?: { paired: number; layers: number };
  designMatch?: { now: number; was?: number };
  signals?: { design: StyleSignals; app: StyleSignals };
};

/** "Grid-Item-0 › Card-Top: 120×600 in Figma, 514×240 in the app (why)" — where Live differs from the browser. */
function differenceLines(root: string, s: Stats): string[] {
  return (s.differs ?? [])
    .map((d) => {
      const path =
        d.k
          .slice(root.length + 1)
          .split("/")
          .join(" › ") || "(the whole thing)";
      if (d.inFlow)
        return `${path}: at ${d.figma[0]},${d.figma[1]} in its parent in Figma, ${d.app[0]},${d.app[1]} in the app (placed elsewhere in its row or column${d.why ? `: ${d.why}` : ""})${alikeNote(d.alike)}`;
      if (d.at)
        return `${path}: at ${d.figma[0]},${d.figma[1]} in Figma, ${d.app[0]},${d.app[1]} in the app (placed elsewhere${s.anchored ? "" : " — rebuilt next update"})${alikeNote(d.alike)}`;
      return `${path}: ${d.figma[0]}×${d.figma[1]} in Figma, ${d.app[0]}×${d.app[1]} in the app${d.why ? ` (${d.why})` : ""}${alikeNote(d.alike)}`;
    })
    .concat((s.props ?? []).map((d) => propDifferenceLine(root, d)));
}
export type Proposal = {
  nodeId: string;
  claim: {
    id: string;
    component: string;
    by: string;
    baselineGen: string;
    readyHash?: string;
    note?: string;
    scopes?: Record<string, "all" | "variants">;
    /** Claimed from this branch's lane (not Live's version). */
    branch?: string;
  };
  role: string;
  locked?: boolean;
};

/** The Figma file, through the plugin (the bridge for the CLI; the plugin's own handlers in the panel). */
export type Figma = { call: <T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }) => Promise<T> };

/** Where the history and the generations live (the repo in local mode, the service in cloud mode). */
export type Store = {
  ledger: () => LedgerEvent[];
  /** Appends events not already there (by id); returns the ones added. */
  append: (events: LedgerEvent[]) => LedgerEvent[];
  generation: (component: string, gen: string) => Promise<Raw | null>;
  saveGeneration: (component: string, gen: string, snap: Raw) => Promise<void>;
  /** Keeps a computed delta for the developer (CLI: proposals/<component>/<claim>/); returns where. */
  delta?: (component: string, claim: string, m: MergeReport, changes: Change[], content: Change[], uses?: SystemUse[]) => string;
  /** Keeps a new design's spec and picture for the developer (CLI only; the service has the proposal). */
  newDesign?: (component: string, claim: string, spec: Raw, picture: () => Promise<string>) => Promise<string>;
};

/** A commit that names a proposal (CoDesignFlo: line), with the change list frozen when it was handed off. */
export type Delivery = {
  commit: string;
  component: string;
  claim: string;
  items: string[];
  changes: Change[];
  /** Why changes were left out (deliver's report), by change id. */
  why: Record<string, string>;
};

export type UpdateInput = {
  sets: SpecNode[];
  screens: Screen[];
  dtcg: Record<string, unknown>;
  commit: string;
  /** Component and page keys in the code now (the index lists these, plus new designs). */
  keys: string[];
  /** Component and page key → its source file (relative to the app), named where the app differs from the design. */
  sources?: Record<string, string>;
  deliveries: Delivery[];
  /**
   * Pictures by content hash, base64 (PNG or JPEG). A local sync sends them; through the service they're in
   * its media storage (refs in `media`) and the plugin fills this in with the ones the file doesn't have.
   */
  images?: Record<string, string>;
  /** Cloud: content hashes of every picture this update uses (the app's images and the pages' screenshots). */
  media?: string[];
  /**
   * Page key → the browser's screenshot of the page (a picture ref, its size): shown beside the Live page,
   * so the designer sees the app as built next to Live's editable copy of it.
   */
  shots?: Record<string, { ref: string; w: number; h: number }>;
  /**
   * Update only these components and pages in Live (keys; one item at a time while building designs):
   * everything else in Live stays as it is, and nothing counts as removed from the code.
   */
  only?: string[];
  /** Branches merged into the Live branch since their preview: their "Branch: <name>" sections go. */
  closePreviews?: string[];
  /**
   * A preview of a connected branch: its lane beside Live, kept up to date by every sync on the branch until
   * it's disconnected or merged (a one-off preview has none). `by`: who connected it.
   */
  lane?: { by?: string };
  /** The designs this branch builds, and how far (preview): marked in the lane and on the designers' copies. */
  designs?: LaneDesign[];
};

/** A design a branch builds: its claim, component (key) and how many of its changes are in the code. */
export type LaneDesign = { claim: string; component: string; done: number; total: number };

export type UpdateResult = { states: Map<string, ComponentState>; notes: string[] };

const now = () => new Date().toISOString();
const canon = (s: Snap) => canonicalize(s.tree, { variables: s.variables, styles: s.styles, ignoreRootName: true });

/**
 * A designer's copy against what the code built in Figma (Live's item, or a branch lane's): how many of the design's
 * changes it has. The base is the version the copy was claimed from: a Live generation, or — claimed from a
 * branch's lane, which has no Live generation — the copy's own starting point, kept on it.
 */
export async function designAgainst(
  s: Figma,
  p: {
    copyId: string;
    builtId: string;
    base?: Raw | null;
    dtcg: Record<string, unknown>;
    scopes?: Record<string, "all" | "variants">;
    designWins?: boolean;
  },
) {
  const theirs = canon(await s.call<Snap>("snapshot", { id: p.builtId }));
  const own = p.base ?? (await s.call<Raw | null>("proposalBase", { id: p.copyId }).catch(() => null));
  const base = withDataTags(own ?? theirs, theirs);
  const projectTokens = new Set(tokenNames(p.dtcg).values());
  const ours = adoptForeignVariables(withDataTags(canon(await s.call<Snap>("snapshot", { id: p.copyId })), theirs), projectTokens);
  const { m, changes, content } = deltaFor({
    base,
    ours,
    theirs,
    dtcg: p.dtcg,
    ...(p.scopes ? { scopes: p.scopes } : {}),
    ...(p.designWins ? { designWins: true } : {}),
  });
  const conflicts = p.designWins ? 0 : m.summary.conflict;
  const left = changes.reduce((n, c) => n + c.items.length, 0);
  return { m, changes, content, done: m.summary.convergent, total: m.summary.convergent + left + conflicts, conflicts };
}

/** The snapshot minus tags that aren't design (data-text marks), for generation ids. */
function withoutTags(r: Raw): Raw {
  const { dataText: _, children, ...rest } = r as Raw & { dataText?: boolean };
  return { ...rest, ...(children ? { children: children.map(withoutTags) } : {}) } as Raw;
}
/** A generation is what Figma shows: identical visuals (tags aside) = same generation. */
export const generationOf = (snap: Raw) => `g_${hash(stringify(withoutTags(snap))).slice(0, 10)}`;

/**
 * A designer's new design and what was built from it, made comparable: a plain frame is one version of the
 * component, so it is compared with the built component's first (default) variant, not with the set around
 * it; the design has no sync keys, so layers match by name (the names code gives with data-cdf); and where
 * each root sits (constraints, sizing inside its parent) is not part of the design.
 */
export function comparable(design: Raw, live: Raw): [Raw, Raw] {
  let l = live;
  if (design.type !== "COMPONENT_SET" && live.type === "COMPONENT_SET" && live.children?.length) {
    const { variantProperties: _, ...first } = live.children[0] as Raw & { variantProperties?: unknown };
    l = { ...first, type: design.type, name: design.name } as Raw;
  }
  const unkeyed = (r: Raw): Raw => {
    const { k: _, children, ...rest } = r as Raw & { k?: unknown };
    return { ...rest, ...(children ? { children: children.map(unkeyed) } : {}) } as Raw;
  };
  const placement = (r: Raw): Raw => {
    const { constraints: _c, layoutSizingHorizontal: _h, layoutSizingVertical: _v, ...rest } = r as Raw & Record<string, unknown>;
    const layout = rest.layout as Record<string, unknown> | undefined;
    if (layout) {
      const { strokesIncludedInLayout: _s, ...lay } = layout;
      (rest as Record<string, unknown>).layout = lay;
    }
    return rest as Raw;
  };
  // Both sides: placed components inside a designer's design carry their main component's layer keys too.
  return [placement(unkeyed(design)), placement(unkeyed(l))];
}

/** One-line, designer-readable summary of what changed between two generations. */
function whatsNew(before: Raw | null, after: Raw): string | undefined {
  if (!before) return undefined;
  const items = diff(before, after);
  if (!items.length) return undefined;
  const words: Record<string, string> = {
    layout: "layout",
    token: "tokens",
    style: "colours/borders",
    typography: "type",
    content: "text",
    structure: "layers",
    variant: "variants",
    prop: "properties",
  };
  const kinds = [...new Set(items.map((i) => words[i.kind] ?? i.kind))];
  return `Changed in code: ${kinds.join(", ")} (${items.length} change${items.length > 1 ? "s" : ""})`;
}

/**
 * Kept-as-design properties the code now produces itself: they can follow the code again. Compared with what
 * the code would draw there (the spec laid over Live, pins ignored).
 */
function codeCaughtUp(live: Raw, spec: SpecNode): string[] {
  const pinned: { key: string; props: string[] }[] = [];
  const walk = (n: Raw) => {
    if (Array.isArray(n.pin) && typeof n.k === "string" && !(n.pin as string[]).includes("*"))
      pinned.push({ key: n.k, props: n.pin as string[] });
    for (const c of n.children ?? []) walk(c);
  };
  walk(live);
  if (!pinned.length) return [];
  const drawn = predictLive(live, spec).tree;
  const keys = keysById(live);
  const differs = new Set(diff(live, drawn, { pins: false }).map((i) => `${keys.get(i.target)}|${i.prop}`));
  return pinned.flatMap((p) =>
    p.props
      .filter((prop) => !differs.has(`${p.key}|${prop}`))
      .map(
        (prop) =>
          `the code now does what was kept as design (${prop} of ${p.key}) — it can follow the code again ("Use the code's" in the panel)`,
      ),
  );
}

/** What a Live root was built from: the compiled code for it (the same code → nothing to rewrite). */
export const specHashOf = (spec: SpecNode) => hash(stableStringify(spec)).slice(0, 16);

/** Updates Live from compiled code and moves the history on. `log` gets one line per outcome. */
export async function applyUpdate(
  s: Figma,
  store: Store,
  input: UpdateInput,
  log: (line: string) => void,
  /** After each component and each page: how many of all are done, and which one just was. */
  onStep?: (done: number, total: number, item: string) => void,
): Promise<UpdateResult> {
  const { dtcg, commit } = input;
  const picked = (k: string) => !input.only || input.only.includes(k.replace(/^screen:/, ""));
  const sets = input.sets.filter((x) => picked(x.k));
  const screens = input.screens.filter((x) => picked(x.spec.k));
  if (input.only) log(`only: ${input.only.join(", ")} — the rest of Live stays as it is`);
  let stepsDone = 0;
  const step = (item: string) => onStep?.(++stepsDone, sets.length + screens.length, item);
  const projectTokens = new Set(tokenNames(dtcg).values());

  const ledgerBefore = fold(store.ledger());
  const events: LedgerEvent[] = [];
  const generations = (k: string) => [...store.ledger(), ...events].filter((e) => e.kind === "generated" && e.component === k).length;
  const liveIds = Object.fromEntries(Object.entries(await s.call<Record<string, string>>("ids", {})).filter(([k]) => !k.includes("/")));
  const notes: string[] = [];
  const whatsNewBy: Record<string, string> = {};
  /** Where Live can't look like the app, by component (shown on its row in the panel). */
  const warnings: Record<string, string> = {};
  /** Where Live, once built, differs from the browser (sizes), by component. */
  const differsBy: Record<string, string[]> = {};
  /** How closely the app follows the designer's design, by page (%), and last time. */
  const designMatchBy: Record<string, { now: number; was?: number }> = {};
  /** How well Live matches the app, by component: the score and how many layers were fitted to it. */
  const scoreBy: Record<string, { score: number; fitted: number }> = {};
  const recordDifferences = (key: string, root: string, s: Stats) => {
    if (s.score) {
      const fitted = s.fitted ?? [];
      scoreBy[key] = { score: s.score.after, fitted: fitted.length };
      const pc = s.propCheck;
      if (fitted.length || s.score.after < 100 || pc?.differ)
        log(
          `${key}: ${s.score.after}% of ${s.score.checked} layers match the app${fitted.length ? ` (${s.score.before}% as built; ${fitted.length} fitted to it)` : ""}${s.score.skipped ? ` (${s.score.skipped} not checked: Library components or layers the page didn't measure)` : ""}${pc ? `; ${pc.checked - pc.differ} of ${pc.checked} properties on ${pc.layers} layers match` : ""}`,
        );
      if (fitted.length) {
        const paths = fitted.map(
          (k) =>
            k
              .slice(root.length + 1)
              .split("/")
              .join(" › ") || "(the whole thing)",
        );
        notes.push(
          `${key}: fitted to the app after building — ${paths.slice(0, 6).join("; ")}${paths.length > 6 ? `; +${paths.length - 6} more` : ""} (CoDesignFlo gaps, not code to change)`,
        );
      }
    }
    if (s.designMatch) {
      designMatchBy[key] = s.designMatch;
      const { now, was } = s.designMatch;
      log(
        `${key}: ${now}% like the designer's design${was !== undefined && was !== now ? ` (was ${was}%)` : ""} — Live ${s.anchored ? "is built on it with the code's changes" : "shows the app"}`,
      );
      if (was !== undefined && was - now >= 10)
        notes.push(
          `${key}: the app moved away from the designer's design — ${now}% like it, was ${was}% (the designer sees it on the row)`,
        );
    }
    if (s.anchored)
      log(`${key}: built on the designer's design${s.fitted?.length ? `; ${s.fitted.length} layer(s) the code added were generated` : ""}`);
    // Few of the design's layers found in the app: the code doesn't name its elements after them, so code
    // changes and differences can't follow — the developer's to fix (a safe change: names only).
    if (s.pairing && s.pairing.paired < 0.6 * s.pairing.layers)
      notes.push(
        `${key}: only ${s.pairing.paired} of the design's ${s.pairing.layers} layers are found in the app — for the developer, code to change: name the page's elements after the design's layers (call pair_design for this page), so changes and differences follow them`,
      );
    // The look as a whole (gradients, glows, corners, spacing, columns), where it's clearly apart from the design's.
    // On a page built on the design that's code to change; otherwise the match above already says the app went
    // its own way, and this says how (not a CoDesignFlo gap: it isn't Live against the app).
    const style = s.signals ? signalDifferences(s.signals.design, s.signals.app) : [];
    const look = style.length ? `the look as a whole: ${style.join("; ")}` : "";
    if (look && !s.anchored) log(`${key}: unlike the designer's design in ${look.slice(4)}`);
    const lines = [...(look && s.anchored ? [look] : []), ...differenceLines(root, s)];
    if (!lines.length) return;
    differsBy[key] = lines;
    // Built on the design: where it differs from the browser, the app differs from the design — code to change,
    // in the page's or component's source file.
    const file = s.anchored ? input.sources?.[key] : undefined;
    for (const l of lines)
      notes.push(`${key}: ${s.anchored ? "the app differs from the design" : "differs from the app"} — ${l}${file ? ` [${file}]` : ""}`);
  };

  // 2. Protect hand edits — for every component before any is updated: updating one changes the
  //    instances inside others, which would otherwise look like hand edits.
  // Compared with the generation Live itself shows: after a sync from another branch that generation's
  // snapshot isn't stored, and Live is then not checked (rather than every difference looking like an edit).
  const liveGens = await s.call<Record<string, string>>("gens", {});
  // Components whose Live was edited by hand: rebuilt even if the code is the same as last time.
  const handEdited = new Set<string>();
  for (const set of sets) {
    const prev = liveGens[set.k] ?? ledgerBefore.get(set.k)?.lastGen;
    const prevSnap = prev ? await store.generation(set.k, prev) : null;
    if (prev && !prevSnap && liveIds[set.k]) notes.push(`${set.k}: Live was last updated from another branch — not checked for hand edits`);
    if (prevSnap && liveIds[set.k]) {
      const live = canon(await s.call<Snap>("snapshot", { id: liveIds[set.k] }));
      if (diff(prevSnap, live).length) {
        const claim = { id: `live${Date.now().toString(36)}`, component: set.k, by: "edited in Live", at: now(), baselineGen: prev ?? "" };
        await s.call("cloneToProposals", { id: liveIds[set.k], claim, base: prevSnap });
        handEdited.add(set.k);
        const st = ledgerBefore.get(set.k)?.state;
        // Recorded right away: if a later step fails, the copy isn't left without its claim.
        if (st === "in_sync" || st === "code_new" || st === "ignored")
          store.append([
            {
              id: `${claim.id}_claimed`,
              at: now(),
              by: claim.by,
              component: set.k,
              kind: "claimed",
              claim: claim.id,
              baselineGen: claim.baselineGen,
            },
          ]);
        notes.push(`${set.k}: Live had been edited by hand — saved as a proposal before updating it`);
      }
    }
  }

  // Tokens before anything is built: Live components bind to these variables (idempotent, writes only what
  // changed). After the hand-edit check: a token's new value changes Live, and wasn't anyone's hand edit.
  const tok = await s.call<{ created: number; writes: Record<string, number> }>("tokensPush", { dtcg });
  if (tok.created || Object.keys(tok.writes).length)
    log(`tokens: ${tok.created} created, ${Object.values(tok.writes).reduce((a, b) => a + b, 0)} updated`);
  // Pictures before anything uses them (each once per session, by content hash).
  if (input.images && Object.keys(input.images).length) await s.call("putImages", { images: input.images }, { timeoutMs: 120_000 });

  // 3. Update Live in place.
  const proposalsBefore = (await s.call<{ proposals: Proposal[] }>("readFacts")).proposals;
  const progress: Record<string, { done: number; total: number }> = {};
  // A designer's new design that lands in code now: Live adopts their frame instead of building a fresh one.
  const adoptFrom = (key: string): { adoptFrom?: string } => {
    const st = ledgerBefore.get(key);
    if (st?.state !== "design_new" || !st.claim || liveIds[key]) return {};
    const p = proposalsBefore.find((x) => x.role === "proposal" && x.claim.id === st.claim!.id);
    return p ? { adoptFrom: p.nodeId } : {};
  };
  /** Records a new generation of a component or page; returns whether it changed. */
  const generated = async (key: string, id: string, snap: Raw, firstReviewed: boolean) => {
    const gen = generationOf(snap);
    await s.call("setGen", { id, gen });
    if (!(await store.generation(key, gen))) await store.saveGeneration(key, gen, snap);
    const prev = ledgerBefore.get(key)?.lastGen;
    if (gen !== prev) {
      // First sync: everything starts in sync. Later, a component new in code waits for the designer ("New in code").
      if (!ledgerBefore.has(key))
        events.push({
          id: `reg_${key}`,
          at: new Date(Date.now() - 1).toISOString(), // before its "generated" event
          by: "cli",
          component: key,
          kind: "registered",
          reviewed: firstReviewed,
        });
      // Numbered per component: going back to an earlier generation (a revert) is a new event, not a duplicate.
      events.push({
        id: `gen_${key}_${generations(key)}_${gen}`,
        at: now(),
        by: "cli",
        component: key,
        kind: "generated",
        gen,
        commit,
        fingerprint: gen,
      });
      const wn = whatsNew(prev ? await store.generation(key, prev) : null, snap);
      if (wn) whatsNewBy[key] = wn;
    }
    return { gen, prev };
  };

  // Framing from the designs built as app UI: a browser window bar in every page of the app and of Live.
  const layer = (n: SpecNode): Parameters<typeof isWindowBar>[0] => ({
    name: n.name,
    type: n.type,
    width: n.measured?.w,
    height: n.measured?.h,
    children: (n.children ?? []).map(layer),
  });
  for (const set of sets)
    if ((set.children ?? []).some((v) => isWindowBar(layer(v))))
      notes.push(
        `${set.k}: looks like the browser window the designs were framed in (a title bar with traffic lights), not app UI — for the developer, code to change: take it out of the app's pages (nothing to wait for from the designer)`,
      );
  const builtSets: { key: string; id: string; gen: string }[] = [];
  for (const set of sets) {
    const adopt = adoptFrom(set.k);
    // One component that can't be built doesn't stop the others, or the pages after them (it used to: a single
    // failing component left Live with half its components and no pages).
    let r: { id: string; stats: Stats; skipped?: boolean };
    try {
      r = await s.call<{ id: string; stats: Stats; skipped?: boolean }>(
        "reconcile",
        { spec: set, ...adopt, ...(handEdited.has(set.k) || adopt.adoptFrom ? {} : { specHash: specHashOf(set) }) },
        { timeoutMs: 180_000 },
      );
    } catch (e) {
      notes.push(
        `${set.k}: couldn't update this component in Live (${(e as Error).message}) — the rest of the update went on; it's tried again next time`,
      );
      step(set.k);
      continue;
    }
    liveIds[set.k] = r.id;
    for (const e of r.stats.errors) if (!e.startsWith("bind grid")) notes.push(`${set.k}: ${e}`);
    recordDifferences(set.k, set.k, r.stats);
    const font = r.stats.errors.filter((e) => e.startsWith("font missing in Figma")).map((e) => /: (.+?) \(/.exec(e)?.[1] ?? e);
    if (font.length)
      warnings[set.k] =
        `Drawn with Inter here: the app's font (${[...new Set(font)].join(", ")}) isn't in Figma — install it, or the app doesn't look like this`;
    const after = canon(await s.call<Snap>("snapshot", { id: r.id }));
    // A designer's new design just showed up in the code: it is built → close it (before its first
    // generation, so it starts In sync). Visual differences are reported, not blocking: the designer
    // can claim the new Live component like any other.
    const before = ledgerBefore.get(set.k);
    if (before?.state === "design_new" && before.claim) {
      const p = proposalsBefore.find((x) => x.role === "proposal" && x.claim.id === before.claim!.id);
      const design = p ? canon(await s.call<Snap>("snapshot", { id: p.nodeId })) : null;
      // Visual differences only: a token in code where the designer used the same raw value is not one.
      const unbound = (v: unknown) => stableStringify(v, (k) => k === "boundVariables");
      const found = design ? diff(...comparable(design, after)) : [];
      const left = found.filter((i) => unbound(i.from) !== unbound(i.to)).length;
      const tokenized = found.length - left;
      events.push({
        id: `closed_${before.claim.id}`,
        at: new Date(Date.now() - 2).toISOString(),
        by: "cli",
        component: set.k,
        kind: "closed",
        claim: before.claim.id,
        commit,
        items: [],
      });
      if (p) await s.call("archiveProposal", { nodeId: p.nodeId });
      log(
        `closed: ${set.k} — the new design is built and now in Live${left ? ` (${left} visual difference(s) from the designer's frame — check with: codesignflo verify ${set.k})` : " and matches the designer's frame"}${tokenized ? `; ${tokenized} raw value(s) became tokens` : ""}`,
      );
    }
    const { gen, prev } = await generated(set.k, r.id, after, ledgerBefore.size === 0);
    builtSets.push({ key: set.k, id: r.id, gen });
    for (const n of codeCaughtUp(after, set)) notes.push(`${set.k}: ${n}`);
    const writes = Object.values(r.stats.writes).reduce((a, b) => a + b, 0);
    log(
      `${set.k.padEnd(16)} ${gen === prev ? "unchanged" : prev ? "updated" : "created"}${writes || r.stats.created ? ` (${r.stats.created} created, ${writes} writes)` : ""}`,
    );
    step(set.k);
  }
  // The Design System page (when the file has one): a From-code copy of each code component that has no
  // Library counterpart, before the pages are drawn with the Library's linked components. A plugin from before
  // it doesn't know the call: nothing to do then.
  const system = await s.call<{ notes: string[] }>("dsRefresh", {}, { timeoutMs: 120_000 }).catch(() => null);
  for (const n of Array.isArray(system?.notes) ? system.notes : []) notes.push(n);
  const mains = new Map(input.sets.flatMap((x) => (x.children ?? []).map((v) => [v.k, v] as const)));
  for (const sc of screens) {
    // Pages have generations like components, so the designer can claim one (Phase 2).
    const key = sc.spec.k.replace(/^screen:/, "");
    const adopt = adoptFrom(key);
    // Placed components also as plain layers: a page built on the designer's design follows those where
    // the designer drew the component's look rather than placing it.
    const spec = inlineInstances(sc.spec, mains);
    // Designs that can be Live's base: proposals for this page that closed (implemented), not withdrawn ones.
    const closedClaims = [...store.ledger(), ...events].flatMap((e) =>
      e.kind === "closed" && e.component === key && e.how !== "accepted" ? [e.claim] : [],
    );
    // One page that can't be built doesn't stop the others (a half-done update left pages twice in Live).
    let rs: { id: string; stats: Stats };
    try {
      rs = await s.call<{ id: string; stats: Stats }>(
        "reconcileScreen",
        { spec, closedClaims, ...adopt, ...(adopt.adoptFrom ? {} : { specHash: specHashOf(spec) }) },
        { timeoutMs: 180_000 },
      );
    } catch (e) {
      notes.push(
        `${key}: couldn't update this page in Live (${(e as Error).message}) — the rest of the update went on; it's tried again next time`,
      );
      step(key);
      continue;
    }
    liveIds[key] = rs.id;
    const shot = input.shots?.[key];
    if (shot)
      await s.call("placeShot", { k: sc.spec.k, ...shot }).catch((e: Error) => {
        notes.push(`${key}: couldn't show the app's screenshot beside the page (${e.message})`);
      });
    recordDifferences(key, sc.spec.k, rs.stats);
    await generated(key, rs.id, canon(await s.call<Snap>("snapshot", { id: rs.id })), true);
    // A designer's new page whose story now exists: built → close it (like a new component).
    const before = ledgerBefore.get(key);
    if (before?.state === "design_new" && before.claim) {
      const p = proposalsBefore.find((x) => x.role === "proposal" && x.claim.id === before.claim!.id);
      events.push({
        id: `closed_${before.claim.id}`,
        at: now(),
        by: "cli",
        component: key,
        kind: "closed",
        claim: before.claim.id,
        commit,
        items: [],
      });
      if (p) await s.call("archiveProposal", { nodeId: p.nodeId });
      log(`closed: ${key} — the new page is built and now in Live → Pages (compare with: codesignflo verify --screens)`);
    }
    step(key);
  }
  // Where each linked Library component differs from what the code draws (the designer's to decide).
  if (system) {
    const pairs = await s.call<{ k: string; lines: string[] }[]>("dsReport", {}).catch(() => []);
    for (const p of Array.isArray(pairs) ? pairs : [])
      for (const l of p.lines ?? []) notes.push(`${p.k}: differs from your Library — ${l}`);
  }
  // Components built early can still change while later ones are built (the instances inside them follow
  // their main components a moment later): what Live shows now is the generation to check the next hand
  // edits against — not the in-between state (a shell's sidebar "moved" and looked edited by hand).
  for (const b of builtSets) {
    const now2 = canon(await s.call<Snap>("snapshot", { id: b.id }));
    const g2 = generationOf(now2);
    if (g2 === b.gen) continue;
    await s.call("setGen", { id: b.id, gen: g2 });
    if (!(await store.generation(b.key, g2))) await store.saveGeneration(b.key, g2, now2);
    const e = events.find((x) => x.kind === "generated" && x.component === b.key && x.gen === b.gen);
    if (e && e.kind === "generated") Object.assign(e, { id: e.id.replace(b.gen, g2), gen: g2, fingerprint: g2 });
    else
      events.push({
        id: `gen_${b.key}_${generations(b.key)}_${g2}`,
        at: now(),
        by: "cli",
        component: b.key,
        kind: "generated",
        gen: g2,
        commit,
        fingerprint: g2,
      });
  }
  if (screens.length)
    log(
      `screens: ${screens.map((x) => `${x.spec.name} (${Math.round((100 * x.coverage.inInstances) / x.coverage.nodes)}% from library)`).join(", ")}`,
    );
  // Components and pages the code no longer has: Live's copy moves to Archive (never deleted — the designer
  // decides). Not while the designer has a proposal open for it, and not when an update would take away
  // most of Live at once (more likely a broken Storybook build than a decision).
  // (Not in an update of only some items: the others are still in the code.)
  const inCode = new Set([...sets.map((x) => x.k), ...screens.map((x) => x.spec.k)]);
  const liveRoots = input.only
    ? []
    : [
        ...Object.keys(liveIds).filter((k) => !k.startsWith("pages.") && !k.includes("/")),
        ...Object.keys(await s.call<Record<string, string>>("ids", { screens: true })).filter(
          (k) => k.startsWith("screen:") && !k.includes("/"),
        ),
      ].filter((k) => !inCode.has(k));
  const gone = liveRoots.filter((k) => {
    const st = ledgerBefore.get(k.replace(/^screen:/, ""));
    const open = st?.state === "in_design" || st?.state === "ready_for_dev";
    if (open) notes.push(`${k.replace(/^screen:/, "")}: no longer in the code, but the designer has a proposal open for it — kept in Live`);
    return !open;
  });
  const total = sets.length + screens.length + gone.length;
  if (gone.length > 3 && gone.length > total / 2)
    notes.push(
      `this update would remove ${gone.length} of ${total} components and pages from Live (${gone.join(", ")}) — held back: if they were really removed, they go with the next update that keeps most of Live`,
    );
  else
    for (const k of gone) {
      await s.call("archiveLive", { k, commit });
      const key = k.replace(/^screen:/, "");
      delete liveIds[key];
      events.push({ id: `removed_${key}_${commit.slice(0, 8)}`, at: now(), by: "cli", component: key, kind: "removed_in_code", commit });
      log(`removed: ${key} — no longer in the code; Live's copy moved to Archive (the designer decides whether to delete it)`);
    }
  store.append(events);

  // 4. Designer's facts.
  const facts = await s.call<{ events: LedgerEvent[]; proposals: Proposal[] }>("readFacts");
  for (const e of store.append(facts.events))
    log(
      `designer: ${e.component} ${e.kind}${"note" in e && typeof e.note === "string" ? ` — ${designerText(e.note, 300)}` : ""} (${e.by})`,
    );
  if (facts.events.length) await s.call("ackEvents", { ids: facts.events.map((e) => e.id) });

  // A proposal edited after "Ready for dev" goes back to "In design" (its content no longer matches the hash).
  const edited: LedgerEvent[] = [];
  for (const p of facts.proposals.filter((x) => x.role === "proposal" && x.claim.readyHash)) {
    const st = fold(store.ledger()).get(p.claim.component);
    if (st?.state !== "ready_for_dev" || st.claim?.id !== p.claim.id) continue;
    const snap = await s.call<Snap>("snapshot", { id: p.nodeId });
    const now_ = hash(stringify(canonicalize(snap.tree, { variables: snap.variables, styles: snap.styles })));
    if (now_ !== p.claim.readyHash) {
      edited.push({
        id: `edited_${p.claim.id}_${now_.slice(0, 8)}`,
        at: now(),
        by: "sync",
        component: p.claim.component,
        kind: "proposal_changed_after_ready",
        claim: p.claim.id,
      });
      notes.push(`${p.claim.component}: the proposal was edited after "Ready for dev" — back to In design`);
    }
  }
  store.append(edited);

  // 5. Verify and close delivered proposals.
  const closing: LedgerEvent[] = [];
  // Every delivery for a proposal that is still open is rechecked until it closes (not only new commits).
  const openClaims = new Set(
    [...fold(store.ledger()).values()].filter((x) => x.claim && x.state === "ready_for_dev").map((x) => x.claim!.id),
  );
  // A delivery already answered (sent back) is not checked again: the designer has moved on (M6).
  const answered = new Set(store.ledger().map((e) => e.id));
  for (const t of input.deliveries.filter((x) => openClaims.has(x.claim) && !answered.has(`sentback_${x.claim}_${x.commit.slice(0, 8)}`))) {
    const st = fold(store.ledger()).get(t.component);
    if (!st?.claim || st.claim.id !== t.claim) continue;
    const proposal = facts.proposals.find((p) => p.claim.id === t.claim && p.role === "proposal");
    if (!proposal) continue;
    const live = canon(await s.call<Snap>("snapshot", { id: liveIds[t.component] }));
    // The designer's own variables count as the project tokens made from them (designer decides; M6).
    const designed = adoptForeignVariables(canon(await s.call<Snap>("snapshot", { id: proposal.nodeId })), projectTokens);
    const remaining = new Set(diff(live, designed).map((i) => i.id));
    const listed = t.changes.filter((c) => !t.items.length || t.items.includes(c.id));
    const open = listed.filter((c) => c.items.some((id) => remaining.has(id)));
    if (open.length) {
      notes.push(
        `${t.component}: ${listed.length - open.length}/${listed.length} changes landed; still open: ${open.map((c) => `${c.id} ${c.layer} ${c.prop}`).join(", ")}`,
      );
      continue;
    }
    // Everything the designer asked for landed → close. Otherwise send it back with the open questions.
    const notDelivered = t.changes.filter((c) => !listed.includes(c));
    if (notDelivered.length === 0) {
      closing.push({
        id: `closed_${t.claim}`,
        at: now(),
        by: "cli",
        component: t.component,
        kind: "closed",
        claim: t.claim,
        commit: t.commit,
        items: listed.map((c) => c.id),
      });
      await s.call("archiveProposal", { nodeId: proposal.nodeId });
      log(
        `closed: ${t.component} — all ${listed.length} changes verified in ${t.commit.slice(0, 7)}; the designer's copy moved to Archive`,
      );
    } else {
      const why = (c: Change) => t.why[c.id] ?? "not applied";
      const question = `Done in code: ${listed.map((c) => `${c.layer} ${c.prop}`).join(", ")}. Needs your decision: ${notDelivered.map((c) => `${c.layer} ${c.prop} — ${why(c)}`).join(" | ")}`;
      closing.push({
        id: `sentback_${t.claim}_${t.commit.slice(0, 8)}`,
        at: now(),
        by: "cli",
        component: t.component,
        kind: "sent_back",
        claim: t.claim,
        question,
      });
      log(
        `partly delivered: ${t.component} — ${listed.length} verified in ${t.commit.slice(0, 7)}, ${notDelivered.length} sent back to the designer with questions`,
      );
    }
  }
  store.append(closing);

  // 6. Deltas for ready proposals (baseline = the generation the claim was made from).
  const deltas = await computeDeltas(s, store, dtcg);
  // Closing by observation: the code now does what the designer asked — however it got there (Claude
  // Code, by hand, a merged PR, a ticket); no commit line needed. Also closes proposals with only
  // example text. The commit is the one that last changed the component.
  const done = deltas.filter((d) => d.changes.length === 0 && d.conflicts === 0);
  for (const d of done) {
    const landed = store
      .ledger()
      .filter((e) => e.kind === "generated" && e.component === d.component)
      .at(-1);
    const at = landed && "commit" in landed ? landed.commit : commit;
    store.append([
      { id: `closed_${d.claim}`, at: now(), by: "cli", component: d.component, kind: "closed", claim: d.claim, commit: at, items: [] },
    ]);
    await s.call("archiveProposal", { nodeId: d.nodeId });
    log(
      d.convergent
        ? `closed: ${d.component} — the code now matches the designer's copy (${d.convergent} change(s), in ${at.slice(0, 7)}); the copy moved to Archive`
        : `closed: ${d.component} — nothing to change in code (example text only); the copy moved to Archive`,
    );
  }
  for (const d of deltas)
    progress[d.component] = { done: d.convergent, total: d.convergent + d.conflicts + d.changes.reduce((n, c) => n + c.items.length, 0) };
  const left = deltas.filter((d) => !done.includes(d));
  for (const d of left)
    for (const f of d.changes.flatMap((c) => c.foreign ?? []))
      notes.push(`${d.component}: the designer used Figma variable ${f.variable} (${f.value}); delivering it adds the token ${f.token}`);
  for (const d of left)
    log(
      `ready: ${d.component} — ${d.changes.length} code change(s)${d.convergent ? ` left (${d.convergent} already in code)` : ""}${d.conflicts ? `, ${d.conflicts} conflicting (settle with: codesignflo resolve ${d.component} --design | --code "<why>")` : ""}${d.folder ? ` (${d.folder})` : ""}`,
    );

  // New designs: the designer's frame as a spec (canonical tree + picture) for building it.
  if (store.newDesign)
    for (const [component, st] of fold(store.ledger())) {
      if (st.state !== "design_new" || !st.claim) continue;
      const p = facts.proposals.find((x) => x.role === "proposal" && x.claim.id === st.claim!.id);
      if (!p) continue;
      const snap = await s.call<Snap>("snapshot", { id: p.nodeId });
      const where = await store.newDesign(
        component,
        st.claim.id,
        canonicalize(snap.tree, { variables: snap.variables, styles: snap.styles }),
        () => s.call<string>("exportNode", { id: p.nodeId }),
      );
      log(
        `new design: ${component} by ${st.claim.by} — ${designerText(st.claim.note ?? "", 300)} (${where}); build it with: codesignflo deliver ${component}`,
      );
    }

  // 7. The panel's index.
  const states = fold(store.ledger());
  const finalFacts = await s.call<{ proposals: Proposal[] }>("readFacts");
  // Where a merge was computed, "needs a look" follows it: only when code changes clash with the designer's.
  for (const d of left) {
    const st = states.get(d.component);
    if (st) st.conflict = d.conflicts > 0;
  }
  const keys = new Set(input.keys);
  const entries: IndexEntry[] = [...states.values()]
    .filter((x) => keys.has(x.component) || x.state === "design_new")
    .map((x) => ({
      ...indexEntry(x, liveIds, finalFacts.proposals, whatsNewBy, progress),
      ...(warnings[x.component] ? { warning: warnings[x.component] } : {}),
      ...(differsBy[x.component] ? { differs: differsBy[x.component] } : {}),
      ...(scoreBy[x.component] ? { score: scoreBy[x.component]!.score, fitted: scoreBy[x.component]!.fitted } : {}),
      ...(designMatchBy[x.component] ? { designMatch: designMatchBy[x.component] } : {}),
    }));
  await s.call("writeIndex", {
    entries,
    lastSyncAt: now(),
    lastSyncCommit: commit,
    // Only some were rebuilt: the others keep how they compared with the app last time.
    ...(input.only ? { updated: [...sets.map((x) => x.k), ...screens.map((x) => x.spec.k.replace(/^screen:/, ""))] } : {}),
  });
  return { states, notes };
}

/**
 * Three-way deltas for every proposal that is ready for dev: base = the stored generation the claim was made
 * from (or today's Live without one), ours = the designer's copy, theirs = Live now.
 */
export async function computeDeltas(s: Figma, store: Store, dtcg: Record<string, unknown>) {
  const facts = await s.call<{ proposals: Proposal[] }>("readFacts");
  const states = fold(store.ledger());
  // Live components, and Live pages under their page key ("screen:pages.cart-page" → "pages.cart-page").
  const pageIds = Object.entries(await s.call<Record<string, string>>("ids", { screens: true }))
    .filter(([k]) => k.startsWith("screen:") && !k.includes("/"))
    .map(([k, v]) => [k.slice("screen:".length), v] as const);
  const ids = { ...(await s.call<Record<string, string>>("ids", {})), ...Object.fromEntries(pageIds) };
  const projectTokens = new Set(tokenNames(dtcg).values());
  const out: {
    component: string;
    claim: string;
    /** The designer's copy. */
    nodeId: string;
    /** The designer's changes the code already has (made the same way). */
    convergent: number;
    note?: string;
    by: string;
    changes: Change[];
    content: Change[];
    conflicts: number;
    /** Visual changes in code since the claim's baseline (0 = code didn't move under the designer). */
    codeChanges: number;
    folder: string;
  }[] = [];
  for (const p of facts.proposals.filter((x) => x.role === "proposal")) {
    const st = states.get(p.claim.component);
    if (st?.state !== "ready_for_dev") continue;
    const liveId = ids[p.claim.component];
    // Not in Live (yet): a design claimed from a branch's lane, checked on that branch's syncs until it's merged.
    if (!liveId) continue;
    const theirs = canon(await s.call<Snap>("snapshot", { id: liveId }));
    // The ledger's baseline moves forward after a partial delivery; the copy's record keeps the original.
    const baseGen = st.claim?.baselineGen || p.claim.baselineGen;
    // Claimed from a branch's lane (no Live generation): the copy's own starting point is its base.
    const own = !baseGen || p.claim.branch ? await s.call<Raw | null>("proposalBase", { id: p.nodeId }).catch(() => null) : null;
    const base = withDataTags((baseGen && (await store.generation(p.claim.component, baseGen))) || own || theirs, theirs);
    // Variables the designer used that the code has since made into tokens are those tokens.
    const ours = adoptForeignVariables(withDataTags(canon(await s.call<Snap>("snapshot", { id: p.nodeId })), theirs), projectTokens);
    const designWins = store.ledger().some((e) => e.kind === "resolved" && e.claim === p.claim.id && e.take === "design");
    const { m, changes, content } = deltaFor({
      base,
      ours,
      theirs,
      dtcg,
      ...(p.claim.scopes ? { scopes: p.claim.scopes } : {}),
      designWins,
    });
    out.push({
      component: p.claim.component,
      claim: p.claim.id,
      nodeId: p.nodeId,
      convergent: m.summary.convergent,
      ...(p.claim.note ? { note: p.claim.note } : {}),
      by: p.claim.by,
      changes,
      content,
      conflicts: designWins ? 0 : m.summary.conflict,
      codeChanges: m.summary.codeChanges,
      folder: store.delta ? store.delta(p.claim.component, p.claim.id, m, changes, content, systemUses(ours)) : "",
    });
  }
  return out;
}

function indexEntry(
  s: ComponentState,
  live: Record<string, string>,
  proposals: Proposal[],
  whatsNewBy: Record<string, string>,
  progress: Record<string, { done: number; total: number }> = {},
): IndexEntry {
  const p = proposals.find((x) => x.role === "proposal" && x.claim.component === s.component);
  return {
    component: s.component,
    name: s.component,
    state: s.state,
    unseen: s.unseen,
    conflict: s.conflict,
    ...(s.lastGen ? { lastGen: s.lastGen } : {}),
    ...(live[s.component] ? { liveNodeId: live[s.component] } : {}),
    ...(whatsNewBy[s.component] ? { whatsNew: whatsNewBy[s.component] } : {}),
    ...(s.pins ? { pins: s.pins } : {}),
    ...(s.claim
      ? {
          claim: {
            id: s.claim.id,
            by: s.claim.by,
            baselineGen: s.claim.baselineGen,
            ...(s.claim.note ? { note: s.claim.note } : {}),
            ...(s.claim.question ? { question: s.claim.question } : {}),
            ...(p ? { proposalNodeId: p.nodeId } : {}),
            ...(progress[s.component]?.done ? progress[s.component] : {}),
          },
        }
      : {}),
  };
}
