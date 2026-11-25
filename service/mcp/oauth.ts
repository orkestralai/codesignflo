// Sign-in for the hosted MCP, as MCP clients (Claude Code, Cursor…) expect it: OAuth 2.1 with discovery,
// dynamic client registration and PKCE. The person signs in on CoDesignFlo's sign-in page (GitHub or Figma)
// and approves; the client gets that session's tokens. No passwords pass through here.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Config = {
  /** This server's public base URL, e.g. https://mcp.codesignflo.com */
  base: string;
  /** The sign-in page. */
  web: string;
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;
};

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(JSON.stringify(body));

export const admin = (c: Config): SupabaseClient =>
  createClient(c.supabaseUrl, c.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

export const protectedResource = (c: Config) => ({
  resource: `${c.base}/mcp`,
  authorization_servers: [c.base],
  bearer_methods_supported: ["header"],
  resource_name: "CoDesignFlo",
});

export const authorizationServer = (c: Config) => ({
  issuer: c.base,
  authorization_endpoint: `${c.base}/authorize`,
  token_endpoint: `${c.base}/token`,
  registration_endpoint: `${c.base}/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
});

/** The 401 that tells an MCP client where to sign in. */
export function unauthorized(c: Config, res: ServerResponse) {
  json(res, 401, { error: "invalid_token", error_description: "sign in to CoDesignFlo" }, {
    "www-authenticate": `Bearer resource_metadata="${c.base}/.well-known/oauth-protected-resource"`,
  });
}

/** Registrations allowed per address per hour (each MCP client registers once per machine). */
const REGISTRATIONS_PER_HOUR = 20;
/** Sign-ins a client may start in 15 minutes (each leaves a row until it's approved or expires). */
const AUTHORIZES_PER_15_MIN = 30;

/**
 * Where a sign-in may be sent back to. A coding agent on the person's own computer listens on a loopback
 * address (Claude Code, Codex, Gemini CLI, VS Code, Cursor, Windsurf…), any port and path. Hosted agents only
 * at their own exact callbacks: anything else would let whoever registers a client receive a stranger's sign-in.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const KNOWN_CALLBACKS: Record<string, string> = {
  // Claude (claude.ai, Claude Desktop's connectors)
  "https://claude.ai/api/mcp/auth_callback": "Claude",
  "https://claude.com/api/mcp/auth_callback": "Claude",
  // VS Code in the browser (the desktop app uses a loopback address)
  "https://vscode.dev/redirect": "VS Code",
  "https://insiders.vscode.dev/redirect": "VS Code Insiders",
  // Cursor: its older custom scheme (desktop now uses http://localhost:8787/callback), and its cloud agents
  "cursor://anysphere.cursor-mcp/oauth/callback": "Cursor",
  "https://www.cursor.com/agents/mcp/oauth/callback": "Cursor",
};

/** Where a redirect address sends the sign-in: this computer (loopback), a known agent, or nowhere allowed. */
export function redirectTarget(uri: string): { kind: "loopback"; port: string } | { kind: "known"; name: string; host: string } | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash) return null;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return { kind: "loopback", port: u.port || "80" };
  if (u.search) return null;
  const exact = `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
  const name = KNOWN_CALLBACKS[exact];
  return name ? { kind: "known", name, host: u.protocol === "https:" ? u.host : `${u.protocol}//${u.host}` } : null;
}

let lastCleanup = 0;
/** Removes expired sign-in leftovers, at most every 5 minutes per server (pg_cron does it too where it runs). */
export function cleanupNow(c: Config) {
  if (Date.now() - lastCleanup < 5 * 60_000) return;
  lastCleanup = Date.now();
  void admin(c)
    .rpc("cleanup_expired")
    .then(
      () => undefined,
      () => undefined,
    );
}

/** The caller's address (first hop behind a proxy such as Vercel's). */
export const clientIp = (req: IncomingMessage) =>
  String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

/** Dynamic client registration (public clients, PKCE). Limited per address: anyone can call it. */
export async function register(c: Config, body: Record<string, unknown>, res: ServerResponse, ip = "unknown") {
  cleanupNow(c);
  const asked = Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string") : [];
  // Only the allowed ones are registered (a client may list several, e.g. Cursor's loopback and its own scheme).
  const uris = asked.filter((u) => u.length <= 500 && !!redirectTarget(u)).slice(0, 10);
  if (!uris.length)
    return json(res, 400, {
      error: "invalid_redirect_uri",
      error_description: "CoDesignFlo sends sign-ins only to a coding agent on this computer (http://localhost or 127.0.0.1) or a known agent's callback",
    });
  const client_id = `cdf_${randomBytes(16).toString("hex")}`;
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 80) : null;
  const db = admin(c);
  const { count } = await db
    .from("mcp_clients")
    .select("client_id", { count: "exact", head: true })
    .eq("ip", ip)
    .gt("created_at", new Date(Date.now() - 3600_000).toISOString());
  if ((count ?? 0) >= REGISTRATIONS_PER_HOUR)
    return json(res, 429, { error: "too_many_requests", error_description: "too many registrations from this address — try again later" });
  const { error } = await db.from("mcp_clients").insert({ client_id, name, redirect_uris: uris, ip });
  if (error) {
    console.error("register: couldn't save the client", error.message);
    return json(res, 500, { error: "server_error" });
  }
  json(res, 201, {
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: uris,
    ...(name ? { client_name: name } : {}),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

/** Starts a sign-in: remembers the request and sends the browser to the sign-in page. */
export async function authorize(c: Config, url: URL, res: ServerResponse) {
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirect = q.get("redirect_uri") ?? "";
  const { data: client } = await admin(c).from("mcp_clients").select("redirect_uris").eq("client_id", clientId).maybeSingle();
  // Without a known client and redirect, nothing can be sent back safely: answer here. (Checked again against
  // the allowed addresses: clients registered before they were narrowed down.)
  if (!client || !(client.redirect_uris as string[]).includes(redirect) || !redirectTarget(redirect))
    return void res.writeHead(400, { "content-type": "text/plain" }).end("Unknown app or redirect address. Connect again from your coding agent.");
  const back = (params: Record<string, string>) => {
    const u = new URL(redirect);
    for (const [k, v] of Object.entries({ ...params, ...(q.get("state") ? { state: q.get("state")! } : {}) })) u.searchParams.set(k, v);
    res.writeHead(302, { location: u.toString() }).end();
  };
  if (q.get("response_type") !== "code") return back({ error: "unsupported_response_type" });
  if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return back({ error: "invalid_request", error_description: "PKCE (S256) is required" });
  const { count } = await admin(c)
    .from("mcp_auth_requests")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .gt("created_at", new Date(Date.now() - 15 * 60_000).toISOString());
  if ((count ?? 0) >= AUTHORIZES_PER_15_MIN)
    return back({ error: "temporarily_unavailable", error_description: "too many sign-ins started — try again in a few minutes" });
  const id = randomBytes(18).toString("hex");
  await admin(c).from("mcp_clients").update({ last_used_at: new Date().toISOString() }).eq("client_id", clientId);
  const { error } = await admin(c)
    .from("mcp_auth_requests")
    .insert({ id, client_id: clientId, redirect_uri: redirect, code_challenge: q.get("code_challenge"), state: q.get("state") });
  if (error) {
    console.error("authorize: couldn't save the request", error.message);
    return back({ error: "server_error" });
  }
  res.writeHead(302, { location: `${c.web}/?mcp=${id}` }).end();
}

type Tokens = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string };

async function fromRefresh(c: Config, refresh: string): Promise<Tokens | null> {
  const sb = createClient(c.supabaseUrl, c.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.refreshSession({ refresh_token: refresh });
  if (error || !data.session) return null;
  return {
    access_token: data.session.access_token,
    token_type: "Bearer",
    expires_in: data.session.expires_in,
    refresh_token: data.session.refresh_token,
  };
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Code → tokens (checked against the PKCE verifier, once), and refresh. */
export async function token(c: Config, form: URLSearchParams, res: ServerResponse) {
  cleanupNow(c);
  const grant = form.get("grant_type");
  if (grant === "refresh_token") {
    // The refresh token is the person's own sign-in session (Supabase's), not something this server issued per
    // client, so it can't be tied to the client here; the client that asks is kept from expiring while in use.
    const clientId = form.get("client_id");
    if (clientId) void admin(c).from("mcp_clients").update({ last_used_at: new Date().toISOString() }).eq("client_id", clientId).then(() => undefined, () => undefined);
    const t = await fromRefresh(c, form.get("refresh_token") ?? "");
    return t ? json(res, 200, t) : json(res, 400, { error: "invalid_grant" });
  }
  if (grant !== "authorization_code") return json(res, 400, { error: "unsupported_grant_type" });
  const db = admin(c);
  const { data: r } = await db
    .from("mcp_auth_requests")
    .select("id, client_id, redirect_uri, code_challenge, refresh_token, used_at, created_at")
    .eq("code", form.get("code") ?? "")
    .maybeSingle();
  const fresh = r && !r.used_at && Date.now() - Date.parse(r.created_at) < 15 * 60_000;
  if (!r || !fresh || r.client_id !== form.get("client_id") || r.redirect_uri !== form.get("redirect_uri") || s256(form.get("code_verifier") ?? "") !== r.code_challenge)
    return json(res, 400, { error: "invalid_grant" });
  // One use, whoever asks first (a single conditional update); the session it carried is handed over and no
  // longer kept here.
  const { data: won } = await db
    .from("mcp_auth_requests")
    .update({ used_at: new Date().toISOString(), refresh_token: null })
    .eq("id", r.id)
    .is("used_at", null)
    .select("id");
  if (!won?.length) return json(res, 400, { error: "invalid_grant" });
  const t = r.refresh_token ? await fromRefresh(c, r.refresh_token) : null;
  return t ? json(res, 200, t) : json(res, 400, { error: "invalid_grant" });
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
