// Branch lanes against the local Supabase stack: developers connect branches, everyone in the project sees them,
// nobody else does. Skipped when the stack isn't running.
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
const lanesOf = async (c: SupabaseClient, project: string) =>
  ((await c.rpc("project_lanes", { p_project: project })).data ?? []) as { branch: string; connected_by: string }[];

run("branch lanes", () => {
  let dev: SupabaseClient;
  let designer: SupabaseClient;
  let stranger: SupabaseClient;
  let project: string;
  const devEmail = emailFor("lanedev");
  const designerEmail = emailFor("lanedesigner");

  beforeAll(async () => {
    [dev, stranger] = await Promise.all([signUp(devEmail), signUp(emailFor("lanestranger"))]);
    project = (await dev.rpc("create_project", { p_name: "Lanes", p_root_commit: `root_${Math.random().toString(36).slice(2)}` })).data as string;
    await dev.rpc("set_live_branch", { p_project: project, p_branch: "main" });
    await dev.rpc("invite", { p_project: project, p_email: designerEmail, p_role: "designer" });
    designer = await signUp(designerEmail);
    await designer.rpc("accept_invitations");
  });

  it("a developer connects a branch; connecting again keeps one", async () => {
    expect((await dev.rpc("connect_branch", { p_project: project, p_branch: "feat/checkout" })).error).toBeNull();
    expect((await dev.rpc("connect_branch", { p_project: project, p_branch: "feat/checkout" })).error).toBeNull();
    const lanes = await lanesOf(dev, project);
    expect(lanes.map((l) => l.branch)).toEqual(["feat/checkout"]);
    expect(lanes[0]!.connected_by).toBe(devEmail);
  });

  it("not the Live branch, nor a name git refuses", async () => {
    expect((await dev.rpc("connect_branch", { p_project: project, p_branch: "main" })).error?.message).toMatch(/Live branch/);
    expect((await dev.rpc("connect_branch", { p_project: project, p_branch: "a..b" })).error?.message).toMatch(/not a branch name/);
    expect((await dev.rpc("connect_branch", { p_project: project, p_branch: "--force" })).error?.message).toMatch(/not a branch name/);
  });

  it("designers see the lanes but don't connect or disconnect them", async () => {
    expect((await lanesOf(designer, project)).map((l) => l.branch)).toEqual(["feat/checkout"]);
    expect((await designer.rpc("connect_branch", { p_project: project, p_branch: "feat/x" })).error?.message).toMatch(/developers and admins/);
    expect((await designer.rpc("disconnect_branches", { p_project: project, p_branches: ["feat/checkout"] })).error?.message).toMatch(
      /developers and admins/,
    );
  });

  it("people outside the project see nothing and change nothing", async () => {
    expect(await lanesOf(stranger, project)).toEqual([]);
    expect((await stranger.from("project_branches").select("branch").eq("project_id", project)).data).toEqual([]);
    expect((await stranger.rpc("connect_branch", { p_project: project, p_branch: "feat/y" })).error).not.toBeNull();
    // Nobody writes the table directly.
    expect((await dev.from("project_branches").insert({ project_id: project, branch: "feat/z" })).error).not.toBeNull();
  });

  it("disconnecting (or merged) takes the lane out", async () => {
    expect((await dev.rpc("disconnect_branches", { p_project: project, p_branches: ["feat/checkout", "never"] })).data).toBe(1);
    expect(await lanesOf(dev, project)).toEqual([]);
  });
});
