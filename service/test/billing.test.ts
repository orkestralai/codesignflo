// Billing: designer seats, 5 free sends to dev, held designs when they are used, the whitelist, Stripe Checkout, the webhook and
// seat sync — against the local Supabase stack and a fake Stripe. Skipped when the stack isn't running.
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { form, verifyWebhook } from "../mcp/billing.ts";
import { LAUNCH, launchOn } from "../web/src/pricing.ts";
import { listen } from "../mcp/server.ts";

const env = (() => {
  try {
    const out = execSync("supabase status -o env", { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const get = (k: string) => new RegExp(`^${k}="?([^"\\n]+)`, "m").exec(out)?.[1];
    return { url: get("API_URL"), anon: get("ANON_KEY"), service: get("SERVICE_ROLE_KEY") };
  } catch {
    return { url: undefined, anon: undefined, service: undefined };
  }
})();
const run = env.url && env.anon && env.service ? describe : describe.skip;
const PORT = 3392;
const STRIPE_PORT = 3394;
const BASE = `http://localhost:${PORT}`;
const SECRET = "test-notify-secret";
const WHSEC = "whsec_test";
// Stripe ids unique to this run (the local stack keeps earlier runs' accounts, and customer ids are unique).
const CUS = `cus_${Date.now().toString(36)}`;

async function person(name: string): Promise<{ db: SupabaseClient; token: string; email: string; id: string }> {
  const db = createClient(env.url!, env.anon!, { auth: { persistSession: false } });
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const { data, error } = await db.auth.signUp({ email, password: "test-password-123" });
  if (error) throw error;
  return { db, token: data.session!.access_token, email, id: data.user!.id };
}

const signed = (payload: unknown, secret = WHSEC) => {
  const raw = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  return { raw, sig: `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}` };
};

run("billing", { timeout: 60_000 }, () => {
  let srv: Server;
  let fake: Server;
  const calls: { method: string; path: string; body: string }[] = [];
  // The checkout session the fake Stripe hands back (back from Checkout): whose, and whether paid.
  // Emails the service sends (through a fake Resend on the same fake server).
  const mails: { to: string[]; subject: string; text: string }[] = [];
  // The customer's subscriptions in the fake Stripe (none, unless a test says).
  let stripeSubs: { id: string; customer: string; status: string; cancel_at_period_end?: boolean; items: { data: { id: string; quantity: number }[] } }[] = [];
  let paidSession: { client_reference_id: string; status: string } | null = null;
  const ops = () => createClient(env.url!, env.service!, { auth: { persistSession: false } });

  beforeAll(() => {
    // A fake Stripe: records each call, answers what the service needs.
    fake = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const path = (req.url ?? "").split("?")[0]!;
        calls.push({ method: req.method!, path, body: body || (req.url ?? "").split("?")[1] || "" });
        const send = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
        if (path === "/emails") {
          mails.push(JSON.parse(body) as { to: string[]; subject: string; text: string });
          return send({ id: "email_1" });
        }
        if (path === "/v1/customers") return send({ id: CUS });
        if (path === "/v1/prices" && req.method === "GET") return send({ data: [] });
        if (path === "/v1/prices") return send({ id: "price_1" });
        if (path === "/v1/coupons") return send({ id: LAUNCH.coupon });
        if (path === "/v1/checkout/sessions") return send({ url: "https://checkout.stripe.test/s/1" });
        if (path.startsWith("/v1/checkout/sessions/cs_") && paidSession)
          return send({
            ...paidSession,
            subscription: { id: "sub_c", customer: `cus_c_${paidSession.client_reference_id}`, status: "active", metadata: {}, items: { data: [{ id: "si_c", quantity: 1, current_period_end: 1900000000 }] } },
          });
        if (path === "/v1/billing_portal/sessions") return send({ url: "https://billing.stripe.test/p/1" });
        if (path === "/v1/subscriptions" && req.method === "GET") return send({ data: stripeSubs });
        if (path.startsWith("/v1/subscriptions/")) return send({ id: "sub_1", customer: CUS, status: "active", items: { data: [{ id: "si_1", quantity: 1 }] } });
        if (path.startsWith("/v1/subscription_items/")) return send({ id: "si_1" });
        res.writeHead(404).end("{}");
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
        notifySecret: SECRET,
        notify: { from: "CoDesignFlo by OrkestralAI <billing@example.test>", resendKey: "re_test", resendUrl: `http://localhost:${STRIPE_PORT}/emails` },
        billing: { secretKey: "sk_test_x", webhookSecret: WHSEC, api: `http://localhost:${STRIPE_PORT}` },
      },
      PORT,
    );
  });
  afterAll(() => {
    srv?.close();
    fake?.close();
  });

  it("Stripe's form encoding and webhook signatures", () => {
    expect(form({ line_items: [{ price: "p", quantity: 2 }], a: { b: "c d" } })).toBe("line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=2&a%5Bb%5D=c%20d");
    const ok = signed({ type: "x", data: { object: {} } });
    expect(verifyWebhook(ok.raw, ok.sig, WHSEC)?.type).toBe("x");
    expect(verifyWebhook(ok.raw, ok.sig, "whsec_other")).toBeNull();
    expect(verifyWebhook(`${ok.raw} `, ok.sig, WHSEC)).toBeNull();
    expect(verifyWebhook(ok.raw, ok.sig, WHSEC, Date.now() + 10 * 60_000)).toBeNull();
  });

  it("designer seats: 5 free sends, held designs without a seat, paying for others, checkout, webhook and seat sync", async () => {
    const lead = await person("lead");
    const designer = await person("designer");
    const second = await person("designer2");
    const dev = await person("dev");
    const project = (await lead.db.rpc("create_project", { p_name: "Shop", p_root_commit: `root_b_${Date.now()}` })).data as string;
    await lead.db.rpc("invite", { p_project: project, p_email: designer.email, p_role: "designer" });
    await lead.db.rpc("invite", { p_project: project, p_email: dev.email, p_role: "developer" });
    await designer.db.rpc("accept_invitations");
    await dev.db.rpc("accept_invitations");
    const stateOf = async (who: { db: SupabaseClient }) =>
      ((await who.db.rpc("project_billing", { p_project: project })).data as { state: string }[])[0]!.state;
    // A new account: its 5 free sends to dev ahead of it.
    expect(await stateOf(designer)).toBe("trial");
    const ev = (who: { db: SupabaseClient }, kind: string) =>
      who.db.from("events").insert({ project_id: project, id: `${kind}_${Date.now()}_${Math.random()}`, at: new Date().toISOString(), by: "Dana", component: "components.x", kind, body: { claim: "c", note: "n", readyHash: "h" } });
    const sends = async (who: { db: SupabaseClient }) => ((await who.db.rpc("my_sends")).data as { state: string; used: number; free: number }[])[0]!;

    // Every send to dev uses one, re-sends included: 4 Ready for dev and a new design use all 5; claiming doesn't
    // count.
    expect((await ev(designer, "claimed")).error).toBeNull();
    for (let i = 0; i < 4; i++) expect((await ev(designer, "ready")).error).toBeNull();
    expect(await sends(designer)).toEqual({ state: "trial", used: 4, free: 5 });
    expect((await ev(designer, "designed_new")).error).toBeNull();
    expect(await sends(designer)).toEqual({ state: "unpaid", used: 5, free: 5 });
    // Then sending designs is held (refused, so the plugin keeps them); the rest goes on.
    expect((await ev(designer, "ready")).error?.message).toMatch(/read-only for you: your 5 free sends to dev are used/);
    expect((await ev(designer, "claimed")).error).toBeNull();
    expect((await sends(designer)).used).toBe(5);
    // Live, previews and new projects are never refused; a developer never needs a seat.
    expect((await dev.db.from("live_updates").insert({ project_id: project, commit: "c1", payload: {} })).error).toBeNull();
    expect((await dev.db.rpc("create_project", { p_name: "Dev's", p_root_commit: `root_b2_${Date.now()}` })).error).toBeNull();
    expect((await ev(dev, "building")).error).toBeNull();

    // Whitelisted: never needs a seat.
    await ops().from("billing_whitelist").insert({ email: designer.email.toLowerCase() });
    expect(await stateOf(designer)).toBe("whitelisted");
    // Adding a seat doesn't tell others who's on the free list (it's never charged); the designer sees it.
    expect((await lead.db.rpc("add_seat", { p_email: designer.email })).data).toBe("added");
    expect((await designer.db.rpc("add_seat", { p_email: designer.email })).data).toBe("free");
    expect((await lead.db.rpc("remove_seat", { p_email: designer.email })).data).toBe(true);
    await ops().from("billing_whitelist").delete().eq("email", designer.email.toLowerCase());
    // Only CoDesignFlo's admins see everyone's billing.
    expect((await lead.db.rpc("admin_billing")).error?.message).toMatch(/admins only/);

    // Checkout needs seats to pay for.
    const checkout = () => fetch(`${BASE}/api/billing/checkout`, { method: "POST", headers: { authorization: `Bearer ${lead.token}` } });
    expect((await checkout()).status).toBe(400);
    // The lead pays for the designer's seat (and someone not signed up yet); nobody else can take it.
    expect((await lead.db.rpc("add_seat", { p_email: designer.email.toUpperCase() })).data).toBe("added");
    expect((await lead.db.rpc("add_seat", { p_email: designer.email })).data).toBe("yours");
    expect((await second.db.rpc("add_seat", { p_email: designer.email })).data).toBe("taken");
    expect((await lead.db.rpc("add_seat", { p_email: "not an email" })).error?.message).toMatch(/not an email/);
    const later = `later-${Date.now()}@example.test`;
    expect((await lead.db.rpc("add_seat", { p_email: later })).data).toBe("added");
    expect(((await lead.db.rpc("my_seats")).data as { email: string; signed_up: boolean }[]).map((r) => [r.email, r.signed_up])).toEqual([
      [designer.email.toLowerCase(), true],
      [later, false],
    ]);
    // Not paid yet: the seat doesn't count.
    expect(await stateOf(designer)).toBe("unpaid");

    // Checkout: a customer, the seat price (made on first use), a subscription for 2 seats.
    expect(await (await checkout()).json()).toEqual({ url: "https://checkout.stripe.test/s/1" });
    const session = calls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(decodeURIComponent(session.body)).toContain("line_items[0][price]=price_1");
    expect(decodeURIComponent(session.body)).toContain("line_items[0][quantity]=2");
    expect(decodeURIComponent(session.body)).toContain(`client_reference_id=${lead.id}`);
    expect(calls.some((c) => c.path === "/v1/prices" && c.method === "POST" && decodeURIComponent(c.body).includes("unit_amount=2500") && decodeURIComponent(c.body).includes("tax_behavior=inclusive"))).toBe(true);
    // VAT by Stripe Tax: billing address required, VAT IDs collected.
    expect(decodeURIComponent(session.body)).toContain("automatic_tax[enabled]=true");
    expect(decodeURIComponent(session.body)).toContain("tax_id_collection[enabled]=true");
    expect(decodeURIComponent(session.body)).toContain("billing_address_collection=required");
    // The launch offer: a 40%-off coupon (€15 instead of €25) for 6 months (made on first use) while it runs; promotion codes after.
    if (launchOn()) {
      expect(decodeURIComponent(session.body)).toContain(`discounts[0][coupon]=${LAUNCH.coupon}`);
      expect(decodeURIComponent(session.body)).not.toContain("allow_promotion_codes");
      const coupon = calls.find((c) => c.path === "/v1/coupons" && c.method === "POST")!;
      expect(decodeURIComponent(coupon.body)).toContain("percent_off=40");
      expect(decodeURIComponent(coupon.body)).toContain("duration_in_months=6");
    } else expect(decodeURIComponent(session.body)).toContain("allow_promotion_codes=true");
    expect((await fetch(`${BASE}/api/billing/checkout`, { method: "POST" })).status).toBe(401);

    // Stripe says it's active (signed): the designer has a seat, paid by the lead, in every project.
    const bad = await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body: "{}" });
    expect(bad.status).toBe(400);
    const sub = {
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer: CUS, status: "active", metadata: { user_id: lead.id }, items: { data: [{ id: "si_1", quantity: 2, current_period_end: 1900000000 }] } } },
    };
    const w = signed(sub);
    // The webhook reads the customer's subscriptions from Stripe (the fake has this one).
    stripeSubs = [sub.data.object];
    expect((await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": w.sig }, body: w.raw })).status).toBe(200);
    expect(await stateOf(designer)).toBe("active");
    expect((await ev(designer, "ready")).error).toBeNull();
    const theirs = ((await designer.db.rpc("my_billing")).data as { state: string; paid_by: string; seats: number }[])[0];
    expect(theirs).toMatchObject({ state: "active", paid_by: lead.email.toLowerCase(), seats: 0 });
    const mine = ((await lead.db.rpc("my_billing")).data as { seats: number; billed_seats: number; subscribed: boolean }[])[0];
    expect(mine).toMatchObject({ seats: 2, billed_seats: 2, subscribed: true });

    // Another seat: the subscription's quantity follows (when the service is pinged).
    expect((await lead.db.rpc("add_seat", { p_email: second.email })).data).toBe("added");
    await fetch(`${BASE}/api/notify`, { method: "POST", headers: { "x-codesignflo-secret": SECRET } });
    const upd = calls.find((c) => c.path === "/v1/subscription_items/si_1");
    expect(upd && decodeURIComponent(upd.body)).toContain("quantity=3");
    // Removing one: only the payer can.
    expect((await second.db.rpc("remove_seat", { p_email: second.email })).data).toBe(false);
    expect((await lead.db.rpc("remove_seat", { p_email: later })).data).toBe(true);

    // The portal, for the subscribed payer.
    const p = await fetch(`${BASE}/api/billing/portal`, { method: "POST", headers: { authorization: `Bearer ${lead.token}` } });
    expect(await p.json()).toEqual({ url: "https://billing.stripe.test/p/1" });

    // Cancelled: the designer's seat stops (their free sends are used).
    const del = signed({ ...sub, type: "customer.subscription.deleted", data: { object: { ...sub.data.object, status: "canceled" } } });
    stripeSubs = [{ ...sub.data.object, status: "canceled" }];
    await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": del.sig }, body: del.raw });
    expect(await stateOf(designer)).toBe("unpaid");
    // An old event resent after it (still "active" in its payload) doesn't bring it back: Stripe says it ended.
    const late = signed(sub);
    await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": late.sig }, body: late.raw });
    expect(await stateOf(designer)).toBe("unpaid");
    stripeSubs = [];
  });

  it("back from Checkout, the page confirms the session: subscribed without the webhook, only for its own payer", async () => {
    const payer = await person("confirm-payer");
    const other = await person("confirm-other");
    const confirm = (who: { token: string }, session: string) =>
      fetch(`${BASE}/api/billing/confirm`, { method: "POST", headers: { authorization: `Bearer ${who.token}` }, body: JSON.stringify({ session }) });
    expect((await fetch(`${BASE}/api/billing/confirm`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await confirm(payer, "not-a-session")).status).toBe(400);
    paidSession = { client_reference_id: payer.id, status: "open" };
    expect(await (await confirm(payer, "cs_test_1")).json()).toEqual({ subscribed: false });
    paidSession = { client_reference_id: payer.id, status: "complete" };
    expect((await confirm(other, "cs_test_1")).status).toBe(403);
    expect(await (await confirm(payer, "cs_test_1")).json()).toEqual({ subscribed: true });
    const { data } = await ops().from("billing_accounts").select("stripe_subscription_id, status, seats").eq("user_id", payer.id).single();
    expect(data).toEqual({ stripe_subscription_id: "sub_c", status: "active", seats: 1 });
    expect((await ops().from("billing_accounts").select("user_id").eq("user_id", other.id)).data).toEqual([]);
    // Our own confirmation, once: confirming again, or the webhook after it, sends nothing more.
    const paid = () => mails.filter((m) => m.to.includes(payer.email) && m.subject === "Your CoDesignFlo subscription is active");
    expect(paid()).toHaveLength(1);
    expect(paid()[0]!.text).toContain("Designer seats: 1");
    expect(paid()[0]!.text).toContain("http://localhost:3317/#/billing");
    await confirm(payer, "cs_test_1");
    const object = { id: "sub_c", customer: `cus_c_${payer.id}`, status: "active", metadata: { user_id: payer.id }, items: { data: [{ id: "si_c", quantity: 1 }] } };
    const w = signed({ type: "customer.subscription.updated", data: { object } });
    stripeSubs = [object];
    expect((await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": w.sig }, body: w.raw })).status).toBe(200);
    expect(paid()).toHaveLength(1);
    paidSession = null;
  });

  it("no second subscription: one in Stripe that wasn't recorded (a missed webhook) is recorded instead", async () => {
    const payer = await person("dup-payer");
    expect((await payer.db.rpc("add_seat", { p_email: payer.email })).data).toBe("added");
    stripeSubs = [{ id: "sub_dup", customer: CUS, status: "active", items: { data: [{ id: "si_dup", quantity: 1 }] } }];
    await ops().from("billing_accounts").update({ stripe_customer_id: null }).eq("stripe_customer_id", CUS);
    const r = await fetch(`${BASE}/api/billing/checkout`, { method: "POST", headers: { authorization: `Bearer ${payer.token}` } });
    expect(r.status).toBe(409);
    const { data } = await ops().from("billing_accounts").select("stripe_subscription_id, status").eq("user_id", payer.id).single();
    expect(data).toEqual({ stripe_subscription_id: "sub_dup", status: "active" });

    // Cancelled in Manage billing, for the end of the period: back on Billing, read again, it ends then.
    stripeSubs = [{ ...stripeSubs[0]!, cancel_at_period_end: true, items: { data: [{ id: "si_dup", quantity: 1, current_period_end: 1900000000 } as { id: string; quantity: number }] } }];
    const back = await fetch(`${BASE}/api/billing/refresh`, { method: "POST", headers: { authorization: `Bearer ${payer.token}` } });
    expect(await back.json()).toEqual({ subscribed: true });
    const mine = await payer.db.from("billing_accounts").select("status, cancel_at").maybeSingle();
    expect(mine.data?.status).toBe("active");
    expect(new Date(mine.data!.cancel_at as string).getTime()).toBe(1900000000 * 1000);
    expect((await fetch(`${BASE}/api/billing/refresh`, { method: "POST" })).status).toBe(401);
    stripeSubs = [];
  });

  it("admins manage admins and the free list (codesignflo admin); a new admin is free", async () => {
    const boss = await person("boss");
    const other = await person("other");
    const later = `later-${Date.now()}@example.test`;
    // Not an admin: every call is refused.
    for (const [fn, p] of [
      ["admin_people", {}],
      ["admin_add", { p_email: other.email }],
      ["free_add", { p_email: later }],
    ] as const)
      expect((await boss.db.rpc(fn, p)).error?.message).toMatch(/admins only/);
    await ops().from("admins").insert({ user_id: boss.id });

    expect((await boss.db.rpc("admin_add", { p_email: other.email.toUpperCase() })).data).toBe("added");
    expect((await boss.db.rpc("admin_add", { p_email: other.email })).data).toBe("already");
    expect((await boss.db.rpc("admin_add", { p_email: later })).error?.message).toMatch(/sign in once first/);
    const rows = async () => (await boss.db.rpc("admin_people")).data as { email: string; admin: boolean; free: boolean; note: string | null }[];
    expect((await rows()).find((r) => r.email === other.email.toLowerCase())).toMatchObject({ admin: true, free: true });

    // The free list takes emails without an account.
    expect((await boss.db.rpc("free_add", { p_email: ` ${later.toUpperCase()} `, p_note: "beta" })).data).toBe("added");
    expect((await rows()).find((r) => r.email === later)).toMatchObject({ admin: false, free: true, note: "beta" });
    expect((await boss.db.rpc("free_add", { p_email: "nope" })).error?.message).toMatch(/not an email/);
    expect((await boss.db.rpc("free_remove", { p_email: later })).data).toBe("removed");
    expect((await boss.db.rpc("free_remove", { p_email: later })).data).toBe("not_free");

    // No longer an admin: still free, and no longer allowed.
    expect((await boss.db.rpc("admin_remove", { p_email: other.email })).data).toBe("removed");
    expect((await rows()).find((r) => r.email === other.email.toLowerCase())).toMatchObject({ admin: false, free: true });
    expect((await other.db.rpc("admin_people")).error?.message).toMatch(/admins only/);
    expect((await boss.db.rpc("admin_remove", { p_email: other.email })).data).toBe("not_admin");
    await ops().from("admins").delete().eq("user_id", boss.id);
  });
});
