// Invitation emails: inviting queues an email for the person's role, the sender delivers it (to a local stand-in
// for Resend) and records how it went on the invitation, resending is limited, and a signed-in member can
// trigger sending — against the local Supabase stack (supabase start). Skipped when it isn't running.
import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmail } from "../mcp/notify.ts";
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
const PORT = 3396;
const BASE = `http://localhost:${PORT}`;
const RESEND_PORT = 3395;

async function person(name: string): Promise<{ db: SupabaseClient; token: string; email: string }> {
  const db = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const { data, error } = await db.auth.signUp({ email, password: "test-password-123" });
  if (error) throw error;
  const token = data.session!.access_token;
  return { db: createClient(env.url!, env.anon!, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } }), token, email };
}

describe("invitation email content", () => {
  const base = { project: "Shop", projectId: "p_1", by: "dana@example.test", web: "https://app.example", mcp: "https://app.example/mcp" };
  it("tells a developer how to connect their coding agent", () => {
    const m = invitationEmail({ ...base, email: "dev@example.test", role: "developer", added: false });
    expect(m.subject).toBe("dana@example.test invited you to Shop on CoDesignFlo");
    expect(m.text).toContain("https://app.example/#/connect");
    expect(m.text).toContain("https://app.example/mcp");
    expect(m.text).toContain("Connect this app to CoDesignFlo");
    expect(m.text).toContain("https://app.example/#/p/p_1");
    expect(m.text).not.toContain("Figma plugin");
  });
  it("tells a designer how to open the plugin (and where to get it, when configured)", () => {
    const m = invitationEmail({ ...base, email: "des@example.test", role: "designer", added: false });
    expect(m.text).toContain("Get the CoDesignFlo Figma plugin from dana@example.test");
    expect(m.text).not.toContain("/mcp");
    expect(invitationEmail({ ...base, email: "des@example.test", role: "designer", added: false, pluginUrl: "https://get.example/plugin" }).text).toContain(
      "Install the CoDesignFlo Figma plugin: https://get.example/plugin",
    );
  });
  it("someone who already had an account is told they're in; html is escaped", () => {
    const m = invitationEmail({ ...base, project: "<b>x</b>", email: "dev@example.test", role: "admin", added: true });
    expect(m.subject).toBe("You're in <b>x</b> on CoDesignFlo");
    expect(m.html).toContain("&#60;b&#62;x&#60;/b&#62;");
    expect(m.html).not.toContain("<b>x</b>");
  });
});

run("invitation emails", { timeout: 60_000 }, () => {
  let srv: Server;
  let resend: Server;
  const mails: { to: string[]; subject: string; text: string; auth: string }[] = [];
  /** Resend refuses mail to this address (once). */
  let failFor = "";
  const admin = () => createClient(env.url!, env.service!, { auth: { persistSession: false } });

  beforeAll(() => {
    resend = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const mail = JSON.parse(body) as { to: string[]; subject: string; text: string };
        if (failFor && mail.to.includes(failFor)) {
          failFor = "";
          return void res.writeHead(422).end('{"message":"domain not verified"}');
        }
        mails.push({ ...mail, auth: req.headers.authorization ?? "" });
        res.writeHead(200).end('{"id":"x"}');
      });
    }).listen(RESEND_PORT);
    srv = listen(
      {
        base: BASE,
        web: "https://app.example",
        supabaseUrl: env.url!,
        anonKey: env.anon!,
        serviceKey: env.service!,
        cli: "codesignflo",
        cliEnv: {},
        notify: { resendKey: "re_test", from: "CoDesignFlo <notify@example.test>", resendUrl: `http://localhost:${RESEND_PORT}/emails` },
      },
      PORT,
    );
  });
  afterAll(() => {
    srv?.close();
    resend?.close();
  });

  const people = async (db: SupabaseClient, project: string) =>
    ((await db.rpc("project_people", { p_project: project })).data ?? []) as {
      email: string;
      pending: boolean;
      email_status: string | null;
      email_error: string | null;
    }[];

  it("inviting emails the person; a member triggers sending; the invitation records it went", async () => {
    const a = await person("inviter");
    const project = (await a.db.rpc("create_project", { p_name: "Mail shop", p_root_commit: `root_m_${Date.now()}` })).data as string;
    const invited = `new-dev-${Date.now()}@example.test`;
    expect((await a.db.rpc("invite", { p_project: project, p_email: invited, p_role: "developer" })).data).toBe("invited");
    expect((await people(a.db, project)).find((p) => p.email === invited)?.email_status).toBe("queued");

    // Not signed in: refused. Signed in: sends what's queued.
    expect((await fetch(`${BASE}/api/notify`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${BASE}/api/notify`, { method: "POST", headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${BASE}/api/notify`, { method: "POST", headers: { authorization: `Bearer ${a.token}` } })).status).toBe(200);

    const mail = mails.find((m) => m.to.includes(invited))!;
    expect(mail.auth).toBe("Bearer re_test");
    expect(mail.subject).toBe(`${a.email} invited you to Mail shop on CoDesignFlo`);
    expect(mail.text).toContain("https://app.example/#/connect");
    expect((await people(a.db, project)).find((p) => p.email === invited)?.email_status).toBe("sent");
  });

  it("resending is limited, members only, pending invitations only; a failed send says why", async () => {
    const a = await person("resender");
    const stranger = await person("stranger");
    const project = (await a.db.rpc("create_project", { p_name: "Resend shop", p_root_commit: `root_r_${Date.now()}` })).data as string;
    const invited = `new-des-${Date.now()}@example.test`;
    await a.db.rpc("invite", { p_project: project, p_email: invited, p_role: "designer" });
    expect((await a.db.rpc("resend_invitation", { p_project: project, p_email: invited })).error?.message).toMatch(/a moment ago/);
    expect((await stranger.db.rpc("resend_invitation", { p_project: project, p_email: invited })).error?.message).toMatch(/not in this project/);
    expect((await a.db.rpc("resend_invitation", { p_project: project, p_email: "nobody@example.test" })).error?.message).toMatch(/no pending invitation/);

    // Two minutes later (moved back here), it can be sent again; Resend refuses it this time.
    await admin().from("invitations").update({ last_sent_at: new Date(Date.now() - 5 * 60_000).toISOString() }).eq("project_id", project);
    expect((await a.db.rpc("resend_invitation", { p_project: project, p_email: invited })).error).toBeNull();
    failFor = invited;
    await new Promise((r) => setTimeout(r, 3100)); // the per-server pause between member-triggered sends
    expect((await fetch(`${BASE}/api/notify`, { method: "POST", headers: { authorization: `Bearer ${a.token}` } })).status).toBe(200);
    const row = (await people(a.db, project)).find((p) => p.email === invited)!;
    expect(row.email_status).toBe("failed");
    expect(row.email_error).toMatch(/422.*domain not verified/);
  });

  it("someone with an account is added and told; inviting without an email address is refused", async () => {
    const a = await person("adder");
    const b = await person("existing");
    const project = (await a.db.rpc("create_project", { p_name: "Added shop", p_root_commit: `root_a_${Date.now()}` })).data as string;
    expect((await a.db.rpc("invite", { p_project: project, p_email: b.email, p_role: "developer" })).data).toBe("added");
    const { data: queued } = await admin().from("notifications").select("kind, body").eq("project_id", project).eq("kind", "invited");
    expect(queued).toEqual([{ kind: "invited", body: { email: b.email, role: "developer", added: true } }]);
    expect((await a.db.rpc("invite", { p_project: project, p_email: "not-an-email", p_role: "developer" })).error?.message).toMatch(/not an email/);
  });

  it("at most 30 invitation emails per project per hour", async () => {
    const a = await person("bulk");
    const project = (await a.db.rpc("create_project", { p_name: "Bulk shop", p_root_commit: `root_b_${Date.now()}` })).data as string;
    for (let i = 0; i < 30; i++) expect((await a.db.rpc("invite", { p_project: project, p_email: `bulk${i}-${Date.now()}@example.test` })).error).toBeNull();
    expect((await a.db.rpc("invite", { p_project: project, p_email: `bulk-over-${Date.now()}@example.test` })).error?.message).toMatch(/too many invitation emails/);
  });
});
