// Notifications: the database puts facts worth telling someone about in an outbox (designer sent something,
// developer has a question, a proposal closed, Live updated or failed); this sends them to the project's Slack,
// and by email (SMTP, e.g. Gmail, or Resend) the ones someone has to act on, then marks them sent. Called by the database (pg_net) when
// something lands, and by a cron as a fallback.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTransport } from "nodemailer";
import { message } from "./messages.ts";

export { message };

export type NotifyConfig = {
  /** The web app (links in messages). */
  web: string;
  /** An SMTP server to send emails through (e.g. Gmail with an app password); it wins over Resend. */
  smtp?: { host: string; port: number; secure: boolean; user?: string; pass?: string };
  /** Resend API key. Without it or SMTP, no emails (Slack still works). */
  resendKey?: string;
  /** Sender, e.g. "CoDesignFlo <contact@orkestralai.com>" (NOTIFY_FROM). */
  from?: string;
  /** The hosted MCP's address, for developers' invitations (default: <web>/mcp). */
  mcp?: string;
  /** Where designers get the Figma plugin (invitations); without it, they're told to ask whoever invited them. */
  pluginUrl?: string;
  /** Resend's API (tests point it at a local server). */
  resendUrl?: string;
  /** A self-hosted box: no referrals; without SMTP, invitations aren't emailed (the invitee signs up themselves). */
  selfhost?: boolean;
};

type Outbox = {
  id: number;
  project_id: string;
  kind: string;
  component: string;
  by: string;
  body: Record<string, unknown>;
  attempts: number;
};
type Person = { email: string | null; role: string; side: "design" | "code" | "both"; notify: boolean };

/** Who hears about each kind of fact: the other side of the hand-off. */
const AUDIENCE: Record<string, "design" | "code" | "slack"> = {
  // Emailed: what someone has to act on (a design to build, a question to answer).
  ready: "code",
  designed_new: "code",
  review_answered: "code",
  sent_back: "design",
  dev_reviewed: "design",
  // Routine (building started, done in code, Live updated or not): the project's Slack only; the plugin and the
  // developer's status show them anyway.
  building: "slack",
  closed: "slack",
  live_applied: "slack",
  live_failed: "slack",
  // The person invited gets their own email (below); the project's Slack hears about it.
  invited: "slack",
};

/**
 * Members with their side. Roles say designer or developer; an admin (whoever started the project) is on the
 * side of how they sign in — Figma (or started the project from Figma): design, GitHub: code — or both when it
 * can't be told (Google, an email link).
 */
async function people(db: SupabaseClient, project: string): Promise<Person[]> {
  const { data: members } = await db.from("project_members").select("user_id, role").eq("project_id", project);
  const ids = ((members ?? []) as { user_id: string; role: string }[]).map((m) => m.user_id);
  if (!ids.length) return [];
  const { data: profiles } = await db.from("profiles").select("id, email, figma_user_id, github_user_id, design_side, notify_email").in("id", ids);
  const byId = new Map(
    (
      (profiles ?? []) as {
        id: string;
        email: string | null;
        figma_user_id: string | null;
        github_user_id: string | null;
        design_side: boolean | null;
        notify_email: boolean | null;
      }[]
    ).map((p) => [p.id, p]),
  );
  return ((members ?? []) as { user_id: string; role: string }[]).map((m) => {
    const p = byId.get(m.user_id);
    const side: Person["side"] =
      m.role === "designer"
        ? "design"
        : m.role === "developer"
          ? "code"
          : (p?.figma_user_id || p?.design_side) && !p.github_user_id
            ? "design"
            : p?.github_user_id && !p.figma_user_id && !p.design_side
              ? "code"
              : "both";
    return { email: p?.email ?? null, role: m.role, side, notify: p?.notify_email ?? true };
  });
}

async function post(url: string, init: RequestInit): Promise<void> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/** Whether this service can send emails at all. */
export const canEmail = (cfg: NotifyConfig) => !!cfg.from && (!!cfg.smtp || !!cfg.resendKey);

/** Sends one email: through SMTP when it's set up, else Resend. */
export async function sendMail(cfg: NotifyConfig, m: { to: string[]; subject: string; text: string; html?: string }): Promise<void> {
  if (cfg.smtp) {
    const { host, port, secure, user, pass } = cfg.smtp;
    await createTransport({ host, port, secure, ...(user ? { auth: { user, pass } } : {}) }).sendMail({ from: cfg.from, ...m });
    return;
  }
  await post(cfg.resendUrl ?? "https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.resendKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: cfg.from, ...m }),
  });
}

export const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export type Invitation = { subject: string; text: string; html: string };

/** The logo in emails: the site's icon, from the public site (an email client loads it from there). */
export const EMAIL_LOGO = "https://codesignflo.com/icon-512.png";
const BLUE = "#2563eb";

/** An email's HTML: the CoDesignFlo header (logo and name), the content, and who it's from. */
export function emailHtml(inner: string): string {
  return `<div style="font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1e1e1e;max-width:560px">
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td style="vertical-align:middle"><img src="${EMAIL_LOGO}" width="36" height="36" alt="" style="display:block;border:0"></td><td style="vertical-align:middle;padding-left:8px;font-size:18px;font-weight:700;letter-spacing:-0.2px;color:#0a0a0a">CoDesignFlo</td></tr></table>
${inner}
<p style="color:#8a8a8a;font-size:12px;margin-top:28px;border-top:1px solid #eee;padding-top:12px">CoDesignFlo by OrkestralAI · <a href="https://codesignflo.com" style="color:#8a8a8a">codesignflo.com</a></p></div>`;
}

/** A button in an email. */
export const emailButton = (href: string, label: string) =>
  `<p><a href="${escHtml(href)}" style="display:inline-block;background:${BLUE};color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:600">${escHtml(label)}</a></p>`;


/**
 * The invitation email: who invited them to what, and the steps for their role — developers connect their
 * coding agent, designers open the Figma plugin (admins get both). They join by signing in with this email.
 */
export function invitationEmail(o: {
  project: string;
  projectId: string;
  by: string;
  email: string;
  role: string;
  added: boolean;
  web: string;
  mcp: string;
  pluginUrl?: string;
  /** A designer inviting a designer with no account yet (a referral): their second month is free. */
  referral?: boolean;
  /** A self-hosted box that doesn't prove emails: the invitation's sign-up code, needed to make the account. */
  signupCode?: string;
}): Invitation {
  const dev = o.role === "developer" || o.role === "admin";
  const design = o.role === "designer" || o.role === "admin";
  const steps: { text: string; code?: string; link?: string }[] = [];
  if (o.signupCode && !o.added)
    steps.push({ text: `Create your account at ${o.web} with this email (${o.email}) and this sign-up code:`, code: o.signupCode });
  if (dev)
    steps.push(
      { text: "Connect your coding agent (Claude Code, Cursor, VS Code, Windsurf, Codex, Gemini…) to CoDesignFlo — the steps for each agent:", link: `${o.web}/#/connect` },
      { text: "Its MCP server is:", code: o.mcp },
      { text: `When the agent asks you to sign in, use an account with this email (${o.email}).` },
      { text: "Then, in your app's folder, ask the agent:", code: "Connect this app to CoDesignFlo" },
    );
  if (design)
    steps.push(
      o.pluginUrl
        ? { text: "Install the CoDesignFlo Figma plugin:", link: o.pluginUrl }
        : { text: `Get the CoDesignFlo Figma plugin from ${o.by} (it's installed in the Figma desktop app).` },
      { text: `Open the team's Figma file, run the plugin and sign in with this email (${o.email}).` },
    );
  const open = `${o.web}/#/p/${encodeURIComponent(o.projectId)}`;
  const head = o.added
    ? `${o.by} added you to ${o.project} on CoDesignFlo as ${o.role === "admin" ? "an admin" : `a ${o.role}`}.`
    : `${o.by} invited you to ${o.project} on CoDesignFlo as ${o.role === "admin" ? "an admin" : `a ${o.role}`}.`;
  const about = "CoDesignFlo keeps a Figma file and the app's code in step: designers send designs from Figma, developers' coding agents build them, and Figma shows what the code does.";
  const referral = o.referral && o.role === "designer" && !o.added ? "Your second month is free when you start paying." : "";
  const text = [
    head,
    "",
    about,
    ...(referral ? ["", referral] : []),
    "",
    "To get started:",
    ...steps.map((s, i) => `${i + 1}. ${s.text}${s.link ? ` ${s.link}` : ""}${s.code ? `\n   ${s.code}` : ""}`),
    "",
    `The project: ${open}`,
    "",
    `You get this email because ${o.by} invited ${o.email}. If you didn't expect it, ignore it: nothing happens until you sign in.`,
  ].join("\n");
  const html = emailHtml(`<p><b>${escHtml(head)}</b></p><p style="color:#6b6b6b">${escHtml(about)}</p>${referral ? `<p>${escHtml(referral)}</p>` : ""}<p>To get started:</p><ol>${steps
    .map(
      (s) =>
        `<li style="margin-bottom:8px">${escHtml(s.text)}${s.link ? ` <a href="${escHtml(s.link)}">${escHtml(s.link)}</a>` : ""}${
          s.code ? `<br><code style="background:#f2f2f2;padding:2px 6px;border-radius:4px">${escHtml(s.code)}</code>` : ""
        }</li>`,
    )
    .join("")}</ol>
${emailButton(open, `Open ${o.project}`)}
<p style="color:#6b6b6b;font-size:12px">You get this email because ${escHtml(o.by)} invited ${escHtml(o.email)}. If you didn't expect it, ignore it: nothing happens until you sign in.</p>`);
  return { subject: o.added ? `You're in ${o.project} on CoDesignFlo` : `${o.by} invited you to ${o.project} on CoDesignFlo`, text, html };
}

/** Sends what's waiting in the outbox (oldest first, a batch at a time); returns how many were handled. */
export async function drain(db: SupabaseClient, cfg: NotifyConfig, limit = 50): Promise<{ sent: number; failed: number }> {
  const { data, error } = await db
    .from("notifications")
    .select("id, project_id, kind, component, by, body, attempts")
    .is("sent_at", null)
    .lt("attempts", 5)
    .order("id")
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Outbox[];
  const projects = new Map<string, { name: string; people: Person[]; slack: string | null; demo: boolean }>();
  let sent = 0;
  let failed = 0;
  for (const n of rows) {
    // Claim it first: two drains at once (a ping and the cron) don't send it twice.
    const { data: claimed } = await db
      .from("notifications")
      .update({ attempts: n.attempts + 1 })
      .eq("id", n.id)
      .eq("attempts", n.attempts)
      .is("sent_at", null)
      .select("id");
    if (!claimed?.length) continue;
    try {
      let p = projects.get(n.project_id);
      if (!p) {
        const [{ data: proj }, { data: integ }, team] = await Promise.all([
          db.from("projects").select("name, settings").eq("id", n.project_id).maybeSingle(),
          db.from("project_integrations").select("slack_webhook").eq("project_id", n.project_id).maybeSingle(),
          people(db, n.project_id),
        ]);
        p = {
          name: (proj?.name as string | undefined) ?? n.project_id,
          people: team,
          slack: (integ?.slack_webhook as string | null | undefined) ?? null,
          demo: (proj?.settings as { demo?: boolean } | null | undefined)?.demo === true,
        };
        projects.set(n.project_id, p);
      }
      // The guided demo tells nobody (its developer, Alex, is simulated): done, nothing sent.
      if (p.demo) {
        await db.from("notifications").update({ sent_at: new Date().toISOString(), error: null }).eq("id", n.id);
        sent++;
        continue;
      }
      const line = message(n);
      const link = `${cfg.web}/#/p/${encodeURIComponent(n.project_id)}`;
      const audience = AUDIENCE[n.kind] ?? "slack";
      const sends: Promise<void>[] = [];
      if (p.slack)
        sends.push(
          post(p.slack, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: `*${p.name}*: ${line} (<${link}|open>)` }),
          }),
        );
      // An invitation: one email to the person invited, whatever the project's members' settings; how it went
      // is recorded on the invitation (the People lists show it).
      let invitation: Promise<void> | null = null;
      if (n.kind === "invited") {
        const email = String(n.body.email ?? "");
        const mark = (patch: Record<string, unknown>) =>
          db.from("invitations").update(patch).eq("project_id", n.project_id).eq("email", email).then(() => undefined);
        if (!canEmail(cfg))
          await mark({
            email_status: "failed",
            email_error: cfg.selfhost
              ? `this server doesn't send emails — tell them yourself: they create their account at ${cfg.web} with this email and the sign-up code you see in People at ${cfg.web}`
              : "emails aren't set up on this service yet — tell them yourself",
          });
        else {
          // A box that doesn't prove emails: the invitation's code goes in its email (the address gets it).
          const signupCode = cfg.selfhost
            ? ((await db.from("invitation_codes").select("code").eq("project_id", n.project_id).eq("email", email).maybeSingle()).data?.code as
                | string
                | undefined)
            : undefined;
          const proof = cfg.selfhost && signupCode ? (await db.rpc("selfhost_email_proof")).data === true : false;
          const m = invitationEmail({
            project: p.name,
            projectId: n.project_id,
            by: n.by,
            email,
            role: String(n.body.role ?? "developer"),
            added: n.body.added === true,
            web: cfg.web,
            mcp: cfg.mcp ?? `${cfg.web}/mcp`,
            pluginUrl: cfg.pluginUrl,
            referral: !cfg.selfhost && n.body.referral === true,
            signupCode: signupCode && !proof ? signupCode : undefined,
          });
          invitation = sendMail(cfg, { to: [email], subject: m.subject, text: m.text, html: m.html }).then(
            () => mark({ email_status: "sent", email_error: null }),
            async (e: Error) => {
              await mark({ email_status: "failed", email_error: e.message.slice(0, 300) });
              throw e;
            },
          );
          sends.push(invitation);
        }
      } else if (audience !== "slack" && canEmail(cfg)) {
        const to = [
          ...new Set(
            p.people
              .filter((x) => x.notify && x.email && (x.side === audience || x.side === "both"))
              // Not the person who did it (when their name is their email).
              .filter((x) => x.email!.toLowerCase() !== n.by.toLowerCase())
              .map((x) => x.email!),
          ),
        ];
        if (to.length)
          sends.push(
            sendMail(cfg, {
              to,
              subject: `${p.name}: ${line.slice(0, 120)}`,
              text: `${line}\n\nOpen the project: ${link}\n\nYou get these because you're in ${p.name} on CoDesignFlo. Turn emails off in the project's settings.`,
              html: emailHtml(
                `<p>${escHtml(line)}</p>${emailButton(link, `Open ${p.name}`)}<p style="color:#6b6b6b;font-size:12px">You get these because you're in ${escHtml(p.name)} on CoDesignFlo. Turn emails off in the project's settings.</p>`,
              ),
            }),
          );
      }
      const results = await Promise.allSettled(sends);
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String((r.reason as Error).message ?? r.reason));
      // Sent when every channel took it; a failing one is retried (up to 5 attempts).
      await db
        .from("notifications")
        .update(errors.length ? { error: errors.join("; ").slice(0, 1000) } : { sent_at: new Date().toISOString(), error: null })
        .eq("id", n.id);
      errors.length ? failed++ : sent++;
    } catch (e) {
      failed++;
      await db
        .from("notifications")
        .update({ error: (e as Error).message.slice(0, 1000) })
        .eq("id", n.id);
    }
  }
  return { sent, failed };
}
