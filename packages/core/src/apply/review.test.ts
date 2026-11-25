import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../ledger/events.js";
import { fold } from "../ledger/state.js";
import { figmaLink, reviewQueue, reviewQueueLines } from "./instructions.js";

let n = 0;
const ev = (component: string, kind: string, body: Record<string, unknown> = {}): LedgerEvent =>
  ({ id: `e${n++}`, at: new Date(Date.UTC(2026, 9, 11, 0, 0, n)).toISOString(), by: "dana", component, kind, ...body }) as LedgerEvent;

describe("the developer reviews designs one at a time before building", () => {
  const events = [
    ev("pages.checkout-page", "designed_new", { claim: "c1", note: "the checkout" }),
    ev("components.badge", "designed_new", { claim: "c2", note: "new badge" }),
    ev("components.card", "designed_new", { claim: "c3", note: "card" }),
  ];

  it("components before the pages that use them; the next one to review", () => {
    const q = reviewQueue([...fold(events).values()]);
    expect(q.map((s) => s.component)).toEqual(["components.badge", "components.card", "pages.checkout-page"]);
    expect(reviewQueueLines(q).at(-1)).toBe("Next to review: components.badge.");
  });

  it("decisions are kept on the proposal; a question waits for the designer's answer; then the next is to build", () => {
    const more = [
      ...events,
      ev("components.badge", "dev_reviewed", { claim: "c2", decision: "approved", plan: "reuse Chip, add a tone prop" }),
      ev("components.card", "dev_reviewed", { claim: "c3", decision: "questions", question: "hover state?" }),
      ev("pages.checkout-page", "dev_reviewed", { claim: "c1", decision: "later" }),
    ];
    let states = fold(more);
    expect(states.get("components.badge")?.claim?.review).toMatchObject({ decision: "approved", plan: "reuse Chip, add a tone prop" });
    expect(states.get("components.badge")?.state).toBe("design_new"); // reviewing doesn't move it
    let lines = reviewQueueLines(reviewQueue([...states.values()]));
    expect(lines.join("\n")).toMatch(/waiting for the designer's answer to "hover state\?"/);
    expect(lines.at(-1)).toBe("All reviewed. Next to build: components.badge.");
    states = fold([...more, ev("components.card", "review_answered", { claim: "c3", answer: "a light shadow" })]);
    lines = reviewQueueLines(reviewQueue([...states.values()]));
    expect(lines.at(-1)).toBe("Next to review: components.card.");
  });

  it("a link to the design in Figma when the file key is known, else where to find it", () => {
    expect(figmaLink({ nodeId: "12:34", fileKey: "AbC" }, "components.badge")).toBe("https://www.figma.com/design/AbC/?node-id=12-34");
    expect(figmaLink({ nodeId: "12:34", fileName: "Shop" }, "components.badge")).toMatch(/"Shop", page Proposals → components.badge/);
  });
});
