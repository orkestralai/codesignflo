-- The payment confirmation CoDesignFlo sends (besides Stripe's receipts): the subscription it was sent for, so
-- it goes once per subscription, whether the webhook or the page back from Checkout records it first.
alter table public.billing_accounts add column if not exists confirmed_subscription text;
