// Pictures of a Live update (the app's images, the pages' screenshots) in the project's media storage, against
// the local Supabase stack. Skipped when it isn't running.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { uploadMedia } from "../../packages/cli/src/commands/live.js";

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
// A 1×1 PNG and a few bytes of JPEG (content is never decoded by the storage).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString("base64");

run("media: a sync's pictures, for the project's members only", () => {
  let dev: SupabaseClient;
  let designer: SupabaseClient;
  let other: SupabaseClient;
  let project: string;

  beforeAll(async () => {
    const designerEmail = emailFor("designer");
    [dev, designer, other] = await Promise.all([signUp(emailFor("dev")), signUp(designerEmail), signUp(emailFor("other"))]);
    project = (await dev.rpc("create_project", { p_name: "Shop", p_root_commit: `root_${Date.now()}` })).data as string;
    await dev.rpc("invite", { p_project: project, p_email: designerEmail, p_role: "designer" });
  });

  it("the developer's sync uploads each picture once; the designer reads them; strangers can't", async () => {
    const images = new Map([
      ["png1", PNG],
      ["jpg1", JPEG],
    ]);
    expect(await uploadMedia({ client: dev, projectId: project } as never, images)).toBe(2);
    expect(await uploadMedia({ client: dev, projectId: project } as never, images)).toBe(0);
    const got = await designer.storage.from("media").download(`${project}/jpg1`);
    expect(got.error).toBeNull();
    expect(got.data!.type).toBe("image/jpeg");
    expect(Buffer.from(await got.data!.arrayBuffer()).toString("base64")).toBe(JPEG);
    expect((await other.storage.from("media").download(`${project}/png1`)).error).not.toBeNull();
  });

  it("designers and strangers can't add pictures", async () => {
    const bytes = Buffer.from(PNG, "base64");
    const opts = { contentType: "image/png" };
    expect((await designer.storage.from("media").upload(`${project}/d1`, bytes, opts)).error).not.toBeNull();
    expect((await other.storage.from("media").upload(`${project}/o1`, bytes, opts)).error).not.toBeNull();
  });
});
