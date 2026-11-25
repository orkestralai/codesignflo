// fold(events) → per-component state, following the state machine in brief §3.3–3.4.
// Events come from two independent writers (CLI and plugin), so an event that doesn't fit the current
// state is not an error that stops the fold: it is recorded as a warning and ignored.
import { type LedgerEvent, ordered } from "./events.js";

export type State = "in_sync" | "in_design" | "ready_for_dev" | "design_new" | "code_new" | "ignored";

export type ComponentState = {
  component: string;
  state: State;
  /** Live was regenerated since the designer last looked. */
  unseen: boolean;
  /** Code moved after the claim's baseline (derived; never blocks). */
  conflict: boolean;
  lastGen?: string;
  claim?: {
    id: string;
    by: string;
    baselineGen: string;
    note?: string;
    readyHash?: string;
    delivered?: string;
    question?: string;
    /** The developer building it (who, since when), until it closes or they stop. */
    builder?: { by: string; at: string };
    /** The developer's review of this proposal before building it (and the designer's answer to its questions). */
    review?: {
      decision: "approved" | "questions" | "later" | "skipped";
      by: string;
      at: string;
      plan?: string;
      question?: string;
      answer?: string;
    };
  };
  /** Kept as design in Live (by layer key): properties that don't follow the code, or ["*"] for whole layers. */
  pins?: Record<string, string[]>;
  /** The commit that removed it from the code (its Live copy is in Archive); cleared if it comes back. */
  removedInCode?: string;
  /** Bringing existing designs in: how the designer's design compared, and their decision. */
  compared?: { result: "matches" | "differs" | "design_only"; differences?: number; decision?: "design" | "code" | "later" };
  history: { at: string; event: string; from: State; to: State }[];
  warnings: string[];
};

const initial = (component: string): ComponentState => ({
  component,
  state: "in_sync",
  unseen: false,
  conflict: false,
  history: [],
  warnings: [],
});

export function fold(events: LedgerEvent[], start: Map<string, ComponentState> = new Map()): Map<string, ComponentState> {
  const out = new Map([...start].map(([k, v]) => [k, JSON.parse(JSON.stringify(v)) as ComponentState]));
  for (const e of ordered(events)) {
    const s = out.get(e.component) ?? initial(e.component);
    out.set(e.component, step(s, e));
  }
  return out;
}

/**
 * Applies one event to one component's state (mutates and returns `s`). The plugin uses it to show the
 * effect of the designer's own, not-yet-synced actions on top of the state mirrored at the last sync.
 */
export function step(s: ComponentState, e: LedgerEvent): ComponentState {
  {
    const from = s.state;
    const go = (to: State) => {
      if (to !== s.state) s.history.push({ at: e.at, event: e.kind, from: s.state, to });
      s.state = to;
    };
    const reject = (why: string) => s.warnings.push(`${e.at} ${e.kind}: ${why} (state ${from})`);
    const sameClaim = (id: string) => s.claim?.id === id;

    switch (e.kind) {
      case "registered":
        if (!s.lastGen) go(e.reviewed ? "in_sync" : "code_new");
        break;
      case "removed_in_code":
        s.removedInCode = e.commit;
        break;
      case "generated": {
        delete s.removedInCode;
        const changed = s.lastGen !== undefined && s.lastGen !== e.gen;
        s.lastGen = e.gen;
        if (changed && (s.state === "in_sync" || s.state === "code_new")) s.unseen = true;
        break;
      }
      case "seen":
        s.unseen = false;
        break;
      case "accepted":
        if (s.state === "code_new") go("in_sync");
        else reject("only a code_new component can be accepted");
        break;
      case "ignored":
        if (s.state === "code_new") go("ignored");
        else reject("only a code_new component can be ignored");
        break;
      case "claimed":
        if (s.state === "in_sync" || s.state === "code_new" || s.state === "ignored") {
          s.claim = { id: e.claim, by: e.by, baselineGen: e.baselineGen };
          s.unseen = false;
          go("in_design");
        } else reject("already claimed");
        break;
      case "unclaimed":
        if (sameClaim(e.claim) && (s.state === "in_design" || s.state === "ready_for_dev" || s.state === "design_new")) {
          s.claim = undefined;
          go("in_sync");
        } else reject("no matching open claim");
        break;
      case "ready":
        if (sameClaim(e.claim) && s.state === "in_design" && s.claim) {
          s.claim.note = e.note;
          s.claim.readyHash = e.readyHash;
          s.claim.question = undefined;
          // A new version: reviewed again.
          s.claim.review = undefined;
          go("ready_for_dev");
        } else reject("ready needs an open claim in design");
        break;
      case "resolved":
        // Recorded for the audit trail; "code" is followed by a sent_back, "design" by a delivery.
        if (!sameClaim(e.claim)) reject("no matching claim");
        break;
      case "reopened":
        if (sameClaim(e.claim) && s.state === "ready_for_dev") go("in_design");
        else if (!(sameClaim(e.claim) && s.state === "in_design")) reject("can only reopen a ready proposal");
        break;
      case "proposal_changed_after_ready":
        if (sameClaim(e.claim) && s.state === "ready_for_dev") go("in_design");
        break;
      case "sent_back":
        if (sameClaim(e.claim) && s.state === "ready_for_dev" && s.claim) {
          s.claim.question = e.question;
          // Part of it landed: the code that delivered it is the new base for the rest. Otherwise the
          // designer's own delivery reads as "code changed under the claim" (M6).
          if (s.lastGen) s.claim.baselineGen = s.lastGen;
          go("in_design");
        } else reject("can only send back a ready proposal");
        break;
      case "delivered":
        if (sameClaim(e.claim) && (s.state === "ready_for_dev" || s.state === "design_new") && s.claim) s.claim.delivered = e.ref ?? e.mode;
        else reject("can only deliver a ready proposal");
        break;
      case "closed":
        if (sameClaim(e.claim) && (s.state === "ready_for_dev" || s.state === "design_new")) {
          s.claim = undefined;
          s.unseen = false;
          go("in_sync");
        } else reject("no matching ready proposal");
        break;
      case "compared":
        s.compared = {
          result: e.result,
          ...(e.differences !== undefined ? { differences: e.differences } : {}),
          ...(e.decision ? { decision: e.decision } : {}),
        };
        break;
      case "review_requested":
        if (s.state === "in_sync") go("code_new");
        else reject("only a component in sync goes back to review");
        break;
      case "kept": {
        const pins = { ...(s.pins ?? {}) };
        for (const p of e.pins) pins[p.key] = [...new Set([...(pins[p.key] ?? []), ...p.props])];
        s.pins = pins;
        break;
      }
      case "unkept": {
        const pins = { ...(s.pins ?? {}) };
        const left = (pins[e.key] ?? []).filter((x) => !e.props.includes(x));
        if (left.length) pins[e.key] = left;
        else delete pins[e.key];
        s.pins = Object.keys(pins).length ? pins : undefined;
        break;
      }
      case "dev_reviewed":
        if (sameClaim(e.claim) && s.claim && (s.state === "ready_for_dev" || s.state === "design_new"))
          s.claim.review = {
            decision: e.decision,
            by: e.by,
            at: e.at,
            ...(e.plan ? { plan: e.plan } : {}),
            ...(e.question ? { question: e.question } : {}),
          };
        else reject("can only review what the designer sent");
        break;
      case "building":
        if (sameClaim(e.claim) && s.claim && (s.state === "ready_for_dev" || s.state === "design_new"))
          s.claim.builder = { by: e.by, at: e.at };
        else reject("can only build what the designer sent");
        break;
      case "stopped_building":
        if (sameClaim(e.claim) && s.claim) delete s.claim.builder;
        else reject("no matching claim");
        break;
      case "review_answered":
        if (sameClaim(e.claim) && s.claim?.review) s.claim.review.answer = e.answer;
        else reject("no review to answer");
        break;
      case "designed_new":
        if (!s.lastGen && !s.claim) {
          s.claim = { id: e.claim, by: e.by, baselineGen: "", note: e.note };
          go("design_new");
        } else reject("component already exists in code");
        break;
    }
    // Conflict is derived: an open claim whose baseline is no longer the latest generation.
    s.conflict = !!s.claim && s.claim.baselineGen !== "" && s.lastGen !== undefined && s.lastGen !== s.claim.baselineGen;
  }
  return s;
}

export const initialState = initial;
