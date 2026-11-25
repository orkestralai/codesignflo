// codesignflo dev:reload — development only: hot-swaps the running plugin (dev build) with the current
// build in packages/plugin/dist, so plugin changes don't need the plugin to be reopened in Figma.
import { readFileSync } from "node:fs";
import { requireConfig } from "../project.js";
import { withPlugin } from "./connect.js";

export async function devReload(): Promise<number> {
  const config = requireConfig();
  const dist = new URL("../../../plugin/dist/", import.meta.url);
  const code = readFileSync(new URL("code.js", dist), "utf8");
  const html = readFileSync(new URL("ui.html", dist), "utf8");
  await withPlugin({ projectId: config.projectId }, async (s) => {
    await s.call("dev.reload", { code, html });
  });
  console.log(`plugin reloaded (${Math.round(code.length / 1024)} kB code, ${Math.round(html.length / 1024)} kB panel)`);
  return 0;
}
