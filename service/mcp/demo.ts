// The guided demo (the plugin's "Try a demo"): one demo project per person, marked settings.demo, with a
// simulated developer, Alex (a service account, developer member), and a sample shop app uploaded as its first
// Live update with its pictures, as a sync would (demo/seed.json, built by demo/build-seed.ts). The person's
// plugin then sets up their file for it and applies Live, as for any project. Demo sends never count toward the
// free sends (20261119000100_demo.sql).
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import seed from "../demo/seed.json" with { type: "json" };

/** The simulated developer's account (no password: nobody signs in as Alex). */
export const ALEX = { email: "alex@demo.codesignflo.com", name: "Alex" };
export const DEMO_NAME = "CoDesignFlo demo";

type Update = (typeof seed)["update"];

/** A Live update as the CLI uploads it: the compiled code gzipped in `bundle`, the rest as JSON. */
export function liveRow(project: string, by: string, update: Update, commit: string, registry: unknown = seed.registry) {
  const { sets, screens, ...meta } = update;
  return {
    project_id: project,
    created_by: by,
    commit,
    branch: "main",
    kind: "live",
    status: "pending",
    payload: { ...meta, commit, pictures: Object.keys(seed.pictures).length, registry, setup: null },
    bundle: gzipSync(JSON.stringify({ sets, screens })).toString("base64"),
  };
}

/**
 * Alex ships a feature, the way developers do: built first, with no design yet. Once the person's plugin has
 * applied the sample shop (and nothing else is waiting), his next update adds a Free shipping badge to the
 * products that ship free; it shows in Figma as New in code, for the designer to fix. Once per demo. Whether he
 * shipped it now.
 */
export async function shipFeature(db: SupabaseClient, project: string): Promise<boolean> {
  const { data: updates } = await db.from("live_updates").select("commit, status").eq("project_id", project).eq("kind", "live");
  const all = (updates ?? []) as { commit: string; status: string }[];
  if (all.some((u) => u.commit === "demo-2") || all.some((u) => u.status === "pending" || u.status === "applying")) return false;
  if (!all.some((u) => u.commit === "demo-1" && u.status === "applied")) return false;
  const { error } = await db.from("live_updates").insert(liveRow(project, await alex(db), seed.update2 as Update, "demo-2", seed.registry2));
  if (error) throw new Error(`couldn't ship the demo's feature: ${error.message}`);
  return true;
}

/** Alex's user id, made the first time. */
export async function alex(db: SupabaseClient): Promise<string> {
  const { data: found } = await db.from("profiles").select("id").eq("email", ALEX.email).maybeSingle();
  if (found?.id) return found.id as string;
  // A self-hosted box lets this account in with its demo key (null in the cloud).
  const { data: key } = await db.rpc("demo_key").then(
    (r) => r,
    () => ({ data: null }),
  );
  const { data, error } = await db.auth.admin.createUser({
    email: ALEX.email,
    email_confirm: true,
    user_metadata: { full_name: `${ALEX.name} (demo developer)`, name: ALEX.name, ...(typeof key === "string" && key ? { codesignflo_demo_key: key } : {}) },
  });
  if (error || !data.user) {
    // Made meanwhile by another request: look again.
    const { data: again } = await db.from("profiles").select("id").eq("email", ALEX.email).maybeSingle();
    if (again?.id) return again.id as string;
    throw new Error(`couldn't set up the demo developer: ${error?.message ?? "no user"}`);
  }
  return data.user.id;
}

/** The sample app's pictures (product photos, the pages' screenshots), in the project's media storage. */
async function uploadPictures(db: SupabaseClient, project: string) {
  const bucket = db.storage.from("media");
  await Promise.all(
    Object.entries(seed.pictures as Record<string, string>).map(async ([ref, b64]) => {
      const bytes = Buffer.from(b64, "base64");
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const { error } = await bucket.upload(`${project}/${ref}`, bytes, { contentType: jpeg ? "image/jpeg" : "image/png", upsert: true });
      if (error) throw new Error(`couldn't set up the demo's pictures: ${error.message}`);
    }),
  );
}

/** A deleted demo's pictures go too. */
async function removePictures(db: SupabaseClient, project: string) {
  const bucket = db.storage.from("media");
  const { data } = await bucket.list(project, { limit: 1000 });
  const files = (data ?? []).map((f) => `${project}/${f.name}`);
  if (files.length) await bucket.remove(files);
}

/** The person's demo project, if they have one. */
export async function demoOf(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await db.from("projects").select("id").eq("owner", userId).eq("settings->>demo", "true").limit(1);
  return ((data ?? [])[0]?.id as string | undefined) ?? null;
}

/** "Quit demo": the person's demo project goes, with its history and pictures. Returns whether there was one. */
export async function quitDemo(db: SupabaseClient, userId: string): Promise<boolean> {
  const existing = await demoOf(db, userId);
  if (!existing) return false;
  const { error } = await db.from("projects").delete().eq("id", existing);
  if (error) throw new Error(`couldn't quit the demo: ${error.message}`);
  await removePictures(db, existing).catch(() => undefined);
  return true;
}

/**
 * Starts the person's demo: their existing one (the file may be a new one), or a new one (after "Quit demo",
 * a fresh one). Returns the project id.
 */
export async function startDemo(db: SupabaseClient, userId: string): Promise<{ projectId: string; fresh: boolean }> {
  const existing = await demoOf(db, userId);
  if (existing) return { projectId: existing, fresh: false };
  const dev = await alex(db);
  const projectId = `p_${randomBytes(6).toString("hex")}`;
  const { error: pe } = await db
    .from("projects")
    .insert({ id: projectId, name: DEMO_NAME, owner: userId, settings: { demo: true, liveBranch: "main" } });
  if (pe) throw new Error(`couldn't start the demo: ${pe.message}`);
  const { error: me } = await db.from("project_members").insert([
    { project_id: projectId, user_id: userId, role: "admin" },
    { project_id: projectId, user_id: dev, role: "developer" },
  ]);
  if (me) throw new Error(`couldn't start the demo: ${me.message}`);
  await uploadPictures(db, projectId);
  const { error: le } = await db.from("live_updates").insert(liveRow(projectId, dev, seed.update as Update, "demo-1"));
  if (le) throw new Error(`couldn't start the demo: ${le.message}`);
  return { projectId, fresh: true };
}
