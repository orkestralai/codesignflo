// Vercel build (Build Output API v3): the web app as static files and the hosted MCP as one Node function,
// mounted at each path it answers (no rewrites: the function sees the address as it was asked).
// Run from the repository root by vercel.json; needs @codesignflo/core built first.
//
// Environment (Vercel project settings): SUPABASE_URL, SUPABASE_ANON_KEY (also baked into the web app's
// config.json), and at runtime SUPABASE_SERVICE_ROLE_KEY, PUBLIC_URL, NOTIFY_SECRET, CRON_SECRET,
// RESEND_API_KEY, NOTIFY_FROM. See docs/DEPLOY.md.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { buildWeb } from "../web/build.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = `${root}.vercel/output`;

/** Every path the MCP server answers (OAuth discovery is asked for with and without the resource's path). */
export const PATHS = [
  "mcp",
  "register",
  "authorize",
  "token",
  "install-code",
  "ticket",
  "api/notify",
  "api/stripe/webhook",
  "api/billing/checkout",
  "api/billing/portal",
  "api/billing/confirm",
  "api/billing/refresh",
  "api/demo/start",
  "api/demo/quit",
  "api/demo/tick",
  "api/mcp-request",
  ".well-known/oauth-protected-resource",
  ".well-known/oauth-protected-resource/mcp",
  ".well-known/oauth-authorization-server",
  ".well-known/oauth-authorization-server/mcp",
  ".well-known/openid-configuration",
  ".well-known/openid-configuration/mcp",
];

/** SIGNIN_METHODS as a list; a name it doesn't know stops the build (a typo would hide a button). */
export function signInMethods(value) {
  const known = ["figma", "google", "github", "email"];
  const list = [...new Set(value.split(",").map((m) => m.trim().toLowerCase()).filter(Boolean))];
  const wrong = list.filter((m) => !known.includes(m));
  if (wrong.length || !list.length) throw new Error(`SIGNIN_METHODS: use some of ${known.join(", ")} (got "${value}")`);
  return list;
}

// The web app's own address: where people sign in, and where the plugin is downloaded (/plugin.zip).
const webUrl = (process.env.CODESIGNFLO_WEB_URL ?? process.env.PUBLIC_URL ?? "https://codesignflo.com").replace(/\/$/, "");

// The plugin's install address (PLUGIN_INSTALL_URL, else this deployment's /plugin.zip): the landing page, the
// docs and the invitation emails link it.
// The MCP's address (PUBLIC_URL): the landing page, the docs and Connect your agent show it.
const service = {
  url: process.env.SUPABASE_URL,
  anon: process.env.SUPABASE_ANON_KEY,
  pluginUrl: process.env.PLUGIN_INSTALL_URL ?? `${webUrl}/plugin.zip`,
  // The plugin's Figma Community page, once published: the landing page's "Try it in Figma".
  ...(process.env.FIGMA_COMMUNITY_URL ? { communityUrl: process.env.FIGMA_COMMUNITY_URL } : {}),
  // The sign-in buttons (SIGNIN_METHODS, e.g. "google,email,github"): each one needs its provider turned on in
  // Supabase Auth (email: Auth's own SMTP). Unset: Figma and GitHub.
  ...(process.env.SIGNIN_METHODS ? { signIn: signInMethods(process.env.SIGNIN_METHODS) } : {}),
  // The MCP's own address (its sign-in is set up for PUBLIC_URL): the same whichever domain shows the web app.
  ...(process.env.PUBLIC_URL ? { mcpUrl: `${process.env.PUBLIC_URL.replace(/\/$/, "")}/mcp` } : {}),
};
if (!service.url || !service.anon) throw new Error("set SUPABASE_URL and SUPABASE_ANON_KEY in the Vercel project's environment variables");

/**
 * On every response, the web app's and the MCP's: no page of ours inside someone else's frame (clickjacking the
 * Approve and Connect buttons), no content-type guessing, no full addresses (?code=, ?mcp=) sent to other sites,
 * no camera, microphone or location. CORS stays as the MCP sets it (the Figma plugin calls from a null origin).
 */
export const SECURITY_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/static`, { recursive: true });
await buildWeb(`${out}/static`, service);
writeFileSync(`${out}/static/plugin.zip`, packPlugin());

/**
 * The Figma plugin for this deployment's service, zipped (codesignflo.com/plugin.zip): the same release build as
 * `pnpm plugin:pack`. Another service than CoDesignFlo's (a preview deployment on the dev database) gets the
 * staging plugin: its own id and name in Figma, so it never stands in for the real one.
 */
function packPlugin() {
  const dir = `${root}packages/plugin`;
  const prod = JSON.parse(readFileSync(`${root}service/prod.json`, "utf8"));
  const env = {
    ...process.env,
    CODESIGNFLO_SERVICE_URL: service.url,
    CODESIGNFLO_SERVICE_ANON: service.anon,
    CODESIGNFLO_SERVICE_WEB: webUrl,
    ...(service.url === prod.url ? {} : { CODESIGNFLO_PLUGIN_FLAVOR: "staging" }),
  };
  execFileSync("node", ["scripts/build.mjs", "--release"], { cwd: dir, env, stdio: "inherit" });
  execFileSync("node", ["scripts/pack.mjs"], { cwd: dir, env, stdio: "inherit" });
  const version = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version;
  return readFileSync(`${dir}/codesignflo-figma-plugin-${version}${env.CODESIGNFLO_PLUGIN_FLAVOR ? "-staging" : ""}.zip`);
}

const bundle = `${out}/.mcp/index.mjs`;
await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../mcp/vercel.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: bundle,
  logLevel: "warning",
  // Some dependencies are CommonJS and call require() for Node's own modules.
  banner: { js: "import { createRequire as __cdfRequire } from 'node:module'; const require = __cdfRequire(import.meta.url);" },
});
const vc = {
  runtime: "nodejs22.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  // The handler reads the raw body itself (OAuth forms, MCP JSON): no parsing by the platform.
  shouldAddHelpers: false,
  supportsResponseStreaming: true,
  // wait_for_designer holds a request up to 50 s.
  maxDuration: 60,
};
for (const p of PATHS) {
  const dir = `${out}/functions/${p}.func`;
  mkdirSync(dir, { recursive: true });
  cpSync(bundle, `${dir}/index.mjs`);
  writeFileSync(`${dir}/.vc-config.json`, JSON.stringify(vc, null, 2));
  writeFileSync(`${dir}/package.json`, JSON.stringify({ type: "module" }));
}
rmSync(`${out}/.mcp`, { recursive: true, force: true });
writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/.*$", headers: SECURITY_HEADERS, continue: true },
        { src: "^/config\\.json$", headers: { "cache-control": "no-store" }, continue: true },
        // Search engines index codesignflo.com only: the admin app and the vercel.app addresses (the MCP's, the
        // development deployment) say noindex.
        ...["admin.codesignflo.com", "codesignflo.vercel.app", "codesignflo-dev.vercel.app"].map((host) => ({
          src: "^/.*$",
          has: [{ type: "host", value: host }],
          headers: { "x-robots-tag": "noindex" },
          continue: true,
        })),
        { handle: "filesystem" },
        { src: "^/(?!mcp|api/|\\.well-known/).*$", dest: "/index.html" },
      ],
      crons: [{ path: "/api/notify", schedule: "0 8 * * *" }],
    },
    null,
    2,
  ),
);
console.log(`Vercel output in ${out}: web app + MCP at /${PATHS.join(", /")}`);
