// The CoDesignFlo web app: sign-in (for the plugin, the CLI and coding agents) and the project dashboard —
// what waits on whom, the history, Live updates, people and settings. Everything is read and written as the
// signed-in person, straight from the service (row-level security decides what they see); a project's page
// reloads by itself when something happens in it (realtime signal).
import { type ComponentState, fold, type LedgerEvent, readEvent } from "@codesignflo/core";
import { createClient, type RealtimeChannel, type Session } from "@supabase/supabase-js";
import { message } from "../../mcp/messages.ts";
import { ADMIN_VIEWS, type AdminView, adminPage, isAdmin, wireAdminBilling } from "./admin.ts";
import { agents, FIRST_PROMPT } from "./agents.ts";
import { counterView, initConsent } from "./consent.ts";
import { logoSvg } from "./logo.ts";
import { billingHtml, billingNotice, confirmCheckout, goToStripe, myBilling, myReferrals, mySeats, refreshBilling } from "./billing.ts";
import { DOC_SLUGS, docHtml, docIndex, docTitle } from "./docs.ts";
import { landingHtml } from "./landing.ts";
import { LEGAL_PAGES, type LegalPage, legalHtml } from "./legal.ts";

type Config = {
  url: string;
  anon: string;
  devEmail?: boolean;
  pluginUrl?: string;
  communityUrl?: string;
  mcpUrl?: string;
  /** CoDesignFlo's cloud: the sign-in buttons (SIGNIN_METHODS); absent: Figma and GitHub. */
  signIn?: SignInMethod[];
  /** A self-hosted box ("selfhost"); absent: CoDesignFlo's cloud. */
  mode?: "selfhost";
  /** Self-hosted: the box sends emails (SMTP set up): invitations are emailed. */
  emails?: boolean;
  /** Self-hosted: Supabase Auth can email sign-in links (its SMTP is set up). */
  magicLink?: boolean;
  /** Self-hosted: OAuth providers set up on the box's Supabase Auth (none by default). */
  providers?: ("figma" | "github")[];
  /** Self-hosted: invitations need their sign-up code (the box doesn't prove emails by email). */
  codes?: boolean;
};
type SignInMethod = "figma" | "google" | "github" | "email";
type Project = { project_id: string; name: string; role: string; has_code: boolean; file_name: string | null };
type Person = {
  email: string | null;
  role: string;
  pending: boolean;
  email_status?: "queued" | "sent" | "failed" | null;
  email_error?: string | null;
  last_sent_at?: string | null;
};
type Upload = { id: number; created_at: string; commit: string; branch: string | null; kind: string; status: string; log: string | null };
type Check = {
  claim_id: string;
  component: string;
  code_check: { done: number; total: number; branch: string | null; commit: string } | null;
};
type Row = { seq: number; id: string; at: string; by: string; component: string; kind: string; body: Record<string, unknown> };

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
/**
 * Opened from the plugin's or the CLI's sign-in (?code=…): the person types the code they see there. The code in
 * the address is never used — a link someone else sent could carry theirs (one click would sign them in as you).
 */
const deviceSignIn = params.has("code");
/** A coding agent connecting to the hosted MCP (OAuth): approve it instead of a device code. */
const mcpRequest = params.get("mcp") ?? "";
/**
 * A designer's referral link (?ref=CODE): the code is kept in this browser (it survives the Figma or GitHub
 * sign-in) until a session exists, then offered once to the service, which binds it only to a brand-new account.
 */
const REF_KEY = "cdf.ref";
const refCode = (params.get("ref") ?? "").toUpperCase();
const cfg = (await (await fetch("/config.json")).json()) as Config;
/**
 * A self-hosted box: sign-in with email and password (invite-only), no billing, referrals or landing page; the
 * root is the app. Everything else is as on CoDesignFlo's cloud.
 */
const SELFHOST = cfg.mode === "selfhost";
if (!SELFHOST && /^[A-HJ-NP-Z2-9]{8}$/.test(refCode)) {
  try {
    if (!localStorage.getItem(REF_KEY)) localStorage.setItem(REF_KEY, refCode);
  } catch {
    // private window: the link just isn't remembered
  }
}
const storedRef = () => {
  if (SELFHOST) return null;
  try {
    return localStorage.getItem(REF_KEY);
  } catch {
    return null;
  }
};
// Back from Figma or GitHub, the sign-in comes after the page's own route (#/admin#access_token=…), and the
// Supabase client only reads it right after the first #: move it there, and put the route back once read.
const returnRoute = (() => {
  const h = location.hash;
  const k = h.indexOf("#", 1);
  if (k < 0 || !/(^|&)(access_token|error|error_description)=/.test(h.slice(k + 1))) return "";
  window.history.replaceState(null, "", `${location.pathname}${location.search}${h.slice(k)}`);
  return h.slice(0, k);
})();
const sb = createClient(cfg.url, cfg.anon);
if (returnRoute) {
  await sb.auth.getSession();
  window.history.replaceState(null, "", `${location.pathname}${location.search}${returnRoute}`);
}
// A saved sign-in the server no longer accepts (its account is gone, or its keys changed, as when a self-hosted
// server is set up again): forget it, so the page shows the sign-in instead of failing every request. Being offline
// isn't a reason (no status).
{
  const { data } = await sb.auth.getSession();
  if (data.session) {
    const { error } = await sb.auth.getUser();
    if (error && (error.status === 401 || error.status === 403)) await sb.auth.signOut({ scope: "local" });
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const show = (html: string) => {
  app.innerHTML = html;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const on = (id: string, f: () => void) => {
  const el = $(id);
  if (el) el.onclick = f;
};
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const pretty = (component: string) => component.replace(/^(components|pages)\./, "").replace(/[-_.]/g, " ");
const errorLine = (e: string) => (e ? `<p class="err">${esc(e)}</p>` : "");

/** Forgets the session in this tab without telling the server: it now belongs to the plugin, CLI or agent. */
function handOver() {
  sb.auth.stopAutoRefresh();
  for (const k of Object.keys(localStorage)) if (k.startsWith("sb-")) localStorage.removeItem(k);
}

/** GitHub signs in with whichever account is open in the browser unless asked to show its account picker. */
const GITHUB_PICK = { prompt: "select_account" };

/** A Supabase Auth error as the person should read it (self-hosted sign-in). */
function authError(m: string): string {
  // The sign-up guard's refusal (Supabase Auth answers it as "Database error saving new user").
  if (/database error saving new user|ask a teammate to invite you/i.test(m))
    return cfg.codes
      ? "Ask a teammate to invite you: this CoDesignFlo server lets in only people invited to a project. Create your account with the email they invited and the sign-up code they give you."
      : "Ask a teammate to invite you: this CoDesignFlo server lets in only people invited to a project. Once they've invited your email, create your account with it.";
  if (/email can.?t be changed/i.test(m)) return "On this server an account's email can't be changed: ask its admin.";
  if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/email not confirmed/i.test(m)) return "Confirm your email first (the link in the email you got), then sign in.";
  if (/already registered|already been registered|already exists/i.test(m)) return "There's an account with this email already — sign in instead.";
  if (/signups? not allowed|signup is disabled/i.test(m)) return "New accounts aren't open on this server — ask its admin.";
  return m;
}

/** A self-hosted box's sign-in: email and password (sign in, or create an account), a sign-in link when it emails. */
function selfhostSignIn(mode: "signin" | "signup" = "signin", error = "", notice = "", typed = "") {
  const signup = mode === "signup";
  document.title = `${signup ? "Create your account" : "Sign in"} — CoDesignFlo`;
  const back = location.href;
  show(`<section class="narrow">
    <h1>${signup ? "Create your CoDesignFlo account" : "Sign in to CoDesignFlo"}</h1>
    <p>${
      signup
        ? cfg.codes
          ? "Use the email a teammate invited to a project, with the sign-up code they gave you. The first account on a new server is its admin: use the server's setup code (SETUP_CODE in its .env)."
          : "Use the email a teammate invited to a project. The first account on a new server is its admin: use the server's setup code (SETUP_CODE in its .env)."
        : `Your team's own CoDesignFlo server <span class="muted">(${esc(location.host)})</span>.`
    }</p>
    <form id="pwForm" style="display:flex;flex-direction:column;gap:10px">
      <input id="email" type="email" placeholder="email" autocomplete="email" required value="${esc(typed)}" aria-label="Email">
      <input id="pw" type="password" placeholder="${signup ? "password (8 characters or more)" : "password"}" autocomplete="${signup ? "new-password" : "current-password"}" required ${signup ? 'minlength="8"' : ""} aria-label="Password">
      ${signup ? `<input id="code" type="text" placeholder="${cfg.codes ? "sign-up code" : "setup code (the first account only)"}" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Sign-up code">` : ""}
      <button class="primary" id="pwGo" type="submit">${signup ? "Create account" : "Sign in"}</button>
    </form>
    ${!signup && cfg.magicLink ? `<button id="magic" type="button">Email me a sign-in link</button>` : ""}
    ${(cfg.providers ?? []).map((p) => `<button id="oauth-${p}" type="button">Continue with ${p === "figma" ? "Figma" : "GitHub"}</button>`).join("")}
    ${error ? `<p class="err" role="alert" style="color:var(--warn)">${esc(error)}</p>` : ""}${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ""}
    <p class="muted">${
      signup ? `Already have an account? <a href="#" id="switch">Sign in</a>` : `No account yet? <a href="#" id="switch">Create one</a> with the email you were invited with.`
    }</p>
  </section>`);
  const email = () => $<HTMLInputElement>("email")!.value.trim();
  const busy = (yes: boolean) => {
    for (const id of ["pwGo", "magic"]) {
      const b = $<HTMLButtonElement>(id);
      if (b) b.disabled = yes;
    }
  };
  $("switch")!.onclick = (e) => {
    e.preventDefault();
    selfhostSignIn(signup ? "signin" : "signup", "", "", email());
  };
  $<HTMLFormElement>("pwForm")!.onsubmit = async (e) => {
    e.preventDefault();
    const password = $<HTMLInputElement>("pw")!.value;
    busy(true);
    if (signup) {
      const code = $<HTMLInputElement>("code")?.value.trim() ?? "";
      const { data, error: err } = await sb.auth.signUp({
        email: email(),
        password,
        options: { emailRedirectTo: back, ...(code ? { data: { codesignflo_code: code } } : {}) },
      });
      if (err) return selfhostSignIn(mode, authError(err.message), "", email());
      // With email confirmations on (a box with SMTP), the account waits for its link.
      if (!data.session) return selfhostSignIn("signin", "", `Almost there: open the link we emailed to ${email()}, then sign in.`, email());
    } else {
      const { error: err } = await sb.auth.signInWithPassword({ email: email(), password });
      if (err) return selfhostSignIn(mode, authError(err.message), "", email());
    }
    void route();
  };
  on("magic", async () => {
    if (!email()) return selfhostSignIn(mode, "Type your email first.", "", "");
    busy(true);
    const { error: err } = await sb.auth.signInWithOtp({ email: email(), options: { emailRedirectTo: back } });
    if (err) return selfhostSignIn(mode, authError(err.message), "", email());
    selfhostSignIn(mode, "", `Check your inbox: a sign-in link to ${email()} is on its way.`, email());
  });
  for (const p of cfg.providers ?? [])
    on(`oauth-${p}`, () => void sb.auth.signInWithOAuth({ provider: p, options: { redirectTo: back, ...(p === "github" ? { queryParams: GITHUB_PICK } : {}) } }));
  (typed ? $<HTMLInputElement>("pw") : $<HTMLInputElement>("email"))?.focus();
}

/** The cloud's sign-in methods, in the order they're shown. */
const SIGN_IN: SignInMethod[] = (["figma", "google", "github", "email"] as const).filter((m) =>
  (cfg.signIn?.length ? cfg.signIn : ["figma", "github"]).includes(m),
);
const PROVIDER_NAME = { figma: "Figma", google: "Google", github: "GitHub" } as const;

/** "a, b or c". */
const orList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** Signs in with Figma, Google or GitHub, coming back to `back`. */
function oauth(provider: "figma" | "google" | "github", back: string) {
  void sb.auth.signInWithOAuth({ provider, options: { redirectTo: back, ...(provider === "github" ? { queryParams: GITHUB_PICK } : {}) } });
}

function signInScreen(error = "", notice = "", typed = "") {
  if (SELFHOST) return selfhostSignIn("signin", error);
  document.title = "Sign in — CoDesignFlo";
  const back = location.href;
  const design = SIGN_IN.filter((m) => m !== "github").map((m) => (m === "email" ? "a link by email" : PROVIDER_NAME[m]));
  const providers = SIGN_IN.filter((m) => m !== "email") as ("figma" | "google" | "github")[];
  show(`<section class="narrow">
    <h1>Sign in to CoDesignFlo</h1>
    <p>${
      SIGN_IN.includes("github") && design.length
        ? `Designers sign in with ${orList(design)}, developers usually with GitHub.`
        : "New here? Signing in makes your account."
    }</p>
    ${providers.map((p, i) => `<button ${i === 0 ? 'class="primary" ' : ""}id="oauth-${p}" type="button">Continue with ${PROVIDER_NAME[p]}</button>`).join("")}
    ${
      SIGN_IN.includes("email")
        ? `<form id="linkForm" style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
      ${providers.length ? `<p class="muted" style="margin:0">Or with your email:</p>` : ""}
      <input id="linkEmail" type="email" placeholder="email" autocomplete="email" required value="${esc(typed)}" aria-label="Email">
      <button ${providers.length ? "" : 'class="primary" '}id="linkGo" type="submit">Email me a sign-in link</button>
    </form>`
        : ""
    }
    ${
      cfg.devEmail
        ? `<div class="dev"><p>Local development: email</p><input id="email" type="email" placeholder="email"><input id="pw" type="password" placeholder="password (8+)"><button id="emailgo">Sign in / sign up</button></div>`
        : ""
    }
    ${errorLine(error)}${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ""}
  </section>`);
  for (const p of providers) on(`oauth-${p}`, () => oauth(p, back));
  const form = $<HTMLFormElement>("linkForm");
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      const email = $<HTMLInputElement>("linkEmail")!.value.trim();
      $<HTMLButtonElement>("linkGo")!.disabled = true;
      // The link comes back here (a device code's page too: the code is typed, never taken from the address).
      const { error: err } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: back } });
      if (err) return signInScreen(linkError(err.message), "", email);
      signInScreen("", `Check your inbox: a sign-in link to ${email} is on its way. Open it in this browser.`, email);
    };
  on("emailgo", async () => {
    const email = $<HTMLInputElement>("email")!.value;
    const password = $<HTMLInputElement>("pw")!.value;
    let r = await sb.auth.signInWithPassword({ email, password });
    if (r.error) r = (await sb.auth.signUp({ email, password })) as typeof r;
    if (r.error) return signInScreen(r.error.message);
    void route();
  });
}

/** Auth's answer to a sign-in link request, said plainly. */
function linkError(m: string): string {
  if (/rate limit|only request this after|too many/i.test(m)) return "A link was sent a moment ago. Check your inbox, or try again in a minute.";
  if (/invalid|validate email|format/i.test(m)) return "That doesn't look like an email address.";
  return m;
}

type AgentRequest = { client_name: string | null; to: { kind: "loopback"; port: string } | { kind: "known"; name: string; host: string } };

/** What the MCP server says about a request (the name is the client's own; where it goes is checked there). */
async function agentRequest(): Promise<AgentRequest | null> {
  try {
    const r = await fetch(`${MCP_URL.replace(/\/mcp$/, "")}/api/mcp-request?id=${encodeURIComponent(mcpRequest)}`);
    return r.ok ? ((await r.json()) as AgentRequest) : null;
  } catch {
    return null;
  }
}

/** A coding agent asks to connect (OAuth through the hosted MCP). */
async function approveAgent(session: Session, error = "") {
  const info = await agentRequest();
  if (!info) return show(`<section class="narrow"><h1>This link expired</h1><p>Connect again from your coding agent.</p></section>`);
  const where =
    info.to.kind === "loopback"
      ? `an app on this computer <span class="muted">(localhost, port ${esc(info.to.port)})</span>`
      : `${esc(info.to.name)} <span class="muted">(${esc(info.to.host)})</span>`;
  show(`<section class="narrow"><h1>Connect a coding agent</h1>
    <p>Signed in as ${esc(session.user.email ?? session.user.id)}.</p>
    <div class="facts">
      <div><span class="muted">Your sign-in goes to</span><b>${where}</b></div>
      <div><span class="muted">It calls itself</span><b>${info.client_name ? `“${esc(info.client_name)}”` : "no name"}</b><span class="muted">Any app can give itself any name.</span></div>
    </div>
    <p class="notice warn">Only connect if you started this from your coding agent on your own computer just now. If someone sent you this link, choose Not me.</p>
    <p>The agent will be able to read your CoDesignFlo projects' design proposals and send updates from your code.</p>
    <div class="row"><button class="primary" id="approve">Connect</button><button id="cancel">Not me</button></div>
    ${errorLine(error)}</section>`);
  on("cancel", async () => {
    await sb.auth.signOut({ scope: "local" });
    void route();
  });
  on("approve", async () => {
    const { data, error: e } = await sb.rpc("approve_mcp", { p_request: mcpRequest, p_refresh_token: session.refresh_token });
    if (e) return approveAgent(session, e.message);
    handOver();
    const r = (data as { redirect_uri: string; code: string; state: string | null }[])[0]!;
    const to = new URL(r.redirect_uri);
    to.searchParams.set("code", r.code);
    if (r.state) to.searchParams.set("state", r.state);
    show(`<section class="narrow"><h1>Connected</h1><p>Go back to your coding agent. You can close this tab.</p></section>`);
    location.href = to.toString();
  });
}

/** A sign-in code as typed: its 8 letters and digits (the dash, spaces and case don't matter). */
const typedCode = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The plugin or the CLI shows a code; the person types it here to approve it (device sign-in). */
function approveDevice(session: Session, error = "", typed = "") {
  show(`<section class="narrow"><h1>Approve sign-in</h1>
    <p>Signed in as ${esc(session.user.email ?? session.user.id)}. Type the code shown in Figma or your terminal:</p>
    <input id="usercode" class="code-input" value="${esc(typed)}" placeholder="XXXX-XXXX" maxlength="9" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Sign-in code">
    <p class="notice warn">Only approve if you started this sign-in on your own computer just now. If someone sent you this link or a code, choose Not me.</p>
    <div class="row"><button class="primary" id="approve" disabled>Approve</button><button id="cancel">Not me</button></div>
    ${errorLine(error)}</section>`);
  const input = $<HTMLInputElement>("usercode")!;
  const approve = $<HTMLButtonElement>("approve")!;
  const check = () => {
    approve.disabled = typedCode(input.value).length !== 8;
  };
  input.oninput = check;
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !approve.disabled) approve.click();
  };
  check();
  input.focus();
  on("cancel", async () => {
    await sb.auth.signOut({ scope: "local" });
    void route();
  });
  on("approve", async () => {
    const code = typedCode(input.value);
    approve.disabled = true;
    const { data: client, error: e } = await sb.rpc("approve_login", { p_user_code: code, p_refresh_token: session.refresh_token });
    if (e) return approveDevice(session, e.message, input.value);
    handOver();
    show(
      `<section class="narrow"><h1>You're signed in</h1><p>Go back to ${client === "plugin" ? "Figma" : "your terminal"}. You can close this tab.</p></section>`,
    );
  });
}

/** Whether the signed-in person is one of CoDesignFlo's admins (asked once per sign-in). */
let admin: Promise<boolean> | null = null;
let adminFor = "";
function frame(session: Session, crumbs: string, body: string) {
  if (adminFor !== session.user.id) {
    adminFor = session.user.id;
    admin = isAdmin(sb);
  }
  show(`<header class="top">
      <a href="#/" class="brand">${logoSvg(20)}CoDesignFlo</a>${crumbs}
      <span class="grow"></span>
      <a href="#/admin" id="adminLink" hidden>Admin</a>
      <a href="#/docs/developers">Docs</a>
      ${SELFHOST ? `<a href="#/setup">Set up</a>` : `<a href="#/billing">Billing</a>`}
      <a href="#/connect">Connect your agent</a>
      <span class="muted">${esc(session.user.email ?? "")}</span>
      <button id="signout" class="small">Sign out</button>
    </header>
    <section class="page">${body}</section>`);
  void admin?.then((yes) => {
    const a = $("adminLink");
    if (a) a.hidden = !yes;
  });
  on("signout", async () => {
    await sb.auth.signOut({ scope: "local" });
    void route();
  });
}

const MCP_URL = cfg.mcpUrl ?? `${location.origin}/mcp`;

/** The agent tab last chosen (this browser only). */
function savedAgent(): string {
  try {
    return localStorage.getItem("cdf.agent") ?? "claude-code";
  } catch {
    return "claude-code";
  }
}

const codeBlock = (code: string) =>
  `<div class="snippet"><pre>${esc(code)}</pre><button class="small copy" data-copy="${esc(code)}">Copy</button></div>`;

/** "Connect your coding agent": the MCP address and, for each major agent, how to add it and sign in. */
function connectCard(intro = true): string {
  const list = agents(MCP_URL);
  const chosen = list.some((a) => a.id === savedAgent()) ? savedAgent() : "claude-code";
  return `<div class="card connect"><h2>Connect your coding agent</h2>
    ${intro ? `<p class="muted">Developers: your coding agent works with CoDesignFlo through its MCP server — it reads what the designer sent, builds it in your code, and updates Live in Figma.</p>` : ""}
    <label>MCP server</label>${codeBlock(MCP_URL)}
    <div class="agents" role="tablist">${list
      .map((a) => `<button class="agent ${a.id === chosen ? "on" : ""}" role="tab" data-agent="${esc(a.id)}">${esc(a.name)}</button>`)
      .join("")}</div>
    ${list
      .map(
        (a) => `<div class="agentPanel" data-panel="${esc(a.id)}" ${a.id === chosen ? "" : "hidden"}>
          ${a.install ? `<p><a class="button primary" href="${esc(a.install.href)}">${esc(a.install.label)}</a></p>` : ""}
          <ol>${a.steps.map((st) => `<li>${esc(st.text)}${st.code ? codeBlock(st.code) : ""}</li>`).join("")}
          <li>Open your app's folder in it and ask: ${codeBlock(FIRST_PROMPT)}It finds your project (or the one your designer started and invited you to), writes <code>.codesignflo/config.json</code> and puts your app into Figma.</li></ol>
        </div>`,
      )
      .join("")}
  </div>`;
}

/** This server's address, for the plugin's and the CLI's sign-in on a self-hosted box. */
const ORIGIN = location.origin;

/** The box's public address (PUBLIC_URL): what the plugin and the CLI are made for, whatever address this page has. */
const BOX = (() => {
  try {
    return new URL(MCP_URL).origin;
  } catch {
    return ORIGIN;
  }
})();
const BOX_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(BOX).hostname);

const SELFHOST_START = `<div class="card"><h2>Getting started on this server</h2><ol>
  <li><b>Designers:</b> install this server's Figma plugin (<a href="#/setup">Set up</a>), open your team's file, sign in from the plugin and choose <i>Start a project for this file</i>. Invite your developer from <i>People</i>.</li>
  <li><b>Developers:</b> point the CLI at this server and connect your coding agent (<a href="#/setup">Set up</a>), then ask it to "${FIRST_PROMPT}".</li>
  <li>People join by invitation: invite their email, then they create their account on this server with it.</li>
</ol></div>`;

/** A self-hosted box's Set up page: the Figma plugin for this box, the CLI, the agent, and who can join. */
async function setupPage(session: Session) {
  frame(session, ` <span class="muted">/</span> Set up`, "<p class=\"muted\">Loading…</p>");
  const [admin, zip] = await Promise.all([
    isAdmin(sb),
    fetch("/plugin.zip", { method: "HEAD" }).then((r) => r.ok, () => false),
  ]);
  const host = new URL(BOX).host;
  const local = BOX_LOCAL
    ? `<p class="notice">This server's address is <code>${esc(BOX)}</code>: the plugin and the CLI work only on the computer running it. For a team on other computers, set <code>PUBLIC_URL</code> in the server's <code>.env</code> to an address they can open (the same network, Tailscale or a domain: <code>selfhost/GUIDE.md</code>, section 3) and restart it; then everyone installs the plugin from here again.</p>`
    : "";
  frame(
    session,
    ` <span class="muted">/</span> Set up`,
    `<h1>Set up</h1>${local}
    <div class="card"><h2>Designers: the Figma plugin</h2>
      <p class="muted">This server has its own CoDesignFlo plugin, made for <code>${esc(BOX)}</code>. It isn't in Figma's Community: each designer installs it once, in the Figma desktop app (macOS or Windows; Figma in a browser can't install it, and Figma has no Linux app).</p>
      <ol>
        <li>${
          zip
            ? `<a class="button primary" href="/plugin.zip" download>Download the plugin</a>`
            : `Make it on your computer (needs Node 22): ${codeBlock(`npx @codesignflo/cli plugin build --server ${BOX}`)}`
        }</li>
        <li>${zip ? "Unzip it and keep" : "Keep"} the <code>CoDesignFlo</code> folder somewhere permanent, e.g. in Documents. Don't move it afterwards.</li>
        <li>In the Figma desktop app, open any design file, then in the menu: <b>Plugins → Development → Import plugin from manifest…</b> and choose <code>manifest.json</code> in that folder.</li>
        <li>Run it from <b>Plugins → Development → CoDesignFlo (${esc(host)})</b>, choose <i>Sign in</i>, and sign in to this server on the page that opens.</li>
      </ol>
      <p class="muted"><b>Updates:</b> after this server is updated, ${zip ? "download the plugin again and replace the files in the same folder" : "run the same command again"}. Figma picks up the new version without importing it again.</p>
      ${zip ? `<details><summary class="muted">Or with the command line (any system with Node 22)</summary>${codeBlock(`npx @codesignflo/cli plugin build --server ${BOX}`)}</details>` : ""}
    </div>
    <div class="card"><h2>Developers: the CLI and your coding agent</h2>
      <p class="muted">On macOS, Windows or Linux, with Node 22. Once per computer, in a terminal:</p>
      ${codeBlock(`npx @codesignflo/cli connect ${BOX}
npx @codesignflo/cli login`)}
      <p class="muted">Then connect your coding agent to this server's MCP (<a href="#/connect">how, for each agent</a>) and ask it, in your app's folder, to "${FIRST_PROMPT}". To use codesignflo.com again later: <code>npx @codesignflo/cli connect --cloud</code>.</p>
    </div>
    <div class="card"><h2>Who can join</h2>
      <p class="muted">People join by invitation: invite their email from <i>People</i> in a project, then they create their account at <code>${esc(BOX)}</code> with that email${
        cfg.codes ? " and the invitation's sign-up code (shown to you in People)" : ""
      }.${cfg.emails ? " Invitations are emailed." : " This server sends no emails, so tell them yourself."}${
        admin
          ? cfg.codes
            ? " Letting everyone with your company's email in without an invitation (<code>ALLOWED_DOMAINS</code>) needs email confirmation: set up SMTP and <code>EMAIL_AUTOCONFIRM=false</code> in the server's <code>.env</code> (selfhost/GUIDE.md, section 4)."
            : " To let everyone with your company's email in without an invitation, set <code>ALLOWED_DOMAINS</code> in the server's <code>.env</code> (e.g. <code>yourcompany.com</code>) and restart it."
          : ""
      }</p>
    </div>`,
  );
}

const GETTING_STARTED = `<div class="card"><h2>Getting started</h2><ol>
  <li><b>Designer:</b> install the CoDesignFlo Figma plugin (<a href="/plugin.zip" download>download it</a>, unzip it, then in the Figma desktop app: Plugins › Development › Import plugin from manifest), open your team's file, sign in and choose <i>Start a project for this file</i>. Invite your developer from <i>People</i>.</li>
  <li><b>Developer:</b> connect your coding agent (<a href="#/connect">how, for each agent</a>) and ask it to "${FIRST_PROMPT}".</li>
  <li>Either side can start; invitations by email turn into memberships the next time that person signs in.</li>
</ol></div>`;

/** Signed in with GitHub, or a developer somewhere: the agent setup comes first. */
const developer = (session: Session, projects: Project[]) =>
  session.user.app_metadata?.provider === "github" || projects.some((p) => p.role === "developer");

function connectPage(session: Session) {
  frame(session, ` <span class="muted">/</span> Connect your coding agent`, connectCard());
}

/**
 * Works on the design side somewhere (a designer, or an admin who signed in with Figma or started a project from
 * Figma): seats concern them.
 */
const designs = (session: Session, projects: Project[], designSide: boolean) =>
  projects.some((p) => p.role === "designer" || (p.role === "admin" && (designSide || session.user.app_metadata?.provider === "figma")));

async function projectsPage(session: Session) {
  await sb.rpc("accept_invitations");
  const [{ data, error }, billing, me] = await Promise.all([
    sb.rpc("my_projects"),
    SELFHOST ? null : myBilling(sb),
    SELFHOST ? null : sb.from("profiles").select("design_side").eq("id", session.user.id).maybeSingle(),
  ]);
  const projects = (data ?? []) as Project[];
  // A developer whose agent isn't connected to any code yet starts there; afterwards it stays at the bottom.
  const dev = developer(session, projects);
  const first = dev && !projects.some((p) => p.has_code);
  frame(
    session,
    "",
    `<h1>Your projects</h1>${errorLine(error?.message ?? "")}${!SELFHOST && designs(session, projects, me?.data?.design_side === true) ? billingNotice(billing) : ""}
    ${first ? connectCard() : ""}
    ${
      projects.length
        ? `<div class="list">${projects
            .map(
              (p) => `<a class="item" href="#/p/${esc(p.project_id)}"><b>${esc(p.name)}</b>
                <span class="muted">${esc(p.role)} · ${p.has_code ? "code linked" : "waiting for its code"} · ${p.file_name ? `Figma: ${esc(p.file_name)}` : "no Figma file yet"}</span></a>`,
            )
            .join("")}</div>`
        : `<p class="muted">You're not in a project yet. Projects start from the Figma plugin or from a coding agent; someone in one can invite you by email.</p>`
    }
    ${dev && !first ? connectCard() : ""}
    ${SELFHOST ? SELFHOST_START : GETTING_STARTED}`,
  );
}

const TABS = ["overview", "activity", "live", "people", "settings"] as const;
type Tab = (typeof TABS)[number];
let channel: RealtimeChannel | null = null;
let channelFor = "";

function listen(project: string, reload: () => void) {
  if (channelFor === project) return;
  if (channel) void sb.removeChannel(channel);
  channelFor = project;
  let timer: ReturnType<typeof setTimeout> | null = null;
  channel = sb
    .channel(`project:${project}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "project_signals", filter: `project_id=eq.${project}` }, () => {
      // Several facts land together (an update writes many events): one reload for them.
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 400);
    })
    .subscribe();
}

function stopListening() {
  if (channel) void sb.removeChannel(channel);
  channel = null;
  channelFor = "";
}

const STATE_LABEL: Record<string, string> = {
  ready_for_dev: "Ready for dev",
  design_new: "New design",
  in_design: "In design",
  code_new: "New in code",
  in_sync: "In sync",
  ignored: "Ignored",
};

async function projectPage(session: Session, id: string, tab: Tab, notice = "") {
  // Arriving from an invitation email: the invitation becomes a membership now.
  await sb.rpc("accept_invitations");
  const { data: proj } = await sb
    .from("projects")
    .select("id, name, owner, settings, repo_root_commit, repo_folder")
    .eq("id", id)
    .maybeSingle();
  if (!proj) {
    stopListening();
    return frame(
      session,
      "",
      `<h1>No access</h1><p>This project doesn't exist or you're not in it — ask someone in it to invite you.</p><p><a href="#/">Your projects</a></p>`,
    );
  }
  listen(id, () => void projectPage(session, id, currentTab()));
  const { data: mine } = await sb.from("project_members").select("role").eq("project_id", id).eq("user_id", session.user.id).maybeSingle();
  const role = (mine?.role as string | undefined) ?? "";
  const settings = (proj.settings ?? {}) as { liveBranch?: string; buildMode?: string; shareContent?: boolean; file?: { name?: string } };
  const tabs = `<nav class="tabs">${TABS.map((t) => `<a href="#/p/${esc(id)}/${t}" class="${t === tab ? "on" : ""}">${t[0]!.toUpperCase()}${t.slice(1)}</a>`).join("")}</nav>`;
  const head = `<h1>${esc(proj.name)}</h1>
    <p class="muted">You're ${esc(role)} · ${proj.repo_root_commit ? `code linked (${esc(String(proj.repo_root_commit).slice(0, 7))}${proj.repo_folder !== "." ? `, ${esc(proj.repo_folder)}` : ""})` : "waiting for its code"} · ${settings.file?.name ? `Figma: ${esc(settings.file.name)}` : "no Figma file yet"} · Live branch: ${esc(settings.liveBranch ?? "not set")}</p>
    ${notice ? `<p class="ok">${esc(notice)}</p>` : ""}${tabs}`;
  const body =
    tab === "activity"
      ? await activity(id)
      : tab === "live"
        ? await live(id)
        : tab === "people"
          ? await peopleTab(id, role)
          : tab === "settings"
            ? await settingsTab(session, id, role, proj.owner === session.user.id, settings)
            : await overview(id);
  frame(session, ` <span class="muted">/</span> <a href="#/p/${esc(id)}">${esc(proj.name)}</a>`, head + body);
  wire(session, id);
}

async function history(id: string): Promise<{ rows: Row[]; events: LedgerEvent[] }> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("events")
      .select("seq, id, at, by, component, kind, body")
      .eq("project_id", id)
      .order("seq")
      .range(from, from + 999);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const events = rows
    .map((r) => readEvent({ ...r.body, id: r.id, at: r.at, by: r.by, component: r.component, kind: r.kind }))
    .filter((e): e is LedgerEvent => !!e);
  return { rows, events };
}

async function overview(id: string): Promise<string> {
  const [{ events }, { data: checks }, { data: presence }, { data: last }] = await Promise.all([
    history(id),
    sb.from("proposals").select("claim_id, component, code_check").eq("project_id", id),
    sb.from("plugin_presence").select("seen_at, file_name").eq("project_id", id).order("seen_at", { ascending: false }).limit(1),
    sb
      .from("live_updates")
      .select("commit, branch, status, created_at")
      .eq("project_id", id)
      .eq("kind", "live")
      .order("id", { ascending: false })
      .limit(1),
  ]);
  const states = [...fold(events).values()];
  const byClaim = new Map(((checks ?? []) as Check[]).map((c) => [c.claim_id, c.code_check]));
  const seen = (presence as { seen_at: string; file_name: string | null }[] | null)?.[0];
  const open = seen && Date.now() - Date.parse(seen.seen_at) < 60_000;
  const lastLive = (last as { commit: string; branch: string | null; status: string; created_at: string }[] | null)?.[0];
  const card = (title: string, list: ComponentState[], empty: string) =>
    `<div class="card"><h2>${title} <span class="count">${list.length}</span></h2>${
      list.length
        ? `<ul class="states">${list
            .map((s) => {
              const k = s.claim ? byClaim.get(s.claim.id) : null;
              const progress =
                k?.total
                  ? k.done === k.total
                    ? `looks done in code${k.branch ? ` (${esc(k.branch)})` : ""}`
                    : `${k.done} of ${k.total} in code`
                  : "";
              const review = s.claim?.review ? `reviewed: ${esc(s.claim.review.decision)}` : "";
              return `<li><b>${esc(pretty(s.component))}</b> <span class="tag">${esc(STATE_LABEL[s.state] ?? s.state)}</span>${s.conflict ? ' <span class="tag warn">clashes with code</span>' : ""}
                ${s.claim?.note ? `<div class="muted">“${esc(s.claim.note)}” — ${esc(s.claim.by)}</div>` : ""}
                ${s.claim?.question ? `<div class="muted">Question: “${esc(s.claim.question)}”</div>` : ""}
                ${progress || review ? `<div class="muted">${[progress, review].filter(Boolean).join(" · ")}</div>` : ""}</li>`;
            })
            .join("")}</ul>`
        : `<p class="muted">${empty}</p>`
    }</div>`;
  const pick = (...st: string[]) => states.filter((s) => st.includes(s.state));
  return `<div class="grid">
    ${card("Waiting on the developer", pick("ready_for_dev", "design_new"), "Nothing — the developer is up to date with the designs.")}
    ${card("With the designer", pick("in_design", "code_new"), "Nothing is being designed or waiting for review.")}
    <div class="card"><h2>Figma</h2>
      <p>${open ? `The file${seen?.file_name ? ` <b>${esc(seen.file_name)}</b>` : ""} is open with the plugin now — Live updates apply at once.` : seen ? `Last opened with the plugin ${ago(seen.seen_at)}. Updates from code wait until someone opens it.` : "Nobody has opened the file with the plugin yet."}</p>
      <p>${lastLive ? `Latest Live update: ${esc(lastLive.branch ?? "")} @${esc(lastLive.commit.slice(0, 7))} — ${esc(lastLive.status)} (${ago(lastLive.created_at)})` : "No Live update from code yet."}</p>
      <p class="muted">${states.length} components and pages tracked.</p>
    </div>
  </div>`;
}

async function activity(id: string): Promise<string> {
  const { data } = await sb
    .from("events")
    .select("seq, id, at, by, component, kind, body")
    .eq("project_id", id)
    .order("seq", { ascending: false })
    .limit(150);
  const rows = (data ?? []) as Row[];
  return rows.length
    ? `<ul class="feed">${rows.map((r) => `<li><span class="when">${ago(r.at)}</span> ${esc(message(r))} <span class="tag">${esc(r.kind)}</span></li>`).join("")}</ul>`
    : `<p class="muted">Nothing has happened in this project yet.</p>`;
}

async function live(id: string): Promise<string> {
  const { data } = await sb
    .from("live_updates")
    .select("id, created_at, commit, branch, kind, status, log")
    .eq("project_id", id)
    .order("id", { ascending: false })
    .limit(40);
  const rows = (data ?? []) as Upload[];
  return rows.length
    ? `<table class="table"><thead><tr><th>When</th><th>Kind</th><th>Branch @ commit</th><th>Status</th></tr></thead><tbody>${rows
        .map(
          (
            u,
          ) => `<tr><td>${ago(u.created_at)}</td><td>${u.kind === "live" ? "Live update" : "Check"}</td><td><code>${esc(u.branch ?? "?")} @${esc(u.commit.slice(0, 7))}</code></td>
            <td><span class="tag ${u.status === "failed" ? "warn" : ""}">${esc(u.status)}</span>${u.log ? `<details><summary>log</summary><pre>${esc(u.log)}</pre></details>` : ""}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">Nothing uploaded from code yet. The developer's coding agent uploads Live updates when it syncs on the Live branch.</p>`;
}

/** A self-hosted box that doesn't send emails: invitations are passed on by hand. */
const NO_EMAILS = SELFHOST && !cfg.emails;

/** How a pending invitation's email went. */
function emailLine(p: Person, code?: string): string {
  if (!p.pending) return "";
  const codeLine = code ? ` and the sign-up code <code>${esc(code)}</code>` : "";
  if (NO_EMAILS) return `<div class="invite-line"><span class="muted">tell them to create their account at ${esc(ORIGIN)} with this email${codeLine}</span></div>`;
  const when = p.last_sent_at ? ` ${ago(p.last_sent_at)}` : "";
  const line =
    p.email_status === "sent"
      ? `<span class="muted">invitation email sent${when}</span>`
      : p.email_status === "failed"
        ? `<span class="err">invitation email not sent: ${esc(p.email_error ?? "unknown error")}</span>`
        : p.email_status === "queued"
          ? `<span class="muted">invitation email on its way${when}</span>`
          : `<span class="muted">no invitation email sent</span>`;
  return `<div class="invite-line">${line} <button class="small" data-resend="${esc(p.email ?? "")}">${p.email_status ? "Send again" : "Send email"}</button></div>`;
}

/** Sends what's queued now (the invitation just made), rather than when the database pings; harmless if it can't. */
async function sendNow() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return;
  await fetch("/api/notify", { method: "POST", headers: { authorization: `Bearer ${data.session.access_token}` } }).catch(() => undefined);
}

async function peopleTab(id: string, role: string): Promise<string> {
  const { data } = await sb.rpc("project_people", { p_project: id });
  const people = (data ?? []) as Person[];
  // A box that doesn't prove emails: the pending invitations' sign-up codes (only those you invited, or all as an admin).
  const codes = new Map<string, string>();
  if (cfg.codes)
    await Promise.all(
      people
        .filter((p) => p.pending && p.email)
        .map(async (p) => {
          const { data: c } = await sb.rpc("invitation_code", { p_project: id, p_email: p.email });
          if (typeof c === "string" && c) codes.set(p.email!, c);
        }),
    );
  return `<div class="card"><h2>People</h2><ul class="states">${people
    .map(
      (p) =>
        `<li><b>${esc(p.email ?? "(no email)")}</b> <span class="tag">${esc(p.role)}</span>${p.pending ? ' <span class="tag">invited</span>' : ""}${emailLine(p, codes.get(p.email ?? ""))}${
          !NO_EMAILS && codes.get(p.email ?? "") ? `<div class="invite-line"><span class="muted">sign-up code (in their email too): <code>${esc(codes.get(p.email ?? "")!)}</code></span></div>` : ""
        }</li>`,
    )
    .join("")}</ul></div>
    <div class="card"><h2>Invite someone</h2>
      <p class="muted">${
        NO_EMAILS
          ? `This server doesn't send emails: tell them to create their account at ${esc(ORIGIN)} with the email you invite${cfg.codes ? " and the sign-up code shown here" : ""} — they join the project when they sign in.`
          : "They get an email with what to do for their role — developers how to connect their coding agent, designers how to open the Figma plugin — and join when they sign in with that email."
      }</p>
      <div class="row"><input id="invEmail" type="email" placeholder="email">
      <select id="invRole"><option value="designer">designer</option><option value="developer">developer</option>${role === "admin" ? '<option value="admin">admin</option>' : ""}</select>
      <button class="primary" id="invite">Invite</button></div><p id="invMsg"></p></div>`;
}

async function settingsTab(
  session: Session,
  id: string,
  role: string,
  owner: boolean,
  s: { liveBranch?: string; buildMode?: string; shareContent?: boolean },
): Promise<string> {
  const dev = role === "admin" || role === "developer";
  const { data: emails } = await sb.rpc("my_notifications");
  const { data: integ } =
    role === "admin" ? await sb.from("project_integrations").select("slack_webhook").eq("project_id", id).maybeSingle() : { data: null };
  return `${
    role === "admin"
      ? `<div class="card"><h2>Name</h2><div class="row"><input id="name" value=""><button id="rename">Rename</button></div></div>`
      : ""
  }
    <div class="card"><h2>Code</h2>
      <label>Live branch — commits to it update Live in Figma</label>
      <div class="row"><input id="branch" value="${esc(s.liveBranch ?? "")}" placeholder="main" ${dev ? "" : "disabled"}><button id="setBranch" ${dev ? "" : "disabled"}>Save</button></div>
      <label>Where designs are built</label>
      <div class="row"><select id="mode" ${dev ? "" : "disabled"}>
        <option value="" ${s.buildMode ? "" : "selected"} disabled>not chosen</option>
        <option value="storybook-first" ${s.buildMode === "storybook-first" ? "selected" : ""}>Storybook first (wired into the app after review)</option>
        <option value="storybook-and-app" ${s.buildMode === "storybook-and-app" ? "selected" : ""}>Storybook and the app together</option>
      </select><button id="setMode" ${dev ? "" : "disabled"}>Save</button></div>
      ${dev ? "" : '<p class="muted">Developers choose these.</p>'}
    </div>
    <div class="card"><h2>${SELFHOST ? "Diagnostics" : "Help improve CoDesignFlo"}</h2>
      <p class="muted">${
        SELFHOST
          ? "CoDesignFlo records how it does here, on this server, in structure and numbers only: what failed and where in CoDesignFlo, how long each step took, which versions ran, and where Live differs from the app by kind and size — never your app's words, names or pictures. This server's admins see it."
          : "CoDesignFlo always tells its team how it does here in structure and numbers only: what failed and where in CoDesignFlo, how long each step took, which versions ran, and where Live differs from the app by kind and size — never your app's words, names or pictures."
      }</p>
      <label class="check"><input type="checkbox" id="shareContent" ${s.shareContent ? "checked" : ""} ${dev ? "" : "disabled"}> Also keep content when something goes wrong: the sync's log and reports your coding agent files (kept 90 days, seen only by ${SELFHOST ? "this server's admins" : "CoDesignFlo's team"})</label>
    </div>
    <div class="card"><h2>Notifications</h2>
      ${NO_EMAILS ? "" : `<label class="check"><input type="checkbox" id="emails" ${emails === false ? "" : "checked"}> Email me when there's something for me (${esc(session.user.email ?? "")})</label>`}
      ${
        role === "admin"
          ? `<label>Slack incoming webhook — the whole project's activity in a channel</label>
             <div class="row"><input id="slack" placeholder="${integ?.slack_webhook ? "set — paste a new one to replace, or leave empty and save to remove" : "https://hooks.slack.com/services/…"}"><button id="setSlack">Save</button></div>`
          : ""
      }
    </div>
    ${owner ? `<div class="card danger"><h2>Delete project</h2><p class="muted">Deletes its history, proposals and Live versions for everyone. The Figma file and the code stay as they are.</p><button id="delete" class="danger">Delete this project…</button></div>` : ""}`;
}

function currentTab(): Tab {
  const t = location.hash.split("/")[3] as Tab | undefined;
  return t && TABS.includes(t) ? t : "overview";
}

function wire(session: Session, id: string) {
  const redo = (notice = "") => void projectPage(session, id, currentTab(), notice);
  const fail = (e: { message: string } | null, ok: string) => (e ? alert(e.message) : redo(ok));
  const name = $<HTMLInputElement>("name");
  if (name) name.value = (document.querySelector("h1")?.textContent ?? "").trim();
  on("rename", async () => {
    const { error } = await sb.from("projects").update({ name: name!.value.trim() }).eq("id", id);
    fail(error, "Renamed.");
  });
  on("setBranch", async () =>
    fail((await sb.rpc("set_live_branch", { p_project: id, p_branch: $<HTMLInputElement>("branch")!.value })).error, "Live branch saved."),
  );
  on("setMode", async () =>
    fail((await sb.rpc("set_build_mode", { p_project: id, p_mode: $<HTMLSelectElement>("mode")!.value })).error, "Saved."),
  );
  const share = $<HTMLInputElement>("shareContent");
  if (share)
    share.onchange = async () =>
      fail(
        (await sb.rpc("set_share_content", { p_project: id, p_on: share.checked })).error,
        share.checked ? "This project now shares content when something goes wrong." : "This project no longer shares content.",
      );
  const emails = $<HTMLInputElement>("emails");
  if (emails)
    emails.onchange = async () =>
      fail((await sb.rpc("set_my_notifications", { p_email: emails.checked })).error, emails.checked ? "Emails on." : "Emails off.");
  on("setSlack", async () =>
    fail((await sb.rpc("set_slack_webhook", { p_project: id, p_url: $<HTMLInputElement>("slack")!.value })).error, "Slack saved."),
  );
  on("delete", async () => {
    if (!confirm("Delete this project and all its history for everyone? This can't be undone.")) return;
    const { error } = await sb.rpc("delete_project", { p_project: id });
    if (error) return alert(error.message);
    stopListening();
    location.hash = "#/";
  });
  on("invite", async () => {
    const email = $<HTMLInputElement>("invEmail")!.value.trim();
    const r = $<HTMLSelectElement>("invRole")!.value;
    if (!email) return;
    const { data, error } = await sb.rpc("invite", { p_project: id, p_email: email, p_role: r });
    if (error) {
      $("invMsg")!.textContent = error.message;
      return;
    }
    await sendNow();
    const code = data === "invited" && cfg.codes ? ((await sb.rpc("invitation_code", { p_project: id, p_email: email })).data as string | null) : null;
    if (code)
      return redo(
        NO_EMAILS
          ? `Invited ${email}. Give them the sign-up code ${code}: they create their account at ${ORIGIN} with this email and the code.`
          : `Invited ${email} — an email with how to join and their sign-up code (${code}) is on its way.`,
      );
    redo(
      data === "role_changed"
        ? `${email} is now ${r === "admin" ? "an admin" : `a ${r}`} in the project.`
        : data === "member"
          ? `${email} is in the project already. Only an admin changes their role, by inviting them again with the new one.`
          : data === "added"
            ? `${email} is now in the project${NO_EMAILS ? "" : " — they got an email about it"}.`
            : NO_EMAILS
              ? `Invited ${email}. This server doesn't send emails: tell them to create their account at ${ORIGIN} with this email.`
              : `Invited ${email} — an email with how to join is on its way.`,
    );
  });
  for (const b of app.querySelectorAll<HTMLButtonElement>("[data-resend]"))
    b.onclick = async () => {
      b.disabled = true;
      const { error } = await sb.rpc("resend_invitation", { p_project: id, p_email: b.dataset.resend });
      if (error) {
        b.disabled = false;
        return alert(error.message);
      }
      await sendNow();
      redo(`Invitation email sent again to ${b.dataset.resend}.`);
    };
}

/**
 * In-page links (data-scroll) scroll to their section, without touching the address (the app routes on it).
 * From another page (the footer on a legal page), they open the landing page first.
 */
function wireScroll() {
  for (const a of app.querySelectorAll<HTMLAnchorElement>("[data-scroll]"))
    a.onclick = (e) => {
      e.preventDefault();
      const id = a.dataset.scroll!;
      const go = () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
      if (document.getElementById(id)) return go();
      pendingScroll = id;
      location.hash = "#/";
    };
  if (pendingScroll) {
    const id = pendingScroll;
    pendingScroll = "";
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }));
  }
}
let pendingScroll = "";

/** The privacy policy, the terms, the impressum or cookies and storage: for everyone, signed in or not. */
function legalPage(which: LegalPage) {
  show(legalHtml(which));
  const titles: Record<LegalPage, string> = { privacy: "Privacy policy", terms: "Terms", impressum: "Impressum", cookies: "Cookies and storage", security: "Security" };
  document.title = `${titles[which]} — CoDesignFlo`;
  window.scrollTo(0, 0);
  wireScroll();
}

/** The documentation: for everyone, signed in or not. #/docs/<page>[/<section>]. */
let docSpy: IntersectionObserver | null = null;
let docClickWired = false;
function docPage(slug: string, sec = "") {
  const ctx = { mcpUrl: MCP_URL };
  show(docHtml(slug, ctx));
  document.title = `${docTitle(slug)} — CoDesignFlo docs`;
  const goSec = (id: string, smooth = true) => {
    document.getElementById(id)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
    window.history.replaceState(null, "", `#/docs/${slug}${id ? `/${id}` : ""}`);
  };
  if (sec) requestAnimationFrame(() => goSec(sec, false));
  else window.scrollTo(0, 0);
  // Section links ("On this page", heading anchors): scroll, and keep the address shareable.
  for (const a of app.querySelectorAll<HTMLAnchorElement>("[data-doc-sec]"))
    a.onclick = (e) => {
      e.preventDefault();
      goSec(a.dataset.docSec!);
    };
  // Copy buttons on code blocks.
  for (const b of app.querySelectorAll<HTMLButtonElement>("[data-copy]"))
    b.onclick = async () => {
      const text = b.closest(".dx-code")?.querySelector("code")?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "Copied";
      } catch {
        b.textContent = "Select and copy";
      }
      setTimeout(() => (b.textContent = "Copy"), 1500);
    };
  // Tabs (one panel per coding agent).
  for (const t of app.querySelectorAll<HTMLButtonElement>("[data-tab]"))
    t.onclick = () => {
      for (const o of app.querySelectorAll<HTMLButtonElement>("[data-tab]")) o.classList.toggle("on", o === t);
      for (const p of app.querySelectorAll<HTMLElement>("[data-panel]")) p.hidden = p.dataset.panel !== t.dataset.tab;
    };
  // The sidebar on small screens.
  const side = app.querySelector<HTMLElement>("[data-dx-side]");
  const menu = app.querySelector<HTMLButtonElement>("[data-dx-menu]");
  if (menu && side) menu.onclick = () => side.classList.toggle("open");
  // "On this page" follows the reader.
  docSpy?.disconnect();
  const toc = [...app.querySelectorAll<HTMLAnchorElement>(".dx-toc [data-doc-sec]")];
  if (toc.length && "IntersectionObserver" in window) {
    docSpy = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) for (const a of toc) a.classList.toggle("on", a.dataset.docSec === top.target.id);
      },
      { rootMargin: "-72px 0px -70% 0px" },
    );
    for (const h of app.querySelectorAll(".dx-content h2[id]")) docSpy.observe(h);
  }
  // Search: pages and their sections.
  const input = app.querySelector<HTMLInputElement>("[data-dx-search]");
  const out = app.querySelector<HTMLElement>("[data-dx-results]");
  if (input && out) {
    const index = docIndex(ctx);
    const render = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) return void (out.hidden = true);
      const words = q.split(/\s+/);
      const hits = index
        .map((e) => {
          const hay = `${e.title} ${e.where} ${e.text}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) return null;
          return { e, score: (e.title.toLowerCase().includes(q) ? 0 : 1) + (e.sec ? 0.5 : 0) };
        })
        .filter((h): h is NonNullable<typeof h> => !!h)
        .sort((a, b) => a.score - b.score)
        .slice(0, 8);
      out.innerHTML = hits.length
        ? hits.map(({ e }) => `<a href="#/docs/${e.slug}${e.sec ? `/${e.sec}` : ""}"><b>${esc(e.title)}</b><span>${esc(e.where)}</span></a>`).join("")
        : `<p>No results for “${esc(input.value)}”</p>`;
      out.hidden = false;
    };
    input.oninput = render;
    input.onfocus = render;
    input.onkeydown = (e) => {
      if (e.key === "Escape") {
        input.value = "";
        out.hidden = true;
      }
      if (e.key === "Enter") out.querySelector<HTMLAnchorElement>("a")?.click();
    };
    if (!docClickWired) {
      docClickWired = true;
      document.addEventListener("click", (e) => {
        const r = app.querySelector<HTMLElement>("[data-dx-results]");
        if (r && !(e.target as HTMLElement).closest(".dx-search")) r.hidden = true;
      });
    }
  }
}

/** Billing: my seat, the seats I pay for, and Stripe. */
let backFromCheckout: { at: number } | null = null;
async function billingPage(session: Session, error = "") {
  const me = session.user.email ?? "";
  frame(session, ' / <a href="#/billing">Billing</a>', '<p class="muted">Loading…</p>');
  // Back from Checkout: confirmed with Stripe first, then the page waits a minute at most for it to show.
  const back = /[?&]session=(cs_[A-Za-z0-9_]+)/.exec(location.hash)?.[1];
  if (location.hash.includes("done=1")) {
    // Confirmed once; then the page only looks again.
    if (!backFromCheckout) {
      backFromCheckout = { at: Date.now() };
      if (back) await confirmCheckout(session.access_token, back);
    }
  } else backFromCheckout = null;
  // Each visit (not the waiting page's looks): the subscription read again from Stripe, so a cancellation or a
  // change made in Stripe shows even when its webhook didn't arrive.
  if (location.hash.includes("refresh=1")) window.history.replaceState(null, "", "#/billing");
  if (!backFromCheckout || !back) await refreshBilling(session.access_token);
  const [b, seats, referrals] = await Promise.all([myBilling(sb), mySeats(sb), myReferrals(sb)]);
  const done: "" | "waiting" | "slow" = !backFromCheckout || b?.subscribed ? "" : Date.now() - backFromCheckout.at < 60_000 ? "waiting" : "slow";
  // Shown: the address goes back to plain Billing (a reload doesn't confirm again).
  if (backFromCheckout && done !== "waiting") {
    backFromCheckout = null;
    window.history.replaceState(null, "", "#/billing");
  }
  frame(session, ' / <a href="#/billing">Billing</a>', billingHtml(b, seats, me, done, error, referrals));
  const say = (t: string) => {
    const m = $("seatMsg");
    if (m) m.textContent = t;
  };
  const add = async (email: string) => {
    if (!email.trim()) return say("Type the designer's email.");
    const { data, error: e } = await sb.rpc("add_seat", { p_email: email });
    if (e) return say(e.message);
    const said: Record<string, string> = {
      added: "",
      yours: "You already pay for that seat.",
      taken: "Someone else already pays for that designer's seat.",
      free: "That designer is on CoDesignFlo's free list: no seat needed.",
    };
    if (said[data as string]) return say(said[data as string]!);
    void billingPage(session);
  };
  on("seatAdd", () => void add($<HTMLInputElement>("seatEmail")?.value ?? ""));
  on("seatMe", () => void add(me));
  for (const btn of app.querySelectorAll<HTMLButtonElement>("[data-seat-remove]"))
    btn.onclick = async () => {
      btn.disabled = true;
      const { error: e } = await sb.rpc("remove_seat", { p_email: btn.dataset.seatRemove });
      if (e) return say(e.message);
      void billingPage(session);
    };
  const go = (which: "checkout" | "portal") => async () => {
    const b = $<HTMLButtonElement>(which === "checkout" ? "subscribe" : "portal");
    if (b) b.disabled = true;
    const e = await goToStripe(sb, which);
    if (e) void billingPage(session, e);
  };
  on("subscribe", go("checkout"));
  on("portal", go("portal"));
  // Back from Checkout: Stripe tells the service in a moment.
  if (done === "waiting") setTimeout(() => location.hash.startsWith("#/billing?done=1") && void billingPage(session), 4000);
}

/** What CoDesignFlo is and how to start, for someone not signed in (sign-in links skip it). */
function landingPage() {
  show(
    landingHtml({
      mcpUrl: MCP_URL,
      pluginUrl: cfg.pluginUrl,
      communityUrl: cfg.communityUrl,
      firstPrompt: FIRST_PROMPT,
      referred: !!storedRef(),
      signIn: SIGN_IN,
    }),
  );
  document.title = "CoDesignFlo — your app in Figma, your designs in code";
  wireScroll();
  for (const b of app.querySelectorAll<HTMLButtonElement>("[data-signin]"))
    b.onclick = () => oauth(b.dataset.signin as "figma" | "google" | "github", `${location.origin}/#/`);
}

/** admin.codesignflo.com: the admin dashboard, nothing else (a self-hosted box's name means nothing here). */
const ADMIN_HOST = !SELFHOST && location.hostname.startsWith("admin.");

/** Each route() call; a slower earlier one (still loading the session) doesn't draw over a newer page. */
let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  const legal = location.hash.split("/")[1] as LegalPage | undefined;
  if (legal && LEGAL_PAGES.includes(legal)) {
    stopListening();
    counterView("public");
    return legalPage(legal);
  }
  const [, first, doc] = location.hash.split("/");
  if (first === "docs") {
    stopListening();
    counterView("public");
    return docPage(doc && DOC_SLUGS.includes(doc) ? doc : "overview", location.hash.split("/")[3] ?? "");
  }
  if (ADMIN_HOST && !location.hash.startsWith("#/admin")) {
    location.replace("#/admin");
    return;
  }
  const { data } = await sb.auth.getSession();
  if (seq !== routeSeq) return;
  const session = data.session;
  if (!session) {
    stopListening();
    // From the plugin, the CLI or an agent, or "Sign in": straight to signing in; anyone else: the landing page.
    const [, page] = location.hash.split("/");
    // A self-hosted box has no landing page: its root is the app.
    if (SELFHOST || ADMIN_HOST || mcpRequest || deviceSignIn || (page && page !== "")) {
      counterView("private");
      return signInScreen();
    }
    counterView("landing");
    return landingPage();
  }
  // Signed in: never the visit counter (someone else's script) next to the session.
  counterView("private");
  const ref = storedRef();
  if (ref) {
    // Once per browser: whatever the answer (bound, already referred, not a new account), it's done.
    const { error } = await sb.rpc("claim_referral", { p_code: ref });
    if (!error)
      try {
        localStorage.removeItem(REF_KEY);
      } catch {
        // nothing kept anyway
      }
  }
  document.title = "CoDesignFlo";
  if (mcpRequest) return approveAgent(session);
  if (deviceSignIn) return approveDevice(session);
  const [, page, id] = location.hash.split("/");
  if (page === "connect") {
    stopListening();
    return connectPage(session);
  }
  if (page?.startsWith("admin")) {
    stopListening();
    // #/admin/<view>?days=7&sig=<signature>
    const [path, query = ""] = location.hash.slice(2).split("?");
    const view = (path!.split("/")[1] ?? "problems") as AdminView;
    const q = new URLSearchParams(query);
    const days = [7, 30, 90].includes(Number(q.get("days"))) ? Number(q.get("days")) : 7;
    frame(session, ' / <a href="#/admin">Admin</a>', '<p class="muted">Loading…</p>');
    const html = await adminPage(sb, ADMIN_VIEWS.includes(view) ? view : "problems", days, q.get("sig") ?? undefined, SELFHOST);
    frame(session, ' / <a href="#/admin">Admin</a>', html);
    if (view === "billing") wireAdminBilling(sb, () => void route());
    return;
  }
  if (page === "setup" && SELFHOST) {
    stopListening();
    return setupPage(session);
  }
  if (page?.startsWith("billing")) {
    stopListening();
    // No billing on a self-hosted box.
    if (SELFHOST) return void location.replace("#/");
    return billingPage(session);
  }
  if (page === "p" && id) return projectPage(session, decodeURIComponent(id), currentTab());
  stopListening();
  return projectsPage(session);
}

window.addEventListener("hashchange", () => void route());
// The agent tabs and copy buttons, wherever the connect card is drawn.
app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-agent], [data-copy]");
  if (!el) return;
  if (el.dataset.agent) {
    const id = el.dataset.agent;
    for (const b of app.querySelectorAll<HTMLElement>("[data-agent]")) b.classList.toggle("on", b.dataset.agent === id);
    for (const p of app.querySelectorAll<HTMLElement>("[data-panel]")) p.hidden = p.dataset.panel !== id;
    try {
      localStorage.setItem("cdf.agent", id);
    } catch {
      // private window: the choice just isn't remembered
    }
  } else if (el.dataset.copy !== undefined) {
    void navigator.clipboard?.writeText(el.dataset.copy).then(() => {
      el.textContent = "Copied";
      setTimeout(() => {
        el.textContent = "Copy";
      }, 1500);
    });
  }
});
sb.auth.onAuthStateChange((event) => {
  // Back from Figma/GitHub sign-in (the session arrives in the address).
  // After the callback returns: the client can't answer (getSession) from inside its own callback.
  if (event === "SIGNED_IN") setTimeout(() => void route(), 0);
});
// A self-hosted box: no visit counter (nothing to consent to), and not for search engines.
if (SELFHOST) {
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex, nofollow";
  document.head.append(robots);
} else initConsent();
void route();
