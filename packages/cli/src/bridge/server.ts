// Localhost bridge to the Figma plugin (protocol v2). Accepts one plugin at a time, only from the
// project's file (by projectId), and only a plugin new enough for this CLI. Unknown plugins pair by
// showing a code the developer types here; approved plugins get a secret and reconnect silently.
// Ported from spike S0 (p95 0.37 ms; 20 MB payloads; reverse pairing).
// Any web page the developer has open can reach ws://localhost too: only the plugin's iframe (Origin "null",
// or no Origin from non-browser clients) on a loopback Host gets in, it gets one small hello frame and 10 s to
// send it, and a pairing needs the four-digit code the plugin shows, typed here. Secrets are kept per project.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Duplex } from "node:stream";
import * as protocol from "@codesignflo/core/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { printable } from "../safe.js";
import { VERSION } from "../version.js";

export const CLI_VERSION = VERSION;
/** Oldest plugin this CLI works with. */
export const MIN_PLUGIN = "0.1.0";

export type CallOptions = { timeoutMs?: number };
export type Session = {
  hello: protocol.Hello;
  call: <T = unknown>(method: string, params?: unknown, opts?: CallOptions) => Promise<T>;
};
export type BridgeOptions = {
  port?: number;
  /**
   * The project pairings made here are for (default: `accept.projectId`). `codesignflo init` on a file not set
   * up yet passes the id it is about to give the file.
   */
  projectId?: string;
  /**
   * Which file to accept: a projectId, a file name (test scripts), or "unset" for `codesignflo init` (only files not yet set up), or
   * "any". Plugins in other files are told "developer is on another file" and stop retrying.
   */
  accept: { projectId: string } | { fileName: string } | "unset" | "any";
  approve?: (hello: protocol.Hello) => Promise<boolean>;
  secretsFile?: string;
  /** How long a connection may stay silent before its hello (tests shorten it). */
  helloTimeoutMs?: number;
  log?: (line: string) => void;
};

/** Before a plugin is in: one hello frame, this small, within this long. */
export const PRE_AUTH_BYTES = 64 * 1024;
export const HELLO_TIMEOUT_MS = 10_000;

/**
 * paired.json: one entry per approved plugin (the plugin keeps one secret for every file), with the projects it
 * was approved for. A bare string is a pairing made before projects were recorded: it is bound to the first
 * project it connects for, so nobody has to pair again after updating.
 */
type Pairing = { secret: string; projects: string[]; at?: string };
type Stored = string | Pairing;

const helloSchema = z.object({
  t: z.literal("hello"),
  protocol: z.number(),
  secret: z.string().max(256).nullable(),
  pairCode: z.string().regex(protocol.PAIR_CODE),
  plugin: z.object({ version: z.string().max(64) }),
  file: z.object({ name: z.string().max(2048), projectId: z.string().max(128).nullable(), editorType: z.string().max(64) }),
  user: z.object({ name: z.string().max(512).nullable() }).nullable(),
});

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Only the Figma plugin's iframe may connect: its Origin is "null" (other clients, like test scripts, send none);
 * a web page's is its own and is refused. The Host must be this machine (a DNS-rebound name is refused).
 */
export function upgradeAllowed(headers: IncomingMessage["headers"], port: number): { ok: true } | { ok: false; why: string } {
  const origin = headers.origin;
  if (origin !== undefined && origin !== "null") return { ok: false, why: `a web page (${printable(origin, 80)})` };
  const host = (headers.host ?? "").toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!m || !LOOPBACK.has(m[1]!) || (m[2] !== undefined && Number(m[2]) !== port))
    return { ok: false, why: `an address that isn't this machine (Host ${printable(host, 80) || "missing"})` };
  return { ok: true };
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
  method: string;
};

export class Bridge {
  readonly port: number;
  private opts: BridgeOptions;
  private secretsFile: string;
  private approvals = Promise.resolve();
  private wss: WebSocketServer | null = null;
  private http: Server[] = [];
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private waiters: ((s: Session) => void)[] = [];
  private session: Session | null = null;

  constructor(opts: BridgeOptions) {
    this.opts = opts;
    this.port = opts.port ?? protocol.DEFAULT_PORT;
    this.secretsFile = opts.secretsFile ?? join(homedir(), ".codesignflo", "paired.json");
    // Pairings made before the rename to CoDesignFlo.
    const legacy = join(homedir(), ".codesignloop", "paired.json");
    if (!opts.secretsFile && !existsSync(this.secretsFile) && existsSync(legacy)) {
      mkdirSync(join(homedir(), ".codesignflo"), { recursive: true, mode: 0o700 });
      copyFileSync(legacy, this.secretsFile);
      chmodSync(this.secretsFile, 0o600);
    }
  }

  private log(line: string) {
    (this.opts.log ?? ((l: string) => console.error(l)))(line);
  }

  private secrets(): Stored[] {
    try {
      const all = JSON.parse(readFileSync(this.secretsFile, "utf8")) as unknown;
      return Array.isArray(all)
        ? all.filter((e): e is Stored => typeof e === "string" || (!!e && typeof e.secret === "string" && Array.isArray(e.projects)))
        : [];
    } catch {
      return [];
    }
  }

  private saveSecrets(all: Stored[]) {
    const d = dirname(this.secretsFile);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileSync(this.secretsFile, JSON.stringify(all), { mode: 0o600 });
    chmodSync(this.secretsFile, 0o600);
  }

  /** The project a pairing is for: the one this command works on. */
  private project(): string | null {
    const a = this.opts.accept;
    return this.opts.projectId ?? (typeof a === "object" && "projectId" in a ? a.projectId : null);
  }

  /** Is this secret approved for this command's project? A legacy entry becomes bound to it here. */
  private known(secret: string): boolean {
    const all = this.secrets();
    const i = all.findIndex((e) => sameSecret(typeof e === "string" ? e : e.secret, secret));
    if (i < 0) return false;
    const e = all[i]!;
    const project = this.project();
    if (typeof e === "string") {
      if (project) {
        all[i] = { secret: e, projects: [project] };
        this.saveSecrets(all);
      }
      return true;
    }
    // No project (test scripts on a named file): any approved plugin.
    return !project || e.projects.includes(project);
  }

  /** After the developer approved: the plugin's secret, now also for this project (a new one if it had none). */
  private approveSecret(had: string | null): string {
    const all = this.secrets();
    const project = this.project();
    const i = had ? all.findIndex((e) => sameSecret(typeof e === "string" ? e : e.secret, had)) : -1;
    if (i >= 0) {
      const e = all[i]!;
      const entry: Pairing = typeof e === "string" ? { secret: e, projects: [] } : e;
      if (project && !entry.projects.includes(project)) entry.projects.push(project);
      all[i] = entry;
      this.saveSecrets(all);
      return entry.secret;
    }
    const secret = randomBytes(24).toString("hex");
    this.saveSecrets([...all, { secret, projects: project ? [project] : [], at: new Date().toISOString() }]);
    return secret;
  }

  /** Listens on both loopback addresses: `ws://localhost` may resolve to ::1 or 127.0.0.1. */
  async listen(): Promise<void> {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer((_, res) => res.writeHead(426).end());
      server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.port, host, () => resolve());
        });
        this.http.push(server);
      } catch (e) {
        if (host !== "127.0.0.1") continue;
        if ((e as NodeJS.ErrnoException).code === "EADDRINUSE")
          throw new Error(
            `port ${this.port} is in use, probably another codesignflo command. Find it with: lsof -nP -iTCP:${this.port} -sTCP:LISTEN`,
          );
        throw e;
      }
    }
  }

  /** Resolves when an accepted plugin is connected; rejects after `timeoutMs`. */
  waitForPlugin(timeoutMs = 0): Promise<Session> {
    if (this.session) return Promise.resolve(this.session);
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      if (timeoutMs > 0)
        setTimeout(
          () =>
            reject(new Error("the CoDesignFlo plugin did not connect — open it in Figma desktop (Plugins → Development → CoDesignFlo)")),
          timeoutMs,
        );
    });
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge closed"));
    }
    this.pending.clear();
    this.socket?.close();
    this.wss?.close();
    await Promise.all(this.http.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }

  private reject(ws: WebSocket, code: protocol.Rejected["code"], reason: string) {
    this.send(ws, { t: "rejected", code, reason });
    ws.close(1008, reason.slice(0, 120));
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const check = upgradeAllowed(req.headers, this.port);
    if (!check.ok) {
      this.log(`refused a connection to the plugin bridge from ${check.why}`);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss?.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, socket));
  }

  private onConnection(ws: WebSocket, raw: Duplex) {
    const decoder = new protocol.Decoder();
    let authed = false;
    let hello: protocol.Hello | null = null;
    // Until the plugin is in: a few bytes, and a hello soon (the frame limit after that is the server's 64 MB).
    // ws checks a frame's announced length against its receiver's limit as the header arrives: lowered until the
    // plugin is in (ws has no per-connection option). The byte count on the socket backs it up.
    const receiver = (ws as unknown as { _receiver?: { _maxPayload?: number } })._receiver;
    const limit = receiver?._maxPayload;
    if (receiver && typeof limit === "number") receiver._maxPayload = PRE_AUTH_BYTES;
    let received = 0;
    const count = (chunk: Buffer) => {
      received += chunk.length;
      if (!authed && received > PRE_AUTH_BYTES + 1024) raw.destroy();
    };
    raw.prependListener("data", count);
    const silent = setTimeout(() => {
      if (!hello) ws.terminate();
    }, this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    // A bad or oversized frame: ws closes the connection itself; never an uncaught error that ends the command.
    ws.on("error", () => {});
    ws.on("message", (data) => {
      if (authed) {
        let msg: protocol.Message | null;
        try {
          msg = decoder.push(data.toString());
        } catch {
          ws.close(1003, "bad frame");
          return;
        }
        if (msg) this.onMessage(msg);
        return;
      }
      // One hello, whole (not chunked); anything else before approval ends the connection.
      if (hello) return void ws.close(1008, "expected nothing before approval");
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return void ws.close(1003, "bad frame");
      }
      const valid = helloSchema.safeParse(parsed);
      if (!valid.success) return void ws.close(1008, "expected hello");
      clearTimeout(silent);
      hello = valid.data as protocol.Hello;
      this.onHello(ws, hello, () => {
        authed = true;
        raw.off("data", count);
        if (receiver && typeof limit === "number") receiver._maxPayload = limit;
      });
    });
    ws.on("close", () => {
      clearTimeout(silent);
      raw.off("data", count);
      if (this.socket !== ws) return;
      this.socket = null;
      this.session = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`the plugin disconnected during ${p.method}`));
      }
      this.pending.clear();
    });
  }

  private onHello(ws: WebSocket, hello: protocol.Hello, authed: () => void) {
    if (hello.protocol !== protocol.PROTOCOL_VERSION)
      return this.reject(ws, "protocol", `protocol ${hello.protocol}, CLI speaks ${protocol.PROTOCOL_VERSION}`);
    if (!protocol.atLeast(hello.plugin.version, MIN_PLUGIN))
      return this.reject(ws, "plugin_too_old", `plugin ${hello.plugin.version} is older than ${MIN_PLUGIN}`);
    const a = this.opts.accept;
    const fileOk =
      a === "any" ||
      (a === "unset"
        ? hello.file.projectId === null
        : "fileName" in a
          ? hello.file.name === a.fileName
          : hello.file.projectId === a.projectId);
    if (!fileOk) {
      this.log(
        `ignoring the plugin in "${printable(hello.file.name)}" (${hello.file.projectId ? `project ${printable(hello.file.projectId, 64)}` : "not set up"})`,
      );
      return this.reject(ws, "wrong_file", "the developer's CLI is working on another file");
    }
    const accept = (secret: string) => {
      if (ws.readyState !== ws.OPEN) return;
      authed();
      if (this.socket && this.socket !== ws) this.socket.close(protocol.CLOSE_REPLACED, "replaced");
      this.socket = ws;
      this.send(ws, { t: "welcome", protocol: protocol.PROTOCOL_VERSION, server: { version: CLI_VERSION }, secret });
      this.session = { hello, call: (m, p, o) => this.call(m, p, o) };
      for (const w of this.waiters.splice(0)) w(this.session);
    };
    if (hello.secret && this.known(hello.secret)) return accept(hello.secret);
    this.send(ws, { t: "awaiting_approval" });
    this.approvals = this.approvals
      .then(async () => {
        if (ws.readyState !== ws.OPEN) return;
        if (await (this.opts.approve ?? askInTerminal)(hello)) accept(this.approveSecret(hello.secret));
        else this.reject(ws, "not_approved", "pairing not approved");
      })
      // A prompt that failed (stdin closed, say) refuses this plugin only; later pairings still get asked.
      .catch(() => {
        if (ws.readyState === ws.OPEN) this.reject(ws, "not_approved", "pairing not approved");
      });
  }

  private onMessage(msg: protocol.Message) {
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error.message), { stack: msg.error.stack }));
    } else if (msg.t === "progress") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      p.timer = this.arm(msg.id, p.timeoutMs, p.method);
    }
  }

  private call<T>(method: string, params?: unknown, opts: CallOptions = {}): Promise<T> {
    const ws = this.socket;
    if (!ws) return Promise.reject(new Error("the plugin is not connected"));
    const id = `r${(this.seq++).toString(36)}`;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeoutMs, method, timer: this.arm(id, timeoutMs, method) });
      this.send(ws, { t: "req", id, method, params });
    });
  }

  private arm(id: string, ms: number, method: string) {
    return setTimeout(() => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      p.reject(new Error(`${method} timed out after ${ms} ms without progress`));
    }, ms);
  }

  private send(ws: WebSocket, msg: protocol.Message) {
    for (const frame of protocol.encode(msg)) ws.send(frame);
  }
}

/** Does what the developer typed match the code the plugin shows? (Empty never does.) */
export const codeMatches = (typed: string, pairCode: string) =>
  protocol.PAIR_CODE.test(pairCode) && typed.trim() !== "" && typed.trim() === pairCode;

async function askInTerminal(hello: protocol.Hello): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // Names come from the plugin's connection: printed without control or escape characters.
    const who = `${printable(hello.file.name)}${hello.user?.name ? ` (${printable(hello.user.name, 60)})` : ""}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const typed = await rl.question(`\nThe CoDesignFlo plugin in "${who}" wants to connect.\nType the code shown in the plugin: `);
      if (codeMatches(typed, hello.pairCode)) return true;
      console.error("that code doesn't match");
    }
    return false;
  } finally {
    rl.close();
  }
}
