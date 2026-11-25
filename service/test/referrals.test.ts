// Referrals: a designer brings a designer (a project invitation or their link); the invited designer's second
// month is credited after their first paid invoice, the referrer's month after the second; self-referrals,
// refunds, the free list and existing accounts get nothing; webhook retries never credit twice; 12 a year;
// banked months apply on subscribing and expire. Against the local Supabase stack and a fake Stripe (never the
// real one). Skipped when the stack isn't running.
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmail } from "../mcp/notify.ts";
import { CREDIT_DESCRIPTION, type Invoice, referralTick, rewardEmail, seatCents } from "../mcp/referrals.ts";
import { listen } from "../mcp/server.ts";

const env = (() => {
  try {
    const out = execSync("supabase status -o env", { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const get = (k: string) => new RegExp(`^${k}="?([^"\\n]+)`, "m").exec(out)?.[1];
    return { url: get("API_URL"), anon: get("ANON_KEY"), service: get("SERVICE_ROLE_KEY"), db: get("DB_URL") };
  } catch {
    return { url: undefined, anon: undefined, service: undefined, db: undefined };
  }
})();
const run = env.url && env.anon && env.service ? describe : describe.skip;
const PORT = 3402;
const STRIPE_PORT = 3403;
const BASE = `http://localhost:${PORT}`;
const WHSEC = "whsec_referrals";
const RUN = Date.now().toString(36);
const DAY = 86400;

type Who = { db: SupabaseClient; email: string; id: string };

async function signUp(email: string): Promise<Who> {
  const db = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
  const { data, error } = await db.auth.signUp({ email, password: "test-password-123" });
  if (error) throw error;
  return { db, email: email.toLowerCase(), id: data.user!.id };
}
const person = (name: string) => signUp(`${name}-${RUN}-${Math.random().toString(36).slice(2, 6)}@example.test`);

describe("referral pieces", () => {
  it("one seat's month as charged: the seat line after its discount, per seat; prorations aside", () => {
    const inv = { id: "in_1", customer: "c", status: "paid", amount_paid: 3000, currency: "eur", created: 0 } as Invoice;
    expect(seatCents({ ...inv, lines: { data: [{ amount: 5000, quantity: 2, discount_amounts: [{ amount: 2000 }] }] } })).toBe(1500);
    expect(seatCents({ ...inv, lines: { data: [{ amount: 700, quantity: 1, proration: true }, { amount: 2500, quantity: 1 }] } })).toBe(2500);
    expect(seatCents({ ...inv, lines: { data: [{ amount: 900, quantity: 1, parent: { subscription_item_details: { proration: true } } }] } })).toBe(3000);
  });
  it("the invitation says the second month is free when it's a referral; the referrer's email", () => {
    const base = { project: "Shop", projectId: "p_1", by: "dana@example.test", email: "des@example.test", role: "designer", added: false, web: "https://w", mcp: "https://w/mcp" };
    expect(invitationEmail({ ...base, referral: true }).text).toContain("Your second month is free when you start paying.");
    expect(invitationEmail({ ...base, referral: true }).html).toContain("Your second month is free when you start paying.");
    expect(invitationEmail(base).text).not.toContain("second month");
    expect(invitationEmail({ ...base, role: "developer", referral: true }).text).not.toContain("second month");
    const banked = rewardEmail({ cents: 2500, currency: "eur", applied: false, expires: "2027-11-22T00:00:00Z", web: "https://w" });
    expect(banked.subject).toBe("You earned a free month on CoDesignFlo");
    expect(banked.text).toContain("€25.00 that waits for you");
    expect(banked.text).toContain("22 November 2027");
    expect(rewardEmail({ cents: 1500, currency: "eur", applied: true, expires: "", web: "https://w" }).text).toContain("€15.00 on your account");
  });
});

run("referrals", { timeout: 120_000 }, () => {
  let srv: Server;
  let fake: Server;
  const ops = () => createClient(env.url!, env.service!, { auth: { persistSession: false } });
  // The fake Stripe's state.
  const invoices = new Map<string, Invoice[]>(); // by customer, newest first (as Stripe lists them)
  const charges = new Map<string, { id: string; refunded: boolean; amount_refunded: number; disputed: boolean; payment_method_details: unknown }>();
  const cards = new Map<string, string[]>(); // a customer's saved cards' fingerprints
  const balance = new Map<string, { id: string; amount: number; currency: string; description: string; metadata: Record<string, string> }[]>();
  const subs = new Map<string, unknown[]>();
  const idem = new Map<string, unknown>();
  const posts: { path: string; key?: string }[] = [];
  const mails: { to: string[]; subject: string; text: string }[] = [];
  let n = 0;

  beforeAll(() => {
    fake = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const u = new URL(req.url ?? "/", "http://x");
        const send = (o: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
        if (u.pathname === "/emails") {
          mails.push(JSON.parse(body) as { to: string[]; subject: string; text: string });
          return send({ id: "email" });
        }
        const q = u.searchParams;
        let m: RegExpExecArray | null;
        if (u.pathname === "/v1/invoices") return send({ data: invoices.get(q.get("customer") ?? "") ?? [] });
        if ((m = /^\/v1\/invoices\/(in_\w+)$/.exec(u.pathname))) {
          const inv = [...invoices.values()].flat().find((i) => i.id === m![1]);
          return inv ? send(inv) : send({ error: { message: "no such invoice" } }, 404);
        }
        if ((m = /^\/v1\/charges\/(\w+)$/.exec(u.pathname))) return send(charges.get(m[1]!) ?? { error: {} }, charges.has(m[1]!) ? 200 : 404);
        if (u.pathname === "/v1/payment_methods") return send({ data: (cards.get(q.get("customer") ?? "") ?? []).map((f) => ({ card: { fingerprint: f } })) });
        if (u.pathname === "/v1/subscriptions" && req.method === "GET") return send({ data: subs.get(q.get("customer") ?? "") ?? [] });
        if ((m = /^\/v1\/customers\/(\w+)\/balance_transactions$/.exec(u.pathname))) {
          const list = balance.get(m[1]!) ?? [];
          if (req.method === "GET") return send({ data: [...list].reverse() });
          const key = String(req.headers["idempotency-key"] ?? "");
          posts.push({ path: u.pathname, key });
          if (key && idem.has(key)) return send(idem.get(key));
          const f = new URLSearchParams(body);
          const t = {
            id: `cbtxn_${RUN}_${++n}`,
            amount: Number(f.get("amount")),
            currency: f.get("currency")!,
            description: f.get("description")!,
            metadata: { cdf_key: f.get("metadata[cdf_key]")! },
          };
          balance.set(m[1]!, [...list, t]);
          if (key) idem.set(key, t);
          return send(t);
        }
        send({ error: { message: "not in the fake" } }, 404);
      });
    }).listen(STRIPE_PORT);
    srv = listen(
      {
        base: BASE,
        web: "http://localhost:3317",
        supabaseUrl: env.url!,
        anonKey: env.anon!,
        serviceKey: env.service!,
        cli: "codesignflo",
        cliEnv: {},
        notify: { from: "CoDesignFlo <billing@example.test>", resendKey: "re_test", resendUrl: `http://localhost:${STRIPE_PORT}/emails` },
        billing: { secretKey: "sk_test_x", webhookSecret: WHSEC, api: `http://localhost:${STRIPE_PORT}` },
      },
      PORT,
    );
  });
  afterAll(() => {
    srv?.close();
    fake?.close();
  });

  const hook = async (type: string, object: Record<string, unknown>) => {
    const raw = JSON.stringify({ type, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}`;
    const r = await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sig }, body: raw });
    expect(r.status).toBe(200);
  };
  /** A customer for this person, subscribed (as the webhook would record it). */
  const subscribe = async (who: Who) => {
    const customer = `cus_${RUN}_${++n}`;
    const { error } = await ops()
      .from("billing_accounts")
      .upsert({ user_id: who.id, stripe_customer_id: customer, stripe_subscription_id: `sub_${customer}`, status: "active", seats: 1 }, { onConflict: "user_id" });
    expect(error).toBeNull();
    return customer;
  };
  /** A paid invoice in the fake Stripe (and its charge, with the card's fingerprint), then Stripe's invoice.paid. */
  const pay = async (customer: string, o: { reason: string; at: number; paid?: number; card?: string; line?: { amount: number; quantity: number; off?: number } }) => {
    const paid = o.paid ?? 2500;
    const charge = paid > 0 ? `ch_${RUN}_${++n}` : null;
    if (charge)
      charges.set(charge, { id: charge, refunded: false, amount_refunded: 0, disputed: false, payment_method_details: { type: "card", card: { fingerprint: o.card ?? `fp_${customer}` } } });
    const l = o.line ?? { amount: 2500, quantity: 1 };
    const inv: Invoice = {
      id: `in_${RUN}_${++n}`,
      customer,
      status: "paid",
      amount_paid: paid,
      currency: "eur",
      billing_reason: o.reason,
      created: o.at,
      status_transitions: { paid_at: o.at },
      charge,
      lines: { data: [{ amount: l.amount, quantity: l.quantity, discount_amounts: l.off ? [{ amount: l.off }] : [] }] },
    };
    invoices.set(customer, [inv, ...(invoices.get(customer) ?? [])]);
    await hook("invoice.paid", { id: inv.id, customer });
    return inv;
  };
  const referralOf = async (who: Who) => (await ops().from("referrals").select("*").eq("referee_email", who.email).maybeSingle()).data;
  const rewardsOf = async (who: Who) => (await ops().from("referral_rewards").select("*").eq("referrer", who.id).order("id")).data ?? [];
  const credits = (customer: string) => (balance.get(customer) ?? []).filter((t) => t.description === CREDIT_DESCRIPTION);
  const mine = async (who: Who) => ((await who.db.rpc("my_referrals")).data as Record<string, unknown>[])[0]!;
  /** A designer who can refer (signed in with Figma, as designers do). */
  const designer = async (name: string) => {
    const who = await person(name);
    await ops().from("profiles").update({ figma_user_id: `fig_${RUN}_${++n}` }).eq("id", who.id);
    return who;
  };
  const codeOf = async (who: Who) => (await mine(who)).code as string;
  const now = () => Math.floor(Date.now() / 1000);

  it("by link: the referee's second month after their first invoice, the referrer's month after their second (banked, then applied on subscribing)", async () => {
    const referrer = await designer("ref");
    const code = await codeOf(referrer);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(await codeOf(referrer)).toBe(code); // one per person
    const referee = await person("new");
    expect((await referee.db.rpc("claim_referral", { p_code: "NOTACODE" })).data).toBe("invalid");
    expect((await referee.db.rpc("claim_referral", { p_code: code.toLowerCase() })).data).toBe("bound");
    // First referrer wins: another code later changes nothing; nor one's own code.
    const other = await designer("other");
    expect((await referee.db.rpc("claim_referral", { p_code: await codeOf(other) })).data).toBe("already");
    expect((await referrer.db.rpc("claim_referral", { p_code: code })).data).toBe("own");
    expect(await referralOf(referee)).toMatchObject({ referrer: referrer.id, via: "link", status: "pending" });
    expect((await mine(referee)).referred).toBe("pending");
    // Clients never touch the tables or the internal functions.
    expect((await referee.db.from("referrals").select("*")).data ?? []).toEqual([]);
    expect((await referee.db.rpc("referral_earn", { p_referral: 1, p_cents: 1, p_currency: "eur" })).error).not.toBeNull();
    expect((await referee.db.rpc("bind_referral", { p_referee: referee.id, p_referrer: other.id, p_via: "link" })).error).not.toBeNull();

    // The referee pays for their own seat: first invoice paid (the launch price: €15 a seat).
    expect((await referee.db.rpc("add_seat", { p_email: referee.email })).data).toBe("added");
    const cus = await subscribe(referee);
    const t0 = now();
    const first = await pay(cus, { reason: "subscription_create", at: t0, paid: 1500, line: { amount: 2500, quantity: 1, off: 1000 } });
    expect(await referralOf(referee)).toMatchObject({ status: "first_paid", first_invoice: first.id, seat_cents: 1500, payer: referee.id });
    expect(credits(cus).map((t) => [t.amount, t.currency])).toEqual([[-1500, "eur"]]);
    expect(await rewardsOf(referrer)).toEqual([]);
    // Webhook retried (twice at once, then again): still one credit.
    await Promise.all([hook("invoice.paid", { id: first.id }), hook("invoice.paid", { id: first.id })]);
    await hook("invoice.paid", { id: first.id });
    expect(credits(cus)).toHaveLength(1);
    // A renewal sooner than a month (not the second month) doesn't qualify.
    await pay(cus, { reason: "subscription_cycle", at: t0 + 3 * DAY });
    expect((await referralOf(referee))!.status).toBe("first_paid");

    // The second month, covered by the credit (nothing charged): the referrer's month is earned, banked (they
    // don't pay yet), and they hear about it.
    const second = await pay(cus, { reason: "subscription_cycle", at: t0 + 31 * DAY, paid: 0 });
    await hook("invoice.paid", { id: second.id });
    expect((await referralOf(referee))!.status).toBe("rewarded");
    expect((await rewardsOf(referrer)).map((w) => [w.status, w.cents])).toEqual([["banked", 2500]]);
    expect(mails.filter((m) => m.to.includes(referrer.email) && m.subject === "You earned a free month on CoDesignFlo")).toHaveLength(1);
    expect(await mine(referrer)).toMatchObject({ joined: 1, waiting: 0, earned: 1, banked: 1, applied: 0 });

    // The referrer subscribes: the banked month goes onto their Stripe customer.
    const rcus = `cus_${RUN}_${++n}`;
    await ops().from("billing_accounts").upsert({ user_id: referrer.id, stripe_customer_id: rcus }, { onConflict: "user_id" });
    const sub = { id: `sub_${rcus}`, customer: rcus, status: "active", metadata: { user_id: referrer.id }, items: { data: [{ id: "si", quantity: 1 }] } };
    subs.set(rcus, [sub]);
    await hook("customer.subscription.updated", sub);
    expect(credits(rcus).map((t) => t.amount)).toEqual([-2500]);
    expect((await rewardsOf(referrer)).map((w) => w.status)).toEqual(["applied"]);
    await hook("customer.subscription.updated", sub);
    await referralTick({ secretKey: "sk_test_x", api: `http://localhost:${STRIPE_PORT}` }, ops());
    expect(credits(rcus)).toHaveLength(1);
    expect(credits(cus)).toHaveLength(1);
    // Every POST to Stripe's balance went with an idempotency key.
    expect(posts.every((p) => p.key?.startsWith("cdf-referral-"))).toBe(true);
  });

  it("by invitation: a designer inviting a new designer (a developer's invitations don't count); paid by a team lead", async () => {
    const referrer = await designer("inviter");
    const project = (await referrer.db.rpc("create_project", { p_name: "Shop", p_root_commit: `root_ref_${RUN}` })).data as string;
    const email = `invited-${RUN}@example.test`;
    expect((await referrer.db.rpc("invite", { p_project: project, p_email: email, p_role: "designer" })).data).toBe("invited");
    const { data: note } = await ops().from("notifications").select("body").eq("project_id", project).eq("kind", "invited").single();
    expect(note!.body).toMatchObject({ email, role: "designer", referral: true });
    // A developer in the project inviting another designer: no referral.
    const dev = await person("dev");
    await referrer.db.rpc("invite", { p_project: project, p_email: dev.email, p_role: "developer" });
    await dev.db.rpc("accept_invitations");
    const email2 = `invited2-${RUN}@example.test`;
    expect((await dev.db.rpc("invite", { p_project: project, p_email: email2, p_role: "designer" })).data).toBe("invited");
    expect((await ops().from("referral_invites").select("referrer").eq("email", email2)).data).toEqual([]);
    // Inviting as a developer: no referral either.
    const email3 = `invited3-${RUN}@example.test`;
    await referrer.db.rpc("invite", { p_project: project, p_email: email3, p_role: "developer" });
    expect((await ops().from("referral_invites").select("referrer").eq("email", email3)).data).toEqual([]);

    // The invited designer signs up: the referral is theirs from the start.
    const referee = await signUp(email);
    expect(await referralOf(referee)).toMatchObject({ referrer: referrer.id, via: "invite", project_id: project, status: "pending" });
    expect(await referralOf(await signUp(email2))).toBeNull();

    // A team lead (subscribed, other card) pays the seat: the credit is theirs; the referrer (subscribed) gets the month at once.
    const lead = await person("lead");
    const lcus = await subscribe(lead);
    expect((await lead.db.rpc("add_seat", { p_email: email })).data).toBe("added");
    const rcus = await subscribe(referrer);
    const t0 = now();
    await pay(lcus, { reason: "subscription_cycle", at: t0, paid: 5000, line: { amount: 5000, quantity: 2 } });
    expect(credits(lcus).map((t) => t.amount)).toEqual([-2500]);
    await pay(lcus, { reason: "subscription_cycle", at: t0 + 30 * DAY, paid: 2500, line: { amount: 5000, quantity: 2 } });
    expect((await referralOf(referee))!.status).toBe("rewarded");
    expect((await rewardsOf(referrer)).map((w) => w.status)).toEqual(["applied"]);
    expect(credits(rcus).map((t) => t.amount)).toEqual([-2500]);
    const mail = mails.find((m) => m.to.includes(referrer.email) && m.subject === "You earned a free month on CoDesignFlo");
    expect(mail?.text).toContain("Stripe takes it off your next invoice");
  });

  it("self-referral: the referrer paying the seat, or the same card, gets nothing for either", async () => {
    // The referrer pays the referee's seat.
    const a = await designer("selfpay");
    const a1 = await person("selfpay-new");
    expect((await a1.db.rpc("claim_referral", { p_code: await codeOf(a) })).data).toBe("bound");
    expect((await a.db.rpc("add_seat", { p_email: a1.email })).data).toBe("added");
    const acus = await subscribe(a);
    await pay(acus, { reason: "subscription_create", at: now() });
    expect(await referralOf(a1)).toMatchObject({ status: "void", void_reason: "the referrer pays this seat" });
    expect(credits(acus)).toEqual([]);

    // The referee pays with the referrer's card (saved on the referrer's Stripe customer).
    const b = await designer("samecard");
    const bcus = await subscribe(b);
    cards.set(bcus, [`fp_card_${RUN}`]);
    const b1 = await person("samecard-new");
    expect((await b1.db.rpc("claim_referral", { p_code: await codeOf(b) })).data).toBe("bound");
    await b1.db.rpc("add_seat", { p_email: b1.email });
    const b1cus = await subscribe(b1);
    await pay(b1cus, { reason: "subscription_create", at: now(), card: `fp_card_${RUN}` });
    expect(await referralOf(b1)).toMatchObject({ status: "void", void_reason: "paid with the referrer's card" });
    expect(credits(b1cus)).toEqual([]);
    // Fingerprints are kept, never card details.
    const { data: fps } = await ops().from("payment_fingerprints").select("*").eq("customer", b1cus);
    expect(fps).toEqual([expect.objectContaining({ customer: b1cus, fingerprint: `fp_card_${RUN}` })]);
  });

  it("a refund before the referrer's month voids it (the referee's credit stays); a dispute too", async () => {
    const r = await designer("refund");
    const e = await person("refund-new");
    await e.db.rpc("claim_referral", { p_code: await codeOf(r) });
    await e.db.rpc("add_seat", { p_email: e.email });
    const cus = await subscribe(e);
    const t0 = now();
    const first = await pay(cus, { reason: "subscription_create", at: t0 });
    expect(credits(cus)).toHaveLength(1);
    const ch = charges.get(first.charge as string)!;
    // A refund event Stripe doesn't back (the charge isn't refunded) changes nothing.
    await hook("charge.refunded", { id: ch.id });
    expect((await referralOf(e))!.status).toBe("first_paid");
    ch.refunded = true;
    ch.amount_refunded = 2500;
    await hook("charge.refunded", { id: ch.id });
    expect(await referralOf(e)).toMatchObject({ status: "void", void_reason: "refunded" });
    await pay(cus, { reason: "subscription_cycle", at: t0 + 31 * DAY });
    expect(await rewardsOf(r)).toEqual([]);
    expect(credits(cus)).toHaveLength(1);

    // A dispute on the second invoice's charge, arriving before the invoice event: void when the invoice comes.
    const r2 = await designer("dispute");
    const e2 = await person("dispute-new");
    await e2.db.rpc("claim_referral", { p_code: await codeOf(r2) });
    await e2.db.rpc("add_seat", { p_email: e2.email });
    const cus2 = await subscribe(e2);
    await pay(cus2, { reason: "subscription_create", at: t0 });
    const charge2 = `ch_${RUN}_disputed`;
    charges.set(charge2, { id: charge2, refunded: false, amount_refunded: 0, disputed: true, payment_method_details: { type: "card", card: { fingerprint: "fp_x" } } });
    const inv: Invoice = { id: `in_${RUN}_disputed`, customer: cus2, status: "paid", amount_paid: 2500, currency: "eur", billing_reason: "subscription_cycle", created: t0 + 31 * DAY, charge: charge2, lines: { data: [{ amount: 2500, quantity: 1 }] } };
    invoices.set(cus2, [inv, ...(invoices.get(cus2) ?? [])]);
    await hook("charge.dispute.created", { id: "dp_1", charge: charge2 });
    await hook("invoice.paid", { id: inv.id });
    expect(await referralOf(e2)).toMatchObject({ status: "void", void_reason: "refunded or disputed" });
    expect(await rewardsOf(r2)).toEqual([]);
  });

  it("at most 12 free months a rolling year", async () => {
    const r = await designer("cap");
    const rows = Array.from({ length: 12 }, (_, i) => ({ referrer: r.id, cents: 2500, currency: "eur", earned_at: new Date(Date.now() - (i + 1) * 20 * DAY * 1000).toISOString(), expires_at: new Date(Date.now() + DAY * 1000).toISOString(), status: "applied" }));
    // One of them from more than a year ago doesn't count: 11 in the year, so one more is still earned.
    rows[0]!.earned_at = new Date(Date.now() - 400 * DAY * 1000).toISOString();
    expect((await ops().from("referral_rewards").insert(rows)).error).toBeNull();
    const pass = async (name: string) => {
      const e = await person(name);
      await e.db.rpc("claim_referral", { p_code: await codeOf(r) });
      await e.db.rpc("add_seat", { p_email: e.email });
      const cus = await subscribe(e);
      const t0 = now();
      await pay(cus, { reason: "subscription_create", at: t0 });
      await pay(cus, { reason: "subscription_cycle", at: t0 + 31 * DAY });
      return e;
    };
    expect((await referralOf(await pass("cap-12")))!.status).toBe("rewarded");
    expect((await referralOf(await pass("cap-13")))!.status).toBe("capped");
    expect((await mine(r)).earned_year).toBe(12);
  });

  it("banked months expire after 12 months; the cron applies the others", async () => {
    const r = await designer("expiry");
    const past = new Date(Date.now() - DAY * 1000).toISOString();
    const later = new Date(Date.now() + 100 * DAY * 1000).toISOString();
    const added = await ops().from("referral_rewards").insert([
      { referrer: r.id, cents: 2500, currency: "eur", earned_at: new Date(Date.now() - 366 * DAY * 1000).toISOString(), expires_at: past, status: "banked", notified_at: past },
      { referrer: r.id, cents: 2500, currency: "eur", earned_at: new Date().toISOString(), expires_at: later, status: "banked", notified_at: past },
    ]);
    expect(added.error).toBeNull();
    expect(await mine(r)).toMatchObject({ banked: 1, expired: 1 });
    const cus = await subscribe(r);
    await referralTick({ secretKey: "sk_test_x", api: `http://localhost:${STRIPE_PORT}` }, ops());
    expect((await rewardsOf(r)).map((w) => w.status)).toEqual(["expired", "applied"]);
    expect(credits(cus).map((t) => t.amount)).toEqual([-2500]);
  });

  it("only brand-new accounts: not an existing account, nor one that paid before; never the free list or the demo", async () => {
    const r = await designer("strict");
    const code = await codeOf(r);
    // An account from before the link (more than a day old).
    const old = await person("old");
    if (env.db) {
      execSync(`psql "${env.db}" -q -c "update auth.users set created_at = now() - interval '3 days' where id = '${old.id}'"`, { stdio: "ignore" });
      expect((await old.db.rpc("claim_referral", { p_code: code })).data).toBe("not_new");
    }
    // An email that had a paid seat before (its account deleted, made again): not new.
    const paid = await person("paidbefore");
    await ops().from("billing_history").insert({ email: paid.email, what: "seat", ref: "in_old" });
    expect((await paid.db.rpc("claim_referral", { p_code: code })).data).toBe("not_new");
    // A Figma account that paid before, under another email.
    const fig = `fig_paid_${RUN}`;
    await ops().from("billing_history").insert({ figma_user_id: fig, what: "payer", ref: "in_old2" });
    const again = await person("figagain");
    await ops().from("profiles").update({ figma_user_id: fig }).eq("id", again.id);
    expect((await again.db.rpc("claim_referral", { p_code: code })).data).toBe("not_new");
    // The demo's accounts never count.
    const demo = await signUp(`demo-${RUN}@demo.codesignflo.com`);
    expect((await demo.db.rpc("claim_referral", { p_code: code })).data).toBe("not_eligible");
    // A free-listed referee never qualifies.
    const free = await person("free");
    expect((await free.db.rpc("claim_referral", { p_code: code })).data).toBe("bound");
    await ops().from("billing_whitelist").insert({ email: free.email });
    await ops().from("designer_seats").insert({ email: free.email, payer: free.id });
    const cus = await subscribe(free);
    await pay(cus, { reason: "subscription_create", at: now() });
    expect(await referralOf(free)).toMatchObject({ status: "void", void_reason: "free list" });
    expect(credits(cus)).toEqual([]);
    await ops().from("billing_whitelist").delete().eq("email", free.email);
    // A referrer who's a developer only (no design side) can't refer by link.
    const dev = await person("devref");
    const e = await person("devref-new");
    expect((await e.db.rpc("claim_referral", { p_code: await codeOf(dev) })).data).toBe("not_eligible");
  });
});
