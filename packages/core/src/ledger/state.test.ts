import { describe, expect, it } from "vitest";
import { EventSchema, type LedgerEvent } from "./events.js";
import { fold } from "./state.js";

let n = 0;
const ev = (e: Record<string, unknown>): LedgerEvent =>
  EventSchema.parse({ id: `e${++n}`, at: `2026-10-05T10:${String(n).padStart(2, "0")}:00Z`, by: "dev", component: "card.product", ...e });
const run = (...events: LedgerEvent[]) => fold(events).get("card.product")!;

describe("ledger fold (brief §3.3–3.4)", () => {
  it("claim → ready → delivered → closed", () => {
    const s = run(
      ev({ kind: "registered", reviewed: true }),
      ev({ kind: "generated", gen: "g1", commit: "a", fingerprint: "f1" }),
      ev({ kind: "claimed", claim: "c1", baselineGen: "g1", by: "designer" }),
      ev({ kind: "ready", claim: "c1", note: "more room", readyHash: "h" }),
      ev({ kind: "delivered", claim: "c1", mode: "patch" }),
      ev({ kind: "closed", claim: "c1", commit: "b", items: ["C1"] }),
    );
    expect(s.state).toBe("in_sync");
    expect(s.history.map((h) => h.to)).toEqual(["in_design", "ready_for_dev", "in_sync"]);
    expect(s.warnings).toEqual([]);
  });

  it("a developer building what was sent: who and since when, until they stop or it closes", () => {
    const start = [
      ev({ kind: "registered", reviewed: true }),
      ev({ kind: "generated", gen: "g1", commit: "a", fingerprint: "f1" }),
      ev({ kind: "claimed", claim: "c1", baselineGen: "g1", by: "designer" }),
    ];
    // Nothing sent yet: nothing to build.
    expect(run(...start, ev({ kind: "building", claim: "c1", by: "marco" })).warnings).toHaveLength(1);
    const sent = [...start, ev({ kind: "ready", claim: "c1", note: "more room", readyHash: "h" })];
    const b = ev({ kind: "building", claim: "c1", by: "marco" });
    expect(run(...sent, b).claim?.builder).toEqual({ by: "marco", at: b.at });
    expect(run(...sent, b, ev({ kind: "stopped_building", claim: "c1" })).claim?.builder).toBeUndefined();
    // A new version from the designer: still theirs to build.
    const again = run(...sent, b, ev({ kind: "reopened", claim: "c1" }), ev({ kind: "ready", claim: "c1", note: "v2", readyHash: "h2" }));
    expect(again.claim?.builder?.by).toBe("marco");
    expect(run(...sent, b, ev({ kind: "closed", claim: "c1", commit: "b", items: [] })).claim).toBeUndefined();
  });

  it("a new generation sets unseen; seen clears it", () => {
    const g1 = ev({ kind: "generated", gen: "g1", commit: "a", fingerprint: "f1" });
    const g2 = ev({ kind: "generated", gen: "g2", commit: "b", fingerprint: "f2" });
    expect(run(g1, g2).unseen).toBe(true);
    expect(run(g1, g2, ev({ kind: "seen" })).unseen).toBe(false);
  });

  it("code moving under a claim is a conflict flag, not a block", () => {
    const s = run(
      ev({ kind: "generated", gen: "g1", commit: "a", fingerprint: "f1" }),
      ev({ kind: "claimed", claim: "c1", baselineGen: "g1" }),
      ev({ kind: "generated", gen: "g2", commit: "b", fingerprint: "f2" }),
    );
    expect(s).toMatchObject({ state: "in_design", conflict: true });
  });

  it("sent back with a question, edited after ready, unclaim", () => {
    const g = ev({ kind: "generated", gen: "g1", commit: "a", fingerprint: "f1" });
    const c = ev({ kind: "claimed", claim: "c1", baselineGen: "g1" });
    const r = ev({ kind: "ready", claim: "c1", note: "x", readyHash: "h" });
    expect(run(g, c, r, ev({ kind: "sent_back", claim: "c1", question: "which size?" }))).toMatchObject({
      state: "in_design",
      claim: { question: "which size?" },
    });
    expect(run(g, c, r, ev({ kind: "proposal_changed_after_ready", claim: "c1" })).state).toBe("in_design");
    expect(run(g, c, ev({ kind: "unclaimed", claim: "c1" }))).toMatchObject({ state: "in_sync", claim: undefined });
  });

  it("code_new: accepted or ignored by the designer", () => {
    expect(run(ev({ kind: "registered", reviewed: false })).state).toBe("code_new");
    expect(run(ev({ kind: "registered", reviewed: false }), ev({ kind: "accepted" })).state).toBe("in_sync");
    expect(run(ev({ kind: "registered", reviewed: false }), ev({ kind: "ignored" })).state).toBe("ignored");
  });

  it("design_new until implemented and closed", () => {
    const s = run(ev({ kind: "designed_new", claim: "c9", note: "new card" }), ev({ kind: "closed", claim: "c9", commit: "z", items: [] }));
    expect(s.history.map((h) => h.to)).toEqual(["design_new", "in_sync"]);
  });

  it("a new design built in code: closed, then its first generation, is in sync and not 'changed in code'", () => {
    const s = run(
      ev({ kind: "designed_new", claim: "c9", note: "new card" }),
      ev({ kind: "closed", claim: "c9", commit: "z", items: [] }),
      ev({ kind: "generated", gen: "g1", commit: "z", fingerprint: "g1" }),
    );
    expect([s.state, s.unseen, s.lastGen, s.claim]).toEqual(["in_sync", false, "g1", undefined]);
  });

  it("a new design can be withdrawn before it is built", () => {
    const s = run(ev({ kind: "designed_new", claim: "c9", note: "new card" }), ev({ kind: "unclaimed", claim: "c9" }));
    expect([s.state, s.claim, s.warnings]).toEqual(["in_sync", undefined, []]);
  });

  it("out-of-order facts become warnings, not crashes", () => {
    const s = run(ev({ kind: "ready", claim: "nope", note: "x", readyHash: "h" }));
    expect(s.state).toBe("in_sync");
    expect(s.warnings).toHaveLength(1);
  });

  it("events are ordered by time then id, so mirroring order doesn't matter", () => {
    const a = ev({ kind: "generated", gen: "g1", commit: "a", fingerprint: "f1" });
    const b = ev({ kind: "claimed", claim: "c1", baselineGen: "g1" });
    expect(fold([b, a]).get("card.product")).toEqual(fold([a, b]).get("card.product"));
  });

  it("rejects a ready without a note", () => {
    expect(() =>
      EventSchema.parse({ id: "x", at: "t", by: "d", component: "c", kind: "ready", claim: "c1", note: "", readyHash: "h" }),
    ).toThrow();
  });
});

describe("step / fold from a mirrored start", () => {
  it("the panel overlays local design events on the state mirrored at the last sync", async () => {
    const { initialState, step } = await import("./state.js");
    const mirrored = { ...initialState("card.product"), lastGen: "g1" };
    const next = step(JSON.parse(JSON.stringify(mirrored)), ev({ kind: "claimed", claim: "c1", baselineGen: "g1" }));
    expect(next.state).toBe("in_design");
    const start = new Map([["card.product", mirrored]]);
    expect(fold([ev({ kind: "claimed", claim: "c1", baselineGen: "g1" })], start).get("card.product")?.state).toBe("in_design");
    expect(start.get("card.product")?.state).toBe("in_sync"); // start is not mutated
  });
});

describe("reopened (Keep editing)", () => {
  it("moves a ready proposal back to In design at once", () => {
    const s = fold([
      { id: "1", at: "2026-01-01T00:00:01Z", by: "d", component: "c", kind: "claimed", claim: "x", baselineGen: "g" },
      { id: "2", at: "2026-01-01T00:00:02Z", by: "d", component: "c", kind: "ready", claim: "x", note: "n", readyHash: "h" },
      { id: "3", at: "2026-01-01T00:00:03Z", by: "d", component: "c", kind: "reopened", claim: "x" },
    ]).get("c")!;
    expect([s.state, s.warnings]).toEqual(["in_design", []]);
  });
});

describe("sent back after a partial delivery", () => {
  it("rebases the claim on the delivered code: no false conflict", () => {
    const s = fold([
      { id: "0", at: "2026-01-01T00:00:00Z", by: "cli", component: "c", kind: "generated", gen: "g1", commit: "a", fingerprint: "g1" },
      { id: "1", at: "2026-01-01T00:00:01Z", by: "d", component: "c", kind: "claimed", claim: "x", baselineGen: "g1" },
      { id: "2", at: "2026-01-01T00:00:02Z", by: "d", component: "c", kind: "ready", claim: "x", note: "n", readyHash: "h" },
      { id: "3", at: "2026-01-01T00:00:03Z", by: "cli", component: "c", kind: "generated", gen: "g2", commit: "b", fingerprint: "g2" },
      { id: "4", at: "2026-01-01T00:00:04Z", by: "cli", component: "c", kind: "sent_back", claim: "x", question: "q" },
    ]).get("c")!;
    expect([s.state, s.conflict, s.claim?.baselineGen]).toEqual(["in_design", false, "g2"]);
  });
});
