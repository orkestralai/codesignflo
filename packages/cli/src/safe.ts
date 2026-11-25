// Checks on strings that come from outside this machine (the service, the Figma plugin, commit messages)
// before they become file paths, git arguments, service addresses or terminal output.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * One path segment: a component or page key ("product-card", "pages.cart-page", see keyOfTitle), a claim id
 * ("cmuy9vmkc"), a generation. No separators, nothing that climbs ("." / ".."), no control characters.
 */
export const isSegment = (s: unknown): s is string => typeof s === "string" && /^[\w.@-]{1,200}$/.test(s) && s !== "." && s !== "..";

export function segment(s: unknown, what: string): string {
  if (!isSegment(s)) throw new Error(`unexpected ${what} ${JSON.stringify(String(s).slice(0, 80))}: not a name CoDesignFlo makes`);
  return s;
}

/** `base/…segments`, each a safe segment, and the result still inside `base`. */
export function inside(base: string, segments: { value: unknown; what: string }[]): string {
  const p = join(base, ...segments.map((s) => segment(s.value, s.what)));
  const rel = relative(resolve(base), resolve(p));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`refusing a path outside ${base}`);
  return p;
}

/** A proposal's folder: <codesignflo dir>/proposals/<component>/<claim>. */
export const proposalFolder = (codesignfloDir: string, component: unknown, claim: unknown) =>
  inside(join(codesignfloDir, "proposals"), [
    { value: component, what: "component" },
    { value: claim, what: "proposal id" },
  ]);

/** Project ids: "p_" + 12 hex from init or the service; older and test ids are other short words, never paths. */
export const isProjectId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
export function projectId(s: unknown): string {
  if (!isProjectId(s)) throw new Error(`unexpected project id ${JSON.stringify(String(s).slice(0, 80))}`);
  return s;
}

/** A commit id (abbreviated or full SHA-1/SHA-256): anything else never reaches git's arguments. */
export const isCommit = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{4,64}$/i.test(s);

/**
 * A branch name git accepts (`git check-ref-format --branch` rules), and never one that reads as an option:
 * no leading "-", no "..", ":", whitespace, control characters, ~^?*[\, "@{", no "." at a component's start,
 * no ".lock" at its end, no empty component.
 */
export function isBranchName(s: unknown): s is string {
  if (typeof s !== "string" || !s || s.length > 255) return false;
  if (s.startsWith("-") || s === "@" || s === "HEAD") return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(s) || s.includes("..") || s.includes("@{")) return false;
  if (s.endsWith("/") || s.endsWith(".") || s.startsWith("/")) return false;
  return s.split("/").every((c) => c && !c.startsWith(".") && !c.endsWith(".lock"));
}
export function branchName(s: unknown): string {
  if (!isBranchName(s)) throw new Error(`not a branch name git accepts: ${JSON.stringify(String(s).slice(0, 80))}`);
  return s;
}

/** Text from someone else, made safe to print in a terminal: no control, escape or bidi characters; short. */
export const printable = (s: unknown, max = 120): string => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// ---- the service's addresses: a one-time code or ticket is only exchanged with CoDesignFlo itself ----

/**
 * Where the CoDesignFlo service runs. The web app and the hosted MCP (prod: codesignflo.com,
 * codesignflo.vercel.app; dev: codesignflo-dev.vercel.app) and their Supabase projects (service/prod.json,
 * service/staging.json — a test checks they are listed). Plus this machine, for local development.
 */
export const TRUSTED_ORIGINS = [
  "https://codesignflo.com",
  "https://www.codesignflo.com",
  "https://mcp.codesignflo.com",
  "https://codesignflo.vercel.app",
  "https://codesignflo-dev.vercel.app",
  "https://vgyurviruwhuaqakoxfx.supabase.co",
  "https://ewesoiejxkhxkykatewq.supabase.co",
];

/**
 * The self-hosted box this person connected to: `codesignflo connect <box>` writes ~/.codesignflo/trusted-origins.json
 * and nothing else does — no answer from the network adds an origin (the service, an MCP or a ticket only ever
 * name addresses that must already be trusted).
 */
export const trustedOriginsFile = () => join(homedir(), ".codesignflo", "trusted-origins.json");

export function savedTrustedOrigins(file = trustedOriginsFile()): string[] {
  if (!existsSync(file)) return [];
  try {
    const { origins } = JSON.parse(readFileSync(file, "utf8")) as { origins?: unknown };
    // Only whole origins (scheme://host[:port]) count: anything else in the file is ignored.
    return Array.isArray(origins)
      ? origins.filter((o): o is string => {
          if (typeof o !== "string") return false;
          try {
            const u = new URL(o);
            return (u.protocol === "https:" || u.protocol === "http:") && u.origin === o;
          } catch {
            return false;
          }
        })
      : [];
  } catch {
    return [];
  }
}

/**
 * Is this URL CoDesignFlo's service (or this machine)? Self-hosting adds origins: the box `codesignflo connect`
 * was run for (savedTrustedOrigins), and CODESIGNFLO_TRUSTED_ORIGINS.
 */
export function isTrustedServiceUrl(url: unknown, env: NodeJS.ProcessEnv = process.env, saved: string[] = savedTrustedOrigins()): boolean {
  if (typeof url !== "string") return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if ((u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
  const extra = (env.CODESIGNFLO_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return [...TRUSTED_ORIGINS, ...extra, ...saved].includes(u.origin);
}

export function trustedServiceUrl(url: unknown, what: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isTrustedServiceUrl(url, env))
    throw new Error(
      `${what} ${JSON.stringify(printable(url, 100))} is not a CoDesignFlo address (${TRUSTED_ORIGINS[0]}, or localhost for development) — refusing to send a sign-in code there. Self-hosting: run codesignflo connect <your box's URL> (or add its origin to CODESIGNFLO_TRUSTED_ORIGINS).`,
    );
  return url as string;
}
