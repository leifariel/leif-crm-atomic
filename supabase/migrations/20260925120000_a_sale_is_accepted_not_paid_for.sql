-- Becky Schmauch's sale, and the two beliefs that could not both be true.
--
-- 2026-09-14, 20260914153328_deal_won_payment_authority_guard.sql made
-- Stripe the sole authority for Won: handle_deal_saved() raised if any
-- role but service_role set stage = 'won'.
--
-- 2026-09-18, 20260918180000_won_is_a_sales_fact_not_a_payment_fact.sql
-- overturned the model that guard encodes, in as many words:
--
--   "The cause was a model that treated Won as a payment fact. It is not.
--    ... Won means the sale was accepted. It does not mean paid in full,
--    does not mean a Stripe subscription is active, and does not mean
--    onboarding is finished."
--
-- The frontend was changed to match on the same day. The guard was never
-- retired. From then on, recording an attended sale from the CRM was
-- impossible: the attendance write landed (its own PostgREST request, its
-- own transaction), the Won write was refused by the trigger, and the UI
-- showed a generic "server connection error". The Opportunity stayed at
-- Call Booked with no Enrollment. One click, half persisted.
--
-- Production bears it out. Of 32 Opportunities that ever entered Won, 28
-- are historical imports and the other four all carry the timestamp of
-- that very migration — a direct database connection, where the guard let
-- the write through. Not one sale had ever been won through the CRM's own
-- UI since the guard landed. The unit tests stayed green because they run
-- against FakeRest, which has no triggers.
--
-- Three things change, and nothing else.
--
--   1. Who may say a sale was won. Not "which role are you" — that made
--      Stripe the only possible author of a fact that is not about
--      payment. The question is whether you came through a canonical sale
--      action, and the credential for that is elevation, which a client
--      cannot forge.
--
--   2. One transaction. Becky's click was six separate requests. Fixing
--      only the guard would have fixed her case and left the SHAPE that
--      produced it: any later failure would split the same action again.
--
--   3. Convergence. Her call is already attended. A rule that answered
--      "already completed" would politely do nothing forever while her
--      Opportunity sat at Call Booked with no Enrollment. Recording an
--      outcome that never landed is not a duplicate; it is the first time
--      it has ever been recorded.

-- ---------------------------------------------------------------------------
-- 1. WHO MAY SAY A SALE WAS WON
-- ---------------------------------------------------------------------------
-- The old guard's real concern survives intact: handle_deal_won() creates
-- a real Enrollment, seeds an onboarding checklist and can consume the
-- Offer's single scholarship slot, so an ordinary CRM user must not be
-- able to fabricate all of that by typing into a stage field.
--
-- What changes is the test. An earlier draft of this repair had the sale
-- actions announce themselves by setting a transaction-local GUC that the
-- trigger then trusted. The security proof written for it broke it in one
-- line — a custom GUC is settable by ANY role, so the flag was a public
-- credential and revoking the function that set it stopped nobody. That
-- design is not in this file and was never deployed.
--
-- What decides it instead is who is actually running the statement:
--
--   a browser PATCH through PostgREST   current_user = authenticated
--   the Stripe webhook (supabaseAdmin)  current_user = service_role
--   a canonical sale action             current_user = the function owner,
--                                       because it is SECURITY DEFINER
--   a migration or recovery session     current_user = postgres
--
-- A client cannot become the owner. Elevation is the credential, it is
-- granted by EXECUTE on exactly the wrappers Leif is meant to use, and
-- there is nothing to set, hold or leak across a request boundary.
create or replace function public.handle_deal_saved() returns trigger
    language plpgsql
    set search_path to 'public'
    as $fn$
declare
  v_offer offers%ROWTYPE;
  v_cohort_offer_id bigint;
  v_contact contacts%ROWTYPE;
  v_option_offer_id bigint;
  v_option_pricing_mode text;
  v_rows int;
begin
  -- Won is a SALES fact: the prospect accepted. Not paid, not enrolled,
  -- not onboarded (20260918180000). Still not something to type into a
  -- field by hand, because handle_deal_won() turns it into an Enrollment,
  -- an onboarding checklist and possibly a claimed scholarship slot.
  if new.stage = 'won'
     and (tg_op = 'INSERT' or old.stage is distinct from 'won')
     and current_user in ('anon', 'authenticated')
  then
    raise exception 'Deal % cannot be set to Won by editing its stage — record the sale through the sales-call outcome or the prospect decision', new.id;
  end if;

  select * into v_offer from offers where id = new.offer_id;
  if v_offer.id is null then
    raise exception 'Invalid offer_id %', new.offer_id;
  end if;

  if new.cohort_id is not null then
    select offer_id into v_cohort_offer_id from cohorts where id = new.cohort_id;
    if v_cohort_offer_id is null then
      raise exception 'Invalid cohort_id %', new.cohort_id;
    end if;
    if v_offer.type <> 'group' then
      raise exception 'cohort_id can only be set on a group offer (offer_id %)', new.offer_id;
    end if;
    if v_cohort_offer_id <> new.offer_id then
      raise exception 'cohort_id % does not belong to offer_id %', new.cohort_id, new.offer_id;
    end if;
  end if;

  if current_setting('app.migration_mode', true) is distinct from 'true' then
    if tg_op = 'UPDATE' and old.stage = 'won' and new.pricing_mode is distinct from old.pricing_mode then
      raise exception 'Cannot change pricing_mode on deal % once it has reached Won', new.id;
    end if;

    if tg_op = 'INSERT' and new.pricing_mode = 'scholarship' then
      raise exception 'A new Opportunity cannot be created directly as scholarship — grant scholarship pricing via Deal edit after creation';
    end if;

    if tg_op = 'UPDATE'
       and old.pricing_mode = 'scholarship'
       and new.offer_id is distinct from old.offer_id
    then
      raise exception 'Cannot change offer_id on deal % while it holds a scholarship reservation — release scholarship pricing first', new.id;
    end if;

    if tg_op = 'UPDATE' and new.pricing_mode is distinct from old.pricing_mode then
      if new.pricing_mode = 'scholarship' then
        if v_offer.scholarship_price is null then
          raise exception 'Offer % has no scholarship price configured', new.offer_id;
        end if;

        insert into scholarship_slots (offer_id, holder_deal_id, reserved_at)
        values (new.offer_id, new.id, now())
        on conflict (offer_id) do update
          set holder_deal_id = excluded.holder_deal_id,
              reserved_at = excluded.reserved_at
          where scholarship_slots.holder_deal_id is null
            and scholarship_slots.holder_enrollment_id is null;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          raise exception 'Scholarship slot for offer % is already held', new.offer_id;
        end if;

        insert into scholarship_slot_events (offer_id, deal_id, event_type, occurred_at)
        values (new.offer_id, new.id, 'scholarship_granted', now());
      elsif old.pricing_mode = 'scholarship' then
        update scholarship_slots
          set holder_deal_id = null, reserved_at = null, updated_at = now()
          where offer_id = old.offer_id and holder_deal_id = new.id;

        insert into scholarship_slot_events (offer_id, deal_id, event_type, occurred_at)
        values (old.offer_id, new.id, 'scholarship_released', now());
      end if;
    end if;
  end if;

  if tg_op = 'INSERT'
     or new.offer_id is distinct from old.offer_id
     or new.pricing_mode is distinct from old.pricing_mode
  then
    new.offer_name_snapshot := v_offer.name;
    new.offer_price_snapshot := case
      when new.pricing_mode = 'scholarship' then v_offer.scholarship_price
      else v_offer.current_price
    end;
  end if;

  if new.selected_payment_option_id is not null
     and (tg_op = 'INSERT'
          or new.selected_payment_option_id is distinct from old.selected_payment_option_id
          or new.pricing_mode is distinct from old.pricing_mode)
  then
    select offer_id, pricing_mode, total, installments, installment_amount
      into v_option_offer_id, v_option_pricing_mode,
           new.selected_payment_total, new.selected_installment_count, new.selected_installment_amount
      from offer_payment_options
      where id = new.selected_payment_option_id;

    if v_option_offer_id is null then
      raise exception 'Invalid selected_payment_option_id %', new.selected_payment_option_id;
    end if;
    if v_option_offer_id <> new.offer_id or v_option_pricing_mode <> new.pricing_mode then
      raise exception 'Payment option % does not match deal %''s offer/pricing_mode', new.selected_payment_option_id, new.id;
    end if;
  end if;

  select * into v_contact from contacts where id = new.contact_id;
  if v_contact.id is not null then
    new.name := trim(both ' ' from coalesce(v_contact.first_name, '') || ' ' || coalesce(v_contact.last_name, ''));
  end if;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. THE ENROLLMENT A WON SALE HAS
-- ---------------------------------------------------------------------------
-- Lifted out of handle_deal_won() so the convergence path can reach it.
-- That trigger fires only on a genuine stage TRANSITION into Won; a deal
-- already Won and somehow without an Enrollment would never get one from
-- it, which is exactly the hole a half-landed sale falls into.
create or replace function public.ensure_sale_enrollment(p_deal_id bigint)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_cohort cohorts%rowtype;
  v_enrollment_id bigint;
begin
  select * into v_deal from deals where id = p_deal_id;
  if not found or v_deal.stage <> 'won' then
    return null;
  end if;

  if v_deal.cohort_id is not null then
    select * into v_cohort from cohorts where id = v_deal.cohort_id;
  end if;

  -- Idempotent: enrollments.opportunity_id is unique, so this can run any
  -- number of times and create at most one.
  insert into enrollments (opportunity_id, status, start_date, end_date, onboarding_tracking, start_date_source)
  values (
    v_deal.id,
    'onboarding',
    v_cohort.program_start_at::date,
    v_cohort.program_end_at::date,
    -- A sale made today is tracked. legacy_untracked is only ever a
    -- statement about the past, never a default for new work.
    'tracked',
    -- A Cohort start is a date Leif published when she created the round.
    -- An individual Offer has no such date: the Start Week is hers to set,
    -- and until she does it stays unknown rather than inferred.
    case when v_cohort.program_start_at is not null then 'owner' end
  )
  on conflict (opportunity_id) do nothing
  returning id into v_enrollment_id;

  if v_enrollment_id is not null then
    perform public.seed_enrollment_onboarding(v_enrollment_id);
  end if;

  return v_enrollment_id;
end;
$fn$;

revoke all on function public.ensure_sale_enrollment(bigint) from public;
revoke all on function public.ensure_sale_enrollment(bigint) from anon;
revoke all on function public.ensure_sale_enrollment(bigint) from authenticated;
revoke all on function public.ensure_sale_enrollment(bigint) from service_role;

-- ---------------------------------------------------------------------------
-- 3. THE ONE PLACE A SALE IS ACCEPTED
-- ---------------------------------------------------------------------------
-- Three UIs record the same business event — the prospect accepted — so
-- there is one primitive underneath and thin wrappers only where the
-- surrounding facts genuinely differ.
--
-- Convergent rather than merely idempotent:
--
--   nothing recorded yet      record it
--   already Won               ensure the Enrollment and onboarding exist,
--                             then report it was already Won — a sale that
--                             landed halfway is finished, not refused
--   conflicting outcome       fail closed, rewrite nothing
create or replace function public.accept_sale(p_deal_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_already boolean;
  v_enrollments int;
begin
  select * into v_deal from deals where id = p_deal_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- A sale may not overwrite somebody's recorded no, and an archived
  -- Opportunity is not quietly reopened by a click.
  if v_deal.archived_at is not null then
    return jsonb_build_object('status', 'conflicting-outcome',
      'reason', 'This opportunity has been archived.');
  end if;
  if v_deal.outcome is not null then
    return jsonb_build_object('status', 'conflicting-outcome',
      'reason', format('This opportunity already ended as "%s".', v_deal.outcome));
  end if;

  v_already := v_deal.stage = 'won';

  if not v_already then
    -- Permitted because this function runs as its owner, which is what
    -- handle_deal_saved() above is actually checking.
    update deals
       set stage = 'won',
           prospect_decision = 'yes'
     where id = p_deal_id;
  end if;

  -- Either way, the facts a Won sale has must exist. On the transition the
  -- trigger has already made them and this is a no-op; on a sale that
  -- landed halfway it is the repair.
  perform public.ensure_sale_enrollment(p_deal_id);
  select count(*) into v_enrollments from enrollments where opportunity_id = p_deal_id;

  return jsonb_build_object(
    'status', case when v_already then 'already-won' else 'won' end,
    'opportunity_id', p_deal_id,
    'contact_id', v_deal.contact_id,
    'enrollments', v_enrollments
  );
end;
$fn$;

revoke all on function public.accept_sale(bigint) from public;
revoke all on function public.accept_sale(bigint) from anon;
revoke all on function public.accept_sale(bigint) from authenticated;
revoke all on function public.accept_sale(bigint) from service_role;

-- ---------------------------------------------------------------------------
-- 4. THE SALES-CALL WRAPPER
-- ---------------------------------------------------------------------------
-- The call facts are its own; the sale itself goes through accept_sale().
--
-- The convergence rule, and its limit:
--
--   Attendance alone NEVER implies Won. A call marked attended with no
--   outcome stays exactly that until somebody says what happened. What
--   makes this safe is that Leif RESUBMITS the decision — she is not
--   being asked to trust a repair job, she is answering the same question
--   again and this time it lands.
create or replace function public.complete_attended_sales_call(
  p_sales_call_id bigint,
  p_owner_decision text,
  p_prospect_decision text default null,
  p_follow_up_date date default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_call sales_calls%rowtype;
  v_deal deals%rowtype;
  v_now timestamptz := now();
  v_sale jsonb;
  v_follow_up date;
  v_converged boolean := false;
begin
  select * into v_call from sales_calls where id = p_sales_call_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;
  if v_call.opportunity_id is null then
    return jsonb_build_object('status', 'no-opportunity');
  end if;

  if p_owner_decision is null then
    return jsonb_build_object('status', 'validation-error',
      'message', 'An owner-fit decision is required for an attended call.');
  end if;
  if p_owner_decision = 'would_work_with' and p_prospect_decision is null then
    return jsonb_build_object('status', 'validation-error',
      'message', 'A prospect decision is required when Would Work With.');
  end if;

  select * into v_deal from deals where id = v_call.opportunity_id for update;
  if not found then
    return jsonb_build_object('status', 'no-opportunity');
  end if;

  -- A call recorded as a no-show is a different answer to the same
  -- question, and this is not the place to overturn it.
  if v_call.attendance = 'no_show' then
    return jsonb_build_object('status', 'already-completed');
  end if;

  if v_call.attendance is null then
    -- The normal path: the call has not been resolved yet.
    update sales_calls
       set attendance = 'attended',
           attendance_recorded_at = v_now,
           status = 'completed',
           updated_at = v_now
     where id = v_call.id;
  else
    -- Already attended. The question is whether the DECISION landed.
    -- Becky's did not: her call reads attended while her Opportunity sits
    -- at Call Booked with no Enrollment. Resubmitting is how she finishes
    -- it, so this is a convergence rather than a refusal.
    v_converged := true;
    if v_deal.owner_decision is not null
       and v_deal.owner_decision is distinct from p_owner_decision then
      return jsonb_build_object('status', 'conflicting-outcome',
        'reason', format('This call was already recorded as "%s".', v_deal.owner_decision));
    end if;
    if v_deal.prospect_decision is not null
       and p_prospect_decision is not null
       and v_deal.prospect_decision is distinct from p_prospect_decision then
      return jsonb_build_object('status', 'conflicting-outcome',
        'reason', format('This call was already recorded as "%s".', v_deal.prospect_decision));
    end if;
  end if;

  -- The event is part of the call's history, and a sale that landed
  -- halfway may be missing it. Written once, ever.
  if not exists (
    select 1 from sales_call_events
     where sales_call_id = v_call.id and kind = 'attendance_recorded'
  ) then
    insert into sales_call_events (sales_call_id, kind, occurred_at, attendance)
    values (v_call.id, 'attendance_recorded', v_now, 'attended');
  end if;

  if p_owner_decision = 'do_not_engage' then
    if v_deal.outcome is null then
      update deals set owner_decision = 'do_not_engage', outcome = 'lost' where id = v_deal.id;
    end if;
    update contacts set sales_eligibility = 'do_not_engage' where id = v_deal.contact_id;

  elsif p_owner_decision = 'workshops_only' then
    -- A genuine pipeline exit, explicitly not a lost sale.
    if v_deal.outcome is null then
      update deals set owner_decision = 'workshops_only', outcome = 'workshops_only' where id = v_deal.id;
    end if;

  elsif p_prospect_decision = 'yes' then
    update deals set owner_decision = 'would_work_with' where id = v_deal.id;
    v_sale := public.accept_sale(v_deal.id);
    if v_sale ->> 'status' = 'conflicting-outcome' then
      return v_sale;
    end if;

  elsif p_prospect_decision = 'no' then
    if v_deal.outcome is null then
      update deals
         set owner_decision = 'would_work_with', prospect_decision = 'no',
             follow_up_date = null, outcome = 'lost'
       where id = v_deal.id;
    end if;

  else
    v_follow_up := coalesce(p_follow_up_date, (v_now + interval '4 days')::date);
    update deals
       set owner_decision = 'would_work_with', prospect_decision = 'thinking',
           follow_up_date = v_follow_up, stage = 'decision'
     where id = v_deal.id;
  end if;

  select * into v_deal from deals where id = v_deal.id;

  return jsonb_build_object(
    'status', case when v_converged then 'converged' else 'completed' end,
    'opportunity_id', v_deal.id,
    'contact_id', v_deal.contact_id,
    'stage', v_deal.stage,
    'outcome', v_deal.outcome,
    'follow_up_date', v_follow_up,
    'enrollments', (select count(*) from enrollments where opportunity_id = v_deal.id)
  );
end;
$fn$;

revoke all on function public.complete_attended_sales_call(bigint, text, text, date) from public;
revoke all on function public.complete_attended_sales_call(bigint, text, text, date) from anon;
grant execute on function public.complete_attended_sales_call(bigint, text, text, date) to authenticated;
grant execute on function public.complete_attended_sales_call(bigint, text, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 5. THE DECISION WRAPPER
-- ---------------------------------------------------------------------------
-- Serves both Decision surfaces — the Opportunity's own Yes button
-- (recordSalesDecision) and the Dashboard's Deciding card
-- (recordOpportunityDecision). Neither has a call to record, so this is
-- accept_sale() with a public door on it and nothing else.
--
-- Only 'yes' lives here. Declined and Ghosted write `outcome`, which no
-- guard touches, and Ghosted also needs a Contact tag whose colour is a UI
-- fact — they stay in the client where they already work.
create or replace function public.record_prospect_accepted(p_opportunity_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  return public.accept_sale(p_opportunity_id);
end;
$fn$;

revoke all on function public.record_prospect_accepted(bigint) from public;
revoke all on function public.record_prospect_accepted(bigint) from anon;
grant execute on function public.record_prospect_accepted(bigint) to authenticated;
grant execute on function public.record_prospect_accepted(bigint) to service_role;


-- ---------------------------------------------------------------------------
-- 6. PROVE IT
-- ---------------------------------------------------------------------------
-- Every case runs inside a subtransaction that is always unwound: a sale
-- creates an Enrollment, a checklist and Tasks, and undoing the insert is
-- cleaner than trying to take each one back. No real database ever holds a
-- probe row, even momentarily.
do $fn$
declare
  v_offer bigint;
  v_contact bigint; v_deal bigint; v_call bigint;
  v_r jsonb;
  -- verdicts, which survive the unwind because PL/pgSQL variables are not
  -- transactional
  v_normal text; v_normal_enrol int; v_normal_items int; v_normal_stage text;
  v_retry text; v_retry_enrol int;
  v_becky text; v_becky_stage text; v_becky_enrol int; v_becky_items int;
  v_conflict text; v_conflict_stage text;
  v_decision text; v_decision_enrol int;
  v_handedit boolean := false;
  v_legacy boolean := false;
  v_forged boolean := false;
begin
  select id into v_offer from offers where is_active order by id limit 1;
  if v_offer is null then
    return;  -- an empty clean room has nothing to sell
  end if;

  begin
    ---------------------------------------------------------------------
    -- A. attended Sales Call -> Yes, from a normal pre-sale state
    ---------------------------------------------------------------------
    insert into contacts (first_name, last_name) values ('Path','A') returning id into v_contact;
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description)
    values (v_contact, v_offer, 'call_booked', 0, 'other', '') returning id into v_deal;
    insert into sales_calls (opportunity_id, contact_id, scheduled_at, original_scheduled_at, status, source)
    values (v_deal, v_contact, now() - interval '1 day', now() - interval '1 day', 'booked', 'manual')
    returning id into v_call;

    v_r := public.complete_attended_sales_call(v_call, 'would_work_with', 'yes', null);
    v_normal := v_r ->> 'status';
    v_normal_stage := v_r ->> 'stage';
    select count(*) into v_normal_enrol from enrollments where opportunity_id = v_deal;
    select count(*) into v_normal_items from enrollment_onboarding_items i
      join enrollments e on e.id = i.enrollment_id where e.opportunity_id = v_deal;

    -- retry is idempotent: converges, creates nothing twice
    v_r := public.complete_attended_sales_call(v_call, 'would_work_with', 'yes', null);
    v_retry := v_r ->> 'status';
    select count(*) into v_retry_enrol from enrollments where opportunity_id = v_deal;

    ---------------------------------------------------------------------
    -- B. BECKY'S EXACT SHAPE: call attended, Opportunity untouched
    ---------------------------------------------------------------------
    insert into contacts (first_name, last_name) values ('Becky','Shape') returning id into v_contact;
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description)
    values (v_contact, v_offer, 'call_booked', 0, 'other', '') returning id into v_deal;
    insert into sales_calls (opportunity_id, contact_id, scheduled_at, original_scheduled_at,
                             status, source, attendance, attendance_recorded_at)
    values (v_deal, v_contact, now() - interval '1 day', now() - interval '1 day',
            'completed', 'manual', 'attended', now())
    returning id into v_call;
    -- no decision, no outcome, no Enrollment — exactly what she has

    v_r := public.complete_attended_sales_call(v_call, 'would_work_with', 'yes', null);
    v_becky := v_r ->> 'status';
    v_becky_stage := v_r ->> 'stage';
    select count(*) into v_becky_enrol from enrollments where opportunity_id = v_deal;
    select count(*) into v_becky_items from enrollment_onboarding_items i
      join enrollments e on e.id = i.enrollment_id where e.opportunity_id = v_deal;

    ---------------------------------------------------------------------
    -- C. a conflicting outcome fails closed
    ---------------------------------------------------------------------
    insert into contacts (first_name, last_name) values ('Already','Lost') returning id into v_contact;
    insert into deals (contact_id, offer_id, stage, outcome, amount, entry_path, description)
    values (v_contact, v_offer, 'decision', 'lost', 0, 'other', '') returning id into v_deal;
    v_r := public.accept_sale(v_deal);
    v_conflict := v_r ->> 'status';
    select stage into v_conflict_stage from deals where id = v_deal;

    ---------------------------------------------------------------------
    -- D. Decision -> Yes, with no call at all
    ---------------------------------------------------------------------
    insert into contacts (first_name, last_name) values ('Path','D') returning id into v_contact;
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description)
    values (v_contact, v_offer, 'decision', 0, 'other', '') returning id into v_deal;
    v_r := public.record_prospect_accepted(v_deal);
    v_decision := v_r ->> 'status';
    select count(*) into v_decision_enrol from enrollments where opportunity_id = v_deal;

    ---------------------------------------------------------------------
    -- E. a hand-edited stage is still refused, and legacy onboarding too
    ---------------------------------------------------------------------
    insert into contacts (first_name, last_name) values ('Hand','Edit') returning id into v_contact;
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description)
    values (v_contact, v_offer, 'decision', 0, 'other', '') returning id into v_deal;

    set local role authenticated;
    begin
      -- The forgeable design this repair never shipped: a transaction-
      -- local GUC the trigger trusted. A custom GUC is settable by ANY
      -- role, so it was a public credential. Nothing consults it now, so
      -- setting it by hand changes nothing.
      perform set_config('app.sale_authority', 'true', true);
      update deals set stage = 'won' where id = v_deal;
    exception when raise_exception then
      v_forged := sqlerrm like '%cannot be set to Won by editing its stage%';
    end;
    begin
      update deals set stage = 'won' where id = v_deal;
    exception when raise_exception then
      v_handedit := sqlerrm like '%cannot be set to Won by editing its stage%';
    end;
    begin
      update deals set stage = 'onboarding' where id = v_deal;
    exception when others then
      v_legacy := sqlerrm like '%legacy storage%';
    end;
    reset role;

    raise exception 'unwinding the sale proof' using errcode = 'restrict_violation';
  exception when restrict_violation then
    null;
  end;

  -- A
  if v_normal <> 'completed' or v_normal_stage <> 'won' then
    raise exception 'attended yes did not complete: % / %', v_normal, v_normal_stage;
  end if;
  if v_normal_enrol <> 1 then raise exception 'expected 1 Enrollment, got %', v_normal_enrol; end if;
  if v_normal_items < 1 then raise exception 'onboarding was not seeded'; end if;
  if v_retry not in ('converged', 'completed') then
    raise exception 'a retry was not accepted: %', v_retry;
  end if;
  if v_retry_enrol <> 1 then raise exception 'a retry created a second Enrollment'; end if;

  -- B
  if v_becky <> 'converged' or v_becky_stage <> 'won' then
    raise exception 'a Becky-shaped call did not converge: % / %', v_becky, v_becky_stage;
  end if;
  if v_becky_enrol <> 1 then
    raise exception 'convergence did not produce exactly one Enrollment, got %', v_becky_enrol;
  end if;
  if v_becky_items < 1 then raise exception 'convergence did not seed onboarding'; end if;

  -- C
  if v_conflict <> 'conflicting-outcome' then
    raise exception 'a concluded sale was overwritten: %', v_conflict;
  end if;
  if v_conflict_stage = 'won' then raise exception 'a lost sale was rewritten to Won'; end if;

  -- D
  if v_decision <> 'won' then raise exception 'Decision -> Yes did not win: %', v_decision; end if;
  if v_decision_enrol <> 1 then raise exception 'Decision -> Yes made % Enrollments', v_decision_enrol; end if;

  -- E
  if not v_handedit then raise exception 'a hand-edited stage reached Won'; end if;
  if not v_forged then raise exception 'a hand-set app.sale_authority forged a Won write'; end if;
  if not v_legacy then raise exception 'legacy onboarding was accepted as a stage'; end if;
end;
$fn$;
