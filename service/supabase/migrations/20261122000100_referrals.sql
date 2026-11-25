-- Referrals: a designer brings another designer. When the invited designer pays for their seat, their second
-- month is free (a Stripe balance credit right after their first paid invoice, for whoever pays their seat), and
-- after their second paid invoice the designer who brought them gets a month free (at most 12 a rolling year;
-- banked while they don't subscribe, for 12 months). Two ways in: a project invitation from a designer to someone
-- with no account yet (invite()), or the designer's personal link (codesignflo.com/?ref=CODE, bound at the new
-- account's first sign-in). Only brand-new accounts that never had a paid seat or a subscription; first referrer
-- wins; never the referrer's own payment (same person, same Stripe customer, same card); a refund or a dispute
-- before the reward voids it. The service (mcp/referrals.ts) does the Stripe side, from the webhook and the cron.
-- Replaced in place; safe to run again. New functions are closed by default (20261122000000_security): the ones
-- clients call are granted at the end.

-- ── Tables (service only; clients read through my_referrals) ────────────────────────────────────────────────

-- One code per person, random (8 characters, no look-alikes), made the first time they look at it.
create table if not exists public.referral_codes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  created_at timestamptz not null default now()
);

-- A designer invited someone with no account yet as a designer: bound when that email's account is made. The
-- first inviter wins (one row per email).
create table if not exists public.referral_invites (
  email text primary key check (email = lower(email)),
  referrer uuid not null references auth.users (id) on delete cascade,
  project_id text,
  at timestamptz not null default now()
);

-- Who has paid before: emails and Figma accounts covered by a paid invoice (their own subscription or a seat
-- someone paid), kept when the account or the seat goes. A referral is only for people who aren't in it.
create table if not exists public.billing_history (
  email text,
  figma_user_id text,
  what text not null,
  ref text,
  at timestamptz not null default now()
);
create index if not exists billing_history_email on public.billing_history (email);
create index if not exists billing_history_figma on public.billing_history (figma_user_id) where figma_user_id is not null;
create unique index if not exists billing_history_once on public.billing_history (coalesce(email, ''), coalesce(figma_user_id, ''), what, coalesce(ref, ''));

-- A referral: one per invited designer (by account and by email, also after the account is deleted).
--   pending     bound; the referee hasn't paid yet
--   first_paid  their first paid invoice: their second month is credited (referee_credit_txn)
--   qualified   their second paid invoice: the referrer's month is due
--   rewarded    the referrer's month is in referral_rewards
--   capped      due, but the referrer had 12 free months in the last year already
--   void        not counted (void_reason): self-referral, refund, dispute, free list…
create table if not exists public.referrals (
  id bigint generated always as identity primary key,
  referrer uuid references auth.users (id) on delete set null,
  referee uuid unique references auth.users (id) on delete set null,
  referee_email text not null unique check (referee_email = lower(referee_email)),
  via text not null check (via in ('invite', 'link')),
  project_id text,
  bound_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'first_paid', 'qualified', 'rewarded', 'capped', 'void')),
  void_reason text,
  payer uuid references auth.users (id) on delete set null,
  payer_customer text,
  seat_cents int,
  currency text,
  first_invoice text,
  first_charge text,
  first_paid_at timestamptz,
  referee_credit_txn text unique,
  referee_credit_cents int,
  second_invoice text,
  second_charge text,
  second_paid_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists referrals_by_referrer on public.referrals (referrer);
create index if not exists referrals_by_charge on public.referrals (first_charge);
create index if not exists referrals_by_charge2 on public.referrals (second_charge);

-- A referrer's free months: banked until applied to their Stripe customer (a balance credit, txn), expired
-- 12 months after being earned if they never subscribed.
create table if not exists public.referral_rewards (
  id bigint generated always as identity primary key,
  referral_id bigint unique references public.referrals (id) on delete set null,
  referrer uuid not null references auth.users (id) on delete cascade,
  cents int not null check (cents > 0),
  currency text not null,
  earned_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'banked' check (status in ('banked', 'applied', 'expired', 'void')),
  customer text,
  txn text unique,
  applied_at timestamptz,
  notified_at timestamptz
);
create index if not exists referral_rewards_by_referrer on public.referral_rewards (referrer, earned_at);

-- Card fingerprints seen on each Stripe customer's paid invoices (never card details): the same card on the
-- referrer's and the referee's side is a self-referral.
create table if not exists public.payment_fingerprints (
  customer text not null,
  fingerprint text not null,
  user_id uuid references auth.users (id) on delete set null,
  at timestamptz not null default now(),
  primary key (customer, fingerprint)
);
create index if not exists payment_fingerprints_fp on public.payment_fingerprints (fingerprint);

do $$
declare t text;
begin
  foreach t in array array['referral_codes', 'referral_invites', 'billing_history', 'referrals', 'referral_rewards', 'payment_fingerprints'] loop
    execute format('alter table public.%I enable row level security', t);  -- no policies: definer functions and the service
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Who already paid, from before this migration: payers with a Stripe customer, and seats paid by a subscriber.
insert into public.billing_history (email, figma_user_id, what)
select lower(u.email), pr.figma_user_id, 'subscription' from public.billing_accounts a
join auth.users u on u.id = a.user_id left join public.profiles pr on pr.id = a.user_id
where a.stripe_customer_id is not null or a.stripe_subscription_id is not null
on conflict do nothing;
insert into public.billing_history (email, figma_user_id, what)
select s.email, pr.figma_user_id, 'seat' from public.designer_seats s
join public.billing_accounts a on a.user_id = s.payer and a.stripe_subscription_id is not null
left join auth.users u on lower(u.email) = s.email left join public.profiles pr on pr.id = u.id
on conflict do nothing;

-- A subscription recorded: the payer has had one (kept for good, whatever happens to the account).
create or replace function public.billing_history_subscribed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stripe_subscription_id is not null and (tg_op = 'INSERT' or old.stripe_subscription_id is null) then
    insert into billing_history (email, figma_user_id, what, ref)
    select lower(u.email), pr.figma_user_id, 'subscription', new.stripe_subscription_id
    from auth.users u left join profiles pr on pr.id = u.id where u.id = new.user_id
    on conflict do nothing;
  end if;
  return null;
end;
$$;
drop trigger if exists billing_history on public.billing_accounts;
create trigger billing_history after insert or update of stripe_subscription_id on public.billing_accounts
for each row execute function public.billing_history_subscribed();

-- ── Binding a referral ──────────────────────────────────────────────────────────────────────────────────────

-- Works on the design side: a designer somewhere, signed in with Figma, or holding or paying a seat.
create or replace function public.designs_side(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from project_members where user_id = p_user and role = 'designer')
      or exists (select 1 from profiles where id = p_user and figma_user_id is not null)
      or exists (select 1 from designer_seats s where s.payer = p_user
                 or s.email = (select lower(email) from auth.users where id = p_user));
$$;

-- Records a referral when it may count: 'bound', or why not ('already', 'own', 'not_new', 'not_eligible').
-- p_new_within: how recently the account must have been made (a link, bound at its first sign-in).
create or replace function public.bind_referral(p_referee uuid, p_referrer uuid, p_via text, p_project text default null,
                                                p_new_within interval default null) returns text
language plpgsql security definer set search_path = public as $$
declare
  ee text;
  re text;
  fig text;
  made timestamptz;
begin
  if p_referee is null or p_referrer is null then return 'not_eligible'; end if;
  if p_referee = p_referrer then return 'own'; end if;
  select lower(u.email), u.created_at, pr.figma_user_id into ee, made, fig
  from auth.users u left join profiles pr on pr.id = u.id where u.id = p_referee;
  select lower(email) into re from auth.users where id = p_referrer;
  if ee is null or re is null then return 'not_eligible'; end if;
  if ee = re then return 'own'; end if;
  if exists (select 1 from referrals where referee = p_referee or referee_email = ee) then return 'already'; end if;
  -- The demo's simulated developer and its kind never count.
  if ee like '%@demo.codesignflo.com' or re like '%@demo.codesignflo.com' then return 'not_eligible'; end if;
  if not public.designs_side(p_referrer) then return 'not_eligible'; end if;
  -- Brand new: made just now (a link) and never paid, as this email, this Figma account or this account.
  if p_new_within is not null and made < now() - p_new_within then return 'not_new'; end if;
  if exists (select 1 from billing_history where email = ee or (fig is not null and figma_user_id = fig))
     or exists (select 1 from billing_accounts where user_id = p_referee and (stripe_customer_id is not null or stripe_subscription_id is not null))
     or exists (select 1 from designer_seats s join billing_accounts a on a.user_id = s.payer and a.stripe_subscription_id is not null where s.email = ee) then
    return 'not_new';
  end if;
  insert into referrals (referrer, referee, referee_email, via, project_id) values (p_referrer, p_referee, ee, p_via, p_project)
  on conflict do nothing;
  if not found then return 'already'; end if;
  return 'bound';
end;
$$;

-- A new account: its profile, then the referral of whoever invited it as a designer first. A referral never
-- stops a sign-up.
create or replace function public.on_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  inv referral_invites;
begin
  insert into profiles (id, email, figma_user_id, github_user_id)
  values (
    new.id,
    new.email,
    case when new.raw_app_meta_data ->> 'provider' = 'figma' then new.raw_user_meta_data ->> 'provider_id' end,
    case when new.raw_app_meta_data ->> 'provider' = 'github' then new.raw_user_meta_data ->> 'provider_id' end
  )
  on conflict (id) do update set email = excluded.email;
  begin
    select * into inv from referral_invites where email = lower(new.email);
    if inv.email is not null then perform public.bind_referral(new.id, inv.referrer, 'invite', inv.project_id); end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;

-- A person's code, made the first time.
create or replace function public.referral_code(p_user uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  c text;
begin
  select code into c from referral_codes where user_id = p_user;
  if c is not null then return c; end if;
  loop
    c := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 32), 1), '')
          from (select extensions.gen_random_bytes(8) b) r, generate_series(0, 7) i);
    insert into referral_codes (user_id, code) values (p_user, c) on conflict do nothing;
    if found then return c; end if;
    select code into c from referral_codes where user_id = p_user;  -- made meanwhile
    if c is not null then return c; end if;
  end loop;
end;
$$;

-- The web app, right after signing in with a referral link's code kept in the browser: only a brand-new
-- account (made in the last day, never paid), only once, never one's own code. What happened, as a word.
create or replace function public.claim_referral(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  c text := upper(btrim(coalesce(p_code, '')));
  referrer uuid;
begin
  if uid is null then raise exception 'sign in first'; end if;
  if c !~ '^[A-HJ-NP-Z2-9]{8}$' then return 'invalid'; end if;
  if (select count(*) from rate_log where user_id = uid and what = 'referral' and at > now() - interval '1 hour') >= 10 then
    return 'invalid';
  end if;
  insert into rate_log (user_id, what) values (uid, 'referral');
  select user_id into referrer from referral_codes where code = c;
  if referrer is null then return 'invalid'; end if;
  return public.bind_referral(uid, referrer, 'link', null, interval '1 day');
end;
$$;

-- For Billing: my link's code, and how my referrals stand.
create or replace function public.my_referrals()
returns table (code text, joined int, waiting int, earned int, applied int, banked int, expired int, earned_year int,
               next_expiry timestamptz, referred text)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'sign in first'; end if;
  update referral_rewards set status = 'expired' where referrer = uid and status = 'banked' and expires_at < now();
  return query select
    public.referral_code(uid),
    (select count(*)::int from referrals r where r.referrer = uid and r.status <> 'void'),
    (select count(*)::int from referrals r where r.referrer = uid and r.status in ('pending', 'first_paid', 'qualified')),
    (select count(*)::int from referral_rewards w where w.referrer = uid and w.status <> 'void'),
    (select count(*)::int from referral_rewards w where w.referrer = uid and w.status = 'applied'),
    (select count(*)::int from referral_rewards w where w.referrer = uid and w.status = 'banked'),
    (select count(*)::int from referral_rewards w where w.referrer = uid and w.status = 'expired'),
    (select count(*)::int from referral_rewards w where w.referrer = uid and w.status <> 'void' and w.earned_at > now() - interval '1 year'),
    (select min(w.expires_at) from referral_rewards w where w.referrer = uid and w.status = 'banked'),
    (select r.status from referrals r where r.referee = uid);
end;
$$;

-- ── Invitations ─────────────────────────────────────────────────────────────────────────────────────────────

-- As in 20261122000000_security, and: a designer (or an admin on the design side) inviting someone with no
-- account yet as a designer records the referral for when that account is made.
create or replace function public.invite(p_project text, p_email text, p_role text default 'developer', p_email_them boolean default true) returns text
language plpgsql security definer set search_path = public as $$
declare
  existing uuid;
  current_role_ text;
  mine text;
  e text := lower(trim(p_email));
  result text := 'invited';
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if public.is_demo(p_project) then raise exception 'the demo project is just for you and Alex — start a project of your own to invite people' using errcode = '42501'; end if;
  if p_role not in ('developer', 'designer', 'admin') then raise exception 'role must be developer, designer or admin'; end if;
  if p_role = 'admin' and not public.is_member(p_project, array['admin']) then raise exception 'only admins can invite admins'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that is not an email address'; end if;
  select id into existing from auth.users where lower(email) = e;
  if existing is not null then
    select role into current_role_ from project_members where project_id = p_project and user_id = existing;
  end if;
  -- Already in the project: an admin changes their role; anyone else leaves it as it is.
  if current_role_ is not null then
    if current_role_ = p_role or not public.is_member(p_project, array['admin']) then return 'member'; end if;
    if current_role_ = 'admin' and exists (select 1 from projects where id = p_project and owner = existing) then
      raise exception 'the project''s owner stays an admin';
    end if;
    if current_role_ = 'admin' and (select count(*) from project_members where project_id = p_project and role = 'admin') = 1 then
      raise exception 'that''s the project''s last admin — make someone else an admin first';
    end if;
    update project_members set role = p_role where project_id = p_project and user_id = existing;
    update invitations set role = p_role where project_id = p_project and email = e;
    return 'role_changed';
  end if;
  insert into invitations (project_id, email, role, invited_by) values (p_project, e, p_role, auth.uid())
  on conflict (project_id, email) do update set role = excluded.role, invited_by = excluded.invited_by;
  if existing is not null then
    insert into project_members (project_id, user_id, role) values (p_project, existing, p_role) on conflict do nothing;
    update invitations set accepted_at = now() where project_id = p_project and email = e;
    result := 'added';
  elsif p_role = 'designer' then
    -- A referral: designer to designer (a developer's invitations never are).
    select role into mine from project_members where project_id = p_project and user_id = auth.uid();
    if (mine = 'designer' or (mine = 'admin' and public.designs_side(auth.uid())))
       and e <> lower((select email from auth.users where id = auth.uid()))
       and e not like '%@demo.codesignflo.com' then
      insert into referral_invites (email, referrer, project_id) values (e, auth.uid(), p_project) on conflict do nothing;
    end if;
  end if;
  -- Inviting the same person again within the email limit still records the invitation; only the email waits.
  if p_email_them and not exists (select 1 from invitations where project_id = p_project and email = e and last_sent_at > now() - interval '2 minutes') then
    perform public.queue_invitation_email(p_project, e);
  end if;
  return result;
end;
$$;

-- As in 20261122000000_security, and: the email says the second month is free when it's a referral.
create or replace function public.queue_invitation_email(p_project text, p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare
  inv invitations;
  inviter text := coalesce((select email from profiles where id = auth.uid()), 'Someone');
begin
  select * into inv from invitations where project_id = p_project and email = p_email;
  if inv.email is null then raise exception 'no invitation for % in this project', p_email; end if;
  if inv.last_sent_at > now() - interval '2 minutes' then
    raise exception 'an invitation email went to % a moment ago — wait a couple of minutes before sending it again', p_email;
  end if;
  if (select count(*) from notifications where project_id = p_project and kind = 'invited' and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many invitation emails from this project in the last hour — try again later';
  end if;
  if auth.uid() is not null then
    if (select count(*) from rate_log where user_id = auth.uid() and what = 'invite_email' and at > now() - interval '1 day') >= 50 then
      raise exception 'you''ve sent 50 invitation emails today — try again tomorrow' using errcode = 'P0429';
    end if;
    insert into rate_log (user_id, what) values (auth.uid(), 'invite_email');
  end if;
  -- One email waiting per invitation: sending again before the last one left doesn't send two.
  if not exists (select 1 from notifications where project_id = p_project and kind = 'invited' and sent_at is null and attempts < 5 and body ->> 'email' = inv.email) then
    insert into notifications (project_id, kind, component, by, body)
    values (p_project, 'invited', '', inviter, jsonb_build_object('email', inv.email, 'role', inv.role, 'added', inv.accepted_at is not null)
      || case when inv.accepted_at is null and inv.role = 'designer' and exists (select 1 from referral_invites r where r.email = inv.email)
              then jsonb_build_object('referral', true) else '{}'::jsonb end);
  end if;
  update invitations set last_sent_at = now(), email_status = 'queued', email_error = null
  where project_id = p_project and email = p_email;
  perform public.ping_notify();
end;
$$;

-- ── The referrer's month (the service calls it once the referee's second invoice is paid) ──────────────────

-- Atomic per referrer (12 a rolling year, counted with a lock): 'banked' with the reward's id, 'capped', or
-- 'done' when it was handled before (a webhook retried); 'not_qualified' otherwise.
create or replace function public.referral_earn(p_referral bigint, p_cents int, p_currency text)
returns table (result text, reward_id bigint)
language plpgsql security definer set search_path = public as $$
declare
  r referrals;
  rid bigint;
begin
  select * into r from referrals where id = p_referral for update;
  if r.id is null or r.referrer is null then return query select 'not_qualified'::text, null::bigint; return; end if;
  if r.status in ('rewarded', 'capped') then
    return query select 'done'::text, (select w.id from referral_rewards w where w.referral_id = r.id); return;
  end if;
  if r.status <> 'qualified' or coalesce(p_cents, 0) <= 0 then return query select 'not_qualified'::text, null::bigint; return; end if;
  perform pg_advisory_xact_lock(hashtext('referral_rewards:' || r.referrer::text));
  if (select count(*) from referral_rewards where referrer = r.referrer and status <> 'void' and earned_at > now() - interval '1 year') >= 12 then
    update referrals set status = 'capped', updated_at = now() where id = r.id;
    return query select 'capped'::text, null::bigint; return;
  end if;
  insert into referral_rewards (referral_id, referrer, cents, currency, expires_at)
  values (r.id, r.referrer, p_cents, lower(p_currency), now() + interval '12 months') returning id into rid;
  update referrals set status = 'rewarded', updated_at = now() where id = r.id;
  return query select 'banked'::text, rid;
end;
$$;

-- ── Who may call what ───────────────────────────────────────────────────────────────────────────────────────

revoke execute on function public.designs_side(uuid) from public, anon, authenticated;
revoke execute on function public.bind_referral(uuid, uuid, text, text, interval) from public, anon, authenticated;
revoke execute on function public.referral_code(uuid) from public, anon, authenticated;
revoke execute on function public.referral_earn(bigint, int, text) from public, anon, authenticated;
revoke execute on function public.billing_history_subscribed() from public, anon, authenticated;
grant execute on function public.designs_side(uuid) to service_role;
grant execute on function public.bind_referral(uuid, uuid, text, text, interval) to service_role;
grant execute on function public.referral_code(uuid) to service_role;
grant execute on function public.referral_earn(bigint, int, text) to service_role;
grant all on public.referral_codes, public.referral_invites, public.billing_history, public.referrals, public.referral_rewards,
  public.payment_fingerprints to service_role;

grant execute on function public.claim_referral(text) to authenticated;
grant execute on function public.my_referrals() to authenticated;
grant execute on function public.invite(text, text, text, boolean) to authenticated;

-- ── Paid invoices (the service, on invoice.paid) ────────────────────────────────────────────────────────────

-- A paid invoice: its payer and every seat it pays for (their emails and Figma accounts) have paid, for good.
create or replace function public.log_paid_invoice(p_payer uuid, p_invoice text) returns void
language sql security definer set search_path = public as $$
  insert into billing_history (email, figma_user_id, what, ref)
  select lower(u.email), pr.figma_user_id, 'payer', p_invoice from auth.users u left join profiles pr on pr.id = u.id where u.id = p_payer
  union all
  select s.email, (select pr.figma_user_id from profiles pr where lower(pr.email) = s.email and pr.figma_user_id is not null limit 1), 'seat', p_invoice
  from designer_seats s where s.payer = p_payer
  on conflict do nothing;
$$;
revoke execute on function public.log_paid_invoice(uuid, text) from public, anon, authenticated;
grant execute on function public.log_paid_invoice(uuid, text) to service_role;
