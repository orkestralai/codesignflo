// The project's realtime signal (Supabase Realtime, Phoenix protocol over a WebSocket): the service bumps one
// small row per project whenever something happens in it — the designer's or developer's history, a proposal,
// an update from code — and the panel reacts at once instead of waiting for its next check. Only that signal
// travels here (row-level security: members only); the panel then reads what it needs as usual. When the socket
// is down, the regular checks carry on as before.

export type RealtimeOptions = {
  /** The service's address (https://…); the socket is wss://…/realtime/v1/websocket. */
  url: string;
  anon: string;
  project: string;
  /** The current access token (renewed by the caller; sent again on each reconnect and with `setToken`). */
  token: () => string | null;
  onSignal: () => void;
  /** Connected and joined, or not (for the panel to show; optional). */
  onState?: (live: boolean) => void;
  /** The WebSocket class (the plugin's UI has one; tests pass Node's). */
  WebSocket?: typeof WebSocket;
};

export class ProjectSignal {
  private ws: WebSocket | null = null;
  private ref = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private closed = false;
  private readonly topic: string;
  live = false;

  constructor(private readonly o: RealtimeOptions) {
    this.topic = `realtime:cdf-${o.project}`;
    this.open();
  }

  private send(event: string, payload: unknown, topic = this.topic) {
    if (this.ws?.readyState !== 1) return;
    const ref = String(++this.ref);
    this.ws.send(JSON.stringify({ topic, event, payload, ref, join_ref: topic === this.topic ? "1" : undefined }));
  }

  private open() {
    if (this.closed) return;
    const WS = this.o.WebSocket ?? WebSocket;
    const base = this.o.url.replace(/^http/, "ws").replace(/\/$/, "");
    const ws = new WS(`${base}/realtime/v1/websocket?apikey=${encodeURIComponent(this.o.anon)}&vsn=1.0.0`);
    this.ws = ws;
    ws.onopen = () => {
      this.send("phx_join", {
        config: {
          broadcast: { self: false },
          presence: { key: "" },
          postgres_changes: [{ event: "*", schema: "public", table: "project_signals", filter: `project_id=eq.${this.o.project}` }],
          private: false,
        },
        access_token: this.o.token() ?? this.o.anon,
      });
      this.heartbeat = setInterval(() => this.send("heartbeat", {}, "phoenix"), 25_000);
    };
    ws.onmessage = (m) => {
      let msg: { topic?: string; event?: string; payload?: { status?: string } };
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (msg.topic !== this.topic) return;
      if (msg.event === "phx_reply" && msg.payload?.status === "ok" && !this.live) {
        this.live = true;
        this.backoff = 1000;
        this.o.onState?.(true);
      } else if (msg.event === "postgres_changes") this.o.onSignal();
      else if (msg.event === "system" && (msg.payload as { status?: string } | undefined)?.status === "error") ws.close();
      else if (msg.event === "phx_error" || msg.event === "phx_close") ws.close();
    };
    ws.onclose = () => this.dropped();
    ws.onerror = () => ws.close();
  }

  private dropped() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.live) this.o.onState?.(false);
    this.live = false;
    this.ws = null;
    if (this.closed) return;
    // Back again soon, then less often (the regular checks cover the gap).
    this.retry = setTimeout(() => this.open(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }

  /** A renewed access token: realtime keeps checking membership with it. */
  setToken(token: string) {
    this.send("access_token", { access_token: token });
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }
}
