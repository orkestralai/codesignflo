// Every /api/… path the server answers is deployed on Vercel too (PATHS in scripts/vercel-build.mjs): a route left
// out answered 404 in production (/api/plugin, the plugin's update check, in 0.5.1). Read as text: importing the
// build script would run the build.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = join(import.meta.dirname, "..");
describe("deployed routes", () => {
  it("every /api path in the server is a Vercel function", () => {
    const server = readFileSync(join(here, "mcp/server.ts"), "utf8");
    const build = readFileSync(join(here, "scripts/vercel-build.mjs"), "utf8");
    const routes = [...new Set([...server.matchAll(/path === "\/(api\/[^"]+)"/g)].map((m) => m[1]!))];
    const paths = /export const PATHS = \[([\s\S]*?)\];/.exec(build)![1]!;
    const deployed = [...paths.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.filter((r) => !deployed.includes(r))).toEqual([]);
  });
});
