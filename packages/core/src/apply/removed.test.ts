import { describe, expect, it } from "vitest";
import type { SpecNode } from "../compile/compile.js";
import type { LedgerEvent } from "../ledger/events.js";
import { applyUpdate, type Figma, type Store } from "./apply.js";

/** A stand-in for the plugin: Live has `live` component sets; records what it's asked to archive. */
function fakeFigma(live: string[]) {
  const archived: string[] = [];
  const reconciled: string[] = [];
  const s: Figma = {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      const p = params as Record<string, unknown> | undefined;
      const r: Record<string, unknown> = {
        tokensPush: { created: 0, writes: {} },
        ids: p?.screens ? {} : Object.fromEntries(live.map((k) => [k, `id-${k}`])),
        gens: {},
        readFacts: { events: [], proposals: [] },
        reconcile: {
          id: `id-${(p?.spec as SpecNode | undefined)?.k}`,
          stats: { created: 0, deleted: 0, moved: 0, writes: {}, errors: [] },
        },
        snapshot: { tree: { type: "COMPONENT_SET", name: "x", children: [] }, variables: {}, styles: {} },
      };
      if (method === "archiveLive") archived.push(p?.k as string);
      if (method === "reconcile") reconciled.push((p?.spec as SpecNode | undefined)?.k ?? "");
      return (r[method] ?? {}) as T;
    },
  };
  return { s, archived, reconciled };
}
const store = (events: LedgerEvent[] = []): Store => ({
  ledger: () => events,
  append: (more) => {
    events.push(...more);
    return more;
  },
  generation: async () => null,
  saveGeneration: async () => undefined,
});
const set = (k: string): SpecNode => ({ k, type: "COMPONENT_SET", name: k, props: {}, children: [] });
const input = (keys: string[]) => ({ sets: keys.map(set), screens: [], dtcg: {}, commit: "c0ffee00", keys, deliveries: [] });

describe("components removed from the code", () => {
  it("move to Archive and are recorded", async () => {
    const { s, archived } = fakeFigma(["badge", "button", "card", "tile"]);
    const events: LedgerEvent[] = [];
    await applyUpdate(s, store(events), input(["badge", "button", "card"]), () => undefined);
    expect(archived).toEqual(["tile"]);
    expect(events.filter((e) => e.kind === "removed_in_code").map((e) => e.component)).toEqual(["tile"]);
  });

  it("not while the designer has a proposal open for it", async () => {
    const { s, archived } = fakeFigma(["badge", "tile"]);
    const open: LedgerEvent[] = [
      { id: "c", at: "2026-01-01T00:00:00.000Z", by: "D", component: "tile", kind: "claimed", claim: "c1", baselineGen: "" },
    ];
    const notes: string[] = [];
    const r = await applyUpdate(s, store(open), input(["badge"]), () => undefined);
    notes.push(...r.notes);
    expect(archived).toEqual([]);
    expect(notes.join(" ")).toMatch(/tile: no longer in the code, but the designer has a proposal open/);
  });

  it("held back when an update would empty most of Live (a broken build, not a decision)", async () => {
    const { s, archived } = fakeFigma(["a", "b", "c", "d", "e", "f"]);
    const r = await applyUpdate(s, store(), input(["a"]), () => undefined);
    expect(archived).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/would remove 5 of 6 .* held back/);
  });
});

describe("an update of only some items (building designs one at a time)", () => {
  it("rebuilds just those; nothing else is touched or counted as removed", async () => {
    const { s, archived, reconciled } = fakeFigma(["badge", "button", "card", "tile"]);
    const r = await applyUpdate(s, store(), { ...input(["badge", "button"]), only: ["badge"] }, () => undefined);
    expect(reconciled).toEqual(["badge"]);
    expect(archived).toEqual([]);
    expect(r.notes.join(" ")).not.toMatch(/remove/);
  });
});
