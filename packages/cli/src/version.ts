// The CLI's version, from its package.json: the one number a release bumps. Read next to the code that runs —
// dist/version.js in this checkout (../package.json is packages/cli's), dist/main.js in the published package
// (../package.json is the package's own).
import { readFileSync } from "node:fs";

function read(): string {
  try {
    const p = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name?: string; version?: string };
    if (p.version && p.name?.includes("codesignflo")) return p.version;
  } catch {
    // not found: below
  }
  return "0.0.0";
}

export const VERSION = read();
