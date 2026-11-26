// Cloud projects: what a sync uploads and what it tells the developer. Commits on the Live branch (no
// uncommitted changes) become a Live update, applied by the plugin when the Figma file is open; anything
// else is a check. Either way the developer hears at once how the code stands with each proposal, predicted
// from the compiled code (no Figma). Merges and staleness come from local git (fetch + ancestry): the
// service never needs access to the repository.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type Bundle, differenceLines, fold, type LiveRow, liveStateLine, type SpecNode, type UpdateInput } from "@codesignflo/core";
import { affectsRender, behind, branch, changedSince, contains, defaultBranch, dirtyFiles, head, sameFiles, tipOf } from "../git.js";
import { type cloudSession, dir, readConfig, readLedger } from "../project.js";
import type { RenderSetup } from "../render/render.js";
import { branchName, projectId as safeProjectId } from "../safe.js";
import { savedSignIn } from "../service/client.js";
import { timed } from "../telemetry.js";
import { proposalChecks } from "./pull.js";

type Cloud = NonNullable<ReturnType<typeof cloudSession>>;
export type Plan = {
  kind: "live" | "check" | "preview";
  liveBranch: string;
  branch: string | null;
  commit: string;
  why?: string;
  /** A preview of a connected branch: its lane beside Live. */
  lane?: boolean;
};

/** The project's Live branch: its setting in the service, else the repo's default branch. */
export async function liveBranchOf(cloud: Cloud): Promise<string> {
  const { data } = await cloud.client.from("projects").select("settings").eq("id", cloud.projectId).single();
  const set = (data as { settings?: { liveBranch?: string } } | null)?.settings?.liveBranch;
  return set ?? defaultBranch() ?? "main";
}

/** Decided before rendering (a hook run that won't upload anything stops here, cheaply). */
export async function plan(cloud: Cloud, preview = false): Promise<Plan> {
  const liveBranch = await liveBranchOf(cloud);
  const current = branch();
  const commit = head();
  // Only what can change the rendered app holds a Live update (or a preview) back (not a doc or a script being edited).
  const ignore = ((readConfig() ?? {}) as { liveIgnore?: string[] }).liveIgnore ?? [];
  const dirty = () => dirtyFiles().filter((f) => affectsRender(f, ignore));
  if (current !== liveBranch) {
    // A connected branch: every sync on it updates its lane beside Live (the hook's too).
    const lane = current ? await connected(cloud, current) : false;
    if (lane) {
      const files = dirty();
      if (files.length)
        return {
          kind: "check",
          liveBranch,
          branch: current,
          commit,
          why: `${current}'s lane shows committed code; commit first: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`,
        };
      const stale = staleness(commit, current!, tipOf(current!), await laneCommit(cloud, current!), `${current}'s lane`);
      if (stale) return { kind: "check", liveBranch, branch: current, commit, why: stale };
      return { kind: "preview", liveBranch, branch: current, commit, lane: true };
    }
    if (!preview)
      return {
        kind: "check",
        liveBranch,
        branch: current,
        commit,
        why: `Live follows ${liveBranch}; to keep this branch beside Live in Figma: codesignflo branch connect (once: then every sync on it updates its lane), or sync --preview for a one-off look`,
      };
    if (!current) return { kind: "check", liveBranch, branch: current, commit, why: "a preview needs a branch (this is a detached HEAD)" };
    const files = dirty();
    if (files.length)
      return {
        kind: "check",
        liveBranch,
        branch: current,
        commit,
        why: `commit first — a preview shows committed code: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`,
      };
    return { kind: "preview", liveBranch, branch: current, commit };
  }
  const files = dirty();
  if (files.length)
    return {
      kind: "check",
      liveBranch,
      branch: current,
      commit,
      why: `uncommitted changes never reach Live: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`,
    };
  const stale = staleness(commit, liveBranch, tipOf(liveBranch), await liveCommit(cloud));
  if (stale) return { kind: "check", liveBranch, branch: current, commit, why: stale };
  return { kind: "live", liveBranch, branch: current, commit };
}

/** Is this branch connected (a lane beside Live)? False when the service can't say (from before lanes). */
export async function connected(cloud: Cloud, branch: string): Promise<boolean> {
  const { data, error } = await cloud.client
    .from("project_branches")
    .select("branch")
    .eq("project_id", cloud.projectId)
    .eq("branch", branch)
    .limit(1);
  return !error && !!data?.length;
}

/** The connected branches, with who connected each; null when the service can't say. */
export async function lanes(cloud: Cloud): Promise<{ branch: string; connected_by: string | null; connected_at: string }[] | null> {
  const { data, error } = await cloud.client.rpc("project_lanes", { p_project: cloud.projectId });
  return error ? null : ((data ?? []) as { branch: string; connected_by: string | null; connected_at: string }[]);
}

/** The commit a branch's lane shows, or is about to (its newest preview that didn't fail). */
async function laneCommit(cloud: Cloud, branch: string): Promise<string | null> {
  const { data } = await cloud.client
    .from("live_updates")
    .select("commit")
    .eq("project_id", cloud.projectId)
    .eq("kind", "preview")
    .eq("branch", branch)
    .neq("status", "failed")
    .order("id", { ascending: false })
    .limit(1);
  return (data as { commit: string }[] | null)?.[0]?.commit ?? null;
}

/** The commit Live shows, or is about to (the newest Live update that didn't fail). */
export async function liveCommit(cloud: Cloud): Promise<string | null> {
  const { data } = await cloud.client
    .from("live_updates")
    .select("commit")
    .eq("project_id", cloud.projectId)
    .eq("kind", "live")
    .neq("status", "failed")
    .order("id", { ascending: false })
    .limit(1);
  return (data as { commit: string }[] | null)?.[0]?.commit ?? null;
}

/**
 * Why this checkout of the Live branch mustn't update Live, or null when it may. Live never goes back: the
 * commit must contain the one Live shows (another developer's newer sync). And it must be the team's branch
 * (origin's, `team`) or ahead of it: a local branch behind it, or split from it, would show old code or code
 * nobody else has. Committed but not pushed yet is fine (the git hook syncs after each commit, before the
 * push). What git can't tell (a commit it doesn't know, no remote) doesn't hold the update back.
 */
export function staleness(
  commit: string,
  liveBranch: string,
  team: string | null,
  live: string | null,
  /** What shows `live`: Live, or a branch's lane. */
  shown = "Live",
): string | null {
  const short = (c: string) => c.slice(0, 7);
  if (live && live !== commit && contains(commit, live) === false)
    return contains(live, commit) === true
      ? `${shown} already shows ${liveBranch} @${short(live)}, newer than yours (@${short(commit)}): pull ${liveBranch} first (git pull), then sync`
      : `${shown} shows ${liveBranch} @${short(live)}, which your ${liveBranch} doesn't have: pull ${liveBranch} first (git pull), then sync`;
  if (team && team !== commit && contains(commit, team) === false) {
    const n = behind(commit, team);
    return contains(team, commit) === true
      ? `your ${liveBranch} is ${n ?? "some"} commit${n === 1 ? "" : "s"} behind origin/${liveBranch}: pull first (git pull), then sync`
      : `your ${liveBranch} and origin/${liveBranch} have split: pull (merge or rebase) first, then sync`;
  }
  return null;
}

/**
 * Nothing to render for a Live update: this commit is already uploaded (another developer, an earlier run),
 * or the app's files haven't changed since the last one (a commit elsewhere in a monorepo, say).
 */
export async function upToDate(cloud: Cloud, commit: string, lane?: string): Promise<boolean> {
  const q = cloud.client
    .from("live_updates")
    .select("commit")
    .eq("project_id", cloud.projectId)
    .eq("kind", lane ? "preview" : "live");
  const { data } = await (lane ? q.eq("branch", lane) : q)
    .neq("status", "failed")
    // An update of only some items doesn't make Live up to date with that commit.
    .filter("payload->only", "is", null)
    .order("id", { ascending: false })
    .limit(1);
  const last = (data as { commit: string }[] | null)?.[0]?.commit;
  if (!last) return false;
  return last === commit || changedSince(last) === false;
}

/**
 * Branches with a preview in Figma that the Live branch now contains (merged): a Live update takes their
 * "Branch: <name>" sections out. Read from the previews uploaded in the last 90 days.
 */
export async function mergedPreviews(cloud: Cloud, tip: string): Promise<string[]> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { data } = await cloud.client
    .from("live_updates")
    .select("branch, commit")
    .eq("project_id", cloud.projectId)
    .eq("kind", "preview")
    .gte("created_at", since)
    .order("id", { ascending: false });
  const newest = new Map<string, string>();
  for (const r of (data ?? []) as { branch: string | null; commit: string }[])
    if (r.branch && !newest.has(r.branch)) newest.set(r.branch, r.commit);
  return [...newest].filter(([, commit]) => contains(tip, commit) === true).map(([b]) => b);
}

/** A Live update's compiled code (components and pages), gzipped and base64: what the plugin unpacks. */
export function packBundle(input: UpdateInput): string {
  const bundle: Bundle = { sets: input.sets, screens: input.screens };
  return gzipSync(JSON.stringify(bundle)).toString("base64");
}
/** The rest of a Live update: small, kept as JSON (the CLI and the hosted MCP read it). */
export function liveMeta(input: UpdateInput): Omit<UpdateInput, "sets" | "screens"> {
  const { sets: _s, screens: _p, ...rest } = input;
  return rest;
}

/** Uploads the update (or check), records each proposal's check, and reports. */
export async function cloudSync(
  cloud: Cloud,
  p: Plan,
  input: UpdateInput,
  specs: SpecNode[],
  /** Pictures by content hash (the app's images, the pages' screenshots): uploaded to the media storage. */
  images: Map<string, string>,
  registry: unknown,
  setup: RenderSetup | null,
  /** Wait for the plugin to apply a Live update and report how it went (not for the hook's runs). */
  wait = true,
): Promise<number> {
  // Rendered on another setup than the last Live update: small differences may come from that, not the code.
  const { data: prev } = await cloud.client
    .from("live_updates")
    .select("payload->setup")
    .eq("project_id", cloud.projectId)
    .eq("kind", "live")
    .neq("status", "failed")
    .order("id", { ascending: false })
    .limit(1);
  const before = (prev as { setup: RenderSetup | null }[] | null)?.[0]?.setup;
  const differs = before && setup && (before.os !== setup.os || before.browser !== setup.browser);
  const pictures = images.size;
  const builds = p.kind === "live" || p.kind === "preview";
  // How far each of the designer's designs is (before uploading: a lane marks the designs its branch builds).
  const byKey = new Map(specs.map((s) => [s.k.replace(/^screen:/, ""), s]));
  const { checks } = await proposalChecks(byKey);
  if (p.kind === "preview" && p.lane) {
    const by = (await lanes(cloud))?.find((l) => l.branch === p.branch)?.connected_by;
    input.lane = by ? { by } : {};
    input.designs = checks.map((c) => ({ claim: c.claim, component: c.component, done: c.done, total: c.total }));
  }
  if (builds && pictures) {
    const sent = await timed("sync.upload-pictures", () => uploadMedia(cloud, images), { pictures });
    input.media = [...images.keys()];
    if (sent) console.error(`${sent} picture(s) uploaded (screenshots and the app's images)`);
  }
  const { data: inserted, error } = await timed(
    `sync.upload-${p.kind}`,
    async () =>
      await cloud.client
        .from("live_updates")
        .insert({
          project_id: cloud.projectId,
          commit: p.commit,
          branch: p.branch,
          kind: p.kind,
          status: builds ? "pending" : "checked",
          // A check keeps only what it found; a Live update carries the compiled code for the plugin, gzipped in
          // `bundle` (a big app's pages are megabytes of JSON: too slow for the database to store as JSON). Both
          // keep the registry (which files and stories make each component), for the hosted MCP's instructions.
          ...(builds
            ? { payload: { ...liveMeta(input), pictures, registry, setup }, bundle: packBundle(input) }
            : { payload: { keys: input.keys, registry, dtcg: input.dtcg, setup } }),
        })
        .select("id")
        .single(),
  );
  if (error) throw new Error(`couldn't upload to the service: ${error.message}`);
  const at = `${p.branch ?? "detached"} @${p.commit.slice(0, 7)}`;
  console.log(
    p.kind === "live"
      ? `Live update uploaded (${at}): the CoDesignFlo plugin applies it when the Figma file is open — now, or the next time someone opens it.`
      : p.kind === "preview" && p.lane
        ? `${p.branch}'s lane updated (${at}): the plugin builds what differs from Live beside it, in "Branch: ${p.branch}", with the designs it builds marked; the lane goes when ${p.branch} is merged into ${p.liveBranch} (or: codesignflo branch disconnect).`
        : p.kind === "preview"
          ? `Preview of ${at} uploaded: the plugin builds what differs from Live in a "Branch: ${p.branch}" section on the Live page (Live itself stays as it is); it goes when ${p.branch} is merged into ${p.liveBranch}.`
          : `Checked ${at} — not a Live update (${p.why}).`,
  );

  // Merged into the Live branch: those branches' lanes are done (Live has their code).
  if (p.kind === "live" && input.closePreviews?.length)
    await cloud.client.rpc("disconnect_branches", { p_project: cloud.projectId, p_branches: input.closePreviews }).then(
      () => undefined,
      () => undefined,
    );
  const now = new Date().toISOString();
  for (const c of checks) {
    const done = c.done === c.total;
    await cloud.client
      .from("proposals")
      .update({
        code_check: { done: c.done, total: c.total, conflicts: c.conflicts, exact: c.exact, branch: p.branch, commit: p.commit, at: now },
      })
      .eq("project_id", cloud.projectId)
      .eq("claim_id", c.claim);
    const when =
      p.kind === "live"
        ? "it closes when the designer opens Figma (Live confirms it)"
        : p.branch === p.liveBranch
          ? "commit it, and it closes once Live has it"
          : `it closes once this reaches ${p.liveBranch} and Live has it`;
    console.log(
      done
        ? c.total === 0
          ? `${c.component}: nothing to change in the code (the designer's copy shows no difference); ${when}`
          : `${c.component}: looks done — ${c.total}/${c.total} of the designer's changes are in the code; ${when}${c.exact ? "" : " (layers added or removed: Live confirms the rest)"}`
        : `${c.component}: ${c.done} of ${c.total} of the designer's changes in the code${c.conflicts ? `, ${c.conflicts} clashing` : ""} — the rest: get_proposal ${c.component}`,
    );
  }
  if (differs)
    console.log(
      `! rendered on ${setup.os}, ${setup.browser}; the last Live update was rendered on ${before.os}, ${before.browser} — small differences in Live can come from that (fonts, anti-aliasing), not the code`,
    );
  if (builds && wait) await reportApplied(cloud, (inserted as { id: number }).id);
  for (const line of await liveStatus(cloud, p.liveBranch)) console.log(line);
  return 0;
}

/**
 * Pictures into the project's media storage (members read them; the plugin downloads what its file lacks),
 * named by content hash: one already there isn't sent again. Returns how many were sent.
 */
export async function uploadMedia(cloud: Cloud, images: Map<string, string>): Promise<number> {
  const bucket = cloud.client.storage.from("media");
  const have = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await bucket.list(cloud.projectId, { limit: 1000, offset });
    if (error) throw new Error(`couldn't read the project's pictures in the service: ${error.message}`);
    for (const f of data ?? []) have.add(f.name);
    if ((data ?? []).length < 1000) break;
  }
  const todo = [...images].filter(([ref]) => !have.has(ref));
  let sent = 0;
  const one = async () => {
    for (let next = todo.shift(); next; next = todo.shift()) {
      const [ref, b64] = next;
      const bytes = Buffer.from(b64, "base64");
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const { error } = await bucket.upload(`${cloud.projectId}/${ref}`, bytes, {
        contentType: jpeg ? "image/jpeg" : "image/png",
        upsert: false,
      });
      // Uploaded meanwhile (another sync): it's there, which is all that matters.
      if (error && !/exists|duplicate/i.test(error.message)) throw new Error(`couldn't upload a picture to the service: ${error.message}`);
      sent++;
    }
  };
  await Promise.all([one(), one(), one(), one()]);
  return sent;
}

/** The newest Live update (not superseded), the newest applied one, and when a plugin last checked in. */
export async function liveState(
  cloud: Cloud,
): Promise<{ newest: LiveRow | null; applied: LiveRow | null; seenAt: string | null; error?: string }> {
  const cols = "commit, status, created_at, taken_at, progress, log, cli:payload->setup->>cli";
  const base = () => cloud.client.from("live_updates").select(cols).eq("project_id", cloud.projectId).eq("kind", "live");
  const [n, a, seen] = await Promise.all([
    base().neq("status", "superseded").order("id", { ascending: false }).limit(1),
    base().eq("status", "applied").order("id", { ascending: false }).limit(1),
    cloud.client
      .from("plugin_presence")
      .select("seen_at")
      .eq("project_id", cloud.projectId)
      .order("seen_at", { ascending: false })
      .limit(1),
  ]);
  const error = n.error?.message ?? a.error?.message;
  return {
    newest: ((n.data ?? []) as LiveRow[])[0] ?? null,
    applied: ((a.data ?? []) as LiveRow[])[0] ?? null,
    seenAt: ((seen.data ?? []) as { seen_at: string }[])[0]?.seen_at ?? null,
    ...(error ? { error: expired(error) ? "the sign-in for this command expired — status, or the next sync, shows it" : error } : {}),
  };
}
const expired = (m: string) => /jwt|expired|token/i.test(m);

/**
 * With the Figma file open (the plugin checked in during the last minute), wait for the update to be
 * applied and say how it went — built, closed, removed, and where Live still differs from the app. A big
 * update takes a while: waits while the plugin keeps making progress (up to 30 minutes), 5 without any.
 */
async function reportApplied(start_: Cloud, id: number) {
  let cloud = start_;
  // A ticket's sign-in can run out while waiting (it can't be renewed): this machine's own sign-in takes over.
  let switched = false;
  const { data: seen } = await cloud.client
    .from("plugin_presence")
    .select("seen_at, file_name")
    .eq("project_id", cloud.projectId)
    .order("seen_at", { ascending: false })
    .limit(1);
  const last = (seen as { seen_at: string; file_name: string | null }[] | null)?.[0];
  if (!last || Date.now() - Date.parse(last.seen_at) > 60_000) {
    console.log("Figma isn't open with the plugin: Live is updated when someone opens the file; status then shows how it went.");
    return;
  }
  console.log(`Figma is open${last.file_name ? ` ("${last.file_name}")` : ""}: waiting for the plugin to apply the update…`);
  let said = "";
  let beat = "";
  let moved = Date.now();
  const start = Date.now();
  // Every page is redrawn after some updates (a new CoDesignFlo): about a minute a page, so up to an hour.
  // Five quiet minutes: a plugin in a background window may save only once a minute.
  const QUIET = 5 * 60_000;
  while (Date.now() - start < 60 * 60_000 && Date.now() - moved < QUIET) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data, error } = await cloud.client.from("live_updates").select("status, log, progress, taken_at").eq("id", id).single();
    if (error && expired(error.message) && !switched) {
      switched = true;
      const own = await savedSignIn().catch(() => null);
      if (own) {
        cloud = { ...cloud, client: own };
        continue;
      }
    }
    if (error) {
      console.log(
        expired(error.message)
          ? "Stopped waiting: the sign-in for this command expired. The plugin goes on; status shows how it went."
          : `Stopped waiting: couldn't read the update (${error.message}). The plugin goes on; status shows how it went.`,
      );
      return;
    }
    const u = data as { status: string; log: string | null; progress: LiveRow["progress"]; taken_at: string | null };
    if (u.status === "pending" || u.status === "applying") {
      // Any sign of life counts (each progress save moves taken_at on), not only a page done: a page can take
      // a minute, and pictures load before the first one.
      if (u.taken_at && u.taken_at !== beat) {
        beat = u.taken_at;
        moved = Date.now();
      }
      const now = u.progress ? `${u.progress.done} of ${u.progress.total}` : "";
      const line = now ? `${now} components and pages${u.progress?.item ? ` (${u.progress.item})` : ""}` : "";
      if (line && line !== said) {
        said = line;
        console.log(
          `  applying in Figma: ${line}${u.progress?.background ? " — Figma is in the background, which slows it down: bring its window to the front" : ""}`,
        );
      }
      continue;
    }
    if (u.status === "superseded") return void console.log("(a newer update replaced this one)");
    const lines = (u.log ?? "")
      .split("\n")
      .filter(
        (l) =>
          /^(closed:|removed:|ready:|! |couldn't)/.test(l) ||
          / built on the designer's design| of \d+ layers match the app| — in the preview$|: nothing differs from Live$|\(removed there\)/.test(
            l,
          ),
      );
    console.log(u.status === "applied" ? "Applied in Figma." : "Applying it in Figma failed:");
    const differs = (x: string) =>
      x.includes(": differs from the app — ") ||
      x.includes(": the app differs from the design — ") ||
      x.includes(": differs from your Library — ");
    for (const l of lines.filter((x) => !differs(x))) console.log(`  ${l}`);
    for (const l of differenceLines(u.log, 12)) console.log(`  ${l}`);
    return;
  }
  console.log(
    Date.now() - moved >= QUIET
      ? `No sign from the plugin for 5 minutes${said ? ` (at ${said})` : ""}. If Figma is open, bring its window to the front and leave the plugin running (closing it starts the update over); status shows how it goes.`
      : `Still being applied in Figma${said ? ` (${said})` : ""}: status shows how it goes.`,
  );
}

/** Where Live stands against the Live branch, and proposals done on branches that have since been merged. */
export async function liveStatus(cloud: Cloud, liveBranch?: string, all = false): Promise<string[]> {
  const lb = liveBranch ?? (await liveBranchOf(cloud));
  const out: string[] = [];
  const st = await liveState(cloud);
  const lastLive = st.applied;
  const tip = tipOf(lb);
  if (st.error) out.push(`Live: couldn't read how Live stands (${st.error})`);
  else {
    const n = lastLive && tip ? behind(lastLive.commit, tip) : null;
    out.push(
      `${liveStateLine(lb, st.newest, st.applied, st.seenAt)}${n ? ` — ${n} commit${n > 1 ? "s" : ""} behind ${lb}: sync on ${lb} to update it` : ""}`,
    );
  }
  out.push(...differenceLines(lastLive?.log, all ? Number.POSITIVE_INFINITY : 12));
  const connectedLanes = await lanes(cloud);
  if (connectedLanes?.length)
    out.push(
      `Lanes beside Live: ${connectedLanes.map((l) => `${l.branch} (${l.connected_by ?? "someone"})`).join(", ")} — each updated by a sync on it`,
    );
  if (tip) {
    const open = new Set([...fold(readLedger()).values()].filter((x) => x.state === "ready_for_dev" && x.claim).map((x) => x.claim!.id));
    const { data } = await cloud.client
      .from("proposals")
      .select("component, claim_id, code_check")
      .eq("project_id", cloud.projectId)
      .not("code_check", "is", null);
    for (const r of (data ?? []) as {
      component: string;
      claim_id: string;
      code_check: { done: number; total: number; branch: string | null; commit: string };
    }[]) {
      const c = r.code_check;
      if (!open.has(r.claim_id) || c.branch === lb || c.done !== c.total || !c.total) continue;
      // Merged: in the tip's history, or (squash merge) the component's files are the same as on the branch.
      if (contains(tip, c.commit) || sameFiles(c.commit, tip, filesOf(r.component)))
        out.push(`${r.component}: done on ${c.branch}, now merged into ${lb} — Live has it after the next sync on ${lb}`);
    }
  }
  return out;
}

/** The component's or page's files, from the registry the last sync wrote (paths relative to the app). */
function filesOf(component: string): string[] {
  const f = join(dir(), "registry.json");
  if (!existsSync(f)) return [];
  const r = JSON.parse(readFileSync(f, "utf8")) as {
    components?: Record<string, { files?: string[] }>;
    screens?: Record<string, { files?: string[] }>;
  };
  return r.components?.[component]?.files ?? r.screens?.[component]?.files ?? [];
}

// ---- the hook's background runs: one at a time per project; commits made meanwhile are rendered once ----

const lockDir = () => join(homedir(), ".codesignflo", "locks");

/**
 * Runs `work` unless a run for this project is already going; then that run is told to go again at the end
 * (HEAD will have moved). Returns false when it handed over.
 */
export async function oneAtATime(projectId: string, work: () => Promise<void>): Promise<boolean> {
  mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
  const id = safeProjectId(projectId);
  const lock = join(lockDir(), `${id}.lock`);
  const again = join(lockDir(), `${id}.again`);
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // stale lock
    }
    if (alive) {
      writeFileSync(again, "1");
      return false;
    }
  }
  writeFileSync(lock, String(process.pid));
  try {
    do {
      rmSync(again, { force: true });
      await work();
    } while (existsSync(again));
  } finally {
    rmSync(lock, { force: true });
  }
  return true;
}

/** codesignflo live-branch [name] — which branch updates Live (developers and admins can change it). */
export async function liveBranchCommand(args: string[], cloud: Cloud | null): Promise<number> {
  if (!cloud) throw new Error("this app isn't connected to the CoDesignFlo service — run: codesignflo init --cloud");
  const name = args.find((a) => !a.startsWith("--"));
  if (name) {
    branchName(name);
    const { error } = await cloud.client.rpc("set_live_branch", { p_project: cloud.projectId, p_branch: name });
    if (error) throw new Error(error.message);
  }
  console.log(`Live follows ${await liveBranchOf(cloud)}${name ? "" : " (change it: codesignflo live-branch <name>)"}`);
  return 0;
}

/**
 * codesignflo branch [connect | disconnect] [<name>] — branches with a lane beside Live: every sync on a
 * connected branch updates its lane (developers and admins). Without arguments: the connected branches.
 */
export async function branchCommand(args: string[], cloud: Cloud | null): Promise<number> {
  if (!cloud) throw new Error("this app isn't connected to the CoDesignFlo service — run: codesignflo init --cloud");
  const [sub, given] = args.filter((a) => !a.startsWith("--"));
  const liveBranch = await liveBranchOf(cloud);
  if (sub === "connect" || sub === "disconnect") {
    const name = branchName(given ?? branch());
    if (sub === "connect") {
      if (name === liveBranch) throw new Error(`${name} is the Live branch: Live is its lane`);
      const { error } = await cloud.client.rpc("connect_branch", { p_project: cloud.projectId, p_branch: name });
      if (error) throw new Error(error.message);
      console.log(
        `${name} is connected: every sync on it (yours, the agent's, the git hook's) updates its lane beside Live in Figma — what differs from Live, with the designs it builds marked. It goes when ${name} is merged into ${liveBranch}, or: codesignflo branch disconnect ${name}`,
      );
      if (branch() === name) console.log("Sync now to build the lane: codesignflo sync");
    } else {
      const { data, error } = await cloud.client.rpc("disconnect_branches", { p_project: cloud.projectId, p_branches: [name] });
      if (error) throw new Error(error.message);
      console.log(data ? `${name} is disconnected: its lane goes from Figma the next time the plugin runs.` : `${name} wasn't connected.`);
    }
    return 0;
  }
  if (sub && sub !== "list") throw new Error("usage: codesignflo branch [connect | disconnect] [<name>]");
  const list = await lanes(cloud);
  if (!list) throw new Error("couldn't read the connected branches (the service may be from before lanes)");
  if (!list.length) console.log(`No branches connected: Live follows ${liveBranch}. Connect this one: codesignflo branch connect`);
  for (const l of list) console.log(`${l.branch} — connected by ${l.connected_by ?? "someone"} on ${l.connected_at.slice(0, 10)}`);
  return 0;
}
