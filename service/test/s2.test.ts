// Live updates through the service against the local Supabase stack. Skipped when it isn't running.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { type UpdateInput, unpackBundle } from "@codesignflo/core";
import { beforeAll, describe, expect, it } from "vitest";
import { liveMeta, packBundle } from "../../packages/cli/src/commands/live.js";

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

run("live updates: the developer uploads, a plugin applies", () => {
  let dev: SupabaseClient;
  let designer: SupabaseClient;
  let other: SupabaseClient;
  let project: string;
  const upload = (commit: string) =>
    dev.from("live_updates").insert({ project_id: project, commit, payload: { sets: [] } }).select("id").single();

  beforeAll(async () => {
    const designerEmail = emailFor("designer");
    [dev, designer, other] = await Promise.all([signUp(emailFor("dev")), signUp(designerEmail), signUp(emailFor("other"))]);
    project = (await dev.rpc("create_project", { p_name: "Shop", p_root_commit: `root_${Date.now()}` })).data as string;
    await dev.rpc("invite", { p_project: project, p_email: designerEmail, p_role: "designer" });
  });

  it("only developers upload updates; designers and strangers can't", async () => {
    expect((await upload("c1")).error).toBeNull();
    expect((await designer.from("live_updates").insert({ project_id: project, commit: "x", payload: {} })).error).not.toBeNull();
    expect((await other.from("live_updates").insert({ project_id: project, commit: "x", payload: {} })).error).not.toBeNull();
  });

  it("the plugin takes the newest update; older ones are superseded; one plugin at a time", async () => {
    const newest = (await upload("c2")).data!.id as number;
    const taken = (await designer.rpc("take_update", { p_project: project })).data as { id: number; commit: string }[];
    expect(taken.map((t) => t.commit)).toEqual(["c2"]);
    expect((await dev.rpc("take_update", { p_project: project })).data).toEqual([]);
    const all = (await dev.from("live_updates").select("commit, status").eq("project_id", project).order("id")).data;
    expect(all).toEqual([
      { commit: "c1", status: "superseded" },
      { commit: "c2", status: "applying" },
    ]);
    expect((await dev.rpc("finish_update", { p_id: newest, p_ok: true, p_log: "x" })).error?.message).toMatch(/not being applied by you/);
    expect((await designer.rpc("finish_update", { p_id: newest, p_ok: true, p_log: "closed: cart-item" })).error).toBeNull();
    const done = (await dev.from("live_updates").select("status, log").eq("id", newest).single()).data;
    expect(done).toEqual({ status: "applied", log: "closed: cart-item" });
    expect((await designer.rpc("take_update", { p_project: project })).data).toEqual([]);
  });

  it("a big app's update travels gzipped: stored and taken in time, unpacked whole; applying a newer one drops it", async () => {
    // ~8 MB of compiled pages as JSON (orkestralai's 37 pages: 7.7 MB), which timed out stored as JSON.
    const node = (i: number) => ({ k: `n${i}`, type: "FRAME", name: `row ${i}`, width: 1728, height: 64, fills: [{ hex: "#ffffff" }] });
    const screens = Array.from({ length: 37 }, (_, s) => ({
      spec: { k: `screen:page-${s}`, type: "FRAME", name: `page ${s}`, children: Array.from({ length: 2000 }, (_, i) => node(s * 2000 + i)) },
      coverage: { nodes: 2000, inInstances: 0, instances: {} },
    }));
    const input = { sets: [], screens, dtcg: {}, commit: "big", keys: [], deliveries: [] } as unknown as UpdateInput;
    expect(JSON.stringify(screens).length).toBeGreaterThan(7_000_000);
    const first = (await dev.from("live_updates").insert({ project_id: project, commit: "big", payload: liveMeta(input), bundle: packBundle(input) }).select("id").single());
    expect(first.error).toBeNull();
    const taken = (await designer.rpc("take_update", { p_project: project })).data as { id: number; payload: object; bundle: string }[];
    expect(taken[0]!.id).toBe(first.data!.id);
    expect(taken[0]!.payload).not.toHaveProperty("screens");
    expect((await unpackBundle(taken[0]!.bundle)).screens).toEqual(screens);
    expect((await designer.rpc("finish_update", { p_id: first.data!.id, p_ok: true, p_log: "" })).error).toBeNull();
    // The newest applied update stays whole (nothing newer replaced it yet)…
    const kept = (await dev.from("live_updates").select("bundle").eq("id", first.data!.id).single()).data as { bundle: string | null };
    expect(kept.bundle).not.toBeNull();
    // …until a newer one is applied.
    const next = (await upload("after")).data!.id as number;
    await designer.rpc("take_update", { p_project: project });
    await designer.rpc("finish_update", { p_id: next, p_ok: true, p_log: "" });
    const dropped = (await dev.from("live_updates").select("bundle, payload").eq("id", first.data!.id).single()).data as { bundle: string | null; payload: object };
    expect(dropped.bundle).toBeNull();
    expect(dropped.payload).toHaveProperty("commit", "big");
  }, 30_000);

  it("the applying plugin saves its progress (only it); each save keeps the update from being taken over", async () => {
    const id = (await upload("progress")).data!.id as number;
    await designer.rpc("take_update", { p_project: project });
    expect((await designer.rpc("update_progress", { p_id: id, p_done: 3, p_total: 52, p_item: "badge" })).error).toBeNull();
    expect((await dev.rpc("update_progress", { p_id: id, p_done: 9, p_total: 52, p_item: "x" })).error?.message).toMatch(/not being applied by you/);
    const row = (await dev.from("live_updates").select("status, progress, taken_at").eq("id", id).single()).data as {
      status: string;
      progress: unknown;
      taken_at: string;
    };
    expect(row.status).toBe("applying");
    expect(row.progress).toEqual({ done: 3, total: 52, item: "badge" });
    expect(Date.now() - Date.parse(row.taken_at)).toBeLessThan(60_000);
    expect((await designer.rpc("finish_update", { p_id: id, p_ok: true, p_log: "" })).error).toBeNull();
  });

  it("branch previews: taken after Live, the newest per branch; plugins from before previews never get them", async () => {
    const preview = (branch: string, commit: string) =>
      dev.from("live_updates").insert({ project_id: project, commit, branch, kind: "preview", payload: { sets: [] } }).select("id").single();
    expect((await designer.from("live_updates").insert({ project_id: project, commit: "x", branch: "f", kind: "preview", payload: {} })).error).not.toBeNull();
    expect((await preview("feature-a", "a1")).error).toBeNull();
    const a2 = (await preview("feature-a", "a2")).data!.id as number;
    const b1 = (await preview("feature-b", "b1")).data!.id as number;
    const live = (await upload("live-1")).data!.id as number;
    // An older plugin: Live only.
    expect((await designer.rpc("take_update", { p_project: project })).data.map((r: { id: number }) => r.id)).toEqual([live]);
    expect((await designer.rpc("finish_update", { p_id: live, p_ok: true, p_log: "" })).error).toBeNull();
    expect((await designer.rpc("take_update", { p_project: project })).data).toEqual([]);
    // A newer plugin: the newest preview (feature-b), then feature-a's newest; its older one is superseded.
    const next = async () => ((await designer.rpc("take_next_update", { p_project: project })).data as { id: number; kind: string; branch: string }[]);
    const first = await next();
    expect(first.map((r) => [r.id, r.kind, r.branch])).toEqual([[b1, "preview", "feature-b"]]);
    expect(await next()).toEqual([]);
    expect((await designer.rpc("finish_update", { p_id: b1, p_ok: true, p_log: "" })).error).toBeNull();
    expect((await next()).map((r) => r.id)).toEqual([a2]);
    const rows = (await dev.from("live_updates").select("commit, status").eq("project_id", project).eq("kind", "preview").order("id")).data;
    expect(rows).toEqual([
      { commit: "a1", status: "superseded" },
      { commit: "a2", status: "applying" },
      { commit: "b1", status: "applied" },
    ]);
    expect((await designer.rpc("finish_update", { p_id: a2, p_ok: true, p_log: "" })).error).toBeNull();
    // Live still comes first.
    const l2 = (await upload("live-2")).data!.id as number;
    await preview("feature-a", "a3");
    expect((await next()).map((r) => r.id)).toEqual([l2]);
  });

  it("generations: members add and read them, nobody changes them; strangers see nothing", async () => {
    const row = { project_id: project, component: "badge", gen: "g_1", snapshot: { type: "FRAME" } };
    expect((await designer.from("generations").insert(row)).error).toBeNull();
    await designer.from("generations").update({ snapshot: { type: "TEXT" } }).eq("project_id", project).eq("gen", "g_1");
    expect((await dev.from("generations").select("snapshot").eq("project_id", project)).data).toEqual([{ snapshot: { type: "FRAME" } }]);
    expect((await other.from("generations").select("gen").eq("project_id", project)).data).toEqual([]);
    expect((await other.rpc("take_update", { p_project: project })).error?.message).toMatch(/not in this project/);
  });
});
