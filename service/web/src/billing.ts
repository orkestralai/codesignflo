// Billing: a designer seat belongs to a person and works in every project. You pay for your own seat, for
// others' (by email), or both: one subscription, one seat per email. Developers are free; every designer gets
// 5 free sends to dev first. Whitelisted people never need a seat. Prices: pricing.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { FREE_SENDS, LAUNCH, launchOn, SEAT_EUR, seatPrice, VAT_NOTE } from "./pricing.ts";

export { FREE_SENDS, SEAT_EUR };

export type MyBilling = {
  /** "trial": free sends left. */
  state: "whitelisted" | "active" | "trial" | "unpaid";
  sends_used: number;
  sends_free: number;
  /** Who pays for my seat (when it's active). */
  paid_by: string | null;
  /** Seats I pay for. */
  seats: number;
  billed_seats: number;
  status: string | null;
  current_period_end: string | null;
  subscribed: boolean;
  /** When a cancelled subscription ends (read from my billing row). */
  cancel_at?: string | null;
};
export type Seat = { email: string; signed_up: boolean; added_at: string };
/** My referral link's code and how my referrals stand (my_referrals). */
export type MyReferrals = {
  code: string;
  /** Designers who joined through me and still count. */
  joined: number;
  /** Of them, those whose second month hasn't started yet. */
  waiting: number;
  /** Free months: earned in all, applied to my subscription, waiting for it, expired. */
  earned: number;
  applied: number;
  banked: number;
  expired: number;
  earned_year: number;
  next_expiry: string | null;
  /** How my own referral stands, when someone brought me. */
  referred: string | null;
};
/** Referrals: free months a referrer earns in a rolling year. */
export const REFERRAL_CAP = 12;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const left = (b: MyBilling) => Math.max(0, (b.sends_free ?? FREE_SENDS) - (b.sends_used ?? 0));

export async function myBilling(sb: SupabaseClient): Promise<MyBilling | null> {
  const [{ data }, { data: mine }] = await Promise.all([sb.rpc("my_billing"), sb.from("billing_accounts").select("cancel_at").maybeSingle()]);
  const b = ((data ?? []) as MyBilling[])[0] ?? null;
  return b && { ...b, cancel_at: (mine?.cancel_at as string | null | undefined) ?? null };
}

/** Back from Manage billing: the service reads the subscription again from Stripe. */
export async function refreshBilling(token: string): Promise<void> {
  await fetch("/api/billing/refresh", { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
}

export async function myReferrals(sb: SupabaseClient): Promise<MyReferrals | null> {
  const { data } = await sb.rpc("my_referrals");
  return ((data ?? []) as MyReferrals[])[0] ?? null;
}

/** My personal link: the landing page, with my code (kept in the browser until the new account's first sign-in). */
export const referralLink = (code: string, origin = location.origin) => `${origin}/?ref=${encodeURIComponent(code)}`;

/** Billing's referral card: my link, the rules in two lines, and my months. */
export function referralHtml(r: MyReferrals | null): string {
  if (!r?.code) return "";
  const link = referralLink(r.code);
  const months = [
    r.applied ? `${r.applied} applied` : "",
    r.banked ? `${r.banked} waiting for your subscription${r.next_expiry ? ` (the first expires ${day(r.next_expiry)})` : ""}` : "",
    r.expired ? `${r.expired} expired` : "",
  ].filter(Boolean);
  const stats = r.joined
    ? `<p>${plural(r.joined, "designer")} joined through you${r.waiting ? ` · ${r.waiting} not in their second month yet` : ""} · ${plural(r.earned, "free month")} earned${months.length ? `: ${months.join(", ")}` : ""}.${
        r.earned_year >= REFERRAL_CAP ? ` <span class="muted">That's the ${REFERRAL_CAP} for this year.</span>` : ""
      }</p>`
    : `<p class="muted">Nobody has joined through you yet.</p>`;
  const mine =
    r.referred && ["pending", "first_paid"].includes(r.referred)
      ? `<div class="notice">A designer invited you: ${r.referred === "pending" ? "your second month is free when you start paying." : "your second month is free, already credited."}</div>`
      : "";
  return `<div class="card"><h2>Invite designers, get a month free</h2>
    ${mine}
    <p class="muted">Share your link with designers new to CoDesignFlo, or invite them to a project as designers. They pay their first month and get the second free; when it starts, you get a month free. Up to ${REFERRAL_CAP} free months a year; months you earn before subscribing wait for you for 12 months. <a href="#/terms">Terms</a></p>
    <div class="snippet"><pre>${esc(link)}</pre><button class="small copy" data-copy="${esc(link)}">Copy</button></div>
    ${stats}</div>`;
}

export async function mySeats(sb: SupabaseClient): Promise<Seat[]> {
  const { data } = await sb.rpc("my_seats");
  return (data ?? []) as Seat[];
}

/** A line for the projects page when my free sends are running out or used (nothing otherwise). */
export function billingNotice(b: MyBilling | null): string {
  if (!b) return "";
  if (b.state === "unpaid")
    return `<div class="notice warn"><b>Your ${FREE_SENDS} free sends to dev are used.</b> To send more designs to developers you need a designer seat: pay for yours, or ask someone to pay for it. Everything else keeps working. <a href="#/billing">Billing</a></div>`;
  if (b.state === "trial" && left(b) <= 2)
    return `<div class="notice">${plural(left(b), "free send")} to dev left. After that, designers need a seat; developers are free. <a href="#/billing">Billing</a></div>`;
  return "";
}

function mine(b: MyBilling, me: string, paysOwn: boolean): string {
  if (b.state === "whitelisted") return `<b>Free for you.</b><p class="muted">Your account is on CoDesignFlo's free list: you never need a seat.</p>`;
  if (b.state === "active")
    return `<b>You have a designer seat</b>${b.paid_by && b.paid_by !== me ? ` · paid by ${esc(b.paid_by)}` : ""}<p class="muted">Use it in any project, yours or anyone's.</p>`;
  const head = b.state === "trial" ? `<b>${plural(left(b), "free send")} to dev left</b> <span class="muted">of ${FREE_SENDS}</span>` : `<b>Your ${FREE_SENDS} free sends to dev are used</b>`;
  const what =
    b.state === "trial"
      ? `Every design you send to the developers (Ready for dev, or a new design) uses one. After that, designers need a seat to send designs; developers never do.`
      : "You can still use everything, but designs you send wait until you have a seat. Developers don't need one.";
  return `${head}<p class="muted">${what} Pay for your own seat below, or ask someone to pay for it (they add your email in their Billing).</p>
    ${paysOwn ? "" : `<div class="row"><button id="seatMe" class="primary">Pay for my seat</button></div>`}`;
}

export function billingHtml(
  b: MyBilling | null,
  seats: Seat[],
  me: string,
  done: "" | "waiting" | "slow",
  error = "",
  referrals: MyReferrals | null = null,
  /** Launch seats left (of LAUNCH.spots): the launch price only when there's a place for each of these seats. */
  launchLeft = 0,
): string {
  const head = `<h1>Billing</h1><p class="muted">${seatPrice()}. A seat belongs to a designer and works in every project. Developers are free.</p><p class="muted">${VAT_NOTE}</p>`;
  if (!b) return `${head}<p class="err">Couldn't read your billing. Reload the page.</p>`;
  const err = error ? `<p class="err">${esc(error)}</p>` : "";
  const thanks =
    done === "waiting"
      ? `<div class="notice">Thanks — your subscription is being set up. This page updates in a moment.</div>`
      : done === "slow"
        ? `<div class="notice warn">Your payment went through, but your subscription isn't showing here yet. Reload this page in a few minutes; if it still doesn't show, write to contact@orkestralai.com.</div>`
        : "";
  const paysOwn = seats.some((s) => s.email === me.toLowerCase());
  const n = seats.length;
  const total = !n
    ? ""
    : launchOn() && !b.subscribed && launchLeft >= n
      ? `€${LAUNCH.eur * n} a month for ${LAUNCH.months} months if you subscribe by ${LAUNCH.until}, then €${SEAT_EUR * n}, VAT included`
      : `€${SEAT_EUR * n} a month, VAT included`;
  const rows = seats
    .map(
      (s) =>
        `<tr><td>${esc(s.email)}${s.email === me.toLowerCase() ? ' <span class="muted">(you)</span>' : ""}</td><td class="muted">${s.signed_up ? "signed up" : "not signed up yet"}</td><td><button class="small" data-seat-remove="${esc(s.email)}">Remove</button></td></tr>`,
    )
    .join("");
  const sub = b.subscribed
    ? `<p class="muted">Subscribed · ${esc(b.status ?? "")} · ${plural(b.billed_seats, "seat")} billed${
      b.cancel_at
        ? `. <b>Cancelled</b>: the seats stay until ${day(b.cancel_at)}, then end; nothing more is charged. To keep them, renew it in Manage billing.</p>`
        : `${b.current_period_end ? `, renews ${day(b.current_period_end)}` : ""}. Adding or removing a seat changes the bill, prorated; to stop paying, cancel in Manage billing.</p>`
    }
      <div class="row"><button id="portal" class="primary">Manage billing</button></div>`
    : n
      ? `<p class="muted">${plural(n, "seat")} · ${total}.</p>
      <div class="row"><button id="subscribe" class="primary">Subscribe</button></div>`
      : `<p class="muted">Add the designers you pay for — yourself, or others by email — then subscribe.</p>`;
  return `${head}${thanks}${err}
    <div class="card"><h2>Your seat</h2>${mine(b, me, paysOwn)}</div>
    <div class="card"><h2>Seats you pay for <span class="count">${n}</span></h2>
      <p class="muted">Pay for designers on your team: each email gets a seat that works in every project. Someone who hasn't signed up yet gets it when they do.</p>
      <div class="row"><input id="seatEmail" type="email" placeholder="designer's email"><button id="seatAdd">Add seat</button></div>
      <p id="seatMsg" class="muted"></p>
      ${n ? `<table class="table"><tr><th>Designer</th><th></th><th></th></tr>${rows}</table>` : ""}
      ${sub}</div>
    ${referralHtml(referrals)}`;
}

/** Opens Stripe (Checkout or the portal) through the service. */
/** Back from Checkout: the service confirms the session with Stripe. Whether the subscription is recorded. */
// The access token is passed in, not read from the client: asking it for the session while it's announcing a
// sign-in waits forever (the page "Loading…" back from Checkout).
export async function confirmCheckout(token: string, session: string): Promise<boolean> {
  const r = await fetch("/api/billing/confirm", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ session }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  return !!((await r?.json().catch(() => null)) as { subscribed?: boolean } | null)?.subscribed;
}

export async function goToStripe(sb: SupabaseClient, which: "checkout" | "portal"): Promise<string> {
  const { data } = await sb.auth.getSession();
  const r = await fetch(`/api/billing/${which}`, { method: "POST", headers: { authorization: `Bearer ${data.session?.access_token ?? ""}` } });
  const body = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!body.url) return body.error ?? "Stripe didn't answer — try again in a moment";
  location.href = body.url;
  return "";
}
