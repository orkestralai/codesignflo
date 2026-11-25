// Builds the web app into web/dist: index.html, app.js (bundled), and config.json when the service's address
// is given (SUPABASE_URL / SUPABASE_ANON_KEY — the deployment build; development serves it from dev.mjs).
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  return out;
}

function serviceFromEnv(env = process.env) {
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anon ? { url, anon } : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`web app in ${await buildWeb()}`);
