// Builds the self-hosted server into server/dist: index.mjs (the server and the MCP, one bundle) and web/ (the web
// app, without a config.json: the server answers /config.json from its environment). Needs @codesignflo/core built.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { buildWeb } from "../web/build.mjs";
import { routes } from "./routes.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = process.argv[2] ?? here("dist");
rmSync(out, { recursive: true, force: true });
await buildWeb(`${out}/web`, null);
await esbuild.build({
  entryPoints: [here("index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: `${out}/index.mjs`,
  logLevel: "warning",
  define: { __CDF_ROUTES__: JSON.stringify(routes()) },
  // Some dependencies are CommonJS and call require() for Node's own modules (as in scripts/vercel-build.mjs).
  banner: { js: "import { createRequire as __cdfRequire } from 'node:module'; const require = __cdfRequire(import.meta.url);" },
});
console.log(`self-hosted server in ${out}: index.mjs + web/`);
