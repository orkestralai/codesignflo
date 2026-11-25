// codesignflo sync — the developer-side reconciliation (brief W0).
//  1. render Storybook and extract every registered story; compile components and pages
//  2. update Live from them (the shared apply step in @codesignflo/core: hand-edit protection, generations,
//     the designer's facts, closing what the code now satisfies, the panel's index)
// Local projects apply through the plugin on this machine. Cloud projects upload the compiled update to the
// service; the plugin applies it when the Figma file is open (now, or the next time anyone opens it).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  applyUpdate,
  type Change,
  type ComponentState,
  compile,
  compileScreens,
  type Delivery,
  designerText,
  type IRNode,
  type Registry,
  type Store,
  stringify,
  tokenNames,
  type UpdateInput,
} from "@codesignflo/core";
import { branch, head, trailersSince } from "../git.js";
import { appendLedger, cloudSession, dir, loadGeneration, readLedger, requireConfig, saveGeneration } from "../project.js";
import { renderSetup, renderStorybook, UNREADABLE } from "../render/render.js";
import { isSegment, proposalFolder } from "../safe.js";
import { storyCoverage } from "../stories.js";
import { record, timed } from "../telemetry.js";
import { VERSION } from "../version.js";
import { withPlugin } from "./connect.js";
import { writeDelta } from "./delta.js";
import { cloudSync, mergedPreviews, oneAtATime, plan, upToDate } from "./live.js";
import { coverageLine } from "./stories.js";

export { comparable } from "@codesignflo/core";
export { loadGeneration };

type RegistryFile = Registry & {
  components: Record<string, { module: string; files?: string[]; stories: Record<string, Record<string, string>> }>;
  screens?: Record<string, { story: string; files?: string[] }>;
};

const statePath = () => join(dir(), "state.json");

/** The history and generations as this machine sees them (repo files, or the service for cloud projects). */
export const cliStore: Store = {
  ledger: () => readLedger(),
  append: (events) => appendLedger(events),
  generation: loadGeneration,
  saveGeneration,
  delta: (component, claim, m, changes, content, uses) => relative(process.cwd(), writeDelta(component, claim, m, changes, content, uses)),
  newDesign: async (component, claim, spec, picture) => {
    const folder = proposalFolder(dir(), component, claim);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "spec.json"), stringify(spec));
    writeFileSync(join(folder, "design.png"), Buffer.from(await picture(), "base64"));
    return relative(process.cwd(), folder);
  },
};

/** Commits that name a proposal (CoDesignFlo: line), with the change list frozen when it was handed off. */
function deliveries(): Delivery[] {
  const out: Delivery[] = [];
  for (const t of trailersSince(undefined)) {
    // Commit messages are anyone's text: a line naming something that isn't a proposal is skipped.
    if (!isSegment(t.component) || !isSegment(t.claim)) continue;
    const folder = proposalFolder(dir(), t.component, t.claim);
    // The list exactly as delivered in that commit (ids are positions; the live changes.json gets renumbered).
    const byCommit = join(folder, `delivered-${t.commit.slice(0, 8)}.json`);
    // Track mode: the developer's own commit carries the line; the list was frozen at hand-off.
    const frozen = existsSync(byCommit) ? byCommit : join(folder, "delivered-track.json");
    if (!existsSync(frozen)) continue;
    const { changes } = JSON.parse(readFileSync(frozen, "utf8")) as { changes: Change[] };
    const report = existsSync(join(folder, "report.json"))
      ? (JSON.parse(readFileSync(join(folder, "report.json"), "utf8")) as { changes: { id: string; note?: string }[] }).changes
      : [];
    const why = Object.fromEntries(report.filter((r) => r.note).map((r) => [r.id, r.note!]));
    out.push({ ...t, changes, why });
  }
  return out;
}

/** The size of the designer's design of each page (the newest proposal carrying one). */
async function designSizes(cloud: NonNullable<ReturnType<typeof cloudSession>>): Promise<Record<string, { w: number; h: number }>> {
  const { data } = await cloud.client
    .from("proposals")
    .select("component, w:payload->spec->width, h:payload->spec->height, updated_at")
    .eq("project_id", cloud.projectId)
    .like("component", "pages.%")
    .order("updated_at", { ascending: true });
  const out: Record<string, { w: number; h: number }> = {};
  for (const r of (data ?? []) as { component: string; w: number | null; h: number | null }[])
    if (typeof r.w === "number" && typeof r.h === "number" && r.w > 0 && r.h > 0) out[r.component] = { w: r.w, h: r.h };
  return out;
}

export async function sync(args: string[] = []): Promise<number> {
  const cloud = cloudSession();
  // The git hook's background run (cloud projects): one at a time; commits made meanwhile are rendered once.
  if (args.includes("--from-hook")) {
    if (!cloud) return 0;
    let code = 0;
    await oneAtATime(cloud.projectId, async () => {
      code = await syncOnce(args, cloud);
    });
    return code;
  }
  return syncOnce(args, cloud);
}

async function syncOnce(args: string[], cloud: ReturnType<typeof cloudSession>): Promise<number> {
  const config = requireConfig();
  // Which CoDesignFlo runs (an older npx cache, a local build): the first thing to know when Live looks off.
  if (!args.includes("--from-hook")) console.error(`CoDesignFlo CLI ${VERSION}`);
  // Cloud projects: a Live update from the Live branch, a check from anywhere else (decided before rendering).
  const cloudPlan = cloud && !args.includes("--local") ? await plan(cloud, args.includes("--preview")) : null;
  if (cloud && cloudPlan && args.includes("--from-hook")) {
    // The Live branch updates Live; a connected branch its lane; anything else waits for a sync by hand.
    const lane = cloudPlan.kind === "preview" && cloudPlan.lane ? cloudPlan.branch! : undefined;
    if (cloudPlan.kind !== "live" && !lane) return 0;
    if (await upToDate(cloud, cloudPlan.commit, lane)) return 0;
    console.log(
      `${new Date().toISOString()} hook: updating ${lane ? `${lane}'s lane` : "Live"} from ${lane ?? cloudPlan.liveBranch} @${cloudPlan.commit.slice(0, 7)}`,
    );
  }
  const dtcg = JSON.parse(readFileSync(resolve(config.tokens ?? "tokens/tokens.json"), "utf8"));
  const sb = (config as { storybook?: { build?: string; out?: string } }).storybook ?? {};

  // 1. Render.
  if (!args.includes("--no-build")) {
    console.error(`building Storybook (${sb.build ?? "pnpm build-storybook"})…`);
    await timed("sync.build-storybook", () =>
      execSync(sb.build ?? "pnpm build-storybook", { stdio: "ignore", env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: "1" } }),
    );
  }
  // The whole Storybook is registered automatically on every sync (components, variants from props, pages).
  console.error("reading Storybook…");
  // Pages the designer designed are rendered at the design's size (a 1728-wide design against a page drawn
  // at 1200 compared nothing).
  const sizes = cloud ? await designSizes(cloud) : {};
  const {
    registry: auto,
    irs,
    images,
    failed,
    shots: shotsByStory,
  } = await timed("sync.render", () => renderStorybook(resolve(sb.out ?? "storybook-static"), process.cwd(), sizes));
  // A story whose play function fails shows where it stopped (a modal on its first step instead of its
  // fourth): Live would show that. The story is the code's to fix.
  for (const [story, error] of failed)
    console.log(
      error.startsWith(UNREADABLE)
        ? `! story ${story}: ${error} — left out of this update (a CoDesignFlo gap: report it); the rest went on`
        : `! story ${story}: its play function failed — ${error.split("\n")[0]} — Live shows the story where it stopped; fix the story (code to change), then sync`,
    );
  const registry = auto as unknown as RegistryFile;
  writeFileSync(join(dir(), "registry.json"), `${JSON.stringify(auto, null, 2)}\n`);
  console.error(
    `${Object.keys(auto.components).length} components, ${Object.keys(auto.screens).length} screens, ${irs.size} stories rendered`,
  );
  const unnamedCount = [...irs.values()].reduce((n, ir) => {
    const walk = (x: IRNode): number => (x.unnamed ? 1 : 0) + (x.children ?? []).reduce((a, c) => a + walk(c), 0);
    return n + walk(ir.root);
  }, 0);
  if (unnamedCount) console.error(`${unnamedCount} element(s) without a semantic name — run: codesignflo name`);
  // Components without a story aren't components in Live (nor can they be linked to a design system).
  try {
    const cov = storyCoverage(
      process.cwd(),
      join(resolve(sb.out ?? "storybook-static"), "index.json"),
      (config as { components?: string[] }).components,
    );
    const line = coverageLine(cov);
    if (line) console.error(line);
    record({ kind: "setup", signature: "story coverage", data: { files: cov.files, covered: cov.covered } });
  } catch {
    // A Storybook layout we can't read: say nothing rather than something wrong.
  }
  // What this sync ran on, and how big the app is (numbers only).
  const setup = renderSetup();
  record({
    kind: "setup",
    signature: `cli ${VERSION}`,
    data: {
      ...setup,
      components: Object.keys(auto.components).length,
      screens: Object.keys(auto.screens).length,
      stories: irs.size,
      failedStories: failed.size,
      unnamed: unnamedCount,
      pictures: images.size,
    },
  });
  for (const [, error] of failed) record({ kind: "error", signature: `story play function failed: ${error.split("\n")[0]}`.slice(0, 200) });
  const tokens = tokenNames(dtcg);
  const { sets, screens } = await timed("sync.compile", () => ({
    sets: compile(registry, irs, tokens),
    screens: compileScreens({ ...registry, screens: registry.screens ?? {} }, irs, tokens),
  }));
  if (args.includes("--dry-run")) {
    for (const [k, c] of Object.entries(auto.components)) {
      const props = [...new Set(Object.values(c.stories).flatMap((p) => Object.keys(p)))];
      console.log(
        `${k.padEnd(18)} ${Object.keys(c.stories).length} variant(s)${props.length && props[0] !== "story" ? ` by ${props.join(", ")}` : ""}${c.examples ? `, ${Object.keys(c.examples).length} example(s)` : ""} — ${c.files.join(", ")}`,
      );
    }
    for (const sc of screens)
      console.log(
        `screen ${sc.spec.name.padEnd(11)} ${Math.round((100 * sc.coverage.inInstances) / sc.coverage.nodes)}% from library; instances ${JSON.stringify(sc.coverage.instances)}`,
      );
    return 0;
  }
  const commit = head();
  const keys = [...Object.keys(registry.components), ...Object.keys(registry.screens ?? {})];
  // --only a,b: update just these in Live (building designs one at a time).
  const onlyArg = args.find((a) => a.startsWith("--only"));
  const only = onlyArg
    ? (onlyArg.includes("=") ? onlyArg.split("=")[1]! : (args[args.indexOf(onlyArg) + 1] ?? ""))
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : undefined;
  if (only) {
    const unknown = only.filter((k) => !keys.includes(k));
    if (unknown.length) {
      console.error(`not in this app's Storybook: ${unknown.join(", ")} — known: ${keys.join(", ")}`);
      return 1;
    }
  }
  // Each page's screenshot, by page key: shown beside the Live page.
  const shots = Object.fromEntries(
    Object.entries(registry.screens ?? {}).flatMap(([key, sc]) => {
      const shot = shotsByStory.get(sc.story);
      return shot ? [[key, shot] as const] : [];
    }),
  );
  const input: UpdateInput = {
    sets,
    screens: screens.map((x) => ({ spec: x.spec, coverage: x.coverage })),
    shots,
    dtcg,
    commit,
    keys,
    deliveries: deliveries(),
    ...(only ? { only } : {}),
  };
  // A Live update also takes out the previews of branches merged since (their code is in Live now).
  if (cloud && cloudPlan?.kind === "live") {
    const merged = await mergedPreviews(cloud, commit).catch(() => []);
    if (merged.length) input.closePreviews = merged;
  }
  // Cloud projects: upload; whoever has the Figma file open applies it (no Figma needed here).
  if (cloud && cloudPlan)
    return cloudSync(
      cloud,
      cloudPlan,
      input,
      [...sets, ...screens.map((x) => x.spec)],
      images,
      auto,
      renderSetup(),
      !args.includes("--from-hook"),
    );

  // Local projects: Live is the mirror of one branch; syncing from another would show its unmerged code.
  const tracked = config.trackedBranch;
  const current = branch();
  if (tracked && current && current !== tracked && !args.includes("--allow-branch")) {
    console.error(
      `Live mirrors "${tracked}", and you are on "${current}". Deliver works on any branch; run sync on ${tracked} after merging (it verifies delivered changes there). To update Live from this branch anyway: codesignflo sync --allow-branch`,
    );
    return 1;
  }

  let states: Map<string, ComponentState> | undefined;
  await withPlugin({ projectId: config.projectId }, async (s) => {
    const r = await applyUpdate(s, cliStore, { ...input, images: Object.fromEntries(images) }, (line) => console.log(line));
    states = r.states;
    for (const n of r.notes) console.log(`! ${n}`);
  });
  if (states) writeFileSync(join(dir(), "STATUS.md"), status(states, registry));
  writeFileSync(statePath(), `${JSON.stringify({ lastSyncCommit: commit }, null, 2)}\n`);
  return 0;
}

function status(states: Map<string, ComponentState>, registry: RegistryFile): string {
  const label: Record<string, string> = {
    in_sync: "In sync",
    in_design: "In design",
    ready_for_dev: "Ready for dev",
    design_new: "New design",
    code_new: "New in code",
    ignored: "Ignored",
  };
  const rows = [...states.values()]
    .filter((s) => registry.components[s.component] || registry.screens?.[s.component] || s.state === "design_new")
    .map(
      (s) =>
        `| ${s.component} | ${s.conflict ? "Needs a look" : s.unseen ? "Changed in code" : label[s.state]} | ${s.claim ? s.claim.by : ""} | ${s.claim?.note ? designerText(s.claim.note, 300).replace(/\|/g, "\\|") : ""} |`,
    );
  return `# CoDesignFlo status\n\nGenerated by \`codesignflo sync\`. Do not edit.\n\n| Component | State | Claimed by | Designer's note |\n|---|---|---|---|\n${rows.join("\n")}\n`;
}
