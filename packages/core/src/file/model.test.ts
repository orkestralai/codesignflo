import { describe, expect, it } from "vitest";
import { ClaimRecordSchema, IndexEntrySchema, MetaSchema } from "./model.js";

describe("file model", () => {
  it("validates records stored in the Figma file", () => {
    expect(MetaSchema.parse({ schema: 1, projectId: "p1" }).projectId).toBe("p1");
    expect(() => ClaimRecordSchema.parse({ id: "c1", component: "button" })).toThrow();
    expect(IndexEntrySchema.parse({ component: "button", name: "Button", state: "in_sync", unseen: false, conflict: false }).state).toBe(
      "in_sync",
    );
  });
});
