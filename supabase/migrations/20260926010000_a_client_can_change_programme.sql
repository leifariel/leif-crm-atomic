-- Jenna Smith booked a Growing Yourself Up call and bought The Living Example.
--
-- Her Opportunity says The Living Example. Her onboarding says Growing
-- Yourself Up: "Invite jenna smith to GYU Slack", "Grant jenna smith GYU
-- calendar access", a GYU curriculum item, and four pending Tasks to match.
-- Both halves were written correctly, three minutes apart:
--
--   18:53:34  the sale was accepted while the Opportunity was still GYU, so
--             handle_deal_won() seeded GYU's five requirements and their Tasks
--   then      the offer was changed to LE through the ordinary edit form
--
-- handle_deal_saved() did exactly what it is written to do — refreshed the
-- commercial snapshot, revalidated the offer/cohort pairing, cleared a stale
-- payment option — and nothing else. No trigger reconciles an Enrollment when
-- its Opportunity's offer changes, because there was no such thing as
-- changing programmes: no transfer function, no offer-change event, and no
-- guard stopping a raw offer_id edit on an enrolled client.
--
-- A production scan found exactly one Enrollment in this state, hers.
--
-- This migration builds the missing lifecycle primitive:
--
--   1. a retired status for onboarding requirements, so obsolete work is
--      withdrawn rather than deleted or pretended to be done
--   2. provenance: which offer's template each requirement came from
--   3. deal_offer_events — the append-only history of programme changes,
--      which did not exist
--   4. a guard: once an Enrollment exists, no ordinary client write may move
--      the offer. The UI is not the boundary; this is.
--   5. transfer_enrolled_opportunity_offer() — the one authority, in one
--      transaction
--
-- Historical facts are not rewritten. Jenna's GYU Application and her GYU
-- Acuity sales call stay exactly as they are; what changes is the operational
-- truth that should have followed the sale.

-- ---------------------------------------------------------------------------
-- 1. A REQUIREMENT CAN BE WITHDRAWN
-- ---------------------------------------------------------------------------
-- Not deleted: "we were going to invite her to GYU Slack" is a true thing
-- that happened, and a checklist that quietly loses rows cannot be audited.
-- Not 'done' either — that would claim somebody did the work.
alter table public.enrollment_onboarding_items
  add column if not exists retired_at timestamptz;
alter table public.enrollment_onboarding_items
  add column if not exists retired_from_offer_id bigint;
-- Which offer's template this row came from. Null on every row that predates
-- this migration: their provenance is genuinely unknown, and guessing it from
-- the Opportunity's CURRENT offer is exactly the mistake that produced
-- Jenna's state. Seeding and transfers stamp it from here on.
alter table public.enrollment_onboarding_items
  add column if not exists source_offer_id bigint;

alter table public.enrollment_onboarding_items
  drop constraint if exists enrollment_onboarding_items_retired_from_offer_id_fkey;
alter table public.enrollment_onboarding_items
  add constraint enrollment_onboarding_items_retired_from_offer_id_fkey
  foreign key (retired_from_offer_id) references public.offers(id) on update cascade;
alter table public.enrollment_onboarding_items
  drop constraint if exists enrollment_onboarding_items_source_offer_id_fkey;
alter table public.enrollment_onboarding_items
  add constraint enrollment_onboarding_items_source_offer_id_fkey
  foreign key (source_offer_id) references public.offers(id) on update cascade;

alter table public.enrollment_onboarding_items
  drop constraint if exists enrollment_onboarding_items_status_check;
alter table public.enrollment_onboarding_items
  add constraint enrollment_onboarding_items_status_check
  check (status in ('pending', 'sent', 'done', 'retired'));

-- The pair moves together or not at all, the same shape as
-- deals_payment_setup_pair_check.
alter table public.enrollment_onboarding_items
  drop constraint if exists enrollment_onboarding_items_retired_pair_check;
alter table public.enrollment_onboarding_items
  add constraint enrollment_onboarding_items_retired_pair_check
  check ((status = 'retired') = (retired_at is not null));

comment on column public.enrollment_onboarding_items.retired_at is
  'When this requirement stopped applying — set only by transfer_enrolled_opportunity_offer(). A retired item is history: it never counts toward completion and never surfaces as work.';
comment on column public.enrollment_onboarding_items.source_offer_id is
  'Which offer template this row was seeded from. Null for rows created before programme transfers existed; never inferred from the Opportunity''s current offer.';

-- ---------------------------------------------------------------------------
-- 2. A RETIRED ITEM IS NOT OUTSTANDING WORK
-- ---------------------------------------------------------------------------
-- This trigger treats every status that is not 'done' as outstanding and
-- REOPENS or recreates the item's Task — the projection rule that makes a
-- deleted system Task come back while its condition is live. Retiring an item
-- without teaching it this would have resurrected the very GYU Task the
-- transfer just cancelled.
create or replace function public.sync_task_from_onboarding_item()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_enrollment enrollments%rowtype;
  v_deal deals%rowtype;
  v_contact_name text;
begin
  -- Withdrawn: its Task is withdrawn too, and stays that way.
  --
  -- done_date moves with it because tasks_completion_agreement_check reads it
  -- as "closed at", not "finished at": only pending and waiting Tasks may
  -- have none. Cancelling without it is refused by the database, which is how
  -- this was found.
  if new.status = 'retired' then
    update tasks
       set status = 'cancelled',
           done_date = coalesce(done_date, now())
     where onboarding_item_id = new.id and status <> 'completed';
    return new;
  end if;

  -- Item finished: close its open Task, if it still has one.
  if new.status = 'done' then
    update tasks
       set done_date = coalesce(done_date, coalesce(new.completed_at, now())),
           status = 'completed'
     where onboarding_item_id = new.id and done_date is null;
    return new;
  end if;

  -- Item is outstanding again (or still). One open Task, no more. A
  -- cancelled Task does not count as open: a requirement that comes back
  -- from retirement needs its request back.
  if exists (
    select 1 from tasks
     where onboarding_item_id = new.id
       and done_date is null
       and status <> 'cancelled'
  ) then
    return new;
  end if;

  select * into v_enrollment from enrollments where id = new.enrollment_id;
  if not found then
    return new;
  end if;
  -- A finished client has no outstanding setup work.
  if v_enrollment.status in ('completed', 'withdrawn', 'ended') then
    return new;
  end if;

  select * into v_deal from deals where id = v_enrollment.opportunity_id;

  -- Prefer reopening the Task that already exists over creating a second
  -- record of the same request.
  update tasks
     set done_date = null, status = 'pending'
   where id = (
     select id from tasks
      where onboarding_item_id = new.id
      order by done_date desc nulls first, id desc
      limit 1);
  if found then
    return new;
  end if;

  select nullif(trim(both ' ' from coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
    into v_contact_name from contacts where id = v_deal.contact_id;

  insert into tasks (contact_id, type, text, due_date, status, enrollment_id, onboarding_item_id)
  values (
    v_deal.contact_id,
    'onboarding_item',
    replace(new.task_text_template, '{name}', coalesce(v_contact_name, v_deal.name)),
    now() + interval '3 days',
    'pending',
    new.enrollment_id,
    new.id
  );

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. ACTIVATION AND THE MISSING-CHECKLIST VIEW IGNORE RETIRED ITEMS
-- ---------------------------------------------------------------------------
-- Without this, a transferred client could never be activated: her retired
-- GYU rows would count as required-and-not-done forever.
create or replace function public.enforce_enrollment_activation_requirements()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
declare
  v_required int;
  v_outstanding int;
begin
  if new.status is distinct from 'active' or old.status is not distinct from 'active' then
    return new;
  end if;

  if current_setting('app.migration_mode', true) = 'true' then
    return new;
  end if;

  if new.onboarding_tracking = 'legacy_untracked' then
    return new;
  end if;

  select count(*) filter (where is_required),
         count(*) filter (where is_required and status <> 'done')
    into v_required, v_outstanding
    from enrollment_onboarding_items
   where enrollment_id = new.id
     and status <> 'retired';

  if v_required = 0 then
    raise exception 'Cannot activate enrollment %: it is tracked but has no required onboarding items. Either its Offer has no active onboarding templates, or seeding did not run. An empty checklist is not a finished one.', new.id
      using hint = 'Seed it with seed_enrollment_onboarding(), or record it as legacy_untracked if its onboarding genuinely happened outside the CRM.';
  end if;

  if v_outstanding > 0 then
    raise exception 'Cannot activate enrollment %: % of % required onboarding items are not done', new.id, v_outstanding, v_required;
  end if;

  return new;
end;
$fn$;

create or replace view public.enrollments_missing_onboarding as
 select e.id as enrollment_id,
    e.opportunity_id,
    e.status,
    e.onboarding_tracking,
    d.offer_id,
    ( select count(*) as count
           from onboarding_requirement_templates t
          where t.offer_id = d.offer_id and t.is_active) as active_templates
   from enrollments e
     join deals d on d.id = e.opportunity_id
  where e.onboarding_tracking = 'tracked'::text and not (exists ( select 1
           from enrollment_onboarding_items i
          where i.enrollment_id = e.id and i.is_required and i.status <> 'retired'::text));

-- ---------------------------------------------------------------------------
-- 4. SEEDING RECORDS WHERE EACH REQUIREMENT CAME FROM
-- ---------------------------------------------------------------------------
create or replace function public.seed_enrollment_onboarding(p_enrollment_id bigint, p_due_at timestamp with time zone default (now() + '3 days'::interval))
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_contact_name text;
  v_item record;
  v_seeded int := 0;
begin
  select d.* into v_deal
    from deals d
    join enrollments e on e.opportunity_id = d.id
   where e.id = p_enrollment_id;
  if not found then
    raise exception 'enrollment % does not exist', p_enrollment_id;
  end if;

  select nullif(trim(both ' ' from coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
    into v_contact_name
    from contacts where id = v_deal.contact_id;
  v_contact_name := coalesce(v_contact_name, v_deal.name);

  for v_item in
    insert into enrollment_onboarding_items
      (enrollment_id, requirement_key, label, task_text_template, is_required, sort_order, source_offer_id)
    select p_enrollment_id, t.key, t.label, t.task_text_template, t.is_required, t.sort_order, v_deal.offer_id
      from onboarding_requirement_templates t
     where t.offer_id = v_deal.offer_id and t.is_active
    on conflict (enrollment_id, requirement_key) do nothing
    returning id, is_required
  loop
    v_seeded := v_seeded + 1;
    if v_item.is_required and not exists (
      select 1 from tasks where onboarding_item_id = v_item.id
    ) then
      insert into tasks (contact_id, type, text, due_date, status, enrollment_id, onboarding_item_id)
      select v_deal.contact_id, 'onboarding_item',
             replace(i.task_text_template, '{name}', v_contact_name),
             p_due_at, 'pending', p_enrollment_id, i.id
        from enrollment_onboarding_items i
       where i.id = v_item.id;
    end if;
  end loop;

  return v_seeded;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. THE HISTORY THAT DID NOT EXIST
-- ---------------------------------------------------------------------------
-- Narrow and append-only, the same shape as deal_stage_events and
-- deal_outcome_events: one table per fact, never a general audit log.
-- Reusing deal_outcome_events would have meant writing an offer id into a
-- column called old_outcome.
create table if not exists public.deal_offer_events (
    id bigint generated by default as identity primary key,
    opportunity_id bigint not null,
    -- The Enrollment this moved, when there was one. A pre-Enrollment offer
    -- change stays an ordinary edit and writes no event.
    enrollment_id bigint,
    from_offer_id bigint not null,
    to_offer_id bigint not null,
    occurred_at timestamptz not null default now(),
    recorded_at timestamptz not null default now(),
    source text not null default 'app',
    note text,
    constraint deal_offer_events_offers_differ_check check (from_offer_id <> to_offer_id),
    constraint deal_offer_events_source_check check (source in ('app', 'migration', 'reconstructed'))
);

alter table public.deal_offer_events
  drop constraint if exists deal_offer_events_opportunity_id_fkey;
alter table public.deal_offer_events
  add constraint deal_offer_events_opportunity_id_fkey
  foreign key (opportunity_id) references public.deals(id) on update cascade on delete cascade;
alter table public.deal_offer_events
  drop constraint if exists deal_offer_events_enrollment_id_fkey;
alter table public.deal_offer_events
  add constraint deal_offer_events_enrollment_id_fkey
  foreign key (enrollment_id) references public.enrollments(id) on update cascade on delete set null;
alter table public.deal_offer_events
  drop constraint if exists deal_offer_events_from_offer_id_fkey;
alter table public.deal_offer_events
  add constraint deal_offer_events_from_offer_id_fkey
  foreign key (from_offer_id) references public.offers(id) on update cascade;
alter table public.deal_offer_events
  drop constraint if exists deal_offer_events_to_offer_id_fkey;
alter table public.deal_offer_events
  add constraint deal_offer_events_to_offer_id_fkey
  foreign key (to_offer_id) references public.offers(id) on update cascade;

create index if not exists deal_offer_events_opportunity_idx
  on public.deal_offer_events using btree (opportunity_id);

alter table public.deal_offer_events enable row level security;

drop policy if exists "Enable read for authenticated users" on public.deal_offer_events;
create policy "Enable read for authenticated users" on public.deal_offer_events
  for select to authenticated using (true);

-- Readable by the app, written only by the transfer function (which runs as
-- the owner). No client INSERT grant, exactly like deal_outcome_events.
grant select on public.deal_offer_events to authenticated;
grant select on public.deal_offer_events to service_role;
revoke insert, update, delete on public.deal_offer_events from authenticated;
revoke insert, update, delete on public.deal_offer_events from anon;
grant usage, select on sequence public.deal_offer_events_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 6. AN APPLICATION MAY OUTLIVE THE PROGRAMME IT WAS FOR
-- ---------------------------------------------------------------------------
-- This guard refuses an Application whose offer differs from its
-- Opportunity's, which is right for an ordinary mistake and wrong for Jenna:
-- she genuinely applied to GYU and genuinely bought LE, and her Application
-- must stay GYU. Her Application 109 is currently unwritable for that reason.
-- The disagreement is legal exactly when a transfer explains it.
create or replace function public.enforce_application_opportunity_agreement()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
begin
  if new.opportunity_id is null then
    return new;
  end if;

  select * into v_deal from deals where id = new.opportunity_id;
  if not found then
    raise exception 'Application % points at Opportunity %, which does not exist',
      coalesce(new.id::text, 'new'), new.opportunity_id;
  end if;

  if v_deal.contact_id is distinct from new.contact_id then
    raise exception 'Application % belongs to Contact % but Opportunity % belongs to Contact %',
      coalesce(new.id::text, 'new'), new.contact_id, v_deal.id, v_deal.contact_id;
  end if;

  if v_deal.offer_id is distinct from new.offer_id
     and not exists (
       select 1 from deal_offer_events ev
        where ev.opportunity_id = v_deal.id
          and ev.from_offer_id = new.offer_id
     )
  then
    raise exception 'Application % is for Offer % but Opportunity % is for Offer %; an application cannot belong to a sales attempt for a different programme',
      coalesce(new.id::text, 'new'), new.offer_id, v_deal.id, v_deal.offer_id
      using hint = 'If this client genuinely changed programmes, move them with transfer_enrolled_opportunity_offer() — that records the change and makes the original application legal history.';
  end if;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. ONCE AN ENROLLMENT EXISTS, THE OFFER IS NOT A FORM FIELD
-- ---------------------------------------------------------------------------
-- The boundary is ENROLLMENT EXISTS, not stage Won: an Enrollment is what
-- has downstream state to go stale. Elevation-based, the same unforgeable
-- credential the sale guard uses (20260925120000): current_user is what the
-- caller actually connected as, so a SECURITY DEFINER function running as the
-- owner passes, a direct database or migration connection passes, and an
-- ordinary PostgREST edit does not. A settable GUC would be forgeable — that
-- design was broken by its own security proof once already.
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

    -- An enrolled client's programme is not a form field. Changing it leaves
    -- an Enrollment, an onboarding checklist and its Tasks describing a
    -- programme nobody bought — which is what happened to Jenna Smith, three
    -- minutes after her sale.
    if tg_op = 'UPDATE'
       and new.offer_id is distinct from old.offer_id
       and current_user in ('anon', 'authenticated')
       and exists (select 1 from enrollments where opportunity_id = new.id)
    then
      raise exception 'Opportunity % has an Enrollment: move the client with transfer_enrolled_opportunity_offer() rather than editing the offer, so their onboarding and Tasks follow', new.id;
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
-- 8. THE ONE WAY A CLIENT CHANGES PROGRAMME
-- ---------------------------------------------------------------------------
-- One transaction. Either the Opportunity, the checklist, the Tasks and the
-- history all move together, or none of them does — there is no state where
-- the sale says The Living Example and the onboarding still says GYU.
--
-- What it does to each requirement, by stable KEY rather than by label:
--
--   shared key, done        kept exactly as it is, timestamp intact
--   shared key, pending     updated to the target template's label and task
--                           wording. Nothing fulfilled is erased: it is
--                           pending, so only the request changes
--   old-offer only, done    kept, and marked as belonging to the programme it
--                           was completed under. Never deleted, never
--                           converted into a requirement of the new offer
--   old-offer only, pending retired, and its Task cancelled
--   target only, missing    added, with its Task projected
--
-- Idempotent by construction: a second call finds current_offer = target and
-- returns 'already-on-offer' without writing anything.
create or replace function public.transfer_enrolled_opportunity_offer(
  p_opportunity_id bigint,
  p_to_offer_id bigint,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_offer offers%rowtype;
  v_enrollment enrollments%rowtype;
  v_enrollment_count int;
  v_item record;
  v_retired int := 0;
  v_relabelled int := 0;
  v_added int := 0;
  v_kept int := 0;
  v_kept_historical int := 0;
  v_from_offer_id bigint;
  v_existing_status text;
begin
  select * into v_deal from deals where id = p_opportunity_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  select * into v_offer from offers where id = p_to_offer_id;
  if not found then
    return jsonb_build_object('status', 'invalid-offer');
  end if;

  if v_deal.offer_id = p_to_offer_id then
    -- A replay, a double click, or a stale tab. Nothing to do, and saying so
    -- is not an error.
    return jsonb_build_object('status', 'already-on-offer', 'offer_id', p_to_offer_id);
  end if;

  select count(*) into v_enrollment_count from enrollments where opportunity_id = p_opportunity_id;
  if v_enrollment_count = 0 then
    -- Nothing downstream exists yet, so an ordinary edit is the right tool and
    -- is still allowed. Refusing here keeps this function honest about what it
    -- is for.
    return jsonb_build_object('status', 'no-enrollment');
  end if;
  if v_enrollment_count > 1 then
    -- Structurally impossible today (enrollments.opportunity_id is unique),
    -- and if it ever becomes possible this must not guess which one moves.
    return jsonb_build_object('status', 'ambiguous-enrollment', 'enrollments', v_enrollment_count);
  end if;

  select * into v_enrollment from enrollments where opportunity_id = p_opportunity_id for update;

  -- A group programme needs a round, and this function does not pick one.
  if v_offer.type = 'group' then
    return jsonb_build_object(
      'status', 'needs-cohort',
      'reason', format('%s is a group programme: choose the round before moving a client into it', v_offer.name)
    );
  end if;
  -- Leaving a group programme means leaving its round behind.
  v_from_offer_id := v_deal.offer_id;

  -- ---- the Opportunity itself --------------------------------------------
  -- handle_deal_saved() refreshes the commercial snapshot and revalidates the
  -- pairing; its enrolled-client guard lets this through because this function
  -- runs as the owner, not as the caller.
  update deals
     set offer_id = p_to_offer_id,
         cohort_id = case when v_offer.type = 'group' then cohort_id else null end
   where id = p_opportunity_id;

  -- ---- requirements that no longer apply ---------------------------------
  for v_item in
    select i.* from enrollment_onboarding_items i
     where i.enrollment_id = v_enrollment.id
       and i.status <> 'retired'
       and not exists (
         select 1 from onboarding_requirement_templates t
          where t.offer_id = p_to_offer_id and t.is_active and t.key = i.requirement_key
       )
  loop
    if v_item.status = 'done' then
      -- Completed work under the old programme is history, not a requirement
      -- of the new one. Kept as it is, with its provenance made explicit.
      -- Completed work that belongs only to the old programme. Provenance is
      -- known here too — it is not a requirement of the new one — and saying
      -- so is what keeps it readable as history rather than as a stray row.
      update enrollment_onboarding_items
         set source_offer_id = coalesce(source_offer_id, v_from_offer_id),
             updated_at = now()
       where id = v_item.id;
      v_kept_historical := v_kept_historical + 1;
    else
      -- Retiring one IS a moment where provenance is known: the requirement
      -- exists on the programme being left and not on the one being joined, so
      -- the offer it came from is the offer we are leaving. Filled only when
      -- the row does not already say.
      update enrollment_onboarding_items
         set status = 'retired',
             retired_at = now(),
             retired_from_offer_id = v_from_offer_id,
             source_offer_id = coalesce(source_offer_id, v_from_offer_id),
             updated_at = now()
       where id = v_item.id;
      v_retired := v_retired + 1;
    end if;
  end loop;

  -- ---- requirements the target programme shares or adds -------------------
  for v_item in
    select t.* from onboarding_requirement_templates t
     where t.offer_id = p_to_offer_id and t.is_active
  loop
    select status into v_existing_status
      from enrollment_onboarding_items
     where enrollment_id = v_enrollment.id and requirement_key = v_item.key;

    if v_existing_status is not null then
      -- Shared key. A done item keeps everything, including its wording: it
      -- describes what was actually done. A pending one is only a request, so
      -- it becomes the target's request.
      update enrollment_onboarding_items
         set label = case when v_existing_status = 'done' then label else v_item.label end,
             task_text_template = case when v_existing_status = 'done' then task_text_template else v_item.task_text_template end,
             is_required = v_item.is_required,
             sort_order = v_item.sort_order,
             -- A requirement coming back from retirement (a move back to the
             -- programme it belonged to) becomes real work again.
             status = case when v_existing_status = 'retired' then 'pending' else status end,
             retired_at = case when v_existing_status = 'retired' then null else retired_at end,
             retired_from_offer_id = case when v_existing_status = 'retired' then null else retired_from_offer_id end,
             -- Provenance, said only where it is known:
             --
             --   done      LEFT ALONE, including null. A shared requirement
             --             that is already finished is the same requirement in
             --             both programmes — "contract" is contract — so the
             --             Opportunity having once been GYU says nothing about
             --             where THIS row came from. Stamping it would invent a
             --             fact about completed work.
             --   otherwise the target template, which is now genuinely where
             --             this requirement comes from. Re-pointing a pending
             --             row is a change of request, not a claim about
             --             history; the transfer event carries the history.
             source_offer_id = case when v_existing_status = 'done' then source_offer_id else p_to_offer_id end,
             updated_at = now()
       where enrollment_id = v_enrollment.id
         and requirement_key = v_item.key;

      if v_existing_status = 'done' then
        v_kept := v_kept + 1;
      else
        v_relabelled := v_relabelled + 1;
      end if;
    else
      insert into enrollment_onboarding_items
        (enrollment_id, requirement_key, label, task_text_template, is_required, sort_order, source_offer_id)
      values (v_enrollment.id, v_item.key, v_item.label, v_item.task_text_template,
              v_item.is_required, v_item.sort_order, p_to_offer_id);
      v_added := v_added + 1;
    end if;
  end loop;

  -- ---- every outstanding requirement has exactly one open Task -----------
  -- The relabelled ones need their wording corrected; the added ones need a
  -- Task at all. sync_task_from_onboarding_item() creates on insert, so this
  -- only repairs text and fills genuine gaps.
  update tasks t
     set text = replace(i.task_text_template, '{name}',
                        coalesce(nullif(trim(both ' ' from coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), v_deal.name))
    from enrollment_onboarding_items i
    join contacts c on c.id = v_deal.contact_id
   where t.onboarding_item_id = i.id
     and i.enrollment_id = v_enrollment.id
     and i.status not in ('done', 'retired')
     and t.status = 'pending';

  insert into tasks (contact_id, type, text, due_date, status, enrollment_id, onboarding_item_id)
  select v_deal.contact_id, 'onboarding_item',
         replace(i.task_text_template, '{name}',
                 coalesce(nullif(trim(both ' ' from coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), v_deal.name)),
         now() + interval '3 days', 'pending', v_enrollment.id, i.id
    from enrollment_onboarding_items i
    join contacts c on c.id = v_deal.contact_id
   where i.enrollment_id = v_enrollment.id
     and i.is_required
     and i.status not in ('done', 'retired')
     and not exists (
       select 1 from tasks tk
        where tk.onboarding_item_id = i.id
          and tk.status not in ('completed', 'cancelled')
     );

  -- ---- the history this never had ----------------------------------------
  insert into deal_offer_events (opportunity_id, enrollment_id, from_offer_id, to_offer_id, source, note)
  values (p_opportunity_id, v_enrollment.id, v_from_offer_id, p_to_offer_id, 'app', p_note);

  return jsonb_build_object(
    'status', 'transferred',
    'opportunity_id', p_opportunity_id,
    'enrollment_id', v_enrollment.id,
    'from_offer_id', v_from_offer_id,
    'to_offer_id', p_to_offer_id,
    'retired', v_retired,
    'relabelled', v_relabelled,
    'added', v_added,
    'kept_done', v_kept,
    'kept_historical', v_kept_historical,
    -- sync_task_from_onboarding_item() cancelled these as each item retired.
    'cancelled_tasks', (
      select count(*) from tasks tk
        join enrollment_onboarding_items i on i.id = tk.onboarding_item_id
       where i.enrollment_id = v_enrollment.id
         and i.status = 'retired'
         and tk.status = 'cancelled'
    ),
    'required_outstanding', (
      select count(*) from enrollment_onboarding_items
       where enrollment_id = v_enrollment.id and is_required
         and status not in ('done', 'retired')
    ),
    'required_total', (
      select count(*) from enrollment_onboarding_items
       where enrollment_id = v_enrollment.id and is_required and status <> 'retired'
    )
  );
end;
$fn$;

revoke all on function public.transfer_enrolled_opportunity_offer(bigint, bigint, text) from public;
revoke all on function public.transfer_enrolled_opportunity_offer(bigint, bigint, text) from anon;
grant execute on function public.transfer_enrolled_opportunity_offer(bigint, bigint, text) to authenticated;
grant execute on function public.transfer_enrolled_opportunity_offer(bigint, bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. A CANCELLED TASK IS NOT A FINISHED ONE
-- ---------------------------------------------------------------------------
-- The two projections point at each other: retiring a requirement cancels its
-- Task, and closing a Task marks its requirement done. Together they turned
-- "we are not doing this any more" into "somebody did this" — the retired
-- Slack and Calendar requirements came back as COMPLETED work, caught by
-- enrollment_onboarding_items_retired_pair_check while proving this migration.
--
-- done_date is when a Task CLOSED, which a cancellation also is. Only a
-- completed Task means the work happened.
create or replace function public.sync_onboarding_item_from_task()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if new.onboarding_item_id is null then
    return new;
  end if;

  if new.done_date is not null and old.done_date is null and new.status = 'completed' then
    update enrollment_onboarding_items
      set status = 'done', completed_at = coalesce(completed_at, new.done_date), updated_at = now()
      where id = new.onboarding_item_id and status not in ('done', 'retired');
  elsif new.done_date is null and old.done_date is not null then
    -- Reopened. A retired requirement is not reopened by its Task coming
    -- back: only another transfer brings it back.
    update enrollment_onboarding_items
      set status = 'pending', completed_at = null, updated_at = now()
      where id = new.onboarding_item_id and status = 'done';
  end if;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. PROOF, ON JENNA'S EXACT SHAPE, LEAVING NO ROWS BEHIND
-- ---------------------------------------------------------------------------
-- Builds a GYU client the way the app does — sold through the canonical path,
-- so her Enrollment and its five GYU requirements are real — then moves her to
-- The Living Example and checks every claim this migration makes. The whole
-- fixture is unwound by a sentinel exception, because a proof that leaves
-- rows behind is a data change pretending to be a test.
do $fn$
declare
  v_contact bigint;
  v_deal bigint;
  v_enrollment bigint;
  v_result jsonb;
  v_replay jsonb;
  v_gyu_items int;
  v_after_required int;
  v_after_done int;
  v_retired int;
  v_cancelled int;
  v_curriculum text;
  v_curriculum_task text;
  v_notion int;
  v_meditation text;
  v_contract_done timestamptz;
  v_contract_after timestamptz;
  v_events int;
  v_events_after_replay int;
  v_enrollments int;
  v_raw_edit_refused boolean := false;
  v_app_ok boolean := false;
  v_slack_source bigint;
  v_curriculum_source bigint;
  v_meditation_source bigint;
  v_notion_source bigint;
  v_contract_source bigint;
begin
  begin
    insert into contacts (first_name, last_name) values ('Proof', 'Transfer') returning id into v_contact;
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, 2, 'call_booked', 1400, 'other', '', 0) returning id into v_deal;

    -- Her historical GYU application, which must survive untouched.
    insert into applications (contact_id, offer_id, opportunity_id, status, source, submitted_at)
    values (v_contact, 2, v_deal, 'approved', 'public_form', now() - interval '30 days');

    perform public.accept_sale(v_deal);
    select id into v_enrollment from enrollments where opportunity_id = v_deal;
    select count(*) into v_gyu_items from enrollment_onboarding_items where enrollment_id = v_enrollment;

    -- Contract signed under GYU, exactly like Jenna's — and with its
    -- provenance erased, exactly like hers: every production row was seeded
    -- before source_offer_id existed, so it genuinely does not know where it
    -- came from. That unknown must survive the transfer rather than being
    -- filled in with a plausible guess.
    update enrollment_onboarding_items
       set status = 'done', completed_at = now() - interval '1 hour',
           source_offer_id = null
     where enrollment_id = v_enrollment and requirement_key = 'contract';
    select completed_at into v_contract_done
      from enrollment_onboarding_items
     where enrollment_id = v_enrollment and requirement_key = 'contract';

    -- An ordinary authenticated edit must not be able to move her.
    set local role authenticated;
    begin
      update deals set offer_id = 1 where id = v_deal;
    exception when others then
      v_raw_edit_refused := sqlerrm like '%transfer_enrolled_opportunity_offer%';
    end;
    reset role;

    v_result := public.transfer_enrolled_opportunity_offer(v_deal, 1, 'proof');
    v_replay := public.transfer_enrolled_opportunity_offer(v_deal, 1, 'proof again');

    select count(*) into v_enrollments from enrollments where opportunity_id = v_deal;
    select count(*) filter (where is_required and status <> 'retired'),
           count(*) filter (where is_required and status = 'done'),
           count(*) filter (where status = 'retired')
      into v_after_required, v_after_done, v_retired
      from enrollment_onboarding_items where enrollment_id = v_enrollment;

    select count(*) into v_cancelled
      from tasks tk join enrollment_onboarding_items i on i.id = tk.onboarding_item_id
     where i.enrollment_id = v_enrollment and i.status = 'retired' and tk.status = 'cancelled';

    select label into v_curriculum from enrollment_onboarding_items
     where enrollment_id = v_enrollment and requirement_key = 'curriculum_access';
    select text into v_curriculum_task from tasks tk
      join enrollment_onboarding_items i on i.id = tk.onboarding_item_id
     where i.enrollment_id = v_enrollment and i.requirement_key = 'curriculum_access'
       and tk.status = 'pending';
    select count(*) into v_notion from enrollment_onboarding_items
     where enrollment_id = v_enrollment and requirement_key = 'notion_access';
    select status into v_meditation from enrollment_onboarding_items
     where enrollment_id = v_enrollment and requirement_key = 'meditation_library_access';
    select completed_at into v_contract_after
      from enrollment_onboarding_items
     where enrollment_id = v_enrollment and requirement_key = 'contract';

    -- Provenance, said only where it is known. The fixture deliberately has
    -- none to begin with, exactly like every production row seeded before the
    -- column existed.
    select source_offer_id into v_slack_source from enrollment_onboarding_items
     where enrollment_id = v_enrollment and requirement_key = 'slack_access';
    select source_offer_id into v_curriculum_source from enrollment_onboarding_items
     where enrollment_id = v_enrollment and requirement_key = 'curriculum_access';
    select source_offer_id into v_meditation_source from enrollment_onboarding_items
     where enrollment_id = v_enrollment and requirement_key = 'meditation_library_access';
    select source_offer_id into v_notion_source from enrollment_onboarding_items
     where enrollment_id = v_enrollment and requirement_key = 'notion_access';
    select source_offer_id into v_contract_source from enrollment_onboarding_items
     where enrollment_id = v_enrollment and requirement_key = 'contract';

    select count(*) into v_events from deal_offer_events where opportunity_id = v_deal;
    v_events_after_replay := v_events;

    -- Her GYU application is still GYU, and still writable now that a
    -- transfer explains the disagreement.
    begin
      update applications set status = 'approved' where opportunity_id = v_deal;
      v_app_ok := true;
    exception when others then
      v_app_ok := false;
    end;

    raise exception 'unwinding the transfer proof' using errcode = 'restrict_violation';
  exception when restrict_violation then
    null;
  end;

  if v_gyu_items <> 5 then
    raise exception 'the GYU fixture did not seed 5 requirements, got %', v_gyu_items;
  end if;
  if not v_raw_edit_refused then
    raise exception 'an ordinary authenticated edit moved an enrolled client''s offer';
  end if;
  if v_result ->> 'status' <> 'transferred' then
    raise exception 'the transfer did not happen: %', v_result;
  end if;
  if v_replay ->> 'status' <> 'already-on-offer' then
    raise exception 'a replayed transfer was not a no-op: %', v_replay;
  end if;
  if v_enrollments <> 1 then
    raise exception 'the transfer changed the Enrollment count to %', v_enrollments;
  end if;
  if v_after_required <> 4 then
    raise exception 'expected 4 live required requirements after the move, got %', v_after_required;
  end if;
  if v_after_done <> 1 then
    raise exception 'expected exactly 1 done (the contract), got %', v_after_done;
  end if;
  if v_retired <> 2 then
    raise exception 'expected slack_access and calendar_access retired, got % retired', v_retired;
  end if;
  if v_cancelled <> 2 then
    raise exception 'retired requirements left % cancelled Tasks, expected 2', v_cancelled;
  end if;
  if v_curriculum <> 'Living Example curriculum access' then
    raise exception 'curriculum_access was not relabelled: %', v_curriculum;
  end if;
  if v_curriculum_task is null or v_curriculum_task like '%GYU%' then
    raise exception 'the curriculum Task still asks for GYU: %', v_curriculum_task;
  end if;
  if v_notion <> 1 then
    raise exception 'notion_access was not added exactly once, got %', v_notion;
  end if;
  if v_meditation <> 'pending' then
    raise exception 'meditation_library_access should still be pending, is %', v_meditation;
  end if;
  if v_contract_after is distinct from v_contract_done then
    raise exception 'the contract completion timestamp moved: % -> %', v_contract_done, v_contract_after;
  end if;
  if v_events <> 1 or v_events_after_replay <> 1 then
    raise exception 'expected exactly one transfer event, got % (% after replay)', v_events, v_events_after_replay;
  end if;
  if not v_app_ok then
    raise exception 'the historical GYU application became unwritable after the transfer';
  end if;
  if v_slack_source is distinct from 2 then
    raise exception 'a retired requirement did not name the programme it came from: %', v_slack_source;
  end if;
  if v_curriculum_source is distinct from 1 then
    raise exception 'the re-pointed curriculum requirement does not name its new programme: %', v_curriculum_source;
  end if;
  if v_meditation_source is distinct from 1 then
    raise exception 'the shared pending requirement does not name its new programme: %', v_meditation_source;
  end if;
  if v_notion_source is distinct from 1 then
    raise exception 'the added requirement does not name the programme that asked for it: %', v_notion_source;
  end if;
  -- And the one place nothing is known: a shared requirement already done,
  -- whose provenance was never recorded. Contract is contract in both
  -- programmes, so the Opportunity having been GYU says nothing about this row.
  if v_contract_source is not null then
    raise exception 'provenance was invented for completed shared work: %', v_contract_source;
  end if;
end;
$fn$;
