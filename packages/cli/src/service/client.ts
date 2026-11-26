// The CoDesignFlo service (cloud mode): where it is, and the signed-in session (kept in the home folder,
// never in the repo).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { trustedOriginsFile, trustedServiceUrl } from "../safe.js";

/**
 * Where the service is. mode "selfhost": a team's own box (`codesignflo connect <box>`), with its origin and its
 * hosted MCP's address; absent on the cloud.
 */
export type ServiceConfig = { url: string; anon: string; web: string; mode?: "cloud" | "selfhost"; box?: string; mcpUrl?: string };

/** CoDesignFlo's cloud service (service/prod.json; a test checks they match): what `connect --cloud` goes back to. */
export const HOSTED: ServiceConfig = {
  url: "https://vgyurviruwhuaqakoxfx.supabase.co",
  anon: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZneXVydmlydXdodWFxYWtveGZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5OTAwMzUsImV4cCI6MjEwNzU2NjAzNX0.6cy8La_Oc92hTD-M5AlCdZGIWp2iOlWMfu5BdTnxfZg",
  web: "https://codesignflo.com",
};

const home = join(homedir(), ".codesignflo");
const sessionFile = join(home, "session.json");

/** Service location: env (development), ~/.codesignflo/service.json, or the hosted default. */
export function serviceConfig(): ServiceConfig {
  const env = process.env;
  if (env.CODESIGNFLO_SERVICE_URL && env.CODESIGNFLO_SERVICE_ANON)
    return {
      url: env.CODESIGNFLO_SERVICE_URL,
      anon: env.CODESIGNFLO_SERVICE_ANON,
      web: env.CODESIGNFLO_SERVICE_WEB ?? "https://codesignflo.com",
    };
  const file = join(home, "service.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as ServiceConfig;
  throw new Error("the CoDesignFlo service isn't configured yet (set CODESIGNFLO_SERVICE_URL and CODESIGNFLO_SERVICE_ANON)");
}

/** The saved service (~/.codesignflo/service.json), if any; the environment's isn't looked at. */
export function savedService(): ServiceConfig | null {
  const file = join(home, "service.json");
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ServiceConfig) : null;
  } catch {
    return null;
  }
}

/** The service in use is a self-hosted box (env first, as serviceConfig): its config, else null. */
export function selfhostService(): ServiceConfig | null {
  if (process.env.CODESIGNFLO_SERVICE_URL && process.env.CODESIGNFLO_SERVICE_ANON) return null;
  const s = savedService();
  return s?.mode === "selfhost" ? s : null;
}

/**
 * The origins `codesignflo connect` trusts from now on (replacing the previous box's; [] = the cloud's only).
 * Only that command calls this: the user typed the address.
 */
export function saveTrustedOrigins(origins: string[]) {
  ensureHome();
  const file = trustedOriginsFile();
  if (!origins.length) rmSync(file, { force: true });
  else {
    writeFileSync(file, `${JSON.stringify({ origins }, null, 2)}\n`, { mode: 0o600 });
    // mode applies only to a new file: an existing one is made private too.
    chmodSync(file, 0o600);
  }
}

/** Remembers where the service is, for commands that run on their own later (the git hook). */
export function saveService(c: ServiceConfig) {
  ensureHome();
  const file = join(home, "service.json");
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** ~/.codesignflo: this person's sign-in and pairings, readable by them only. */
export function ensureHome(dir = home) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not ours to change (a shared mount): the files themselves are 0600
  }
}

export const anonClient = (c = serviceConfig()) =>
  createClient(c.url, c.anon, { auth: { persistSession: false, autoRefreshToken: false } });

export function saveSession(refreshToken: string, user: { id: string; email?: string | null }) {
  ensureHome();
  writeFileSync(sessionFile, JSON.stringify({ refresh_token: refreshToken, user }, null, 2), { mode: 0o600 });
  chmodSync(sessionFile, 0o600);
}

export function forgetSession() {
  rmSync(sessionFile, { force: true });
}

/** Signed in on this machine (a saved session, not only a token handed to one command). */
export const hasSession = () => existsSync(sessionFile);

/** A ticket's sign-in, redeemed once per process (a command signs in several times; the ticket works once). */
let fromTicket: Promise<{ token: string; project: string }> | null = null;

/**
 * The hosted MCP hands the agent a command with a one-time ticket (CODESIGNFLO_TICKET, and where to redeem it:
 * CODESIGNFLO_MCP). Redeeming it gives this person's short-lived sign-in and where the service is; nothing is
 * saved.
 */
function redeemTicket(ticket: string, mcp: string) {
  fromTicket ??= (async () => {
    // The ticket is a sign-in: it goes only to CoDesignFlo's own MCP, and only CoDesignFlo's service is used after.
    trustedServiceUrl(mcp, "CODESIGNFLO_MCP");
    const r = await fetch(`${mcp.replace(/\/$/, "")}/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    const body = (await r.json().catch(() => ({}))) as { access_token?: string; project?: string; service?: ServiceConfig; error?: string };
    if (!r.ok || !body.access_token || !body.service || !body.project)
      throw new Error(body.error ?? "this command's ticket couldn't be used — call sync again for a fresh command");
    trustedServiceUrl(body.service.url, "the service address the ticket gave");
    if (body.service.web) trustedServiceUrl(body.service.web, "the web address the ticket gave");
    process.env.CODESIGNFLO_SERVICE_URL = body.service.url;
    process.env.CODESIGNFLO_SERVICE_ANON = body.service.anon;
    process.env.CODESIGNFLO_SERVICE_WEB = body.service.web;
    return { token: body.access_token, project: body.project };
  })();
  return fromTicket;
}

/** The project a ticket was made for (null without a ticket): a command checks it's run in that project's app. */
export async function ticketProject(): Promise<string | null> {
  const { CODESIGNFLO_TICKET: ticket, CODESIGNFLO_MCP: mcp } = process.env;
  return ticket && mcp ? (await redeemTicket(ticket, mcp)).project : null;
}

/**
 * A client signed in as the saved user (the refresh token rotates and is saved again) — or, when the hosted
 * MCP hands the agent a command to run, as the user of its one-time ticket (CODESIGNFLO_TICKET) or, from older
 * MCP servers, of a short-lived token (CODESIGNFLO_TOKEN). Nothing is saved for those.
 */
/**
 * This machine's own sign-in (login, or the git hook's), renewed and saved again; null without one. A command
 * run with a ticket uses it when the ticket's sign-in runs out (it can't be renewed): a sync waiting for Figma
 * stopped after a few minutes with "the sign-in for this command expired".
 */
export async function savedSignIn(): Promise<SupabaseClient | null> {
  if (!existsSync(sessionFile)) return null;
  const saved = JSON.parse(readFileSync(sessionFile, "utf8")) as { refresh_token: string };
  const client = anonClient();
  const { data, error } = await client.auth.refreshSession({ refresh_token: saved.refresh_token });
  if (error || !data.session || !data.user) return null;
  saveSession(data.session.refresh_token, { id: data.user.id, email: data.user.email ?? null });
  return client;
}

export async function signedIn(): Promise<{ client: SupabaseClient; user: { id: string; email?: string | null } }> {
  const { CODESIGNFLO_TICKET: ticket, CODESIGNFLO_MCP: mcp } = process.env;
  const token = ticket && mcp ? (await redeemTicket(ticket, mcp)).token : process.env.CODESIGNFLO_TOKEN;
  if (token) {
    const c = serviceConfig();
    const client = createClient(c.url, c.anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) throw new Error("the sign-in from the CoDesignFlo MCP expired — call sync again for a fresh command");
    return { client, user: { id: data.user.id, email: data.user.email ?? null } };
  }
  if (!existsSync(sessionFile)) throw new Error("not signed in — run: codesignflo login");
  const saved = JSON.parse(readFileSync(sessionFile, "utf8")) as { refresh_token: string };
  const client = anonClient();
  const { data, error } = await client.auth.refreshSession({ refresh_token: saved.refresh_token });
  if (error || !data.session || !data.user) throw new Error("your sign-in expired — run: codesignflo login");
  saveSession(data.session.refresh_token, { id: data.user.id, email: data.user.email ?? null });
  // Invitations to this email become memberships on the first signed-in command (no link to click).
  await client.rpc("accept_invitations");
  return { client, user: { id: data.user.id, email: data.user.email ?? null } };
}
