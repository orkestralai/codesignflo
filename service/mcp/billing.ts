// Payments through Stripe: €25 a month per designer seat, VAT included. A seat belongs to a designer (by email) and
// works in every project; it's paid by the designer or by anyone paying for others (one subscription per payer, its
// quantity = the seats they pay for). Developers are free; designers get 5 free sends to dev first. Until the
// launch offer ends (web/src/pricing.ts), checkout adds a coupon: 40% off, i.e. €15 a seat, for 6 months.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LAUNCH, launchOn, SEAT_EUR } from "../web/src/pricing.ts";
import { emailButton, emailHtml } from "./notify.ts";
import { afterSubscribed, onChargeProblem, onInvoicePaid } from "./referrals.ts";

export type BillingConfig = {
  /** Stripe's secret key (sk_test_… while testing). Without it, billing is off: everyone is served. */
  secretKey?: string;
  /** The webhook endpoint's signing secret (whsec_…). */
  webhookSecret?: string;
  /** The price's lookup key; created on first use if Stripe has none (€25 a month per seat, VAT included). */
  priceLookup?: string;
  /** Stripe's API (tests point it at a fake). */
  api?: string;
  /** Sends an email (the service's SMTP or Resend); without it, no payment confirmation from us. */
  mail?: (m: { to: string[]; subject: string; text: string; html?: string }) => Promise<void>;
  /** The web app, for the link in the confirmation. */
  web?: string;
};

const PRICE = { lookup: "designer_seat_25_incl_vat_monthly", cents: SEAT_EUR * 100, currency: "eur", product: "CoDesignFlo designer seat" } as const;

/** The launch coupon (40% off for 6 months: €15 instead of €25), made once if Stripe doesn't have it yet. */
async function launchCoupon(cfg: BillingConfig): Promise<string> {
  try {
    return (await stripe<{ id: string }>(cfg, "GET", `coupons/${LAUNCH.coupon}`)).id;
  } catch {
    const made = await stripe<{ id: string }>(cfg, "POST", "coupons", {
      id: LAUNCH.coupon,
      name: `Launch price: €${LAUNCH.eur} a seat for ${LAUNCH.months} months`,
      percent_off: LAUNCH.percentOff,
      duration: "repeating",
      duration_in_months: LAUNCH.months,
    });
    return made.id;
  }
}

/** Stripe's form encoding: nested keys as a[b][0][c]. */
export function form(o: Record<string, unknown>, prefix = ""): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(form(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join("&");
}

/** Stripe's REST API. A POST with an idempotency key is made once by Stripe, however often it's sent. */
export async function stripe<T>(cfg: BillingConfig, method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const url = `${cfg.api ?? "https://api.stripe.com"}/v1/${path}${method === "GET" && body ? `?${form(body)}` : ""}`;
  const r = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(method === "POST" && body ? { body: form(body) } : {}),
  });
  const data = (await r.json()) as T & { error?: { message?: string } };
  if (!r.ok) {
    // Stripe's own words go to the logs; whoever asked hears that payments couldn't be reached.
    console.error(`Stripe ${method} ${path}: ${r.status} ${data.error?.message ?? ""}`);
    throw new Error("payments couldn't be reached — try again in a moment");
  }
  return data;
}

/**
 * The seat price, made once if Stripe doesn't have it yet. Its amount includes VAT (tax_behavior inclusive):
 * Stripe Tax takes each customer's VAT out of it. A price made without a tax behaviour is set once.
 */
async function priceId(cfg: BillingConfig): Promise<string> {
  const lookup = cfg.priceLookup ?? PRICE.lookup;
  const found = await stripe<{ data: { id: string; tax_behavior?: string | null }[] }>(cfg, "GET", "prices", {
    "lookup_keys[]": lookup,
    active: true,
    limit: 1,
  });
  const p = found.data[0];
  if (p) {
    if (!p.tax_behavior || p.tax_behavior === "unspecified") await stripe(cfg, "POST", `prices/${p.id}`, { tax_behavior: "inclusive" });
    return p.id;
  }
  const made = await stripe<{ id: string }>(cfg, "POST", "prices", {
    currency: PRICE.currency,
    unit_amount: PRICE.cents,
    tax_behavior: "inclusive",
    recurring: { interval: "month" },
    lookup_key: lookup,
    product_data: { name: PRICE.product },
  });
  return made.id;
}

/**
 * Checks a webhook's Stripe-Signature (t=…,v1=…) against the raw body, within 5 minutes. Returns the event, or
 * null when it doesn't verify.
 */
export function verifyWebhook(raw: string, header: string, secret: string, now = Date.now()): { type: string; data: { object: Record<string, unknown> } } | null {
  const parts = Object.fromEntries(header.split(",").map((x) => x.split("=") as [string, string]));
  const t = Number(parts.t);
  const sigs = header
    .split(",")
    .filter((x) => x.startsWith("v1="))
    .map((x) => x.slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return null;
  const want = createHmac("sha256", secret).update(`${t}.${raw}`).digest();
  const ok = sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  });
  return ok ? (JSON.parse(raw) as { type: string; data: { object: Record<string, unknown> } }) : null;
}

const reply = (res: ServerResponse, status: number, b: unknown) =>
  void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(b));

type Account = { user_id: string; trial_ends_at: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null; seats: number };

async function account(db: SupabaseClient, userId: string): Promise<Account> {
  await db.from("billing_accounts").upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  const { data, error } = await db.from("billing_accounts").select("*").eq("user_id", userId).single();
  if (error) throw new Error(`couldn't read billing: ${error.message}`);
  return data as Account;
}

async function seatsOf(db: SupabaseClient, userId: string): Promise<number> {
  const { data } = await db.rpc("billing_seats", { p_owner: userId });
  return Number(data ?? 0);
}

/** Stripe Checkout for the signed-in payer: a subscription for the seats they pay for, charged from today. */
export async function checkout(cfg: BillingConfig, db: SupabaseClient, user: { id: string; email?: string | null }, web: string, res: ServerResponse) {
  if (!cfg.secretKey) return reply(res, 503, { error: "payments aren't set up on this server yet" });
  const a = await account(db, user.id);
  if (a.stripe_subscription_id) return reply(res, 409, { error: "you're subscribed already — manage it from Billing" });
  let customer = a.stripe_customer_id;
  if (!customer) {
    customer = (await stripe<{ id: string }>(cfg, "POST", "customers", { email: user.email ?? undefined, metadata: { user_id: user.id } })).id;
    await db.from("billing_accounts").update({ stripe_customer_id: customer, updated_at: new Date().toISOString() }).eq("user_id", user.id);
  }
  // Already subscribed in Stripe, though not recorded here (a webhook that didn't arrive): no second subscription;
  // the one there is recorded now.
  const existing = await stripe<{ data: Sub[] }>(cfg, "GET", "subscriptions", { customer, status: "all", limit: 10 });
  const running = existing.data.find((x) => ["active", "trialing", "past_due", "unpaid"].includes(x.status));
  if (running) {
    await mirror(cfg, db, { ...running, metadata: { ...running.metadata, user_id: user.id } });
    return reply(res, 409, { error: "you're subscribed already — manage it from Billing" });
  }
  const seats = await seatsOf(db, user.id);
  if (!seats) return reply(res, 400, { error: "add the designers you pay for first (yourself, or others by email)" });
  const session = await stripe<{ url: string }>(cfg, "POST", "checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price: await priceId(cfg), quantity: seats }],
    subscription_data: { metadata: { user_id: user.id } },
    // VAT: Stripe Tax works it out from the billing address and takes it out of the price (19% in Germany, German
    // VAT for consumers elsewhere in the EU under the OSS threshold, reverse charge for EU businesses with a VAT ID).
    automatic_tax: { enabled: true },
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    customer_update: { address: "auto", name: "auto" },
    // Stripe takes either a discount or promotion codes: the launch coupon while it runs, codes after.
    ...(launchOn() ? { discounts: [{ coupon: await launchCoupon(cfg) }] } : { allow_promotion_codes: true }),
    // Back with the session: the page confirms it (confirm below), so the subscription shows even before
    // Stripe's webhook arrives, or when it doesn't.
    success_url: `${web}/#/billing?done=1&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${web}/#/billing`,
  });
  return reply(res, 200, { url: session.url });
}

/** Stripe's billing portal (payment method, invoices, cancel). */
export async function portal(cfg: BillingConfig, db: SupabaseClient, userId: string, web: string, res: ServerResponse) {
  if (!cfg.secretKey) return reply(res, 503, { error: "payments aren't set up on this server yet" });
  const a = await account(db, userId);
  if (!a.stripe_customer_id) return reply(res, 404, { error: "no subscription yet — subscribe from Billing" });
  const s = await stripe<{ url: string }>(cfg, "POST", "billing_portal/sessions", { customer: a.stripe_customer_id, return_url: `${web}/#/billing?refresh=1` });
  return reply(res, 200, { url: s.url });
}

type Sub = {
  id: string;
  customer: string;
  status: string;
  current_period_end?: number;
  /** Set when it's cancelled for later (at the end of the period, or a date). */
  cancel_at?: number | null;
  cancel_at_period_end?: boolean;
  metadata?: { user_id?: string };
  items?: { data: { id: string; quantity: number; current_period_end?: number }[] };
};

/** Mirrors a subscription into billing_accounts (by its user, else by its customer). */
async function mirror(cfg: BillingConfig, db: SupabaseClient, sub: Sub, gone = false) {
  const item = sub.items?.data[0];
  const end = sub.current_period_end ?? item?.current_period_end;
  const row = {
    stripe_customer_id: sub.customer,
    stripe_subscription_id: gone ? null : sub.id,
    status: sub.status,
    current_period_end: end ? new Date(end * 1000).toISOString() : null,
    seats: item?.quantity ?? 0,
    cancel_at: !gone && sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : !gone && sub.cancel_at_period_end && end ? new Date(end * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  const userId = sub.metadata?.user_id;
  const { data, error } = userId
    ? await db.from("billing_accounts").upsert({ user_id: userId, ...row }, { onConflict: "user_id" }).select("user_id")
    : await db.from("billing_accounts").update(row).eq("stripe_customer_id", sub.customer).select("user_id");
  // Stripe retries a webhook that failed: say so rather than lose the update.
  if (error) throw new Error(`couldn't record the subscription: ${error.message}`);
  const payer = (data ?? [])[0]?.user_id as string | undefined;
  if (payer && !gone && (sub.status === "active" || sub.status === "trialing")) {
    await confirmPaid(cfg, db, payer, sub);
    // Referral months waiting for this payer apply now; the referrals of the seats they pay for move on.
    await afterSubscribed(cfg, db, payer);
  }
}

/**
 * Our own confirmation that the subscription is on (Stripe sends the receipts): once per subscription, to the
 * payer. Claimed before sending, so the webhook and the page back from Checkout don't both send it; a failed
 * send is given back, for the next event to try again. Never fails the caller.
 */
async function confirmPaid(cfg: BillingConfig, db: SupabaseClient, userId: string, sub: Sub) {
  if (!cfg.mail) return;
  const { data: claimed } = await db
    .from("billing_accounts")
    .update({ confirmed_subscription: sub.id })
    .eq("user_id", userId)
    .or(`confirmed_subscription.is.null,confirmed_subscription.neq.${sub.id}`)
    .select("user_id");
  if (!claimed?.length) return;
  try {
    const { data } = await db.auth.admin.getUserById(userId);
    const to = data.user?.email;
    if (!to) return;
    const seats = sub.items?.data[0]?.quantity ?? 1;
    const end = sub.current_period_end ?? sub.items?.data[0]?.current_period_end;
    const web = cfg.web ?? "https://codesignflo.com";
    const renew = end ? new Date(end * 1000).toISOString().slice(0, 10) : "";
    const billing = `${web}/#/billing`;
    await cfg.mail({
      to: [to],
      subject: "Your CoDesignFlo subscription is active",
      text: [
        "Thanks — your payment went through and your CoDesignFlo subscription is active.",
        "",
        `Designer seats: ${seats}. Each seat works in every project, for the designer whose email it's for.`,
        ...(renew ? [`Next renewal: ${renew}.`] : []),
        "",
        "Stripe sends your receipt and invoices separately. Manage your seats, payment method and invoices, or cancel, in Billing:",
        billing,
        "",
        "Questions? Reply to this email or write to contact@orkestralai.com.",
        "",
        "CoDesignFlo by OrkestralAI",
      ].join("\n"),
      html: emailHtml(
        `<p><b>Thanks — your payment went through and your CoDesignFlo subscription is active.</b></p>
<p>Designer seats: <b>${seats}</b>. Each seat works in every project, for the designer whose email it's for.${renew ? `<br>Next renewal: ${renew}.` : ""}</p>
<p style="color:#6b6b6b">Stripe sends your receipt and invoices separately. Manage your seats, payment method and invoices, or cancel, in Billing.</p>
${emailButton(billing, "Open Billing")}
<p style="color:#6b6b6b;font-size:12px">Questions? Reply to this email or write to <a href="mailto:contact@orkestralai.com">contact@orkestralai.com</a>.</p>`,
      ),
    });
  } catch {
    await db.from("billing_accounts").update({ confirmed_subscription: null }).eq("user_id", userId).eq("confirmed_subscription", sub.id);
  }
}

/**
 * Back from Checkout: the signed-in payer's completed session, read from Stripe and mirrored as the webhook
 * would (the webhook still keeps it up to date afterwards). Only their own session.
 */
export async function confirm(cfg: BillingConfig, db: SupabaseClient, userId: string, sessionId: string, res: ServerResponse) {
  if (!cfg.secretKey) return reply(res, 503, { error: "payments aren't set up on this server yet" });
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return reply(res, 400, { error: "not a checkout session" });
  const s = await stripe<{ client_reference_id?: string; status?: string; subscription?: Sub | null }>(cfg, "GET", `checkout/sessions/${sessionId}`, {
    "expand[]": "subscription",
  });
  if (s.client_reference_id !== userId) return reply(res, 403, { error: "not your checkout" });
  if (s.status !== "complete" || !s.subscription) return reply(res, 200, { subscribed: false });
  await mirror(cfg, db, { ...s.subscription, metadata: { ...s.subscription.metadata, user_id: userId } });
  return reply(res, 200, { subscribed: true });
}

/**
 * Back from Manage billing: the payer's subscription read again from Stripe and mirrored (a cancellation shows at
 * once, and even when the webhook doesn't arrive).
 */
export async function refresh(cfg: BillingConfig, db: SupabaseClient, userId: string, res: ServerResponse) {
  if (!cfg.secretKey) return reply(res, 503, { error: "payments aren't set up on this server yet" });
  const a = await account(db, userId);
  if (!a.stripe_customer_id) return reply(res, 200, { subscribed: false });
  return reply(res, 200, { subscribed: await syncCustomer(cfg, db, a.stripe_customer_id, userId) });
}

/**
 * A customer's subscription as Stripe has it now, mirrored: the running one (Stripe lists the newest first), else
 * the latest, ended. Read from Stripe rather than taken from an event, so events arriving late, twice or out of
 * order (resent ones) can't bring back an older state. Whether one is running.
 */
async function syncCustomer(cfg: BillingConfig, db: SupabaseClient, customer: string, userId?: string): Promise<boolean> {
  const { data } = await stripe<{ data: Sub[] }>(cfg, "GET", "subscriptions", { customer, status: "all", limit: 10 });
  const running = data.find((x) => ["active", "trialing", "past_due", "unpaid"].includes(x.status));
  const sub = running ?? data[0];
  if (sub) await mirror(cfg, db, userId ? { ...sub, metadata: { ...sub.metadata, user_id: userId } } : sub, !running);
  return !!running;
}

/**
 * Stripe's webhook: the subscription's state, mirrored; paid invoices, refunds and disputes for referrals. Events
 * to send it: checkout.session.completed, customer.subscription.*, invoice.paid, charge.refunded,
 * charge.dispute.created.
 */
export async function webhook(cfg: BillingConfig, db: SupabaseClient, raw: string, signature: string, res: ServerResponse) {
  if (!cfg.webhookSecret) return reply(res, 503, { error: "webhook secret not set" });
  const event = verifyWebhook(raw, signature, cfg.webhookSecret);
  if (!event) {
    // Which check failed, for whoever reads Stripe's delivery log (nothing about the secret itself).
    const t = Number(/(?:^|,)t=(\d+)/.exec(signature)?.[1]);
    const why = !signature
      ? "no Stripe-Signature header"
      : !t
        ? "malformed Stripe-Signature header"
        : Math.abs(Date.now() / 1000 - t) > 300
          ? "signature too old (more than 5 minutes)"
          : "signature doesn't match STRIPE_WEBHOOK_SECRET (check it's this endpoint's signing secret, in this mode: test or live)";
    return reply(res, 400, { error: `bad signature: ${why}` });
  }
  const o = event.data.object;
  if (event.type === "checkout.session.completed" && o.mode === "subscription" && typeof o.client_reference_id === "string") {
    const { error } = await db
      .from("billing_accounts")
      .upsert(
        { user_id: o.client_reference_id, stripe_customer_id: o.customer, stripe_subscription_id: o.subscription, status: "active", updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(`couldn't record the subscription: ${error.message}`);
    if (typeof o.customer === "string") await syncCustomer(cfg, db, o.customer, o.client_reference_id);
  } else if (event.type.startsWith("customer.subscription.")) {
    const sub = o as unknown as Sub;
    await syncCustomer(cfg, db, sub.customer, sub.metadata?.user_id);
  } else if (event.type === "invoice.paid" && typeof o.id === "string") {
    // Referrals (mcp/referrals.ts): the invoice is read again from Stripe there.
    await onInvoicePaid(cfg, db, o.id);
  } else if (event.type === "charge.refunded" && typeof o.id === "string") {
    await onChargeProblem(cfg, db, o.id, "refunded");
  } else if (event.type === "charge.dispute.created" && typeof o.charge === "string") {
    await onChargeProblem(cfg, db, o.charge, "disputed");
  }
  return reply(res, 200, { received: true });
}

/**
 * Seats billed = the seats each payer pays for: each subscribed payer whose count changed gets the new quantity
 * (prorated). Called after seats are added or removed (with the notifications) and by the daily cron.
 */
export async function syncSeats(cfg: BillingConfig, db: SupabaseClient): Promise<{ updated: number }> {
  if (!cfg.secretKey) return { updated: 0 };
  const { data } = await db.from("billing_accounts").select("user_id, stripe_subscription_id, seats").not("stripe_subscription_id", "is", null);
  let updated = 0;
  for (const a of (data ?? []) as { user_id: string; stripe_subscription_id: string; seats: number }[]) {
    const want = Math.max(1, await seatsOf(db, a.user_id));
    if (want === a.seats) continue;
    const sub = await stripe<Sub>(cfg, "GET", `subscriptions/${a.stripe_subscription_id}`);
    const item = sub.items?.data[0];
    if (!item) continue;
    await stripe(cfg, "POST", `subscription_items/${item.id}`, { quantity: want, proration_behavior: "create_prorations" });
    await db.from("billing_accounts").update({ seats: want, updated_at: new Date().toISOString() }).eq("user_id", a.user_id);
    updated++;
  }
  return { updated };
}
