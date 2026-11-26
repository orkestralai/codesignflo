// The panel's connection to the CoDesignFlo service (cloud mode). Runs in the UI iframe (it has fetch).
// Sign-in is a device code: the panel shows a code, the browser page approves it, the panel receives the
// session — no password is ever typed in Figma. The session (a refresh token) is kept in the plugin's
// clientStorage; the designer's actions are sent to the shared history as they happen.

import type { TelemetryEvent } from "@codesignflo/core";
import { CANON_VERSION, type LedgerEvent, type Raw, readEvent, type UpdateInput, unpackBundle } from "@codesignflo/core";
import { ProjectSignal } from "./realtime";

/** mode "selfhost": a team's own CoDesignFlo box (no billing: its service reports every seat as paid). */
export type Service = { url: string; anon: string; web: string; mode?: "cloud" | "selfhost" };
/** Someone in the project, or invited to it (with how their invitation email went). */
export type Person = {
  email: string | null;
  role: string;
  pending: boolean;
  email_status?: "queued" | "sent" | "failed" | null;
  email_error?: string | null;
  last_sent_at?: string | null;
};
export type CloudUser = { id: string; email: string | null; figmaId: string | null };

export class Cloud {
  user: CloudUser | null = null;
  /** The code to show while waiting for the approval in the browser. */
  code: string | null = null;
  /** This file's project in the service, when the signed-in person is a member. */
  project: { id: string; name: string; liveBranch: string | null; hasCode: boolean; demo: boolean } | null = null;
  /** This Figma file's name (recorded on the project, so the developer's side knows it has a file). */
  fileName = "";
  /** findProject has answered at least once (until then, "not a member" isn't known). */
  looked = false;
  /** What the developer's latest sync found for each proposal (by claim), predicted from the code. */
  checks = new Map<string, { done: number; total: number; branch: string | null; commit: string; at: string }>();
  error = "";
  /** Something happened in the project (realtime): the panel checks for updates now, not at its next check. */
  onSignal: () => void = () => undefined;
  private signal: ProjectSignal | null = null;
  private access: { token: string; until: number } | null = null;
  private queue: unknown[] = [];
  private projectId: string | null = null;

  constructor(
    readonly service: Service,
    private refresh: string | null,
    private readonly saveSession: (refreshToken: string | null) => void,
    /** The sign-in as saved now: the plugin open in another file may have renewed it meanwhile. */
    private readonly loadSession: () => Promise<string | null>,
    private readonly openUrl: (url: string) => void,
    private readonly figmaUserId: string | null,
    private readonly changed: () => void,
  ) {}

  private headers(auth = true): Record<string, string> {
    return {
      apikey: this.service.anon,
      "content-type": "application/json",
      ...(auth && this.access ? { authorization: `Bearer ${this.access.token}` } : {}),
    };
  }

  private async rpc<T>(name: string, body: unknown, auth = false): Promise<T> {
    const r = await fetch(`${this.service.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: this.headers(auth),
      body: JSON.stringify(body),
    });
    // A function that returns nothing answers with an empty body (204): no JSON to read.
    const raw = await r.text();
    const data = raw ? (JSON.parse(raw) as unknown) : null;
    if (!r.ok) throw new Error((data as { message?: string } | null)?.message ?? `service error ${r.status}`);
    return data as T;
  }

  /** Exchanges the saved refresh token for an access token (rotating it). */
  private renewing: Promise<boolean> | null = null;
  /** One renewal at a time; and from the latest saved sign-in (see below). */
  private renew(): Promise<boolean> {
    this.renewing ??= this.renewNow().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async renewNow(): Promise<boolean> {
    // The plugin open in several files shares one saved sign-in. Each renewal replaces it; renewing with a
    // token another copy already replaced looks like a stolen token, and the service revokes the sign-in
    // everywhere (it signed everyone out). So start from what is saved now.
    const saved = await this.loadSession().catch(() => null);
    if (saved && saved !== this.refresh) this.refresh = saved;
    if (!this.refresh) return false;
    const r = await fetch(`${this.service.url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: this.headers(false),
      body: JSON.stringify({ refresh_token: this.refresh }),
    });
    if (!r.ok) {
      // Renewed by another copy at the same moment: try once more with what it saved.
      const again = await this.loadSession().catch(() => null);
      if (again && again !== this.refresh) {
        this.refresh = again;
        return this.renewNow();
      }
      this.signOut("Your sign-in expired — sign in again.");
      return false;
    }
    const s = (await r.json()) as { access_token: string; refresh_token: string; expires_in: number; user: { id: string; email?: string } };
    this.access = { token: s.access_token, until: Date.now() + (s.expires_in - 60) * 1000 };
    this.refresh = s.refresh_token;
    this.saveSession(this.refresh);
    this.signal?.setToken(s.access_token);
    this.user = { id: s.user.id, email: s.user.email ?? null, figmaId: await this.figmaIdentity() };
    // Signed in with Figma: it must be the Figma user in front of the plugin (no borrowed sessions).
    if (this.user.figmaId && this.figmaUserId && this.user.figmaId !== this.figmaUserId) {
      this.signOut("This sign-in belongs to another Figma account. Sign in with the account you're using in Figma.");
      return false;
    }
    return true;
  }

  private async figmaIdentity(): Promise<string | null> {
    const r = await fetch(`${this.service.url}/auth/v1/user`, { headers: this.headers() });
    if (!r.ok) return null;
    const u = (await r.json()) as {
      identities?: { provider: string; id?: string; identity_data?: { provider_id?: string; sub?: string } }[];
    };
    const f = u.identities?.find((i) => i.provider === "figma");
    return f ? (f.identity_data?.provider_id ?? f.identity_data?.sub ?? f.id ?? null) : null;
  }

  private async ready(): Promise<boolean> {
    if (this.access && Date.now() < this.access.until) return true;
    return this.renew();
  }

  /** On start: restore a saved sign-in and find this file's project. */
  async restore(projectId: string | null) {
    this.projectId = projectId;
    if (this.refresh && (await this.renew())) await this.findProject();
    this.changed();
  }

  async signIn() {
    this.error = "";
    const [req] = await this.rpc<{ device_code: string; user_code: string }[]>("start_login", { p_client: "plugin" });
    if (!req) throw new Error("couldn't start sign-in");
    this.code = `${req.user_code.slice(0, 4)}-${req.user_code.slice(4)}`;
    this.changed();
    this.openUrl(`${this.service.web}/?code=${req.user_code}`);
    for (let waited = 0; waited < 600_000 && this.code; waited += 2000) {
      await new Promise((r) => setTimeout(r, 2000));
      let token: string | null;
      try {
        token = await this.rpc<string | null>("poll_login", { p_device_code: req.device_code });
      } catch (e) {
        this.code = null;
        this.error = (e as Error).message;
        break;
      }
      if (token) {
        this.code = null;
        this.refresh = token;
        if (await this.renew()) await this.findProject();
        break;
      }
    }
    this.code = null;
    this.changed();
  }

  cancelSignIn() {
    this.code = null;
    this.changed();
  }

  signOut(reason = "") {
    this.user = null;
    this.access = null;
    this.refresh = null;
    this.project = null;
    this.listen();
    this.error = reason;
    this.saveSession(null);
    this.changed();
  }

  private lastCheck = 0;
  /**
   * Signed in but not (yet) in this file's project: check again, at most every 10 s — someone may have just
   * invited this person (no restart needed).
   */
  async recheck() {
    if (!this.user || this.project || Date.now() - this.lastCheck < 10_000) return;
    this.lastCheck = Date.now();
    await this.findProject();
    if (this.project) this.changed();
  }

  /** Is this file's project in the service, and is the signed-in person a member? */
  async findProject() {
    this.project = null;
    this.listen();
    if (!(await this.ready())) return;
    // Invitations to this person's email turn into memberships here (no link to click).
    await this.rpc("accept_invitations", {}, true).catch(() => 0);
    if (!this.projectId) return;
    try {
      await this.lookUp();
    } finally {
      this.looked = true;
    }
  }

  private async lookUp() {
    const r = await fetch(
      `${this.service.url}/rest/v1/projects?id=eq.${encodeURIComponent(this.projectId ?? "")}&select=id,name,settings,repo_root_commit`,
      {
        headers: this.headers(),
      },
    );
    const rows = r.ok
      ? ((await r.json()) as {
          id: string;
          name: string;
          settings?: { liveBranch?: string; file?: { name?: string }; demo?: boolean };
          repo_root_commit: string | null;
        }[])
      : [];
    const row = rows[0];
    this.project = row
      ? {
          id: row.id,
          name: row.name,
          liveBranch: row.settings?.liveBranch ?? null,
          hasCode: !!row.repo_root_commit,
          demo: row.settings?.demo === true,
        }
      : null;
    // The project's file is recorded (developer-first projects learn they have a file), and kept up to date
    // when the file is renamed in Figma (the project list said "uses" the old name).
    if (row && this.fileName && row.settings?.file?.name !== this.fileName)
      await this.rpc("link_file", { p_project: row.id, p_file_name: this.fileName }, true).catch(() => 0);
    this.listen();
    this.role = this.project ? await this.rpc<string | null>("my_role", { p_project: this.project.id }, true).catch(() => null) : null;
    if (this.project) {
      await this.refreshBilling();
      await this.flush();
      await this.refreshChecks();
    }
  }

  /** Listens to this project's realtime signal (and stops when there is no project any more). */
  private listen() {
    const id = this.project?.id ?? null;
    if (this.signal && id && this.listening === id) return;
    this.signal?.close();
    this.signal = null;
    this.listening = id;
    if (!id) return;
    this.signal = new ProjectSignal({
      url: this.service.url,
      anon: this.service.anon,
      project: id,
      token: () => this.access?.token ?? null,
      onSignal: () => this.onSignal(),
    });
  }
  private listening: string | null = null;

  /** The project's people (for the getting-started guide: has a developer joined?). */
  team: Person[] | null = null;

  /** Reloads the developer's latest checks (and the team); returns whether anything changed. */
  async refreshChecks(): Promise<boolean> {
    if (!this.project) return false;
    const team = await this.people().catch(() => null);
    const teamChanged = JSON.stringify(team) !== JSON.stringify(this.team);
    if (team) this.team = team;
    const rows = await this.rest<{ claim_id: string; code_check: NonNullable<ReturnType<Cloud["checks"]["get"]>> }[]>(
      `proposals?project_id=eq.${encodeURIComponent(this.project.id)}&code_check=not.is.null&select=claim_id,code_check`,
    ).catch(() => null);
    if (!rows) return false;
    const before = JSON.stringify([...this.checks]);
    this.checks = new Map(rows.map((r) => [r.claim_id, r.code_check]));
    return JSON.stringify([...this.checks]) !== before || teamChanged;
  }

  /** The file's id changed (it was just set up): look for its project again. */
  async fileChanged(projectId: string | null) {
    if (projectId === this.projectId) return;
    this.projectId = projectId;
    await this.findProject();
    this.changed();
  }

  /**
   * A designer starts a project from this file before any code exists (their free project); the developer
   * links the codebase later when they connect their app. Returns the new project's id.
   */
  async createProject(name: string): Promise<string> {
    if (!(await this.ready())) throw new Error("sign in first");
    return this.rpc<string>("create_project", { p_name: name, p_root_commit: null, p_settings: {} }, true);
  }

  /**
   * The guided demo: my demo project (a sample app and Alex, a simulated developer), made by the service the
   * first time (and again after quitting). Returns its id; the file is set up for it like any project.
   */
  async startDemo(): Promise<string> {
    const body = await this.demoCall<{ projectId?: string }>("start");
    if (!body.projectId) throw new Error("couldn't start the demo — try again in a moment");
    return body.projectId;
  }

  /** "Quit demo": my demo project goes, with everything done in it. */
  async quitDemo(): Promise<void> {
    await this.demoCall("quit");
  }

  /** Moves Alex, the demo's simulated developer, on: what he did, and whether anything still waits on him. */
  async demoTick(): Promise<{ did: string; waiting: boolean }> {
    return this.demoCall("tick");
  }

  private async demoCall<T>(what: "start" | "quit" | "tick"): Promise<T> {
    if (!(await this.ready())) throw new Error("sign in first");
    const r = await fetch(`${this.service.web}/api/demo/${what}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.access?.token ?? ""}` },
      body: "{}",
    });
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `couldn't ${what === "quit" ? "quit" : "run"} the demo — try again in a moment`);
    return body;
  }

  /**
   * This file was just linked to a project: its latest Live comes again (the update was applied already, in
   * another file, and the new file stayed empty until the developer's next sync). False when there's nothing to
   * send or one is on its way; a service without resend_live yet: false too.
   */
  async resendLive(projectId: string): Promise<boolean> {
    if (!(await this.ready())) return false;
    return this.rpc<boolean>("resend_live", { p_project: projectId }, true).catch(() => false);
  }

  /** My projects: which have their code, and which already use a Figma file. */
  async myProjects(): Promise<{ project_id: string; name: string; role: string; has_code: boolean; file_name: string | null }[]> {
    if (!this.user || !(await this.ready())) return [];
    return this.rpc("my_projects", {}, true);
  }

  /** The project's members and pending invitations. */
  async people(): Promise<Person[]> {
    if (!this.project || !(await this.ready())) return [];
    return this.rpc("project_people", { p_project: this.project.id }, true);
  }

  /** Deletes a project (its owner only) with all its history; the free project can then be used again. */
  async deleteProject(id: string): Promise<void> {
    if (!(await this.ready())) throw new Error("sign in first");
    await this.rpc("delete_project", { p_project: id }, true);
    if (this.project?.id === id) this.project = null;
  }

  /** Invites someone by email: added now if they have an account, otherwise when they first sign in. */
  async invite(email: string, role: "developer" | "designer" | "admin"): Promise<"added" | "invited" | "member" | "role_changed"> {
    if (!this.project || !(await this.ready())) throw new Error("sign in first");
    const r = await this.rpc<"added" | "invited" | "member" | "role_changed">(
      "invite",
      { p_project: this.project.id, p_email: email, p_role: role },
      true,
    );
    await this.sendNow();
    return r;
  }

  /** Sends a pending invitation's email again (limited by the service: once every couple of minutes). */
  async resendInvitation(email: string): Promise<void> {
    if (!this.project || !(await this.ready())) throw new Error("sign in first");
    await this.rpc("resend_invitation", { p_project: this.project.id, p_email: email }, true);
    await this.sendNow();
  }

  /**
   * Asks the service to send what's queued now (the invitation just made) instead of when the database pings
   * it. Best effort: the email goes out either way.
   */
  private async sendNow() {
    await fetch(`${this.service.web}/api/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.access?.token ?? ""}` },
    }).catch(() => undefined);
  }

  /**
   * What applying an update was like, for CoDesignFlo's team (telemetry: structure and numbers, no content;
   * see packages/core/src/telemetry.ts). Never in the way: failures are dropped.
   */
  async telemetry(events: TelemetryEvent[]) {
    if (!events.length || !(await this.ready().catch(() => false))) return;
    await fetch(`${this.service.url}/rest/v1/telemetry`, {
      method: "POST",
      headers: { ...this.headers(), prefer: "return=minimal" },
      body: JSON.stringify(
        events.map((e) => ({
          project_id: e.project ?? this.project?.id ?? null,
          source: "plugin",
          kind: e.kind,
          signature: e.signature,
          version: e.version ?? null,
          data: e.data ?? {},
        })),
      ),
    }).catch(() => undefined);
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!(await this.ready())) throw new Error("signed out");
    const r = await fetch(`${this.service.url}/rest/v1/${path}`, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
    const text = await r.text();
    if (!r.ok) throw new Error((text && (JSON.parse(text) as { message?: string }).message) || `service error ${r.status}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** The project's history, oldest first (for applying an update). */
  async events(): Promise<LedgerEvent[]> {
    const out: LedgerEvent[] = [];
    for (let from = 0; ; from += 1000) {
      const rows = await this.rest<
        { id: string; at: string; by: string; component: string; kind: string; body: Record<string, unknown> }[]
      >(`events?project_id=eq.${encodeURIComponent(this.project!.id)}&select=id,at,by,component,kind,body&order=seq`, {
        headers: { range: `${from}-${from + 999}` },
      });
      for (const r of rows) {
        const e = readEvent({ ...r.body, id: r.id, at: r.at, by: r.by, component: r.component, kind: r.kind });
        if (e) out.push(e);
      }
      if (rows.length < 1000) return out;
    }
  }

  private gens = new Map<string, Raw | null>();
  async generation(component: string, gen: string): Promise<Raw | null> {
    const key = `${component}@${gen}`;
    if (!this.gens.has(key)) {
      const q = `project_id=eq.${encodeURIComponent(this.project!.id)}&component=eq.${encodeURIComponent(component)}&gen=eq.${encodeURIComponent(gen)}`;
      const rows = await this.rest<{ snapshot: Raw; canon_version: number | null }[]>(`generations?${q}&select=snapshot,canon_version`);
      // Another snapshot format can't be compared with Live: as if it weren't stored.
      const r = rows[0];
      this.gens.set(key, r && (r.canon_version ?? CANON_VERSION) === CANON_VERSION ? r.snapshot : null);
    }
    return this.gens.get(key)!;
  }
  async saveGeneration(component: string, gen: string, snapshot: Raw) {
    this.gens.set(`${component}@${gen}`, snapshot);
    await this.rest("generations?on_conflict=project_id,component,gen", {
      method: "POST",
      headers: { prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify({ project_id: this.project!.id, component, gen, snapshot, canon_version: CANON_VERSION }),
    });
  }

  /** The branches developers connected (each has a lane beside Live); null when the service can't say. */
  async lanes(): Promise<string[] | null> {
    if (!this.project) return null;
    const rows = await this.rpc<{ branch: string }[]>("project_lanes", { p_project: this.project.id }, true).catch(() => null);
    return rows ? rows.map((r) => r.branch) : null;
  }

  /** The newest update from code waiting for this file (taken: no other plugin applies it meanwhile). */
  async takeUpdate(): Promise<{
    id: number;
    commit: string;
    kind: "live" | "preview";
    branch: string | null;
    payload: UpdateInput & { pictures?: number };
  } | null> {
    if (!this.project || !(await this.ready())) return null;
    // "The file is open": a developer's sync waits for its update and reports how it went.
    await this.rpc("plugin_seen", { p_project: this.project.id, p_file_name: this.fileName || null }, true).catch(() => 0);
    type Row = {
      id: number;
      commit: string;
      kind?: string;
      branch?: string | null;
      payload: UpdateInput & { pictures?: number };
      bundle?: string | null;
    };
    // Live updates and branch previews; a service from before previews has only take_update (Live).
    const rows = await this.rpc<Row[]>("take_next_update", { p_project: this.project.id }, true).catch((e: Error) =>
      /take_next_update|function|schema cache/i.test(e.message)
        ? this.rpc<Row[]>("take_update", { p_project: this.project!.id }, true)
        : Promise.reject(e),
    );
    const row = rows[0];
    if (!row) return null;
    // The compiled code comes gzipped (CLI 0.2.1 and later); older CLIs put it in the payload.
    const payload = row.bundle ? { ...row.payload, ...(await unpackBundle(row.bundle)) } : row.payload;
    return { id: row.id, commit: row.commit, kind: row.kind === "preview" ? "preview" : "live", branch: row.branch ?? null, payload };
  }
  /**
   * Pictures an update uses (the app's images, the pages' screenshots), from the project's media storage
   * (members only), base64 by ref. A few at a time; one that fails is left out (and reported).
   */
  async media(refs: string[], onEach?: (done: number) => void): Promise<{ images: Record<string, string>; failed: string[] }> {
    const images: Record<string, string> = {};
    const failed: string[] = [];
    const project = this.project?.id;
    if (!project || !refs.length) return { images, failed };
    const todo = [...refs];
    const one = async () => {
      for (let ref = todo.shift(); ref; ref = todo.shift()) {
        try {
          if (!(await this.ready())) throw new Error("signed out");
          const r = await fetch(`${this.service.url}/storage/v1/object/authenticated/media/${project}/${ref}`, {
            headers: { apikey: this.service.anon, authorization: `Bearer ${this.access!.token}` },
          });
          if (!r.ok) throw new Error(`${r.status}`);
          const bytes = new Uint8Array(await r.arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          images[ref] = btoa(bin);
        } catch {
          failed.push(ref);
        }
        onEach?.(Object.keys(images).length + failed.length);
      }
    };
    await Promise.all([one(), one(), one(), one()]);
    return { images, failed };
  }
  async releaseUpdate(id: number) {
    if (!(await this.ready())) throw new Error("signed out");
    await this.rpc("release_update", { p_id: id }, true);
  }
  /**
   * How far applying is (also the sign that this plugin is still at it: the update isn't handed to another
   * plugin while it keeps coming).
   */
  async updateProgress(id: number, done: number, total: number, item: string, background = false) {
    if (!(await this.ready())) return;
    // Whether Figma is in the background (the developer is told to bring it to the front); a service without
    // that parameter yet gets the progress alone.
    await this.rpc("update_progress", { p_id: id, p_done: done, p_total: total, p_item: item, p_background: background }, true)
      .catch(() => this.rpc("update_progress", { p_id: id, p_done: done, p_total: total, p_item: item }, true))
      .then(
        () => {
          this.reportRefused = null;
        },
        (e: Error) => {
          // Refused reports used to vanish: the panel looked frozen and nobody could tell why (the service
          // answered 400 to every report of an update it had handed to this very plugin). Kept and shown.
          if (this.reportRefused !== e.message) console.warn(`CoDesignFlo: the service refused progress for update ${id}: ${e.message}`);
          this.reportRefused = e.message;
          this.changed();
        },
      );
  }
  /**
   * Records how applying went. A big update can outlast the sign-in it started with (ready() renews it), and
   * a blip in the network mustn't leave it "being applied" forever: tried a few times.
   */
  async finishUpdate(id: number, ok: boolean, log: string) {
    let last: unknown;
    for (const wait of [0, 2000, 5000, 15000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        if (!(await this.ready())) throw new Error("signed out");
        await this.rpc("finish_update", { p_id: id, p_ok: ok, p_log: log }, true);
        return;
      } catch (e) {
        last = e;
        console.warn(`CoDesignFlo: the service refused to record update ${id} as ${ok ? "applied" : "failed"}: ${(e as Error).message}`);
      }
    }
    throw last;
  }
  /** Why the service refuses this plugin's reports on the update it's applying (null: it doesn't). */
  reportRefused: string | null = null;
  /** Writes queued events now (applying an update waits for its history to be saved). */
  async saved() {
    await this.flush();
    if (this.queue.length) throw new Error("couldn't save the history to the service");
  }

  private proposals: { component: string; claim: string; payload: unknown }[] = [];
  /** Uploads a proposal (changes as layer snapshots, note, answers) so the developer gets it without Figma. */
  async sendProposal(p: { component: string; claim: string; payload: unknown }) {
    this.proposals.push(p);
    await this.flush();
  }

  /** Sends design-side events to the shared history (queued while offline or not signed in). */
  async send(events: unknown[]) {
    this.queue.push(...events);
    await this.flush();
  }

  /**
   * Sends what is queued. Each send takes its items off the queue first and puts them back if it fails, so
   * sends that overlap never drop what was queued meanwhile (it once lost a "kept" and a "closed").
   */
  private async flush() {
    if (!this.project || (!this.queue.length && !this.proposals.length) || !(await this.ready())) return;
    let refused = "";
    const post = async (path: string, prefer: string, rows: unknown[]) => {
      try {
        const r = await fetch(`${this.service.url}/rest/v1/${path}`, {
          method: "POST",
          headers: { ...this.headers(), prefer },
          body: JSON.stringify(rows),
        });
        if (!r.ok) refused = ((await r.json().catch(() => ({}))) as { message?: string }).message ?? "";
        return r.ok;
      } catch {
        return false;
      }
    };
    const proposals = this.proposals.splice(0);
    if (proposals.length) {
      const rows = proposals.map((p) => ({ project_id: this.project!.id, claim_id: p.claim, component: p.component, payload: p.payload }));
      if (!(await post("proposals?on_conflict=project_id,claim_id", "resolution=merge-duplicates", rows)))
        this.proposals.unshift(...proposals);
    }
    const events = this.queue.splice(0) as { id: string; at: string; by: string; component: string; kind: string }[];
    if (!events.length) return;
    const rows = events.map((e) => {
      const { id, at, by, component, kind, ...body } = e;
      return { project_id: this.project!.id, id, at, by, component, kind, body };
    });
    if (await post("events?on_conflict=project_id,id", "resolution=ignore-duplicates", rows)) {
      // A send to dev used one of my free sends: the count shown follows.
      if (events.some((e) => e.kind === "ready" || e.kind === "designed_new")) void this.refreshBilling().then(() => this.changed());
      return;
    }
    // No designer seat (my free sends are used): what sends a design waits until I have one; the rest goes now.
    if (/read-only/.test(refused)) {
      this.billing = { state: "unpaid", message: refused };
      this.changed();
      const held = (e: { kind: string }) => e.kind === "ready" || e.kind === "designed_new";
      const rest = rows.filter((r) => !held(r));
      this.queue.unshift(...events.filter(held));
      if (rest.length && !(await post("events?on_conflict=project_id,id", "resolution=ignore-duplicates", rest)))
        this.queue.push(...events.filter((e) => !held(e)));
      return;
    }
    this.queue.unshift(...events);
  }

  /** My role in the project (designer, developer or admin); null before the project is known or on an older service. */
  role: string | null = null;

  /**
   * My designer seat: whitelisted, active, trial (free sends to dev left) or unpaid (free sends used: designs I
   * send wait until I have a seat).
   */
  billing: { state: string; message?: string; sendsLeft?: number; owner?: string } | null = null;
  async refreshBilling() {
    if (!this.project) return;
    const was = this.billing?.state;
    const sends = (await this.rpc<{ state: string; used: number; free: number }[]>("my_sends", {}, true).catch(() => null))?.[0];
    if (sends) this.billing = { state: sends.state, sendsLeft: Math.max(0, sends.free - sends.used) };
    else {
      // A service from before free sends: its project_billing (nothing to say on one from before billing).
      const rows = await this.rpc<{ state: string; owner_email: string }[]>("project_billing", { p_project: this.project.id }, true).catch(
        () => [],
      );
      const b = rows[0];
      this.billing = b ? { state: b.state, owner: b.owner_email } : null;
    }
    // A seat arrived: the designs held meanwhile go now.
    if (was === "unpaid" && this.billing?.state !== "unpaid") await this.flush();
  }
}
