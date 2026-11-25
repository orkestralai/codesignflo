// The paths the hosted MCP answers and the security headers, read from scripts/vercel-build.mjs (the one list both
// deployments follow). That script builds when imported, so its two constants are read from its source instead.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = () => readFileSync(fileURLToPath(new URL("../scripts/vercel-build.mjs", import.meta.url)), "utf8");

/** The literal after `export const <name> =` up to its closing bracket (an array of strings or a flat object). */
function literal(src, name, open, close) {
  const start = src.indexOf(`export const ${name} =`);
  if (start < 0) throw new Error(`scripts/vercel-build.mjs no longer exports ${name}`);
  const from = src.indexOf(open, start);
  const to = src.indexOf(`\n${close}`, from);
  if (from < 0 || to < 0) throw new Error(`couldn't read ${name} from scripts/vercel-build.mjs`);
  // Plain data (strings, commas, comments): evaluated on its own, nothing else from the script runs.
  return new Function(`return ${src.slice(from, to + 2)}`)();
}

/** @returns {{ paths: string[], headers: Record<string, string> }} */
export function routes() {
  const src = source();
  const paths = literal(src, "PATHS", "[", "]");
  const headers = literal(src, "SECURITY_HEADERS", "{", "}");
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) throw new Error("PATHS isn't a list of paths");
  return { paths, headers };
}
