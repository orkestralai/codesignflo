import { describe, expect, it } from "vitest";
import { diff } from "../diff/diff.js";
import type { LedgerEvent } from "../ledger/events.js";
import { fold } from "../ledger/state.js";
import type { Raw } from "../snapshot/canonical.js";
import { matchByName } from "./instructions.js";

const row = (padding: number, extra: Partial<Raw> = {}, children: Raw[] = []): Raw => ({
  type: "FRAME",
  name: "Row",
  k: "row",
  layout: { mode: "HORIZONTAL", paddingTop: padding, paddingBottom: padding, paddingLeft: 0, paddingRight: 0, itemSpacing: 8 },
  opacity: 1,
  ...extra,
  children: [{ type: "TEXT", name: "title", k: "row/title", characters: "Tote" }, ...children],
});

describe("kept as design (pins)", () => {
  it("a pinned property is not a difference; others still are", () => {
    const live = row(16, { pin: ["padding"], opacity: 0.5 });
    expect(diff(row(12), live).map((i) => i.prop)).toEqual(["opacity"]);
    expect(
      diff(row(12), live, { pins: false })
        .map((i) => i.prop)
        .sort(),
    ).toEqual(["opacity", "padding"]);
  });

  it("a layer kept whole — and everything in it — is not a difference, nor is the pin itself", () => {
    const illustration: Raw = {
      type: "FRAME",
      name: "illustration",
      k: "row/+illustration",
      pin: ["*"],
      children: [{ type: "RECTANGLE", name: "blob" }],
    };
    expect(diff(row(12), row(12, {}, [illustration]))).toEqual([]);
  });

  it("the history keeps what is pinned, and lets it go", () => {
    const at = (n: number) => `2026-10-09T10:00:0${n}.000Z`;
    const e = (n: number, x: Partial<LedgerEvent>) => ({ id: `e${n}`, at: at(n), by: "D", component: "row", ...x }) as LedgerEvent;
    const s = fold([
      e(1, {
        kind: "kept",
        claim: "c1",
        pins: [
          { key: "row", props: ["padding", "opacity"] },
          { key: "row/+illustration", props: ["*"] },
        ],
      }),
      e(2, { kind: "unkept", key: "row", props: ["opacity"] }),
      e(3, { kind: "unkept", key: "row/+illustration", props: ["*"] }),
    ]).get("row")!;
    expect(s.pins).toEqual({ row: ["padding"] });
  });
});

describe("bringing existing designs in", () => {
  it("matches the designer's names with the code's keys, each key once", () => {
    const m = matchByName(
      [
        { id: "1", name: "Cart item" },
        { id: "2", name: "Components/ProductCard" },
        { id: "3", name: "Cart" },
        { id: "4", name: "cart-item copy" },
        { id: "5", name: "Hero" },
      ],
      ["cart-item", "product-card", "pages.cart-page"],
    );
    expect(m).toEqual({ "1": "cart-item", "2": "product-card", "3": "pages.cart-page", "4": null, "5": null });
  });

  it("a component only in code goes back to the designer for review; comparisons are kept", () => {
    const e = (n: number, x: Partial<LedgerEvent>) =>
      ({ id: `e${n}`, at: `2026-10-09T10:00:0${n}.000Z`, by: "D", component: "badge", ...x }) as LedgerEvent;
    const s = fold([
      e(1, { kind: "registered", reviewed: true }),
      e(2, { kind: "generated", gen: "g1", commit: "c", fingerprint: "g1" }),
      e(3, { kind: "review_requested" }),
      e(4, { kind: "compared", result: "differs", differences: 3, decision: "later" }),
    ]).get("badge")!;
    expect(s.state).toBe("code_new");
    expect(s.compared).toEqual({ result: "differs", differences: 3, decision: "later" });
  });
});
