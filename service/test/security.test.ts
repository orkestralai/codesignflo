// Security fixes (20261122000000_security.sql): the demo flag is the service's, sends outlive their project,
// internal functions aren't callable, members join only by invitation and the owner/last admin stay, proposals
// keep their project and claim, events carry their real author's name. Against the local Supabase stack
// (skipped without it).
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

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
const ops = () => createClient(env.url!, env.service!, { auth: { persistSession: false } });

async function person(name: string, shown?: string): Promise<{ db: SupabaseClient; id: string; email: string }> {
  const db = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const { data, error } = await db.auth.signUp({ email, password: "test-password-123", ...(shown ? { options: { data: { name: shown } } } : {}) });
  if (error) throw error;
  return { db, id: data.user!.id, email };
}

let n = 0;
const event = (project: string, kind: string, by = "Dana", body: Record<string, unknown> = {}) => ({
  project_id: project,
  id: `${kind}_${Date.now()}_${n++}`,
  at: new Date().toISOString(),
  by,
  component: "components.x",
  kind,
  body: { claim: "c", note: "n", readyHash: "h", ...body },
});
const used = async (who: { db: SupabaseClient }) => ((await who.db.rpc("my_sends")).data as { used: number }[])[0]!.used;

run("security", { timeout: 60_000 }, () => {
  it("a client can't make a project a demo one; the service can", async () => {
    const dana = await person("sec-demo");
    const p = (await dana.db.rpc("create_project", { p_name: "Sneaky", p_root_commit: null, p_settings: { demo: true, tokens: "t.json", other: 1 } })).data as string;
    expect(p).toMatch(/^p_/);
    const { data: row } = await ops().from("projects").select("settings").eq("id", p).single();
    expect(row!.settings).toEqual({ tokens: "t.json" });
    // Nor through the functions that change settings.
    await dana.db.rpc("set_live_branch", { p_project: p, p_branch: "main" });
    expect(((await ops().from("projects").select("settings").eq("id", p).single()).data!.settings as { demo?: boolean }).demo).toBeUndefined();
    // So its sends count.
    expect((await dana.db.from("events").insert(event(p, "ready"))).error).toBeNull();
    expect(await used(dana)).toBe(1);

    // The service's demo keeps its flag; a signed-in update can't take it off; nobody is invited into it.
    const demo = `p_${Date.now().toString(16).slice(-12).padStart(12, "0")}`;
    expect((await ops().from("projects").insert({ id: demo, name: "CoDesignFlo demo", owner: dana.id, settings: { demo: true } })).error).toBeNull();
    expect((await ops().from("project_members").insert({ project_id: demo, user_id: dana.id, role: "admin" })).error).toBeNull();
    await dana.db.from("projects").update({ name: "Mine now" }).eq("id", demo);
    await dana.db.rpc("set_build_mode", { p_project: demo, p_mode: "storybook" });
    expect(((await ops().from("projects").select("settings").eq("id", demo).single()).data!.settings as { demo?: boolean }).demo).toBe(true);
    expect((await dana.db.from("events").insert(event(demo, "ready"))).error).toBeNull();
    expect(await used(dana)).toBe(1);
    expect((await dana.db.rpc("invite", { p_project: demo, p_email: "someone@example.test", p_role: "developer" })).error?.message).toMatch(/demo project/);
    expect((await dana.db.rpc("link_codebase", { p_project: demo, p_root_commit: `demo_${Date.now()}` })).error?.message).toMatch(/demo project/);
    expect((await dana.db.from("live_updates").insert({ project_id: demo, commit: "c1", payload: {} })).error?.message).toMatch(/demo project/);
  });

  it("sends to dev stay counted when their project is deleted", async () => {
    const dana = await person("sec-sends");
    const p = (await dana.db.rpc("create_project", { p_name: "Gone", p_root_commit: null })).data as string;
    expect((await dana.db.from("events").insert([event(p, "ready"), event(p, "designed_new"), event(p, "claimed")])).error).toBeNull();
    // A batch sent again (on conflict do nothing) isn't counted twice.
    const again = event(p, "ready");
    await dana.db.from("events").upsert(again, { onConflict: "project_id,id", ignoreDuplicates: true });
    await dana.db.from("events").upsert(again, { onConflict: "project_id,id", ignoreDuplicates: true });
    expect(await used(dana)).toBe(3);
    expect((await dana.db.rpc("delete_project", { p_project: p })).error).toBeNull();
    expect(await used(dana)).toBe(3);
  });

  it("internal functions aren't callable; signing in works before signing in", async () => {
    const anon = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
    const someone = await person("sec-fn");
    const internal: [string, Record<string, unknown>][] = [
      ["billing_state", { p_owner: someone.id }],
      ["sends_used", { p_user: someone.id }],
      ["seat_payer", { p_user: someone.id }],
      ["whitelisted", { p_user: someone.id }],
      ["billing_seats", { p_owner: someone.id }],
      ["trial_ends", { p_user: someone.id }],
      ["is_demo", { p: "p_000000000000" }],
      ["read_only_message", { p: "p_000000000000" }],
      ["cleanup_telemetry", {}],
      ["cleanup_expired", {}],
      ["display_name", { p_user: someone.id }],
    ];
    for (const [fn, args] of internal) {
      expect((await anon.rpc(fn, args)).error?.message, `anon ${fn}`).toMatch(/permission denied/);
      expect((await someone.db.rpc(fn, args)).error?.message, `authenticated ${fn}`).toMatch(/permission denied/);
    }
    // Signed-in only.
    expect((await anon.rpc("find_project", { p_root_commit: "x" })).error?.message).toMatch(/permission denied/);
    expect((await anon.rpc("my_billing")).error?.message).toMatch(/permission denied/);
    expect((await someone.db.rpc("find_project", { p_root_commit: "x" })).error).toBeNull();
    // Sign-in from the plugin / CLI.
    const { data: started, error } = await anon.rpc("start_login", { p_client: "cli" });
    expect(error).toBeNull();
    const code = (started as { device_code: string }[])[0]!.device_code;
    expect((await anon.rpc("poll_login", { p_device_code: code })).error).toBeNull();
    expect((await anon.rpc("mcp_request_info", { p_request: "nope" })).error).toBeNull();
    // Row-level security still answers anon with nothing rather than an error.
    expect((await anon.from("projects").select("id")).data).toEqual([]);
  });

  it("members join only by invitation; the owner and the last admin stay", async () => {
    const owner = await person("sec-owner");
    const admin = await person("sec-admin");
    const dev = await person("sec-dev");
    const p = (await owner.db.rpc("create_project", { p_name: "Team", p_root_commit: null })).data as string;
    expect((await owner.db.from("project_members").insert({ project_id: p, user_id: dev.id, role: "developer" })).error).not.toBeNull();
    expect((await owner.db.rpc("invite", { p_project: p, p_email: admin.email, p_role: "admin" })).data).toBe("added");
    expect((await owner.db.rpc("invite", { p_project: p, p_email: dev.email, p_role: "developer" })).data).toBe("added");
    const members = async () => ((await ops().from("project_members").select("user_id").eq("project_id", p)).data ?? []).length;
    expect(await members()).toBe(3);
    // Another admin can't remove the owner, nor both admins at once.
    expect((await admin.db.from("project_members").delete().eq("project_id", p).eq("user_id", owner.id)).error?.message).toMatch(/owner stays/);
    expect((await admin.db.from("project_members").delete().eq("project_id", p).eq("role", "admin")).error).not.toBeNull();
    expect(await members()).toBe(3);
    // A developer removes nobody; an admin removes the developer and another admin.
    await dev.db.from("project_members").delete().eq("project_id", p).eq("user_id", admin.id);
    expect(await members()).toBe(3);
    expect((await admin.db.from("project_members").delete().eq("project_id", p).eq("user_id", dev.id)).error).toBeNull();
    expect((await owner.db.from("project_members").delete().eq("project_id", p).eq("user_id", admin.id)).error).toBeNull();
    expect(await members()).toBe(1);
    // Deleting the project still takes its members.
    expect((await owner.db.rpc("delete_project", { p_project: p })).error).toBeNull();
    expect(await members()).toBe(0);
  });

  it("proposals keep their project and claim; a design without a seat waits", async () => {
    const dana = await person("sec-prop");
    const other = await person("sec-prop-other");
    const p = (await dana.db.rpc("create_project", { p_name: "Props", p_root_commit: null })).data as string;
    const q = (await dana.db.rpc("create_project", { p_name: "Props 2", p_root_commit: null })).data as string;
    const theirs = (await other.db.rpc("create_project", { p_name: "Theirs", p_root_commit: null })).data as string;
    const row = { project_id: p, claim_id: "c1", component: "components.x", payload: { note: "design" } };
    expect((await dana.db.from("proposals").insert(row)).error).toBeNull();
    const at = (id: string) => dana.db.from("proposals").select("claim_id").eq("project_id", id);
    // Moving it to another claim, another project of mine, or someone else's project: refused.
    expect((await dana.db.from("proposals").update({ claim_id: "c2" }).eq("project_id", p).eq("claim_id", "c1")).error?.message).toMatch(/stays in its project/);
    expect((await dana.db.from("proposals").update({ project_id: q }).eq("project_id", p).eq("claim_id", "c1")).error?.message).toMatch(/stays in its project/);
    expect((await dana.db.from("proposals").update({ project_id: theirs }).eq("project_id", p).eq("claim_id", "c1")).error).not.toBeNull();
    expect((await at(p)).data).toEqual([{ claim_id: "c1" }]);
    expect((await at(q)).data).toEqual([]);
    // Free sends used: a new design, or a changed one, waits like the send itself (the plugin keeps both).
    expect((await dana.db.from("events").insert([1, 2, 3, 4, 5].map(() => event(p, "ready")))).error).toBeNull();
    expect((await dana.db.from("proposals").update({ payload: { note: "rewritten" } }).eq("project_id", p).eq("claim_id", "c1")).error?.message).toMatch(/read-only for you/);
    expect((await dana.db.from("proposals").insert({ ...row, claim_id: "c3" })).error?.message).toMatch(/read-only for you/);
    expect((await ops().from("proposals").select("payload").eq("project_id", p).eq("claim_id", "c1").single()).data).toEqual({ payload: { note: "design" } });
  });

  it("an event shows its real author's name; unknown kinds are dropped", async () => {
    const dana = await person("sec-by", "Dana");
    const p = (await dana.db.rpc("create_project", { p_name: "Names", p_root_commit: null })).data as string;
    const own = event(p, "claimed", "Dana");
    const mail = event(p, "seen", dana.email);
    const cli = event(p, "generated", "cli");
    const forged = event(p, "claimed", "The CEO");
    const odd = event(p, "make_me_admin");
    expect((await dana.db.from("events").insert([own, mail, cli, forged, odd])).error).toBeNull();
    const { data } = await dana.db.from("events").select("id, by").eq("project_id", p);
    const by = Object.fromEntries((data ?? []).map((r) => [r.id, r.by]));
    expect(by).toEqual({ [own.id]: "Dana", [mail.id]: dana.email, [cli.id]: "cli", [forged.id]: "Dana" });
  });

  it("limits: project names, and a seat claim by someone who doesn't pay doesn't block the designer", async () => {
    const lead = await person("sec-lead");
    const designer = await person("sec-designer");
    expect((await lead.db.rpc("create_project", { p_name: "   ", p_root_commit: null })).error?.message).toMatch(/1 to 80/);
    expect((await lead.db.rpc("create_project", { p_name: "x".repeat(81), p_root_commit: null })).error?.message).toMatch(/1 to 80/);
    const p = (await lead.db.rpc("create_project", { p_name: "  Trimmed  ", p_root_commit: null })).data as string;
    expect((await ops().from("projects").select("name").eq("id", p).single()).data).toEqual({ name: "Trimmed" });
    expect((await lead.db.from("projects").update({ name: "y".repeat(81) }).eq("id", p)).error).not.toBeNull();

    expect((await lead.db.rpc("add_seat", { p_email: designer.email })).data).toBe("added");
    expect((await designer.db.rpc("add_seat", { p_email: designer.email })).data).toBe("added");
    expect(((await designer.db.rpc("my_seats")).data as { email: string }[]).map((s) => s.email)).toEqual([designer.email.toLowerCase()]);
    expect((await lead.db.rpc("my_seats")).data).toEqual([]);
    // Held by a payer who pays: taken.
    await ops().from("billing_accounts").upsert({ user_id: designer.id, status: "active" });
    expect((await lead.db.rpc("add_seat", { p_email: designer.email })).data).toBe("taken");
  });
});
