-- When a cancelled subscription ends (cancelled at the end of the period, it stays active until then): Billing
-- says "ends on …" instead of "renews on …". The payer reads it from their own row (billing_accounts' policy).
alter table public.billing_accounts add column if not exists cancel_at timestamptz;
