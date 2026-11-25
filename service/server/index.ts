// The self-hosted service ("team box"): one plain Node server for the web app and the MCP, the same handler the
// Vercel deployment mounts (mcp/vercel.ts), plus what Vercel's platform does there: the static web app with its
// security headers, /config.json, and the daily /api/notify cron. Built into one file by server/build.mjs.
//
// Environment (selfhost/.env.example explains each):
//   PORT                        where this server listens (default 3000)
//   PUBLIC_URL                  the box's public address, e.g. https://design.acme.com (the MCP is <PUBLIC_URL>/mcp)
//   SUPABASE_URL                the Supabase API as this server reaches it (inside Docker: http://gateway:8080)
//   SUPABASE_PUBLIC_URL         the Supabase API as browsers, the plugin and the CLI reach it (default: PUBLIC_URL)
//   SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   NOTIFY_SECRET               shared with the database (app_config.notify_secret): who may trigger /api/notify
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, NOTIFY_FROM (or SMTP_FROM_EMAIL + SMTP_FROM_NAME)
//   EMAIL_AUTOCONFIRM           "false" (with SMTP): Auth confirms addresses by email, so invitations need no code
//   CODESIGNFLO_MODE            "selfhost" (default here)
//   NOTIFY_EVERY_MINUTES        catch-up sends between the database's pings (default 10; 0 = off)
//   NOTIFY_DAILY_HOUR_UTC       the daily run, as Vercel's cron (default 8)
//   WEB_DIR                     the built web app (default: ./web next to this file)
//   CODESIGNFLO_PLUGIN_TEMPLATE the Figma plugin template (the image has it): /plugin.zip is the plugin for this box
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBoxConfig, writePlugin } from "../../packages/cli/src/selfhost.ts";
import handler from "../mcp/vercel.ts";

declare const __CDF_ROUTES__: { paths: string[]; headers: Record<string, string> } | undefined;
// Bundled: inlined at build time. Run from the checkout (node server/index.ts): read from vercel-build.mjs.
const { paths: PATHS, headers: SECURITY_HEADERS } =
  typeof __CDF_ROUTES__ !== "undefined" ? __CDF_ROUTES__ : (await import("./routes.mjs")).routes();

const env = process.env;
const trim = (u: string) => u.replace(/\/$/, "");
const need = (k: string) => {
  const v = env[k];
  if (!v) throw new Error(`${k} is not set (see selfhost/.env.example)`);
  return v;
};

const port = Number(env.PORT ?? 3000);
const publicUrl = trim(need("PUBLIC_URL"));
const internalSupabase = trim(need("SUPABASE_URL"));
const publicSupabase = trim(env.SUPABASE_PUBLIC_URL || publicUrl);
const anon = need("SUPABASE_ANON_KEY");
need("SUPABASE_SERVICE_ROLE_KEY");
const mode = env.CODESIGNFLO_MODE || "selfhost";
env.CODESIGNFLO_MODE = mode;

// The handler hands the Supabase address to the CLI (tickets, install codes), so it must be the public one; this
// server itself reaches Supabase inside Docker. Its requests to the public address go to the internal one.
env.SUPABASE_URL = publicSupabase;
if (publicSupabase !== internalSupabase) {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === publicSupabase || url.startsWith(`${publicSupabase}/`)) {
      const to = internalSupabase + url.slice(publicSupabase.length);
      return fetchOriginal(input instanceof Request ? new Request(to, input) : to, init);
    }
    return fetchOriginal(input, init);
  };
}
if (!env.NOTIFY_FROM && env.SMTP_FROM_EMAIL)
  env.NOTIFY_FROM = env.SMTP_FROM_NAME ? `${env.SMTP_FROM_NAME} <${env.SMTP_FROM_EMAIL}>` : env.SMTP_FROM_EMAIL;

const config = JSON.stringify({
  mode,
  url: publicSupabase,
  anon,
  mcpUrl: `${publicUrl}/mcp`,
  // The box sends emails (invitations, notifications) only with SMTP; Auth's magic links use the same SMTP.
  emails: !!env.SMTP_HOST,
  magicLink: !!env.SMTP_HOST,
  // Invitations need their sign-up code unless Auth proves addresses by email (SMTP, EMAIL_AUTOCONFIRM=false).
  codes: !(env.SMTP_HOST && env.EMAIL_AUTOCONFIRM === "false"),
  ...(env.PLUGIN_INSTALL_URL ? { pluginUrl: env.PLUGIN_INSTALL_URL } : {}),
  ...(env.FIGMA_COMMUNITY_URL ? { communityUrl: env.FIGMA_COMMUNITY_URL } : {}),
});

const webDir = normalize(env.WEB_DIR ?? fileURLToPath(new URL("./web", import.meta.url)));
if (!existsSync(join(webDir, "index.html"))) throw new Error(`no web app in ${webDir} (build it: node server/build.mjs)`);
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

/** The MCP's paths (as Vercel mounts them), and anything under /api/ and /.well-known/ (its own 404 there). */
const ROOT_PATHS = new Set(PATHS.map((p) => `/${p}`));
const isMcp = (path: string) =>
  ROOT_PATHS.has(path.replace(/\/$/, "")) || path.startsWith("/api/") || path.startsWith("/.well-known/") || path.startsWith("/mcp/");

function serveFile(req: IncomingMessage, res: ServerResponse, path: string) {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // a malformed address: the app's index below
  }
  let file = normalize(join(webDir, decoded));
  const inside = file === webDir || file.startsWith(`${webDir}/`);
  if (!inside || !existsSync(file) || statSync(file).isDirectory()) file = join(webDir, "index.html"); // the app's routes
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  // Code and pages are checked for a newer version on every load (as on Vercel), so a box update reaches everyone at once;
  // fonts and pictures are kept for a day.
  const cache = /\.(html|js|css|json|webmanifest)$/.test(file) ? "no-cache" : "public, max-age=86400";
  res.writeHead(200, { "content-type": type, "cache-control": cache });
  res.end(req.method === "HEAD" ? undefined : readFileSync(file));
}

/**
 * The Figma plugin made for this box (its PUBLIC_URL), as `codesignflo plugin build --server` makes it: built once
 * per start, so designers download it from the Set up page and need no Node or command line.
 */
let pluginZip: { data: Buffer; name: string } | Error | null = null;
function plugin(): { data: Buffer; name: string } | Error {
  if (pluginZip) return pluginZip;
  const template = env.CODESIGNFLO_PLUGIN_TEMPLATE;
  if (!template || !existsSync(join(template, "template.json")))
    return new Error("This server has no Figma plugin template (CODESIGNFLO_PLUGIN_TEMPLATE): use `npx @codesignflo/cli plugin build --server <address>`.");
  const dir = mkdtempSync(join(tmpdir(), "cdf-plugin-"));
  try {
    const box = new URL(publicUrl);
    const cfg = parseBoxConfig({ mode: "selfhost", url: publicSupabase, anon, web: publicUrl, mcpUrl: `${publicUrl}/mcp` }, box);
    const built = writePlugin(cfg, join(dir, "CoDesignFlo"), template, `download the plugin again from ${publicUrl}/#/setup and replace this folder's files with the new ones (same folder). No re-import needed.`);
    const host = box.host.replace(/[^\w.-]/g, "-");
    pluginZip = { data: readFileSync(built.zip), name: `codesignflo-plugin-${host}-${built.version}.zip` };
  } catch (e) {
    pluginZip = e instanceof Error ? e : new Error(String(e));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return pluginZip;
}

async function healthz(res: ServerResponse) {
  const probe = async (url: string, headers: Record<string, string> = {}) => {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
      return r.status < 500;
    } catch {
      return false;
    }
  };
  const [auth, rest] = await Promise.all([
    probe(`${internalSupabase}/auth/v1/health`, { apikey: anon }),
    probe(`${internalSupabase}/rest/v1/`, { apikey: anon, authorization: `Bearer ${anon}` }),
  ]);
  const ok = auth && rest;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ ok, mode, auth, rest }));
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://box").pathname;
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (path === "/healthz") return void healthz(res);
  if (path === "/config.json")
    return void res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(config);
  if (path === "/plugin.zip") {
    const p = plugin();
    if (p instanceof Error) return void res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(p.message);
    return void res
      .writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${p.name}"`, "cache-control": "no-cache" })
      .end(req.method === "HEAD" ? undefined : p.data);
  }
  if (isMcp(path)) return void handler(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
  serveFile(req, res, path);
});
// wait_for_designer holds a request up to 50 s (Vercel's maxDuration is 60).
server.requestTimeout = 120_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 65_000;
server.listen(port, () => console.log(`CoDesignFlo (${mode}) on :${port} — ${publicUrl} (MCP: ${publicUrl}/mcp)`));

/** /api/notify on this server, as the database's ping (pg_net) calls it: the shared NOTIFY_SECRET. */
async function runNotify(why: string) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/notify`, {
      method: "POST",
      headers: { "x-codesignflo-secret": env.NOTIFY_SECRET as string },
    });
    const body = await r.text();
    if (!r.ok || why === "daily") console.log(`notify (${why}): ${r.status} ${body.slice(0, 200)}`);
  } catch (e) {
    console.error(`notify (${why}):`, e);
  }
}
const every = Number(env.NOTIFY_EVERY_MINUTES ?? 10);
if (!env.NOTIFY_SECRET) console.warn("NOTIFY_SECRET is not set: notifications are sent only when someone invites");
if (every > 0 && env.NOTIFY_SECRET) setInterval(() => void runNotify("catch-up"), every * 60_000).unref();
const dailyHour = Number(env.NOTIFY_DAILY_HOUR_UTC ?? 8);
function scheduleDaily() {
  const next = new Date();
  next.setUTCHours(dailyHour, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => {
    if (env.NOTIFY_SECRET) void runNotify("daily");
    scheduleDaily();
  }, next.getTime() - Date.now()).unref();
}
scheduleDaily();

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
