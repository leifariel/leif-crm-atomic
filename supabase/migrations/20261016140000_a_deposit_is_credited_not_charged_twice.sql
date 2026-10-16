-- A DEPOSIT IS CREDITED, NOT CHARGED TWICE.
--
-- Deposits / payment-page support. Leif takes a fixed deposit now and the
-- rest on the first day of the client's programme start month, on the
-- payment plan they already chose.
--
--   The Living Example   $4,000 total   $500 deposit   $3,500 balance
--   Growing Yourself Up  $1,400 total   $400 deposit   $1,000 balance
--
-- FOUR DECISIONS THIS ENCODES, ALL LEIF'S (2026-10-16).
--
-- 1. The deposit is credited toward the SELECTED OPTION'S total, so the
--    authority is the versioned payment option, not the Offer. The deposit
--    interacts with the instalment structure, and options are already
--    versioned and immutable once referenced -- putting it on the Offer
--    would force every option of a programme to share one deposit and leave
--    Financial Need undecidable. Scholarship and custom options configure
--    their own, including zero; nothing about scholarship is hardcoded.
--
-- 2. The Living Example's Financial Need option stays $3,996. Four Won
--    Deals already carry that agreed total. It is NOT rewritten to $4,000,
--    and there is no separate public LE six-pay -- the six-pay IS Financial
--    Need.
--
-- 3. Unequal instalments are authorised. $3,996 less $500 is $3,496, which
--    does not divide by six. The old choice was to distort the agreed total
--    or refuse the plan; Leif chose neither. The balance is split in
--    integer cents, remainder one cent at a time to the earliest payments:
--    4 x $582.67 then 2 x $582.66, summing to exactly $3,496.
--
--    NOTE WHERE THAT RELAXATION DOES *NOT* GO. An option's own
--    `installment_amount x installments = total` rule is UNTOUCHED, because
--    `installment_amount` stays the PRE-deposit figure ($666) and the
--    balance split is derived. Relaxing the catalogue would have invited an
--    option that does not add up for reasons having nothing to do with a
--    deposit. The exactness that had to move is in the CHARGE path, where
--    stripe_checkout rebuilds the amount.
--
-- 4. A webhook-confirmed deposit IS the financial commitment, so it marks
--    the sale Won. Audited first: seed_enrollment_onboarding() writes only
--    onboarding items and Tasks, and those Tasks are Leif's own to-dos
--    ("Send contract", "Grant Notion access", "Invite to GYU Slack"). The
--    CRM grants nothing, invites nobody and sends no email. No new
--    "deposit paid but not Won" stage is introduced.
--
-- THE BALANCE ANCHOR is `date_trunc('month', enrollments.start_date)` --
-- derived, never a second column, and never the deposit date, the
-- sales-call date, the Won timestamp, the Enrollment timestamp or a 30-day
-- offset.
--
-- Deterministic: adds two nullable columns, replaces one function, creates
-- two, and attaches nothing. Asserts structure only and replays into an
-- empty database. Historical Deals acquire no deposit: every production
-- option is referenced by zero Deals, and the snapshot below is written
-- only when a deposit is actually agreed.

-- ---------------------------------------------------------------------
-- 1. The versioned deposit.
-- ---------------------------------------------------------------------

alter table public.offer_payment_options
    add column if not exists deposit_amount numeric(10, 2);

comment on column public.offer_payment_options.deposit_amount is
    'Credited toward THIS option''s total. Null or 0 is no deposit, which is every option that existed before deposits and whose behaviour must not change. Versioned with the rest of the option: set_offer_payment_option() replaces a referenced option rather than editing it, so an agreement already made cannot be reinterpreted.';

alter table public.offer_payment_options
    drop constraint if exists offer_payment_options_deposit_amount_check;
alter table public.offer_payment_options
    add constraint offer_payment_options_deposit_amount_check check (
        deposit_amount is null
        or (deposit_amount >= 0 and deposit_amount <= total));

-- ---------------------------------------------------------------------
-- 2. The Deal's own copy of it.
-- ---------------------------------------------------------------------
-- Why a snapshot at all, when the Deal already points at the option.
--
-- Because the three numbers beside it are snapshots for exactly this
-- reason: `selected_payment_total`, `selected_installment_count` and
-- `selected_installment_amount` exist so a later catalogue edit cannot
-- reinterpret an agreement somebody already made, and stripe_checkout reads
-- the snapshot rather than the catalogue precisely because of a drift that
-- once charged one number while the page showed another.
--
-- The deposit is a term of the same agreement, and the BALANCE is derived
-- from it (total - deposit). Reading the deposit from the catalogue while
-- reading the total from the Deal is the same drift with an extra step:
-- it could compute a balance from two different versions of one agreement.
--
-- Null means no deposit was agreed, which is every Deal that exists today.

alter table public.deals
    add column if not exists selected_deposit_amount numeric(10, 2);

comment on column public.deals.selected_deposit_amount is
    'Snapshot of the chosen payment option''s deposit_amount at the moment the agreement was frozen -- the fourth of the commercial snapshot fields, for the same reason as the other three. Null means no deposit was agreed. The balance is agreed total minus this, and nothing recomputes it from the catalogue.';

alter table public.deals
    drop constraint if exists deals_selected_deposit_amount_check;
alter table public.deals
    add constraint deals_selected_deposit_amount_check check (
        selected_deposit_amount is null
        or (selected_deposit_amount >= 0
            and (selected_payment_total is null
                 or selected_deposit_amount <= selected_payment_total)));

-- ---------------------------------------------------------------------
-- 3. The catalogue authority learns about deposits.
-- ---------------------------------------------------------------------
-- Replaced rather than overloaded: the signature gains one trailing
-- parameter and the dataProvider calls this with NAMED arguments through
-- PostgREST, where two candidates differing only by a defaulted trailing
-- parameter is how a named-argument call becomes ambiguous (the lesson of
-- 20261015140000).

drop function if exists public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint);

create or replace function public.set_offer_payment_option(
  p_offer_id bigint,
  p_name text,
  p_total numeric,
  p_installments smallint,
  p_installment_amount numeric,
  p_is_public boolean default true,
  p_pricing_mode text default 'standard',
  p_option_id bigint default null,
  p_deposit_amount numeric default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_existing offer_payment_options%rowtype;
  v_references int;
  v_new_id bigint;
  v_deposit numeric;
begin
  if not exists (select 1 from offers where id = p_offer_id) then
    return jsonb_build_object('status', 'offer-invalid');
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    return jsonb_build_object('status', 'name-required');
  end if;
  if p_pricing_mode not in ('standard', 'scholarship') then
    return jsonb_build_object('status', 'pricing-mode-invalid');
  end if;
  if p_installments is null or p_installments < 1 then
    return jsonb_build_object('status', 'installments-invalid');
  end if;
  if p_total is null or p_total < 0
     or p_installment_amount is null or p_installment_amount < 0 then
    return jsonb_build_object('status', 'amount-invalid');
  end if;
  -- UNCHANGED. An option's instalment_amount is the PRE-deposit figure, so
  -- a deposit never makes this impossible and relaxing it would only admit
  -- plans that do not add up for unrelated reasons. See this migration's
  -- header, decision 3.
  if p_installments > 1
     and round(p_installment_amount * p_installments, 2) <> round(p_total, 2) then
    return jsonb_build_object(
      'status', 'instalments-do-not-add-up',
      'total', p_total,
      'reconstructed', round(p_installment_amount * p_installments, 2));
  end if;

  -- A deposit larger than the thing it is a deposit on is not a deposit.
  v_deposit := case when p_deposit_amount is null then null
                    else round(p_deposit_amount, 2) end;
  if v_deposit is not null and v_deposit < 0 then
    return jsonb_build_object('status', 'deposit-invalid');
  end if;
  if v_deposit is not null and v_deposit > round(p_total, 2) then
    return jsonb_build_object('status', 'deposit-exceeds-total',
      'deposit', v_deposit, 'total', round(p_total, 2));
  end if;

  -- ---- a new one -----------------------------------------------------------
  if p_option_id is null then
    insert into offer_payment_options
      (offer_id, name, total, installments, installment_amount, is_public,
       pricing_mode, deposit_amount)
    values
      (p_offer_id, btrim(p_name), p_total, p_installments, p_installment_amount,
       coalesce(p_is_public, true), p_pricing_mode, v_deposit)
    returning id into v_new_id;
    return jsonb_build_object('status', 'added', 'option_id', v_new_id);
  end if;

  select * into v_existing from offer_payment_options where id = p_option_id;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;
  if v_existing.offer_id <> p_offer_id then
    return jsonb_build_object('status', 'offer-mismatch');
  end if;

  -- Nothing changed is not a new version.
  if v_existing.name = btrim(p_name)
     and round(v_existing.total, 2) = round(p_total, 2)
     and v_existing.installments = p_installments
     and round(v_existing.installment_amount, 2) = round(p_installment_amount, 2)
     and v_existing.is_public = coalesce(p_is_public, true)
     and v_existing.pricing_mode = p_pricing_mode
     and v_existing.deposit_amount is not distinct from v_deposit then
    return jsonb_build_object('status', 'unchanged', 'option_id', v_existing.id);
  end if;

  -- An option somebody has agreed to is immutable. Editing it creates the
  -- NEXT version and retires this one; the Deals that reference it keep
  -- the terms they actually agreed, deposit included.
  select count(*) into v_references
    from deals where selected_payment_option_id = v_existing.id;

  if v_references > 0 then
    insert into offer_payment_options
      (offer_id, name, total, installments, installment_amount, is_public,
       pricing_mode, deposit_amount, replaces_option_id)
    values
      (p_offer_id, btrim(p_name), p_total, p_installments, p_installment_amount,
       coalesce(p_is_public, true), p_pricing_mode, v_deposit, v_existing.id)
    returning id into v_new_id;

    update offer_payment_options set is_active = false, updated_at = now()
     where id = v_existing.id;

    return jsonb_build_object(
      'status', 'versioned',
      'option_id', v_new_id,
      'replaced_option_id', v_existing.id,
      'agreements_preserved', v_references);
  end if;

  update offer_payment_options
     set name = btrim(p_name), total = p_total, installments = p_installments,
         installment_amount = p_installment_amount,
         is_public = coalesce(p_is_public, true),
         pricing_mode = p_pricing_mode,
         deposit_amount = v_deposit,
         updated_at = now()
   where id = v_existing.id;

  return jsonb_build_object('status', 'updated', 'option_id', v_existing.id);
end;
$fn$;

revoke all on function public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint, numeric) from public, anon;
grant execute on function public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint, numeric) to authenticated;
grant execute on function public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint, numeric) to service_role;

-- ---------------------------------------------------------------------
-- 4. The balance allocation, in integer cents, in SQL.
-- ---------------------------------------------------------------------
-- Mirrored by deals/depositAllocation.ts, which the Offer Page and the
-- owner's surfaces read from -- the same dual-implementation convention as
-- every other integration here, and
-- contracts/deals/oneDepositAllocation.test.ts proves the two agree on
-- every decided plan rather than trusting that they do.
--
-- floor = balance div n, remainder = balance mod n. The first `remainder`
-- instalments carry one extra cent. Earliest-first so the odd cents arrive
-- sooner, and deterministic so the same agreement always produces the same
-- schedule.

create or replace function public.allocate_balance_cents(
  p_balance_cents bigint,
  p_installments int
) returns bigint[]
language sql
immutable
set search_path to 'public'
as $fn$
  select array_agg(
           (p_balance_cents / p_installments)
           + case when i <= (p_balance_cents % p_installments) then 1 else 0 end
           order by i)
    from generate_series(1, p_installments) as i;
$fn$;

comment on function public.allocate_balance_cents(bigint, int) is
    'Splits a balance into instalments that sum to it EXACTLY, in integer cents, remainder one cent at a time to the earliest payments. Mirrored by deals/depositAllocation.ts and cross-checked by contract.';

-- ---------------------------------------------------------------------
-- 5. What the remaining balance is, and whether it may be scheduled yet.
-- ---------------------------------------------------------------------
-- A DECISION, not a Stripe call: Postgres cannot reach Stripe, so this
-- answers "what, when, and is it safe" and the Edge Function executes it.
-- The one write it makes is the review Task, because a refusal that nobody
-- can see is a refusal that silently loses money.
--
-- The past-due rule is Leif's, and it is a refusal rather than a repair: if
-- the first of the start month has already gone, DO NOT backdate a
-- schedule, shift the contract, re-anchor to today's day-of-month, or
-- charge a catch-up. Raise it and let her resolve it.

create or replace function public.plan_balance_schedule(p_opportunity_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_enrollment enrollments%rowtype;
  v_deposit_cents bigint;
  v_total_cents bigint;
  v_balance_cents bigint;
  v_installments int;
  v_anchor date;
  v_parts bigint[];
  v_collected_cents bigint;
  v_balance_paid_cents bigint;
  v_phases jsonb;
  v_amount bigint;
  v_run int;
  v_i int;
begin
  select * into v_deal from deals where id = p_opportunity_id;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- The sale has to exist before its balance can be scheduled.
  if v_deal.stage <> 'won' then
    return jsonb_build_object('status', 'not-won', 'stage', v_deal.stage);
  end if;
  if v_deal.archived_at is not null or v_deal.outcome is not null then
    return jsonb_build_object('status', 'not-won',
      'stage', v_deal.stage, 'outcome', v_deal.outcome);
  end if;

  if v_deal.selected_payment_total is null then
    return jsonb_build_object('status', 'terms-unknown');
  end if;
  v_total_cents := round(v_deal.selected_payment_total * 100)::bigint;
  v_installments := coalesce(v_deal.selected_installment_count, 1);
  if v_installments < 1 then
    return jsonb_build_object('status', 'terms-unknown');
  end if;

  -- No deposit agreed means this whole mechanism does not apply: the Deal
  -- is paid for however it was already being paid for, and nothing here
  -- changes that. Every Deal in production today is in this branch.
  if v_deal.selected_deposit_amount is null
     or round(v_deal.selected_deposit_amount, 2) = 0 then
    return jsonb_build_object('status', 'no-deposit-plan');
  end if;
  v_deposit_cents := round(v_deal.selected_deposit_amount * 100)::bigint;
  if v_deposit_cents > v_total_cents then
    return jsonb_build_object('status', 'terms-unknown',
      'reason', 'the agreed deposit is larger than the agreed total');
  end if;

  v_balance_cents := v_total_cents - v_deposit_cents;
  if v_balance_cents = 0 then
    return jsonb_build_object('status', 'nothing-to-schedule',
      'opportunity_id', v_deal.id,
      'agreed_total_cents', v_total_cents,
      'deposit_cents', v_deposit_cents);
  end if;

  -- THE DEPOSIT HAS TO BE IN. Scheduling a balance before the deposit has
  -- arrived would charge the larger half of an agreement nobody has
  -- started honouring, off a card that may not even be saved.
  select coalesce(sum(round(amount * 100)::bigint), 0) into v_collected_cents
    from deal_payment_schedule_items
   where deal_id = v_deal.id and status = 'paid';
  if v_collected_cents < v_deposit_cents then
    return jsonb_build_object('status', 'deposit-not-paid',
      'collected_cents', v_collected_cents,
      'deposit_cents', v_deposit_cents);
  end if;

  -- THE ANCHOR. The first calendar day of the month the client's programme
  -- starts in, and nothing else.
  select * into v_enrollment from enrollments
   where opportunity_id = v_deal.id
     and status <> 'withdrawn'
   order by id limit 1;
  if not found then
    return jsonb_build_object('status', 'enrollment-missing');
  end if;
  if v_enrollment.start_date is null then
    -- Valid and expected for The Living Example: Won, enrolled, onboarding
    -- under way, start week still Leif's to state. Never invented.
    return jsonb_build_object('status', 'start-date-unknown',
      'enrollment_id', v_enrollment.id);
  end if;
  v_anchor := date_trunc('month', v_enrollment.start_date)::date;

  -- Money already collected BEYOND the deposit is a balance payment, and
  -- once one has succeeded the schedule is history rather than a plan.
  v_balance_paid_cents := v_collected_cents - v_deposit_cents;

  if v_balance_paid_cents > 0 then
    perform public.reconcile_payment_health_tasks(v_deal.id);
    return jsonb_build_object('status', 'balance-already-started',
      'balance_paid_cents', v_balance_paid_cents,
      'balance_start_date', v_anchor,
      'reason', 'A balance payment has already succeeded. Changing the schedule now would rewrite financial history.');
  end if;

  -- THE PAST-DUE REFUSAL.
  if v_anchor <= current_date then
    perform public.reconcile_payment_health_tasks(v_deal.id);
    return jsonb_build_object('status', 'balance-start-requires-review',
      'balance_start_date', v_anchor,
      'today', current_date,
      'reason', 'The first of the programme start month has already passed. The balance schedule needs Leif, not a backdated charge.');
  end if;

  v_parts := public.allocate_balance_cents(v_balance_cents, v_installments);

  -- Consecutive equal amounts grouped into Stripe phases, order preserved.
  v_phases := '[]'::jsonb;
  v_amount := v_parts[1];
  v_run := 0;
  for v_i in 1 .. array_length(v_parts, 1) loop
    if v_parts[v_i] = v_amount then
      v_run := v_run + 1;
    else
      v_phases := v_phases || jsonb_build_object('iterations', v_run, 'amount_cents', v_amount);
      v_amount := v_parts[v_i];
      v_run := 1;
    end if;
  end loop;
  v_phases := v_phases || jsonb_build_object('iterations', v_run, 'amount_cents', v_amount);

  return jsonb_build_object(
    'status', 'ready',
    'opportunity_id', v_deal.id,
    'contact_id', v_deal.contact_id,
    'agreed_total_cents', v_total_cents,
    'deposit_cents', v_deposit_cents,
    'balance_cents', v_balance_cents,
    'installments', v_installments,
    'balance_start_date', v_anchor,
    'per_installment_cents', to_jsonb(v_parts),
    'phases', v_phases,
    'existing_schedule_id', v_deal.stripe_subscription_schedule_id);
end;
$fn$;

comment on function public.plan_balance_schedule(bigint) is
    'Decides the remaining-balance schedule: what the instalments are in exact cents, and whether it may be created at all. Anchored on date_trunc(''month'', enrollments.start_date). Refuses rather than repairs when the anchor has passed or a balance payment has already succeeded, and raises a review Task when it does.';

-- ---------------------------------------------------------------------
-- 6. A plan that is failing says so.
-- ---------------------------------------------------------------------
-- The audit found this, and it is pre-existing: PaymentState had no
-- unhealthy value, hasCurrentPlan asked only whether a plan EXISTS, and
-- nothing ever created a check_payment Task by itself. Once a deposit's
-- whole premise is that the client leaves and the rest is charged
-- off-session, "the card failed" has to be visible.
--
-- NO NEW FINANCIAL COLUMN. Stripe's own status is already stored on
-- deal_stripe_plan_objects by the reconciler; this reads it. The Task is
-- the actionable half, reconciled the same way every other Task projection
-- in this schema is: created while its condition holds, closed when it
-- stops.

-- ONE SENTENCE PER PREMISE, IN ONE PLACE.
--
-- Used by the insert and by the refresh below, so a Task that changes
-- premise cannot end up describing the premise it used to have -- and so
-- the refresh can tell a sentence this function wrote from a sentence
-- somebody typed, which is what makes it safe to rewrite at all.
create or replace function public.payment_health_task_reason(p_premise text)
returns text
language sql
immutable
set search_path to 'public'
as $fn$
  select case p_premise
           when 'plan_not_collecting'
             then 'a scheduled payment did not go through'
           when 'balance_start_requires_review'
             then 'the balance start month has already passed -- the remaining balance needs scheduling by hand'
           when 'balance_not_scheduled'
             then 'the remaining balance is not scheduled yet'
         end;
$fn$;

create or replace function public.reconcile_payment_health_tasks(
  p_opportunity_id bigint default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_created int := 0;
  v_closed int := 0;
  v_restated int := 0;
  v_sales_id bigint;
begin
  select id into v_sales_id from sales where administrator = true limit 1;

  -- THREE DURABLE PREMISES, all declarative, so the same query that opens a
  -- Task is the one that closes it.
  --
  --   A  plan_not_collecting            the current Stripe plan is not
  --                                     collecting (Stripe's own vocabulary:
  --                                     past_due / unpaid for a failed
  --                                     charge, incomplete(_expired) when
  --                                     the customer has to authenticate)
  --   B  balance_start_requires_review  deposit in, balance outstanding, the
  --                                     first of the start month has gone, and
  --                                     nothing carrying it
  --   C  balance_not_scheduled          deposit in, balance outstanding, a
  --                                     USABLE FUTURE start month, and no
  --                                     balance schedule exists
  --
  -- C is the one that closes the stranding hole. The CRM and Stripe cannot
  -- share a transaction: enrollments.start_date commits first and the
  -- schedule is a consequence, so every way that consequence can fail --
  -- the Edge call never made, a network error, a provider error, no saved
  -- card -- used to leave a committed client with a balance owed, a known
  -- start month, no schedule and nothing saying so. It is a CONDITION, not
  -- an event: it holds until a schedule exists and then stops on its own,
  -- which is exactly what makes a later success close it with no retry
  -- bookkeeping. deals_awaiting_balance_schedule() below states the same
  -- predicate for the hourly sweep that retries it.
  --
  -- The three cannot overlap: A requires a current plan object and B and C
  -- require none, and B needs the anchor past where C needs it future. The
  -- distinct on () is belt as well as braces.
  with collected as (
    select deal_id, sum(round(amount * 100)::bigint) as cents
      from deal_payment_schedule_items where status = 'paid' group by deal_id
  ),
  -- A sale that is agreed and has not ended, carrying a deposit, with the
  -- deposit in and the balance not. Stated once for both B and C.
  owed as (
    select d.id as deal_id,
           d.contact_id,
           date_trunc('month', e.start_date)::date as anchor,
           d.stripe_subscription_schedule_id as schedule_id
      from deals d
      join enrollments e on e.opportunity_id = d.id and e.status <> 'withdrawn'
      left join collected c on c.deal_id = d.id
      -- Stated directly rather than through deal_is_active(), whose whole
      -- point is that a WON deal is not 'active' -- true here, and
      -- confusing to read.
     where d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
       and d.selected_deposit_amount is not null
       and round(d.selected_deposit_amount, 2) > 0
       and d.selected_payment_total is not null
       and e.start_date is not null
       and coalesce(c.cents, 0) >= round(d.selected_deposit_amount * 100)::bigint
       and coalesce(c.cents, 0) < round(d.selected_payment_total * 100)::bigint
       and not exists (select 1 from deal_stripe_plan_objects p2
                        where p2.deal_id = d.id and p2.is_current)
  ),
  premises as (
    select distinct d.id as deal_id, d.contact_id, 'plan_not_collecting'::text as premise
      from deals d
      join deal_stripe_plan_objects p on p.deal_id = d.id
     where p.is_current
       and p.status in ('past_due', 'unpaid', 'incomplete', 'incomplete_expired')
       and d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
    union all
    select o.deal_id, o.contact_id, 'balance_start_requires_review'
      from owed o where o.anchor <= current_date
    union all
    select o.deal_id, o.contact_id, 'balance_not_scheduled'
      from owed o where o.anchor > current_date and o.schedule_id is null
  ),
  raised as (
    select distinct on (deal_id) deal_id, contact_id, premise
      from premises
     where p_opportunity_id is null or deal_id = p_opportunity_id
     order by deal_id, premise
  )
  insert into tasks (contact_id, type, text, due_date, status, opportunity_id, sales_id)
  select r.contact_id, 'check_payment',
         format('%s · %s', nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                public.payment_health_task_reason(r.premise)),
         now(), 'pending', r.deal_id, v_sales_id
    from raised r
    join contacts c on c.id = r.contact_id
   where not exists (
     select 1 from tasks t
      where t.opportunity_id = r.deal_id
        and t.type = 'check_payment'
        and t.done_date is null);
  get diagnostics v_created = row_count;

  -- A TASK WHOSE REASON CHANGED SAYS THE NEW REASON.
  --
  -- The text is written once, at insert, and the dedupe above deliberately
  -- does not add a second Task -- so a Deal that moves from "the start
  -- month has already passed" to "not scheduled yet" would otherwise keep
  -- telling Leif about a month that is now perfectly fine. The premise it
  -- was raised under is not the premise it is still open under.
  --
  -- Rewrites ONLY a sentence this function itself wrote, which is what
  -- payment_health_task_reason() being single-sourced buys: a check_payment
  -- Task somebody typed by hand matches none of the three and is left
  -- exactly as typed.
  with collected as (
    select deal_id, sum(round(amount * 100)::bigint) as cents
      from deal_payment_schedule_items where status = 'paid' group by deal_id
  ),
  owed as (
    select d.id as deal_id,
           d.contact_id,
           date_trunc('month', e.start_date)::date as anchor,
           d.stripe_subscription_schedule_id as schedule_id
      from deals d
      join enrollments e on e.opportunity_id = d.id and e.status <> 'withdrawn'
      left join collected c on c.deal_id = d.id
     where d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
       and d.selected_deposit_amount is not null
       and round(d.selected_deposit_amount, 2) > 0
       and d.selected_payment_total is not null
       and e.start_date is not null
       and coalesce(c.cents, 0) >= round(d.selected_deposit_amount * 100)::bigint
       and coalesce(c.cents, 0) < round(d.selected_payment_total * 100)::bigint
       and not exists (select 1 from deal_stripe_plan_objects p2
                        where p2.deal_id = d.id and p2.is_current)
  ),
  premises as (
    select distinct d.id as deal_id, d.contact_id, 'plan_not_collecting'::text as premise
      from deals d
      join deal_stripe_plan_objects p on p.deal_id = d.id
     where p.is_current
       and p.status in ('past_due', 'unpaid', 'incomplete', 'incomplete_expired')
       and d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
    union all
    select o.deal_id, o.contact_id, 'balance_start_requires_review'
      from owed o where o.anchor <= current_date
    union all
    select o.deal_id, o.contact_id, 'balance_not_scheduled'
      from owed o where o.anchor > current_date and o.schedule_id is null
  ),
  wanted as (
    select distinct on (p.deal_id)
           p.deal_id,
           format('%s · %s', nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                  public.payment_health_task_reason(p.premise)) as says
      from premises p
      join contacts c on c.id = p.contact_id
     where p_opportunity_id is null or p.deal_id = p_opportunity_id
     order by p.deal_id, p.premise
  )
  update tasks t
     set text = w.says
    from wanted w
   where t.opportunity_id = w.deal_id
     and t.type = 'check_payment'
     and t.done_date is null
     and t.text <> w.says
     and t.text in (
       select format('%s · %s', nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                     public.payment_health_task_reason(premise))
         from contacts c
         cross join unnest(array['plan_not_collecting',
                                 'balance_start_requires_review',
                                 'balance_not_scheduled']) as premise
        where c.id = t.contact_id);
  get diagnostics v_restated = row_count;

  -- Recovered, scheduled, or the plan is gone. Either way the question is
  -- answered, so the Task is finished rather than left to rot. The premise
  -- set is recomputed rather than restated, so opening and closing can
  -- never drift apart -- which is what a third premise would otherwise
  -- have made very easy.
  --
  -- This closes the CONDITION. It deliberately cannot touch
  -- deals.payment_review_code = 'balance_schedule_frozen', which is the
  -- DECISION Leif owns after money has already moved: different artefact,
  -- different table, different lifecycle.
  with collected as (
    select deal_id, sum(round(amount * 100)::bigint) as cents
      from deal_payment_schedule_items where status = 'paid' group by deal_id
  ),
  owed as (
    select d.id as deal_id,
           date_trunc('month', e.start_date)::date as anchor,
           d.stripe_subscription_schedule_id as schedule_id
      from deals d
      join enrollments e on e.opportunity_id = d.id and e.status <> 'withdrawn'
      left join collected c on c.deal_id = d.id
     where d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
       and d.selected_deposit_amount is not null
       and round(d.selected_deposit_amount, 2) > 0
       and d.selected_payment_total is not null
       and e.start_date is not null
       and coalesce(c.cents, 0) >= round(d.selected_deposit_amount * 100)::bigint
       and coalesce(c.cents, 0) < round(d.selected_payment_total * 100)::bigint
       and not exists (select 1 from deal_stripe_plan_objects p2
                        where p2.deal_id = d.id and p2.is_current)
  ),
  premises as (
    select distinct d.id as deal_id
      from deals d
      join deal_stripe_plan_objects p on p.deal_id = d.id
     where p.is_current
       and p.status in ('past_due', 'unpaid', 'incomplete', 'incomplete_expired')
       and d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
    union
    select o.deal_id from owed o where o.anchor <= current_date
    union
    select o.deal_id from owed o where o.anchor > current_date and o.schedule_id is null
  )
  update tasks t
     set done_date = coalesce(t.done_date, now()), status = 'completed'
   where t.type = 'check_payment'
     and t.done_date is null
     and t.opportunity_id is not null
     and (p_opportunity_id is null or t.opportunity_id = p_opportunity_id)
     and not exists (select 1 from premises pr where pr.deal_id = t.opportunity_id);
  get diagnostics v_closed = row_count;

  return jsonb_build_object('created', v_created, 'closed', v_closed,
                            'restated', v_restated);
end;
$fn$;

comment on function public.reconcile_payment_health_tasks(bigint) is
    'One open check_payment Task per Opportunity whose current Stripe plan is not collecting, or whose paid-deposit balance has no schedule carrying it -- closed when the condition stops. Reads the status the reconciler already stores; no new financial column. Never touches deals.payment_review_code.';

-- ---------------------------------------------------------------------
-- The decision Leif owns, after money has already moved
-- ---------------------------------------------------------------------
-- THIS ONE IS AN EVENT, NOT A CONDITION, which is why it is not a Task.
--
-- Before the first balance payment, moving the start week re-anchors the
-- not_started schedule in place: automatic, safe, reversible. After one has
-- succeeded, re-anchoring would rewrite financial history, so the CRM
-- refuses -- and a refusal nobody is told about is the same as a silent
-- failure. But "somebody asked to move a charged schedule" never stops
-- being true, so a declarative reconciler would close it on its next pass,
-- and it is not a condition about the client's account that recovery could
-- resolve.
--
-- So it goes where this schema already keeps "a human must decide about
-- this payment": deals.payment_review_reason with its machine-readable
-- payment_review_code. That slot is the right shape for three structural
-- reasons rather than by preference.
--
--   DEDUPE IS STRUCTURAL. One column on one Deal. A repeated refusal
--   cannot make a second artefact, because there is nowhere to put one.
--
--   IT CANNOT BE AUTO-CLOSED. ingestStripePayments() resolves
--   `existingReviewReason ?? ambiguity ?? computed`, so a stored reason
--   wins over anything the hourly reconciliation computes and is carried
--   forward untouched; and reconcile_payment_health_tasks() above only ever
--   writes `tasks` rows of type check_payment. Recovery of the card, a
--   later successful charge, a new schedule: none of them can erase it.
--
--   IT ALREADY HAS A MANUAL RESOLUTION. canMarkReviewed() in
--   deals/paymentReview.ts allows a stored, deliberately-raised review to
--   be closed by a person, and PaymentPanel's "Mark reviewed" is that
--   action. Leif resolves it exactly the way she resolves every other
--   payment review.
--
-- It derives its own context instead of being handed any: the Edge Function
-- passes an Opportunity id and nothing else, so it cannot be told a start
-- month or an amount that is not in the database.
alter table public.deals drop constraint if exists deals_payment_review_code_check;
alter table public.deals
    add constraint deals_payment_review_code_check check (
      payment_review_code is null or payment_review_code = any (array[
        'terms_unknown'::text,
        'evidence_incomplete'::text,
        'collected_exceeds_agreed'::text,
        'duplicate_economic_payment'::text,
        'identity_unresolved'::text,
        'owner_flagged'::text,
        'balance_schedule_frozen'::text]));

create or replace function public.flag_balance_schedule_frozen(
  p_opportunity_id bigint
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_start date;
  v_collected bigint;
  v_balance_paid bigint;
  v_reason text;
begin
  select * into v_deal from deals where id = p_opportunity_id;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- Already asked, or a different question is already standing. Either way
  -- this does not stack: an older review is somebody else's unanswered
  -- question and overwriting it would lose it.
  if v_deal.payment_review_reason is not null
     or v_deal.payment_review_code is not null then
    return jsonb_build_object(
      'status', case when v_deal.payment_review_code = 'balance_schedule_frozen'
                     then 'already-raised'
                     else 'another-review-stands' end,
      'review_code', v_deal.payment_review_code);
  end if;

  select e.start_date into v_start
    from enrollments e
   where e.opportunity_id = v_deal.id and e.status <> 'withdrawn'
   order by e.id limit 1;

  select coalesce(sum(round(amount * 100)::bigint), 0) into v_collected
    from deal_payment_schedule_items
   where deal_id = v_deal.id and status = 'paid';
  v_balance_paid := greatest(
    v_collected - round(coalesce(v_deal.selected_deposit_amount, 0) * 100)::bigint, 0);

  -- Answer first, mechanism second: what is true, what was NOT done, and
  -- what the decision is. No Stripe object ids and no lifecycle vocabulary.
  v_reason :=
    'The programme start month changed after the remaining balance had already begun collecting, so the payment schedule was NOT moved. Nothing was charged and no schedule was rewritten.'
    || coalesce(' The start month now reads ' ||
                to_char(date_trunc('month', v_start), 'FMMonth YYYY') || '.', '')
    || ' $' || to_char(v_balance_paid / 100.0, 'FM999999990.00')
    || ' of the balance has already been collected.'
    || ' Decide whether to leave the remaining payments as they stand or change them deliberately.';

  update deals
     set payment_review_reason = v_reason,
         payment_review_code = 'balance_schedule_frozen'
   where id = v_deal.id;

  return jsonb_build_object('status', 'raised',
    'opportunity_id', v_deal.id,
    'start_date', v_start,
    'balance_paid_cents', v_balance_paid);
end;
$fn$;

comment on function public.flag_balance_schedule_frozen(bigint) is
    'Durable manual review when a start-month change could not re-anchor a balance schedule that has already begun collecting. One per Deal, never stacked on another review, never auto-closed -- Leif closes it with Mark reviewed.';

-- ---------------------------------------------------------------------
-- What the hourly sweep retries
-- ---------------------------------------------------------------------
-- Premise C of the reconciler above, stated as a list so the sweep can act
-- on it. Deliberately the SAME predicate: the Deals the reconciler raises a
-- Task for are exactly the Deals the sweep tries to schedule, so a Task
-- appearing and a retry happening can never describe different sets.
--
-- This is what makes the invariant hold without Leif doing anything.
-- Growing Yourself Up takes its start authority from the cohort at Won, so
-- its schedule is created by the deposit webhook itself and no Start Week
-- save is ever needed -- but if that one attempt fails, nothing else used to
-- try again. Now the hourly reconcile-stripe job does, and keeps doing it
-- until there is a schedule or the start month arrives and premise B takes
-- over.
create or replace function public.deals_awaiting_balance_schedule()
returns setof bigint
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select d.id
    from deals d
    join enrollments e on e.opportunity_id = d.id and e.status <> 'withdrawn'
   where d.stage = 'won'
     and d.archived_at is null
     and d.outcome is null
     and d.selected_deposit_amount is not null
     and round(d.selected_deposit_amount, 2) > 0
     and d.selected_payment_total is not null
     and e.start_date is not null
     and date_trunc('month', e.start_date)::date > current_date
     and d.stripe_subscription_schedule_id is null
     and not exists (select 1 from deal_stripe_plan_objects p
                      where p.deal_id = d.id and p.is_current)
     and coalesce((select sum(round(i.amount * 100)::bigint)
                     from deal_payment_schedule_items i
                    where i.deal_id = d.id and i.status = 'paid'), 0)
         >= round(d.selected_deposit_amount * 100)::bigint
     and coalesce((select sum(round(i.amount * 100)::bigint)
                     from deal_payment_schedule_items i
                    where i.deal_id = d.id and i.status = 'paid'), 0)
         < round(d.selected_payment_total * 100)::bigint
   order by d.id;
$fn$;

comment on function public.deals_awaiting_balance_schedule() is
    'Opportunities with a paid deposit, a balance outstanding, a usable future start month and no balance schedule -- premise C of reconcile_payment_health_tasks(), as a list for the hourly sweep to retry.';

-- Internal: reached from the Stripe webhook and the hourly reconciler,
-- both of which run as the service, and from plan_balance_schedule() as
-- the owner. A browser never asserts payment health.
revoke all on function public.allocate_balance_cents(bigint, int) from public, anon, authenticated;
grant execute on function public.allocate_balance_cents(bigint, int) to service_role;
revoke all on function public.plan_balance_schedule(bigint) from public, anon, authenticated;
grant execute on function public.plan_balance_schedule(bigint) to service_role;
revoke all on function public.reconcile_payment_health_tasks(bigint) from public, anon, authenticated;
grant execute on function public.reconcile_payment_health_tasks(bigint) to service_role;
revoke all on function public.payment_health_task_reason(text) from public, anon, authenticated;
grant execute on function public.payment_health_task_reason(text) to service_role;
revoke all on function public.flag_balance_schedule_frozen(bigint) from public, anon, authenticated;
grant execute on function public.flag_balance_schedule_frozen(bigint) to service_role;
revoke all on function public.deals_awaiting_balance_schedule() from public, anon, authenticated;
grant execute on function public.deals_awaiting_balance_schedule() to service_role;

-- ---------------------------------------------------------------------
-- 7. PROVE IT.
-- ---------------------------------------------------------------------
do $$
declare
  v_parts bigint[];
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'offer_payment_options'
       and column_name = 'deposit_amount' and is_nullable = 'YES'
  ) then
    raise exception 'offer_payment_options.deposit_amount is missing or NOT NULL';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'deals'
       and column_name = 'selected_deposit_amount' and is_nullable = 'YES'
  ) then
    raise exception 'deals.selected_deposit_amount is missing or NOT NULL';
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'offer_payment_options_deposit_amount_check') then
    raise exception 'a deposit larger than its own total is not refused';
  end if;

  -- Nothing in production acquires a deposit by this migration running.
  if exists (select 1 from offer_payment_options where deposit_amount is not null) then
    raise exception 'a payment option acquired a deposit it was never configured with';
  end if;
  if exists (select 1 from deals where selected_deposit_amount is not null) then
    raise exception 'a Deal acquired a deposit it never agreed to';
  end if;

  -- The arithmetic, on the two plans that forced this design.
  v_parts := public.allocate_balance_cents(349600, 6);
  if v_parts <> array[58267, 58267, 58267, 58267, 58266, 58266]::bigint[] then
    raise exception 'the Financial Need six-pay does not allocate to 4 x 58267 + 2 x 58266: %', v_parts;
  end if;
  if (select sum(x) from unnest(v_parts) as x) <> 349600 then
    raise exception 'the Financial Need six-pay does not sum to 349600';
  end if;
  v_parts := public.allocate_balance_cents(350000, 4);
  if v_parts <> array[87500, 87500, 87500, 87500]::bigint[] then
    raise exception 'the Living Example four-pay is not 4 x 87500: %', v_parts;
  end if;

  if to_regprocedure(
       'public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint, numeric)') is null then
    raise exception 'set_offer_payment_option is not callable at the signature its grants name';
  end if;
  if to_regprocedure(
       'public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint)') is not null then
    raise exception 'the superseded 8-argument set_offer_payment_option is still present -- a named-argument call would be ambiguous';
  end if;

  if has_function_privilege('authenticated', 'public.plan_balance_schedule(bigint)', 'EXECUTE') then
    raise exception 'a browser can decide a balance schedule';
  end if;
  if has_function_privilege('anon', 'public.set_offer_payment_option(bigint, text, numeric, smallint, numeric, boolean, text, bigint, numeric)', 'EXECUTE') then
    raise exception 'anon can configure a payment option';
  end if;
  if not has_function_privilege('service_role', 'public.reconcile_payment_health_tasks(bigint)', 'EXECUTE') then
    raise exception 'the webhook cannot reconcile payment health';
  end if;

  -- THE TWO ARTEFACTS ARE DISTINCT, and the migration says so rather than
  -- trusting that they stay that way.
  if to_regprocedure('public.flag_balance_schedule_frozen(bigint)') is null then
    raise exception 'there is no durable manual review for a refused re-anchor';
  end if;
  if to_regprocedure('public.deals_awaiting_balance_schedule()') is null then
    raise exception 'nothing states which balances are still awaiting a schedule';
  end if;
  -- One sentence per premise, in one place, or a Task that changes premise
  -- starts describing the premise it used to have.
  if public.payment_health_task_reason('balance_not_scheduled')
       <> 'the remaining balance is not scheduled yet' then
    raise exception 'the unscheduled-balance reason is not what the UI and the tests expect';
  end if;
  if public.payment_health_task_reason('nonsense') is not null then
    raise exception 'an unknown premise invents a reason instead of returning nothing';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'deals_payment_review_code_check'
       and pg_get_constraintdef(oid) like '%balance_schedule_frozen%'
  ) then
    raise exception 'balance_schedule_frozen is not an accepted payment review code';
  end if;
  -- The condition reconciler must not be able to close the decision: it
  -- writes only tasks, and never a deals.payment_review_ column.
  --
  -- COMMENTS STRIPPED FIRST. pg_get_functiondef() returns the body
  -- verbatim, comments included, and the reconciler's own comments name
  -- the column precisely in order to say it must never write it. Matching
  -- the prose instead of the code is how this assertion failed the first
  -- time it ran -- against code that was correct.
  if regexp_replace(
       pg_get_functiondef('public.reconcile_payment_health_tasks(bigint)'::regprocedure),
       '--[^' || chr(10) || ']*', '', 'g') like '%payment\_review\_%' then
    raise exception 'the payment-health reconciler can reach the manual review it must never close';
  end if;
  if has_function_privilege('authenticated', 'public.flag_balance_schedule_frozen(bigint)', 'EXECUTE') then
    raise exception 'a browser can raise a payment review directly';
  end if;
  if has_function_privilege('authenticated', 'public.deals_awaiting_balance_schedule()', 'EXECUTE') then
    raise exception 'a browser can enumerate unscheduled balances';
  end if;

  -- Nothing in production acquires this review by the migration running.
  if exists (select 1 from deals where payment_review_code = 'balance_schedule_frozen') then
    raise exception 'a Deal acquired a frozen-schedule review it never had';
  end if;
end $$;
