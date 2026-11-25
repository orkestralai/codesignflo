// Who writes what in a project: every event records its real author, a designer's decisions only count from
// designers (and admins), a developer's only from developers (and admins), and a proposal's design and its
// progress in code are each written by their own side. Against the local Supabase stack (skipped without it).
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

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

async function person(name: string): Promise<{ db: SupabaseClient; id: string; email: string }> {
  const db = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const { data, error } = await db.auth.signUp({ email, password: "test-password-123" });
  if (error) throw error;
  return { db, id: data.user!.id, email };
}

run("roles: authors and sides", { timeout: 60_000 }, () => {
  it("records the real author, keeps each side's decisions to that side, and never holds up a batch", async () => {
    const owner = await person("r-owner");
    const designer = await person("r-designer");
    const developer = await person("r-developer");
    const p = (await owner.db.rpc("create_project", { p_name: "Roles", p_root_commit: `roles_${Date.now()}` })).data as string;
    await owner.db.rpc("invite", { p_project: p, p_email: designer.email, p_role: "designer" });
    await owner.db.rpc("invite", { p_project: p, p_email: developer.email, p_role: "developer" });
    await designer.db.rpc("accept_invitations");
    await developer.db.rpc("accept_invitations");

    const at = new Date().toISOString();
    let n = 0;
    const ev = (kind: string, extra: Record<string, unknown> = {}) => ({
      project_id: p,
      id: `${kind}_${Date.now()}_${n++}`,
      at,
      by: "Someone else",
      component: "components.button",
      kind,
      body: { claim: "c1", ...extra },
    });
    const kinds = async (by: { id: string }) =>
      ((await owner.db.from("events").select("kind, user_id").eq("project_id", p).eq("user_id", by.id)).data ?? []).map((r) => r.kind).sort();

    // A designer's batch: their own decisions land; a developer's decision in it is dropped, the rest still lands.
    const dBatch = [ev("claimed", { baselineGen: "g" }), ev("building"), ev("closed", { commit: "", items: [], how: "accepted" }), ev("generated")];
    expect((await designer.db.from("events").insert(dBatch)).error).toBeNull();
    expect(await kinds(designer)).toEqual(["claimed", "closed", "generated"]);

    // A developer's batch: a designer's decision in it is dropped.
    const vBatch = [ev("building"), ev("ready", { note: "n", readyHash: "h" }), ev("delivered"), ev("closed", { commit: "", items: [], how: "code" })];
    expect((await developer.db.from("events").insert(vBatch)).error).toBeNull();
    expect(await kinds(developer)).toEqual(["building", "closed", "delivered"]);

    // The author can't be chosen: naming someone else records the real author anyway.
    const forged = { ...ev("seen"), user_id: designer.id };
    expect((await developer.db.from("events").insert(forged)).error).toBeNull();
    expect((await owner.db.from("events").select("user_id").eq("project_id", p).eq("id", forged.id).single()).data).toEqual({ user_id: developer.id });
    // An admin may write either side's.
    expect((await owner.db.from("events").insert([ev("ready", { note: "n", readyHash: "h" }), ev("dev_reviewed")])).error).toBeNull();
    expect(await kinds(owner)).toEqual(["dev_reviewed", "ready"]);

    // Proposals: designers write the design, developers its progress in code.
    const row = { project_id: p, claim_id: "c1", component: "components.button", payload: { note: "design" } };
    expect((await developer.db.from("proposals").insert({ ...row, claim_id: "c0" })).error).toBeNull();
    expect((await owner.db.from("proposals").select("claim_id").eq("project_id", p).eq("claim_id", "c0")).data).toEqual([]);
    expect((await designer.db.from("proposals").insert(row)).error).toBeNull();
    await developer.db.from("proposals").update({ payload: { note: "rewritten" }, code_check: { done: 1, total: 2 } }).eq("project_id", p).eq("claim_id", "c1");
    await designer.db.from("proposals").update({ code_check: { done: 2, total: 2 } }).eq("project_id", p).eq("claim_id", "c1");
    const prop = (await owner.db.from("proposals").select("payload, code_check").eq("project_id", p).eq("claim_id", "c1").single()).data;
    expect(prop).toEqual({ payload: { note: "design" }, code_check: { done: 1, total: 2 } });

    // Someone who designs and codes: an admin makes them an admin by inviting them again; then both sides count.
    expect((await developer.db.rpc("my_role", { p_project: p })).data).toBe("developer");
    expect((await designer.db.rpc("invite", { p_project: p, p_email: developer.email, p_role: "designer" })).data).toBe("member");
    expect((await developer.db.rpc("my_role", { p_project: p })).data).toBe("developer");
    expect((await owner.db.rpc("invite", { p_project: p, p_email: developer.email, p_role: "admin" })).data).toBe("role_changed");
    expect((await developer.db.rpc("my_role", { p_project: p })).data).toBe("admin");
    const both = ev("ready", { note: "n", readyHash: "h2" });
    await developer.db.from("events").insert(both);
    expect((await owner.db.from("events").select("kind").eq("project_id", p).eq("id", both.id)).data).toEqual([{ kind: "ready" }]);
    // The owner stays an admin; the last admin stays one.
    expect((await developer.db.rpc("invite", { p_project: p, p_email: owner.email, p_role: "designer" })).error?.message).toMatch(/owner stays an admin/);
    expect((await owner.db.rpc("invite", { p_project: p, p_email: developer.email, p_role: "developer" })).data).toBe("role_changed");
    expect((await developer.db.rpc("my_role", { p_project: p })).data).toBe("developer");
  });
});
