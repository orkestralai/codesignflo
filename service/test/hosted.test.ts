// Hosting: registration limits, what people can edit on a project, the realtime signal, the notifications
// outbox and its sender, waiting for the designer, and cleanup of expired sign-in leftovers — against the
// local Supabase stack (supabase start). Skipped when it isn't running.
import { execSync } from "node:child_process";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { message } from "../mcp/notify.ts";
import { listen } from "../mcp/server.ts";

const env = (() => {
  try {
    const out = execSync("supabase status -o env", {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const get = (k: string) => new RegExp(`^${k}="?([^"\\n]+)`, "m").exec(out)?.[1];
    return { url: get("API_URL"), anon: get("ANON_KEY"), service: get("SERVICE_ROLE_KEY") };
  } catch {
    return { url: undefined, anon: undefined, service: undefined };
  }
})();
const run = env.url && env.anon && env.service ? describe : describe.skip;
const PORT = 3397;
const BASE = `http://localhost:${PORT}`;
const SECRET = "test-notify-secret";

// `shown`: the name their account carries (a provider's name); events they write show it.
async function person(name: string, shown?: string): Promise<{ db: SupabaseClient; token: string; email: string }> {
  const db = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const { data, error } = await db.auth.signUp({ email, password: "test-password-123", ...(shown ? { options: { data: { name: shown } } } : {}) });
  if (error) throw error;
  return { db, token: data.session!.access_token, email };
}

run("hosting", { timeout: 60_000 }, () => {
  let srv: Server;
  const admin = () => createClient(env.url!, env.service!, { auth: { persistSession: false } });

  beforeAll(() => {
    srv = listen(
      {
        base: BASE,
        web: "http://localhost:3317",
        supabaseUrl: env.url!,
        anonKey: env.anon!,
        serviceKey: env.service!,
        cli: "codesignflo",
        cliEnv: {},
        notifySecret: SECRET,
        notify: {},
      },
      PORT,
    );
  });
  afterAll(() => srv?.close());

  it("registering MCP clients is limited per address", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const reg = () =>
      fetch(`${BASE}/register`, {
        method: "POST",
        headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
        body: JSON.stringify({ client_name: "Agent", redirect_uris: ["http://localhost:3999/cb"] }),
      });
    await admin().from("mcp_clients").delete().eq("ip", ip);
    for (let i = 0; i < 20; i++) expect((await reg()).status).toBe(201);
    expect((await reg()).status).toBe(429);
  });

  it("admins rename a project; plan, owner, code link and settings only change through the checked functions", async () => {
    const a = await person("owner");
    const id = (await a.db.rpc("create_project", { p_name: "Shop", p_root_commit: `root_${Date.now()}` })).data as string;
    expect((await a.db.from("projects").update({ name: "Shop 2" }).eq("id", id).select("name")).data).toEqual([{ name: "Shop 2" }]);
    expect((await a.db.from("projects").update({ plan: "paid" }).eq("id", id)).error?.message).toMatch(/permission denied/);
    expect(
      (
        await a.db
          .from("projects")
          .update({ settings: { liveBranch: "x" } })
          .eq("id", id)
      ).error?.message,
    ).toMatch(/permission denied/);
    expect((await a.db.rpc("set_live_branch", { p_project: id, p_branch: "main" })).error).toBeNull();
  });

  it("something happening in a project bumps its signal (members only see it)", async () => {
    const a = await person("sig");
    const stranger = await person("stranger");
    const id = (await a.db.rpc("create_project", { p_name: "Sig", p_root_commit: `root_s_${Date.now()}` })).data as string;
    const seq = async () => ((await a.db.from("project_signals").select("seq, what").eq("project_id", id)).data ?? [])[0];
    const before = (await seq())?.seq ?? 0;
    await a.db
      .from("events")
      .insert({
        project_id: id,
        id: "e1",
        at: new Date().toISOString(),
        by: "Dana",
        component: "components.badge",
        kind: "seen",
        body: {},
      });
    const after = await seq();
    expect(after!.seq).toBeGreaterThan(before);
    expect(after!.what).toBe("events");
    expect((await stranger.db.from("project_signals").select("seq").eq("project_id", id)).data).toEqual([]);
  });

  it("facts worth telling go to the outbox; /api/notify sends them (secret required) and marks them sent", async () => {
    const a = await person("notify");
    const id = (await a.db.rpc("create_project", { p_name: "Notify", p_root_commit: `root_n_${Date.now()}` })).data as string;
    const at = new Date().toISOString();
    await a.db.from("events").insert([
      {
        project_id: id,
        id: "r1",
        at,
        by: "Dana",
        component: "components.promo-banner",
        kind: "ready",
        body: { claim: "c1", note: "bigger title", readyHash: "h" },
      },
      { project_id: id, id: "s1", at, by: "Dana", component: "components.promo-banner", kind: "seen", body: {} },
    ]);
    const outbox = async () => (await admin().from("notifications").select("kind, sent_at").eq("project_id", id)).data ?? [];
    expect((await outbox()).map((n) => n.kind)).toEqual(["ready"]);
    // Nobody reads the outbox but the server; people can't.
    expect((await a.db.from("notifications").select("id").eq("project_id", id)).data).toEqual([]);

    expect((await fetch(`${BASE}/api/notify`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${BASE}/api/notify`, { method: "POST", headers: { "x-codesignflo-secret": "wrong" } })).status).toBe(401);
    // Sent oldest first, a batch at a time: other tests' facts in the local stack may come before this one.
    for (let i = 0; i < 20 && !(await outbox())[0]!.sent_at; i++) {
      const r = await fetch(`${BASE}/api/notify`, { method: "POST", headers: { "x-codesignflo-secret": SECRET } });
      expect(r.status).toBe(200);
    }
    expect((await outbox())[0]!.sent_at).toBeTruthy();

    // Slack is admins' to set, and only a Slack address.
    expect((await a.db.rpc("set_slack_webhook", { p_project: id, p_url: "https://evil.example/x" })).error?.message).toMatch(/Slack/);
    expect((await a.db.rpc("set_slack_webhook", { p_project: id, p_url: "https://hooks.slack.com/services/T/B/x" })).error).toBeNull();
    expect((await a.db.from("project_integrations").select("slack_webhook").eq("project_id", id)).data).toHaveLength(1);
    expect((await a.db.rpc("set_my_notifications", { p_email: false })).error).toBeNull();
    expect((await a.db.rpc("my_notifications")).data).toBe(false);
  });

  it("messages read as sentences", () => {
    expect(message({ kind: "ready", component: "components.promo-banner", by: "Dana", body: { note: "bigger title" } })).toBe(
      "Dana sent promo banner to development — “bigger title”",
    );
    expect(message({ kind: "live_failed", component: "", by: "main", body: { commit: "abcdef1234", log: "a\nfont missing" } })).toBe(
      "Live couldn't be updated from @abcdef1: font missing",
    );
  });

  it("wait_for_designer returns what happened since the last call", async () => {
    const a = await person("wait", "Dana");
    const id = (await a.db.rpc("create_project", { p_name: "Wait", p_root_commit: `root_w_${Date.now()}` })).data as string;
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${a.token}` } } }),
    );
    const call = async (args: Record<string, unknown>) =>
      ((await client.callTool({ name: "wait_for_designer", arguments: args })) as { content: { text: string }[] }).content[0]!.text;
    const idle = await call({ project: id, seconds: 1 });
    expect(idle).toMatch(/Nothing new yet\. after=(\d+)/);
    const after = Number(/after=(\d+)/.exec(idle)![1]);
    setTimeout(() => {
      void a.db
        .from("events")
        .insert({
          project_id: id,
          id: "q1",
          at: new Date().toISOString(),
          by: "Dana",
          component: "components.badge",
          kind: "review_answered",
          body: { claim: "c", answer: "yes, 8px" },
        })
        .then(({ error }) => error && console.error("INSERT", error));
    }, 1500);
    const got = await call({ project: id, seconds: 10, after });
    expect(got).toMatch(/Dana answered the questions on badge — “yes, 8px”/);
    await client.close();
  });

  it("expired sign-in leftovers are cleaned up", async () => {
    const db = admin();
    const old = new Date(Date.now() - 3600_000).toISOString();
    const u = await person("clean");
    const { data: user } = await db.auth.getUser(u.token);
    const id = (await u.db.rpc("create_project", { p_name: "Clean", p_root_commit: `root_c_${Date.now()}` })).data as string;
    await db
      .from("cli_tickets")
      .insert({ code_hash: `old_${Date.now()}`, user_id: user.user!.id, project_id: id, access_token: "x", created_at: old });
    await db.from("install_codes").insert({ code_hash: `old_${Date.now()}`, user_id: user.user!.id, refresh_token: "x", created_at: old });
    expect((await db.rpc("cleanup_expired")).error).toBeNull();
    expect(
      (
        await db
          .from("cli_tickets")
          .select("code_hash")
          .lt("created_at", new Date(Date.now() - 600_000).toISOString())
      ).data,
    ).toEqual([]);
    expect(
      (
        await db
          .from("install_codes")
          .select("code_hash")
          .lt("created_at", new Date(Date.now() - 600_000).toISOString())
      ).data,
    ).toEqual([]);
    // Not something people can call.
    expect((await u.db.rpc("cleanup_expired")).error).toBeTruthy();
  });
});
