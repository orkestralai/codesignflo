// codesignflo delta — for each proposal marked "ready for dev": snapshot the designer's copy and the Live
// component it was copied from, diff them, classify against code changes (three-way merge), group into
// code-level changes, and write .codesignflo/proposals/<component>/<claim>/{delta,changes}.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Change, computeDeltas, type SystemUse } from "@codesignflo/core";
import { dir, requireConfig } from "../project.js";
import { printable, proposalFolder } from "../safe.js";
import { withPlugin } from "./connect.js";
import { cliStore } from "./sync.js";

// The three-way delta itself is shared with the plugin: @codesignflo/core (deltaFor, computeDeltas).
export { deltaFor, withDataTags } from "@codesignflo/core";

export function writeDelta(
  component: string,
  claim: string,
  m: unknown,
  changes: Change[],
  content: Change[],
  uses: SystemUse[] = [],
): string {
  const folder = proposalFolder(dir(), component, claim);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "delta.json"), `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(join(folder, "changes.json"), `${JSON.stringify({ changes, content, ...(uses.length ? { uses } : {}) }, null, 2)}\n`);
  return folder;
}

export async function delta(): Promise<number> {
  const config = requireConfig();
  const results = await withPlugin({ projectId: config.projectId }, (s) =>
    computeDeltas(s, cliStore, JSON.parse(readFileSync(resolve(config.tokens ?? "tokens/tokens.json"), "utf8"))),
  );
  if (!results.length) console.log("no proposals are ready for dev");
  for (const r of results) {
    console.log(
      `\n${r.component} — proposal ${r.claim} by ${printable(r.by)}${r.note ? `: ${JSON.stringify(printable(r.note, 500))}` : ""}`,
    );
    console.log(
      `${r.changes.length} code change${r.changes.length === 1 ? "" : "s"}${r.conflicts ? `, ${r.conflicts} conflicting with code` : ""}:`,
    );
    for (const c of r.changes)
      console.log(
        `  ${c.id} [${c.kind}] ${c.layer} ${c.prop}: ${c.from} → ${c.to}${c.variants === "all" ? "  (all variants)" : c.scope === "variants" ? `  (only: ${c.variants.join("; ")})` : `  (made in ${c.variants.join("; ")} — apply to all)`}`,
      );
    if (r.content.length) {
      console.log("content changes (example data, no code impact):");
      for (const c of r.content) console.log(`  ${c.layer}: ${c.from} → ${c.to}`);
    }
    console.log(`written: ${r.folder}`);
  }
  return 0;
}
