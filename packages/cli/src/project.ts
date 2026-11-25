// The project's CoDesignFlo folder: config and the ledger (code- and design-side events, in git).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CANON_VERSION, type LedgerEvent, ordered, type Raw, readEvent, stringify } from "@codesignflo/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inside, isSegment } from "./safe.js";
import { signedIn, ticketProject } from "./service/client.js";

export type Config = {
  projectId: string;
  tokens?: string;
  registry?: string;
  ir?: string;
  /** Live mirrors this branch: sync updates Live only from it (unless --allow-branch). */
  trackedBranch?: string;
  /** The history lives in the CoDesignFlo service (cloud mode), not in events.jsonl. */
  cloud?: boolean;
};

// ---- cloud mode: the history is loaded from the service once per command and written back at the end ----

type Row = { id: string; at: string; by: string; component: string; kind: string; body: Record<string, unknown> };
let cloud: { projectId: string; events: LedgerEvent[]; pending: LedgerEvent[]; client: SupabaseClient } | null = null;

const toRow = (projectId: string, e: LedgerEvent) => {
  const { id, at, by, component, kind, ...body } = e;
  return { project_id: projectId, id, at, by, component, kind, body };
};
const toEvent = (r: Row): LedgerEvent | null =>
  readEvent({ ...r.body, id: r.id, at: r.at, by: r.by, component: r.component, kind: r.kind });

/** Loads the project's history from the service (cloud projects only). */
export async function openCloud(cwd?: string) {
  const c = readConfig(cwd);
  if (!c?.cloud) return;
  const { client } = await signedIn();
  const forProject = await ticketProject();
  if (forProject && forProject !== c.projectId)
    throw new Error(`this command was made for project ${forProject}, but this app is ${c.projectId} — run it in that app's folder`);
  const events: LedgerEvent[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from("events")
      .select("id, at, by, component, kind, body")
      .eq("project_id", c.projectId)
      .order("seq")
      .range(from, from + 999);
    if (error) throw new Error(`couldn't read the project's history: ${error.message}`);
    events.push(...(data as Row[]).map(toEvent).filter((e): e is LedgerEvent => e !== null));
    if ((data ?? []).length < 1000) break;
  }
  cloud = { projectId: c.projectId, events, pending: [], client };
}

/** The service connection of a cloud project (after openCloud), or null in local mode. */
export const cloudSession = () => (cloud ? { client: cloud.client, projectId: cloud.projectId } : null);

/** Writes the events added during this command to the service. */
export async function flushCloud() {
  if (!cloud?.pending.length) return;
  const rows = cloud.pending.map((e) => toRow(cloud!.projectId, e));
  const { error } = await cloud.client.from("events").upsert(rows, { onConflict: "project_id,id", ignoreDuplicates: true });
  if (error) throw new Error(`couldn't save to the project's history: ${error.message}`);
  cloud.pending = [];
}

/** Uploads a local history (moving a local project to the cloud). */
export async function uploadHistory(client: SupabaseClient, projectId: string, events: LedgerEvent[]) {
  for (let i = 0; i < events.length; i += 500) {
    const { error } = await client.from("events").upsert(
      events.slice(i, i + 500).map((e) => toRow(projectId, e)),
      { onConflict: "project_id,id", ignoreDuplicates: true },
    );
    if (error) throw new Error(`couldn't upload the history: ${error.message}`);
  }
}

export const dir = (cwd = process.cwd()) => {
  const d = resolve(cwd, ".codesignflo");
  // Projects set up before the rename to CoDesignFlo: the folder is renamed in place, once.
  const legacy = resolve(cwd, ".codesignloop");
  if (!existsSync(d) && existsSync(legacy)) renameSync(legacy, d);
  return d;
};
const configPath = (cwd?: string) => join(dir(cwd), "config.json");
const ledgerPath = (cwd?: string) => join(dir(cwd), "events.jsonl");

export function readConfig(cwd?: string): Config | null {
  const p = configPath(cwd);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Config) : null;
}

export function writeConfig(c: Config, cwd?: string) {
  mkdirSync(dir(cwd), { recursive: true });
  writeFileSync(configPath(cwd), `${JSON.stringify(c, null, 2)}\n`);
}

export function requireConfig(cwd?: string): Config {
  const c = readConfig(cwd);
  if (!c) throw new Error("no .codesignflo/config.json here — run `codesignflo init` first (in your app's folder)");
  return c;
}

export function readLedger(cwd?: string): LedgerEvent[] {
  if (cloud) return cloud.events;
  const p = ledgerPath(cwd);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => readEvent(JSON.parse(l)))
    .filter((e): e is LedgerEvent => e !== null);
}

/** Appends events not already in the ledger (by id). Returns the ones added. */
export function appendLedger(events: LedgerEvent[], cwd?: string): LedgerEvent[] {
  const have = new Set(readLedger(cwd).map((e) => e.id));
  const add = ordered(events.filter((e) => !have.has(e.id)));
  if (cloud) {
    cloud.events.push(...add);
    cloud.pending.push(...add);
    return add;
  }
  if (add.length) {
    mkdirSync(dir(cwd), { recursive: true });
    writeFileSync(ledgerPath(cwd), add.map((e) => `${JSON.stringify(e)}\n`).join(""), { flag: "a" });
  }
  return add;
}

// ---- generations: what Live showed at each version (snapshots/ in the repo, or the service) ----

const snapPath = (component: string, gen: string, cwd?: string) =>
  inside(join(dir(cwd), "snapshots"), [
    { value: component, what: "component" },
    { value: `${gen}.json`, what: "version" },
  ]);
const generations = new Map<string, Raw | null>();

/** The snapshot of one generation of a component or page (null when it isn't stored). */
export async function loadGeneration(component: string, gen: string): Promise<Raw | null> {
  const key = `${component}@${gen}`;
  if (generations.has(key)) return generations.get(key)!;
  let snap: Raw | null = null;
  if (cloud) {
    const { data, error } = await cloud.client
      .from("generations")
      .select("snapshot, canon_version")
      .eq("project_id", cloud.projectId)
      .eq("component", component)
      .eq("gen", gen)
      .maybeSingle();
    if (error) throw new Error(`couldn't read a version of ${component}: ${error.message}`);
    // Another snapshot format can't be compared with Live: as if it weren't stored.
    snap = data && (data.canon_version ?? CANON_VERSION) === CANON_VERSION ? (data.snapshot as Raw) : null;
    // Generations made before the project moved to the cloud are still in the repo.
  }
  if (!snap && isSegment(component) && isSegment(gen) && existsSync(snapPath(component, gen)))
    snap = JSON.parse(readFileSync(snapPath(component, gen), "utf8")) as Raw;
  generations.set(key, snap);
  return snap;
}

export async function saveGeneration(component: string, gen: string, snap: Raw) {
  generations.set(`${component}@${gen}`, snap);
  if (cloud) {
    const { error } = await cloud.client
      .from("generations")
      .upsert(
        { project_id: cloud.projectId, component, gen, snapshot: snap, canon_version: CANON_VERSION },
        { onConflict: "project_id,component,gen", ignoreDuplicates: true },
      );
    if (error) throw new Error(`couldn't save a version of ${component}: ${error.message}`);
    return;
  }
  mkdirSync(dirname(snapPath(component, gen)), { recursive: true });
  writeFileSync(snapPath(component, gen), stringify(snap));
}

/** Uploads the generations kept in the repo (a local project moving to the cloud). Returns how many. */
export async function uploadGenerations(client: SupabaseClient, projectId: string, cwd?: string): Promise<number> {
  const root = join(dir(cwd), "snapshots");
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const component of readdirSync(root)) {
    for (const file of readdirSync(join(root, component)).filter((f) => f.endsWith(".json"))) {
      const snapshot = JSON.parse(readFileSync(join(root, component, file), "utf8")) as Raw;
      const { error } = await client
        .from("generations")
        .upsert(
          { project_id: projectId, component, gen: file.slice(0, -5), snapshot, canon_version: CANON_VERSION },
          { onConflict: "project_id,component,gen", ignoreDuplicates: true },
        );
      if (error) throw new Error(`couldn't upload the versions of ${component}: ${error.message}`);
      n++;
    }
  }
  return n;
}
