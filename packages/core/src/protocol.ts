// Wire protocol between the CoDesignFlo CLI (bridge server, localhost) and the Figma plugin.
// JSON text frames; request/response correlation; progress resets the caller's timeout; large
// messages are chunked. Validated in spike S0 (p95 0.37 ms; 20 MB payloads intact).

/** Bump on any incompatible change; both sides refuse to talk across versions. */
export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 4517;
/** Messages larger than this are split into chunks (characters of the JSON string). */
export const CHUNK_SIZE = 512 * 1024;
/** Close code sent to a plugin whose connection was taken over by the plugin in another file. */
export const CLOSE_REPLACED = 4001;

/**
 * Pairing: the plugin shows `pairCode`; the developer types it in the terminal to approve. The CLI then
 * issues a long-lived `secret` the plugin stores and sends on later connects (S0: pasting into the
 * plugin panel was unreliable in Figma desktop).
 */
/** The code the plugin shows for pairing: four digits (1000–9999). Anything else is not from the plugin. */
export const PAIR_CODE = /^\d{4}$/;

export type Hello = {
  t: "hello";
  protocol: number;
  secret: string | null;
  pairCode: string;
  plugin: { version: string };
  /** `projectId` comes from the file's root data (written by `codesignflo init`); null = file not set up. */
  file: { name: string; projectId: string | null; editorType: string };
  user: { name: string | null } | null;
};
export type Welcome = { t: "welcome"; protocol: number; server: { version: string }; secret: string };
export type AwaitingApproval = { t: "awaiting_approval" };
export type Rejected = { t: "rejected"; reason: string; code: "protocol" | "plugin_too_old" | "wrong_file" | "not_approved" };

export type Request = { t: "req"; id: string; method: string; params?: unknown };
export type Response =
  | { t: "res"; id: string; ok: true; result: unknown }
  | { t: "res"; id: string; ok: false; error: { message: string; stack?: string } };
export type Progress = { t: "progress"; id: string; done?: number; total?: number };
export type Chunk = { t: "chunk"; cid: string; seq: number; total: number; data: string };

export type Message = Hello | Welcome | AwaitingApproval | Rejected | Request | Response | Progress | Chunk;

let chunkCounter = 0;

/** Serialize a message into one or more frames. */
export function encode(msg: Message, chunkSize = CHUNK_SIZE): string[] {
  const json = JSON.stringify(msg);
  if (json.length <= chunkSize) return [json];
  const cid = `c${Date.now().toString(36)}${(chunkCounter++).toString(36)}`;
  const total = Math.ceil(json.length / chunkSize);
  const frames: string[] = [];
  for (let seq = 0; seq < total; seq++) {
    const chunk: Chunk = { t: "chunk", cid, seq, total, data: json.slice(seq * chunkSize, (seq + 1) * chunkSize) };
    frames.push(JSON.stringify(chunk));
  }
  return frames;
}

/** Reassembles chunked frames. Returns a message when one is complete, otherwise null. */
export class Decoder {
  private pending = new Map<string, { parts: string[]; received: number }>();

  push(frame: string): Message | null {
    const msg = JSON.parse(frame) as Message;
    if (msg.t !== "chunk") return msg;
    let entry = this.pending.get(msg.cid);
    if (!entry) {
      entry = { parts: new Array(msg.total), received: 0 };
      this.pending.set(msg.cid, entry);
    }
    if (entry.parts[msg.seq] === undefined) entry.received++;
    entry.parts[msg.seq] = msg.data;
    if (entry.received < msg.total) return null;
    this.pending.delete(msg.cid);
    return JSON.parse(entry.parts.join("")) as Message;
  }
}

/** Semver-ish "a.b.c" comparison: is `have` at least `need`? */
export function atLeast(have: string, need: string): boolean {
  const p = (v: string) => v.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const [a, b] = [p(have), p(need)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
