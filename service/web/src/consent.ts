// What the website stores and loads, and the visitor's choice. CoDesignFlo sets no cookies. Strictly necessary
// storage (the sign-in session, remembered choices) needs no consent; the only optional thing is the visit
// counter from ship-or-die.com (no cookies, no identifiers), loaded only after "Allow". The choice is kept in
// this browser (cdf.consent) and can be changed any time from "Cookie settings" in the footer.
//
// The counter is someone else's script on the origin that keeps the sign-in session, so it runs only on the
// public landing page, for someone not signed in (never on sign-in, approval, billing or project pages, nor
// with a sign-in link's ?code or ?mcp), pinned to the exact file reviewed (Subresource Integrity: the browser
// refuses it if it changes; it's served with CORS, which SRI needs). A session appearing reloads the page
// without it.

const KEY = "cdf.consent";
const COUNTER = {
  src: "https://www.ship-or-die.com/hackathon/verify.js",
  site: "e689a8df4eb1206f445fc39dfb33b1c1f794c7ec",
  // sha384 of verify.js as reviewed on 2026-11-22 (1538 bytes). When they change it, counting stops until
  // the new file is reviewed and its hash put here.
  integrity: "sha384-5eftaEf/Zc9OU/GKwliKiY9PMLWLwxcwtlAtQdAgaTvg82WG+t+l8wwsYB5VFUP0",
};

type Choice = { analytics: boolean; at: string };

function read(): Choice | null {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? "null") as Choice | null;
    return c && typeof c.analytics === "boolean" ? c : null;
  } catch {
    return null;
  }
}

function save(analytics: boolean) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ analytics, at: new Date().toISOString() } satisfies Choice));
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
}

/** Only on the public website (not the admin app, not local development). */
const counted = () => location.hostname === "codesignflo.com" || location.hostname === "www.codesignflo.com";

/** A sign-in session kept in this browser (Supabase's sb-…-auth-token). */
const signedIn = () => {
  try {
    return Object.keys(localStorage).some((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
  } catch {
    return true; // can't tell: assume so
  }
};

/** A sign-in link (the plugin's, the CLI's or a coding agent's). */
const signInLink = () => {
  const q = new URLSearchParams(location.search);
  return q.has("code") || q.has("mcp");
};

/** Which view the page shows: the landing page, another public page (docs, legal) or anything else. */
export type CounterView = "landing" | "public" | "private";
let view: CounterView = "private";

let loaded = false;
/** The choice made on this page (it holds even where storage is blocked). */
let chosen: boolean | null = null;
function loadCounter() {
  if (loaded || !counted() || view !== "landing" || signedIn() || signInLink() || !(chosen ?? read()?.analytics)) return;
  loaded = true;
  const s = document.createElement("script");
  s.defer = true;
  s.src = COUNTER.src;
  s.integrity = COUNTER.integrity;
  s.crossOrigin = "anonymous";
  s.referrerPolicy = "origin";
  s.dataset.site = COUNTER.site;
  document.head.append(s);
}

/**
 * The chat assistant on the landing page (OrkestralAI's embed, answering questions about CoDesignFlo). Someone
 * else's script like the counter, so the same rules: the public landing page only, for someone not signed in, never
 * with a sign-in link open; a session appearing reloads the page without it. Not pinned by integrity: the embed
 * changes with the bot. Needs no consent: it sets no cookies, and is there to be asked.
 */
const CHATBOT: Record<string, string> = {
  src: "https://www.orkestralai.com/embed.js",
  botId: "d98c4258-5545-4e2c-b0d0-108d62540886",
  primaryColor: "#1F63CC",
  secondaryColor: "#F8FAFC",
  fontFamily: "modern",
  position: "bottom-right",
  cornerStyle: "round",
  width: "380",
  height: "560",
};
let chatbot = false;
function loadChatbot() {
  if (chatbot || view !== "landing" || signedIn() || signInLink()) return;
  chatbot = true;
  const s = document.createElement("script");
  s.src = CHATBOT.src!;
  s.async = true;
  s.referrerPolicy = "origin";
  for (const [k, v] of Object.entries(CHATBOT)) if (k !== "src") s.dataset[k] = v;
  document.body.append(s);
}

/** The page tells which view it shows; the counter and the chat load on the landing page only. */
export function counterView(v: CounterView) {
  view = v;
  if (v === "landing") {
    loadCounter();
    loadChatbot();
  } else if (v === "private" && (loaded || chatbot)) location.reload();
}

function banner(): HTMLElement {
  const el = document.createElement("div");
  el.className = "consent";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Cookies and privacy");
  el.innerHTML = `<p><b>No cookies.</b> With your OK, we count visits anonymously. <a href="/cookies">Details</a></p>
    <div class="consent-actions"><button type="button" data-consent="no">Only necessary</button><button type="button" data-consent="yes">Allow counting</button></div>`;
  for (const b of el.querySelectorAll<HTMLButtonElement>("[data-consent]"))
    b.onclick = () => {
      const yes = b.dataset.consent === "yes";
      const before = read();
      save(yes);
      chosen = yes;
      el.remove();
      if (yes) loadCounter();
      // Withdrawn after it ran: reload so it's gone from this page too.
      else if (before?.analytics && loaded) location.reload();
    };
  return el;
}

/** Shows the banner (again): first visit, or "Cookie settings". */
export function openConsent() {
  document.querySelector(".consent")?.remove();
  document.body.append(banner());
}

/** At start: apply a stored choice, or ask (on the public website). */
export function initConsent() {
  const c = read();
  if (!c && !location.hostname.startsWith("admin.")) openConsent();
  // Signed in from another tab while the counter ran here: reload without it.
  addEventListener("storage", (e) => {
    if (loaded && e.key?.startsWith("sb-")) location.reload();
  });
  // "Cookie settings" links anywhere on the page.
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("[data-consent-open]");
    if (!a) return;
    e.preventDefault();
    openConsent();
  });
}

export const CONSENT_KEY = KEY;
