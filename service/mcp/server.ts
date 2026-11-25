// The hosted CoDesignFlo MCP: `claude mcp add --transport http codesignflo <base>/mcp`. Streamable HTTP,
// stateless (each request stands alone, so it runs as a serverless function too), behind OAuth sign-in.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import cliPackage from "../../packages/cli/package.json" with { type: "json" };
import { type BillingConfig, checkout, confirm, portal, refresh, syncSeats, webhook } from "./billing.ts";
import { alexTick } from "./alex.ts";
import { quitDemo, startDemo } from "./demo.ts";
import { canEmail, drain, type NotifyConfig, sendMail } from "./notify.ts";
import { referralTick } from "./referrals.ts";
import {
  admin,
  authorizationServer,
  authorize,
  type Config,
  cleanupNow,
  clientIp,
  protectedResource,
  readBody,
  redirectTarget,
  register,
  token,
  unauthorized,
} from "./oauth.ts";
import { server as mcpServer } from "./tools.ts";

export type ServerConfig = Config & {
  cli: string;
  cliEnv: Record<string, string>;
  /** Shared with the database (app_config.notify_secret) and any cron: who may trigger sending notifications. */
  notifySecret?: string;
  /** Vercel Cron's secret (sent as a bearer token), the other way to trigger sending. */
  cronSecret?: string;
  notify?: Omit<NotifyConfig, "web">;
  /** Stripe (payments); without a secret key, billing is off. */
  billing?: BillingConfig;
  /**
   * A self-hosted box (CODESIGNFLO_MODE=selfhost): no billing (its endpoints answer 404, Stripe and referrals
   * never run), and emails only when SMTP is set up.
   */
  selfhost?: boolean;
};

/** What a billing address answers on a self-hosted box. */
const NO_BILLING = { error: "not_available", message: "billing is not available in self-hosted mode" };

export async function handle(cfg: ServerConfig, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", cfg.base);
  const path = url.pathname.replace(/\/$/, "") || "/";
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
  res.setHeader("access-control-expose-headers", "www-authenticate, mcp-session-id");
  res.setHeader("x-content-type-options", "nosniff");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  const json = (body: unknown) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

  if (path.startsWith("/.well-known/oauth-protected-resource")) return json(protectedResource(cfg));
  if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration"))
    return json(authorizationServer(cfg));
  if (path === "/register" && req.method === "POST") return register(cfg, JSON.parse((await readBody(req)) || "{}"), res, clientIp(req));
  if (path === "/authorize" && req.method === "GET") return authorize(cfg, url, res);
  if (path === "/api/mcp-request" && req.method === "GET") return mcpRequestInfo(cfg, url.searchParams.get("id") ?? "", res);
  if (path === "/token" && req.method === "POST") return token(cfg, new URLSearchParams(await readBody(req)), res);
  if (path === "/install-code" && req.method === "POST") return redeemInstallCode(cfg, JSON.parse((await readBody(req)) || "{}"), res);
  if (path === "/ticket" && req.method === "POST") return redeemTicket(cfg, JSON.parse((await readBody(req)) || "{}"), res);
  if (path === "/api/notify" && (req.method === "POST" || req.method === "GET")) return sendNotifications(cfg, req, res);
  if (cfg.selfhost && (path === "/api/stripe/webhook" || path.startsWith("/api/billing/"))) return reply(res, 404, NO_BILLING);
  if (path === "/api/stripe/webhook" && req.method === "POST")
    return webhook(billingOf(cfg), admin(cfg), await readBody(req), String(req.headers["stripe-signature"] ?? ""), res);
  // The plugin's "Try a demo" and "Quit demo", signed in: its access token.
  if ((path === "/api/demo/start" || path === "/api/demo/quit" || path === "/api/demo/tick") && req.method === "POST") {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const { data } = bearer ? await admin(cfg).auth.getUser(bearer) : { data: { user: null } };
    if (!data.user) return reply(res, 401, { error: "sign in first" });
    const what = path.slice("/api/demo/".length) as "start" | "quit" | "tick";
    if (!demoAllowed(data.user.id, what)) return reply(res, 429, { error: "too many demo requests — try again in a few minutes" });
    try {
      if (what === "tick") return reply(res, 200, await alexTick(admin(cfg), data.user.id));
      if (what === "quit") return reply(res, 200, { quit: await quitDemo(admin(cfg), data.user.id) });
      const started = await startDemo(admin(cfg), data.user.id);
      if (started.fresh) demoStarted(data.user.id);
      return reply(res, 200, started);
    } catch (e) {
      console.error(`demo ${what}:`, e);
      return reply(res, 500, { error: `couldn't ${what === "quit" ? "quit" : "run"} the demo — try again in a moment` });
    }
  }
  if ((path === "/api/billing/checkout" || path === "/api/billing/portal") && req.method === "POST") {
    // The web app, signed in: its Supabase access token.
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const { data } = bearer ? await admin(cfg).auth.getUser(bearer) : { data: { user: null } };
    if (!data.user) return reply(res, 401, { error: "sign in first" });
    return path.endsWith("checkout")
      ? checkout(cfg.billing ?? {}, admin(cfg), data.user, cfg.web, res)
      : portal(cfg.billing ?? {}, admin(cfg), data.user.id, cfg.web, res);
  }
  if (path === "/api/billing/refresh" && req.method === "POST") {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const { data } = bearer ? await admin(cfg).auth.getUser(bearer) : { data: { user: null } };
    if (!data.user) return reply(res, 401, { error: "sign in first" });
    try {
      return await refresh(billingOf(cfg), admin(cfg), data.user.id, res);
    } catch (e) {
      console.error("billing refresh:", e);
      return reply(res, 502, { error: "couldn't check your subscription — try again in a moment" });
    }
  }
  if (path === "/api/billing/confirm" && req.method === "POST") {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const { data } = bearer ? await admin(cfg).auth.getUser(bearer) : { data: { user: null } };
    if (!data.user) return reply(res, 401, { error: "sign in first" });
    const body = JSON.parse((await readBody(req)) || "{}") as { session?: string };
    try {
      return await confirm(billingOf(cfg), admin(cfg), data.user.id, String(body.session ?? ""), res);
    } catch (e) {
      console.error("billing confirm:", e);
      return reply(res, 502, { error: "couldn't confirm your payment yet — try again in a moment" });
    }
  }

  if (path === "/mcp") {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer) return unauthorized(cfg, res);
    const client = createClient(cfg.supabaseUrl, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data, error } = await client.auth.getUser(bearer);
    if (error || !data.user) return unauthorized(cfg, res);
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
    const body = JSON.parse((await readBody(req)) || "null");
    const server = mcpServer({
      client,
      ticket: (project) => makeTicket(cfg, data.user.id, project, bearer),
      cli: cfg.cli,
      cliEnv: cfg.cliEnv,
      email: data.user.email ?? null,
      web: cfg.web,
      // Only a self-hosted box says it has no emails (the cloud's answers stay as they are).
      emails: cfg.selfhost ? canEmail({ web: cfg.web, ...cfg.notify }) : undefined,
      installCode: (email) => makeInstallCode(cfg, data.user.id, email),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("CoDesignFlo MCP: connect your coding agent to /mcp");
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A secret compared in constant time (hashed first: equal lengths whatever was sent). */
const sameSecret = (given: string, secret?: string) =>
  !!secret && timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(secret).digest());

/**
 * The guided demo, per person (this server's memory: a cheap brake, not an exact count across servers): at most
 * DEMO_CALLS_PER_MIN calls a minute, and DEMO_STARTS_PER_HOUR fresh demos (each a project and its pictures) an hour.
 */
const DEMO_CALLS_PER_MIN = 60;
const DEMO_STARTS_PER_HOUR = 6;
const demoCalls = new Map<string, number[]>();
const demoStarts = new Map<string, number[]>();
const recent = (m: Map<string, number[]>, key: string, ms: number) => {
  const now = Date.now();
  const list = (m.get(key) ?? []).filter((t) => now - t < ms);
  m.set(key, list);
  if (m.size > 10_000) for (const [k, v] of m) if (!v.some((t) => now - t < ms)) m.delete(k);
  return list;
};
function demoAllowed(userId: string, what: "start" | "quit" | "tick"): boolean {
  const calls = recent(demoCalls, userId, 60_000);
  if (calls.length >= DEMO_CALLS_PER_MIN) return false;
  calls.push(Date.now());
  return what !== "start" || recent(demoStarts, userId, 3600_000).length < DEMO_STARTS_PER_HOUR;
}
const demoStarted = (userId: string) => recent(demoStarts, userId, 3600_000).push(Date.now());

/**
 * What the sign-in page shows about a coding agent's request before the person approves it: the name the
 * client gave itself (anyone can pick any name) and where the sign-in would go (checked here, not taken from
 * the page's address, which anyone can write).
 */
async function mcpRequestInfo(cfg: ServerConfig, id: string, res: ServerResponse) {
  if (!/^[0-9a-f]{36}$/.test(id)) return reply(res, 404, { error: "this link expired — connect again from your coding agent" });
  const { data: r } = await admin(cfg)
    .from("mcp_auth_requests")
    .select("redirect_uri, code, created_at, mcp_clients(name)")
    .eq("id", id)
    .maybeSingle();
  const target = r ? redirectTarget(r.redirect_uri as string) : null;
  if (!r || r.code || Date.now() - Date.parse(r.created_at as string) > 15 * 60_000 || !target)
    return reply(res, 404, { error: "this link expired — connect again from your coding agent" });
  const client = r.mcp_clients as { name: string | null } | { name: string | null }[] | null;
  const name = (Array.isArray(client) ? client[0]?.name : client?.name) ?? null;
  return reply(res, 200, { client_name: name, to: target });
}
const reply = (res: ServerResponse, status: number, b: unknown) =>
  void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(b));

/**
 * A one-time ticket (10 minutes) for the command `sync` hands the agent: the CLI exchanges it once at /ticket
 * for this person's sign-in and the service's address. What stays in the transcript is a used ticket.
 * Returns the environment to put in front of the command.
 */
async function makeTicket(cfg: ServerConfig, userId: string, project: string, accessToken: string): Promise<string> {
  cleanupNow(cfg);
  const code = `cdft_${randomBytes(24).toString("hex")}`;
  const { error } = await admin(cfg).from("cli_tickets").insert({ code_hash: sha(code), user_id: userId, project_id: project, access_token: accessToken });
  if (error) throw new Error("couldn't make a ticket for the command");
  return `CODESIGNFLO_TICKET=${code} CODESIGNFLO_MCP=${cfg.base}`;
}

/** Redeems a ticket once (the first caller wins): the sign-in, its project and where the service is. */
async function redeemTicket(cfg: ServerConfig, body: { ticket?: string }, res: ServerResponse) {
  const { data } = await admin(cfg).rpc("redeem_cli_ticket", { p_hash: sha(body.ticket ?? "") });
  const row = ((data ?? []) as { access_token: string | null; project_id: string }[])[0];
  if (!row?.access_token) return reply(res, 400, { error: "this command's ticket is used or expired — call sync again for a fresh command" });
  return reply(res, 200, {
    access_token: row.access_token,
    project: row.project_id,
    service: { url: cfg.supabaseUrl, anon: cfg.anonKey, web: cfg.web },
  });
}

let lastPersonDrain = 0;
let lastReferralTick = 0;
/**
 * Sends waiting notifications. Called by the database (pg_net, with the shared secret) or a cron (its secret)
 * — and by a signed-in person right after inviting someone, so the invitation leaves at once even where the
 * database can't ping (sending only what's already queued; at most every 3 seconds per server).
 */
async function sendNotifications(cfg: ServerConfig, req: IncomingMessage, res: ServerResponse) {
  const given = String(req.headers["x-codesignflo-secret"] ?? "") || (/^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "");
  const secret = !!given && (sameSecret(given, cfg.notifySecret) || sameSecret(given, cfg.cronSecret));
  if (!secret) {
    const { data } = given ? await admin(cfg).auth.getUser(given) : { data: { user: null } };
    if (!data.user) return reply(res, 401, { error: "unauthorized" });
    if (Date.now() - lastPersonDrain < 3000) return reply(res, 202, { queued: true });
    lastPersonDrain = Date.now();
  }
  const r = await drain(admin(cfg), { web: cfg.web, mcp: `${cfg.base}/mcp`, ...cfg.notify, selfhost: cfg.selfhost });
  // A self-hosted box has no billing: no seats to sync with Stripe, no referrals.
  if (cfg.selfhost) return reply(res, 200, { ...r, seats: 0 });
  // Designers joined or left (the database pings this too): the seats billed follow.
  const seats = secret ? await syncSeats(cfg.billing ?? {}, admin(cfg)).catch(() => ({ updated: 0 })) : { updated: 0 };
  // Referrals (missed webhooks, banked months, expiry): on the daily cron, and at most every 10 minutes otherwise.
  if (secret && (sameSecret(given, cfg.cronSecret) || Date.now() - lastReferralTick > 10 * 60_000)) {
    lastReferralTick = Date.now();
    await referralTick(billingOf(cfg), admin(cfg)).catch((e) => console.error("referrals:", e));
  }
  return reply(res, 200, { ...r, seats: seats.updated });
}

/**
 * A one-time code (10 minutes) for this person's machine: a fresh sign-in of theirs, made server-side
 * (magic link, never sent), handed over when the hook-install command redeems the code.
 */
async function makeInstallCode(cfg: ServerConfig, userId: string, email: string): Promise<string> {
  const db = admin(cfg);
  const { data: link, error } = await db.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !link.properties?.hashed_token) throw new Error("couldn't make a sign-in for this machine");
  const anon = createClient(cfg.supabaseUrl, cfg.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: e } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
  if (e || !s.session) throw new Error("couldn't make a sign-in for this machine");
  const code = `cdfi_${randomBytes(24).toString("hex")}`;
  const { error: e2 } = await db.from("install_codes").insert({ code_hash: sha(code), user_id: userId, refresh_token: s.session.refresh_token });
  if (e2) throw new Error("couldn't make a sign-in for this machine");
  return `${cfg.cli} hook install --code ${code} --from ${cfg.base}`;
}

/** Redeems an install code once: this machine's sign-in and where the service is. */
async function redeemInstallCode(cfg: ServerConfig, body: { code?: string }, res: ServerResponse) {
  const json = (status: number, b: unknown) => void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(b));
  const db = admin(cfg);
  const { data: row } = await db.from("install_codes").select("code_hash, refresh_token, used_at, created_at").eq("code_hash", sha(body.code ?? "")).maybeSingle();
  if (!row || row.used_at || !row.refresh_token || Date.now() - Date.parse(row.created_at) > 10 * 60_000)
    return json(400, { error: "this code is used or expired — ask the agent for auto_update again" });
  // One use, whoever asks first (a single conditional update).
  const { data: won } = await db
    .from("install_codes")
    .update({ used_at: new Date().toISOString(), refresh_token: null })
    .eq("code_hash", row.code_hash)
    .is("used_at", null)
    .select("code_hash");
  if (!won?.length) return json(400, { error: "this code is used or expired — ask the agent for auto_update again" });
  return json(200, { refresh_token: row.refresh_token, service: { url: cfg.supabaseUrl, anon: cfg.anonKey, web: cfg.web } });
}

/** Configuration from the environment (deployment), see dev.ts for local development. */
export function configFromEnv(env = process.env): ServerConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  // One deployment serves the web app and the MCP (Vercel: its production address unless PUBLIC_URL says).
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined;
  const base = (env.MCP_PUBLIC_URL ?? env.PUBLIC_URL ?? vercel ?? need("PUBLIC_URL")).replace(/\/$/, "");
  const selfhost = env.CODESIGNFLO_MODE === "selfhost";
  const smtp = smtpFromEnv(env);
  return {
    base,
    web: (env.CODESIGNFLO_WEB_URL ?? env.PUBLIC_URL ?? base).replace(/\/$/, ""),
    supabaseUrl: need("SUPABASE_URL"),
    anonKey: need("SUPABASE_ANON_KEY"),
    serviceKey: need("SUPABASE_SERVICE_ROLE_KEY"),
    // The CLI released from the same commit, not @latest: a new release reaches developers when the service
    // that goes with it is deployed. CODESIGNFLO_CLI overrides it (e.g. to roll back to an older version).
    cli: env.CODESIGNFLO_CLI ?? `npx -y @codesignflo/cli@${cliPackage.version}`,
    cliEnv: {},
    notifySecret: env.NOTIFY_SECRET,
    cronSecret: env.CRON_SECRET,
    notify: {
      smtp,
      resendKey: env.RESEND_API_KEY,
      // A self-hosted box with SMTP but no sender set: its SMTP account sends.
      from: env.NOTIFY_FROM ?? env.EMAIL_FROM ?? (selfhost && smtp?.user?.includes("@") ? `CoDesignFlo <${smtp.user}>` : undefined),
      // CoDesignFlo's web app and a self-hosted box both serve the plugin at /plugin.zip.
      pluginUrl: env.PLUGIN_INSTALL_URL ?? `${(env.CODESIGNFLO_WEB_URL ?? env.PUBLIC_URL ?? base).replace(/\/$/, "")}/plugin.zip`,
    },
    // Never Stripe on a self-hosted box, whatever its environment holds.
    billing: selfhost
      ? {}
      : { secretKey: clean(env.STRIPE_SECRET_KEY), webhookSecret: clean(env.STRIPE_WEBHOOK_SECRET), priceLookup: clean(env.STRIPE_PRICE_LOOKUP) },
    ...(selfhost ? { selfhost: true } : {}),
  };
}

/** A pasted secret as meant: no spaces, line breaks or quotes around it (a stray newline failed every webhook). */
const clean = (v?: string) => v?.trim().replace(/^["']|["']$/g, "").trim() || undefined;

/** Billing, with the service's email for the payment confirmation (when emails are set up). */
function billingOf(cfg: ServerConfig): BillingConfig {
  const n: NotifyConfig = { web: cfg.web, ...cfg.notify };
  return { ...cfg.billing, web: cfg.web, ...(canEmail(n) ? { mail: (m: { to: string[]; subject: string; text: string; html?: string }) => sendMail(n, m) } : {}) };
}

/** SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS (e.g. smtp.gmail.com, 465, true, an app password). */
export function smtpFromEnv(env: NodeJS.ProcessEnv): NotifyConfig["smtp"] {
  if (!env.SMTP_HOST) return undefined;
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === "true" : env.SMTP_PORT === "465";
  return { host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? (secure ? 465 : 587)), secure, user: env.SMTP_USER, pass: env.SMTP_PASS };
}

export function listen(cfg: ServerConfig, port: number) {
  return createServer((req, res) => {
    handle(cfg, req, res).catch((e: Error) => {
      console.error(`${req.method} ${req.url?.split("?")[0]}:`, e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "server_error", message: "something went wrong on our side — try again in a moment" }));
    });
  }).listen(port);
}
