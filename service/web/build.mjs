// Builds the web app into web/dist: index.html, app.js (bundled), and config.json when the service's address
// is given (SUPABASE_URL / SUPABASE_ANON_KEY — the deployment build; development serves it from dev.mjs).
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export async function buildWeb(out = here("dist"), service = serviceFromEnv()) {
  mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [here("src/app.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap: false,
    outfile: `${out}/app.js`,
    logLevel: "warning",
  });
  copyFileSync(here("index.html"), `${out}/index.html`);
  // Icons, the social share image (og.png), robots.txt, sitemap.xml: served as they are.
  cpSync(here("public"), out, { recursive: true });
  if (service) writeFileSync(`${out}/config.json`, JSON.stringify(service));
  if (service && service.mode !== "selfhost") await prerender(out, service);
  return out;
}

/**
 * CoDesignFlo's site, readable without JavaScript (search engines; Google's review of the sign-in app reads the home
 * page and the privacy policy that way): the landing page written into index.html, and each legal page into its own
 * file, served at /privacy, /terms… The app draws over them when it starts.
 */
async function prerender(out, service) {
  const tmp = `${out}/.prerender.mjs`;
  await esbuild.build({
    stdin: {
      contents: `export { landingHtml } from "./src/landing.ts"; export { legalHtml, LEGAL_PAGES, LEGAL_TITLES } from "./src/legal.ts"; export { FIRST_PROMPT } from "./src/agents.ts";`,
      resolveDir: here("."),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: tmp,
    logLevel: "warning",
  });
  const m = await import(pathToFileURL(tmp).href);
  rmSync(tmp);
  const shell = readFileSync(here("index.html"), "utf8");
  const site = "https://codesignflo.com";
  const page = (drawn, title, path) => {
    // Marked: index.html hides it when the app is about to draw another page (see its first script).
    const body = drawn.replace('<div class="lp">', '<div class="lp" data-prerendered>');
    const html = shell
      .replace('<main id="app"><p class="narrow">Loading…</p></main>', () => `<main id="app">${body}</main>`)
      .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
      .replace(/<link rel="canonical" href="[^"]*" \/>/, () => `<link rel="canonical" href="${site}${path}" />`);
    if (!html.includes(body)) throw new Error("index.html has no <main id=\"app\"> to prerender into");
    return html;
  };
  const landing = m.landingHtml({
    mcpUrl: service.mcpUrl ?? `${site}/mcp`,
    pluginUrl: service.pluginUrl,
    communityUrl: service.communityUrl,
    firstPrompt: m.FIRST_PROMPT,
    referred: false,
    signIn: service.signIn,
  });
  const title = /<title>([^<]*)<\/title>/.exec(shell)?.[1] ?? "CoDesignFlo";
  writeFileSync(`${out}/index.html`, page(landing, title, "/"));
  for (const p of m.LEGAL_PAGES) writeFileSync(`${out}/${p}.html`, page(m.legalHtml(p), `${m.LEGAL_TITLES[p]} — CoDesignFlo`, `/${p}`));
}

function serviceFromEnv(env = process.env) {
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anon ? { url, anon } : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`web app in ${await buildWeb()}`);
