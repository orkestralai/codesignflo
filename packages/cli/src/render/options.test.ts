import { describe, expect, it } from "vitest";
import { renderOptions } from "./options.js";

// orkestralai's preview (Storybook 8): a list of viewports, each story picks one.
const viewports = {
  designFrame: { name: "Design frame (1728)", styles: { width: "1728px", height: "1080px" } },
  widgetFrame: { name: "Widget frame (380×560)", styles: { width: "380px", height: "560px" } },
  fluid: { name: "Fluid", styles: { width: "100%", height: "100%" } },
};

describe("story render options", () => {
  it("nothing set: no options (the default size and clock)", () => {
    expect(renderOptions({})).toEqual({});
    expect(renderOptions({ parameters: { viewport: { viewports } } })).toEqual({});
  });

  it("Storybook 8: the viewport the story picks with defaultViewport", () => {
    expect(renderOptions({ parameters: { viewport: { viewports, defaultViewport: "designFrame" } } })).toEqual({
      size: { w: 1728, h: 1080 },
    });
    expect(renderOptions({ parameters: { viewport: { viewports, defaultViewport: "widgetFrame" } } })).toEqual({
      size: { w: 380, h: 560 },
    });
    expect(
      renderOptions({ parameters: { viewport: { viewports, defaultViewport: "designFrame", defaultOrientation: "landscape" } } }).size,
    ).toEqual({
      w: 1080,
      h: 1728,
    });
  });

  it('Storybook 8 as it really comes: globals.viewport is "reset" when nothing is chosen', () => {
    const raw = {
      parameters: { viewport: { viewports, defaultViewport: "designFrame" } },
      globals: { viewport: "reset", viewportRotated: false },
    };
    expect(renderOptions(raw, { viewport: "reset" }).size).toEqual({ w: 1728, h: 1080 });
    expect(renderOptions({ ...raw, globals: { viewport: "reset", viewportRotated: true } }).size).toEqual({ w: 1080, h: 1728 });
  });

  it("Storybook 9 and later: viewport options and the story's (or the project's) globals", () => {
    const viewport = { options: viewports };
    expect(renderOptions({ parameters: { viewport }, globals: { viewport: { value: "designFrame" } } }).size).toEqual({ w: 1728, h: 1080 });
    expect(renderOptions({ parameters: { viewport }, globals: { viewport: { value: "widgetFrame", isRotated: true } } }).size).toEqual({
      w: 560,
      h: 380,
    });
    expect(renderOptions({ parameters: { viewport } }, { viewport: { value: "designFrame" } }).size).toEqual({ w: 1728, h: 1080 });
    // The story's choice wins over the project's.
    expect(
      renderOptions({ parameters: { viewport }, globals: { viewport: "widgetFrame" } }, { viewport: { value: "designFrame" } }).size,
    ).toEqual({
      w: 380,
      h: 560,
    });
  });

  it("ignores viewports it can't size: unknown names, percentages, a disabled viewport", () => {
    expect(renderOptions({ parameters: { viewport: { viewports, defaultViewport: "iphone6" } } })).toEqual({});
    expect(renderOptions({ parameters: { viewport: { viewports, defaultViewport: "fluid" } } })).toEqual({});
    expect(renderOptions({ parameters: { viewport: { viewports, defaultViewport: "designFrame", disable: true } } })).toEqual({});
  });

  it("parameters.codesignflo: size (wins over the viewport), fullHeight, date", () => {
    const o = renderOptions({
      parameters: {
        viewport: { viewports, defaultViewport: "widgetFrame" },
        codesignflo: { size: { width: 1440, height: 900 }, fullHeight: true, date: "2026-11-10T09:30:00Z" },
      },
    });
    expect(o).toEqual({ size: { w: 1440, h: 900 }, fullHeight: true, date: new Date("2026-11-10T09:30:00Z") });
    expect(renderOptions({ parameters: { codesignflo: { fullHeight: "yes" } } })).toEqual({});
  });

  it("a date it can't read fails loudly instead of drawing the default", () => {
    expect(() => renderOptions({ parameters: { codesignflo: { date: "next tuesday" } } })).toThrow(/isn't a date/);
  });
});
