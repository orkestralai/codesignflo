// What the CLI tells CoDesignFlo's team about how it does (see packages/core/src/telemetry.ts): crashes with
// where they happened, the setup a sync ran on, and how long each step took. Structure and numbers only; for
// a project that shares its content (opt-in, in its settings), a crash also attaches the end of the CLI's
// output. Sent once at the end of a command, never in its way: no sign-in, no network, a slow service or
// CODESIGNFLO_TELEMETRY=off — nothing is sent and the command goes on as if nothing happened.
import { randomUUID } from "node:crypto";
import { crashSignature, type TelemetryEvent } from "@codesignflo/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cloudSession } from "./project.js";
import { signedIn } from "./service/client.js";
import { VERSION } from "./version.js";

export const telemetryOff = () => /^(0|off|false|no)$/i.test(process.env.CODESIGNFLO_TELEMETRY ?? "");

const queue: TelemetryEvent[] = [];
/** The last lines the CLI printed (a crash's context, attached only for projects that share content). */
const tail: string[] = [];
for (const level of ["log", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    tail.push(args.map(String).join(" "));
    if (tail.length > 200) tail.shift();
    original(...args);
  };
}

export function record(e: Omit<TelemetryEvent, "source" | "version">) {
  if (!telemetryOff()) queue.push({ source: "cli", version: VERSION, ...e });
}

/** Runs a step and records how long it took ("sync.render"), whether it worked or not. */
export async function timed<T>(signature: string, fn: () => T | Promise<T>, data?: Record<string, unknown>): Promise<T> {
  const start = Date.now();
  let ok = true;
  try {
    return await fn();
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    record({ kind: "timing", signature, data: { ms: Date.now() - start, ...(ok ? {} : { failed: true }), ...data } });
  }
}

let crashed: Error | null = null;
/** A command that failed: recorded with where in CoDesignFlo it happened (its stack's own frames). */
export function recordCrash(command: string, e: Error) {
  crashed = e;
  const own = (e.cause as Error | undefined)?.stack ?? e.stack ?? "";
  record({
    kind: "crash",
    signature: crashSignature(command, e.message, own),
    data: {
      command,
      error: e.name,
      // Its own code's frames only: function, file and line, no paths from the developer's machine.
      stack: own
        .split("\n")
        .slice(1, 9)
        .map((l) => l.trim().replace(/\(?(?:file:\/\/)?[^\s()]*[/\\]([\w.-]+:\d+:\d+)\)?/, "($1)")),
      node: process.versions.node,
    },
  });
}

const within = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), ms).unref())]);

/** Sends what was recorded (at the end of a command). Never throws, never waits more than a few seconds. */
export async function flushTelemetry() {
  if (!queue.length || telemetryOff()) return;
  const events = queue.splice(0);
  try {
    const session = cloudSession();
    const client: SupabaseClient = session?.client ?? (await within(3000, signedIn())).client;
    const project = session?.projectId ?? null;
    if (crashed && project) {
      const content = await shareContent(client, project, tail.join("\n"));
      if (content) for (const e of events) if (e.kind === "crash") e.content = content;
    }
    await within(
      5000,
      Promise.resolve(
        client.from("telemetry").insert(
          events.map((e) => ({
            project_id: e.project ?? project,
            source: e.source,
            kind: e.kind,
            signature: e.signature,
            version: e.version,
            data: e.data ?? {},
            content: e.content ?? null,
          })),
        ),
      ),
    );
  } catch {
    // Telemetry is never in the way.
  }
}

/** For a project that shares its content: uploads `text` and returns its path; otherwise nothing. */
async function shareContent(client: SupabaseClient, project: string, text: string): Promise<string | undefined> {
  const { data: shares } = await within(3000, Promise.resolve(client.rpc("shares_content", { p: project })));
  if (shares !== true) return undefined;
  const path = `${project}/${randomUUID()}.txt`;
  const { error } = await within(5000, Promise.resolve(client.storage.from("telemetry").upload(path, text, { contentType: "text/plain" })));
  return error ? undefined : path;
}
