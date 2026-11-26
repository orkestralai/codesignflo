// Panel UI (iframe). Renders the designer's component list and talks to the developer's CLI over a
// localhost WebSocket when one is running (silent otherwise).

import {
  applyPreview,
  applyUpdate,
  type Figma,
  gapSignature,
  type LedgerEvent,
  ordered,
  type Store,
  signatureOf,
  type TelemetryEvent,
} from "@codesignflo/core";

declare const __VERSION__: string;
// Which build this is, at the bottom of the panel (and on the title), so a designer can tell support.
document.getElementById("version")!.textContent = `CoDesignFlo ${__VERSION__}`;
document.querySelector("header h1")?.setAttribute("title", `CoDesignFlo ${__VERSION__}`);

import { keyOfTitle, pageNames } from "@codesignflo/core/key";
import * as protocol from "@codesignflo/core/protocol";
import { Cloud, type Person } from "./cloud.js";
import type { SystemState } from "./designsystem.js";
import type { Context, GuidePrefs, MainToUi, PanelAction, UiToMain } from "./messages.js";
import type { PanelRow, PanelState, Preview } from "./panel.js";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const toMain = (m: UiToMain) => parent.postMessage({ pluginMessage: m }, "*");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---- panel ---------------------------------------------------------------------------------------

let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** What the busy bar says while a designer's action runs (quick reads like "state" show nothing). */
const BUSY: Partial<Record<PanelAction, string | ((p: Record<string, unknown>) => string)>> = {
  claim: "Claiming — making your copy…",
  ready: "Sending to the developer…",
  designNew: "Sending the design…",
  designNewMany: (p) => `Sending ${(p.items as unknown[] | undefined)?.length ?? ""} designs…`,
  unclaim: "Unclaiming…",
  reopen: "Reopening your copy…",
  preview: "Looking at your changes…",
  keepDesign: "Keeping your design in Live…",
  acceptCode: "Closing with the code's version…",
  unpin: "Letting it follow the code…",
  scanDesigns: "Looking for your designs…",
  compareDesigns: "Comparing your designs with the app…",
  designWins: "Claiming with your design…",
  useLive: "Switching your screens to Live…",
  reviewInCode: "Listing them as New in code…",
  setUpFile: "Setting up this file…",
  deleteRemoved: "Deleting…",
  undo: "Undoing…",
};
let busy: { label: string; since: number }[] = [];
let busyTimer: ReturnType<typeof setTimeout> | null = null;
/** A thin bar under the header with what's going on — shown when an action takes more than a moment. */
function renderBusy() {
  const el = document.getElementById("busy");
  if (!el) return;
  const now = busy.find((b) => Date.now() - b.since > 250);
  el.hidden = !now;
  const label = document.getElementById("busy-text");
  if (label) label.textContent = now?.label ?? "";
}

const act = <T>(action: PanelAction, params?: unknown) =>
  new Promise<T>((resolve, reject) => {
    const id = nextId++;
    const label = BUSY[action];
    const entry = label
      ? { label: typeof label === "function" ? label((params ?? {}) as Record<string, unknown>) : label, since: Date.now() }
      : null;
    if (entry) {
      busy.push(entry);
      // One timer at a time, ticking while anything is busy.
      if (busyTimer === null)
        busyTimer = setTimeout(function tick() {
          renderBusy();
          busyTimer = busy.length ? setTimeout(tick, 200) : null;
        }, 260);
    }
    const done = () => {
      if (!entry) return;
      busy = busy.filter((b) => b !== entry);
      renderBusy();
    };
    waiting.set(id, {
      resolve: (v: unknown) => {
        done();
        (resolve as (v: unknown) => void)(v);
      },
      reject: (e: Error) => {
        done();
        reject(e);
      },
    });
    toMain({ kind: "panel", id, action, params });
  });

let view: PanelState | null = null;
/** Answers to "what is the saved sign-in now?" (the plugin in another file may have renewed it). */
const sessionWaits = new Map<number, (refreshToken: string | null) => void>();
let readyFor: string | null = null;
let preview: Preview | null = null;
/** The open "Ready for dev" form's state, kept across redraws (the panel redraws whenever the file changes). */
let draftNote = "";
let draftScopes: Record<string, string> = {};
const resetDraft = () => {
  draftNote = "";
  draftScopes = {};
};
/** The "New design" form, kept across redraws; the name follows the selection until the designer edits it. */
let newName: string | null = null;
let newNote = "";
let newFor: string | null = null;

// ---- describing changes in a designer's words ----------------------------------------------------

const PROP: Record<string, string> = {
  size: "size",
  padding: "padding",
  fills: "colour",
  strokes: "border",
  cornerRadius: "corner radius",
  effects: "shadow",
  opacity: "opacity",
  visible: "visibility",
  fontName: "font weight",
  fontSize: "font size",
  lineHeight: "line height",
  letterSpacing: "letter spacing",
  characters: "text",
  textAlignHorizontal: "text alignment",
  textAlignVertical: "vertical alignment",
  textCase: "text case",
  textDecoration: "underline / strike",
  textTruncation: "truncation",
  maxLines: "max lines",
  fontWeight: "font weight",
  strokeWeight: "border width",
  layoutPositioning: "positioning",
  name: "layer name",
  add: "added",
  remove: "removed",
  move: "moved",
  reorder: "order",
  wrap: "grouped",
};
const propLabel = (p: string) => PROP[p] ?? (p.startsWith("layout.") ? "alignment / spacing" : p);
const layerLabel = (l: string) => (l === "(root)" ? "whole component" : l.replace(/ > /g, " › ").replace(/\//g, " › "));
const variantLabel = (v: string) =>
  v
    .split(",")
    .map((kv) => kv.replace("=", ": "))
    .join(" · ");
/** Values as the designer knows them: token names, not CSS (var(--color-text-primary) → color-text-primary). */
const short = (v: string) => {
  const t = v.replace(/var\(--([\w-]+)\)/g, "$1");
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
};
let pairCodeShown: string | null = null;

const LABEL: Record<string, string> = {
  in_sync: "In sync",
  in_design: "In design",
  ready_for_dev: "Ready for dev",
  design_new: "New design",
  code_new: "New in code",
  ignored: "Ignored",
};

// ---- icons (Figma-style, 16px, currentColor) -------------------------------------------------------

const svg = (d: string, extra = "") =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const ICON = {
  chevRight: svg(`<path d="M6.5 4.5 10 8l-3.5 3.5"/>`),
  chevDown: svg(`<path d="M4.5 6.5 8 10l3.5-3.5"/>`),
  more: svg(
    `<circle cx="4" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12" cy="8" r=".9" fill="currentColor"/>`,
  ),
  back: svg(`<path d="M9.5 4 5.5 8l4 4"/>`),
  search: svg(`<circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/>`),
  warn: svg(`<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>`),
  target: svg(`<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="1.5"/>`),
  undo: svg(`<path d="M5.5 4.5 3 7l2.5 2.5"/><path d="M3 7h6.5a3 3 0 0 1 0 6H8"/>`),
  eye: svg(`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>`),
};

/** "knowledge-base-popup-import-from-website" → "Knowledge base popup import from website"; pages too. */
/** A self-hosted box (the team's own service): no seats, prices or Billing to point at. */
const selfhost = () => cloud?.service.mode === "selfhost";
/** My seat as the panel shows it: none for developers, the demo, or a self-hosted box. */
const myBilling = () => (cloud?.role === "developer" || cloud?.project?.demo || selfhost() ? null : cloud?.billing);
/** "3 of 5 free sends to dev left": for a designer without a seat (none for developers, seat holders, older services). */
const sendsLeftText = (n: number) => `${n} of 5 free send${n === 1 ? "" : "s"} to dev left`;
const sendsSuffix = () => {
  const b = myBilling();
  return b?.state === "trial" && b.sendsLeft !== undefined ? ` · ${b.sendsLeft} free left` : "";
};

/** Letters and digits only: "pages.guided-setup-page", "Guided setup" and "GuidedSetup" compare alike. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Search: by the name shown or by the id (pages.guided-setup-page), whatever the spacing and punctuation. */
const matches = (key: string, q: string) => {
  const want = squash(q);
  return (
    title(key).toLowerCase().includes(q) ||
    key.toLowerCase().includes(q) ||
    (want !== "" && (squash(key).includes(want) || squash(title(key)).includes(want)))
  );
};

const title = (key: string) => {
  const t = key
    .replace(/^pages\./, "")
    .replace(/-page$/, "")
    .replace(/[-.]/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Short status chip (one line, never wraps). */
function badge(r: PanelRow) {
  if (r.question) return `<span class="chip b-conflict">Question</span>`;
  if (r.conflict) return `<span class="chip b-conflict">Needs a look</span>`;
  if (r.state === "in_sync" && r.unseen) return `<span class="chip b-unseen">Updated</span>`;
  const short: Record<string, string> = { ready_for_dev: "Ready", in_sync: "In sync" };
  return `<span class="chip b-${r.state}">${short[r.state] ?? LABEL[r.state] ?? r.state}</span>`;
}

/**
 * What the developer's latest sync found for a sent proposal (from the code, before Live has it): done on
 * the Live branch (Live will confirm it), done on another branch (waiting for the merge), or partly done.
 */
function codeCheck(r: PanelRow): string | null {
  const c = r.claim ? cloud?.checks.get(r.claim) : undefined;
  if (!c?.total) return null;
  if (c.done < c.total) return `In code: ${c.done} of ${c.total} changes`;
  const live = cloud?.project?.liveBranch;
  return c.branch && live && c.branch !== live ? `Done on ${c.branch}, not in ${live} yet` : "Done in code — Live updates soon";
}

/** One line under the name: what is going on, in a few words. */
/** The developer's review of what was sent, in a few words. */
const reviewWord = (r: PanelRow) =>
  !r.review
    ? null
    : r.review.decision === "approved"
      ? "Developer approved it"
      : r.review.decision === "questions"
        ? r.review.answer
          ? "You answered the developer"
          : "The developer has a question"
        : r.review.decision === "later"
          ? "Developer: later"
          : "Developer skipped it";

const statusLine = (r: PanelRow) =>
  r.onBranch && r.state === "ready_for_dev" && !r.question
    ? r.onBranch.done === r.onBranch.total
      ? `Done on ${r.onBranch.branch}: closes when it's merged`
      : `Being built on ${r.onBranch.branch}: ${r.onBranch.done} of ${r.onBranch.total} changes`
    : r.branch && r.state === "in_sync"
      ? `Only on ${r.branch} so far: claim it to redesign that version`
      : r.question
        ? "The developer has a question"
        : reviewWord(r) && !(r.state === "ready_for_dev" && (r.progress || codeCheck(r)))
          ? reviewWord(r)!
          : r.conflict
            ? "Code changed the same things"
            : r.state === "ready_for_dev"
              ? (codeCheck(r) ??
                (r.progress
                  ? `In code: ${r.progress.done} of ${r.progress.total} changes`
                  : r.builder
                    ? `${r.builder} is building it`
                    : `Sent: ${r.note ?? ""}`))
              : r.state === "design_new"
                ? r.builder
                  ? `${r.builder} is building it`
                  : "New design, being built"
                : r.state === "in_design"
                  ? r.claimedBy && view?.user && r.claimedBy !== view.user
                    ? `${r.claimedBy} is redesigning it`
                    : "You're editing your copy"
                  : r.state === "code_new"
                    ? "Built in code without a design"
                    : r.unseen
                      ? "Changed in code"
                      : r.state === "ignored"
                        ? "No design needed"
                        : r.warning
                          ? "Doesn't look like the app here (font)"
                          : r.differs?.length
                            ? `Differs from the app in ${r.differs.length} place${r.differs.length > 1 ? "s" : ""}${r.score !== undefined ? ` · ${r.score}% matches` : ""}`
                            : r.pins && Object.keys(r.pins).length
                              ? `Matches the code, except ${Object.keys(r.pins).length} kept as design`
                              : "Matches the code";

/** What the designer kept as design on this component, each with a way back to the code's version. */
const keptHtml = (r: PanelRow) => {
  const entries = Object.entries(r.pins ?? {});
  if (!entries.length) return "";
  const label = (key: string) =>
    key
      .split("/")
      .slice(1)
      .filter((x) => !x.includes("="))
      .join(" / ")
      .replace(/^\+/, "")
      .replace(/\/\+/g, " / ") || "the whole component";
  return `<div class="kept"><b>Kept as design</b> (the code doesn't do this; Live keeps your version):${entries
    .map(
      ([key, props]) =>
        `<div class="kept-row"><span>${esc(props.includes("*") ? `${label(key)} (layer)` : `${props.map(propLabel).join(", ")} · ${label(key)}`)}</span><button type="button" class="link" data-a="unpin" data-c="${esc(r.component)}" data-key="${esc(key)}" data-props="${esc(JSON.stringify(props))}">Use the code's</button></div>`,
    )
    .join("")}</div>`;
};

/** Longer explanation shown when a row is open (only where there is something to read). */
/** The developer's review: their plan, or their question with a box to answer it. */
const reviewHtml = (r: PanelRow) => {
  const v = r.review;
  if (!v) return "";
  if (v.decision === "questions")
    return `<div class="kept"><b>Developer asks</b> (reviewing it before building): ${esc(v.question ?? "")}${
      v.answer
        ? `<div class="kept-row"><span><b>You answered:</b> ${esc(v.answer)}</span></div>`
        : `<textarea id="ans-${esc(r.component)}" rows="2" placeholder="Your answer"></textarea><div class="actions"><button type="button" class="primary" data-a="review-answer" data-c="${esc(r.component)}">Send answer</button></div>`
    }</div>`;
  const what =
    v.decision === "approved"
      ? `approved it${v.plan ? ` — plan: ${esc(v.plan)}` : ""}`
      : v.decision === "later"
        ? "set it for later"
        : `skipped it${v.plan ? `: ${esc(v.plan)}` : ""}`;
  return `<div class="kept"><b>Developer review:</b> ${what}</div>`;
};

/** How closely the app follows the designer's design, and which way it's going. */
const designMatchHtml = (r: PanelRow) => {
  const m = r.designMatch;
  if (!m) return "";
  const trend =
    m.was === undefined || m.was === m.now
      ? ""
      : m.now < m.was
        ? ` (was ${m.was}% — moving away from it)`
        : ` (was ${m.was}% — closer to it)`;
  return `<div class="kept"><b>${m.now}% like your design</b>${trend}. Live shows what the app draws${m.now >= 80 ? ", on your design's layers" : ""}; your design is in Proposals → Archive. Claim the page to bring the app back to your design.</div>`;
};

const detail = (r: PanelRow) =>
  detailText(r) +
  designMatchHtml(r) +
  reviewHtml(r) +
  keptHtml(r) +
  (r.warning ? `<div class="warn">${ICON.warn}<span>${esc(r.warning)}</span></div>` : "") +
  (r.differs?.length
    ? `<div class="kept"><b>Differs from the app</b> (sizes in Live vs the browser — the developer sees this too):${r.differs.map((d) => `<div class="kept-row"><span>${esc(d)}</span></div>`).join("")}</div>`
    : "") +
  (r.fitted
    ? `<div class="kept">${r.score ?? 100}% of its layers match the app. ${r.fitted} layer${r.fitted > 1 ? "s were" : " was"} fitted to the app's size after building: CoDesignFlo didn't get ${r.fitted > 1 ? "them" : "it"} right on its own.</div>`
    : "");
const detailText = (r: PanelRow) =>
  r.question
    ? `<b>Developer asks:</b> ${esc(r.question)}`
    : r.conflict
      ? "Code changed since you claimed this. Your copy is untouched; when you send it, the developer sees both."
      : r.state === "code_new"
        ? "Check it in Live, then say it looks good, that it needs no design, or claim it to redesign."
        : r.unseen && r.whatsNew
          ? esc(r.whatsNew)
          : r.note && (r.state === "ready_for_dev" || r.state === "design_new")
            ? `<b>Your note:</b> ${esc(r.note)}`
            : "";

type Act = { a: string; label: string; node?: string; primary?: boolean; disabled?: string };
/** The one next step for a row, and everything else for its ⋯ menu. */
function actionsFor(r: PanelRow): { main?: Act; menu: Act[] } {
  const show: Act[] = r.liveNodeId ? [{ a: "show", label: "Show in Live", node: r.liveNodeId }] : [];
  const copy: Act[] = r.proposalNodeId ? [{ a: "show", label: "Open my copy", node: r.proposalNodeId }] : [];
  if (r.state === "design_new") return { main: copy[0], menu: [{ a: "unclaim", label: "Withdraw" }] };
  if (r.state === "ready_for_dev")
    return {
      main: copy[0],
      menu: [
        { a: "reopen", label: "Keep editing" },
        ...show,
        // When the code can't do everything: close it as the code has it, or keep the rest as design in Live.
        { a: "acceptCode", label: "Accept the code's version" },
        { a: "keepDesign", label: "Keep the rest as design" },
        { a: "unclaim", label: "Unclaim" },
      ],
    };
  if (r.state === "in_design")
    return {
      main: {
        a: "ready-open",
        label: r.question ? "Answer…" : "Ready for dev…",
        primary: true,
        // Nothing changed in the copy yet: nothing to send (an answer to a question needs no change).
        ...(r.edited === false && !r.question ? { disabled: "Change your copy first: nothing differs from Live yet" } : {}),
      },
      menu: [...copy, ...show, ...(r.question ? [{ a: "reopen", label: "Keep editing" }] : []), { a: "unclaim", label: "Unclaim" }],
    };
  // The demo: Alex's draft is there to be fixed.
  if (r.state === "code_new" && cloud?.project?.demo && r.component === DEMO.component)
    return {
      main: { a: "claim", label: "Claim to fix it", primary: true },
      menu: [{ a: "accept", label: "Looks good" }, { a: "ignore", label: "No design needed" }, ...show],
    };
  if (r.state === "code_new")
    return {
      main: { a: "accept", label: "Looks good", primary: true },
      menu: [{ a: "ignore", label: "No design needed" }, { a: "claim", label: "Claim to redesign" }, ...show],
    };
  if (r.unseen) return { main: { a: "seen", label: "Got it" }, menu: [...show, { a: "claim", label: "Claim" }] };
  return { main: { a: "claim", label: "Claim" }, menu: show };
}

/** Rows the designer opened (click the row); rows that need them open by themselves unless closed. */
const open = new Set<string>();
const shut = new Set<string>();
const isOpen = (r: PanelRow) => open.has(r.component) || (sectionOf(r) === "needs" && !shut.has(r.component));
/** Sections folded by the designer; "rest" (everything in sync) starts folded. */
const folded = new Set<string>(["rest"]);
const sectionOf = (r: PanelRow) =>
  r.question || r.conflict || r.unseen || r.state === "code_new"
    ? "needs"
    : r.state === "in_design" || r.state === "ready_for_dev" || r.state === "design_new"
      ? "work"
      : "rest";
const SECTIONS: [string, string][] = [
  ["needs", "Needs you"],
  ["work", "Your work"],
  ["rest", "Everything else"],
];
/** The row whose ⋯ menu is open, and the search text. */
let menuFor: string | null = null;
let query = "";
/** The row of what's selected on the canvas (highlighted, scrolled into view). */
let selectedRow: string | null = null;
/** The canvas selection's lane item (a branch's version), when it's in a lane; claiming it copies that version. */
let selectedFrom: string | null = null;
/** Why the canvas selection can't be claimed (a section, a label, the designer's own frame). */
let selectionWhy: string | null = null;
/** Thumbnails by component (base64 PNG) and the version they show. */
const thumbs = new Map<string, { version: string; png: string }>();

const btn = (x: Act, c: string) =>
  `<button type="button" class="${x.primary ? "primary" : ""}" data-a="${x.a}" data-c="${esc(c)}"${x.node ? ` data-node="${x.node}"` : ""}${x.disabled ? ` disabled title="${esc(x.disabled)}"` : ""}>${esc(x.label)}</button>`;

function rowHtml(r: PanelRow) {
  const { main, menu } = actionsFor(r);
  const opened = isOpen(r);
  const more = detail(r);
  const t = thumbs.get(r.component);
  return `<div class="row${opened && more ? " open" : ""}${selectedRow === r.component ? " selected" : ""}" data-row="${esc(r.component)}">
    <div class="row-line">
      <button type="button" class="row-main" data-a="toggle" data-c="${esc(r.component)}" title="${esc(title(r.name))}">
        <span class="thumb">${t ? `<img src="data:image/png;base64,${t.png}" alt="">` : ""}</span>
        <span class="text"><span class="name">${esc(title(r.name))}${r.pending ? `<span class="dot-pending" title="Not synced yet: the developer sees it at their next sync"></span>` : ""}</span><span class="status">${badge(r)}<span>${esc(statusLine(r))}</span></span></span>
      </button>
      ${main ? btn(main, r.component) : ""}
      ${menu.length ? `<button type="button" class="icon" data-a="menu" data-c="${esc(r.component)}" title="More">${ICON.more}</button>` : ""}
      ${menuFor === r.component ? `<div class="menu">${menu.map((x) => `<button type="button" data-a="${x.a}" data-c="${esc(r.component)}"${x.node ? ` data-node="${x.node}"` : ""}>${esc(x.label)}</button>`).join("")}</div>` : ""}
    </div>
    ${opened && more ? `<div class="row-body">${more}</div>` : ""}
  </div>`;
}

/** "Ready for dev" (or answering a question) as its own screen. */
function readyScreen(r: PanelRow) {
  const head = `<div class="screen-head"><button type="button" class="icon" data-a="cancel" title="Back">${ICON.back}</button>
    <div><div class="name">Send ${esc(title(r.name))} to the developer</div><div class="status">${r.question ? `They asked: ${esc(r.question)}` : "Check your changes, answer the questions, add a note."}</div></div></div>`;
  if (!preview) return `${head}<div class="hint">Looking at your changes…</div>`;
  const changes = preview.changes.map((c) => {
    const partial = c.variants !== "all";
    // No default (M6: "all versions" was read as "the versions I edited"): the designer picks.
    const which = partial ? (c.variants as string[]).map(variantLabel).map(esc).join(" / ") : "";
    const scope = partial
      ? `<div class="ask"><span>Changed only in <b>${which}</b>. In code, do it:</span>
           <label><input type="radio" name="s-${esc(c.key)}" data-key="${esc(c.key)}" value="variants" ${draftScopes[c.key] === "variants" ? "checked" : ""}> only for ${which}</label>
           <label><input type="radio" name="s-${esc(c.key)}" data-key="${esc(c.key)}" value="all" ${draftScopes[c.key] === "all" ? "checked" : ""}> for every version</label></div>`
      : `<div class="desc">In every version</div>`;
    const warn = (t: string) => `<div class="warn">${ICON.warn}<span>${t}</span></div>`;
    const foreign = c.foreign?.length
      ? warn(`${c.foreign.map((f) => esc(f.variable)).join(", ")} isn't one of the code's tokens yet — the developer will add it.`)
      : "";
    const clash = c.conflict ? warn("The developer changed this too since you claimed it. They'll see both.") : "";
    const tools = `<span class="tools">${c.nodeIds?.length ? `<button type="button" class="icon" data-a="select-change" data-key="${esc(c.key)}" title="Select in your copy">${ICON.target}</button>` : ""}${c.undo ? `<button type="button" class="icon" data-a="undo-change" data-key="${esc(c.key)}" title="Undo this change in your copy">${ICON.undo}</button>` : ""}</span>`;
    return `<div class="card"><div class="what"><span><b>${esc(propLabel(c.prop))}</b> · ${esc(layerLabel(c.layer))}</span>${tools}</div>
      <div class="vals"><span>${esc(short(c.from))}</span><span class="arrow">→</span><span>${esc(short(c.to))}</span></div>${scope}${clash}${foreign}</div>`;
  });
  const unanswered = preview.changes.filter((c) => c.variants !== "all" && !draftScopes[c.key]).length;
  const list = (items: string[], label: string) => (items.length ? `<div class="group">${label}</div>${items.join("")}` : "");
  const already = preview.already.map(
    (c) =>
      `<div class="card quiet"><div class="what"><b>${esc(propLabel(c.prop))}</b> · ${esc(layerLabel(c.layer))}</div><div class="vals"><span>${esc(short(c.to))}</span></div></div>`,
  );
  const content = preview.content.map(
    (c) =>
      `<div class="card quiet"><div class="what">${esc(layerLabel(c.layer))}</div><div class="vals"><span>${esc(short(c.to))}</span></div></div>`,
  );
  return `${head}<div class="screen-body">
    ${changes.length ? list(changes, `Your changes (${changes.length})`) : already.length ? "" : `<div class="hint">No design changes found in your copy yet.</div>`}
    ${list(already, "Already in code — the developer made the same change")}
    ${list(content, "Example text (stays a design example, no code change)")}
    <div class="group">Note for the developer</div>
    <textarea id="note" placeholder="What changed and why">${esc(draftNote)}</textarea>
  </div>
  <div class="screen-foot">
    ${unanswered ? `<div class="hint warn">${unanswered} question${unanswered > 1 ? "s" : ""} above to answer first</div>` : ""}
    <button type="button" class="primary wide" data-a="ready" data-c="${esc(r.component)}" ${(changes.length || already.length) && !unanswered ? "" : "disabled"}>Send to developer${sendsSuffix()}</button>
  </div>`;
}

/** New design: a component or a whole page; wide frames suggest "page" until the designer picks. */
let newKind: "component" | "page" | null = null;
const kindNow = () => newKind ?? (view?.selection?.wide ? "page" : "component");
const keyFor = (name: string) => (kindNow() === "page" ? (keyOfTitle(name) ? pageNames(name).key : "") : keyOfTitle(name));
const nameTaken = (name: string) => !!keyFor(name) && (view?.selection?.taken ?? []).includes(keyFor(name));

/** Kinds chosen for several selected frames (by node id); otherwise guessed from their width. */
const manyKinds: Record<string, "component" | "page"> = {};
const manyKind = (m: { nodeId: string; wide: boolean }) => manyKinds[m.nodeId] ?? (m.wide ? "page" : "component");

function manyDesignsBox(many: NonNullable<PanelState["many"]>) {
  const taken = many.filter((m) => m.taken);
  return `<div class="card new">
    <div class="what"><b>Send ${many.length} designs to the developer</b></div>
    <div class="desc">Each becomes a new design, named after its frame. Components go first in the developer's queue, then pages (which reuse them).</div>
    ${many
      .map(
        (m) =>
          `<div class="person"><span class="who">${esc(m.name)}${m.taken ? ` <span class="role">· name taken</span>` : ""}</span><span class="seg mini">${(
            ["component", "page"] as const
          )
            .map(
              (k) =>
                `<label class="${manyKind(m) === k ? "on" : ""}"><input type="radio" name="mk-${esc(m.nodeId)}" data-node="${esc(m.nodeId)}" value="${k}" ${manyKind(m) === k ? "checked" : ""}>${k === "component" ? "Component" : "Page"}</label>`,
            )
            .join("")}</span></div>`,
      )
      .join("")}
    ${taken.length ? `<div class="warn">${ICON.warn}<span>${taken.map((m) => esc(m.name)).join(", ")}: a component or page with this name exists — rename the frame${taken.length > 1 ? "s" : ""} first.</span></div>` : ""}
    <textarea id="nd-note" placeholder="A note for the developer (for all of them)">${esc(newNote)}</textarea>
    <div class="actions"><button type="button" class="primary" data-a="design-many" ${taken.length ? "disabled" : ""}>Send ${many.length} designs</button></div>
  </div>`;
}

function newDesignBox() {
  if (view?.many?.length) return manyDesignsBox(view.many);
  const sel = view?.selection;
  if (!sel) return `<div class="hint foot">New component or page? Select its frame on the canvas to send it to the developer.</div>`;
  if (sel.copyOf)
    return `<div class="card new">
    <div class="what"><b>Copy of ${esc(title(sel.copyOf))}</b></div>
    ${
      sel.claimable
        ? `<div class="desc">You made a copy of a Live component. Claim it to propose your changes — it moves to your lane in Proposals.</div>
    <div class="actions"><button type="button" class="primary" data-a="adopt">Claim this copy</button></div>`
        : `<div class="warn">${ICON.warn}<span>${esc(title(sel.copyOf))} is already claimed${sel.claimedBy ? ` by ${esc(sel.claimedBy)}` : ""}. ${sel.claimedBy && sel.claimedBy !== view?.user ? "Only one designer works on it at a time: ask them, or delete this copy." : "Edit the open proposal instead, or delete this copy."}</span></div>`
    }
  </div>`;
  if (sel.sent)
    return `<div class="card new"><div class="what"><b>${esc(sel.name)}</b></div>
    <div class="desc">Sent to the developer as a new design. It's under Your work until it is built and appears in Live.</div></div>`;
  if (newFor !== sel.name) {
    newFor = sel.name;
    newName = null;
    newKind = null;
  }
  const name = newName ?? sel.name;
  return `<div class="card new">
    <div class="what"><b>Send as a new design</b></div>
    <div class="desc">The selected frame (${esc(sel.name)}) is built in code, then appears in Live.</div>
    <div class="seg"><label class="${kindNow() === "component" ? "on" : ""}"><input type="radio" name="nd-kind" value="component" ${kindNow() === "component" ? "checked" : ""}>Component</label><label class="${kindNow() === "page" ? "on" : ""}"><input type="radio" name="nd-kind" value="page" ${kindNow() === "page" ? "checked" : ""}>Page</label></div>
    <input type="text" id="nd-name" value="${esc(name)}" placeholder="${kindNow() === "page" ? "Page name, e.g. Checkout" : "Component name, e.g. Promo banner"}">
    <div id="nd-warn" class="warn" ${nameTaken(name) ? "" : "hidden"}>${ICON.warn}<span>${kindNow() === "page" ? "A page" : "A component"} with this name already exists — pick another name.</span></div>
    <textarea id="nd-note" placeholder="What it is and how it behaves (for the developer)">${esc(newNote)}</textarea>
    <div class="actions"><button type="button" class="primary" data-a="design-new">Send new design</button></div>
  </div>`;
}

/**
 * A newer plugin than this one, from the service (/api/plugin): the plugin isn't on Figma Community, which would
 * update it, so the panel says when one is out and how to put it in place.
 */
let newerPlugin: { version: string; download: string } | null = null;
/** a > b, for versions like 0.5.1 (numbers compared part by part; a pre-release suffix is ignored). */
const isNewer = (a: string, b: string) => {
  const parts = (v: string) =>
    v
      .split("-")[0]!
      .split(".")
      .map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
async function checkPluginVersion() {
  const web = cloud?.service.web;
  if (!web) return;
  try {
    const r = await fetch(`${web.replace(/\/$/, "")}/api/plugin`, { cache: "no-store" });
    const b = (await r.json()) as { version?: string; download?: string };
    const next = b.version && b.download && isNewer(b.version, __VERSION__) ? { version: b.version, download: b.download } : null;
    if (JSON.stringify(next) !== JSON.stringify(newerPlugin)) {
      newerPlugin = next;
      render();
    }
  } catch {
    // offline, or a service without /api/plugin yet: nothing to say
  }
}
function newerPluginNotice(): string {
  if (!newerPlugin || ctx?.guide[DEMO_PREFS]?.pluginLater === newerPlugin.version) return "";
  return `<div class="notice"><span><b>CoDesignFlo ${esc(newerPlugin.version)} is out</b> (you have ${esc(__VERSION__)}). Download it, unzip it into the folder you imported the plugin from (replacing its files), then close and reopen the plugin.</span><button type="button" class="primary" data-a="plugin-download">Download</button><button type="button" class="quiet" data-a="plugin-later">Later</button></div>`;
}

/** The CoDesignFlo service, when this build has one (development: the local Supabase). */
let cloud: Cloud | null = null;

function renderCloud() {
  const el = $("cloud");
  if (!cloud) {
    el.innerHTML = "";
    return;
  }
  document.body.classList.toggle("shared", !!cloud.project);
  const guideOn = guideOpen || (!peopleOpen && hasChecklist() && !guidePrefs().hidden);
  const guide = `<button type="button" data-a="guide-open" class="${guideOn ? "on" : ""}" title="${hasChecklist() ? "Show or hide Getting started (the full guide is linked from it)" : "What you can do with CoDesignFlo"}">Guide</button>`;
  const people = cloud.project
    ? `<button type="button" data-a="cloud-people" class="${peopleOpen ? "on" : ""}" title="Who's in ${esc(cloud.project.name)}, and invite">People</button>`
    : "";
  const projects = view?.setUp
    ? `<button type="button" data-a="cloud-projects" class="${projectsOpen ? "on" : ""}" title="Your projects: switch this file to another, or clear it">Projects</button>`
    : "";
  el.innerHTML = cloud.user
    ? `${guide}${people}${projects}<span class="spacer"></span><span class="who" title="Signed in to CoDesignFlo">${esc(cloud.user.email ?? "Signed in")}</span><button type="button" class="quiet" data-a="cloud-signout">Sign out</button>`
    : `${guide}<span class="spacer"></span>${cloud.code ? `<span class="who">Waiting for approval…</span>` : `<button type="button" class="primary" data-a="cloud-signin">Sign in</button>`}`;
}
$("cloud").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest("button");
  if (!b || !cloud) return;
  try {
    if (b.dataset.a === "cloud-signin") await cloud.signIn();
    if (b.dataset.a === "cloud-signout") {
      peopleOpen = false;
      projectsOpen = false;
      cloud.signOut();
    }
    if (b.dataset.a === "cloud-people") await openPeople(!peopleOpen);
    if (b.dataset.a === "cloud-projects") await openProjects(!projectsOpen);
    if (b.dataset.a === "guide-open") toggleGuide();
  } catch (e) {
    toast((e as Error).message);
  }
});

/** Requests to this plugin's own handlers (applying an update from the service); answered in window.onmessage. */
const localCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** While an update is applied: called whenever Figma reports work in progress (each layer it builds). */
let working: (() => void) | null = null;
/** The panel can't be seen (Figma minimised, behind other windows): Figma and macOS slow plugins down then. */
const inBackground = () => document.visibilityState === "hidden";
let localSeq = 0;
const figmaHere: Figma = {
  call: <T>(method: string, params?: unknown) =>
    new Promise<T>((resolve, reject) => {
      const id = `u${(localSeq++).toString(36)}`;
      localCalls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      toMain({ kind: "req", msg: { t: "req", id, method, params } });
    }),
};

/**
 * Updates from code wait in the service until a plugin has the file open (Figma's free plan: only an open
 * plugin can write the file). Checked when the panel opens and every 15 s while it's open.
 */
let applying: string | null = null;
/** Components and pages done so far in the update being applied. */
let applyProgress: { done: number; total: number } | null = null;
/** An update a developer's sync applies from their computer (sync --local), as `applying` names it. */
const LOCAL = "from the developer's computer";
type LocalProgress = { done: number; total: number; item?: string; finished?: boolean; ok?: boolean };
/**
 * A developer's sync updating Live through the connection: the same notice and bar as an update from the service,
 * step by step (the panel said nothing while components and pages were rebuilt), then how it went.
 */
function localProgress(p: LocalProgress) {
  if (p.finished) {
    if (applying === LOCAL) {
      applying = null;
      applyProgress = null;
      toast(
        p.ok === false
          ? "The developer's sync couldn't update all of Live: they see what went wrong."
          : "Live updated from code (the developer's sync).",
      );
    }
  } else {
    applying = LOCAL;
    applyProgress = { done: p.done, total: p.total };
  }
  render();
}
let applyingId: number | null = null;
let billingCheckedAt = 0;
let lanesCheckedAt = 0;
/**
 * One at a time: started by a timer, by the service's signals and by the panel, and it waits on the service before
 * it marks itself as applying — two starts close together both took the same update and built Live twice over (a
 * second set of a component, its layers moved into it, the first left empty: plugin 0.5.4 and earlier).
 */
let pendingRunning = false;
async function applyPending() {
  if (pendingRunning) return;
  pendingRunning = true;
  try {
    await applyPendingNow();
  } finally {
    pendingRunning = false;
  }
}

async function applyPendingNow() {
  // A panel replaced by a development hot reload stops here (its timer would otherwise keep running, take
  // an update and wait forever for answers that go to the new panel).
  if (retiring || !cloud?.project || applying || !view?.setUp || $("conn").classList.contains("on")) return;
  if (await cloud.refreshChecks()) render();
  // Billing can change any time (the owner subscribes): checked about once a minute.
  if (Date.now() - billingCheckedAt > 60_000) {
    billingCheckedAt = Date.now();
    const before = JSON.stringify(cloud.billing);
    await cloud.refreshBilling();
    if (JSON.stringify(cloud.billing) !== before) render();
  }
  const c = cloud;
  // Lanes of branches disconnected since: taken out, about once a minute.
  if (Date.now() - lanesCheckedAt > 60_000) {
    lanesCheckedAt = Date.now();
    const branches = await c.lanes();
    if (branches) await figmaHere.call("lanesKeep", { branches }).catch(() => undefined);
  }
  const u = await c.takeUpdate().catch(() => null);
  if (!u) return;
  // Replaced while asking (a development reload): give it back for the new panel at once.
  if (retiring) return void c.releaseUpdate(u.id).catch(() => undefined);
  const preview = u.kind === "preview" ? (u.branch ?? "a branch") : null;
  applying = preview ? `preview of ${preview} @${u.commit.slice(0, 7)}` : u.commit.slice(0, 7);
  applyingId = u.id;
  render();
  const lines: string[] = [];
  let ok = true;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // What applying it was like, for CoDesignFlo's team (numbers and signatures only).
  const telemetry: TelemetryEvent[] = [];
  const note = (e: Omit<TelemetryEvent, "source" | "version">) => telemetry.push({ source: "plugin", version: __VERSION__, ...e });
  const started = Date.now();
  let lastStep = 0;
  let beats = 0;
  let hiddenBeats = 0;
  try {
    const events = await c.events();
    const store: Store = {
      ledger: () => events,
      append: (more: LedgerEvent[]) => {
        const have = new Set(events.map((e) => e.id));
        const add = ordered(more.filter((e) => !have.has(e.id)));
        events.push(...add);
        if (add.length) void c.send(add);
        return add;
      },
      generation: (component, gen) => c.generation(component, gen),
      saveGeneration: (component, gen, snap) => c.saveGeneration(component, gen, snap),
    };
    applyProgress = { done: 0, total: (u.payload.sets?.length ?? 0) + (u.payload.screens?.length ?? 0) };
    render();
    // The service hears how far it is every few seconds (the developer's status shows it; it also keeps the
    // update from being handed to another plugin as abandoned).
    // Also while it works, not only when a page is done: before the first page it downloads and loads the
    // pictures, and a page can take a minute — five quiet minutes looked like a stall (0.2.6: "stalled at 0 of
    // 37" while it was working), and ten would hand the update to another plugin as abandoned.
    let told = 0;
    let doing = "";
    const tell = (done: number, total: number, item: string) => {
      doing = item;
      if (done < total && Date.now() - told < 5000) return;
      told = Date.now();
      void c.updateProgress(u.id, done, total, item, inBackground()).catch(() => undefined);
    };
    const beat = () => {
      beats++;
      if (inBackground()) hiddenBeats++;
      tell(applyProgress?.done ?? 0, applyProgress?.total ?? 0, doing);
    };
    working = beat;
    heartbeat = setInterval(beat, 20_000);
    tell(0, applyProgress.total, "");
    // Pictures the file doesn't have yet, from the project's media storage (CLI 0.2.4 and later).
    const refs = [...new Set([...(u.payload.media ?? []), ...Object.values(u.payload.shots ?? {}).map((x) => x.ref)])];
    if (refs.length) {
      const { refs: missing } = await figmaHere.call<{ refs: string[] }>("missingImages", { refs });
      if (missing.length) tell(0, applyProgress.total, `downloading ${missing.length} picture(s)`);
      const downloading = Date.now();
      const got = await c.media(missing, (n) => tell(0, applyProgress!.total, `downloading pictures: ${n} of ${missing.length}`));
      if (missing.length)
        note({
          kind: "timing",
          signature: "plugin.download-pictures",
          data: { ms: Date.now() - downloading, pictures: missing.length, failed: got.failed.length },
        });
      u.payload.images = { ...(u.payload.images ?? {}), ...got.images };
      if (got.failed.length)
        lines.push(
          `! ${got.failed.length} picture(s) couldn't be downloaded from the service — they show as blank in Live; the next update tries again`,
        );
    }
    if (Object.keys(u.payload.images ?? {}).length) tell(0, applyProgress.total, "loading pictures into Figma");
    const onLine = (line: string) => {
      lines.push(line);
      render();
    };
    const r = preview
      ? await applyPreview(figmaHere, u.payload, preview, onLine, (done, total, item) => {
          applyProgress = { done, total };
          tell(done, total, `last: ${item}`);
          render();
        })
      : await applyUpdate(
          figmaHere,
          store,
          u.payload,
          (line) => {
            lines.push(line);
            render();
          },
          (done, total, item) => {
            applyProgress = { done, total };
            tell(done, total, `last: ${item}`);
            // The first one also counts the pictures and tokens before it.
            const now = Date.now();
            note({
              kind: "timing",
              signature: done === 1 ? "plugin.first-step" : item.startsWith("pages.") ? "plugin.page" : "plugin.component",
              data: { ms: now - (lastStep || started), background: inBackground() },
            });
            lastStep = now;
            render();
          },
        );
    lines.push(...r.notes.map((n) => `! ${n}`));
    // Branches merged into the Live branch: their previews are in Live now.
    if (!preview && u.payload.closePreviews?.length)
      await figmaHere.call("previewRemove", { branches: u.payload.closePreviews }).catch(() => undefined);
    await c.saved();
  } catch (e) {
    ok = false;
    lines.push(`couldn't update Live: ${(e as Error).message}`);
  }
  clearInterval(heartbeat);
  working = null;
  // Where Live differs from the app, what couldn't be done, and how long it all took.
  for (const l of lines) {
    if (telemetry.length > 300) break;
    if (l.includes("differs from the app — ")) {
      const g = gapSignature(l);
      note({ kind: "gap", signature: g.signature, data: g.data });
    } else if (/^(! )?[^:]*: fitted to the app after building/.test(l))
      note({ kind: "gap", signature: "fitted to the app after building" });
    else if (/couldn't|failed|missing in Figma/.test(l)) note({ kind: "error", signature: `apply: ${signatureOf(l.replace(/^! /, ""))}` });
  }
  note({
    kind: "timing",
    signature: "plugin.update",
    data: { ms: Date.now() - started, ok, steps: applyProgress?.total ?? 0, background: beats ? hiddenBeats / beats : 0 },
  });
  void c.telemetry(telemetry);
  const recorded = await c.finishUpdate(u.id, ok, lines.join("\n")).then(
    () => true,
    () => false,
  );
  const closed = lines.filter((l) => l.startsWith("closed:")).length;
  // The demo: Alex has no browser; the pages' screenshots are made from Live as now built.
  if (ok && !preview && cloud?.project?.demo && u.commit.startsWith("alex-")) await act("demoShots", {}).catch(() => undefined);
  toast(
    !recorded
      ? `Live was ${ok ? "updated" : "not updated"} from code (${applying}), but the service couldn't be told: an open plugin applies it again in about 10 minutes.`
      : ok && preview
        ? `${preview} on the Live page, beside Live (Branch: ${preview}).`
        : ok
          ? `Live updated from code (${applying})${closed ? ` — ${closed} proposal${closed > 1 ? "s" : ""} done` : ""}.`
          : `Couldn't update Live from code: ${lines[lines.length - 1]}`,
  );
  applying = null;
  applyProgress = null;
  c.reportRefused = null;
  await refresh();
}
const applyTimer = setInterval(() => (retiring ? clearInterval(applyTimer) : void applyPending()), 15_000);
// A copy claimed but not changed yet: the panel looks again every 1.5 s (Figma doesn't always tell about edits
// made with the selection kept, like a colour picked in the fill), so Ready for dev turns on once it differs.
let editCheck = false;
const editTimer = setInterval(() => {
  if (retiring) return clearInterval(editTimer);
  if (editCheck || applying || readyFor || !view?.rows.some((r) => r.state === "in_design" && r.edited === false)) return;
  editCheck = true;
  void refresh().finally(() => {
    editCheck = false;
  });
}, 1_500);
// The demo: while something waits on Alex (the simulated developer): his own feature to ship, or a design sent to
// him, the service moves him on (every 1.5 s, only then); when he uploads an update, it's applied at once.
let alexBusy = false;
const alexTimer = setInterval(() => {
  if (retiring) return clearInterval(alexTimer);
  // Waiting on him: his feature (until it's in Live), or a design sent to him.
  const due = !!view?.setUp && !!view.rows.length && (!rowOf(DEMO.component) || view.rows.some((r) => r.state === "ready_for_dev"));
  if (alexBusy || !cloud?.project?.demo || applying || !due) return;
  if (alexHeld()) return;
  alexBusy = true;
  void cloud
    .demoTick()
    .then((r) => {
      if (!r.did) return;
      alexDid = r.did;
      drawTour();
      return applyPending();
    })
    .catch(() => undefined)
    .finally(() => {
      alexBusy = false;
    });
}, 1_500);
/** Realtime: something happened in the project — check now (several facts land together: one check for them). */
let signalTimer: ReturnType<typeof setTimeout> | null = null;
function onProjectSignal() {
  if (retiring) return;
  if (signalTimer) clearTimeout(signalTimer);
  signalTimer = setTimeout(() => void applyPending(), 500);
}

/** The People screen: who is in this file's project, and an invite by email (usually the designer invites the developer). */
let peopleOpen = false;
let people: Person[] = [];
let inviteEmail = "";
let inviteRole: "developer" | "designer" = "developer";
let newProjectName: string | null = null;
/** The project the designer asked to delete (waiting for "Delete" to be confirmed). */
/** "Quit demo" on a demo project: asking before everything it made goes. */
let quitAsk = false;
let deleteAsk: { id: string; name: string } | null = null;

/**
 * Projects: every project I'm in, from any file (not only an empty one). This file can switch to another project or
 * be cleared, after a second confirmation that says what goes.
 */
let projectsOpen = false;
type FileContents = { live: boolean; proposals: boolean; system: boolean; designs: number; ownPages: number };
let clearAsk: { to: { id: string; name: string } | null; contents: FileContents } | null = null;

async function openProjects(open: boolean) {
  projectsOpen = open;
  clearAsk = null;
  if (open) {
    peopleOpen = false;
    guideOpen = false;
    ds = null;
    myProjects = cloud ? await cloud.myProjects().catch(() => []) : [];
  }
  render();
}

function clearConfirm(a: NonNullable<typeof clearAsk>): string {
  const c = a.contents;
  const goes = [
    c.live ? "<b>Live</b> (the app's components and pages, rebuilt from the code in whichever file uses the project)" : "",
    c.proposals
      ? `<b>Proposals</b>${c.designs ? ` with <b>${c.designs} design${c.designs > 1 ? "s" : ""}</b> on it, including copies not built yet` : ""}`
      : "",
    c.system ? "<b>Design System</b> (your Library links to the code)" : "",
  ].filter(Boolean);
  const current = cloud?.project?.name;
  return `<div class="card clear-ask">
    <div class="what"><b>${a.to ? `Use this file for ${esc(a.to.name)}?` : "Clear CoDesignFlo from this file?"}</b></div>
    <div class="desc">${a.to ? "This file is cleared first. " : ""}From this file, these go for good:</div>
    <ul class="goes">${goes.map((g) => `<li>${g}</li>`).join("") || "<li>its link to the project</li>"}</ul>
    <div class="desc">Your own pages stay${c.ownPages ? ` (${c.ownPages})` : ""}.${current ? ` <b>${esc(current)}</b> itself stays, with its history: open it in another file any time.` : ""} Copy any design you want to keep to your own page first.</div>
    <div class="actions"><button type="button" class="danger" data-a="clear-yes">${a.to ? `Clear and use ${esc(a.to.name)}` : "Clear this file"}</button><button type="button" data-a="clear-no">Cancel</button></div>
  </div>`;
}

function projectsScreen(): string {
  const list = myProjects ?? [];
  const here = ctx?.file.projectId;
  const row = (p: (typeof list)[number]) =>
    `<div class="person"><span class="who">${esc(p.name)}<span class="role"> · ${p.role} · ${p.has_code ? "app connected" : "no code yet"}${
      p.project_id === here ? " · this file" : p.file_name ? ` · uses “${esc(p.file_name)}”` : ""
    }</span></span>${
      p.project_id === here
        ? ""
        : `<button type="button" class="link" data-a="switch-ask" data-p="${esc(p.project_id)}" data-n="${esc(p.name)}">Use in this file…</button>`
    }${p.role === "admin" && p.project_id !== here ? `<button type="button" class="link danger-link" data-a="delete-project" data-p="${esc(p.project_id)}" data-n="${esc(p.name)}">Delete…</button>` : ""}</div>` +
    (deleteAsk?.id === p.project_id ? deleteConfirm(deleteAsk) : "");
  return `<div class="card people">
    <div class="what"><b>Your projects</b><button type="button" class="link" data-a="projects-close">Done</button></div>
    ${clearAsk ? clearConfirm(clearAsk) : ""}
    ${list.length ? list.map(row).join("") : `<div class="hint">You're not in any project yet.</div>`}
    ${here ? `<div class="actions"><button type="button" data-a="clear-ask">Clear this file…</button></div>` : ""}
  </div>`;
}

/** Confirming a project's deletion: everything in it goes, for everyone. */
const deleteConfirm = (p: { id: string; name: string }) =>
  `<div class="notice warn"><span>Delete <b>${esc(p.name)}</b> for everyone in it? Its history, proposals and members go with it; this can't be undone. The Figma file keeps its pages.</span><button type="button" class="danger" data-a="delete-project-yes" data-p="${esc(p.id)}">Delete</button><button type="button" data-a="delete-project-no">Cancel</button></div>`;

/** How a pending invitation's email went. */
function mailLine(m: Person): string {
  if (m.email_status === "sent") return "Invitation email sent";
  if (m.email_status === "failed") return `Email not sent: ${m.email_error ?? "unknown error"}`;
  if (m.email_status === "queued") return "Invitation email on its way";
  return "No invitation email sent";
}

async function openPeople(open: boolean) {
  peopleOpen = open;
  // People, the guide and Design System take the same place: one replaces the other.
  if (open) {
    guideOpen = false;
    projectsOpen = false;
    ds = null;
  }
  if (open && cloud) people = await cloud.people();
  render();
}

function peopleScreen(): string {
  const p = cloud!.project!;
  const rows = people
    .map(
      (m) =>
        `<div class="person"><span class="who">${esc(m.email ?? "(no email)")}</span><span class="role">${m.role}${m.pending ? " · invited" : ""}</span></div>${
          m.pending
            ? `<div class="person-mail"><span class="${m.email_status === "failed" ? "warn-text" : ""}">${esc(mailLine(m))}</span><button type="button" class="link" data-a="resend-invite" data-e="${esc(m.email ?? "")}">${m.email_status ? "Send again" : "Send email"}</button></div>`
            : ""
        }`,
    )
    .join("");
  return `<div class="card people">
    <div class="what"><b>People in ${esc(p.name)}</b><button type="button" class="link" data-a="people-close">Done</button></div>
    ${rows || `<div class="hint">Only you so far.</div>`}
    <div class="what"><b>Invite</b></div>
    <div class="desc">They get an email with what to do — the developer how to connect their coding agent, a designer how to open this plugin — and join when they sign in with that email.</div>
    <input type="email" id="inv-email" value="${esc(inviteEmail)}" placeholder="name@company.com">
    <div class="seg">${(["developer", "designer"] as const)
      .map(
        (r) =>
          `<label class="${inviteRole === r ? "on" : ""}"><input type="radio" name="inv-role" value="${r}" ${inviteRole === r ? "checked" : ""}>${r === "developer" ? "Developer" : "Designer"}</label>`,
      )
      .join("")}</div>
    <div class="actions"><button type="button" class="primary" data-a="invite">Send invite</button></div>
    ${
      deleteAsk?.id === p.id
        ? deleteConfirm(deleteAsk)
        : `<div class="actions"><button type="button" class="link danger-link" data-a="delete-project" data-p="${esc(p.id)}" data-n="${esc(p.name)}">Delete this project…</button></div>`
    }
  </div>`;
}

/** Signed in, file not set up: the designer can start the project here, then invite the developer. */
// ---- bring your designs in: match the designer's existing components and screens with Live, compare, decide ----

type Scan = {
  designs: { nodeId: string; name: string; kind: "component" | "screen"; page: string }[];
  live: { key: string; kind: "component" | "screen" }[];
  pairs: Record<string, string | null>;
  decisions: Record<string, "design" | "code" | "later">;
};
type Compared = { nodeId: string; key: string; differences: number; examples: string[] };
let bringIn: { scan: Scan; results?: Compared[]; sentNew?: boolean; reviewed?: boolean; skip?: Set<string> } | null = null;

function bringInScreen(): string {
  const b = bringIn!;
  const head = (sub: string) =>
    `<div class="screen-head"><button type="button" class="icon" data-a="bring-close" title="Back">${ICON.back}</button><div><div class="name">Bring your designs in</div><div class="status">${sub}</div></div></div>`;
  const nameOf = (id: string) => b.scan.designs.find((d) => d.nodeId === id)?.name ?? id;
  if (!b.results) {
    const group = (kind: "component" | "screen") => {
      const items = b.scan.designs.filter((d) => d.kind === kind);
      if (!items.length) return "";
      const options = b.scan.live.filter((l) => l.kind === kind);
      return `<div class="group">${kind === "component" ? "Your components" : "Your screens"}</div>${items
        .map(
          (d) => `<div class="person"><span class="who" title="${esc(d.page)}">${esc(d.name)}</span><select data-node="${esc(d.nodeId)}">
            <option value="">Not in code yet</option>${options.map((o) => `<option value="${esc(o.key)}" ${b.scan.pairs[d.nodeId] === o.key ? "selected" : ""}>${esc(title(o.key))}</option>`).join("")}</select></div>`,
        )
        .join("")}`;
    };
    return `${head("1 of 2 · Match your designs with the app's")}<div class="card">
      <div class="desc">We matched by name. Fix any pair, or pick "Not in code yet" for designs the app doesn't have.</div>
      ${group("component")}${group("screen")}
      <div class="actions"><button type="button" class="primary" data-a="bring-compare">Compare</button></div></div>`;
  }
  const r = b.results;
  const matched = new Set(Object.values(b.scan.pairs).filter(Boolean) as string[]);
  const same = r.filter((x) => x.differences === 0);
  const differs = r.filter((x) => x.differences > 0);
  const onlyDesign = b.scan.designs.filter((d) => !b.scan.pairs[d.nodeId]);
  const onlyCode = b.scan.live.filter((l) => !matched.has(l.key));
  const decided = (key: string) => b.scan.decisions[key];
  const useLive = (x: Compared) =>
    b.scan.designs.find((d) => d.nodeId === x.nodeId)?.kind === "component"
      ? ` <button type="button" class="link" data-a="bring-use-live" data-node="${esc(x.nodeId)}" data-key="${esc(x.key)}">Use Live in my screens</button>`
      : "";
  const label = { design: "Design wins — your copy is in Proposals", code: "Code wins", later: "Later" } as const;
  return `${head("2 of 2 · Decide what to do")}
    ${
      differs.length
        ? `<div class="card"><div class="what"><b>Differ</b><span class="count">${differs.length}</span></div><div class="desc">Design wins: we claim it and carry your design into the copy — check it and send it. Code wins: the app's version stands. Later: it stays listed.</div>${differs
            .map(
              (
                x,
              ) => `<div class="kept-row"><span><b>${esc(nameOf(x.nodeId))}</b> ↔ ${esc(title(x.key))} · ${x.differences} difference${x.differences > 1 ? "s" : ""}<br><span class="desc">${esc(x.examples.join(", "))}</span></span></div>
        <div class="actions">${decided(x.key) ? `<span class="desc">${label[decided(x.key)!]}</span>${decided(x.key) === "code" ? useLive(x) : ""}` : `<button type="button" data-a="bring-design" data-node="${esc(x.nodeId)}" data-key="${esc(x.key)}">Design wins</button><button type="button" data-a="bring-code" data-key="${esc(x.key)}">Code wins</button><button type="button" data-a="bring-later" data-key="${esc(x.key)}">Later</button>`}</div>`,
            )
            .join("")}</div>`
        : ""
    }
    ${same.length ? `<div class="card quiet"><div class="what"><b>Match</b><span class="count">${same.length}</span></div>${same.map((x) => `<div class="kept-row"><span>${esc(nameOf(x.nodeId))} ↔ ${esc(title(x.key))}</span>${useLive(x)}</div>`).join("")}</div>` : ""}
    ${onlyDesign.length ? `<div class="card"><div class="what"><b>Only in your designs</b><span class="count">${onlyDesign.length}</span></div><div class="desc">${b.sentNew ? "Sent as new designs." : "Ticked ones go to the developer as new designs; untick mockups and explorations."}</div>${b.sentNew ? "" : onlyDesign.map((d) => `<label class="kept-row"><span><input type="checkbox" data-send="${esc(d.nodeId)}" ${b.skip?.has(d.nodeId) ? "" : "checked"}> ${esc(d.name)} <span class="desc">· ${d.kind === "screen" ? "page" : "component"}</span></span></label>`).join("")}<div class="actions">${b.sentNew ? "" : `<button type="button" class="primary" data-a="bring-send-new">Send as new designs</button>`}</div></div>` : ""}
    ${onlyCode.length ? `<div class="card"><div class="what"><b>Only in the app</b><span class="count">${onlyCode.length}</span></div><div class="desc">${esc(onlyCode.map((l) => title(l.key)).join(", "))}</div><div class="actions">${b.reviewed ? `<span class="desc">Listed as New in code</span>` : `<button type="button" data-a="bring-review">Show them to me as New in code</button>`}</div></div>` : ""}
    <div class="actions"><button type="button" class="primary" data-a="bring-done">Done for now</button></div>`;
}

// ---- getting started: a checklist that follows the path this project is on ----

/**
 * Which way this project started: the designer first (no code yet), the developer first (the app arrives in
 * Live, nothing of the designer's in the file), or both exist and need bringing together.
 */
function guidePath(): "design-first" | "code-first" | "reconcile" {
  const hasLive = !!view?.lastSyncAt || !!view?.rows.some((r) => r.liveNodeId);
  if (!cloud?.project?.hasCode && !hasLive) return "design-first";
  const own = (view?.ownDesigns?.components ?? 0) + (view?.ownDesigns?.frames ?? 0);
  return own > 0 && !view?.reconciled ? "reconcile" : "code-first";
}

const guidePrefs = () => (cloud?.project ? (ctx?.guide[cloud.project.id] ?? {}) : {});

function guideDone(p: GuidePrefs) {
  if (!cloud?.project || !ctx) return;
  ctx.guide[cloud.project.id] = { ...guidePrefs(), ...p };
  toMain({ kind: "guide", projectId: cloud.project.id, prefs: p });
}

/** The full guide (header → Guide): how Live and Proposals work, the three ways to start, day-to-day tasks. */
let guideOpen = false;
/** Guide sections the designer opened: kept across the panel's redraws (it redraws on updates and selection). */
const guideSections = new Set<string>();
let guideSectionsSet = false;
document.addEventListener(
  "toggle",
  (ev) => {
    const d = ev.target as HTMLDetailsElement;
    if (!d.dataset?.g) return;
    if (d.open) guideSections.add(d.dataset.g);
    else guideSections.delete(d.dataset.g);
  },
  true,
);
type Path = ReturnType<typeof guidePath>;
const PATHS: { id: Path; title: string; when: string; steps: string[] }[] = [
  {
    id: "design-first",
    title: "You have designs, there's no app yet",
    when: "Designer first",
    steps: [
      "<b>Start a project</b> for this file (or pick the one your developer started).",
      "Select your frames — several at once — and use <b>Send N designs</b> (<b>Send new design</b> for one): mark each as a <i>Component</i> (buttons, cards…) or a <i>Page</i>. Components go first, then the pages that use them.",
      "<b>People → Invite</b> your developer. They connect the code from their coding agent and build what you sent.",
      "As it's built, it arrives in <b>Live</b>: your pages become Live's base, kept as you drew them; the code's changes are applied on top.",
    ],
  },
  {
    id: "code-first",
    title: "The developer has an app already",
    when: "Developer first",
    steps: [
      "The developer starts the project from their coding agent and invites you — or you start it here and invite them.",
      "In an empty file, pick the project under <b>Use this file</b>: <b>Live</b> fills with the app's components and pages within a minute.",
      "Rows marked <b>New in code</b> are things the developer built: say <i>Looks good</i>, <i>No design needed</i>, or <i>Claim to redesign</i>.",
      "From there, change anything the usual way: claim it, edit your copy, send it (see <i>Day to day</i>).",
    ],
  },
  {
    id: "reconcile",
    title: "Both exist: your designs and a working app",
    when: "Bring them together",
    steps: [
      "Set the project up as when the developer has an app, so Live shows the app.",
      "<b>Bring your designs in</b>: CoDesignFlo matches your frames with Live's components and pages and shows where they differ.",
      "Decide for each: <i>the design wins</i> (sent to the developer as a proposal), <i>the code wins</i>, or <i>later</i>.",
      "What the developer builds from your designs lands in Live on top of your frames.",
    ],
  },
];
const SEATS = "Free sends and your seat";
const DAILY: [string, string][] = [
  [
    SEATS,
    "Every designer sends their first 5 designs to dev for free (each <b>Ready for dev</b> or new design is one); the panel counts what's left. After that, sending needs a <b>designer seat</b>, yours in every project: get it in <b>Billing</b> at codesignflo.com, or someone pays for it (a team lead adds your email). Developers are always free; the demo's sends never count.",
  ],
  [
    "Who does what",
    "In a project you're a <b>designer</b>, a <b>developer</b> or an <b>admin</b> (both). Designers claim and send designs; developers review and build them. Someone who does both should be an admin: an admin makes them one by inviting them again as admin.",
  ],
  [
    "Change a component or page",
    "Click its row → <b>Claim</b>: your copy opens in Proposals (Live stays as the code has it). Edit the copy, then <b>Ready for dev…</b> with a note. The row shows how much is in the code; it closes by itself when the code catches up, and Live is then built on your copy.",
  ],
  ["Design something new", "Draw it anywhere outside Live, select it and use <b>Send new design</b> (component or page)."],
  [
    "Mockup framing",
    "A browser window bar or a device frame drawn around a page is presentation, not part of the app: the developer is told not to build it, and Live shows the page as the app draws it.",
  ],
  [
    "The developer added something",
    "It shows as <b>New in code</b>: <i>Looks good</i>, <i>No design needed</i>, or <i>Claim to redesign</i>.",
  ],
  [
    "The code can't do part of it",
    "On a sent proposal (⋯ menu): <b>Keep the rest as design</b> — Live keeps your version of those properties — or <b>Accept the code's version</b>.",
  ],
  ["Something left the code", "It moves to Archive in Proposals: delete it or keep it — your decision."],
  ["How close Live is", "A row says where the app differs from your design, or where Live couldn't match the app, with a % match."],
  ["Find things", "Click a row to see it on the canvas; select something on the canvas to find its row."],
];
function guideScreen(): string {
  const current = view?.setUp ? guidePath() : null;
  // What's open on screen right now wins (a section opened a moment before a redraw).
  for (const d of Array.from(document.querySelectorAll<HTMLDetailsElement>("details[data-g]"))) {
    if (d.open) guideSections.add(d.dataset.g!);
    else guideSections.delete(d.dataset.g!);
  }
  // First opened: the designer's own situation is open.
  if (!guideSectionsSet) {
    guideSections.add(`path:${current ?? "design-first"}`);
    guideSectionsSet = true;
  }
  const isOpen = (id: string) => (guideSections.has(id) ? " open" : "");
  const steps = (p: (typeof PATHS)[number]) => `<ol class="g-steps">${p.steps.map((x) => `<li>${x}</li>`).join("")}</ol>`;
  return `<div class="card guide-screen">
    <div class="what"><b>How CoDesignFlo works</b><button type="button" class="link" data-a="guide-close">Done</button></div>
    <div class="desc">Design and code stay in step: you design in this file, the developer builds with their coding agent, and each side sees what the other changed.</div>
    ${
      cloud?.user && !cloud.project?.demo
        ? view?.setUp
          ? `<div class="desc"><b>Try the demo:</b> open a new, empty Figma file and choose <i>Try a demo</i> there: a sample app and a simulated developer, with a step-by-step guide.</div>`
          : `<div class="actions"><button type="button" class="primary" data-a="try-demo">Try a demo</button><span class="desc">A sample app and a simulated developer, with a step-by-step guide.</span></div>`
        : ""
    }
    <div class="g-pages">
      <div><b>Live</b> page — your app as the code draws it, kept up to date by the developer's updates. <i>Components</i> holds the components the code draws, <i>Pages</i> the pages, and <i>Screenshots</i>, level with each page, the app as the browser draws it, to compare with. Pages you designed are kept as you drew them, with the code's changes on top; what you didn't design is generated from the code. Live is the code's: to change something, click it and claim it (edits made in Live itself are moved to Proposals by the next update).</div>
      <div><b>Proposals</b> page — <i>Active</i>: your copies being changed and the designs you sent. <i>Archive</i>: what's done or withdrawn, and the designs Live is built on.</div>
      <div><b>Design System</b> page (optional, from the link at the bottom of the panel) — <i>Library</i>: your components (instances from your team library, or copies), each linked to a code component or not in code yet. <i>From code</i>: a copy of each code component you have no counterpart for, to accept, match or ignore. Live's pages are drawn with your linked components, and each pair shows where it differs from what the app draws.</div>
      <div><b>The loop</b> — you propose in Proposals → the developer's agent implements it → when the code matches, the proposal closes and Live updates.</div>
    </div>
    <div class="what"><b>Getting started</b></div>
    <details class="g-path" data-g="path:demo"${isOpen("path:demo")}><summary><b>Try it first: the demo</b> <span class="g-when">About ten minutes, nothing counts</span></summary><ol class="g-steps">
      <li>In a new, empty file, choose <b>Try a demo</b>: a small shop's website arrives in <b>Live</b>, drawn from its code, with Alex, a simulated developer.</li>
      <li>Follow the step-by-step guide: claim the Button, change your copy, send it to Alex.</li>
      <li>Alex reviews it and builds it; Live is rebuilt from the code and your design closes by itself.</li>
      <li><b>Quit demo</b> (top) removes everything the demo made; <b>Try a demo</b> starts it fresh.</li>
    </ol></details>
    ${PATHS.map(
      (p) =>
        `<details class="g-path" data-g="path:${p.id}"${isOpen(`path:${p.id}`)}><summary><b>${esc(p.title)}</b> <span class="g-when">${esc(p.when)}${p.id === current ? " · this project" : ""}</span></summary>${steps(p)}</details>`,
    ).join("")}
    <div class="what"><b>Day to day</b></div>
    ${DAILY.filter(([t]) => !(selfhost() && t === SEATS))
      .map(
        ([t, how]) =>
          `<details class="g-path" data-g="daily:${esc(t)}"${isOpen(`daily:${t}`)}><summary><b>${esc(t)}</b></summary><div class="desc">${how}</div></details>`,
      )
      .join("")}
    <div class="desc g-legend">Row statuses: <b>In sync</b> · <b>New in code</b> (built by the developer, not reviewed) · <b>In design</b> (your copy) · <b>Ready for dev</b> (sent) · <b>New design</b> (sent, not built yet) · <b>Ignored</b> (no design needed).</div>
    ${cloud?.project && guidePrefs().hidden ? `<div class="actions"><button type="button" data-a="guide-show">Show the checklist again</button></div>` : ""}
  </div>`;
}

/** An empty file: what CoDesignFlo does and the three ways to start, before any project. */
function introCard(): string {
  // Put away: the header's Guide button opens the guide.
  if (ctx?.guide[DEMO_PREFS]?.introHidden) return "";
  return `<div class="card guide">
    <div class="what"><b>Welcome to CoDesignFlo</b></div>
    <div class="desc">Keeps this file and your app's code in step.</div>
    <div class="actions"><button type="button" data-a="guide-open">Open the guide</button><button type="button" class="quiet" data-a="intro-hide">Not now</button></div>
    <div class="desc">${cloud?.user ? "Start a project below, or pick the one your developer started." : "Sign in (top right) to start a project, or to pick the one your developer started."}</div>
  </div>`;
}

/** The project's Getting started checklist can show (else Guide opens the full guide). */
// Not in the demo: its walkthrough guides instead.
const hasChecklist = () => !!cloud?.project && !!view?.setUp && !cloud.project.demo;
/**
 * The header's Guide: shows or hides Getting started (from which the full guide opens); from People or the
 * full guide, back to Getting started. Without a project to start, the full guide.
 */
function toggleGuide() {
  ds = null;
  if (!hasChecklist()) {
    guideOpen = !guideOpen;
    if (guideOpen) peopleOpen = false;
  } else if (peopleOpen || guideOpen) {
    peopleOpen = false;
    guideOpen = false;
    if (guidePrefs().hidden) guideDone({ hidden: false });
  } else guideDone({ hidden: !guidePrefs().hidden });
  render();
}

function guideHtml(): string {
  if (!cloud?.project || !view?.setUp || guidePrefs().hidden) return "";
  const rows = view.rows;
  const hasLive = !!view.lastSyncAt || rows.some((r) => r.liveNodeId);
  const developer = !!cloud.team?.some(
    (m) => m.role === "developer" || (m.role === "admin" && !m.pending && m.email !== cloud?.user?.email),
  );
  const prefs = guidePrefs();
  const path = guidePath();
  const steps: { done: boolean; title: string; how: string; action?: string }[] =
    path === "design-first"
      ? [
          {
            done: rows.some((r) => r.state === "design_new") || hasLive,
            title: "Send your designs to the developer",
            how: "Select a frame — or several — and send it as a new design. Components first, then the pages that use them.",
          },
          {
            done: developer,
            title: "Invite your developer",
            how: "People → Invite, with their email. They connect the code from their coding agent.",
            action: "cloud-people",
          },
          {
            done: cloud.project.hasCode,
            title: "Your developer connects the code",
            how: "Their coding agent links the app to this project.",
          },
          {
            done: hasLive,
            title: "Your designs, built, arrive in Live",
            how: "As the developer builds them, they appear in Live: your pages stay as you drew them, with the code's changes on top.",
          },
          {
            done: !!prefs.claimed,
            title: "Change something: claim it",
            how: "Click a row → Claim. Your copy opens in Proposals; edit it and send it with Ready for dev.",
          },
        ]
      : [
          {
            done: hasLive,
            title: "Your app arrives in Live",
            how: "The developer's latest update is applied when this file is open (usually within a minute).",
          },
          ...(path === "reconcile"
            ? [
                {
                  done: !!view.reconciled,
                  title: "Bring your designs in",
                  how: "Match your existing components and screens with Live, see where design and code differ, and decide what to do.",
                  action: "reconcile-open",
                },
              ]
            : []),
          {
            done: !!prefs.claimed,
            title: "Claim a component to change it",
            how: "Your copy opens in Proposals; Live stays as the code has it.",
          },
          {
            done: !!prefs.sent,
            title: "Send it to the developer",
            how: "Ready for dev: check your changes, add a note. You'll see when it's done in code.",
          },
          { done: developer, title: "Your developer is in", how: "People shows who's in the project.", action: "cloud-people" },
        ];
  if (steps.every((s) => s.done)) return "";
  const next = steps.find((s) => !s.done)!;
  return `<div class="card guide">
    <div class="what"><b>Getting started</b><span><button type="button" class="link" data-a="guide-open">Guide</button> · <button type="button" class="link" data-a="guide-hide" title="The Guide button at the top brings it back">Hide</button></span></div>
    ${steps
      .map(
        (s) =>
          `<div class="step${s.done ? " done" : ""}${s === next ? " next" : ""}"><span class="tick">${s.done ? "✓" : ""}</span><span><b>${esc(s.title)}</b>${s === next ? `<br><span class="desc">${esc(s.how)}</span>${s.action ? ` <button type="button" class="link" data-a="${s.action}">${s.action === "reconcile-open" ? "Start" : "Open"}</button>` : ""}` : ""}</span></div>`,
      )
      .join("")}
  </div>`;
}

/** Components and pages the code removed: in Archive, waiting for the designer to delete or keep them. */
let removedAsk: { uses: number } | null = null;
function removedCard(): string {
  const list = view?.removedFromCode ?? [];
  if (!list.length) return "";
  return `<div class="card">
    <div class="what"><b>Removed from the code</b><span class="count">${list.length}</span></div>
    <div class="desc">The app no longer has these, so they left Live and are in Proposals → Archive. Delete them, or keep them there.</div>
    ${list.map((r) => `<div class="kept-row"><span>${esc(title(r.name))}</span><button type="button" class="link" data-a="show" data-node="${esc(r.nodeId)}">Show</button></div>`).join("")}
    ${removedAsk ? `<div class="warn">${ICON.warn}<span>${removedAsk.uses} instance${removedAsk.uses > 1 ? "s" : ""} in your own screens use${removedAsk.uses > 1 ? "" : "s"} them; deleting leaves ${removedAsk.uses > 1 ? "them" : "it"} without a main component.</span></div>` : ""}
    <div class="actions"><button type="button" data-a="removed-delete">${removedAsk ? "Delete anyway" : list.length > 1 ? "Delete all" : "Delete"}</button><button type="button" data-a="removed-keep">Keep in Archive</button></div>
  </div>`;
}

/** Projects I'm in, for an empty file: the developer may have started one already (their app, no file yet). */
let myProjects: Awaited<ReturnType<Cloud["myProjects"]>> | null = null;

function useFileCard(): string {
  const list = myProjects ?? [];
  if (!list.length) return "";
  const waiting = list.filter((p) => !p.file_name);
  const others = list.filter((p) => p.file_name);
  const row = (p: (typeof list)[number]) =>
    `<div class="person"><span class="who">${esc(p.name)}<span class="role"> · ${p.has_code ? "app connected" : "no code yet"}${p.file_name ? ` · uses “${esc(p.file_name)}”` : ""}</span></span><button type="button" class="link" data-a="use-file" data-p="${esc(p.project_id)}">Use this file</button>${p.role === "admin" ? `<button type="button" class="link danger-link" data-a="delete-project" data-p="${esc(p.project_id)}" data-n="${esc(p.name)}">Delete…</button>` : ""}</div>` +
    (deleteAsk?.id === p.project_id ? deleteConfirm(deleteAsk) : "");
  return `<div class="card">
    <div class="what"><b>${waiting.length ? "Use this file for your project" : "Your projects"}</b></div>
    <div class="desc">${waiting.length ? "Your developer started these. Pick one: this file gets the app's components and pages (Live) right away." : "These already use another file. You can use this one instead."}</div>
    ${[...waiting, ...others].map(row).join("")}
  </div>`;
}

/** The demo card can be put away for good ("Not now"); the full guide still offers the demo. */
const DEMO_PREFS = "*";
const demoHidden = () => ctx?.guide[DEMO_PREFS]?.demoHidden === true;

/** The guided demo, offered first before a real project: a sample app and a simulated developer; nothing counts. */
function demoCard(): string {
  if (demoHidden()) return "";
  return `<div class="card demo">
    <div class="what"><b>New here? Try a demo</b></div>
    <div class="desc">A sample app in Live and a simulated developer, Alex. A guide walks you through the whole loop in about ten minutes. Demo sends don't count toward your free sends.</div>
    <div class="actions"><button type="button" class="primary" data-a="try-demo">Try a demo</button><button type="button" class="quiet" data-a="demo-hide">Not now</button></div>
  </div>`;
}

function startProjectCard(): string {
  const name = newProjectName ?? ctx?.file.name ?? "";
  return `<div class="card new">
    <div class="what"><b>Start a project for this file</b></div>
    <div class="desc">Sets this file up for CoDesignFlo, then you invite your developer. Their coding agent links the code when they connect.</div>
    <input type="text" id="np-name" value="${esc(name)}" placeholder="Project name">
    <div class="actions"><button type="button" class="primary" data-a="start-project">Start project</button></div>
  </div>`;
}

/**
 * The Design System screen: the designer's Library next to the code's components — suggested links to
 * confirm, From-code copies to accept, match or ignore, each linked pair's differences, and the tokens.
 */
type Conflict = { conflict: { k: string; linkedTo: string; nodeId: string } };
let ds: {
  s: SystemState;
  mapFor?: string;
  ask?: Conflict["conflict"] & { retry: { action: PanelAction; params: Record<string, unknown> } };
} | null = null;

async function openSystem() {
  ds = { s: await act<SystemState>("dsState") };
  guideOpen = false;
  peopleOpen = false;
  render();
}
async function refreshSystem() {
  if (ds) ds = { ...ds, s: await act<SystemState>("dsState") };
  render();
}
/** A link that would replace another asks first. */
async function dsLinkAction(action: PanelAction, params: Record<string, unknown>) {
  const r = await act<Conflict | object>(action, params);
  if (r && "conflict" in r) {
    ds!.ask = { ...r.conflict, retry: { action, params } };
    render();
    return;
  }
  ds!.ask = undefined;
  await refreshSystem();
}

function systemScreen(): string {
  const { s, mapFor, ask } = ds!;
  const linked = s.library.filter((l) => l.link).length;
  const head = `<div class="screen-head"><button type="button" class="icon" data-a="ds-close" title="Back">${ICON.back}</button><div><div class="name">Design System</div><div class="status">${
    s.page ? `${linked} linked · ${s.fromCode.length} in From code` : "Your components, linked to the code's"
  }</div></div></div>`;
  if (!s.page) {
    const full = s.setup.pages >= 3;
    const lib =
      s.setup.libraries === null
        ? ""
        : s.setup.libraries > 0
          ? `<div class="desc">A team library is enabled for this file: place instances of its components in <b>Library</b>. They stay linked to the library and keep updating from it.</div>`
          : `<div class="desc">No team library is enabled for this file: copy your components into <b>Library</b> (on a paid plan, enable your library under Assets › Libraries and place its components instead: they keep updating from it).</div>`;
    return `${head}<div class="card">
      <div class="desc">A <b>Design System</b> page next to Live: <b>Library</b> holds your components, <b>From code</b> a copy of each code component you don't have yet. Link yours to the code's, and Live's pages are drawn with your components; each pair shows where it differs from what the app draws.</div>
      ${lib}
      ${full ? `<div class="notice warn"><span>This file has ${s.setup.pages} pages. On Figma's free plan a file has 3, and Live and Proposals take two: remove a page of your own first (move it to Proposals or another file), or use a paid plan.</span></div>` : ""}
      <div class="actions"><button type="button" class="primary" data-a="ds-create">Create the Design System page</button></div></div>`;
  }
  const codeOptions = (sel?: string, onlyFree = true) =>
    s.code
      .filter((c) => !onlyFree || !c.linked || c.k === sel)
      .map((c) => `<option value="${esc(c.k)}" ${c.k === sel ? "selected" : ""}>${esc(title(c.k))}</option>`)
      .join("");
  const parts: string[] = [head];
  if (ask)
    parts.push(
      `<div class="notice warn"><span>${esc(title(ask.k))} is already linked to <b>${esc(ask.linkedTo)}</b>. Replace the link, or keep the current one?</span><button type="button" data-a="ds-replace">Replace</button><button type="button" data-a="ds-keep">Keep</button></div>`,
    );
  if (s.suggestions.length)
    parts.push(
      `<div class="card"><div class="what"><b>Suggested links</b></div><div class="desc">Your components that look like the code's. Link each, pick another, or turn it down.</div>${s.suggestions
        .map(
          (x, i) => `<div class="person"><span class="who">${esc(x.name)}</span><select id="dss-${i}">${codeOptions(x.k)}</select></div>
        <div class="person-mail"><span>${esc(x.why)}</span><button type="button" class="link" data-a="ds-link" data-node="${esc(x.id)}" data-sel="dss-${i}" data-sug="${esc(x.k)}">Link</button><button type="button" class="link" data-a="ds-reject" data-node="${esc(x.id)}" data-k="${esc(x.k)}">Not this</button></div>`,
        )
        .join("")}</div>`,
    );
  const free = s.library.filter((l) => !l.link && !l.copied);
  if (s.fromCode.length)
    parts.push(
      `<div class="card"><div class="what"><b>From code</b><span class="count">${s.fromCode.length}</span></div><div class="desc">The code's components you have no counterpart for: accept one into your Library (or drag it there), match it to one of yours, or ignore it.</div>${s.fromCode
        .map(
          (
            f,
            i,
          ) => `<div class="person"><span class="who">${esc(title(f.k))}</span><button type="button" class="link" data-a="ds-show" data-node="${esc(f.id)}">Show</button></div>
        ${f.inLibrary !== undefined ? `<div class="person-mail"><span>Dragged into Library, but it's linked to ${esc(f.inLibrary)}.</span><button type="button" class="link" data-a="ds-accept" data-k="${esc(f.k)}">Link this one</button></div>` : ""}
        <div class="person-mail"><button type="button" class="link" data-a="ds-accept" data-k="${esc(f.k)}">Accept</button>${
          free.length
            ? `<select id="dsf-${i}"><option value="">Match to…</option>${free.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("")}</select><button type="button" class="link" data-a="ds-match" data-k="${esc(f.k)}" data-sel="dsf-${i}">Match</button>`
            : ""
        }<button type="button" class="link" data-a="ds-ignore" data-k="${esc(f.k)}">Ignore</button></div>`,
        )
        .join("")}</div>`,
    );
  const ago2 = (iso?: string) => (iso ? ago(iso) : "");
  parts.push(
    `<div class="card"><div class="what"><b>Library</b><span class="count">${s.library.length}</span></div>${
      s.library.length
        ? s.library
            .map((l, i) => {
              const where = l.remote ? "team library" : `the file's own${l.seen ? `, brought in ${ago2(l.seen)}` : ""}`;
              const head2 = `<div class="person"><span class="who">${esc(l.name)}</span><span class="role">${where}</span></div>`;
              if (l.link) {
                const diffs = l.link.differs.length
                  ? `<div class="desc warn-text">Differs from the app: ${l.link.differs.map(esc).join("; ")}</div>`
                  : `<div class="desc">Same as the app draws it.</div>`;
                const mapping =
                  mapFor === l.id
                    ? `<div class="desc">How its properties correspond (code → yours):</div>${Object.entries(l.link.codeProps)
                        .map(([p, values]) => {
                          const q = l.link!.map.props[p] ?? "";
                          const opts = Object.keys(l.props)
                            .map((x) => `<option ${x === q ? "selected" : ""}>${esc(x)}</option>`)
                            .join("");
                          return `<div class="person"><span class="who">${esc(p)}</span><select id="dsmp-${esc(p)}"><option value="">(none)</option>${opts}</select></div>${values
                            .map((v) => {
                              const lv = l.link!.map.values[p]?.[v] ?? "";
                              const vo = (l.props[q] ?? []).map((x) => `<option ${x === lv ? "selected" : ""}>${esc(x)}</option>`).join("");
                              return `<div class="person-mail"><span>${esc(p)}=${esc(v)}</span><select id="dsmv-${esc(p)}-${esc(v)}"><option value="">(none)</option>${vo}</select></div>`;
                            })
                            .join("")}`;
                        })
                        .join(
                          "",
                        )}<div class="actions"><button type="button" class="primary" data-a="ds-map-save" data-node="${esc(l.id)}">Save</button><button type="button" data-a="ds-map-close">Cancel</button></div>`
                    : "";
                return `${head2}<div class="person-mail"><span>${l.link.gone ? `<span class="warn-text">No longer in code</span> (was ${esc(title(l.link.k))})` : `Linked to ${esc(title(l.link.k))}`}</span>${
                  Object.keys(l.link.codeProps).length
                    ? `<button type="button" class="link" data-a="ds-map" data-node="${esc(l.id)}">Properties</button>`
                    : ""
                }<button type="button" class="link" data-a="ds-unlink" data-node="${esc(l.id)}">Unlink</button></div>${l.link.gone ? "" : diffs}${mapping}`;
              }
              if (l.pending)
                return `${head2}<div class="person-mail"><span>Sent to the developer as new: linked when it's in the code.</span></div>`;
              if (l.copied) return `${head2}<div class="person-mail"><span>Copied from code; not linked (see From code).</span></div>`;
              return `${head2}<div class="person-mail"><select id="dsl-${i}"><option value="">Link to…</option>${codeOptions()}</select><button type="button" class="link" data-a="ds-link" data-node="${esc(l.id)}" data-sel="dsl-${i}">Link</button><button type="button" class="link" data-a="ds-send-new" data-node="${esc(l.id)}">Not in code: send to dev</button></div>`;
            })
            .join("")
        : `<div class="desc">Empty so far. Bring your components in here: ${s.setup.libraries ? "instances from your team library, or copies" : "copy them from your other files"}, or accept the code's from From code.</div>`
    }</div>`,
  );
  if (s.tokens.suggestions.length || s.tokens.linked.length)
    parts.push(
      `<div class="card"><div class="what"><b>Tokens</b></div><div class="desc">Code tokens that look like your variables: linked ones bind Live's layers to your variables.</div>${s.tokens.suggestions
        .map(
          (
            t,
          ) => `<div class="person"><span class="who">${esc(t.token)}</span><span class="role">${esc(t.collection)} / ${esc(t.name)}</span></div>
        <div class="person-mail"><span>${esc(t.why)}</span><button type="button" class="link" data-a="ds-token" data-t="${esc(t.token)}" data-node="${esc(t.id)}">Link</button><button type="button" class="link" data-a="ds-token-reject" data-t="${esc(t.token)}" data-node="${esc(t.id)}">Not this</button></div>`,
        )
        .join("")}${s.tokens.linked
        .map(
          (t) =>
            `<div class="person"><span class="who">${esc(t.token)}</span><span class="role">→ ${esc(t.name)}</span><button type="button" class="link" data-a="ds-token-unlink" data-t="${esc(t.token)}">Unlink</button></div>`,
        )
        .join("")}</div>`,
    );
  if (s.ignored.length)
    parts.push(
      `<div class="card"><div class="what"><b>Ignored</b></div>${s.ignored
        .map(
          (k) =>
            `<div class="person"><span class="who">${esc(title(k))}</span><button type="button" class="link" data-a="ds-unignore" data-k="${esc(k)}">Show again</button></div>`,
        )
        .join("")}</div>`,
    );
  return parts.join("");
}

// ---- The demo walkthrough ------------------------------------------------------------------------------
// On a demo project, a step-by-step guide over the panel: each step points at what to do (the rest of the panel
// dims), outlines the layer it's about on the canvas, and moves on by itself once it's done. Its progress is
// kept with the file's guide preferences, so closing the plugin keeps the place.

type TourMark = { nodeId: string; label: string };
type TourStep = {
  title: string;
  /** What to read (or, as a function, depending on what's on screen). */
  text: string | (() => string);
  /** What to click in the panel (a CSS selector), if anything. */
  target?: () => string | null;
  /** The layer to outline on the canvas, with its label. */
  mark?: () => TourMark | TourMark[] | null;
  /** Done when this holds: the walkthrough moves on by itself. */
  done?: () => boolean;
  /** A step to read: its button. */
  next?: string;
  /** The component row the step is about: its section is unfolded so it can be seen. */
  row?: string;
  /**
   * A screen with things to fill in (the send screen: scope, note): the card sits at the top of the panel and
   * nothing dims, so every field stays visible and usable; what to click keeps a soft outline.
   */
  form?: boolean;
  /** A step that waits for Alex: what he's doing, shown moving (no button; it moves on by itself). */
  wait?: string;
  /** Alex's agent at work, as a terminal, while this step waits. */
  term?: AlexPhase;
};

type AlexPhase = "ship" | "review" | "build";
/** The walkthrough's card shrunk to a small "Guide" pill (this session), out of the way. */
let tourMin = false;
/** The terminal's pace: a line every so often. */
const LINE_MS = 550;
/** How long after the terminal of a phase starts Alex may act (set as it's drawn), and when it started. */
let alexDueAfter: { phase: AlexPhase; ms: number } | null = null;
let alexTermStarted: { phase: AlexPhase; at: number } | null = null;
/** Alex waits for his terminal while the walkthrough shows it (with the guide closed, he goes at his pace). */
function alexHeld(): boolean {
  // His feature waits for the walkthrough's step that shows him shipping it (not during the welcome).
  if (tourOn() && !tourMin && !rowOf(DEMO.component) && tourPrefs().step < TOUR.findIndex((t) => t.term === "ship")) return true;
  if (!tourOn() || tourMin || !alexDueAfter || !alexTermStarted || alexTermStarted.phase !== alexDueAfter.phase) return false;
  return Date.now() - alexTermStarted.at < alexDueAfter.ms;
}

/** The demo: what was just sent to Alex, for the animation of his agent at work. */
let lastSent: { component: string; changes: { what: string; layer: string; from: string; to: string }[] } | null = null;

/**
 * Alex's coding agent at work, as a terminal: its lines appear one after another (CSS delays), from what was
 * sent. "review" while he reads it, "build" while he codes it, syncs and uploads.
 */
function alexTerminal(phase: AlexPhase): string {
  const name = title(DEMO.component);
  const file = DEMO.file;
  const changes = lastSent?.component === DEMO.component ? lastSent.changes : [];
  const line = (cls: string, text: string) => [cls, text] as const;
  const lines =
    phase === "ship"
      ? [
          line("cmd", `edit src/components/${file}/${file}.tsx`),
          line("add", "<span className={styles.badge}>Free shipping</span>"),
          line("cmd", "edit src/components/ProductCard/ProductCard.tsx"),
          line("add", "{freeShipping && <ShippingBadge />}"),
          line("cmd", 'git commit -m "Free shipping badge on the products that ship free"'),
          line("cmd", "codesignflo sync"),
          line("ok", `1 new component (${name}) · the product card and 2 pages changed`),
          line("ok", "Live update uploaded"),
        ]
      : phase === "review"
        ? [
            line("cmd", "codesignflo review_queue"),
            line("out", `1 design waiting: ${name} (from you)`),
            line("cmd", `codesignflo get_proposal ${DEMO.component} --review`),
            ...(changes.length
              ? changes.map((c) => line("out", `${c.what} · ${c.layer}: ${c.from} → ${c.to}`))
              : [line("out", "reading your changes…")]),
            line("ok", "Clear and buildable. Approved."),
          ]
        : [
            line("cmd", `edit src/components/${file}/${file}.module.css`),
            ...(changes.length
              ? changes.flatMap((c) => [line("del", `${c.what}: ${c.from}`), line("add", `${c.what}: ${c.to}`)])
              : [line("del", "the old styles"), line("add", "your design")]),
            line("cmd", `git commit -m "${name}: the designer's changes"`),
            line("cmd", "codesignflo sync"),
            line("ok", `${changes.length || 1} of ${changes.length || 1} of the designer's changes in the code — looks done`),
            line("ok", "Live update uploaded"),
          ];
  // Alex is paced by it: his review lands once its lines have played, his build is uploaded at "codesignflo sync".
  // His feature is uploaded at "codesignflo sync" too.
  const due = phase === "review" ? lines.length : lines.findIndex(([, t]) => t === "codesignflo sync");
  alexDueAfter = { phase, ms: Math.max(0, due) * LINE_MS };
  const prefix: Record<string, string> = { cmd: "›", out: " ", ok: "✓", del: "−", add: "+" };
  return `<div class="tour-term" aria-label="Alex's coding agent at work">${lines
    .map(
      ([cls, text], n) =>
        `<div class="t-${cls}" style="animation-delay:${((n * LINE_MS) / 1000).toFixed(2)}s"><span class="t-p">${prefix[cls]}</span>${esc(text)}</div>`,
    )
    .join("")}<div class="t-cursor" style="animation-delay:${((lines.length * LINE_MS) / 1000).toFixed(2)}s"></div></div>`;
}

/** When the current waiting step started (to say why after a while). */
let tourWaitSince: { step: number; at: number } | null = null;
function tourWaitedLong(step: number): boolean {
  if (tourWaitSince?.step !== step) {
    tourWaitSince = { step, at: Date.now() };
    // Once, per waiting step: the card redraws when it's been long, to say why.
    setTimeout(() => tourWaitSince?.step === step && drawTour(), 20_500);
  }
  return Date.now() - tourWaitSince.at > 20_000;
}

/** The demo: Alex's feature, built before any design (its component, its file in the shop's code), and the shop. */
const DEMO = { component: "shipping-badge", file: "ShippingBadge", page: "pages.home-page" } as const;
/** The pages that show it (Home through its product cards). */
const DEMO_PAGES = [
  ["pages.home-page", "Home"],
  ["pages.product-page", "Product"],
] as const;
/** The design sent to Alex is done (closed: no claim, not waiting on him any more). */
const closedNow = () => {
  const r = rowOf(DEMO.component);
  return !!r && r.state !== "ready_for_dev" && !r.claim;
};
/** What Alex last reported doing ("reviewed", "built"…): the walkthrough moves on with him. */
let alexDid = "";
const rowOf = (c: string) => view?.rows.find((r) => r.component === c);
const claimed = () => {
  const r = rowOf(DEMO.component);
  return !!r && (r.state === "in_design" || r.state === "ready_for_dev" || !!r.proposalNodeId);
};

const TOUR: TourStep[] = [
  {
    title: "Welcome to the demo",
    text: "This file now holds a small shop's website on its Live page, drawn from the shop's code: its header, product cards and cart, and its Home, Product and Cart pages. Alex, your (simulated) developer, works fast: he builds features before there's a design. Let's see what he ships.",
    mark: () => {
      const id = rowOf(DEMO.page)?.liveNodeId;
      return id ? { nodeId: id, label: "Live: the shop as its code draws it" } : null;
    },
    next: "Start",
  },
  {
    title: "Alex ships a feature",
    text: "Alex adds a Free shipping badge to the products that ship free. No design yet: his coding agent builds it, and his sync sends it to Live.",
    wait: "Alex is shipping it…",
    term: "ship",
    // In Live once his update is applied (all of it: the shop's pages use it).
    done: () => !!rowOf(DEMO.component) && !applying,
  },
  {
    title: "New in code",
    text: "Here it is. Alex built it like the shop's other badges, but in a hurry: its colour is a flat grey, not the brand's. CoDesignFlo lists it as New in code, waiting for you. The product card and the pages that show it changed too. You'll fix its colour.",
    row: DEMO.component,
    target: () => `.row[data-row="${DEMO.component}"]`,
    mark: () => {
      const id = rowOf(DEMO.component)?.liveNodeId;
      return id ? { nodeId: id, label: "Alex's badge: the wrong colour" } : null;
    },
    next: "Next",
  },
  {
    title: "Claim it",
    text: "Click Claim to fix it. You get your own copy of the badge on the Proposals page; Live stays as the app is.",
    row: DEMO.component,
    target: () => `.row[data-row="${DEMO.component}"] [data-a="claim"]`,
    done: claimed,
  },
  {
    title: "Fix its colour",
    text: "This is your copy of Alex's badge. Give it the brand's colour: select it, and in the right panel under Fill, pick a colour from the design system (the style icon next to the fill). That one change is enough.",
    mark: () => {
      const id = rowOf(DEMO.component)?.proposalNodeId;
      return id ? { nodeId: id, label: "Your copy: change its fill" } : null;
    },
    done: () => rowOf(DEMO.component)?.edited === true || readyFor === DEMO.component || rowOf(DEMO.component)?.state === "ready_for_dev",
  },
  {
    title: "Ready for dev",
    text: "Click Ready for dev: CoDesignFlo lists exactly what you changed.",
    row: DEMO.component,
    target: () => `.row[data-row="${DEMO.component}"] [data-a="ready-open"]`,
    done: () => readyFor === DEMO.component || rowOf(DEMO.component)?.state === "ready_for_dev",
  },
  {
    title: "Send it back to Alex",
    text: () =>
      preview && !preview.changes.length && !preview.already.length
        ? "CoDesignFlo found no change in your copy yet, so there's nothing to send. Go back (the arrow at the top), change the badge's fill in your copy on the Proposals page (it's outlined), then click Ready for dev again."
        : 'Check the changes CoDesignFlo found, add a note for Alex ("Brand colour, please"), and send.',
    mark: () => {
      if (!preview || preview.changes.length || preview.already.length) return null;
      const id = rowOf(DEMO.component)?.proposalNodeId;
      return id ? { nodeId: id, label: "Your copy: fix it here" } : null;
    },
    target: () => `[data-a="ready"][data-c="${DEMO.component}"]`,
    form: true,
    done: () => rowOf(DEMO.component)?.state === "ready_for_dev",
  },
  {
    title: "Sent!",
    text: "Alex has your fix now. In a real project, your developer's coding agent gets exactly these changes as instructions.",
    wait: "Waiting for Alex to review it…",
    term: "review",
    // Alex said he reviewed it (his tick), or the panel shows him on it, or it's already done.
    done: () => alexDid !== "" || !!rowOf(DEMO.component)?.builder || !!rowOf(DEMO.component)?.review || closedNow(),
  },
  {
    title: "Alex is on it",
    text: "Alex reviewed your design and approved it, and is building it now: the row shows who's on it. When the code is done, the app's next update rebuilds Live from it.",
    wait: "Alex is building it…",
    term: "build",
    row: DEMO.component,
    target: () => `.row[data-row="${DEMO.component}"]`,
    // Closed happens while his update is still being applied (the badge first, then what uses it, then the
    // screenshots): on only once all of it is in Live.
    done: () => closedNow() && !applying,
  },
  {
    title: "Live has your fix",
    text: "Alex built your design in the code, and his update rebuilt Live from it: his badge now looks the way you designed it. Live matched your copy, so CoDesignFlo closed your design by itself, and your copy moved to Proposals › Archive, for the record.",
    mark: () => {
      const id = rowOf(DEMO.component)?.liveNodeId;
      return id ? { nodeId: id, label: "The badge, rebuilt from the code with your fix" } : null;
    },
    next: "Next",
  },
  {
    title: "Everywhere it's used",
    text: "Look at Live's pages (outlined): the product cards on Home and the Product page show your badge too, as the app now draws them. Beside each page, its screenshot shows the app as built (in a real project, the browser's; here, made from Live, since Alex has no browser). That's the loop: the developer builds first, you fix the look, the code follows.",
    mark: () => {
      const marks: TourMark[] = [];
      for (const [k, name] of DEMO_PAGES) {
        const id = rowOf(k)?.liveNodeId;
        if (id) marks.push({ nodeId: id, label: `${name}: your badge, as the app draws it` });
      }
      return marks.length ? marks : null;
    },
    next: "Finish",
  },
];

// "?" at start: the first step (or none) clears an outline a previous run left on the canvas.
let tourMarked = "?";
const tourPrefs = () => guidePrefs().tour ?? { step: 0 };
const tourOn = () => !!cloud?.project?.demo && !!view?.setUp && (view?.rows.length ?? 0) > 0 && !tourPrefs().closed;

function tourGo(step: number, closed = false) {
  guideDone({ tour: { step: Math.max(0, Math.min(step, TOUR.length - 1)), ...(closed ? { closed } : {}) } });
  render();
}

function tourMarkFor(m: TourMark | TourMark[] | null) {
  const marks = m ? (Array.isArray(m) ? m : [m]) : [];
  const key = marks.map((x) => `${x.nodeId}|${x.label}`).join(",");
  if (key === tourMarked) return;
  tourMarked = key;
  tourMarkTry(marks, key, 0);
}

/** Draws the marks; when the layers weren't there (Live being rebuilt, the file changing), tries again shortly. */
function tourMarkTry(marks: TourMark[], key: string, attempt: number) {
  const again = () => {
    if (tourMarked !== key || attempt >= 4) return;
    setTimeout(() => {
      if (tourMarked !== key) return;
      // The rows' layers may have changed: the step's marks as they are now.
      const now = TOUR[tourPrefs().step]?.mark?.() ?? null;
      tourMarkTry(now ? (Array.isArray(now) ? now : [now]) : marks, key, attempt + 1);
    }, 1_200);
  };
  void act<{ ok: boolean }>("tourMark", { marks })
    .then((r) => {
      if (!r?.ok) again();
    })
    .catch(again);
}

function drawTour() {
  const spot = document.getElementById("tour-spot");
  const tip = document.getElementById("tour-tip");
  if (!tourOn() || document.body.classList.contains("collapsed")) {
    spot?.remove();
    tip?.remove();
    if (!tourOn()) tourMarkFor(null);
    return;
  }
  let i = tourPrefs().step;
  // Done already (the designer went ahead): on to the next one that isn't.
  while (i < TOUR.length - 1 && TOUR[i]!.done?.()) i++;
  if (i !== tourPrefs().step) return tourGo(i);
  const step = TOUR[i]!;
  // The row the step is about must be in view: its section unfolded.
  const row = step.row ? rowOf(step.row) : undefined;
  if (row && folded.has(sectionOf(row))) {
    folded.delete(sectionOf(row));
    return render();
  }
  tourMarkFor(step.mark?.() ?? null);

  const s = spot ?? Object.assign(document.createElement("div"), { id: "tour-spot" });
  const t = tip ?? Object.assign(document.createElement("div"), { id: "tour-tip" });
  if (!spot) document.body.append(s);
  if (!tip) document.body.append(t);
  const sel = step.target?.();
  const el = sel ? document.querySelector<HTMLElement>(sel) : null;
  s.classList.toggle("soft", !!step.form || tourMin);
  t.classList.toggle("min", tourMin);
  if (tourMin) {
    s.style.display = "none";
    delete t.dataset.html;
    t.innerHTML = `<button type="button" class="tour-pill" data-tour="expand" title="Show the demo's guide">Guide · step ${i + 1} of ${TOUR.length}</button>`;
    t.style.top = "";
    t.onclick = () => {
      tourMin = false;
      drawTour();
    };
    return;
  }
  if (el) {
    if (!step.form) el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    Object.assign(s.style, {
      display: "block",
      left: `${r.left - 4}px`,
      top: `${r.top - 4}px`,
      width: `${r.width + 8}px`,
      height: `${r.height + 8}px`,
    });
  } else s.style.display = "none";
  const html = `<div class="tour-count">Demo · step ${i + 1} of ${TOUR.length}<button type="button" class="tour-min" data-tour="min" title="Make the guide small">–</button></div>
    <div class="tour-title">${esc(step.title)}</div>
    <div class="tour-text">${esc(typeof step.text === "function" ? step.text() : step.text)}</div>
    ${step.term ? alexTerminal(step.term) : ""}
    ${step.wait ? `<div class="tour-wait"><span class="tour-dots"></span>${esc(step.wait)}${tourWaitedLong(i) ? `<div class="tour-slow">Still waiting? Alex only works while this plugin is open, and it can take a few more seconds.</div>` : ""}</div>` : ""}
    <div class="tour-actions">
      <span class="tour-gap"></span>
      <button type="button" class="quiet" data-tour="close">Close guide</button>
      ${step.next ? `<button type="button" class="primary" data-tour="next">${esc(step.next)}</button>` : step.wait ? `<button type="button" class="primary" disabled title="Moves on by itself when Alex is done">Next</button>` : ""}
    </div>`;
  // Only when it changed: a redraw keeps the card (and the terminal's animation) as it is.
  if (t.dataset.html !== html) {
    t.innerHTML = html;
    t.dataset.html = html;
    if (step.term && alexTermStarted?.phase !== step.term) alexTermStarted = { phase: step.term, at: Date.now() };
  }
  // A form: at the top of the panel. Otherwise below what to click when there's room, else above it; at the
  // bottom when there's nothing to click.
  const r = el?.getBoundingClientRect();
  const h = t.offsetHeight;
  const top = step.form
    ? $("main").getBoundingClientRect().top + 8
    : r
      ? r.bottom + 12 + h < window.innerHeight
        ? r.bottom + 12
        : Math.max(8, r.top - 12 - h)
      : window.innerHeight - h - 12;
  t.style.top = `${top}px`;
  t.onclick = (e) => {
    const a = (e.target as HTMLElement).closest("button")?.dataset.tour;
    if (a === "next") i === TOUR.length - 1 ? tourGo(i, true) : tourGo(i + 1);
    if (a === "close") tourGo(i, true);
    if (a === "min") {
      tourMin = true;
      drawTour();
    }
  };
}

function render() {
  renderCloud();
  const main = $("main");
  const parts: string[] = [];
  if (cloud?.code)
    parts.push(
      `<div class="notice">Type this code on the sign-in page in your browser, then approve:<span class="code">${cloud.code}</span><button type="button" data-a="cloud-cancel">Cancel</button></div>`,
    );
  if (cloud?.error) parts.push(`<div class="notice warn">${esc(cloud.error)}</div>`);
  parts.push(newerPluginNotice());
  if (selectionWhy && view?.setUp) parts.push(`<div class="hint">${esc(selectionWhy)}</div>`);
  // A demo project: its own strip, first (what it is, the walkthrough, quitting).
  if (cloud?.project?.demo && view?.setUp)
    parts.push(
      `<div class="demo-bar"><span class="badge-demo">Demo</span><span class="demo-what">Alex, a simulated developer, builds what you send.</span><span class="demo-actions">${
        tourPrefs().closed ? `<button type="button" data-a="tour-open">Walkthrough</button>` : ""
      }<button type="button" data-a="quit-demo-ask">Quit demo</button></span></div>`,
    );
  if (quitAsk && cloud?.project?.demo)
    parts.push(`<div class="card">
      <div class="what"><b>Quit the demo?</b></div>
      <div class="desc">Everything the demo made goes: its pages in this file, and the demo project with all you did in it. Try a demo starts it fresh any time.</div>
      <div class="actions"><button type="button" class="primary" data-a="quit-demo">Quit demo</button><button type="button" data-a="quit-demo-no">Cancel</button></div>
    </div>`);
  // Billing: my own designer seat (developers never need one). Once my free sends to dev are used, designs I send
  // wait here until I have a seat.
  const bill = myBilling();
  if (bill?.state === "unpaid")
    parts.push(
      `<div class="notice warn">Your free sends to dev are used: designs you send wait here until you have a designer seat. Get one in Billing at codesignflo.com, or ask someone to pay for your seat. Everything else keeps working.</div>`,
    );
  else if (bill?.state === "trial" && bill.sendsLeft !== undefined)
    parts.push(
      bill.sendsLeft <= 1
        ? `<div class="notice">${sendsLeftText(bill.sendsLeft)}. After that, sending designs needs a designer seat (Billing at codesignflo.com); it works in every project.</div>`
        : `<div class="hint sends">${sendsLeftText(bill.sendsLeft)} · a seat: Billing at codesignflo.com</div>`,
    );
  if (applying && cloud?.reportRefused)
    parts.push(
      `<div class="notice warn"><span>The service doesn't count this update as yours (${esc(cloud.reportRefused)}). It still finishes here; if Live doesn't change, close and reopen the plugin.</span></div>`,
    );
  if (applying)
    parts.push(
      `<div class="notice">${applying.startsWith("preview of") ? `Building the ${esc(applying)}` : `Updating Live from code (${esc(applying)})`}${applyProgress ? `: ${applyProgress.done} of ${applyProgress.total}` : "…"}<span class="busy-bar"><span style="width:${applyProgress ? Math.round((100 * applyProgress.done) / Math.max(1, applyProgress.total)) : 5}%"></span></span></div>`,
    );
  if (pairCodeShown)
    parts.push(
      `<div class="notice">The developer's CLI wants to connect. Tell them this code:<span class="code">${pairCodeShown}</span></div>`,
    );
  const readyRow = readyFor ? view?.rows.find((r) => r.component === readyFor) : undefined;
  if (peopleOpen && !cloud?.project) peopleOpen = false;
  if (cloud?.user && cloud.looked && !cloud.project && ctx?.file.projectId)
    parts.push(
      `<div class="notice warn"><span>You're not in this file's project yet. Ask someone in it to invite <b>${esc(cloud.user.email ?? "you")}</b>.</span></div>`,
    );
  if (projectsOpen && (!cloud?.user || !view?.setUp)) projectsOpen = false;
  document.body.classList.toggle("screen", !!readyRow || peopleOpen || projectsOpen || !!bringIn || guideOpen || !!ds);
  if (ds) parts.push(systemScreen());
  else if (guideOpen) parts.push(guideScreen());
  else if (bringIn) parts.push(bringInScreen());
  else if (projectsOpen) parts.push(projectsScreen());
  else if (peopleOpen) parts.push(peopleScreen());
  else if (readyRow) parts.push(readyScreen(readyRow));
  else if (!view) parts.push(`<div class="hint">Loading…</div>`);
  else if (!view.setUp && cloud?.user)
    parts.push(
      (view.pagesLeft !== undefined && view.pagesLeft < 2
        ? `<div class="notice warn"><span>CoDesignFlo adds two pages (Live, Proposals) and this file has room for ${view.pagesLeft} more on Figma's Starter plan (3 pages per file). Merge some pages, or use a new file.</span></div>`
        : "") +
        introCard() +
        demoCard() +
        useFileCard() +
        startProjectCard(),
    );
  else if (!view.setUp) parts.push(introCard());
  else if (view.rows.length === 0)
    parts.push(
      removedCard() + (guideHtml() || `<div class="notice">No components yet. They appear after the developer's first sync.</div>`),
    );
  else {
    parts.push(removedCard(), guideHtml());
    if (view.rows.length > 6)
      parts.push(
        `<label class="search">${ICON.search}<input type="text" id="q" value="${esc(query)}" placeholder="Search components and pages"></label>`,
      );
    const q = query.trim().toLowerCase();
    const shown = q ? view.rows.filter((r) => matches(r.name, q)) : view.rows;
    for (const [id, name] of SECTIONS) {
      const rows = shown.filter((r) => sectionOf(r) === id);
      if (!rows.length) continue;
      const isFolded = folded.has(id) && !q;
      // Several things only to take note of: all at once.
      const notes = id === "needs" ? rows.filter((r) => actionsFor(r).main?.a === "seen").length : 0;
      parts.push(`<section class="sec">
        <button type="button" class="sec-head" data-a="section" data-s="${id}"><span class="chev">${isFolded ? ICON.chevRight : ICON.chevDown}</span>${name}<span class="count">${rows.length}</span></button>
        ${notes > 1 && !isFolded ? `<div class="sec-act"><button type="button" class="link" data-a="seen-all">Got it for all ${notes}</button></div>` : ""}
        ${isFolded ? "" : `<div class="rows">${rows.map(rowHtml).join("")}</div>`}
      </section>`);
    }
    if (q && !shown.length) parts.push(`<div class="hint">Nothing matches “${esc(query)}”.</div>`);
  }
  if (view?.setUp && !readyRow && !peopleOpen && !bringIn && !guideOpen && !ds) {
    parts.push(newDesignBox());
    parts.push(
      `<div class="hint foot"><button type="button" class="link" data-a="ds-open">Design System: link your components to the code's</button></div>`,
    );
    // Existing designs in this file can be brought in again any time (new ones, or decided "later").
    if (cloud?.project && view.reconciled && (view.ownDesigns?.components ?? 0) + (view.ownDesigns?.frames ?? 0) > 0)
      parts.push(
        `<div class="hint foot"><button type="button" class="link" data-a="reconcile-open">Bring your existing designs in again</button></div>`,
      );
  }
  // Keep focus and cursor in the field being typed in across the redraw.
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focused = active?.id ? { id: active.id, caret: [active.selectionStart, active.selectionEnd] } : null;
  main.innerHTML = parts.join("");
  if (focused) {
    const el = document.getElementById(focused.id) as HTMLInputElement | HTMLTextAreaElement | null;
    el?.focus();
    // Only text fields have a caret: a focused select or button threw "setSelectionRange is not a function" on
    // every redraw. (An email or number input has the method but refuses it: ignored too.)
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)
      try {
        el.setSelectionRange(focused.caret[0] ?? 0, focused.caret[1] ?? 0);
      } catch {
        // a type without a selection (email, number)
      }
  }
  drawTour();
  const live = cloud?.project?.liveBranch;
  $("sub").textContent = view?.lastSyncAt
    ? live
      ? `Live: ${live}${view.lastSyncCommit ? ` @${view.lastSyncCommit.slice(0, 7)}` : ""}, ${ago(view.lastSyncAt)}`
      : `Synced ${ago(view.lastSyncAt)}`
    : view?.setUp
      ? "Not synced yet"
      : "";
}

/** Fetches thumbnails for rows whose picture is missing or changed, then redraws. */
async function loadThumbs() {
  const want = (view?.rows ?? [])
    .filter((r) => thumbs.get(r.component)?.version !== r.version)
    .map((r) => ({ component: r.component, version: r.version, nodeId: r.liveNodeId ?? r.proposalNodeId }))
    .filter((r) => r.nodeId);
  if (!want.length) return;
  const got = await act<Record<string, string>>("thumbs", { components: want });
  for (const w of want) if (got[w.component]) thumbs.set(w.component, { version: w.version, png: got[w.component]! });
  render();
}

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

function toast(text: string) {
  const t = $("toast");
  t.textContent = text;
  t.style.display = "block";
  setTimeout(() => (t.style.display = "none"), 4000);
}

async function refresh() {
  view = await act<PanelState>("state");
  if (cloud) cloud.fileName = ctx?.file.name ?? "";
  // An empty file: list my projects once (the developer may have started one for me).
  if (cloud?.user && (!view.setUp || projectsOpen) && myProjects === null) {
    myProjects = [];
    myProjects = await cloud.myProjects().catch(() => []);
  }
  render();
  void cloud?.recheck().then(() => applyPending());
  void loadThumbs().catch(() => undefined);
}

/** Folded down to the header (name, connection, last sync) so the panel stays out of the way. */
function setCollapsed(collapsed: boolean) {
  document.body.classList.toggle("collapsed", collapsed);
  $("fold").textContent = collapsed ? "▸" : "▾";
  $("fold").title = collapsed ? "Expand" : "Collapse";
  toMain({ kind: "collapse", collapsed });
  // The walkthrough's card hides while collapsed (it would cover the header) and comes back when expanded.
  drawTour();
}
$("fold").addEventListener("click", () => setCollapsed(!document.body.classList.contains("collapsed")));

$("main").addEventListener("input", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === "note") draftNote = (t as HTMLTextAreaElement).value;
  if (t.id === "q") {
    query = (t as HTMLInputElement).value;
    render();
  }
  if (t.id === "nd-name") {
    newName = (t as HTMLInputElement).value;
    // The check follows the name as it is typed (M6: it used to judge the frame's name only).
    document.getElementById("nd-warn")?.toggleAttribute("hidden", !nameTaken(newName));
  }
  if (t.id === "nd-note") newNote = (t as HTMLTextAreaElement).value;
  if (t.id === "inv-email") inviteEmail = (t as HTMLInputElement).value;
  if (t.id === "np-name") newProjectName = (t as HTMLInputElement).value;
});
$("main").addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.type === "checkbox" && t.dataset.send && bringIn) {
    bringIn.skip ??= new Set();
    if (t.checked) bringIn.skip.delete(t.dataset.send);
    else bringIn.skip.add(t.dataset.send);
    return;
  }
  if (t.tagName === "SELECT" && t.dataset.node && bringIn) {
    bringIn.scan.pairs[t.dataset.node] = t.value || null;
    return;
  }
  if (t.type === "radio" && t.name.startsWith("mk-") && t.dataset.node) {
    manyKinds[t.dataset.node] = t.value as "component" | "page";
    render();
    return;
  }
  if (t.type === "radio" && t.name === "inv-role") {
    inviteRole = t.value as "developer" | "designer";
    render();
    return;
  }
  if (t.type === "radio" && t.name === "nd-kind") {
    newKind = t.value as "component" | "page";
    render();
    return;
  }
  if (t.type === "radio" && t.dataset.key) {
    draftScopes[t.dataset.key] = t.value;
    render(); // enables Send once every change is answered
  }
});

/** Buttons that record a designer's decision: claiming, sending, answering, accepting or ignoring. */
const DESIGNER_ACTIONS = new Set([
  "claim",
  "adopt",
  "unclaim",
  "reopen",
  "ready-open",
  "ready",
  "accept",
  "ignore",
  "design-new",
  "design-many",
  "bring-send-new",
  "ds-send-new",
  "review-answer",
]);

$("main").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (b?.dataset.a !== "menu" && menuFor) {
    menuFor = null; // any other click closes the ⋯ menu
    if (!b) return render();
  }
  if (!b) return;
  const component = b.dataset.c ?? "";
  // A designer's decisions are recorded only from designers and admins: a developer is told why, not ignored.
  if (cloud?.role === "developer" && DESIGNER_ACTIONS.has(b.dataset.a ?? ""))
    return toast(
      "You're a developer in this project, so design decisions aren't recorded for you. Ask one of its admins to make you an admin (they invite you again as admin) to design here too.",
    );
  try {
    switch (b.dataset.a) {
      case "ds-open":
        await openSystem();
        return;
      case "ds-close":
        ds = null;
        render();
        return;
      case "ds-create": {
        const r = await act<{ notes: string[] }>("dsCreate");
        toast(r.notes.length ? r.notes[0]! : "Design System page created: bring your components into Library.");
        await refreshSystem();
        return;
      }
      case "ds-show":
        await act("show", { nodeId: b.dataset.node });
        return;
      case "ds-accept":
        await dsLinkAction("dsAccept", { k: b.dataset.k });
        return;
      case "ds-match":
      case "ds-link": {
        const sel = (document.getElementById(b.dataset.sel ?? "") as HTMLSelectElement | null)?.value ?? "";
        if (!sel) return toast(b.dataset.a === "ds-match" ? "Pick one of your components first." : "Pick a code component first.");
        // From code: the select is one of yours; elsewhere: a code component for yours.
        const params = b.dataset.a === "ds-match" ? { k: b.dataset.k, nodeId: sel } : { k: sel, nodeId: b.dataset.node };
        // A suggestion confirmed as it was keeps its property mapping.
        const sug = ds?.s.suggestions.find((x) => x.id === b.dataset.node && x.k === sel && b.dataset.sug === sel);
        await dsLinkAction("dsMatch", { ...params, ...(sug ? { map: sug.map } : {}) });
        return;
      }
      case "ds-replace":
        if (ds?.ask) await dsLinkAction(ds.ask.retry.action, { ...ds.ask.retry.params, replace: true });
        return;
      case "ds-keep":
        if (ds) ds.ask = undefined;
        render();
        return;
      case "ds-reject":
        await act("dsReject", { k: b.dataset.k, nodeId: b.dataset.node });
        await refreshSystem();
        return;
      case "ds-unlink":
        await act("dsUnlink", { nodeId: b.dataset.node });
        await refreshSystem();
        return;
      case "ds-ignore":
      case "ds-unignore":
        await act("dsIgnore", { k: b.dataset.k, on: b.dataset.a === "ds-ignore" });
        await refreshSystem();
        return;
      case "ds-map":
        if (ds) ds.mapFor = b.dataset.node;
        render();
        return;
      case "ds-map-close":
        if (ds) ds.mapFor = undefined;
        render();
        return;
      case "ds-map-save": {
        const l = ds?.s.library.find((x) => x.id === b.dataset.node);
        if (!l?.link) return;
        const val = (id: string) => (document.getElementById(id) as HTMLSelectElement | null)?.value ?? "";
        const map = { props: {} as Record<string, string>, values: {} as Record<string, Record<string, string>> };
        for (const [p, values] of Object.entries(l.link.codeProps)) {
          const q = val(`dsmp-${p}`);
          if (!q) continue;
          map.props[p] = q;
          map.values[p] = {};
          for (const v of values) {
            const lv = val(`dsmv-${p}-${v}`);
            if (lv) map.values[p]![v] = lv;
          }
        }
        await act("dsSetMap", { nodeId: l.id, map });
        ds!.mapFor = undefined;
        toast("Saved: pages use it from the next update.");
        await refreshSystem();
        return;
      }
      case "ds-send-new": {
        const r = await act<{ sent: string[] }>("dsSendNew", {
          nodeId: b.dataset.node,
          note: "A component from the design system, not in the code yet.",
        });
        toast(`Sent to the developer as a new design (${r.sent.join(", ")}): it's linked when it's in the code.`);
        await refreshSystem();
        return;
      }
      case "ds-token":
      case "ds-token-unlink":
        await act("dsLinkToken", { token: b.dataset.t, id: b.dataset.a === "ds-token" ? b.dataset.node : null });
        await refreshSystem();
        return;
      case "ds-token-reject":
        await act("dsRejectToken", { token: b.dataset.t, id: b.dataset.node });
        await refreshSystem();
        return;
      case "select-change": {
        const c = preview?.changes.find((x) => x.key === b.dataset.key);
        if (c?.nodeIds) await act("select", { nodeIds: c.nodeIds });
        return;
      }
      case "undo-change": {
        const c = preview?.changes.find((x) => x.key === b.dataset.key);
        if (!c?.undo || !readyFor) return;
        await act("undo", { ops: c.undo });
        toast("Undone in your copy.");
        preview = await act<Preview>("preview", { component: readyFor });
        render();
        return;
      }
      case "cloud-cancel":
        cloud?.cancelSignIn();
        return;
      case "reconcile-open":
        bringIn = { scan: await act<Scan>("scanDesigns") };
        render();
        return;
      case "bring-close":
        bringIn = null;
        render();
        return;
      case "bring-compare": {
        if (!bringIn) return;
        const r = await act<{ results: Compared[] }>("compareDesigns", { pairs: bringIn.scan.pairs });
        bringIn.results = r.results;
        render();
        return;
      }
      case "bring-design": {
        if (!bringIn || !b.dataset.node || !b.dataset.key) return;
        const r = await act<{ carried: number; left: string[] }>("designWins", { nodeId: b.dataset.node, key: b.dataset.key });
        bringIn.scan.decisions[b.dataset.key] = "design";
        toast(
          `Claimed with your design: ${r.carried} change${r.carried === 1 ? "" : "s"} carried into the copy${r.left.length ? `; do these in the copy yourself: ${r.left.join(", ")}` : ""}. Check it, then send it.`,
        );
        render();
        return;
      }
      case "bring-code":
      case "bring-later": {
        if (!bringIn || !b.dataset.key) return;
        const decision = b.dataset.a === "bring-code" ? "code" : "later";
        await act("decide", { key: b.dataset.key, decision });
        bringIn.scan.decisions[b.dataset.key] = decision;
        render();
        return;
      }
      case "bring-use-live": {
        const r = await act<{ swapped: number }>("useLive", { nodeId: b.dataset.node, key: b.dataset.key });
        toast(
          r.swapped
            ? `${r.swapped} instance${r.swapped === 1 ? "" : "s"} in your screens now use the Live component.`
            : "None of your screens use it.",
        );
        return;
      }
      case "bring-send-new": {
        if (!bringIn) return;
        const items = bringIn.scan.designs
          .filter((d) => !bringIn!.scan.pairs[d.nodeId] && !bringIn!.skip?.has(d.nodeId))
          .map((d) => ({ nodeId: d.nodeId, name: d.name, kind: d.kind === "screen" ? "page" : "component" }));
        const r = await act<{ sent: string[] }>("designNewMany", { items, note: "From the existing designs: not in the app yet." });
        bringIn.sentNew = true;
        toast(`Sent ${r.sent.length} as new designs.`);
        render();
        return;
      }
      case "bring-review": {
        if (!bringIn) return;
        const matched = new Set(Object.values(bringIn.scan.pairs).filter(Boolean));
        const keys = bringIn.scan.live.filter((l) => !matched.has(l.key)).map((l) => l.key);
        await act("reviewInCode", { keys });
        bringIn.reviewed = true;
        render();
        return;
      }
      case "bring-done":
        await act("finishBringingIn");
        bringIn = null;
        toast("Done for now. You can bring designs in again from the link at the bottom.");
        break;
      case "removed-delete": {
        const ids = (view?.removedFromCode ?? []).map((r) => r.nodeId);
        const r = await act<{ deleted: number; uses: number }>("deleteRemoved", { nodeIds: ids, confirmUses: !!removedAsk });
        if (r.uses) {
          removedAsk = { uses: r.uses };
          render();
          return;
        }
        removedAsk = null;
        toast(`Deleted ${r.deleted}.`);
        break;
      }
      case "removed-keep":
        await act("keepRemoved", { nodeIds: (view?.removedFromCode ?? []).map((r) => r.nodeId) });
        removedAsk = null;
        toast("Kept in Archive.");
        break;
      case "guide-hide":
        guideDone({ hidden: true });
        render();
        return;
      case "guide-show":
        guideDone({ hidden: false });
        guideOpen = false;
        render();
        return;
      case "guide-open":
        guideOpen = true;
        peopleOpen = false;
        render();
        return;
      case "guide-close":
        guideOpen = false;
        render();
        return;
      case "cloud-people":
        await openPeople(true);
        return;
      case "resend-invite": {
        const email = b.dataset.e ?? "";
        if (!cloud || !email) return;
        try {
          await cloud.resendInvitation(email);
          toast(`Invitation email sent again to ${email}.`);
        } catch (e) {
          toast((e as Error).message);
        }
        await openPeople(true);
        return;
      }
      case "people-close":
        await openPeople(false);
        return;
      case "plugin-download":
        if (newerPlugin) toMain({ kind: "openExternal", url: newerPlugin.download });
        return;
      case "plugin-later":
        if (!newerPlugin) return;
        if (ctx) ctx.guide[DEMO_PREFS] = { ...ctx.guide[DEMO_PREFS], pluginLater: newerPlugin.version };
        toMain({ kind: "guide", projectId: DEMO_PREFS, prefs: { pluginLater: newerPlugin.version } });
        render();
        return;
      case "projects-close":
        await openProjects(false);
        return;
      case "switch-ask":
      case "clear-ask": {
        const to = b.dataset.a === "switch-ask" && b.dataset.p ? { id: b.dataset.p, name: b.dataset.n ?? "this project" } : null;
        clearAsk = { to, contents: await act<FileContents>("fileContents", {}) };
        render();
        return;
      }
      case "clear-no":
        clearAsk = null;
        render();
        return;
      case "clear-yes": {
        if (!cloud || !clearAsk) return;
        const { to } = clearAsk;
        // The confirmation goes at once: a second click can't clear twice.
        clearAsk = null;
        projectsOpen = false;
        render();
        await act("clearFile", {});
        await cloud.fileChanged(null);
        myProjects = null;
        if (to) {
          await act("setUpFile", { projectId: to.id });
          toMain({ kind: "getContext" });
          await cloud.fileChanged(to.id);
          await cloud.resendLive(to.id);
          toast(`This file now uses ${to.name}: its components and pages arrive in a moment.`);
          void applyPending();
          return;
        }
        toast("CoDesignFlo is cleared from this file. Pick or start a project to use it again.");
        toMain({ kind: "getContext" });
        await refresh();
        return;
      }
      case "invite": {
        const email = inviteEmail.trim();
        if (!cloud || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Enter an email address.");
        const r = await cloud.invite(email, inviteRole);
        toast(
          r === "role_changed"
            ? `${email} is now a ${inviteRole} in the project.`
            : r === "member"
              ? `${email} is in the project already. Only an admin changes their role, by inviting them again.`
              : r === "added"
                ? `${email} is in the project — they got an email about it.`
                : `Invited ${email} — an email with how to join is on its way.`,
        );
        inviteEmail = "";
        await openPeople(true);
        return;
      }
      case "review-answer": {
        const c = b.dataset.c!;
        const box = document.getElementById(`ans-${c}`) as HTMLTextAreaElement | null;
        await act("answerReview", { component: c, answer: box?.value ?? "" });
        toast("Answer sent to the developer.");
        await refresh();
        return;
      }
      case "delete-project":
        deleteAsk = b.dataset.p ? { id: b.dataset.p, name: b.dataset.n ?? "this project" } : null;
        render();
        return;
      case "delete-project-no":
        deleteAsk = null;
        render();
        return;
      case "delete-project-yes": {
        if (!cloud || !deleteAsk) return;
        const gone = deleteAsk;
        // The confirmation goes at once: a second click can't send a second delete.
        deleteAsk = null;
        render();
        try {
          await cloud.deleteProject(gone.id);
        } catch (e) {
          // Already gone (deleted from another window, or a click that got through): just show the list as it is.
          if (!/already deleted/.test(String(e))) throw e;
        } finally {
          myProjects = null;
        }
        // This file's own project: the file is free for a new one.
        if (ctx?.file.projectId === gone.id) {
          await act("forgetProject", {});
          peopleOpen = false;
        }
        myProjects = null;
        toast(`Deleted ${gone.name}.`);
        toMain({ kind: "getContext" });
        await refresh();
        return;
      }
      case "use-file": {
        if (!cloud || !b.dataset.p) return;
        await act("setUpFile", { projectId: b.dataset.p });
        toMain({ kind: "getContext" });
        await cloud.fileChanged(b.dataset.p);
        await cloud.resendLive(b.dataset.p);
        myProjects = null;
        toast("This file is set up — the app's components and pages arrive in a moment.");
        void applyPending();
        return;
      }
      case "intro-hide":
        if (ctx) ctx.guide[DEMO_PREFS] = { ...ctx.guide[DEMO_PREFS], introHidden: true };
        toMain({ kind: "guide", projectId: DEMO_PREFS, prefs: { introHidden: true } });
        render();
        return;
      case "demo-hide":
        if (ctx) ctx.guide[DEMO_PREFS] = { ...ctx.guide[DEMO_PREFS], demoHidden: true };
        toMain({ kind: "guide", projectId: DEMO_PREFS, prefs: { demoHidden: true } });
        toast("Put away. The guide (top left) still offers the demo.");
        render();
        return;
      case "tour-open":
        tourGo(tourPrefs().step);
        return;
      case "quit-demo-ask":
        quitAsk = true;
        render();
        return;
      case "quit-demo-no":
        quitAsk = false;
        render();
        return;
      case "quit-demo": {
        if (!cloud) return;
        quitAsk = false;
        // The file's demo pages go (a demo file holds nothing else of ours) and the file is free again; then the
        // demo project itself, with everything done in it.
        await act("resetDemoFile", {});
        await cloud.quitDemo();
        await cloud.fileChanged(null);
        myProjects = null;
        toast("The demo is gone. Try a demo starts it fresh.");
        toMain({ kind: "getContext" });
        await refresh();
        return;
      }
      case "try-demo": {
        if (!cloud) return;
        guideOpen = false;
        const projectId = await cloud.startDemo();
        await act("setUpFile", { projectId });
        toMain({ kind: "getContext" });
        await cloud.fileChanged(projectId);
        myProjects = null;
        toast("Demo started: the sample app arrives in Live in a moment.");
        void applyPending();
        return;
      }
      case "start-project": {
        if (!cloud) return;
        const name = (newProjectName ?? ctx?.file.name ?? "").trim();
        if (!name) return toast("Give the project a name.");
        const projectId = await cloud.createProject(name);
        await act("setUpFile", { projectId });
        toMain({ kind: "getContext" });
        await cloud.fileChanged(projectId);
        toast("Project started — now invite your developer.");
        await openPeople(true);
        return;
      }
      case "menu":
        menuFor = menuFor === component ? null : component;
        render();
        return;
      case "toggle": {
        const r = view?.rows.find((x) => x.component === component);
        // Clicking a row also brings it into view: your copy when you're working on it, otherwise Live.
        const target = r?.proposalNodeId ?? r?.liveNodeId;
        if (target) void act("show", { nodeId: target }).catch(() => undefined);
        if (r && isOpen(r)) {
          open.delete(component);
          shut.add(component);
        } else {
          shut.delete(component);
          open.add(component);
        }
        render();
        return;
      }
      case "section": {
        const id = b.dataset.s ?? "";
        if (folded.has(id)) folded.delete(id);
        else folded.add(id);
        render();
        return;
      }
      case "show":
        await act("show", { nodeId: b.dataset.node });
        return;
      case "ready-open":
        resetDraft();
        readyFor = component;
        preview = null;
        render();
        try {
          preview = await act<Preview>("preview", { component });
        } catch (e) {
          // Not stuck on "Looking at your changes…": back to the list, saying what went wrong.
          readyFor = null;
          render();
          throw e;
        }
        render();
        ($("note") as HTMLTextAreaElement | null)?.focus();
        return;
      case "cancel":
        resetDraft();
        readyFor = null;
        preview = null;
        render();
        return;
      case "ready": {
        const scopes: Record<string, string> = {};
        for (const c of preview?.changes ?? []) {
          const picked = document.querySelector<HTMLInputElement>(`input[name="s-${CSS.escape(c.key)}"]:checked`);
          if (picked) scopes[c.key] = picked.value;
        }
        alexDid = "";
        if (cloud?.project?.demo && preview)
          lastSent = {
            component,
            changes: preview.changes.map((c) => ({
              what: propLabel(c.prop),
              layer: layerLabel(c.layer),
              from: short(c.from),
              to: short(c.to),
            })),
          };
        await act("ready", { component, note: ($("note") as HTMLTextAreaElement).value, scopes });
        guideDone({ sent: true });
        readyFor = null;
        preview = null;
        resetDraft();
        toast("Sent. The developer sees it at their next sync.");
        break;
      }
      case "design-new": {
        const name = ($("nd-name") as HTMLInputElement).value;
        const kind = kindNow();
        await act("designNew", { name, note: ($("nd-note") as HTMLTextAreaElement).value, kind });
        newName = null;
        newNote = "";
        newKind = null;
        toast(`Sent. ${name} moved to your lane in Proposals; the developer sees it at their next sync.`);
        break;
      }
      case "design-many": {
        const many = view?.many ?? [];
        const r = await act<{ sent: string[] }>("designNewMany", {
          items: many.map((m) => ({ nodeId: m.nodeId, name: m.name, kind: manyKind(m) })),
          note: ($("nd-note") as HTMLTextAreaElement).value,
        });
        newNote = "";
        toast(`Sent ${r.sent.length} designs. They moved to your lane in Proposals; the developer builds components first, then pages.`);
        break;
      }
      case "adopt":
        await act("adopt");
        toast("Claimed. Your copy is in your lane in Proposals.");
        break;
      case "claim":
        // The clicked lane item: that branch's version (else Live's, or the branch's for one only on a branch).
        await act("claim", { component, ...(selectedRow === component && selectedFrom ? { from: selectedFrom } : {}) });
        guideDone({ claimed: true });
        open.add(component);
        toast("Your copy of the whole component (all its variants) is on top of your lane in Proposals. Edit it freely.");
        break;
      case "reopen":
      case "acceptCode":
        await act("acceptCode", { component });
        toast("Closed with the code's version. Your copy is in Archive.");
        break;
      case "keepDesign": {
        const r = await act<{ kept: number; notKept: string[] }>("keepDesign", { component });
        toast(
          `Closed. ${r.kept} change${r.kept === 1 ? "" : "s"} kept as design in Live${r.notKept.length ? `; not kept (remove or move layers in Live yourself): ${r.notKept.join(", ")}` : ""}.`,
        );
        break;
      }
      case "unpin":
        await act("unpin", { component, key: b.dataset.key, props: JSON.parse(b.dataset.props ?? "[]") });
        toast("It follows the code again from the next update.");
        break;
      case "seen-all": {
        const rows = (view?.rows ?? []).filter((r) => sectionOf(r) === "needs" && actionsFor(r).main?.a === "seen");
        for (const r of rows) await act("seen", { component: r.component });
        toast(`Noted ${rows.length} changes.`);
        break;
      }
      case "unclaim":
      case "seen":
      case "accept":
      case "ignore":
        await act(b.dataset.a as PanelAction, { component });
        break;
    }
    await refresh();
  } catch (e) {
    toast((e as Error).message);
  }
});

// ---- bridge to the developer's CLI (localhost; silent when none is running) ------------------------

let ctx: Context | null = null;
let secret: string | null = null;
let ws: WebSocket | null = null;
let retryMs = 2000;
const pairCode = String(Math.floor(1000 + Math.random() * 9000));
const send = (m: protocol.Message) => {
  if (ws && ws.readyState === WebSocket.OPEN) for (const f of protocol.encode(m)) ws.send(f);
};
const conn = (on: boolean, text: string) => {
  $("conn").className = on ? "conn on" : "conn";
  $("conn").title = text;
  $("conn-text").textContent = on ? "Developer connected" : text.charAt(0).toUpperCase() + text.slice(1);
};

let retiring = false;

function connect() {
  if (!ctx || retiring) return;
  const socket = new WebSocket(`ws://localhost:${protocol.DEFAULT_PORT}`);
  ws = socket;
  const decoder = new protocol.Decoder();
  socket.onopen = () => {
    send({
      t: "hello",
      protocol: protocol.PROTOCOL_VERSION,
      secret,
      pairCode,
      plugin: { version: ctx!.plugin.version },
      file: ctx!.file,
      user: ctx!.user,
    });
  };
  socket.onmessage = (ev) => {
    const msg = decoder.push(String(ev.data));
    if (!msg) return;
    if (msg.t === "awaiting_approval") {
      pairCodeShown = pairCode;
      render();
    } else if (msg.t === "welcome") {
      retryMs = 2000;
      pairCodeShown = null;
      conn(true, "developer connected");
      if (msg.secret !== secret) {
        secret = msg.secret;
        toMain({ kind: "saveSecret", secret });
      }
      render();
    } else if (msg.t === "rejected") {
      pairCodeShown = null;
      // Another file or an incompatible version: keep listening, but rarely.
      retryMs = 30000;
      if (msg.code === "not_approved") {
        secret = null;
        toMain({ kind: "saveSecret", secret: null });
      }
      conn(
        false,
        msg.code === "plugin_too_old"
          ? "update the plugin"
          : msg.code === "wrong_file"
            ? "developer is on another file"
            : "developer offline",
      );
      render();
    } else if (msg.t === "req") {
      if (msg.method === "updateProgress") localProgress(msg.params as LocalProgress);
      toMain({ kind: "req", msg });
    }
  };
  socket.onclose = (ev) => {
    if (ws !== socket) return;
    ws = null;
    // The developer's sync stopped in the middle of an update: the notice goes, what was built stays.
    if (applying === LOCAL) {
      applying = null;
      applyProgress = null;
      toast("The developer's sync stopped before Live was fully updated; it carries on next time they sync.");
    }
    conn(false, "developer offline");
    if (ev.code === protocol.CLOSE_REPLACED) return; // the plugin in another file took over
    // Re-read the file's project id before trying again (it may have been set up meanwhile).
    toMain({ kind: "getContext" });
    // Back off up to 30 s: most of the time (designer alone) nobody is listening.
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  };
}

window.onmessage = (ev: MessageEvent<{ pluginMessage?: MainToUi }>) => {
  const m = ev.data.pluginMessage;
  if (!m) return;
  if (m.kind === "reloadUi") {
    // Replaced in the middle of applying an update: give it back, the new panel redoes it (safe to repeat).
    if (applying && applyingId !== null) void cloud?.releaseUpdate(applyingId).catch(() => undefined);
    // Development hot-reload: retire this panel (no reconnects) and load the new one in its place.
    retiring = true;
    ws?.close();
    document.open();
    document.write(m.html);
    document.close();
    return;
  }
  if (m.kind === "context") {
    const first = ctx === null;
    const projectChanged = !first && ctx?.file.projectId !== m.context.file.projectId;
    ctx = m.context;
    secret = m.context.savedSecret;
    // A development build talks to the local test service: the header says so, next to the release plugin.
    if (m.context.plugin.dev) document.querySelector("h1")!.textContent = "CoDesignFlo (dev)";
    if (first && m.context.collapsed) setCollapsed(true);
    if (first && m.context.service) {
      cloud = new Cloud(
        m.context.service,
        m.context.serviceSession,
        (refreshToken) => toMain({ kind: "saveSession", refreshToken }),
        () =>
          new Promise<string | null>((resolve) => {
            const id = nextId++;
            sessionWaits.set(id, resolve);
            toMain({ kind: "loadSession", id });
          }),
        (url) => toMain({ kind: "openExternal", url }),
        m.context.figmaUserId,
        render,
      );
      cloud.onSignal = onProjectSignal;
      void cloud.restore(m.context.file.projectId);
      // A newer plugin: looked for now and every 6 hours while the plugin stays open.
      void checkPluginVersion();
      setInterval(() => void checkPluginVersion(), 6 * 60 * 60_000);
    }
    if (!first && projectChanged) void cloud?.fileChanged(m.context.file.projectId);
    if (first) connect();
    // `init` just set this file up: reconnect so the CLI sees the new project id.
    else if (projectChanged) ws?.close();
    void refresh();
  } else if (m.kind === "session") {
    sessionWaits.get(m.id)?.(m.refreshToken);
    sessionWaits.delete(m.id);
  } else if (m.kind === "panelResult") {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (w) m.ok ? w.resolve(m.result) : w.reject(new Error(m.error));
  } else if ((m.kind === "res" || m.kind === "progress") && localCalls.has(m.msg.id)) {
    // Figma is working through a page: a sign of life for the update being applied.
    if (m.kind === "progress") return void working?.();
    const w = localCalls.get(m.msg.id)!;
    localCalls.delete(m.msg.id);
    m.msg.ok ? w.resolve(m.msg.result) : w.reject(new Error(m.msg.error.message));
  } else if (m.kind === "cloudProposal") {
    void cloud?.sendProposal(m);
  } else if (m.kind === "cloudEvents") {
    void cloud?.send(m.events);
  } else if (m.kind === "selection") {
    selectedRow = m.component ?? null;
    selectedFrom = m.from ?? null;
    selectionWhy = m.why ?? (m.from && m.branch ? `${m.branch}'s version selected: Claim copies that one, not Live's.` : null);
    // Its section opens so the row can be seen.
    const row = selectedRow ? view?.rows.find((r) => r.component === selectedRow) : undefined;
    if (row) folded.delete(sectionOf(row));
    if (view?.setUp) void refresh().then(revealSelected);
    else revealSelected();
  } else if (m.kind === "edited") {
    // A copy being changed: whether it differs from Live yet (Ready for dev). Not while applying an update.
    if (!applying && view?.rows.some((r) => r.state === "in_design")) void refresh();
  } else if (m.kind === "changed") {
    toMain({ kind: "getContext" });
  } else if (m.kind === "liveEdited") {
    // Live and the lanes are the code's: say so once per change (moves and sizes were already put back).
    toast(
      `${m.names.length === 1 ? `"${m.names[0]}" is` : "These are"} the code's: put back as it was${m.inside ? " (changes inside it go at the next update)" : ""}. To change it, claim it (it's selected: Claim in its row).`,
    );
  } else {
    send(m.msg);
  }
};

/** Scrolls the selected row into view (after the panel has drawn it). */
function revealSelected() {
  if (!selectedRow) return;
  requestAnimationFrame(() => document.querySelector(`.row[data-row="${CSS.escape(selectedRow!)}"]`)?.scrollIntoView({ block: "nearest" }));
}

toMain({ kind: "getContext" });
render();
