// The hosted MCP: OAuth sign-in as MCP clients do it (discovery, registration, PKCE) and its tools, against
// the local Supabase stack. The sign-in page's approval is the same call the page makes.
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const PORT = 3398;
const BASE = `http://localhost:${PORT}`;
const REDIRECT = "http://localhost:3999/callback";

run("hosted MCP: sign-in and tools", { timeout: 30_000 }, () => {
  let srv: Server;
  let access = "";
  let project = "";
  const verifier = randomBytes(32).toString("base64url");
  const form = (o: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(o).toString(),
  });

  beforeAll(() => {
    srv = listen(
      { base: BASE, web: "http://localhost:3317", supabaseUrl: env.url!, anonKey: env.anon!, serviceKey: env.service!, cli: "codesignflo", cliEnv: {} },
      PORT,
    );
  });
  afterAll(() => srv?.close());

  it("an agent signs in: 401 → discovery → registration → approval → PKCE code → tokens (once)", async () => {
    const r401 = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
    expect(r401.status).toBe(401);
    const meta = /resource_metadata="([^"]+)"/.exec(r401.headers.get("www-authenticate") ?? "")![1]!;
    const as = await (await fetch(`${(await (await fetch(meta)).json()).authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
    const reg = await (
      await fetch(as.registration_endpoint, { method: "POST", headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ client_name: "Test agent", redirect_uris: [REDIRECT] }) })
    ).json();
    expect((await fetch(as.registration_endpoint, { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) })).status).toBe(400);

    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "x" });
    const go = await fetch(`${as.authorization_endpoint}?${q}`, { redirect: "manual" });
    const request = new URL(go.headers.get("location")!).searchParams.get("mcp")!;
    expect(request).toBeTruthy();
    // An unknown redirect address is refused outright.
    expect((await fetch(`${as.authorization_endpoint}?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "http://localhost:1/x" })}`, { redirect: "manual" })).status).toBe(400);

    // The person signs in on the page and approves.
    const person = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
    const { data: s } = await person.auth.signUp({ email: `agent-${Date.now()}@example.test`, password: "test-password-123", options: { data: { name: "Dana" } } });
    project = (await person.rpc("create_project", { p_name: "Shop", p_root_commit: `root_${Date.now()}` })).data as string;
    const { data: ok } = await person.rpc("approve_mcp", { p_request: request, p_refresh_token: s.session!.refresh_token });
    const code = (ok as { code: string }[])[0]!.code;

    const wrong = await fetch(as.token_endpoint, form({ grant_type: "authorization_code", code, code_verifier: "nope", client_id: reg.client_id, redirect_uri: REDIRECT }));
    expect(wrong.status).toBe(400);
    const tok = await (
      await fetch(as.token_endpoint, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT }))
    ).json();
    expect(tok.access_token).toBeTruthy();
    const reuse = await fetch(as.token_endpoint, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT }));
    expect(reuse.status).toBe(400);
    const refreshed = await (await fetch(as.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token }))).json();
    access = refreshed.access_token;
    expect(access).toBeTruthy();
  });

  it("tools work as that person, and sync hands back a command with a short-lived token", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access}` } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["status", "get_proposal", "sync", "init", "invite", "auto_update", "pair_design"]));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((x) => x.text).join("\n"), error: !!r.isError };
    };
    expect((await call("status", { project })).text).toMatch(/Nothing is waiting on the developer/);
    const sync = (await call("sync", { project })).text;
    expect(sync).not.toMatch(/CODESIGNFLO_TOKEN|eyJ/);
    const ticket = /CODESIGNFLO_TICKET=(cdft_\w+) CODESIGNFLO_MCP=(\S+) codesignflo sync/.exec(sync)!;
    expect(ticket[2]).toBe(BASE);
    // Redeemed once: the sign-in, its project and where the service is; a second use gets nothing.
    const redeem = () => fetch(`${BASE}/ticket`, { method: "POST", body: JSON.stringify({ ticket: ticket[1] }) });
    const first = await redeem();
    expect(first.status).toBe(200);
    const got = await first.json();
    expect(got.project).toBe(project);
    expect(got.service.url).toBe(env.url);
    expect((await createClient(env.url!, env.anon!).auth.getUser(got.access_token)).data.user).toBeTruthy();
    expect((await redeem()).status).toBe(400);
    expect((await fetch(`${BASE}/ticket`, { method: "POST", body: JSON.stringify({ ticket: "cdft_nope" }) })).status).toBe(400);
    expect((await call("status", { project: "p_000000000000" })).error).toBe(true);
    await client.close();
  });

  it("the developer reviews a design before building: queue, review brief with the Figma link, decision, sync of only it", async () => {
    const db = createClient(env.url!, env.anon!, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${access}` } } });
    const at = new Date().toISOString();
    const { error: e1 } = await db.from("events").insert({
      project_id: project,
      id: "d1",
      at,
      by: "Dana",
      component: "components.badge",
      kind: "designed_new",
      body: { claim: "nd1", note: "a new badge" },
    });
    expect(e1).toBeNull();
    const spec = { type: "FRAME", name: "Badge", width: 60, height: 20, children: [] };
    const { error: e2 } = await db
      .from("proposals")
      .insert({ project_id: project, claim_id: "nd1", component: "components.badge", payload: { note: "a new badge", spec, figma: { nodeId: "1:2", fileKey: "FK" } } });
    expect(e2).toBeNull();
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((x) => x.text).join("\n"), error: !!r.isError };
    };
    const queue = (await call("review_queue", { project })).text;
    expect(queue).toMatch(/components.badge \(new component by Dana: "a new badge"\) — to review\. Figma: https:\/\/www.figma.com\/design\/FK\/\?node-id=1-2/);
    expect(queue).toMatch(/Next to review: components.badge/);
    const brief = (await call("get_proposal", { project, component: "components.badge", review: true })).text;
    expect(brief).toMatch(/^Review only — don't change any code yet/);
    expect(brief).toMatch(/The design, for the review:/);
    expect((await call("record_review", { project, component: "components.badge", decision: "questions" })).error).toBe(true);
    expect((await call("record_review", { project, component: "components.badge", decision: "approved", plan: "reuse Chip" })).text).toMatch(
      /approved\.\nAll reviewed\. Next to build: components.badge\./,
    );
    expect((await call("get_proposal", { project, component: "components.badge" })).text).toMatch(/ask the user once where designs are built/);
    expect((await call("set_build_mode", { project, mode: "storybook-first" })).error).toBe(false);
    const build = (await call("get_proposal", { project, component: "components.badge" })).text;
    expect(build).toMatch(/Build it in Storybook only for now/);
    expect(build).toMatch(/Approved in review — build it by this plan: reuse Chip/);
    expect((await call("status", { project })).text).toMatch(/Designs are built in Storybook first/);
    expect((await call("status", { project })).text).toMatch(/Review: 0 to review, 1 approved to build/);
    expect((await call("sync", { project, only: ["components.badge"] })).text).toMatch(/codesignflo sync --only components.badge/);
    const pair = (await call("pair_design", { project, component: "components.badge" })).text;
    expect(pair).toMatch(/set data-cdf="<that layer's name>"/);
    expect(pair).toMatch(/^Badge \(frame 60×20\)$/m);
    // Components without stories: the command to list them, and the prompt that writes them.
    expect((await call("missing_stories", { project })).text).toMatch(/^Run this in the app's folder[\s\S]*\ncodesignflo stories\n/);
    const prompts = (await client.listPrompts()).prompts.map((x) => x.name);
    expect(prompts).toContain("cover_components");
    const cover = await client.getPrompt({ name: "cover_components", arguments: {} });
    expect((cover.messages[0]!.content as { text: string }).text).toMatch(/title "Components\/<Name>"/);
    // Building it: the others see who's on it, and another developer doesn't start on it unknowingly.
    expect((await call("start_building", { project, component: "components.badge" })).text).toMatch(/you're building it/);
    const taken = (await call("review_queue", { project })).text;
    expect(taken).toMatch(/approved — plan: reuse Chip; \S+ is building it\./);
    expect(taken).toMatch(/All reviewed\.$/);
    // Another developer of the project (an event's author is its real account, so a second account).
    const marcoDb = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
    const marco = `marco-${Date.now()}@example.test`;
    expect((await marcoDb.auth.signUp({ email: marco, password: "test-password-123" })).error).toBeNull();
    expect((await db.rpc("invite", { p_project: project, p_email: marco, p_role: "developer", p_email_them: false })).data).toBe("added");
    const { error: e3 } = await marcoDb.from("events").insert({
      project_id: project,
      id: "b2",
      at: new Date().toISOString(),
      by: marco,
      component: "components.badge",
      kind: "building",
      body: { claim: "nd1" },
    });
    expect(e3).toBeNull();
    expect((await call("get_proposal", { project, component: "components.badge" })).text).toMatch(new RegExp(`^${marco} is building this`));
    expect((await call("start_building", { project, component: "components.badge" })).error).toBe(true);
    expect((await call("start_building", { project, component: "components.badge", take_over: true })).text).toMatch(new RegExp(`taken over from ${marco}`));
    expect((await call("start_building", { project, component: "components.badge", stop: true })).text).toMatch(/handed back/);
    // A problem with CoDesignFlo itself, reported by the agent: the report's words, no log (content not shared).
    const sent = await call("report_issue", { project, title: "Live drew the badge twice", what_happened: "two badges in Live", cli_version: "0.2.7" });
    expect(sent.text).toMatch(/^Sent to CoDesignFlo's team \(the report only/);
    // Each tool call is timed (sent in the background: given a moment). Read as the operators (developers can't).
    const ops = createClient(env.url!, env.service!, { auth: { persistSession: false } });
    let rows: { source: string; kind: string; signature: string; data: Record<string, unknown>; content: string | null }[] = [];
    for (let i = 0; i < 20 && !rows.some((r) => r.signature === "mcp.review_queue"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = ((await ops.from("telemetry").select("source, kind, signature, data, content").eq("project_id", project)).data ?? []) as typeof rows;
    }
    const report = rows.find((r) => r.kind === "report");
    expect(report).toMatchObject({ source: "agent", signature: "report: Live drew the badge twice", content: null });
    expect(report?.data).toMatchObject({ title: "Live drew the badge twice", what_happened: "two badges in Live" });
    expect(rows.some((r) => r.source === "mcp" && r.kind === "timing" && r.signature === "mcp.review_queue")).toBe(true);
    // The designer hears that someone started building it.
    const told = ((await ops.from("notifications").select("kind, by").eq("project_id", project).eq("kind", "building")).data ?? []) as { by: string }[];
    expect(told.map((x) => x.by)).toContain(marco);
    // A tool that failed: recorded as an error, by its shape.
    expect(rows.some((r) => r.source === "mcp" && r.kind === "error" && r.signature.startsWith("mcp record_review:"))).toBe(true);
    await client.close();
  });
});
