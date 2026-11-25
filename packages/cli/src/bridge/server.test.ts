import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Bridge, type BridgeOptions, codeMatches, upgradeAllowed } from "./server.js";

const PLUGIN = { version: "0.4.6" };
const hello = (o: Record<string, unknown> = {}) => ({
  t: "hello",
  protocol: 2,
  secret: null,
  pairCode: "4821",
  plugin: PLUGIN,
  file: { name: "Shop", projectId: "p_aaaaaaaaaaaa", editorType: "figma" },
  user: { name: "Dana" },
  ...o,
});

let open: Bridge[] = [];
afterEach(async () => {
  await Promise.all(open.map((b) => b.close()));
  open = [];
});

let nextPort = 46000 + Math.floor(Math.random() * 1000);
async function bridge(opts: Partial<BridgeOptions> & { secretsFile: string }) {
  const b = new Bridge({ port: nextPort++, accept: { projectId: "p_aaaaaaaaaaaa" }, log: () => {}, ...opts });
  await b.listen();
  open.push(b);
  return b;
}
const secretsFile = (content?: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), "cdf-bridge-")), "paired.json");
  if (content !== undefined) writeFileSync(f, JSON.stringify(content));
  return f;
};

/** Connects, sends `first`, and collects what comes back until the socket closes or `until` matches. */
function talk(
  b: Bridge,
  first: unknown,
  opts: { headers?: Record<string, string>; until?: (m: { t: string }) => boolean } = {},
): Promise<{ messages: { t: string; [k: string]: unknown }[]; close?: number; refused?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}`, { headers: opts.headers ?? {} });
    const messages: { t: string }[] = [];
    ws.on("unexpected-response", (_req, res) => resolve({ messages, refused: res.statusCode }));
    ws.on("open", () => ws.send(typeof first === "string" ? first : JSON.stringify(first)));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      messages.push(m);
      if (opts.until?.(m)) {
        resolve({ messages: messages as never });
        ws.close();
      }
    });
    ws.on("close", (code) => resolve({ messages: messages as never, close: code }));
    ws.on("error", () => resolve({ messages: messages as never }));
  });
}

describe("bridge pairing", () => {
  it("a pair code that isn't the plugin's four digits is refused before anyone is asked", async () => {
    let asked = 0;
    const b = await bridge({ secretsFile: secretsFile(), approve: async () => !!++asked });
    for (const pairCode of ["", "12", "abcd", "12345"]) {
      const r = await talk(b, hello({ pairCode }));
      expect(r.close).toBe(1008);
      expect(r.messages.map((m) => m.t)).toEqual([]);
    }
    expect(asked).toBe(0);
  });

  it("the typed code must be non-empty and equal", () => {
    expect(codeMatches("", "")).toBe(false);
    expect(codeMatches("  ", "")).toBe(false);
    expect(codeMatches("4821", "4821")).toBe(true);
    expect(codeMatches(" 4821\n", "4821")).toBe(true);
    expect(codeMatches("4822", "4821")).toBe(false);
  });

  it("a malformed hello closes the connection without crashing the CLI", async () => {
    const b = await bridge({ secretsFile: secretsFile() });
    expect((await talk(b, { t: "hello" })).close).toBe(1008);
    expect((await talk(b, "not json")).close).toBe(1003);
  });

  it("a web page's Origin is refused; the plugin iframe's null Origin and none (scripts) get in", async () => {
    const b = await bridge({ secretsFile: secretsFile(), approve: async () => true });
    expect((await talk(b, hello(), { headers: { Origin: "https://evil.example" } })).refused).toBe(403);
    const fromPlugin = await talk(b, hello(), { headers: { Origin: "null" }, until: (m) => m.t === "welcome" });
    expect(fromPlugin.messages.map((m) => m.t)).toEqual(["awaiting_approval", "welcome"]);
  });

  it("only a loopback Host on the bridge's port (DNS rebinding)", () => {
    expect(upgradeAllowed({ host: "localhost:4517" }, 4517).ok).toBe(true);
    expect(upgradeAllowed({ host: "127.0.0.1:4517", origin: "null" }, 4517).ok).toBe(true);
    expect(upgradeAllowed({ host: "[::1]:4517" }, 4517).ok).toBe(true);
    expect(upgradeAllowed({ host: "evil.example:4517" }, 4517).ok).toBe(false);
    expect(upgradeAllowed({ host: "localhost:9999" }, 4517).ok).toBe(false);
    expect(upgradeAllowed({}, 4517).ok).toBe(false);
    expect(upgradeAllowed({ host: "localhost:4517", origin: "http://localhost:3000" }, 4517).ok).toBe(false);
  });

  it("before approval: one small frame, sent soon", async () => {
    const b = await bridge({ secretsFile: secretsFile(), helloTimeoutMs: 200 });
    const big = await talk(
      b,
      JSON.stringify(hello({ file: { name: "x".repeat(100_000), projectId: "p_aaaaaaaaaaaa", editorType: "figma" } })),
    );
    expect(big.messages).toEqual([]);
    expect(big.close).toBe(1009); // refused on the frame's header (message too big), never read whole
    const silent = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${b.port}`);
      ws.on("close", (code) => resolve(code));
    });
    expect(silent).toBe(1006);
  });

  it("after approval, large frames are fine again", async () => {
    const b = await bridge({ secretsFile: secretsFile(), approve: async () => true });
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}`);
    ws.on("open", () => ws.send(JSON.stringify(hello())));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === "req") ws.send(JSON.stringify({ t: "res", id: m.id, ok: true, result: "y".repeat(300_000) }));
    });
    const session = await b.waitForPlugin(5000);
    expect((await session.call<string>("ping")).length).toBe(300_000);
    ws.close();
  });

  it("a prompt that failed doesn't stop later pairings", async () => {
    let calls = 0;
    const b = await bridge({
      secretsFile: secretsFile(),
      approve: async () => {
        if (++calls === 1) throw new Error("stdin closed");
        return true;
      },
    });
    const first = await talk(b, hello());
    expect(first.messages.map((m) => m.t)).toEqual(["awaiting_approval", "rejected"]);
    const second = await talk(b, hello(), { until: (m) => m.t === "welcome" });
    expect(second.messages.at(-1)?.t).toBe("welcome");
  });
});

describe("paired secrets are per project", () => {
  it("a secret approved for one project asks again for another, then keeps the same secret", async () => {
    const file = secretsFile();
    const a = await bridge({ secretsFile: file, approve: async () => true });
    const got = await talk(a, hello(), { until: (m) => m.t === "welcome" });
    const secret = got.messages.at(-1)!.secret as string;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Same project: silent.
    const again = await talk(a, hello({ secret }), { until: (m) => m.t === "welcome" });
    expect(again.messages.map((m) => m.t)).toEqual(["welcome"]);
    await a.close();

    let asked = 0;
    const other = { name: "Other", projectId: "p_bbbbbbbbbbbb", editorType: "figma" };
    const b = await bridge({ secretsFile: file, accept: { projectId: "p_bbbbbbbbbbbb" }, approve: async () => !!++asked });
    const there = await talk(b, hello({ secret, file: other }), { until: (m) => m.t === "welcome" });
    expect(asked).toBe(1);
    expect(there.messages.map((m) => m.t)).toEqual(["awaiting_approval", "welcome"]);
    expect(there.messages.at(-1)!.secret).toBe(secret);
    expect(JSON.parse(readFileSync(file, "utf8"))[0].projects).toEqual(["p_aaaaaaaaaaaa", "p_bbbbbbbbbbbb"]);
  });

  it("a pairing from before (a bare secret) still works, and is bound to the project it connects for", async () => {
    const legacy = "ab".repeat(24);
    const file = secretsFile([legacy]);
    let asked = 0;
    const b = await bridge({ secretsFile: file, approve: async () => !!++asked });
    const r = await talk(b, hello({ secret: legacy }), { until: (m) => m.t === "welcome" });
    expect(r.messages.map((m) => m.t)).toEqual(["welcome"]);
    expect(asked).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ secret: legacy, projects: ["p_aaaaaaaaaaaa"] }]);
  });
});
