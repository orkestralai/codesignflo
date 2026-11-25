// The guided demo's project: one per person, with Alex (the simulated developer) and the sample app as its first
// Live update; reset starts over; its sends to dev never count toward the free sends and are never held.
// Against the local Supabase stack (skipped without it).
import { execSync } from "node:child_process";
import type { Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALEX } from "../mcp/demo.ts";
import { listen } from "../mcp/server.ts";

const env = (() => {
  try {
    const out = execSync("supabase status -o env", { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const get = (k: string) => new RegExp(`^${k}="?([^"\\n]+)`, "m").exec(out)?.[1];
    return { url: get("API_URL"), anon: get("ANON_KEY"), service: get("SERVICE_ROLE_KEY") };
  } catch {
    return { url: undefined, anon: undefined, service: undefined };
  }
})();
const run = env.url && env.anon && env.service ? describe : describe.skip;
const PORT = 3391;
const BASE = `http://localhost:${PORT}`;

async function person(name: string): Promise<{ db: SupabaseClient; token: string; id: string }> {
  const db = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const { data, error } = await db.auth.signUp({ email, password: "test-password-123" });
  if (error) throw error;
  return { db, token: data.session!.access_token, id: data.user!.id };
}

run("demo", { timeout: 60_000 }, () => {
  let srv: Server;
  const ops = () => createClient(env.url!, env.service!, { auth: { persistSession: false } });
  beforeAll(() => {
    srv = listen(
      { base: BASE, web: "http://localhost:3317", supabaseUrl: env.url!, anonKey: env.anon!, serviceKey: env.service!, cli: "codesignflo", cliEnv: {} },
      PORT,
    );
  });
  afterAll(() => srv?.close());

  it("starts, reuses and quits a person's demo; its sends never count", async () => {
    const dana = await person("demo-dana");
    const call = async (what: "start" | "quit", who: { token?: string }) =>
      fetch(`${BASE}/api/demo/${what}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(who.token ? { authorization: `Bearer ${who.token}` } : {}) },
        body: "{}",
      });
    const start = (who: { token?: string }) => call("start", who);
    expect((await start({})).status).toBe(401);

    const first = (await (await start(dana)).json()) as { projectId: string; fresh: boolean };
    expect(first.fresh).toBe(true);
    const p = first.projectId;
    // A demo project: Dana (admin) and Alex (developer).
    const { data: proj } = await ops().from("projects").select("name, owner, settings").eq("id", p).single();
    expect(proj).toMatchObject({ name: "CoDesignFlo demo", owner: dana.id, settings: { demo: true } });
    const { data: members } = await ops().from("project_members").select("role, user_id").eq("project_id", p);
    expect(members?.map((m) => m.role).sort()).toEqual(["admin", "developer"]);
    const dev = members!.find((m) => m.role === "developer")!.user_id as string;
    expect((await ops().from("profiles").select("email").eq("id", dev).single()).data).toEqual({ email: ALEX.email });
    // The sample shop, waiting for Dana's plugin: its components and pages, its pictures in the project's storage.
    const { data: live } = await ops().from("live_updates").select("status, kind, commit, bundle, payload").eq("project_id", p).single();
    expect(live).toMatchObject({ status: "pending", kind: "live", commit: "demo-1" });
    const bundle = JSON.parse(gunzipSync(Buffer.from(live!.bundle as string, "base64")).toString()) as { sets: { k: string }[]; screens: unknown[] };
    expect(bundle.sets.map((s) => s.k)).toEqual(expect.arrayContaining(["header", "footer", "product-card", "button", "cart-item"]));
    expect(bundle.screens).toHaveLength(3);
    const payload = live!.payload as { keys: string[]; media: string[] };
    expect(payload.keys).toEqual(expect.arrayContaining(["pages.home-page", "pages.product-page", "pages.cart-page"]));
    const stored = ((await ops().storage.from("media").list(p)).data ?? []).map((f) => f.name);
    // All the demo's pictures, the second stage's too (Alex's update uses them).
    expect(stored).toEqual(expect.arrayContaining(payload.media));

    // Again: the same demo (another file can use it).
    expect(await (await start(dana)).json()).toEqual({ projectId: p, fresh: false });

    // Demo sends never count, and are never held: 6 Ready for dev, all recorded, none used.
    const ev = (kind: string) =>
      dana.db.from("events").insert({ project_id: p, id: `${kind}_${Date.now()}_${Math.random()}`, at: new Date().toISOString(), by: "Dana", component: "button", kind, body: { claim: "c", note: "n", readyHash: "h" } });
    for (let i = 0; i < 6; i++) expect((await ev("ready")).error).toBeNull();
    expect(((await dana.db.rpc("my_sends")).data as { used: number }[])[0]!.used).toBe(0);

    // Quit: the demo goes with its history and pictures; Try a demo again starts a fresh one.
    expect(await (await call("quit", dana)).json()).toEqual({ quit: true });
    expect((await ops().from("projects").select("id").eq("id", p)).data).toEqual([]);
    expect((await ops().from("events").select("id").eq("project_id", p)).data).toEqual([]);
    expect((await ops().storage.from("media").list(p)).data ?? []).toEqual([]);
    expect(await (await call("quit", dana)).json()).toEqual({ quit: false });
    const again = (await (await start(dana)).json()) as { projectId: string; fresh: boolean };
    expect(again.fresh).toBe(true);
    expect(again.projectId).not.toBe(p);
  });

  it("Alex reviews, starts building, then builds the designer's change", { timeout: 60_000 }, async () => {
    const dana = await person("demo-alex");
    const call = async (what: string) =>
      (await (
        await fetch(`${BASE}/api/demo/${what}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${dana.token}` }, body: "{}" })
      ).json()) as Record<string, unknown>;
    const { projectId: p } = (await call("start")) as { projectId: string };
    // Dana's plugin applies the sample app.
    const applied = async () => ops().from("live_updates").update({ status: "applied" }).eq("project_id", p).eq("status", "pending");
    await applied();
    // Alex ships his feature first, with no design: the Free shipping badge, used on the product cards.
    expect(await call("tick")).toEqual({ did: "shipped", waiting: true });
    const shipped = (await ops().from("live_updates").select("commit, bundle").eq("project_id", p).eq("status", "pending").single()).data!;
    expect(shipped.commit).toBe("demo-2");
    const stage2 = JSON.parse(gunzipSync(Buffer.from(shipped.bundle as string, "base64")).toString()) as { sets: { k: string }[] };
    expect(stage2.sets.map((x) => x.k)).toContain("shipping-badge");
    // Once: applied, nothing else waits on Alex.
    await applied();
    expect(await call("tick")).toEqual({ did: "", waiting: false });

    // Dana claims the Button and sends a bluer copy (Live as claimed, and her copy).
    const variant = "button/disabled=false, leadingIcon=false, size=md, variant=primary";
    const paint = (r: number, g: number, b: number) => [{ color: { b, g, r }, opacity: 1, type: "SOLID", visible: true }];
    const base = { k: "button", type: "COMPONENT_SET", name: "button", children: [{ k: variant, type: "COMPONENT", name: "v", fills: paint(0.3098, 0.2745, 0.898) }] };
    const copy = structuredClone(base);
    copy.children[0]!.fills = paint(0, 0.4, 1);
    const at = new Date().toISOString();
    const claim = `c_${Date.now()}`;
    await dana.db.from("proposals").insert({ project_id: p, claim_id: claim, component: "button", payload: { base, copy, note: "Bluer" } });
    for (const [kind, body] of [
      ["claimed", { claim, baselineGen: "g0" }],
      ["ready", { claim, note: "Bluer", readyHash: "h" }],
    ] as const)
      expect((await dana.db.from("events").insert({ project_id: p, id: `${kind}_${claim}`, at, by: "Dana", component: "button", kind, body })).error).toBeNull();

    // 1. Review and start: his events, and an update of the Button as it is (only it).
    expect(await call("tick")).toEqual({ did: "reviewed", waiting: true });
    const kinds = async () => ((await ops().from("events").select("kind, by").eq("project_id", p).eq("by", "Alex")).data ?? []).map((e) => e.kind).sort();
    expect(await kinds()).toEqual(["building", "dev_reviewed"]);
    const newest = async () =>
      (await ops().from("live_updates").select("status, commit, bundle, payload").eq("project_id", p).order("id", { ascending: false }).limit(1).single()).data!;
    expect(await newest()).toMatchObject({ status: "pending", commit: `alex-${claim}-start`, payload: { only: ["button"] } });
    // Waits while his update isn't applied.
    expect(await call("tick")).toEqual({ did: "", waiting: true });
    await applied();

    // 2. Built (a moment after his update is applied): the Button's code now has Dana's colour, and the
    // proposal shows it done in code.
    let tick = await call("tick");
    for (let i = 0; i < 10 && tick.did === ""; i++) {
      await new Promise((r) => setTimeout(r, 500));
      tick = await call("tick");
    }
    expect(tick).toEqual({ did: "built", waiting: true });
    const built = await newest();
    expect(built).toMatchObject({ status: "pending", commit: `alex-${claim}` });
    const sets = (JSON.parse(gunzipSync(Buffer.from(built.bundle as string, "base64")).toString()) as { sets: { k: string; children: { k: string; props: { fills: string[] }; paintBind?: unknown }[] }[] }).sets;
    const v = sets.find((x) => x.k === "button")!.children.find((x) => x.k === variant)!;
    expect(v.props.fills).toEqual(["#0066ff"]);
    expect(v.paintBind).toBeUndefined();
    const check = (await ops().from("proposals").select("code_check").eq("project_id", p).eq("claim_id", claim).single()).data!.code_check;
    expect(check).toMatchObject({ done: 1, total: 1, exact: true });
  });
});
