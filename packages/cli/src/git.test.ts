import { describe, expect, it } from "vitest";
import { parseTrailers } from "./git.js";

const rec = (commit: string, body: string) => `${commit}\x1f${body}\x1e`;

describe("CoDesignFlo trailers", () => {
  it("found in git's trailer block", () => {
    const log = rec("a1", "Apply\n\nCoDesignFlo: badge claim=c1 items=C1,C2\nCo-Authored-By: X <x@y>\n");
    expect(parseTrailers(log)).toEqual([{ commit: "a1", component: "badge", claim: "c1", items: ["C1", "C2"] }]);
  });
  it("found in its own paragraph before another trailer paragraph", () => {
    const log = rec("b2", "Apply\n\nCoDesignFlo: badge claim=c1 items=C1\n\nCo-Authored-By: X <x@y>\n");
    expect(parseTrailers(log).map((t) => t.claim)).toEqual(["c1"]);
  });
  it("ignores mentions inside prose", () => {
    expect(parseTrailers(rec("c3", "Docs: explain the CoDesignFlo: trailer format\n"))).toEqual([]);
  });
});
