import { describe, expect, it } from "vitest";
import { inlineInstances, type SpecNode } from "../compile/compile.js";
import { specChanges, specsByKey } from "./patch.js";

const text = (k: string, characters: string): SpecNode => ({
  k,
  type: "TEXT",
  name: k.split("/").pop()!,
  props: { characters, fills: ["#000000"] },
});

describe("Live built on the design: what the code changed", () => {
  it("only the fields the code changed, with a changed token's value", () => {
    const prev: SpecNode = {
      k: "a",
      type: "FRAME",
      name: "a",
      props: { paddingTop: 8, itemSpacing: 4, fills: ["#ffffff"] },
      bind: { paddingTop: "space/2" },
    };
    const next: SpecNode = { ...prev, props: { paddingTop: 16, itemSpacing: 4, fills: ["#ffffff"] }, bind: { paddingTop: "space/4" } };
    expect(specChanges(prev, next)).toEqual({ props: { paddingTop: 16 }, bind: { paddingTop: "space/4" }, paintBind: {} });
    expect(specChanges(prev, prev)).toBeNull();
  });

  it("a placed component as plain layers: its main's layers under the instance key, with its overrides and size", () => {
    const main: SpecNode = {
      k: "components.button/variant=primary",
      type: "COMPONENT",
      name: "variant=primary",
      props: { width: 120, paddingTop: 8 },
      children: [text("components.button/variant=primary/label", "Button")],
    };
    const page: SpecNode = {
      k: "screen:p",
      type: "FRAME",
      name: "p",
      props: {},
      children: [
        {
          k: "screen:p/save",
          type: "INSTANCE",
          name: "save",
          props: { layoutSizingHorizontal: "FIXED", width: 200 },
          instance: {
            mainK: main.k,
            overrides: [
              { path: ["label"], characters: "Save" },
              { path: [], layout: { paddingTop: 12 } },
            ],
          },
        },
      ],
    };
    const out = inlineInstances(page, new Map([[main.k, main]]));
    const inl = out.children![0]!.inlined!;
    expect(inl.type).toBe("FRAME");
    expect(inl.props).toMatchObject({ width: 200, paddingTop: 12 });
    expect(inl.children![0]).toMatchObject({ k: "screen:p/save/label", props: { characters: "Save" } });
    // Followed where the design drew it as layers, the instance otherwise.
    expect([...specsByKey(out, (s) => s.inlined ?? s).keys()]).toEqual(["screen:p", "screen:p/save", "screen:p/save/label"]);
    expect([...specsByKey(out).keys()]).toEqual(["screen:p", "screen:p/save"]);
  });
});
