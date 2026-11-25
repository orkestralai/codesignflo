// Step 1 rules against the local Supabase stack (supabase start). Skipped when it isn't running.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const env = (() => {
  try {
    const out = execSync("supabase status -o env", { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const get = (k: string) => new RegExp(`^${k}="?([^"\\n]+)`, "m").exec(out)?.[1];
    return { url: get("API_URL"), anon: get("ANON_KEY") };
  } catch {
    return { url: undefined, anon: undefined };
  }
})();
const run = env.url && env.anon ? describe : describe.skip;

async function user(name: string): Promise<SupabaseClient> {
  const c = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const { error } = await c.auth.signUp({ email, password: "test-password-123" });
  if (error) throw error;
  return c;
}
const uid = async (c: SupabaseClient) => (await c.auth.getUser()).data.user!.id;
const commit = () => `root_${Math.random().toString(36).slice(2)}`;

run("service step 1: projects, members, history", () => {
  let dev: SupabaseClient;
  let designer: SupabaseClient;
  let stranger: SupabaseClient;
  let project: string;
  const repo = commit();

  beforeAll(async () => {
    [dev, designer, stranger] = await Promise.all([user("dev"), user("designer"), user("stranger")]);
  });

  it("a developer creates their free project for a codebase", async () => {
    const { data, error } = await dev.rpc("create_project", { p_name: "Shop", p_root_commit: repo, p_folder: "examples/demo-app" });
    expect(error).toBeNull();
    project = data as string;
    expect(project).toMatch(/^p_/);
  });

  it("a second project is fine (billing is by designer seat, not by project)", async () => {
    const { error } = await dev.rpc("create_project", { p_name: "Other", p_root_commit: commit() });
    expect(error).toBeNull();
  });

  it("another account can't take the same codebase, and learns only that it exists", async () => {
    const { error } = await stranger.rpc("create_project", { p_name: "Shop again", p_root_commit: repo, p_folder: "examples/demo-app" });
    expect(error?.message).toMatch(/already has a CoDesignFlo project/);
    const { data } = await stranger.rpc("find_project", { p_root_commit: repo, p_folder: "examples/demo-app" });
    expect(data).toEqual([{ project_id: project, name: null, access: false }]);
  });

  it("the owner invites a designer; members share the history, which can't be edited or deleted", async () => {
    // Members join through an invitation only (no direct inserts).
    const email = (await designer.auth.getUser()).data.user!.email!;
    expect((await dev.from("project_members").insert({ project_id: project, user_id: await uid(designer), role: "designer" })).error).not.toBeNull();
    expect((await dev.rpc("invite", { p_project: project, p_email: email, p_role: "designer" })).data).toBe("added");
    const event = { project_id: project, id: "e1", at: new Date().toISOString(), by: "designer", component: "badge", kind: "claimed", body: { claim: "c1" } };
    expect((await designer.from("events").insert(event)).error).toBeNull();
    const seen = await dev.from("events").select("id, kind").eq("project_id", project);
    expect(seen.data).toEqual([{ id: "e1", kind: "claimed" }]);
    await designer.from("events").update({ kind: "closed" }).eq("project_id", project).eq("id", "e1");
    await designer.from("events").delete().eq("project_id", project).eq("id", "e1");
    expect((await dev.from("events").select("kind").eq("project_id", project)).data).toEqual([{ kind: "claimed" }]);
  });

  it("a non-member sees nothing and can't write", async () => {
    expect((await stranger.from("events").select("id").eq("project_id", project)).data).toEqual([]);
    expect((await stranger.from("projects").select("id").eq("id", project)).data).toEqual([]);
    const ins = await stranger.from("events").insert({ project_id: project, id: "x", at: new Date().toISOString(), by: "x", component: "x", kind: "claimed" });
    expect(ins.error).not.toBeNull();
  });

  it("only admins add members", async () => {
    const { error } = await designer.from("project_members").insert({ project_id: project, user_id: await uid(stranger), role: "developer" });
    expect(error).not.toBeNull();
  });
});

run("service step 1: signing in from the plugin/CLI (device code)", () => {
  it("the CLI gets a session after the person approves the code in the browser", async () => {
    const cliSide = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
    const { data: started, error } = await cliSide.rpc("start_login", { p_client: "cli" });
    expect(error).toBeNull();
    const { device_code, user_code } = (started as { device_code: string; user_code: string }[])[0]!;
    expect(user_code).toMatch(/^[A-Z2-9]{8}$/);
    // not approved yet
    expect((await cliSide.rpc("poll_login", { p_device_code: device_code })).data).toBeNull();
    // the browser: signed in, approves the code (shown as XXXX-XXXX)
    const browser = await user("approver");
    const { data: s } = await browser.auth.getSession();
    const ok = await browser.rpc("approve_login", { p_user_code: `${user_code.slice(0, 4)}-${user_code.slice(4)}`, p_refresh_token: s.session!.refresh_token });
    expect(ok.data).toBe("cli");
    // the CLI receives the token once and opens its own session with it
    const token = (await cliSide.rpc("poll_login", { p_device_code: device_code })).data as string;
    expect(token).toBeTruthy();
    const { data: session, error: refreshErr } = await cliSide.auth.refreshSession({ refresh_token: token });
    expect(refreshErr).toBeNull();
    expect(session.user?.id).toBe((await browser.auth.getUser()).data.user!.id);
    // and only once
    expect((await cliSide.rpc("poll_login", { p_device_code: device_code })).error).not.toBeNull();
  });

  it("a wrong code is refused", async () => {
    const browser = await user("approver2");
    const { error } = await browser.rpc("approve_login", { p_user_code: "ZZZZ-ZZZZ", p_refresh_token: "x" });
    expect(error?.message).toMatch(/expired or is wrong/);
  });
});

run("deleting a project", () => {
  it("only its owner can; its history goes with it and the free project can be used again", async () => {
    const [owner, other] = await Promise.all([user("owner"), user("other")]);
    const { data: id } = await owner.rpc("create_project", { p_name: "Old", p_root_commit: commit() });
    await owner.rpc("invite", { p_project: id, p_email: (await other.auth.getUser()).data.user!.email, p_role: "designer" });
    expect((await other.rpc("delete_project", { p_project: id })).error?.message).toMatch(/only the project's owner/);
    expect((await owner.rpc("delete_project", { p_project: id })).error).toBeNull();
    expect((await owner.from("projects").select("id").eq("id", id)).data).toEqual([]);
    expect((await owner.rpc("create_project", { p_name: "New", p_root_commit: commit() })).error).toBeNull();
  });
});
