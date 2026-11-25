// codesignflo init — sets up the open Figma file for this project: pages and sections, project id.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type AppFacts, missingPieces, nextSteps } from "@codesignflo/core";
import { chromium } from "playwright";
import { MIN_PLUGIN } from "../bridge/server.js";
import { defaultBranch } from "../git.js";
import { readConfig, readLedger, uploadGenerations, uploadHistory, writeConfig } from "../project.js";
import { branchName } from "../safe.js";
import { signedIn } from "../service/client.js";
import { installSkills } from "../skills.js";
import { withPlugin } from "./connect.js";
import { installHook } from "./hook.js";
import { mcpLines } from "./selfhost.js";

export async function init(args: string[] = []): Promise<number> {
  if (args.includes("--skills")) {
    const r = installSkills();
    console.log(`Claude Code skills installed in ${r.folder}: ${r.skills.join(", ")}`);
    return 0;
  }
  if (args.includes("--cloud")) {
    const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    return initCloud({
      project: opt("--project"),
      fresh: args.includes("--new"),
      liveBranch: opt("--live-branch"),
      hook: args.includes("--hook") ? true : args.includes("--no-hook") ? false : undefined,
    });
  }
  const existing = readConfig();
  const projectId = existing?.projectId ?? `p_${randomBytes(6).toString("hex")}`;
  // A new project accepts only a file not set up yet; an existing one only its own file.
  // A pairing made now is for this project (the file has no id yet when it's new).
  const result = await withPlugin(
    existing ? { projectId } : "unset",
    (s) => s.call<{ pages: string[] }>("init", { projectId, minPlugin: MIN_PLUGIN }),
    { projectId },
  );
  if (!existing) writeConfig({ projectId, tokens: "tokens/tokens.json" });
  ensureChromium();
  console.log(`project ${projectId} — Figma file set up: ${result.pages.join(", ")}`);
  console.log("config: .codesignflo/config.json (commit it)");
  // The coding agent gets CoDesignFlo through MCP (instructions, tools, prompts): nothing copied into the repo.
  console.log("connect your coding agent (once per machine):");
  // Connected to a self-hosted box: its own hosted MCP (cloud: unchanged).
  for (const l of mcpLines()) console.log(l);
  return 0;
}

/** Projects a designer started (no code yet) that this developer is in. */
async function waiting(client: Awaited<ReturnType<typeof signedIn>>["client"]) {
  const { data, error } = await client.rpc("projects_without_code");
  if (error) throw new Error(error.message);
  return data as { project_id: string; name: string }[];
}

/** Rendering needs Playwright's Chromium; install it once if it isn't there (≈150 MB, shared by projects). */
export function ensureChromium() {
  if (existsSync(chromium.executablePath())) return;
  console.log("installing Chromium for rendering Storybook (once per machine)…");
  const cli = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
  execFileSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
}

/** Which codebase this is: its first commit and the app's folder inside the repo (no file needed). */
export function codebase(): { rootCommit: string; folder: string; name: string } {
  const git = (a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();
  const rootCommit = git(["rev-list", "--max-parents=0", "HEAD"]).split("\n").sort()[0]!;
  const folder = git(["rev-parse", "--show-prefix"]).replace(/\/$/, "") || ".";
  let name = folder === "." ? git(["rev-parse", "--show-toplevel"]).split("/").pop()! : folder.split("/").pop()!;
  try {
    name = (JSON.parse(readFileSync("package.json", "utf8")) as { name?: string }).name ?? name;
  } catch {
    // no package.json: the folder name
  }
  return { rootCommit, folder, name };
}

/**
 * codesignflo init --cloud — connects this app to the CoDesignFlo service: finds its project by codebase
 * (first commit + folder); or links a project a designer started from Figma and invited this developer to
 * (it has no code yet); or creates one (one free project per person). An existing local project moves to
 * the cloud with the same id (the Figma file keeps working) and its history is uploaded.
 */
async function initCloud(opts: { project?: string; fresh?: boolean; liveBranch?: string; hook?: boolean } = {}): Promise<number> {
  const { client, user } = await signedIn();
  const { rootCommit, folder, name } = codebase();
  const existing = readConfig();
  const { data: found, error: findErr } = await client.rpc("find_project", { p_root_commit: rootCommit, p_folder: folder });
  if (findErr) throw new Error(findErr.message);
  const hit = (found as { project_id: string; name: string | null; access: boolean }[])[0];
  let projectId: string;
  if (hit && !hit.access) throw new Error("this app already has a CoDesignFlo project — ask its owner to invite you");
  // Projects a designer started from Figma and invited this developer to (only asked when needed).
  const open = hit || opts.fresh || opts.project ? [] : await waiting(client);
  if (hit) {
    projectId = hit.project_id;
    console.log(`found the project "${hit.name}" (${projectId})`);
  } else if (opts.project || open.length) {
    // A designer started the project from the plugin and invited this developer: link this code to it.
    if (!opts.project) {
      console.log("Projects waiting for their code (a designer started them and invited you):");
      for (const p of open) console.log(`  ${p.project_id}  ${p.name}`);
      console.log("Link this app to one: codesignflo init --cloud --project <id>  (or start a new project: --new)");
      return 2;
    }
    const pick = opts.project;
    const { error } = await client.rpc("link_codebase", { p_project: pick, p_root_commit: rootCommit, p_folder: folder });
    if (error) throw new Error(error.message);
    projectId = pick;
    console.log(`linked this app to the project ${projectId}; its Figma file is already set up by the designer`);
    if (existing && !existing.cloud && readLedger().length)
      console.log("note: the local history (.codesignflo/events.jsonl) belongs to the old local project and was not moved");
  } else {
    const { data, error } = await client.rpc("create_project", {
      p_name: name,
      p_root_commit: rootCommit,
      p_folder: folder,
      p_settings: existing ? { tokens: existing.tokens, trackedBranch: existing.trackedBranch } : {},
      ...(existing && !existing.cloud ? { p_id: existing.projectId } : {}),
    });
    if (error) throw new Error(error.message);
    projectId = data as string;
    console.log(`created the project "${name}" (${projectId}) for ${user.email ?? user.id}`);
    if (existing && !existing.cloud) {
      const history = readLedger();
      await uploadHistory(client, projectId, history);
      console.log(`moved the local project to the cloud: ${history.length} history entries uploaded`);
    }
  }
  // Live's versions kept in the repo so far: the plugin compares against them when it applies updates.
  if (existing && !existing.cloud && existing.projectId === projectId) {
    const n = await uploadGenerations(client, projectId);
    if (n) console.log(`uploaded ${n} stored versions of Live (snapshots/; the folder can be deleted after this)`);
  }
  writeConfig({ ...(existing ?? { tokens: "tokens/tokens.json" }), projectId, cloud: true });
  console.log("this app now uses the CoDesignFlo service");
  // The branch whose commits update Live: as asked, else the one already set, else the repo's default branch.
  const { data: proj } = await client.from("projects").select("settings").eq("id", projectId).single();
  const current = (proj as { settings?: { liveBranch?: string } } | null)?.settings?.liveBranch;
  const liveBranch = opts.liveBranch ?? current ?? defaultBranch() ?? "main";
  if (opts.liveBranch) branchName(opts.liveBranch);
  if (liveBranch !== current) {
    const { error } = await client.rpc("set_live_branch", { p_project: projectId, p_branch: liveBranch });
    if (error) throw new Error(error.message);
  }
  console.log(`Live follows ${liveBranch} (change it: codesignflo live-branch <name>)`);
  if (opts.hook === true) console.log(installHook().message);
  else if (opts.hook === undefined)
    console.log(
      `to update Live on every commit to ${liveBranch} from this machine: codesignflo hook install (a git hook; nothing goes into the repo)`,
    );
  // What's missing in the app, and what to do next on this project's path.
  const missing = missingPieces(appFacts(existing?.tokens ?? "tokens/tokens.json"));
  if (missing.length) console.log(`\nMissing in this app:\n${missing.map((m) => `- ${m}`).join("\n")}`);
  const { data: settings } = await client.from("projects").select("settings").eq("id", projectId).single();
  const { data: events } = await client
    .from("events")
    .select("component, kind")
    .eq("project_id", projectId)
    .in("kind", ["designed_new", "closed", "unclaimed"]);
  const waitingDesigns = new Map<string, number>();
  for (const e of (events ?? []) as { component: string; kind: string }[])
    waitingDesigns.set(e.component, (waitingDesigns.get(e.component) ?? 0) + (e.kind === "designed_new" ? 1 : -1));
  const steps = nextSteps({
    hasFile: !!(settings as { settings?: { file?: unknown } } | null)?.settings?.file,
    newDesigns: [...waitingDesigns].filter(([, n]) => n > 0).map(([k]) => k),
    liveBranch,
  });
  console.log(`\nNext:\n${steps.map((s) => `- ${s}`).join("\n")}`);
  return 0;
}

/** Storybook, a tokens file, page stories: what CoDesignFlo needs in the app folder. */
function appFacts(tokens: string): AppFacts {
  const pkg = existsSync("package.json") ? (JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> }) : {};
  const storybook = existsSync(".storybook") || Object.values(pkg.scripts ?? {}).some((s) => s.includes("storybook"));
  let pageStories = false;
  const walk = (d: string, depth: number) => {
    if (pageStories || depth < 0 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth - 1);
      else if (/\.stories\.(t|j)sx?$/.test(e.name)) {
        // The same rule as the renderer: titled "Pages…" / "Screens…", or rendered full screen.
        const src = readFileSync(p, "utf8");
        if (/title:\s*["'`](pages|screens)(\/|["'`])/i.test(src) || /layout:\s*["'`]fullscreen/.test(src)) pageStories = true;
      }
    }
  };
  walk("src", 6);
  return { storybook, tokens: existsSync(tokens) ? tokens : null, pageStories };
}
