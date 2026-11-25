// Self-hosted mode (app_config mode = 'selfhost', CODESIGNFLO_MODE=selfhost): billing off (a designer whose free
// sends are used still sends), invite-only sign-up (the first account, an invitation, an allowed domain), billing
// endpoints answering 404, invitations without emails. Against the local Supabase stack; the mode is set only
// while this file runs and taken back afterwards (even on failure), so every other test file sees the cloud.
import { execSync } from "node:child_process";
import type { Server } from "node:http";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFromEnv, listen } from "../mcp/server.ts";

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
const PORT = 3396;
const BASE = `http://localhost:${PORT}`;
const SECRET = "test-selfhost-secret";
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
// Domains only this run uses: nobody else is let in through them.
const ALLOWED = `team-${stamp}.test`;
const OTHER = `nobody-${stamp}.test`;

const ops = () => createClient(env.url!, env.service!, { auth: { persistSession: false } });
const anon = () => createClient(env.url!, env.anon!, { auth: { persistSession: false } });

async function signUp(email: string, code?: string) {
  const db = anon();
  const r = await db.auth.signUp({ email, password: "test-password-123", options: code ? { data: { codesignflo_code: code } } : undefined });
  return { db, ...r };
}

async function person(name: string): Promise<{ db: SupabaseClient; token: string; email: string; id: string }> {
  const email = `${name}-${stamp}@example.test`;
  const { db, data, error } = await signUp(email);
  if (error) throw error;
  return { db, token: data.session!.access_token, email, id: data.user!.id };
}

const setMode = async (on: boolean) => {
  const db = ops();
  if (on) {
    const { error } = await db.from("app_config").upsert({ key: "mode", value: "selfhost" });
    if (error) throw new Error(error.message);
  } else {
    await db.from("app_config").delete().in("key", ["mode", "allowed_domains", "demo_key", "setup_code", "email_proof"]);
  }
};

run("self-hosted mode", { timeout: 60_000 }, () => {
  let srv: Server;
  let designer: Awaited<ReturnType<typeof person>>;
  let lead: Awaited<ReturnType<typeof person>>;
  let project: string;

  beforeAll(async () => {
    // Made in cloud mode (sign-up is open there), before the box's mode is set.
    await setMode(false);
    lead = await person("sh-lead");
    designer = await person("sh-designer");
    project = (await designer.db.rpc("create_project", { p_name: "Box", p_root_commit: `root_sh_${stamp}` })).data as string;
    await designer.db.rpc("invite", { p_project: project, p_email: lead.email, p_role: "developer", p_email_them: false });
    await setMode(true);
    srv = listen(
      {
        ...configFromEnv({
          CODESIGNFLO_MODE: "selfhost",
          PUBLIC_URL: BASE,
          SUPABASE_URL: env.url,
          SUPABASE_ANON_KEY: env.anon,
          SUPABASE_SERVICE_ROLE_KEY: env.service,
          NOTIFY_SECRET: SECRET,
          // Present in the environment, never used on a box.
          STRIPE_SECRET_KEY: "sk_test_never",
        }),
        cli: "codesignflo",
      },
      PORT,
    );
  });
  afterAll(async () => {
    srv?.close();
    await setMode(false);
  });

  it("configuration: the mode from the environment, no Stripe; the cloud's unchanged", () => {
    const box = configFromEnv({ CODESIGNFLO_MODE: "selfhost", PUBLIC_URL: BASE, SUPABASE_URL: "x", SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x", STRIPE_SECRET_KEY: "sk", SMTP_HOST: "smtp.example.test", SMTP_USER: "box@example.test" });
    expect(box.selfhost).toBe(true);
    expect(box.billing).toEqual({});
    expect(box.notify?.from).toBe("CoDesignFlo <box@example.test>");
    const cloud = configFromEnv({ PUBLIC_URL: BASE, SUPABASE_URL: "x", SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x", STRIPE_SECRET_KEY: "sk" });
    expect("selfhost" in cloud).toBe(false);
    expect(cloud.billing?.secretKey).toBe("sk");
    expect(cloud.notify?.from).toBeUndefined();
  });

  it("billing off: a designer whose free sends are used still sends, and everyone is active", async () => {
    // Their 5 free sends used (the ledger the cloud counts from).
    await ops()
      .from("send_ledger")
      .insert(Array.from({ length: 5 }, (_, i) => ({ project_id: project, event_id: `used_${stamp}_${i}`, user_id: designer.id, kind: "ready" })));
    const ev = (kind: string) =>
      designer.db.from("events").insert({ project_id: project, id: `${kind}_${Date.now()}_${Math.random()}`, at: new Date().toISOString(), by: "Dana", component: "components.x", kind, body: { claim: "c", note: "n", readyHash: "h" } });
    expect((await ev("ready")).error).toBeNull();
    expect((await ev("designed_new")).error).toBeNull();
    expect(((await designer.db.rpc("my_sends")).data as { state: string }[])[0]!.state).toBe("active");
    expect(((await designer.db.rpc("project_billing", { p_project: project })).data as { state: string }[])[0]!.state).toBe("active");
    // A design (proposal) is never held either.
    const claim = `claim_${stamp}`;
    expect((await designer.db.from("proposals").insert({ project_id: project, claim_id: claim, component: "components.x", payload: { a: 1 } })).error).toBeNull();
    // Back in the cloud, the same designer is out of free sends (the box's mode is all that changed).
    await setMode(false);
    try {
      expect(((await designer.db.rpc("my_sends")).data as { state: string }[])[0]!.state).toBe("unpaid");
      expect((await ev("ready")).error?.message).toMatch(/read-only for you/);
    } finally {
      await setMode(true);
    }
    // The helper isn't callable by clients.
    expect((await designer.db.rpc("selfhost")).error).not.toBeNull();
  });

  it("invite-only sign-up: an invitation needs its code (nothing proves the email), seen only by who invited and admins", async () => {
    const stranger = await signUp(`stranger@${OTHER}`);
    expect(stranger.error).not.toBeNull();
    expect(stranger.data.user).toBeNull();
    // Supabase Auth answers the guard's refusal with this (the web app turns it into "Ask a teammate to invite you").
    expect(stranger.error!.message).toMatch(/database error saving new user/i);

    const invitedEmail = `invited@${OTHER}`;
    expect((await designer.db.rpc("invite", { p_project: project, p_email: invitedEmail, p_role: "developer" })).data).toBe("invited");
    const code = (await designer.db.rpc("invitation_code", { p_project: project, p_email: invitedEmail })).data as string;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    // Another member who isn't an admin and didn't invite them doesn't see it.
    expect((await lead.db.rpc("invitation_code", { p_project: project, p_email: invitedEmail })).data).toBeNull();
    // The invited email alone, or with a wrong code: refused, with the same answer as a stranger.
    const bare = await signUp(invitedEmail);
    expect(bare.error!.message).toBe(stranger.error!.message);
    expect((await signUp(invitedEmail, "AAAA-AAAA")).error).not.toBeNull();
    // With its code (typed in lower case): let in, and in the project once signed in.
    const invited = await signUp(invitedEmail, code.toLowerCase());
    expect(invited.error).toBeNull();
    await invited.db.rpc("accept_invitations");
    expect((await invited.db.rpc("my_role", { p_project: project })).data).toBe("developer");
    // Accepted: the code is gone for good.
    expect((await designer.db.rpc("invitation_code", { p_project: project, p_email: invitedEmail })).data).toBeNull();

    // Its email can't be changed (invitations match on it).
    expect((await invited.db.auth.updateUser({ email: `taken-over@${OTHER}` })).error).not.toBeNull();

    // An allowed domain counts only where the box proves emails.
    await ops().from("app_config").upsert({ key: "allowed_domains", value: `other.test, @${ALLOWED.toUpperCase()}` });
    expect((await signUp(`someone@${ALLOWED}`)).error).not.toBeNull();
    await ops().from("app_config").upsert({ key: "email_proof", value: "true" });
    try {
      const colleague = await signUp(`someone@${ALLOWED}`);
      expect(colleague.error).toBeNull();
      expect(colleague.data.user?.id).toBeTruthy();
      // There, the invitation itself lets the address in (its email proves it) and no code is handed out.
      const mailed = `mailed@${OTHER}`;
      await designer.db.rpc("invite", { p_project: project, p_email: mailed, p_role: "designer" });
      expect((await designer.db.rpc("invitation_code", { p_project: project, p_email: mailed })).data).toBeNull();
      expect((await signUp(mailed)).error).toBeNull();
    } finally {
      await ops().from("app_config").delete().eq("key", "email_proof");
    }

    // The demo's address is the server's only.
    expect((await signUp(`alex-${stamp}@demo.codesignflo.com`)).error).not.toBeNull();
    // A sign-up can't guess the box's demo key; the server (mcp/demo.ts) makes Alex with it.
    expect((await anon().auth.signUp({ email: `alex2-${stamp}@demo.codesignflo.com`, password: "test-password-123", options: { data: { codesignflo_demo_key: "guess" } } })).error).not.toBeNull();
    expect((await designer.db.rpc("demo_key")).error).not.toBeNull();
    const key = (await ops().rpc("demo_key")).data as string;
    expect(key).toMatch(/^[0-9a-f]{48}$/);
    const made = await ops().auth.admin.createUser({ email: `alex-${stamp}@demo.codesignflo.com`, email_confirm: true, user_metadata: { name: "Alex", codesignflo_demo_key: key } });
    expect(made.error).toBeNull();
    await ops().auth.admin.deleteUser(made.data.user!.id);
  });

  it("the demo works on a box", async () => {
    const call = (what: string) => fetch(`${BASE}/api/demo/${what}`, { method: "POST", headers: { authorization: `Bearer ${designer.token}` } });
    const started = await call("start");
    expect(started.status).toBe(200);
    expect(((await started.json()) as { projectId: string }).projectId).toMatch(/^p_/);
    expect(((await (await call("quit")).json()) as { quit: boolean }).quit).toBe(true);
  });

  it("the setup code makes the admin only while the box has none", async () => {
    await ops().from("app_config").upsert({ key: "setup_code", value: "SETU-PCOD" });
    // The local stack has admins already: the setup code lets nobody in, nor makes an admin.
    expect((await ops().rpc("selfhost_signup", { p_email: `first@${OTHER}`, p_code: "SETU-PCOD" })).data).toBeNull();
    expect((await signUp(`first@${OTHER}`, "SETU-PCOD")).error).not.toBeNull();
    // Not callable by clients.
    expect((await designer.db.rpc("selfhost_signup", { p_email: "x@y.z", p_code: "SETU-PCOD" })).error).not.toBeNull();
    expect((await designer.db.rpc("selfhost_email_proof")).error).not.toBeNull();
    // (A fresh box, with no admin yet: the CI job selfhost.yml signs up without and with the code.)
  });

  it("billing endpoints aren't there; sending notifications skips Stripe and referrals; invitations aren't emailed", async () => {
    for (const p of ["/api/billing/checkout", "/api/billing/portal", "/api/billing/refresh", "/api/billing/confirm", "/api/stripe/webhook"]) {
      const r = await fetch(`${BASE}${p}`, { method: "POST", headers: { authorization: `Bearer ${designer.token}` } });
      expect(r.status).toBe(404);
      expect(((await r.json()) as { message: string }).message).toMatch(/not available in self-hosted mode/);
    }
    const invitee = `mailless@${OTHER}`;
    expect((await designer.db.rpc("invite", { p_project: project, p_email: invitee, p_role: "designer" })).data).toBe("invited");
    const rowOf = async () =>
      ((await designer.db.rpc("project_people", { p_project: project })).data as { email: string; email_status: string; email_error: string }[]).find(
        (p) => p.email === invitee,
      )!;
    // Oldest first, a batch at a time (earlier runs may have left some waiting).
    for (let i = 0; i < 5 && (await rowOf()).email_status === "queued"; i++) {
      const r = await fetch(`${BASE}/api/notify`, { method: "POST", headers: { "x-codesignflo-secret": SECRET } });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { seats: number }).seats).toBe(0);
    }
    const row = await rowOf();
    expect(row.email_status).toBe("failed");
    expect(row.email_error).toMatch(/this server doesn't send emails .* create their account at/);
  });
});
