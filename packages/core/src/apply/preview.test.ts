import { describe, expect, it } from "vitest";
import type { SpecNode } from "../compile/compile.js";
import type { Figma, UpdateInput } from "./apply.js";
import { applyPreview, previewItems } from "./preview.js";

const variant = (k: string, fill: string): SpecNode => ({ k, type: "COMPONENT", name: k, props: { fills: [fill] } }) as unknown as SpecNode;
const set = (k: string, fill: string): SpecNode =>
  ({ k, type: "COMPONENT_SET", name: k, props: {}, children: [variant(`${k}/state=default`, fill)] }) as unknown as SpecNode;
const page = (k: string, uses: string): SpecNode =>
  ({
    k,
    type: "FRAME",
    name: k,
    props: {},
    children: [{ k: `${k}/btn`, type: "INSTANCE", name: "btn", props: {}, instance: { mainK: `${uses}/state=default`, overrides: [] } }],
  }) as unknown as SpecNode;
const input = (buttonFill: string): UpdateInput =>
  ({
    sets: [set("components.button", buttonFill), set("components.badge", "#000")],
    screens: [
      { spec: page("screen:pages.home", "components.button"), coverage: { nodes: 1, inInstances: 1, instances: {} } },
      { spec: page("screen:pages.about", "components.badge"), coverage: { nodes: 1, inInstances: 1, instances: {} } },
    ],
    dtcg: {},
    commit: "abc1234",
    keys: [],
    deliveries: [],
  }) as unknown as UpdateInput;

describe("branch previews", () => {
  it("a page that places a changed component differs too (its hash has the component's layers in)", () => {
    const before = Object.fromEntries(previewItems(input("#fff")).map((x) => [x.key, x.hash]));
    const after = Object.fromEntries(previewItems(input("#f00")).map((x) => [x.key, x.hash]));
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    expect(changed.sort()).toEqual(["components.button", "screen:pages.home"]);
  });

  it("builds only what differs from Live, in the branch's section, and records nothing", async () => {
    const live = Object.fromEntries(previewItems(input("#fff")).map((x) => [x.key, x.hash]));
    const calls: [string, Record<string, unknown>][] = [];
    const s: Figma = {
      call: async <T>(method: string, params?: unknown) => {
        const p = (params ?? {}) as Record<string, unknown>;
        calls.push([method, p]);
        if (method === "previewPlan") {
          const hashes = p.hashes as Record<string, string>;
          return { differ: Object.keys(hashes).filter((k) => live[k] !== hashes[k]), onlyInLive: ["components.old"] } as T;
        }
        if (method === "reconcile" || method === "reconcileScreen") return { id: "1", stats: { errors: [] } } as T;
        return {} as T;
      },
    };
    const lines: string[] = [];
    const r = await applyPreview(s, input("#f00"), "feature-x", (l) => lines.push(l));
    expect(r.built).toEqual(["components.button", "pages.home"]);
    expect(r.removed).toEqual(["components.old"]);
    // readFacts: the designs this branch builds, checked against what the lane built (read only).
    expect(calls.map(([m]) => m)).toEqual(["previewPlan", "previewStart", "reconcile", "reconcileScreen", "readFacts", "previewEnd"]);
    expect(calls[1]![1]).toMatchObject({ branch: "feature-x", keep: ["components.button", "screen:pages.home"] });
    expect(calls[2]![1]).toMatchObject({ preview: "feature-x" });
    expect(calls[3]![1]).toMatchObject({ preview: "feature-x" });
    // Nothing that touches Live, its tokens or the history.
    expect(calls.some(([m]) => /tokensPush|setGen|writeIndex|ackEvents|archive/.test(m))).toBe(false);
    expect(lines.some((l) => l.includes("not on feature-x (removed there): components.old"))).toBe(true);
    // A one-off preview: no lane, no designs to mark.
    expect(calls[5]![1]).not.toHaveProperty("lane");
    expect(calls[5]![1]).toMatchObject({ designs: [] });
  });

  it("a connected branch's lane: who connected it and the designs it builds go to the plugin", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const s: Figma = {
      call: async <T>(method: string, params?: unknown) => {
        calls.push([method, (params ?? {}) as Record<string, unknown>]);
        if (method === "previewPlan") return { differ: [], onlyInLive: [] } as T;
        return {} as T;
      },
    };
    const designs = [{ claim: "c1", component: "components.button", done: 2, total: 3 }];
    await applyPreview(s, { ...input("#f00"), lane: { by: "Marco" }, designs }, "feat/checkout", () => undefined);
    expect(calls.find(([m]) => m === "previewEnd")![1]).toMatchObject({ branch: "feat/checkout", lane: { by: "Marco" }, designs });
  });
});
