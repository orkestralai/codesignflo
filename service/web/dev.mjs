// Local development server for the web app: builds it, serves web/dist and /config.json from `supabase status`.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { buildWeb } from "./build.mjs";

const status = execSync("supabase status -o env", { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
const get = (k) => new RegExp(`^${k}="?([^"\\n]+)`, "m").exec(status)?.[1];
// The local MCP (mcp/dev.ts): the sign-in page asks it about a coding agent's request.
const mcpUrl = `http://localhost:${process.env.MCP_PORT ?? 3318}/mcp`;
// CODESIGNFLO_MODE=selfhost: the web app as on a self-hosted box (sign-in with email, no billing, no landing page).
const selfhost = process.env.CODESIGNFLO_MODE === "selfhost" ? { mode: "selfhost" } : {};
// SIGNIN_METHODS (e.g. "google,email,github"): the sign-in buttons, as on Vercel.
// PLUGIN_INSTALL_URL: where the landing page's download button points (codesignflo.com/plugin.zip in production).
const pluginUrl = process.env.PLUGIN_INSTALL_URL ? { pluginUrl: process.env.PLUGIN_INSTALL_URL } : {};
const signIn = process.env.SIGNIN_METHODS ? { signIn: process.env.SIGNIN_METHODS.split(",").map((m) => m.trim()).filter(Boolean) } : {};
const config = JSON.stringify({ url: get("API_URL").replace("127.0.0.1", "localhost"), anon: get("ANON_KEY"), devEmail: true, mcpUrl, ...selfhost, ...signIn, ...pluginUrl });
const dist = await buildWeb(undefined, null);
const types = { ".js": "text/javascript", ".html": "text/html", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain", ".xml": "application/xml", ".webmanifest": "application/manifest+json", ".css": "text/css", ".woff2": "font/woff2" };
const port = Number(process.env.PORT ?? 3317);
createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/config.json") return void res.writeHead(200, { "content-type": "application/json" }).end(config);
  const file = join(dist, path === "/" ? "index.html" : path);
  if (!file.startsWith(dist) || !existsSync(file))
    return void res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(join(dist, "index.html")));
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
}).listen(port, () => console.log(`web app on http://localhost:${port}`)); // all interfaces: localhost may be ::1
