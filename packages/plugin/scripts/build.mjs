// Bundles the plugin: dist/code.js (main thread) and dist/ui.html (UI with the script inlined).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const watch = process.argv.includes("--watch");
// --flavor selfhost-template: the plugin for self-hosted boxes, shipped inside the CLI's npm package. Its service
// is a placeholder that `codesignflo plugin build --server <box>` replaces with the box's own config, and it
// writes the manifest (own id, name, the box's domains). Always a release build.
const flavor = arg("--flavor") ?? process.env.CODESIGNFLO_PLUGIN_FLAVOR;
const template = flavor === "selfhost-template";
// Release builds (the designer zip) leave out development-only features such as dev.eval.
const release = process.argv.includes("--release") || template;
const version = JSON.parse(readFileSync("package.json", "utf8")).version ?? "0.0.0";
// Where the build goes: dist/ (what manifest.json points at), or --out <dir> (its dist/ and a manifest).
const outRoot = arg("--out") ? resolve(arg("--out")) : null;
const dist = outRoot ? join(outRoot, "dist") : "dist";

/**
 * The self-host template's service: strings `codesignflo plugin build` finds and replaces in dist/code.js (the CLI
 * has the same list in packages/cli/src/selfhost.ts; a test checks they match).
 */
const SELFHOST_PLACEHOLDER = {
  url: "__CODESIGNFLO_SELFHOST_URL__",
  anon: "__CODESIGNFLO_SELFHOST_ANON__",
  web: "__CODESIGNFLO_SELFHOST_WEB__",
  mode: "selfhost",
};

/**
 * Where the CoDesignFlo service is: env (CODESIGNFLO_SERVICE_URL / _ANON / _WEB); else, for release builds, the
 * hosted service in ../../service/prod.json, and for development builds the local Supabase in ../../service.
 * null = local mode only (no sign-in).
 */
function serviceConfig() {
  if (template) return SELFHOST_PLACEHOLDER;
  const e = process.env;
  if (e.CODESIGNFLO_SERVICE_URL && e.CODESIGNFLO_SERVICE_ANON)
    return {
      url: e.CODESIGNFLO_SERVICE_URL,
      anon: e.CODESIGNFLO_SERVICE_ANON,
      web: e.CODESIGNFLO_SERVICE_WEB ?? "https://codesignflo.com",
    };
  if (release) return JSON.parse(readFileSync("../../service/prod.json", "utf8"));
  try {
    const out = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: "../../service",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const get = (k) => new RegExp(`^${k}="?([^"\\n]+)`, "m").exec(out)?.[1];
    // Figma's manifest accepts "localhost", not IP addresses.
    return get("API_URL")
      ? { url: get("API_URL").replace("127.0.0.1", "localhost"), anon: get("ANON_KEY"), web: "http://localhost:3317" }
      : null;
  } catch {
    return null;
  }
}
mkdirSync(dist, { recursive: true });
const common = {
  bundle: true,
  target: "es2020",
  logLevel: "info",
  legalComments: "eof",
  minify: release,
  // Always drop comments: Figma's sandbox rejects the text "import(" even inside a library's comment.
  minifyWhitespace: true,
  define: { __DEV__: JSON.stringify(!release), __VERSION__: JSON.stringify(version), __SERVICE__: JSON.stringify(serviceConfig()) },
};

/** Figma's plugin sandbox rejects any code containing "import(" (even in strings or comments). */
function guard(file, text) {
  const m = /\bimport\s*\(/.exec(text);
  if (m)
    throw new Error(
      `${file} contains "${m[0]}" near …${text.slice(Math.max(0, m.index - 60), m.index + 20)}…, which Figma's sandbox rejects`,
    );
}

async function buildUi() {
  const out = await esbuild.build({ ...common, entryPoints: ["src/ui.ts"], format: "iife", write: false });
  const js = out.outputFiles[0].text.replace(/<\/script>/g, "<\\/script>");
  guard("ui.html", js);
  // A function, not a string: a replacement string would expand "$`" / "$'" found in the bundle.
  const html = readFileSync("src/ui.html", "utf8").replace("<!-- SCRIPT -->", () => `<script>${js}</script>`);
  // The inlined script must come out exactly as bundled (it once didn't, and the panel was blank).
  if (!html.includes(js)) throw new Error("ui.html: the inlined script differs from the bundle");
  writeFileSync(`${dist}/ui.html`, html);
}

const code = await esbuild.context({ ...common, entryPoints: ["src/code.ts"], outfile: `${dist}/code.js`, format: "iife" });
if (watch) {
  await code.watch();
  const ui = await esbuild.context({
    ...common,
    entryPoints: ["src/ui.ts"],
    write: false,
    plugins: [{ name: "inline", setup: (b) => b.onEnd(buildUi) }],
  });
  await ui.watch();
} else {
  await code.rebuild();
  await code.dispose();
  guard("code.js", readFileSync(`${dist}/code.js`, "utf8"));
  await buildUi();
  if (template) writeTemplate();
}

/** The template's manifest; the CLI fills in id, name and the box's domains. */
function writeTemplate() {
  if (!outRoot) throw new Error("--flavor selfhost-template needs --out <dir>");
  const js = readFileSync(`${dist}/code.js`, "utf8");
  for (const v of [SELFHOST_PLACEHOLDER.url, SELFHOST_PLACEHOLDER.anon, SELFHOST_PLACEHOLDER.web])
    if (!js.includes(JSON.stringify(v)))
      throw new Error(`code.js lacks the placeholder ${v}: codesignflo plugin build couldn't fill it in`);
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  manifest.name = "CoDesignFlo (self-hosted)";
  manifest.id = "codesignflo-selfhost";
  manifest.networkAccess.allowedDomains = ["ws://localhost:4517"];
  delete manifest.networkAccess.devAllowedDomains;
  writeFileSync(join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(outRoot, "template.json"), `${JSON.stringify({ version, placeholder: SELFHOST_PLACEHOLDER }, null, 2)}\n`);
  console.log(`self-host plugin template ${version} in ${outRoot}`);
}
