import { describe, expect, it } from "vitest";
import { parseBoxShadow } from "./shadow.js";

describe("parseBoxShadow", () => {
  it("none → no effects", () => expect(parseBoxShadow("none")).toEqual([]));
  it("one drop shadow", () => {
    expect(parseBoxShadow("rgba(0, 0, 0, 0.1) 0px 1px 2px 0px")).toEqual([
      {
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: 0.1 },
        offset: { x: 0, y: 1 },
        radius: 2,
        spread: 0,
        visible: true,
        blendMode: "NORMAL",
      },
    ]);
  });
  it("several layers, inset, opaque rgb; Figma order is bottom-first", () => {
    const e = parseBoxShadow("rgb(255, 0, 0) 0px 0px 0px 1px inset, rgba(0, 0, 0, 0.2) 0px 4px 8px -2px");
    expect(e.map((x) => x.type)).toEqual(["DROP_SHADOW", "INNER_SHADOW"]);
    expect(e[0]).toMatchObject({ offset: { x: 0, y: 4 }, radius: 8, spread: -2, color: { a: 0.2 } });
    expect(e[1]).toMatchObject({ spread: 1, color: { r: 1, g: 0, b: 0, a: 1 } });
  });
});
