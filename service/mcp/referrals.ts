// Referrals, Stripe's side (the database's: supabase/migrations/20261122000100_referrals.sql). A designer brings
// another designer (a project invitation or their link). The invited designer's first paid invoice gives whoever
// pays their seat a credit of one month (their second month is free); their second paid invoice, a month or so
// later, gives the referrer a month free: a Stripe balance credit when they're subscribed, else banked for 12
// months and applied when they subscribe. At most 12 a rolling year per referrer.
//
// Everything is read again from Stripe (the customer's paid invoices, the charges) rather than taken from an
// event, so events arriving late, twice or out of order change nothing; every credit carries an idempotency key
// and a marker in its metadata, so it's never given twice. Called from the webhook (invoice.paid, charge.refunded,
// charge.dispute.created), when a subscription is recorded, and by the daily cron.
import type { SupabaseClient } from "@supabase/supabase-js";
import { type BillingConfig, stripe } from "./billing.ts";
import { emailButton, emailHtml, escHtml } from "./notify.ts";

/** What a credit says in Stripe (on the customer's balance and their invoices). */
export const CREDIT_DESCRIPTION = "CoDesignFlo referral: one month free";
/** The referee's second paid invoice is a renewal at least this long after the first. */
const SECOND_AFTER_DAYS = 25;
/** How far an invoice may predate the referral or the seat (clocks differ). */
const SLACK_MS = 10 * 60_000;
const OPEN = ["pending", "first_paid", "qualified"];
const FIRST_REASONS = new Set(["subscription_create", "subscription_cycle", "subscription_update"]);
const ACTIVE = new Set(["active", "trialing", "past_due"]);

type Ref = { id: string } | string | null | undefined;
type Line = {
  amount: number;
  quantity?: number | null;
  proration?: boolean;
  parent?: { subscription_item_details?: { proration?: boolean } | null } | null;
  discount_amounts?: { amount: number }[] | null;
};
export type Invoice = {
  id: string;
  customer: string;
  status: string;
  amount_paid: number;
  currency: string;
  billing_reason?: string | null;
  created: number;
  status_transitions?: { paid_at?: number | null };
  charge?: Ref;
  payment_intent?: Ref;
  lines?: { data: Line[] };
};
type Charge = {
  id: string;
  refunded?: boolean;
  amount_refunded?: number;
  disputed?: boolean;
  payment_method_details?: ({ type?: string } & Record<string, unknown>) | null;
};
type Referral = {
  id: number;
  referrer: string | null;
  referee: string | null;
  referee_email: string;
  bound_at: string;
  status: string;
  payer: string | null;
  payer_customer: string | null;
  seat_cents: number | null;
  currency: string | null;
  first_invoice: string | null;
  first_charge: string | null;
  first_paid_at: string | null;
  referee_credit_txn: string | null;
  second_invoice: string | null;
  second_charge: string | null;
};

const idOf = (x: Ref) => (typeof x === "string" ? x : (x?.id ?? null));
const paidAt = (i: Invoice) => (i.status_transitions?.paid_at ?? i.created) * 1000;
const now = () => new Date().toISOString();
const bad = (c: Charge | null) => !!c && (c.refunded === true || (c.amount_refunded ?? 0) > 0 || c.disputed === true);

/** The card (or bank account) a charge was paid with: its fingerprint only. */
export function fingerprintOf(c: Charge | null): string | null {
  const d = c?.payment_method_details;
  if (!d) return null;
  const of = (k?: string) => (k ? ((d[k] as { fingerprint?: string } | undefined)?.fingerprint ?? null) : null);
  return of(d.type) ?? of("card");
}

/**
 * One seat's month as charged on an invoice: the seat line (not a proration) after its discounts (the launch
 * price), VAT included as charged, per seat. Falls back to what was paid.
 */
export function seatCents(inv: Invoice): number {
  const lines = (inv.lines?.data ?? []).filter(
    (l) => l.proration !== true && l.parent?.subscription_item_details?.proration !== true && (l.quantity ?? 0) > 0 && l.amount > 0,
  );
  const l = lines[0];
  if (!l) return inv.amount_paid;
  const off = (l.discount_amounts ?? []).reduce((s, d) => s + d.amount, 0);
  return Math.max(0, Math.round((l.amount - off) / (l.quantity ?? 1)));
}

/** The charge that paid an invoice, read from Stripe (older API versions name it on the invoice, newer ones list payments). */
async function chargeOf(cfg: BillingConfig, inv: Invoice): Promise<Charge | null> {
  let charge = idOf(inv.charge);
  let intent = idOf(inv.payment_intent);
  if (!charge && !intent && inv.amount_paid > 0) {
    const ps = await stripe<{ data: { status?: string; payment?: { charge?: Ref; payment_intent?: Ref } }[] }>(cfg, "GET", "invoice_payments", {
      invoice: inv.id,
      limit: 10,
    }).catch(() => ({ data: [] }));
    const p = ps.data.find((x) => x.status === "paid") ?? ps.data[0];
    charge = idOf(p?.payment?.charge);
    intent = idOf(p?.payment?.payment_intent);
  }
  if (!charge && intent) charge = idOf((await stripe<{ latest_charge?: Ref }>(cfg, "GET", `payment_intents/${intent}`)).latest_charge);
  return charge ? stripe<Charge>(cfg, "GET", `charges/${charge}`) : null;
}

/** A customer's paid invoices, oldest first. */
async function paidInvoices(cfg: BillingConfig, customer: string): Promise<Invoice[]> {
  const { data } = await stripe<{ data: Invoice[] }>(cfg, "GET", "invoices", { customer, status: "paid", limit: 24 });
  return [...data].filter((i) => i.status === "paid").sort((a, b) => paidAt(a) - paidAt(b));
}

/**
 * A credit on a customer's balance, once: an earlier one with the same key (in its metadata) is the answer; else
 * it's made with the key as Stripe's idempotency key too.
 */
async function credit(cfg: BillingConfig, customer: string, cents: number, currency: string, key: string): Promise<string> {
  const { data } = await stripe<{ data: { id: string; metadata?: Record<string, string> }[] }>(cfg, "GET", `customers/${customer}/balance_transactions`, { limit: 100 });
  const had = data.find((t) => t.metadata?.cdf_key === key);
  if (had) return had.id;
  const t = await stripe<{ id: string }>(
    cfg,
    "POST",
    `customers/${customer}/balance_transactions`,
    { amount: -cents, currency, description: CREDIT_DESCRIPTION, metadata: { cdf_key: key } },
    key,
  );
  return t.id;
}

async function recordFingerprint(db: SupabaseClient, customer: string, fingerprint: string | null, userId: string | null) {
  if (!fingerprint) return;
  await db.from("payment_fingerprints").upsert({ customer, fingerprint, user_id: userId }, { onConflict: "customer,fingerprint", ignoreDuplicates: true });
}

/** The cards seen on the referrer's side: on their paid invoices, and saved on their Stripe customer. */
async function referrerFingerprints(cfg: BillingConfig, db: SupabaseClient, referrer: string): Promise<Set<string>> {
  const { data: acct } = await db.from("billing_accounts").select("stripe_customer_id").eq("user_id", referrer).maybeSingle();
  const customer = (acct?.stripe_customer_id as string | null | undefined) ?? null;
  const { data } = await db
    .from("payment_fingerprints")
    .select("fingerprint")
    .or(customer ? `user_id.eq.${referrer},customer.eq.${customer}` : `user_id.eq.${referrer}`);
  const fps = new Set(((data ?? []) as { fingerprint: string }[]).map((r) => r.fingerprint));
  if (customer) {
    const pms = await stripe<{ data: { card?: { fingerprint?: string } }[] }>(cfg, "GET", "payment_methods", { customer, type: "card", limit: 20 }).catch(() => ({
      data: [],
    }));
    for (const pm of pms.data) if (pm.card?.fingerprint) fps.add(pm.card.fingerprint);
  }
  return fps;
}

async function voidIt(db: SupabaseClient, r: Referral, why: string) {
  await db.from("referrals").update({ status: "void", void_reason: why, updated_at: now() }).eq("id", r.id).in("status", OPEN);
}

async function whitelisted(db: SupabaseClient, emails: string[]): Promise<boolean> {
  const list = emails.filter(Boolean).map((e) => e.toLowerCase());
  if (!list.length) return false;
  const { data } = await db.from("billing_whitelist").select("email").in("email", list);
  return !!data?.length;
}

async function emailOf(db: SupabaseClient, userId: string): Promise<string> {
  const { data } = await db.auth.admin.getUserById(userId);
  return data.user?.email?.toLowerCase() ?? "";
}

/**
 * Moves one referral on as far as Stripe allows: its first paid invoice (the referee's credit), its second (the
 * referrer's month), or void when it can't count.
 */
export async function processReferral(cfg: BillingConfig, db: SupabaseClient, r: Referral): Promise<void> {
  if (!cfg.secretKey || !OPEN.includes(r.status)) return;
  if (!r.referrer) return voidIt(db, r, "the referrer's account is gone");
  const referrer = r.referrer;
  if (r.status === "qualified") return reward(cfg, db, r);
  const { data: seat } = await db.from("designer_seats").select("payer, added_at").eq("email", r.referee_email).maybeSingle();
  if (!seat) return;
  const payer = seat.payer as string;
  const { data: acct } = await db.from("billing_accounts").select("stripe_customer_id").eq("user_id", payer).maybeSingle();
  const customer = (acct?.stripe_customer_id as string | null | undefined) ?? null;
  if (!customer) return;
  // Never the referrer's own money: they pay the seat, or it's their Stripe customer.
  if (payer === r.referrer) return voidIt(db, r, "the referrer pays this seat");
  const { data: theirs } = await db.from("billing_accounts").select("stripe_customer_id").eq("user_id", r.referrer).maybeSingle();
  if (theirs?.stripe_customer_id && theirs.stripe_customer_id === customer) return voidIt(db, r, "the referrer's Stripe customer pays this seat");
  if (await whitelisted(db, [r.referee_email, await emailOf(db, payer)])) return voidIt(db, r, "free list");
  const invoices = await paidInvoices(cfg, customer);

  if (r.status === "pending") {
    const since = Math.max(Date.parse(r.bound_at), Date.parse(seat.added_at as string)) - SLACK_MS;
    const first = invoices.find((i) => i.amount_paid > 0 && FIRST_REASONS.has(i.billing_reason ?? "") && paidAt(i) >= since);
    if (!first) return;
    const charge = await chargeOf(cfg, first);
    if (bad(charge)) return voidIt(db, r, "refunded or disputed");
    const fp = fingerprintOf(charge);
    await recordFingerprint(db, customer, fp, payer);
    if (fp && (await referrerFingerprints(cfg, db, r.referrer)).has(fp)) return voidIt(db, r, "paid with the referrer's card");
    const patch = {
      status: "first_paid",
      payer,
      payer_customer: customer,
      seat_cents: seatCents(first),
      currency: first.currency,
      first_invoice: first.id,
      first_charge: charge?.id ?? null,
      first_paid_at: new Date(paidAt(first)).toISOString(),
      updated_at: now(),
    };
    const { data: won } = await db.from("referrals").update(patch).eq("id", r.id).eq("status", "pending").select("*");
    if (!won?.length) return; // moved on meanwhile (another delivery of the same event)
    r = won[0] as Referral;
  }

  if (r.status === "first_paid") {
    // The referee's second month: a credit of one seat's month for whoever pays it.
    if (!r.referee_credit_txn && r.payer_customer && r.seat_cents && r.currency) {
      const txn = await credit(cfg, r.payer_customer, r.seat_cents, r.currency, `cdf-referral-${r.id}-referee`);
      const { error } = await db
        .from("referrals")
        .update({ referee_credit_txn: txn, referee_credit_cents: r.seat_cents, updated_at: now() })
        .eq("id", r.id)
        .is("referee_credit_txn", null);
      if (error) throw new Error(`couldn't record the referral credit: ${error.message}`);
    }
    const after = Date.parse(r.first_paid_at ?? "") + SECOND_AFTER_DAYS * 86400_000;
    const second = invoices.find((i) => i.id !== r.first_invoice && i.billing_reason === "subscription_cycle" && paidAt(i) >= after);
    if (!second) return;
    if (r.first_charge && bad(await stripe<Charge>(cfg, "GET", `charges/${r.first_charge}`))) return voidIt(db, r, "refunded or disputed");
    const charge = second.amount_paid > 0 ? await chargeOf(cfg, second) : null;
    if (bad(charge)) return voidIt(db, r, "refunded or disputed");
    const fp = fingerprintOf(charge);
    await recordFingerprint(db, customer, fp, payer);
    if (fp && (await referrerFingerprints(cfg, db, referrer)).has(fp)) return voidIt(db, r, "paid with the referrer's card");
    const cents = seatCents(second);
    const { data: won } = await db
      .from("referrals")
      .update({
        status: "qualified",
        second_invoice: second.id,
        second_charge: charge?.id ?? null,
        second_paid_at: new Date(paidAt(second)).toISOString(),
        ...(cents > 0 ? { seat_cents: cents } : {}),
        updated_at: now(),
      })
      .eq("id", r.id)
      .eq("status", "first_paid")
      .select("*");
    if (!won?.length) return;
    r = won[0] as Referral;
  }

  if (r.status === "qualified") await reward(cfg, db, r);
}

/** The referrer's month: checked once more (refunds, disputes, cards), then earned (capped at 12 a year) and applied. */
async function reward(cfg: BillingConfig, db: SupabaseClient, r: Referral) {
  if (!r.referrer) return voidIt(db, r, "the referrer's account is gone");
  for (const c of [r.first_charge, r.second_charge])
    if (c && bad(await stripe<Charge>(cfg, "GET", `charges/${c}`))) return voidIt(db, r, "refunded or disputed");
  if (r.payer === r.referrer) return voidIt(db, r, "the referrer pays this seat");
  const mine = await referrerFingerprints(cfg, db, r.referrer);
  if (r.payer_customer) {
    const { data } = await db.from("payment_fingerprints").select("fingerprint").eq("customer", r.payer_customer);
    if (((data ?? []) as { fingerprint: string }[]).some((x) => mine.has(x.fingerprint))) return voidIt(db, r, "paid with the referrer's card");
  }
  const { data, error } = await db.rpc("referral_earn", { p_referral: r.id, p_cents: r.seat_cents ?? 0, p_currency: r.currency ?? "eur" });
  if (error) throw new Error(`couldn't record the referral: ${error.message}`);
  const got = ((data ?? []) as { result: string; reward_id: number | null }[])[0];
  if (got?.result !== "banked" && got?.result !== "done") return;
  await applyBanked(cfg, db, r.referrer);
  if (got.reward_id) await notifyReward(cfg, db, got.reward_id);
}

/** A referrer's banked months, applied to their Stripe customer while they're subscribed (expired ones aren't). */
export async function applyBanked(cfg: BillingConfig, db: SupabaseClient, userId: string): Promise<number> {
  if (!cfg.secretKey) return 0;
  await db.from("referral_rewards").update({ status: "expired" }).eq("referrer", userId).eq("status", "banked").lt("expires_at", now());
  const { data: acct } = await db.from("billing_accounts").select("stripe_customer_id, status").eq("user_id", userId).maybeSingle();
  const customer = (acct?.stripe_customer_id as string | null | undefined) ?? null;
  if (!customer || !ACTIVE.has(String(acct?.status ?? ""))) return 0;
  const { data } = await db.from("referral_rewards").select("id, cents, currency").eq("referrer", userId).eq("status", "banked").gte("expires_at", now()).order("id");
  let applied = 0;
  for (const w of (data ?? []) as { id: number; cents: number; currency: string }[]) {
    const txn = await credit(cfg, customer, w.cents, w.currency, `cdf-referral-reward-${w.id}`);
    const { error } = await db.from("referral_rewards").update({ status: "applied", customer, txn, applied_at: now() }).eq("id", w.id).eq("status", "banked");
    if (error) throw new Error(`couldn't record the referral credit: ${error.message}`);
    applied++;
  }
  return applied;
}

const money = (cents: number, currency: string) =>
  currency.toLowerCase() === "eur" ? `€${(cents / 100).toFixed(2)}` : `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** The email to a referrer who earned a month (once per month earned; a failed send is tried again by the cron). */
export function rewardEmail(o: { cents: number; currency: string; applied: boolean; expires: string; web: string }) {
  const billing = `${o.web}/#/billing`;
  const head = "A designer you invited has paid for their second month on CoDesignFlo, so you get a month free.";
  const how = o.applied
    ? `It's a credit of ${money(o.cents, o.currency)} on your account: Stripe takes it off your next invoice.`
    : `It's a credit of ${money(o.cents, o.currency)} that waits for you: it's taken off your first invoice when you subscribe in Billing, until ${dayOf(o.expires)}.`;
  const more = "You can earn up to 12 free months a year. Your link and your free months are in Billing.";
  return {
    subject: "You earned a free month on CoDesignFlo",
    text: [head, "", how, "", more, billing, "", "CoDesignFlo by OrkestralAI"].join("\n"),
    html: emailHtml(`<p><b>${escHtml(head)}</b></p><p>${escHtml(how)}</p><p style="color:#6b6b6b">${escHtml(more)}</p>${emailButton(billing, "Open Billing")}`),
  };
}

async function notifyReward(cfg: BillingConfig, db: SupabaseClient, rewardId: number) {
  if (!cfg.mail) return;
  const { data: claimed } = await db.from("referral_rewards").update({ notified_at: now() }).eq("id", rewardId).is("notified_at", null).select("*");
  const w = (claimed ?? [])[0] as { referrer: string; cents: number; currency: string; status: string; expires_at: string } | undefined;
  if (!w) return;
  try {
    const to = await emailOf(db, w.referrer);
    if (!to) return;
    const m = rewardEmail({ cents: w.cents, currency: w.currency, applied: w.status === "applied", expires: w.expires_at, web: cfg.web ?? "https://codesignflo.com" });
    await cfg.mail({ to: [to], ...m });
  } catch (e) {
    console.error("referral email:", e);
    await db.from("referral_rewards").update({ notified_at: null }).eq("id", rewardId);
  }
}

/** The open referrals whose seats a payer pays for. */
async function openReferralsOf(db: SupabaseClient, payer: string): Promise<Referral[]> {
  const { data: seats } = await db.from("designer_seats").select("email").eq("payer", payer);
  const emails = ((seats ?? []) as { email: string }[]).map((s) => s.email);
  if (!emails.length) return [];
  const { data } = await db.from("referrals").select("*").in("referee_email", emails).in("status", OPEN);
  return (data ?? []) as Referral[];
}

/** A payer's subscription is on (recorded from Stripe): their banked months apply, their referees move on. Never throws. */
export async function afterSubscribed(cfg: BillingConfig, db: SupabaseClient, payer: string): Promise<void> {
  try {
    await applyBanked(cfg, db, payer);
    for (const r of await openReferralsOf(db, payer)) await processReferral(cfg, db, r);
  } catch (e) {
    console.error("referrals after subscribing:", e);
  }
}

/** Stripe's invoice.paid: the invoice read again; its payer and seats recorded as paid, their referrals moved on. */
export async function onInvoicePaid(cfg: BillingConfig, db: SupabaseClient, invoiceId: string): Promise<void> {
  if (!cfg.secretKey || !/^in_[A-Za-z0-9_]+$/.test(invoiceId)) return;
  const inv = await stripe<Invoice>(cfg, "GET", `invoices/${invoiceId}`);
  if (inv.status !== "paid") return;
  const { data: acct } = await db.from("billing_accounts").select("user_id").eq("stripe_customer_id", inv.customer).maybeSingle();
  const payer = (acct?.user_id as string | undefined) ?? null;
  if (inv.amount_paid > 0) await recordFingerprint(db, inv.customer, fingerprintOf(await chargeOf(cfg, inv)), payer);
  // Not recorded yet (the subscription's events come later): afterSubscribed picks them up then.
  if (!payer) return;
  // The referrals first (they look at history from before this invoice), then this invoice into the history.
  for (const r of await openReferralsOf(db, payer)) await processReferral(cfg, db, r);
  const { error } = await db.rpc("log_paid_invoice", { p_payer: payer, p_invoice: inv.id });
  if (error) throw new Error(`couldn't record the invoice: ${error.message}`);
}

/** Stripe's charge.refunded and charge.dispute.created: a referral it paid for, not rewarded yet, is void. */
export async function onChargeProblem(cfg: BillingConfig, db: SupabaseClient, chargeId: string, why: "refunded" | "disputed"): Promise<void> {
  if (!cfg.secretKey || !/^(ch|py)_[A-Za-z0-9_]+$/.test(chargeId)) return;
  if (why === "refunded" && !bad(await stripe<Charge>(cfg, "GET", `charges/${chargeId}`))) return;
  await db
    .from("referrals")
    .update({ status: "void", void_reason: why, updated_at: now() })
    .or(`first_charge.eq.${chargeId},second_charge.eq.${chargeId}`)
    .in("status", OPEN);
}

/** The daily cron: banked months expire or apply, open referrals move on (missed webhooks), emails left to send go. */
export async function referralTick(cfg: BillingConfig, db: SupabaseClient): Promise<{ processed: number; applied: number }> {
  if (!cfg.secretKey) return { processed: 0, applied: 0 };
  await db.from("referral_rewards").update({ status: "expired" }).eq("status", "banked").lt("expires_at", now());
  const { data } = await db.from("referrals").select("*").in("status", OPEN).order("id").limit(500);
  let processed = 0;
  for (const r of (data ?? []) as Referral[]) {
    try {
      await processReferral(cfg, db, r);
      processed++;
    } catch (e) {
      console.error(`referral ${r.id}:`, e);
    }
  }
  const { data: banked } = await db.from("referral_rewards").select("referrer").eq("status", "banked");
  let applied = 0;
  for (const referrer of new Set(((banked ?? []) as { referrer: string }[]).map((w) => w.referrer)))
    applied += await applyBanked(cfg, db, referrer).catch((e) => (console.error("referral credit:", e), 0));
  const { data: quiet } = await db.from("referral_rewards").select("id").is("notified_at", null).in("status", ["banked", "applied"]).limit(100);
  for (const w of (quiet ?? []) as { id: number }[]) await notifyReward(cfg, db, w.id);
  return { processed, applied };
}
