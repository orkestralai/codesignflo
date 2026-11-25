// The admin dashboard: what happens across projects, for CoDesignFlo's own team (admins only; the service
// refuses everyone else). Problems grouped by signature (crashes, errors, where Live differs from the app),
// reports coding agents filed, how long each step takes, and which versions projects run.
import type { SupabaseClient } from "@supabase/supabase-js";

export const ADMIN_VIEWS = ["problems", "reports", "speed", "versions", "billing"] as const;
export type AdminView = (typeof ADMIN_VIEWS)[number];

type Summary = {
  kind: string;
  signature: string;
  source: string;
  events: number;
  projects: number;
  first_at: string;
  last_at: string;
  versions: string[];
  previous: number;
};
type Timing = { source: string; signature: string; runs: number; median_ms: number; p95_ms: number; max_ms: number };
type Event = {
  id: number;
  at: string;
  project_id: string | null;
  source: string;
  kind: string;
  signature: string;
  version: string | null;
  data: Record<string, unknown>;
  content: string | null;
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const when = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const secs = (ms: number | null) => (ms == null ? "–" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

/** Whether the signed-in person is one of CoDesignFlo's admins (the header shows the link then). */
export async function isAdmin(sb: SupabaseClient): Promise<boolean> {
  const { data } = await sb.rpc("is_admin");
  return data === true;
}

/** The dashboard's page: `view`, over the last `days`; `signature` opens one problem's events. */
export async function adminPage(sb: SupabaseClient, view: AdminView, days: number, signature?: string, selfhost = false): Promise<string> {
  if (!(await isAdmin(sb))) return `<h1>Admin</h1><p class="muted">Only ${selfhost ? "this server's" : "CoDesignFlo's"} admins see this page.</p>`;
  const { data: projectRows } = await sb.rpc("admin_projects");
  const names = new Map(((projectRows ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  const project = (id: string | null) => (id ? esc(names.get(id) ?? id) : '<span class="muted">no project</span>');
  const nav = `<nav class="tabs">${ADMIN_VIEWS.map(
    // A self-hosted box has no billing: that view is its admins only.
    (v) => `<a href="#/admin/${v}?days=${days}" class="${v === view ? "on" : ""}">${selfhost && v === "billing" ? "Admins" : `${v[0]!.toUpperCase()}${v.slice(1)}`}</a>`,
  ).join("")}<span class="grow"></span>${[7, 30, 90]
    .map((d) => `<a href="#/admin/${view}?days=${d}" class="${d === days ? "on" : ""}">${d} days</a>`)
    .join("")}</nav>`;
  const head = `<h1>Admin</h1><p class="muted">What happens in every project: structure and numbers only, and a project's content where it shares it.</p>${nav}`;

  if (signature) return head + (await problem(sb, signature, days, project));
  if (view === "billing") return head + (await billing(sb, selfhost));
  if (view === "reports") return head + (await reports(sb, days, project));
  if (view === "speed") return head + (await speed(sb, days));
  if (view === "versions") return head + (await versions(sb, days, project));
  return head + (await problems(sb, days));
}

async function problems(sb: SupabaseClient, days: number): Promise<string> {
  const { data, error } = await sb.rpc("telemetry_summary", { p_days: days });
  if (error) return `<p class="err">${esc(error.message)}</p>`;
  const rows = ((data ?? []) as Summary[]).filter((r) => ["crash", "error", "gap"].includes(r.kind));
  if (!rows.length) return `<p class="muted">Nothing went wrong in the last ${days} days.</p>`;
  const trend = (r: Summary) =>
    !r.previous ? '<span class="tag warn">new</span>' : r.events > r.previous ? `↑ from ${r.previous}` : r.events < r.previous ? `↓ from ${r.previous}` : "same";
  const section = (kinds: string[], title: string, hint: string) => {
    const list = rows.filter((r) => kinds.includes(r.kind));
    return list.length
      ? `<div class="card"><h2>${title} <span class="count">${list.length}</span></h2><p class="muted">${hint}</p>
        <table class="table"><tr><th>Problem</th><th>Projects</th><th>Events</th><th>Trend</th><th>Versions</th><th>Last</th></tr>
        ${list
          .map(
            (r) => `<tr><td><span class="tag">${esc(r.source)}</span> <a href="#/admin/problems?days=${days}&sig=${encodeURIComponent(r.signature)}">${esc(r.signature)}</a></td>
              <td>${r.projects}</td><td>${r.events}</td><td>${trend(r)}</td><td>${esc(r.versions.join(", "))}</td><td class="muted">${when(r.last_at)}</td></tr>`,
          )
          .join("")}</table></div>`
      : "";
  };
  return (
    section(["crash"], "Crashes", "A command or the plugin stopped: fix first.") +
    section(["error"], "Errors", "Something couldn't be done (a page not updated, pictures not downloaded, a tool that failed).") +
    section(["gap"], "Where Live differs from the app", "CoDesignFlo/Figma gaps, by kind: the page reader's to-do list, most projects first.")
  );
}

async function problem(sb: SupabaseClient, signature: string, days: number, project: (id: string | null) => string): Promise<string> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await sb
    .from("telemetry")
    .select("id, at, project_id, source, kind, signature, version, data, content")
    .eq("signature", signature)
    .gte("at", since)
    .order("at", { ascending: false })
    .limit(100);
  if (error) return `<p class="err">${esc(error.message)}</p>`;
  const events = (data ?? []) as Event[];
  return `<div class="card"><h2>${esc(signature)}</h2><p class="muted">${events.length} event(s) in the last ${days} days (the latest 100).</p>
    <table class="table"><tr><th>When</th><th>Project</th><th>Version</th><th>Details</th></tr>${(
      await Promise.all(
        events.map(
          async (e) =>
            `<tr><td class="muted">${when(e.at)}</td><td>${project(e.project_id)}</td><td>${esc(e.version ?? "")}</td>
            <td><code>${esc(JSON.stringify(e.data))}</code>${await contentLink(sb, e.content)}</td></tr>`,
        ),
      )
    ).join("")}</table></div>`;
}

async function reports(sb: SupabaseClient, days: number, project: (id: string | null) => string): Promise<string> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await sb
    .from("telemetry")
    .select("id, at, project_id, source, kind, signature, version, data, content")
    .eq("kind", "report")
    .gte("at", since)
    .order("at", { ascending: false })
    .limit(200);
  if (error) return `<p class="err">${esc(error.message)}</p>`;
  const list = (data ?? []) as Event[];
  if (!list.length) return `<p class="muted">No reports in the last ${days} days.</p>`;
  return (
    await Promise.all(
      list.map(async (e) => {
        const d = e.data as { title?: string; what_happened?: string; expected?: string; page?: string; last?: unknown };
        return `<div class="card"><h2>${esc(d.title ?? e.signature)}</h2>
          <p class="muted">${when(e.at)} · ${project(e.project_id)} · CLI ${esc(e.version ?? "?")}${d.page ? ` · ${esc(d.page)}` : ""}</p>
          <pre>${esc(d.what_happened ?? "")}</pre>
          ${d.expected ? `<p><b>Expected:</b> ${esc(d.expected)}</p>` : ""}
          ${d.last ? `<p class="muted">Last sync: ${esc(JSON.stringify(d.last))}</p>` : ""}
          ${await contentLink(sb, e.content)}</div>`;
      }),
    )
  ).join("");
}

async function speed(sb: SupabaseClient, days: number): Promise<string> {
  const { data, error } = await sb.rpc("telemetry_timings", { p_days: days });
  if (error) return `<p class="err">${esc(error.message)}</p>`;
  const rows = (data ?? []) as Timing[];
  if (!rows.length) return `<p class="muted">No timings in the last ${days} days.</p>`;
  return `<div class="card"><h2>How long each step takes</h2><p class="muted">Slowest first (by the 95th percentile).</p>
    <table class="table"><tr><th>Step</th><th>Runs</th><th>Median</th><th>95%</th><th>Slowest</th></tr>${rows
      .map(
        (r) =>
          `<tr><td><span class="tag">${esc(r.source)}</span> ${esc(r.signature)}</td><td>${r.runs}</td><td>${secs(r.median_ms)}</td><td>${secs(r.p95_ms)}</td><td>${secs(r.max_ms)}</td></tr>`,
      )
      .join("")}</table></div>`;
}

async function versions(sb: SupabaseClient, days: number, project: (id: string | null) => string): Promise<string> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await sb
    .from("telemetry")
    .select("at, project_id, source, version, data")
    // The plugin's version: from whatever it sent last.
    .eq("source", "plugin")
    .gte("at", since)
    .order("at", { ascending: false })
    .limit(2000);
  const { data: setups } = await sb
    .from("telemetry")
    .select("at, project_id, source, version, data")
    .eq("kind", "setup")
    .gte("at", since)
    .order("at", { ascending: false })
    .limit(2000);
  if (error) return `<p class="err">${esc(error.message)}</p>`;
  type Row = { at: string; project_id: string | null; source: string; version: string | null; data: Record<string, unknown> };
  const latest = new Map<string, { cli?: Row; plugin?: Row }>();
  for (const r of [...((setups ?? []) as Row[]), ...((data ?? []) as Row[])]) {
    const k = r.project_id ?? "";
    const v = latest.get(k) ?? {};
    if (r.source === "cli" && !v.cli) v.cli = r;
    if (r.source === "plugin" && !v.plugin) v.plugin = r;
    latest.set(k, v);
  }
  if (!latest.size) return `<p class="muted">No syncs in the last ${days} days.</p>`;
  return `<div class="card"><h2>Versions in use</h2><p class="muted">The latest sync and Live update of each project.</p>
    <table class="table"><tr><th>Project</th><th>CLI</th><th>Browser</th><th>Pages</th><th>Plugin</th><th>Last sync</th></tr>${[...latest]
      .map(
        ([id, v]) =>
          `<tr><td>${project(id || null)}</td><td>${esc(v.cli?.version ?? "–")}</td><td>${esc((v.cli?.data.browser as string) ?? "–")}</td><td>${esc(v.cli?.data.screens ?? "–")}</td><td>${esc(v.plugin?.version ?? "–")}</td><td class="muted">${v.cli ? when(v.cli.at) : "–"}</td></tr>`,
      )
      .join("")}</table></div>`;
}

/** A link to an event's shared content (a signed address, valid an hour). */
async function contentLink(sb: SupabaseClient, path: string | null): Promise<string> {
  if (!path) return "";
  const { data } = await sb.storage.from("telemetry").createSignedUrl(path, 3600);
  return data?.signedUrl ? `<a href="${esc(data.signedUrl)}" target="_blank" rel="noopener">Shared content</a>` : "";
}

type BillingRow = {
  user_id: string;
  email: string;
  state: string;
  seats: number;
  status: string | null;
  sends_used: number;
  current_period_end: string | null;
  projects: number;
};

/** Accounts: each one's designer seat and the seats they pay for; the free list (never need a seat). */
async function billing(sb: SupabaseClient, selfhost = false): Promise<string> {
  const [{ data: rows, error }, { data: list }, { data: people }] = await Promise.all([
    sb.rpc("admin_billing"),
    sb.from("billing_whitelist").select("email, note, added_at").order("added_at", { ascending: false }),
    sb.rpc("admin_people"),
  ]);
  if (error) return `<p class="err">${esc(error.message)}</p>`;
  const owners = ((rows ?? []) as BillingRow[]).filter((o) => o.seats || o.status || o.state !== "trial" || o.projects);
  const free = (list ?? []) as { email: string; note: string | null; added_at: string }[];
  const tag = (st: string) => `<span class="tag${st === "unpaid" ? " warn" : ""}">${esc(st)}</span>`;
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "");
  const paying = owners.filter((o) => o.status === "active" || o.status === "trialing" || o.status === "past_due").reduce((n, o) => n + o.seats, 0);
  const admins = ((people ?? []) as { email: string; admin: boolean; added_at: string }[]).filter((p) => p.admin);
  const adminsCard = `<div class="card"><h2>Admins <span class="count">${admins.length}</span></h2>
      <p class="muted">${selfhost ? "Admins see this dashboard and add other admins. Someone becomes an admin after creating their account on this server." : "Admins see this dashboard and never pay. Someone becomes an admin after signing in to CoDesignFlo once."}</p>
      <div class="row"><input id="adEmail" type="email" placeholder="email"><button id="adAdd" class="primary">Add admin</button></div>
      <p id="adMsg" class="muted"></p>
      <table class="table"><tr><th>Email</th><th>Since</th><th></th></tr>${admins
        .map(
          (a) =>
            `<tr><td>${esc(a.email)}</td><td class="muted">${date(a.added_at)}</td><td>${admins.length > 1 ? `<button class="small" data-ad-remove="${esc(a.email)}">Remove</button>` : ""}</td></tr>`,
        )
        .join("")}</table></div>`;
  if (selfhost) return adminsCard;
  return `${adminsCard}
    <div class="card"><h2>Free list <span class="count">${free.length}</span></h2>
      <p class="muted">These emails never need a designer seat.</p>
      <div class="row"><input id="wlEmail" type="email" placeholder="email"><input id="wlNote" placeholder="note (optional)"><button id="wlAdd" class="primary">Add</button></div>
      <p id="wlMsg" class="muted"></p>
      <table class="table"><tr><th>Email</th><th>Note</th><th>Added</th><th></th></tr>${free
        .map(
          (w) =>
            `<tr><td>${esc(w.email)}</td><td class="muted">${esc(w.note ?? "")}</td><td class="muted">${date(w.added_at)}</td><td><button class="small" data-wl-remove="${esc(w.email)}">Remove</button></td></tr>`,
        )
        .join("")}</table></div>
    <div class="card"><h2>Accounts <span class="count">${owners.length}</span></h2>
      <p class="muted">${paying} paid seat${paying === 1 ? "" : "s"} on active subscriptions (launch-price coupons aren't counted here). State is the account's own seat: active, trial (free sends left), unpaid (free sends used) or whitelisted; Seats are those it pays for; Sends are its sends to dev.</p>
      <table class="table"><tr><th>Account</th><th>State</th><th>Seats paid</th><th>Projects</th><th>Stripe</th><th>Sends</th><th>Renews</th></tr>${owners
        .map(
          (o) =>
            `<tr><td>${esc(o.email)}</td><td>${tag(o.state)}</td><td>${o.seats}</td><td>${o.projects}</td><td class="muted">${esc(o.status ?? "–")}</td><td class="muted">${o.sends_used}</td><td class="muted">${date(o.current_period_end)}</td></tr>`,
        )
        .join("")}</table></div>`;
}

/** The admins' and the free list's buttons (after the billing view is drawn). */
export function wireAdminBilling(sb: SupabaseClient, redraw: () => void) {
  const say = (id: string) => (t: string) => {
    const m = document.getElementById(id);
    if (m) m.textContent = t;
  };
  const msg = say("wlMsg");
  const adMsg = say("adMsg");
  const adAdd = document.getElementById("adAdd");
  if (adAdd)
    adAdd.onclick = async () => {
      const email = (document.getElementById("adEmail") as HTMLInputElement).value.trim();
      if (!email.includes("@")) return adMsg("Give an email address.");
      const { error } = await sb.rpc("admin_add", { p_email: email });
      if (error) return adMsg(error.message);
      redraw();
    };
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-ad-remove]"))
    b.onclick = async () => {
      if (!confirm(`${b.dataset.adRemove} will no longer be an admin (they stay on the free list).`)) return;
      b.disabled = true;
      const { error } = await sb.rpc("admin_remove", { p_email: b.dataset.adRemove! });
      if (error) return adMsg(error.message);
      redraw();
    };
  const add = document.getElementById("wlAdd");
  if (add)
    add.onclick = async () => {
      const email = (document.getElementById("wlEmail") as HTMLInputElement).value.trim();
      const note = (document.getElementById("wlNote") as HTMLInputElement).value.trim();
      if (!email.includes("@")) return msg("Give an email address.");
      const { error } = await sb.rpc("free_add", { p_email: email, p_note: note || null });
      if (error) return msg(error.message);
      redraw();
    };
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-wl-remove]"))
    b.onclick = async () => {
      b.disabled = true;
      const { error } = await sb.rpc("free_remove", { p_email: b.dataset.wlRemove! });
      if (error) return msg(error.message);
      redraw();
    };
}
