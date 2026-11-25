// Telemetry against the local Supabase stack: who may record, who may read, content only when the project
// shares it, and the admin dashboard's summaries. Skipped when the stack isn't running.
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

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

const emailFor = (name: string) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
async function signUp(email: string): Promise<{ c: SupabaseClient; id: string }> {
  const c = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signUp({ email, password: "test-password-123" });
  if (error) throw error;
  return { c, id: data.user!.id };
}

run("telemetry: recorded by members, read by CoDesignFlo's admins", () => {
  let dev: { c: SupabaseClient; id: string };
  let other: { c: SupabaseClient; id: string };
  let admin: { c: SupabaseClient; id: string };
  let project: string;

  beforeAll(async () => {
    [dev, other, admin] = await Promise.all([signUp(emailFor("dev")), signUp(emailFor("other")), signUp(emailFor("admin"))]);
    project = (await dev.c.rpc("create_project", { p_name: "Shop", p_root_commit: `root_${Date.now()}` })).data as string;
    // An admin is added by hand (the service key: only the operators have it).
    const ops = createClient(env.url!, env.service!, { auth: { persistSession: false } });
    const { error } = await ops.from("admins").insert({ user_id: admin.id });
    if (error) throw error;
  });

  const event = (extra: Record<string, unknown> = {}) => ({
    project_id: project,
    source: "cli",
    kind: "timing",
    signature: "sync.render",
    version: "0.2.7",
    data: { ms: 1200 },
    ...extra,
  });

  it("a member records events for their project; a stranger can't; nobody but admins reads them", async () => {
    expect((await dev.c.from("telemetry").insert([event(), event({ data: { ms: 800 } })])).error).toBeNull();
    expect((await other.c.from("telemetry").insert(event())).error).not.toBeNull();
    // A crash before the app is set up: no project.
    expect((await other.c.from("telemetry").insert(event({ project_id: null, kind: "crash", signature: "init: x" }))).error).toBeNull();
    const mine = await dev.c.from("telemetry").select("id").eq("project_id", project);
    expect(mine.data ?? []).toEqual([]);
    const all = await admin.c.from("telemetry").select("signature, data").eq("project_id", project);
    expect(all.data?.length).toBe(2);
    expect(await dev.c.rpc("is_admin")).toMatchObject({ data: false });
    expect(await admin.c.rpc("is_admin")).toMatchObject({ data: true });
  });

  it("content only when the project shares it, set by its developers", async () => {
    const path = `${project}/log-${Date.now()}.txt`;
    expect((await dev.c.storage.from("telemetry").upload(path, "the sync's log", { contentType: "text/plain" })).error).not.toBeNull();
    expect((await dev.c.from("telemetry").insert(event({ kind: "crash", signature: "sync: x", content: path }))).error).not.toBeNull();
    expect((await other.c.rpc("set_share_content", { p_project: project, p_on: true })).error).not.toBeNull();
    expect((await dev.c.rpc("set_share_content", { p_project: project, p_on: true })).error).toBeNull();
    expect((await dev.c.storage.from("telemetry").upload(path, "the sync's log", { contentType: "text/plain" })).error).toBeNull();
    expect((await dev.c.from("telemetry").insert(event({ kind: "crash", signature: "sync: x", content: path }))).error).toBeNull();
    // Admins read it; the developer who sent it doesn't (it's CoDesignFlo's).
    expect((await admin.c.storage.from("telemetry").download(path)).error).toBeNull();
    expect((await dev.c.storage.from("telemetry").download(path)).error).not.toBeNull();
  });

  it("the dashboard's summaries: admins only", async () => {
    expect((await dev.c.rpc("telemetry_summary", { p_days: 7 })).error).not.toBeNull();
    const sum = await admin.c.rpc("telemetry_summary", { p_days: 7 });
    expect(sum.error).toBeNull();
    expect((sum.data as { signature: string; events: number }[]).find((r) => r.signature === "sync: x")?.events).toBeGreaterThanOrEqual(1);
    const t = await admin.c.rpc("telemetry_timings", { p_days: 7 });
    const render = (t.data as { signature: string; runs: number; max_ms: number }[]).find((r) => r.signature === "sync.render");
    expect(render?.runs).toBeGreaterThanOrEqual(2);
    expect(render?.max_ms).toBeGreaterThanOrEqual(1200);
    // Filtered by the API (the local stack keeps every run's projects; a response holds 1000 rows at most).
    const names = await admin.c.rpc("admin_projects").eq("id", project);
    expect((names.data as { id: string; name: string }[]).find((p) => p.id === project)?.name).toBe("Shop");
    expect((await dev.c.rpc("admin_projects")).error).not.toBeNull();
  });

  it("progress says whether Figma is in the background (the plugin's new call), the old call still works", async () => {
    // Not applying anything: both refuse the same way (the functions exist with both signatures).
    const five = await dev.c.rpc("update_progress", { p_id: -1, p_done: 0, p_total: 1, p_item: "", p_background: true });
    const four = await dev.c.rpc("update_progress", { p_id: -1, p_done: 0, p_total: 1, p_item: "" });
    expect(five.error?.message).toMatch(/not being applied by you/);
    expect(four.error?.message).toMatch(/not being applied by you/);
  });
});
