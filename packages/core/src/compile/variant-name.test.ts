import { describe, expect, it } from "vitest";
import { variantName } from "./compile.js";

describe("variant names Figma accepts", () => {
  it("keeps valid names as they are", () => {
    expect(variantName({ variant: "primary", size: "md" })).toBe("size=md, variant=primary");
  });
  it("an empty value is 'default'; '=' and ',' inside a value become spaces", () => {
    expect(variantName({ variant: "" })).toBe("variant=default");
    expect(variantName({ label: "a=b, c" })).toBe("label=a b  c");
  });
});
