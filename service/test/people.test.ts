// Invitations and designer-started projects against the local Supabase stack. Skipped when it isn't running.
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

const emailFor = (name: string) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
async function signUp(email: string): Promise<SupabaseClient> {
  const c = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
  const { error } = await c.auth.signUp({ email, password: "test-password-123" });
  if (error) throw error;
  return c;
}
const commit = () => `root_${Math.random().toString(36).slice(2)}`;

run("people: the designer starts the project and invites the developer", () => {
  let designer: SupabaseClient;
  let stranger: SupabaseClient;
  let project: string;
  const devEmail = emailFor("dev");
  const repo = commit();

  beforeAll(async () => {
    [designer, stranger] = await Promise.all([signUp(emailFor("designer")), signUp(emailFor("stranger"))]);
  });

  it("a designer starts a project from Figma with no code yet (their free project)", async () => {
    const { data, error } = await designer.rpc("create_project", { p_name: "Shop", p_root_commit: null });
    expect(error).toBeNull();
    project = data as string;
  });

  it("starting from Figma marks the design side (signed in with Google or an email link, nothing else says it)", async () => {
    const own = async (c: SupabaseClient) => {
      const id = (await c.auth.getUser()).data.user!.id;
      return (await c.from("profiles").select("design_side").eq("id", id).single()).data?.design_side;
    };
    expect(await own(designer)).toBe(true);
    // A project started with its code (a developer's agent) doesn't.
    const dev = await signUp(emailFor("codefirst"));
    expect((await dev.rpc("create_project", { p_name: "Api", p_root_commit: commit() })).error).toBeNull();
    expect(await own(dev)).toBe(false);
    // Nobody sets it for themselves.
    const id = (await dev.auth.getUser()).data.user!.id;
    await dev.from("profiles").update({ design_side: true }).eq("id", id);
    expect(await own(dev)).toBe(false);
  });

  it("the designer invites a developer who has no account yet", async () => {
    const { data, error } = await designer.rpc("invite", { p_project: project, p_email: devEmail.toUpperCase(), p_role: "developer" });
    expect(error).toBeNull();
    expect(data).toBe("invited");
    const people = (await designer.rpc("project_people", { p_project: project })).data as { email: string; role: string; pending: boolean }[];
    // The invitation email is queued for the developer (sent by /api/notify).
    expect(people.find((p) => p.pending)).toMatchObject({ email: devEmail.toLowerCase(), role: "developer", pending: true, email_status: "queued" });
  });

  it("non-members can't invite or see the people", async () => {
    expect((await stranger.rpc("invite", { p_project: project, p_email: "x@example.test" })).error?.message).toMatch(/not in this project/);
    expect((await stranger.rpc("project_people", { p_project: project })).data).toEqual([]);
  });

  it("a designer can't invite an admin", async () => {
    // the creator is admin; add a plain designer to try it
    const d2email = emailFor("designer2");
    const d2 = await signUp(d2email);
    expect((await designer.rpc("invite", { p_project: project, p_email: d2email, p_role: "designer" })).data).toBe("added");
    const { error } = await d2.rpc("invite", { p_project: project, p_email: "boss@example.test", p_role: "admin" });
    expect(error?.message).toMatch(/only admins can invite admins/);
    // nor link code: that's the developers' side
    const link = await d2.rpc("link_codebase", { p_project: project, p_root_commit: commit() });
    expect(link.error?.message).toMatch(/only the project's developers/);
  });

  it("the developer signs up, joins on sign-in, sees the project waiting for code and links the codebase", async () => {
    const dev = await signUp(devEmail);
    expect((await dev.rpc("accept_invitations")).data).toBe(1);
    expect((await dev.rpc("projects_without_code")).data).toEqual([{ project_id: project, name: "Shop" }]);
    expect((await dev.rpc("link_codebase", { p_project: project, p_root_commit: repo, p_folder: "app" })).error).toBeNull();
    expect((await dev.rpc("find_project", { p_root_commit: repo, p_folder: "app" })).data).toEqual([{ project_id: project, name: "Shop", access: true }]);
    expect((await dev.rpc("projects_without_code")).data).toEqual([]);
    // linked once: other code can't take it over
    expect((await dev.rpc("link_codebase", { p_project: project, p_root_commit: commit() })).error?.message).toMatch(/already linked/);
    const people = (await dev.rpc("project_people", { p_project: project })).data as { pending: boolean }[];
    expect(people.every((p) => !p.pending)).toBe(true);
  });

  it("a codebase belongs to one project", async () => {
    const other = await signUp(emailFor("other"));
    const p2 = (await other.rpc("create_project", { p_name: "Other", p_root_commit: null })).data as string;
    expect((await other.rpc("link_codebase", { p_project: p2, p_root_commit: repo, p_folder: "app" })).error?.message).toMatch(/already has a CoDesignFlo project/);
  });
});
