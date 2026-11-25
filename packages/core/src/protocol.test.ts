import { describe, expect, it } from "vitest";
import { atLeast, Decoder, encode, type Message } from "./protocol.js";

describe("protocol", () => {
  it("round-trips a large message through chunks", () => {
    const msg: Message = { t: "res", id: "r1", ok: true, result: { big: "x".repeat(2_000_000) } };
    const frames = encode(msg, 100_000);
    expect(frames.length).toBeGreaterThan(10);
    const d = new Decoder();
    let out: Message | null = null;
    for (const f of [...frames].reverse()) out = d.push(f) ?? out; // out of order
    expect(out).toEqual(msg);
  });

  it("compares versions", () => {
    expect(atLeast("1.2.0", "1.1.9")).toBe(true);
    expect(atLeast("1.2.0", "1.2.0")).toBe(true);
    expect(atLeast("0.9.9", "1.0.0")).toBe(false);
  });
});
