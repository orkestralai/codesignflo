// Self-hosting: a team's own CoDesignFlo "box" (Supabase and the server behind one origin). The box describes
// itself at <box>/config.json ({ mode: "selfhost", url, anon, mcpUrl, … }). From it the CLI builds the Figma
// plugin for that box (`codesignflo plugin build --server <box>`) and connects itself to it (`codesignflo connect`).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { printable } from "./safe.js";

/** What a box serves at /config.json, checked. `origin` is the box's own (where config.json came from). */
export type BoxConfig = { mode: "selfhost"; origin: string; url: string; anon: string; web: string; mcpUrl: string };

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** A private address: RFC 1918, Tailscale's 100.64/10, link-local, *.local (mDNS). Plain http is allowed only there. */
export function isPrivateHost(host: string): boolean {
  if (LOOPBACK.includes(host) || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

/**
 * A box address as typed (https://box.example.com, http://localhost:8080, https://laptop.tailnet.ts.net): its
 * origin. https anywhere; plain http only on this machine or the local network (a sign-in would cross the
 * internet unencrypted otherwise).
 */
export function boxOrigin(input: string): URL {
  let u: URL;
  try {
    u = new URL(/^[a-z][\w+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error(`not a URL: ${JSON.stringify(printable(input, 100))}`);
  }
  if (u.username || u.password) throw new Error("the box's URL can't carry a user name or password");
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`the box's URL must be https:// (got ${u.protocol})`);
  if (u.protocol === "http:" && !isPrivateHost(u.hostname))
    throw new Error(
      `http://${u.host} is not on this machine or the local network: use https:// (plain http only for localhost, LAN or Tailscale addresses)`,
    );
  return new URL(u.origin);
}

const isLoopback = (u: URL) => LOOPBACK.includes(u.hostname);

/** The same box: same origin, counting localhost / 127.0.0.1 / [::1] on the same port and scheme as one. */
const sameBox = (a: URL, b: URL) =>
  a.origin === b.origin || (isLoopback(a) && isLoopback(b) && a.protocol === b.protocol && a.port === b.port);

/** An address the box's config gives (its API, web, MCP): on the box itself, or refused. */
function onBox(value: unknown, box: URL, what: string): string {
  if (typeof value !== "string" || !value) throw new Error(`the box's config.json has no ${what}`);
  let u: URL;
  try {
    u = new URL(value, box);
  } catch {
    throw new Error(`the box's ${what} isn't a URL: ${JSON.stringify(printable(value, 100))}`);
  }
  if (u.username || u.password || !sameBox(u, box))
    throw new Error(`the box's ${what} ${JSON.stringify(printable(value, 100))} is not on ${box.origin}: refusing it`);
  // The box's own host as typed (Figma's manifest takes "localhost" and not 127.0.0.1).
  const out = new URL(u.pathname + u.search, box);
  return out.href.replace(/\/$/, "");
}

/** Checks what a box's /config.json says: a self-hosted box, everything on the box's own origin. */
export function parseBoxConfig(body: unknown, box: URL): BoxConfig {
  const c = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (c.mode !== "selfhost")
    throw new Error(
      `${box.origin} is not a self-hosted CoDesignFlo box (its config.json says mode ${JSON.stringify(printable(c.mode ?? "(none)", 40))}, not "selfhost")`,
    );
  if (typeof c.anon !== "string" || !/^[A-Za-z0-9._-]{16,4096}$/.test(c.anon))
    throw new Error("the box's config.json has no valid anon key");
  return {
    mode: "selfhost",
    origin: box.origin,
    url: onBox(c.url, box, "service URL (url)"),
    anon: c.anon,
    web: c.web === undefined ? box.origin : onBox(c.web, box, "web address (web)"),
    mcpUrl: c.mcpUrl === undefined ? `${box.origin}/mcp` : onBox(c.mcpUrl, box, "MCP address (mcpUrl)"),
  };
}

/** Fetches and checks <box>/config.json. Redirects aren't followed: the config has to come from the box itself. */
export async function fetchBoxConfig(input: string, fetchImpl: typeof fetch = fetch): Promise<BoxConfig> {
  const box = boxOrigin(input);
  let r: Response;
  try {
    r = await fetchImpl(`${box.origin}/config.json`, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    throw new Error(
      `couldn't reach ${box.origin}/config.json (${printable((e as Error).message, 120)}): is the box running, and is this the address its team uses?`,
    );
  }
  if (!r.ok) throw new Error(`${box.origin}/config.json answered ${r.status}: is this a CoDesignFlo box?`);
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    throw new Error(`${box.origin}/config.json isn't JSON: is this a CoDesignFlo box?`);
  }
  return parseBoxConfig(body, box);
}

// ---- the Figma plugin for a box ----

/** The template's placeholders (as packages/plugin/scripts/build.mjs puts them in dist/code.js). */
export const PLACEHOLDER = {
  url: "__CODESIGNFLO_SELFHOST_URL__",
  anon: "__CODESIGNFLO_SELFHOST_ANON__",
  web: "__CODESIGNFLO_SELFHOST_WEB__",
} as const;
const PLACEHOLDER_STEM = "__CODESIGNFLO_SELFHOST_";

/** The plugin's id in Figma for a box: its own per box, so its sign-in is kept apart from other CoDesignFlo plugins. */
export const pluginId = (origin: string) => `codesignflo-selfhost-${createHash("sha256").update(origin).digest("hex").slice(0, 10)}`;

/** The domains the plugin may reach: the box (API and its realtime socket) and the CLI on this machine. */
export function allowedDomains(cfg: BoxConfig): string[] {
  const out = new Set<string>();
  for (const a of [cfg.origin, cfg.url, cfg.web]) {
    const u = new URL(a);
    out.add(u.origin);
    out.add(`${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`);
  }
  out.add("ws://localhost:4517");
  return [...out];
}

/** The plugin template shipped in the npm package (plugin-template/ beside dist/), or CODESIGNFLO_PLUGIN_TEMPLATE. */
export function findTemplate(): string {
  const env = process.env.CODESIGNFLO_PLUGIN_TEMPLATE;
  if (env) return env;
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++, d = dirname(d))
    if (existsSync(join(d, "plugin-template", "template.json"))) return join(d, "plugin-template");
  throw new Error("this codesignflo has no Figma plugin template (a development build): use the npm package, npx @codesignflo/cli@latest");
}

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)).map((g) => join(f, g)) : [f]));

/**
 * Writes the plugin for `cfg` into `out` (and `out`.zip): the template's dist/ with the box's service filled in,
 * and a manifest of its own (id, name, the box's domains). An existing folder is refreshed in place (only one made
 * by this command), so Figma picks the new version up without importing it again.
 */
export function writePlugin(
  cfg: BoxConfig,
  out: string,
  template = findTemplate(),
  /** How to update it, for INSTALL.md (default: run this command again). */
  updates = `run \`codesignflo plugin build --server ${cfg.origin}\` again into the same folder. No re-import needed.`,
): { dir: string; zip: string; manifest: Record<string, unknown>; version: string } {
  const meta = JSON.parse(readFileSync(join(template, "template.json"), "utf8")) as {
    version: string;
    placeholder: Record<string, string>;
  };
  for (const [k, v] of Object.entries(PLACEHOLDER))
    if (meta.placeholder[k] !== v) throw new Error(`the plugin template's placeholder for ${k} isn't the one this CLI fills in`);
  const dir = resolve(out);
  if (existsSync(dir) && readdirSync(dir).length) {
    const old = join(dir, "manifest.json");
    const id = existsSync(old) ? (JSON.parse(readFileSync(old, "utf8")) as { id?: string }).id : undefined;
    if (!id?.startsWith("codesignflo-selfhost"))
      throw new Error(`${dir} exists and isn't a CoDesignFlo plugin built by this command: pick another --out`);
    rmSync(join(dir, "dist"), { recursive: true, force: true });
  }
  mkdirSync(join(dir, "dist"), { recursive: true });
  // JSON string literals: the placeholders sit in the bundle as "…" strings, replaced whole (quotes included).
  const values: Record<string, string> = { url: cfg.url, anon: cfg.anon, web: cfg.web };
  let filled = 0;
  for (const f of files(join(template, "dist"))) {
    let text = readFileSync(join(template, "dist", f), "utf8");
    for (const [k, v] of Object.entries(PLACEHOLDER)) {
      const quoted = JSON.stringify(v);
      if (text.includes(quoted)) filled++;
      // split/join, not replace: a replacement string would expand "$&" and the like.
      text = text.split(quoted).join(JSON.stringify(values[k]!).replace(/</g, "\\u003c"));
    }
    if (text.includes(PLACEHOLDER_STEM)) throw new Error(`the plugin template's ${f} has a placeholder this CLI doesn't know`);
    mkdirSync(dirname(join(dir, "dist", f)), { recursive: true });
    writeFileSync(join(dir, "dist", f), text);
  }
  if (filled < Object.keys(PLACEHOLDER).length) throw new Error("the plugin template has no service placeholder to fill in");
  const host = new URL(cfg.origin).host;
  const manifest = JSON.parse(readFileSync(join(template, "manifest.json"), "utf8")) as Record<string, unknown> & {
    networkAccess: Record<string, unknown>;
  };
  manifest.id = pluginId(cfg.origin);
  manifest.name = `CoDesignFlo (${host})`;
  const domains = allowedDomains(cfg);
  manifest.networkAccess = {
    ...manifest.networkAccess,
    allowedDomains: domains,
    reasoning: `Connects to the CoDesignFlo CLI on the developer's own machine (localhost) and to the team's own CoDesignFlo server at ${host} to share the designer's proposals with their team.`,
  };
  // Figma treats plain-http addresses as development ones: list them there too.
  if (new URL(cfg.origin).protocol === "http:") manifest.networkAccess.devAllowedDomains = domains;
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(dir, "INSTALL.md"),
    `# Installing the CoDesignFlo plugin for ${host} (Figma desktop)

1. Keep this folder somewhere permanent (e.g. \`Documents/CoDesignFlo-${host.replace(/[^\w.-]/g, "-")}\`). Don't move it afterwards.
2. In the **Figma desktop app**, open any design file → menu **Plugins → Development → Import plugin from manifest…** → choose \`manifest.json\` in this folder.
3. Run it from **Plugins → Development → ${manifest.name}**. Sign in opens ${cfg.web}.

**Updates:** ${updates}
The plugin only runs in the Figma desktop app (macOS or Windows), not in Figma in a browser.
`,
  );
  const notices = [join(template, "THIRD_PARTY.md"), join(template, "..", "THIRD_PARTY.md")].find(existsSync);
  if (notices) cpSync(notices, join(dir, "THIRD_PARTY.md"));
  const zip = `${dir.replace(/[\\/]$/, "")}.zip`;
  writeZip(
    zip,
    files(dir).map((f) => ({ name: `CoDesignFlo/${f.split(sep).join("/")}`, data: readFileSync(join(dir, f)) })),
  );
  return { dir, zip, manifest, version: meta.version };
}

/** A folder name for a box: codesignflo-plugin-<host>. */
export const defaultOut = (origin: string) => `codesignflo-plugin-${new URL(origin).host.replace(/[^\w.-]/g, "-")}`;

// ---- a small zip writer (deflate), so no `zip` command is needed ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function writeZip(path: string, entries: { name: string; data: Buffer }[]) {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // 1 Jan 2026 00:00 (DOS time): the same bytes for the same files.
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...parts, dir, end]));
}

/** For messages: a path relative to here when it's inside. */
export const shown = (p: string) => {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
};
