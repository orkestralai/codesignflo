import { describe, expect, it } from "vitest";
import { markPresentation, presentationLayers } from "./presentation.js";

const light = { type: "ELLIPSE", name: "Traffic-Light", width: 12, height: 12 };
const page = (bar: object) => ({
  type: "FRAME",
  name: "inbox",
  width: 1728,
  height: 1117,
  children: [bar, { type: "FRAME", name: "Body", width: 1728, height: 1077, y: 40, children: [] }],
});

describe("presentation framing (a browser window bar is not app UI)", () => {
  it("finds a full-width bar at the top with three equal lights, and marks it for the developer", () => {
    const spec = page({ type: "FRAME", name: "Browser-Chrome-Bar", width: 1728, height: 40, y: 0, children: [light, light, light] });
    expect(presentationLayers(spec).map((l) => l.name)).toEqual(["Browser-Chrome-Bar"]);
    expect((markPresentation(spec).children[0] as { presentation?: string }).presentation).toMatch(/not app UI/);
  });

  it("leaves real UI alone: three dots in a typing bubble, a narrow toolbar", () => {
    const dots = { type: "FRAME", name: "Dots", width: 30, height: 6, y: 0, children: [light, light, light] };
    expect(presentationLayers(page(dots))).toEqual([]);
    const tall = { type: "FRAME", name: "Header", width: 1728, height: 86, y: 0, children: [light, light, light] };
    expect(presentationLayers(page(tall))).toEqual([]);
  });
});
