// codesignflo pull — cloud projects: fetches the designer's proposals from the service and computes their
// changes locally (no Figma needed): base = the version they claimed (sent with the proposal), ours = their
// copy (sent), theirs = the latest Live version in the repo. Writes .codesignflo/proposals/… like sync.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  adoptForeignVariables,
  deltaFor,
  fold,
  markPresentation,
  predictLive,
  type Raw,
  type SpecNode,
  stringify,
  tokenNames,
  withDataTags,
} from "@codesignflo/core";
import { cloudSession, dir, loadGeneration, readLedger, requireConfig } from "../project.js";
import { isSegment, proposalFolder } from "../safe.js";
import { writeDelta } from "./delta.js";

type Payload = {
  base?: Raw;
  copy?: Raw;
  spec?: Raw;
  scopes?: Record<string, "all" | "variants">;
};

/** How the code stands with one proposal. */
export type ProposalCheck = {
  component: string;
  claim: string;
  /** The designer's changes the code has, and how many they made in all (content changes aside). */
  done: number;
  total: number;
  conflicts: number;
  /** false: the code adds or removes layers here, which only Live can confirm. */
  exact: boolean;
};

/**
 * Cloud projects: fetches the designer's proposals and computes their changes locally (no Figma): base = the
 * version they claimed, ours = their copy, theirs = Live — or, given the compiled code (`specs`), Live as it
 * will be once this code reaches it (predicted). Writes .codesignflo/proposals/… like sync.
 */
export async function proposalChecks(specs?: Map<string, SpecNode>): Promise<{ lines: string[]; checks: ProposalCheck[] }> {
  const session = cloudSession();
  if (!session) return { lines: [], checks: [] };
  const config = requireConfig();
  const dtcg = JSON.parse(readFileSync(resolve(config.tokens ?? "tokens/tokens.json"), "utf8"));
  const projectTokens = new Set(tokenNames(dtcg).values());
  const { data, error } = await session.client.from("proposals").select("claim_id, component, payload").eq("project_id", session.projectId);
  if (error) throw new Error(`couldn't read proposals: ${error.message}`);
  const states = fold(readLedger());
  const lines: string[] = [];
  const checks: ProposalCheck[] = [];
  for (const row of (data ?? []) as { claim_id: string; component: string; payload: Payload }[]) {
    // Names become folders here: anything that isn't a name CoDesignFlo makes is skipped.
    if (!isSegment(row.component) || !isSegment(row.claim_id)) continue;
    const st = states.get(row.component);
    if (st?.claim?.id !== row.claim_id) continue;
    if (st.state === "design_new" && row.payload.spec) {
      const folder = proposalFolder(dir(), row.component, row.claim_id);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "spec.json"), stringify(markPresentation(row.payload.spec as Raw)));
      lines.push(`${row.component}: new design`);
      continue;
    }
    if (st.state !== "ready_for_dev" || !row.payload.copy) continue;
    const claimed = row.payload.base ?? (st.claim.baselineGen ? await loadGeneration(row.component, st.claim.baselineGen) : null);
    const live = (st.lastGen ? await loadGeneration(row.component, st.lastGen) : null) ?? claimed;
    if (!claimed || !live) continue;
    const spec = specs?.get(row.component);
    const predicted = spec ? predictLive(live, spec) : null;
    const theirs = predicted?.tree ?? live;
    const designWins = readLedger().some((e) => e.kind === "resolved" && e.claim === row.claim_id && e.take === "design");
    const { m, changes, content } = deltaFor({
      base: withDataTags(claimed, theirs),
      ours: adoptForeignVariables(withDataTags(row.payload.copy, theirs), projectTokens),
      theirs,
      dtcg,
      ...(row.payload.scopes ? { scopes: row.payload.scopes } : {}),
      designWins,
    });
    writeDelta(row.component, row.claim_id, m, changes, content);
    const conflicts = designWins ? 0 : m.summary.conflict;
    const left = changes.reduce((n, c) => n + c.items.length, 0);
    checks.push({
      component: row.component,
      claim: row.claim_id,
      done: m.summary.convergent,
      total: m.summary.convergent + left + conflicts,
      conflicts,
      exact: predicted?.exact ?? true,
    });
    lines.push(`${row.component}: ${changes.length} change(s) to implement`);
  }
  return { lines, checks };
}

export async function pullProposals(): Promise<string[]> {
  return (await proposalChecks()).lines;
}

export async function pull(): Promise<number> {
  const got = await pullProposals();
  console.log(got.length ? got.join("\n") : "no proposals waiting");
  return 0;
}
