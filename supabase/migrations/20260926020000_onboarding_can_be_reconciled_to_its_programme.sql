-- ===========================================================================
-- Onboarding can be reconciled to the programme its Opportunity already names
-- ===========================================================================
--
-- Jenna Smith's Opportunity was edited from Growing Yourself Up to The Living
-- Example three minutes after the sale, long before any guard existed. The
-- offer moved; her onboarding did not. 20260926010000 made that
-- un-creatable — once an Enrollment exists the offer is not a form field —
-- and gave a real programme change its one authority.
--
-- That authority cannot repair her, and it should not pretend to.
-- transfer_enrolled_opportunity_offer(188, <LE>) correctly answers
-- 'already-on-offer': her Opportunity IS on The Living Example. Only the
-- downstream projection is stale. Those are two different facts about a
-- client, and they need two different authorities:
--
--   transfer    the Opportunity's offer changes, A -> B, and everything
--               downstream follows it in one transaction
--   reconcile   the Opportunity already carries the intended offer; the
--               Enrollment's projection does not match it, and is brought
--               into line WITHOUT touching the Opportunity
--
-- What happens to each requirement is decided by the same rules in both, and
-- those rules are now written exactly once, in
-- apply_enrollment_onboarding_projection(). A later change to how a shared key
-- is re-pointed, or how an obsolete pending requirement retires, cannot make
-- transfer and reconcile drift apart, because there is only one body to
-- change.
--
-- What this migration does NOT do is repair Jenna. She is the production
-- acceptance case: the repair is a click Leif makes with the result in front
-- of him, not a migration that rewrites a real client while nobody is
-- looking. Detection is deterministic and automatic; the repair is a
-- decision, and naming the programme she came FROM is part of the decision.

-- ---------------------------------------------------------------------------
-- 1. AN UNKNOWN TIME IS NOT A TIME
-- ---------------------------------------------------------------------------
-- deal_offer_events already separates occurred_at (when the programme changed)
-- from recorded_at (when this row was written), and already has a
-- 'reconstructed' source for a fact established after the event. What it did
-- not have was a way to say "this happened before anyone was recording, and
-- nothing anywhere says when". A reconstructed event may leave occurred_at
-- null rather than borrow the repair's own clock: Jenna's offer edit happened
-- on some day in September that no table recorded, and now() is not that day.
alter table public.deal_offer_events
  alter column occurred_at drop not null;

alter table public.deal_offer_events
  drop constraint if exists deal_offer_events_occurred_at_known_check;
alter table public.deal_offer_events
  add constraint deal_offer_events_occurred_at_known_check
  check (occurred_at is not null or source = 'reconstructed');

comment on column public.deal_offer_events.occurred_at is
  'When the programme change itself happened. Null only for a reconstructed event whose original moment nothing recorded — never the repair time standing in for it. recorded_at is always when this row was written.';

-- ---------------------------------------------------------------------------
-- 2. THE PROJECTION, WRITTEN ONCE
-- ---------------------------------------------------------------------------
-- Everything that happens to an Enrollment's checklist when the programme it
-- answers to is p_to_offer_id, lifted verbatim out of
-- transfer_enrolled_opportunity_offer() so that transfer and reconcile cannot
-- hold different opinions about it.
--
-- Decided by the stable KEY, never the label: "curriculum_access" exists in
-- both programmes and means a different thing in each, which is exactly why
-- the label cannot be the identity.
--
--   shared key, done        kept exactly as it is, wording and timestamp
--                           intact — it describes work that was really done
--   shared key, pending     updated to the target's label and task wording.
--                           Nothing fulfilled is erased: it is pending, so
--                           only the request changes
--   shared key, retired     comes back as real work (a move back to the
--                           programme it belonged to)
--   old-offer only, done    kept, and marked as belonging to the programme it
--                           was completed under. Never deleted, never
--                           converted into a requirement of the new offer
--   old-offer only, pending retired, and its Task cancelled by
--                           sync_task_from_onboarding_item()
--   target only, missing    added once, with its Task projected
--
-- Internal: no client may call this directly, because on its own it would
-- move a checklist without either the offer change or the decision that
-- justifies it. Only the two wrappers below, which run as the owner.
create or replace function public.apply_enrollment_onboarding_projection(
  p_enrollment_id bigint,
  p_from_offer_id bigint,
  p_to_offer_id bigint
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_item record;
  v_retired int := 0;
  v_relabelled int := 0;
  v_added int := 0;
  v_kept int := 0;
  v_kept_historical int := 0;
  v_existing_status text;
begin
  select d.* into v_deal
    from deals d
    join enrollments e on e.opportunity_id = d.id
   where e.id = p_enrollment_id;
  if not found then
    raise exception 'apply_enrollment_onboarding_projection: enrollment % has no Opportunity', p_enrollment_id;
  end if;

  -- ---- requirements that no longer apply ---------------------------------
  for v_item in
    select i.* from enrollment_onboarding_items i
     where i.enrollment_id = p_enrollment_id
       and i.status <> 'retired'
       and not exists (
         select 1 from onboarding_requirement_templates t
          where t.offer_id = p_to_offer_id and t.is_active and t.key = i.requirement_key
       )
  loop
    if v_item.status = 'done' then
      -- Completed work that belongs only to the old programme. Provenance is
      -- known here — it is not a requirement of the new one — and saying so is
      -- what keeps it readable as history rather than as a stray row.
      update enrollment_onboarding_items
         set source_offer_id = coalesce(source_offer_id, p_from_offer_id),
             updated_at = now()
       where id = v_item.id;
      v_kept_historical := v_kept_historical + 1;
    else
      -- Retiring one IS a moment where provenance is known: the requirement
      -- exists on the programme being left and not on the one being joined, so
      -- the offer it came from is the offer being left. Filled only where the
      -- row does not already say.
      update enrollment_onboarding_items
         set status = 'retired',
             retired_at = now(),
             retired_from_offer_id = p_from_offer_id,
             source_offer_id = coalesce(source_offer_id, p_from_offer_id),
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
     where enrollment_id = p_enrollment_id and requirement_key = v_item.key;

    if v_existing_status is not null then
      update enrollment_onboarding_items
         set label = case when v_existing_status = 'done' then label else v_item.label end,
             task_text_template = case when v_existing_status = 'done' then task_text_template else v_item.task_text_template end,
             is_required = v_item.is_required,
             sort_order = v_item.sort_order,
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
             --             history; the event carries the history.
             source_offer_id = case when v_existing_status = 'done' then source_offer_id else p_to_offer_id end,
             updated_at = now()
       where enrollment_id = p_enrollment_id
         and requirement_key = v_item.key;

      if v_existing_status = 'done' then
        v_kept := v_kept + 1;
      else
        v_relabelled := v_relabelled + 1;
      end if;
    else
      insert into enrollment_onboarding_items
        (enrollment_id, requirement_key, label, task_text_template, is_required, sort_order, source_offer_id)
      values (p_enrollment_id, v_item.key, v_item.label, v_item.task_text_template,
              v_item.is_required, v_item.sort_order, p_to_offer_id);
      v_added := v_added + 1;
    end if;
  end loop;

  -- ---- every outstanding requirement has exactly one open Task -----------
  -- The relabelled ones need their wording corrected; the added ones need a
  -- Task at all. sync_task_from_onboarding_item() creates on insert, so this
  -- only repairs text and fills genuine gaps — it never opens a second Task
  -- for a requirement that already has one.
  update tasks t
     set text = replace(i.task_text_template, '{name}',
                        coalesce(nullif(trim(both ' ' from coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), v_deal.name))
    from enrollment_onboarding_items i
    join contacts c on c.id = v_deal.contact_id
   where t.onboarding_item_id = i.id
     and i.enrollment_id = p_enrollment_id
     and i.status not in ('done', 'retired')
     and t.status = 'pending';

  insert into tasks (contact_id, type, text, due_date, status, enrollment_id, onboarding_item_id)
  select v_deal.contact_id, 'onboarding_item',
         replace(i.task_text_template, '{name}',
                 coalesce(nullif(trim(both ' ' from coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), v_deal.name)),
         now() + interval '3 days', 'pending', p_enrollment_id, i.id
    from enrollment_onboarding_items i
    join contacts c on c.id = v_deal.contact_id
   where i.enrollment_id = p_enrollment_id
     and i.is_required
     and i.status not in ('done', 'retired')
     and not exists (
       select 1 from tasks tk
        where tk.onboarding_item_id = i.id
          and tk.status not in ('completed', 'cancelled')
     );

  return jsonb_build_object(
    'retired', v_retired,
    'relabelled', v_relabelled,
    'added', v_added,
    'kept_done', v_kept,
    'kept_historical', v_kept_historical,
    -- sync_task_from_onboarding_item() cancelled these as each item retired.
    'cancelled_tasks', (
      select count(*) from tasks tk
        join enrollment_onboarding_items i on i.id = tk.onboarding_item_id
       where i.enrollment_id = p_enrollment_id
         and i.status = 'retired'
         and tk.status = 'cancelled'
    ),
    'required_outstanding', (
      select count(*) from enrollment_onboarding_items
       where enrollment_id = p_enrollment_id and is_required
         and status not in ('done', 'retired')
    ),
    'required_total', (
      select count(*) from enrollment_onboarding_items
       where enrollment_id = p_enrollment_id and is_required and status <> 'retired'
    )
  );
end;
$fn$;

revoke all on function public.apply_enrollment_onboarding_projection(bigint, bigint, bigint) from public;
revoke all on function public.apply_enrollment_onboarding_projection(bigint, bigint, bigint) from anon;
revoke all on function public.apply_enrollment_onboarding_projection(bigint, bigint, bigint) from authenticated;
revoke all on function public.apply_enrollment_onboarding_projection(bigint, bigint, bigint) from service_role;

-- ---------------------------------------------------------------------------
-- 3. IS THIS CHECKLIST THE PROGRAMME'S?
-- ---------------------------------------------------------------------------
-- Deterministic, and deliberately about keys alone: the live requirement keys
-- and the offer's active template keys are the same set. Retired rows are
-- history and do not count. Labels and ordering do not enter into it, because
-- the key is the identity — this is the same question the dialog asks before
-- it offers to repair anything.
create or replace function public.enrollment_onboarding_matches_offer(
  p_enrollment_id bigint,
  p_offer_id bigint
) returns boolean
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select not exists (
      select 1
        from enrollment_onboarding_items i
       where i.enrollment_id = p_enrollment_id
         and i.status <> 'retired'
         and not exists (
           select 1 from onboarding_requirement_templates t
            where t.offer_id = p_offer_id and t.is_active and t.key = i.requirement_key
         )
    )
    and not exists (
      select 1
        from onboarding_requirement_templates t
       where t.offer_id = p_offer_id and t.is_active
         and not exists (
           select 1 from enrollment_onboarding_items i
            where i.enrollment_id = p_enrollment_id
              and i.status <> 'retired'
              and i.requirement_key = t.key
         )
    );
$fn$;

revoke all on function public.enrollment_onboarding_matches_offer(bigint, bigint) from public;
revoke all on function public.enrollment_onboarding_matches_offer(bigint, bigint) from anon;
grant execute on function public.enrollment_onboarding_matches_offer(bigint, bigint) to authenticated;
grant execute on function public.enrollment_onboarding_matches_offer(bigint, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 4. THE TRANSFER NOW SHARES THAT ONE BODY
-- ---------------------------------------------------------------------------
-- Identical external contract, identical return shape, identical refusals —
-- only the projection moved out from under it.
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
  v_from_offer_id bigint;
  v_counts jsonb;
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
    -- is not an error. It is also the honest answer for a client whose
    -- Opportunity was already edited before the guard existed: the offer is
    -- right and only the checklist is stale, which is
    -- reconcile_enrollment_to_current_offer()'s question, not this one.
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

  v_counts := public.apply_enrollment_onboarding_projection(
    v_enrollment.id, v_from_offer_id, p_to_offer_id
  );

  -- ---- the history this never had ----------------------------------------
  -- occurred_at is now(), because the change is happening now.
  insert into deal_offer_events (opportunity_id, enrollment_id, from_offer_id, to_offer_id, source, note)
  values (p_opportunity_id, v_enrollment.id, v_from_offer_id, p_to_offer_id, 'app', p_note);

  return jsonb_build_object(
    'status', 'transferred',
    'opportunity_id', p_opportunity_id,
    'enrollment_id', v_enrollment.id,
    'from_offer_id', v_from_offer_id,
    'to_offer_id', p_to_offer_id
  ) || v_counts;
end;
$fn$;

revoke all on function public.transfer_enrolled_opportunity_offer(bigint, bigint, text) from public;
revoke all on function public.transfer_enrolled_opportunity_offer(bigint, bigint, text) from anon;
grant execute on function public.transfer_enrolled_opportunity_offer(bigint, bigint, text) to authenticated;
grant execute on function public.transfer_enrolled_opportunity_offer(bigint, bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. RECONCILING A STALE PROJECTION TO THE OFFER ALREADY ON THE OPPORTUNITY
-- ---------------------------------------------------------------------------
-- The Opportunity is not touched. Only the projection moves, and only when it
-- genuinely does not match.
--
-- p_from_offer_id is the programme the stale requirements came FROM, and it is
-- Leif's statement, not an inference: this function will refuse a claim that
-- the requirements themselves contradict, and refuse to proceed at all when a
-- foreign programme is involved and nobody has named it. Where no foreign
-- requirement exists — a template that merely gained a requirement since
-- seeding — there is no programme change to record and naming one is refused
-- instead of written.
create or replace function public.reconcile_enrollment_to_current_offer(
  p_opportunity_id bigint,
  p_from_offer_id bigint default null,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_enrollment enrollments%rowtype;
  v_enrollment_count int;
  v_from_offer offers%rowtype;
  v_foreign_keys text[];
  v_unclaimed text[];
  v_counts jsonb;
begin
  select * into v_deal from deals where id = p_opportunity_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  if p_from_offer_id is not null then
    select * into v_from_offer from offers where id = p_from_offer_id;
    if not found then
      return jsonb_build_object('status', 'invalid-offer');
    end if;
    if p_from_offer_id = v_deal.offer_id then
      -- "It came from the programme it is already on" says nothing, and
      -- deal_offer_events would refuse it too.
      return jsonb_build_object('status', 'same-offer', 'offer_id', p_from_offer_id);
    end if;
  end if;

  select count(*) into v_enrollment_count from enrollments where opportunity_id = p_opportunity_id;
  if v_enrollment_count = 0 then
    -- There is no projection to reconcile. An ordinary offer edit is still
    -- available for an Opportunity with nothing downstream.
    return jsonb_build_object('status', 'no-enrollment');
  end if;
  if v_enrollment_count > 1 then
    return jsonb_build_object('status', 'ambiguous-enrollment', 'enrollments', v_enrollment_count);
  end if;

  select * into v_enrollment from enrollments where opportunity_id = p_opportunity_id for update;

  -- A finished client's record is history. Reopening their checklist because
  -- a template disagrees with it would rewrite what their programme was.
  if v_enrollment.status in ('completed', 'withdrawn', 'ended') then
    return jsonb_build_object(
      'status', 'terminal-enrollment',
      'enrollment_status', v_enrollment.status
    );
  end if;

  if public.enrollment_onboarding_matches_offer(v_enrollment.id, v_deal.offer_id) then
    -- Nothing is stale. A second click, a stale tab, or a client who was
    -- always aligned: all three deserve the same quiet answer.
    return jsonb_build_object(
      'status', 'already-aligned',
      'enrollment_id', v_enrollment.id,
      'offer_id', v_deal.offer_id
    );
  end if;

  -- The live requirements the current programme does not have. These are the
  -- evidence that another programme's template is in play.
  select coalesce(array_agg(i.requirement_key order by i.requirement_key), '{}')
    into v_foreign_keys
    from enrollment_onboarding_items i
   where i.enrollment_id = v_enrollment.id
     and i.status <> 'retired'
     and not exists (
       select 1 from onboarding_requirement_templates t
        where t.offer_id = v_deal.offer_id and t.is_active and t.key = i.requirement_key
     );

  if array_length(v_foreign_keys, 1) is null then
    -- Only missing requirements, no foreign ones: the current programme's
    -- template gained something since this client was seeded. Reconciling that
    -- is right; calling it a programme change is not.
    if p_from_offer_id is not null then
      return jsonb_build_object(
        'status', 'source-offer-not-applicable',
        'reason', 'nothing on this checklist belongs to another programme, so there is no programme change to record'
      );
    end if;
  else
    if p_from_offer_id is null then
      -- Provenance is not guessed. Even where exactly one offer's template
      -- matches, saying so is Leif's call, made in front of the evidence.
      return jsonb_build_object(
        'status', 'needs-source-offer',
        'foreign_keys', to_jsonb(v_foreign_keys)
      );
    end if;

    -- The named programme has to be able to account for what is being
    -- retired. Anything it cannot explain means the claim is wrong, and a
    -- wrong from_offer_id is false history that would outlive the repair.
    select coalesce(array_agg(k order by k), '{}')
      into v_unclaimed
      from unnest(v_foreign_keys) as k
     where not exists (
       select 1 from onboarding_requirement_templates t
        where t.offer_id = p_from_offer_id and t.is_active and t.key = k
     );

    if array_length(v_unclaimed, 1) is not null then
      return jsonb_build_object(
        'status', 'source-offer-mismatch',
        'from_offer_id', p_from_offer_id,
        'unmatched_keys', to_jsonb(v_unclaimed)
      );
    end if;
  end if;

  -- The Opportunity is deliberately NOT written here. Its offer is already
  -- what it should be; that is the whole premise.
  v_counts := public.apply_enrollment_onboarding_projection(
    v_enrollment.id, p_from_offer_id, v_deal.offer_id
  );

  if p_from_offer_id is not null then
    -- Recorded now, because that is when it was recorded. occurred_at stays
    -- null: the programme change itself predates the guard and nothing
    -- anywhere says which day it was. 'reconstructed' is what makes that
    -- readable instead of looking like an event that happened at repair time.
    insert into deal_offer_events
      (opportunity_id, enrollment_id, from_offer_id, to_offer_id, occurred_at, source, note)
    values (
      p_opportunity_id, v_enrollment.id, p_from_offer_id, v_deal.offer_id, null, 'reconstructed',
      coalesce(
        p_note,
        'Onboarding reconciled to the programme the Opportunity already carried. The programme change itself happened before transfer_enrolled_opportunity_offer() existed and its date is not recorded anywhere.'
      )
    );
  end if;

  return jsonb_build_object(
    'status', 'reconciled',
    'opportunity_id', p_opportunity_id,
    'enrollment_id', v_enrollment.id,
    'from_offer_id', p_from_offer_id,
    'to_offer_id', v_deal.offer_id,
    'event_recorded', p_from_offer_id is not null
  ) || v_counts;
end;
$fn$;

revoke all on function public.reconcile_enrollment_to_current_offer(bigint, bigint, text) from public;
revoke all on function public.reconcile_enrollment_to_current_offer(bigint, bigint, text) from anon;
grant execute on function public.reconcile_enrollment_to_current_offer(bigint, bigint, text) to authenticated;
grant execute on function public.reconcile_enrollment_to_current_offer(bigint, bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. PROOF
-- ---------------------------------------------------------------------------
-- Everything below runs on fixture rows inside this migration and is rolled
-- back. It fails the deploy rather than shipping a repair authority that has
-- never repaired anything. Jenna is not touched by any of it: her state is
-- reproduced from scratch, including the part that makes her hard — an offer
-- edit that already happened, with no provenance recorded anywhere.
do $proof$
declare
  v_contact bigint;
  v_deal bigint;
  v_enrollment bigint;
  v_result jsonb;
  v_replay jsonb;
  v_aligned_deal bigint;
  v_aligned_enrollment bigint;
  v_le_deal bigint;
  v_transfer jsonb;
  v_app_offer bigint;
  v_call_offer bigint;
  v_events int;
  v_items jsonb;
  v_privileged boolean := false;
  v_gyu bigint;
  v_le bigint;
  v_stale_deal bigint;
  v_stale_enrollment bigint;
  v_other_offer bigint;
begin
  select id into v_le from offers where name = 'The Living Example';
  select id into v_gyu from offers where name = 'Growing Yourself Up';
  if v_le is null or v_gyu is null then
    raise notice 'reconcile proof skipped: the two offers are not both present';
    return;
  end if;

  begin
    -- ---- Jenna's shape, rebuilt -------------------------------------------
    insert into contacts (first_name, last_name) values ('Proof', 'Reconcile') returning id into v_contact;
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, v_gyu, 'call_booked', 1400, 'other', '', 0) returning id into v_deal;

    -- Her GYU application and her GYU sales call, which must both survive.
    insert into applications (contact_id, offer_id, opportunity_id, status, source, submitted_at)
    values (v_contact, v_gyu, v_deal, 'approved', 'public_form', now() - interval '30 days');

    perform public.accept_sale(v_deal);
    select id into v_enrollment from enrollments where opportunity_id = v_deal;

    -- Contract signed under GYU, with its provenance genuinely unknown —
    -- every production row predates source_offer_id.
    update enrollment_onboarding_items
       set status = 'done', completed_at = now() - interval '1 hour', source_offer_id = null
     where enrollment_id = v_enrollment and requirement_key = 'contract';

    -- The pre-guard edit itself: the offer moved and nothing followed it. Done
    -- as the owner, because that is the only way it can happen now.
    update deals set offer_id = v_le, cohort_id = null where id = v_deal;

    -- ---- the transfer authority correctly declines this ------------------
    v_result := public.transfer_enrolled_opportunity_offer(v_deal, v_le, 'proof');
    if v_result ->> 'status' <> 'already-on-offer' then
      raise exception 'transfer should decline an already-aligned offer, got %', v_result;
    end if;

    -- ---- provenance is not guessed ---------------------------------------
    v_result := public.reconcile_enrollment_to_current_offer(v_deal, null, null);
    if v_result ->> 'status' <> 'needs-source-offer' then
      raise exception 'reconcile invented a source offer: %', v_result;
    end if;

    -- ---- nor accepted when the requirements contradict it ----------------
    v_result := public.reconcile_enrollment_to_current_offer(v_deal, v_le, null);
    if v_result ->> 'status' <> 'same-offer' then
      raise exception 'reconcile accepted the current offer as its own source: %', v_result;
    end if;

    -- ---- the repair -------------------------------------------------------
    v_result := public.reconcile_enrollment_to_current_offer(v_deal, v_gyu, null);
    if v_result ->> 'status' <> 'reconciled' then
      raise exception 'the reconcile did not happen: %', v_result;
    end if;
    if (v_result ->> 'required_outstanding')::int <> 3
       or (v_result ->> 'required_total')::int <> 4 then
      raise exception 'expected 1 of 4 outstanding, got %', v_result;
    end if;
    if (v_result ->> 'retired')::int <> 2 then
      raise exception 'expected the two GYU-only requirements to retire, got %', v_result;
    end if;
    if (v_result ->> 'added')::int <> 1 then
      raise exception 'expected notion_access to be added once, got %', v_result;
    end if;

    -- Contract keeps its completion AND its unknown provenance.
    if not exists (
      select 1 from enrollment_onboarding_items
       where enrollment_id = v_enrollment and requirement_key = 'contract'
         and status = 'done' and completed_at is not null and source_offer_id is null
    ) then
      raise exception 'the signed contract lost its completion or gained invented provenance';
    end if;

    -- The GYU-only requirements retired, and did not become done.
    if exists (
      select 1 from enrollment_onboarding_items
       where enrollment_id = v_enrollment
         and requirement_key in ('slack_access', 'calendar_access')
         and (status <> 'retired' or retired_from_offer_id <> v_gyu)
    ) then
      raise exception 'a withdrawn requirement did not retire against the programme it came from';
    end if;

    -- Their Tasks cancelled, not deleted and not completed.
    if (select count(*) from tasks t
          join enrollment_onboarding_items i on i.id = t.onboarding_item_id
         where i.enrollment_id = v_enrollment
           and i.requirement_key in ('slack_access', 'calendar_access')
           and t.status = 'cancelled' and t.done_date is not null) <> 2 then
      raise exception 'the retired requirements'' Tasks were not cancelled';
    end if;
    if exists (
      select 1 from tasks t
        join enrollment_onboarding_items i on i.id = t.onboarding_item_id
       where i.enrollment_id = v_enrollment
         and i.requirement_key in ('slack_access', 'calendar_access')
         and t.status = 'completed'
    ) then
      raise exception 'a withdrawn requirement''s Task was marked completed';
    end if;

    -- curriculum_access is the same row, re-pointed rather than duplicated.
    if (select count(*) from enrollment_onboarding_items
         where enrollment_id = v_enrollment and requirement_key = 'curriculum_access') <> 1 then
      raise exception 'curriculum_access was duplicated instead of re-pointed';
    end if;
    if not exists (
      select 1 from enrollment_onboarding_items
       where enrollment_id = v_enrollment and requirement_key = 'curriculum_access'
         and status = 'pending' and source_offer_id = v_le
         and label = (select label from onboarding_requirement_templates
                       where offer_id = v_le and key = 'curriculum_access' and is_active)
    ) then
      raise exception 'curriculum_access was not re-pointed at the current programme';
    end if;

    -- No duplicate live keys, and no duplicate open Task for one requirement.
    if exists (
      select requirement_key from enrollment_onboarding_items
       where enrollment_id = v_enrollment and status <> 'retired'
       group by requirement_key having count(*) > 1
    ) then
      raise exception 'a live requirement key appears twice';
    end if;
    if exists (
      select t.onboarding_item_id from tasks t
        join enrollment_onboarding_items i on i.id = t.onboarding_item_id
       where i.enrollment_id = v_enrollment and t.status = 'pending'
       group by t.onboarding_item_id having count(*) > 1
    ) then
      raise exception 'a requirement has two open Tasks';
    end if;

    -- Exactly one Enrollment throughout.
    if (select count(*) from enrollments where opportunity_id = v_deal) <> 1 then
      raise exception 'the reconcile created or removed an Enrollment';
    end if;

    -- ---- the history, and what it does and does not claim -----------------
    if (select count(*) from deal_offer_events where opportunity_id = v_deal) <> 1 then
      raise exception 'expected exactly one reconstructed event';
    end if;
    if not exists (
      select 1 from deal_offer_events
       where opportunity_id = v_deal
         and from_offer_id = v_gyu and to_offer_id = v_le
         and source = 'reconstructed'
         and occurred_at is null
         and recorded_at is not null
         and note is not null
    ) then
      raise exception 'the event did not record GYU -> LE as a reconstruction with an unknown date';
    end if;

    -- ---- the Opportunity's own offer was not touched ----------------------
    if (select offer_id from deals where id = v_deal) <> v_le then
      raise exception 'the reconcile changed the Opportunity''s offer';
    end if;

    -- ---- history that belongs to the old programme stays there ------------
    select offer_id into v_app_offer from applications where opportunity_id = v_deal;
    if v_app_offer <> v_gyu then
      raise exception 'the historical Application was rewritten to the new programme';
    end if;

    -- ---- idempotency ------------------------------------------------------
    v_replay := public.reconcile_enrollment_to_current_offer(v_deal, v_gyu, null);
    if v_replay ->> 'status' <> 'already-aligned' then
      raise exception 'a second reconcile was not a no-op: %', v_replay;
    end if;
    select count(*) into v_events from deal_offer_events where opportunity_id = v_deal;
    if v_events <> 1 then
      raise exception 'the replay wrote a second event';
    end if;
    if (select count(*) from enrollment_onboarding_items where enrollment_id = v_enrollment) <> 6 then
      raise exception 'the replay changed the checklist';
    end if;

    -- ---- an aligned client is never offered a repair ----------------------
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, v_le, 'call_booked', 1400, 'other', '', 0) returning id into v_aligned_deal;
    perform public.accept_sale(v_aligned_deal);
    select id into v_aligned_enrollment from enrollments where opportunity_id = v_aligned_deal;
    if not public.enrollment_onboarding_matches_offer(v_aligned_enrollment, v_le) then
      raise exception 'a freshly seeded checklist did not match its own programme';
    end if;
    v_result := public.reconcile_enrollment_to_current_offer(v_aligned_deal, v_gyu, null);
    if v_result ->> 'status' <> 'already-aligned' then
      raise exception 'an aligned client was reconciled anyway: %', v_result;
    end if;

    -- ---- refusals ---------------------------------------------------------
    v_result := public.reconcile_enrollment_to_current_offer(999999999, v_gyu, null);
    if v_result ->> 'status' <> 'not-found' then
      raise exception 'reconcile accepted a missing Opportunity: %', v_result;
    end if;
    v_result := public.reconcile_enrollment_to_current_offer(v_deal, 999999999, null);
    if v_result ->> 'status' <> 'invalid-offer' then
      raise exception 'reconcile accepted a missing offer: %', v_result;
    end if;

    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, v_le, 'interested', 10, 'other', '', 0) returning id into v_le_deal;
    v_result := public.reconcile_enrollment_to_current_offer(v_le_deal, v_gyu, null);
    if v_result ->> 'status' <> 'no-enrollment' then
      raise exception 'reconcile accepted an Opportunity with nothing downstream: %', v_result;
    end if;

    -- A finished client is history. 'withdrawn' is reachable from anywhere,
    -- which makes it the cheapest terminal state to say this with; the rule is
    -- about terminal, not about which terminal.
    update enrollments set status = 'withdrawn' where id = v_aligned_enrollment;
    update enrollment_onboarding_items set status = 'pending', completed_at = null
     where enrollment_id = v_aligned_enrollment and requirement_key = 'notion_access';
    delete from enrollment_onboarding_items
     where enrollment_id = v_aligned_enrollment and requirement_key = 'meditation_library_access';
    v_result := public.reconcile_enrollment_to_current_offer(v_aligned_deal, v_gyu, null);
    if v_result ->> 'status' <> 'terminal-enrollment' then
      raise exception 'reconcile reopened a finished client''s checklist: %', v_result;
    end if;

    -- ---- a named source the requirements cannot have come from -----------
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, v_gyu, 'call_booked', 1400, 'other', '', 0) returning id into v_stale_deal;
    perform public.accept_sale(v_stale_deal);
    select id into v_stale_enrollment from enrollments where opportunity_id = v_stale_deal;
    update deals set offer_id = v_le, cohort_id = null where id = v_stale_deal;

    select id into v_other_offer from offers
     where id not in (v_gyu, v_le)
       and not exists (
         select 1 from onboarding_requirement_templates t
          where t.offer_id = offers.id and t.is_active and t.key = 'slack_access'
       )
     limit 1;
    if v_other_offer is not null then
      v_result := public.reconcile_enrollment_to_current_offer(v_stale_deal, v_other_offer, null);
      if v_result ->> 'status' <> 'source-offer-mismatch' then
        raise exception 'reconcile accepted a source offer the requirements contradict: %', v_result;
      end if;
      if (v_result -> 'unmatched_keys') is null then
        raise exception 'the mismatch did not say which requirements it could not account for';
      end if;
      -- And it wrote nothing while refusing.
      if (select count(*) from deal_offer_events where opportunity_id = v_stale_deal) <> 0 then
        raise exception 'a refused reconcile still recorded history';
      end if;
      if not exists (
        select 1 from enrollment_onboarding_items
         where enrollment_id = v_stale_enrollment and requirement_key = 'slack_access'
           and status = 'pending'
      ) then
        raise exception 'a refused reconcile still moved the checklist';
      end if;
    end if;

    -- ---- a checklist whose programme merely gained a requirement ---------
    -- Nothing foreign, so there is no programme change to record, and naming
    -- one is refused rather than written.
    delete from tasks where onboarding_item_id in (
      select id from enrollment_onboarding_items
       where enrollment_id = v_stale_enrollment and requirement_key in ('slack_access', 'calendar_access')
    );
    delete from enrollment_onboarding_items
     where enrollment_id = v_stale_enrollment
       and requirement_key in ('slack_access', 'calendar_access', 'curriculum_access');
    v_result := public.reconcile_enrollment_to_current_offer(v_stale_deal, v_gyu, null);
    if v_result ->> 'status' <> 'source-offer-not-applicable' then
      raise exception 'reconcile recorded a programme change with nothing foreign on the checklist: %', v_result;
    end if;
    v_result := public.reconcile_enrollment_to_current_offer(v_stale_deal, null, null);
    if v_result ->> 'status' <> 'reconciled' or (v_result ->> 'event_recorded')::boolean then
      raise exception 'filling a grown template should reconcile without claiming a transfer: %', v_result;
    end if;

    -- ---- a real A -> B transfer still behaves exactly as before -----------
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, v_gyu, 'call_booked', 1400, 'other', '', 0) returning id into v_le_deal;
    perform public.accept_sale(v_le_deal);
    v_transfer := public.transfer_enrolled_opportunity_offer(v_le_deal, v_le, 'proof');
    if v_transfer ->> 'status' <> 'transferred'
       or (v_transfer ->> 'retired')::int <> 2
       or (v_transfer ->> 'added')::int <> 1
       or (v_transfer ->> 'required_total')::int <> 4 then
      raise exception 'the transfer changed shape after the refactor: %', v_transfer;
    end if;
    if (select offer_id from deals where id = v_le_deal) <> v_le then
      raise exception 'the transfer no longer moves the Opportunity';
    end if;
    if not exists (
      select 1 from deal_offer_events
       where opportunity_id = v_le_deal and source = 'app' and occurred_at is not null
    ) then
      raise exception 'a real transfer must record when it happened';
    end if;

    -- ---- the internal projection is unreachable by a client --------------
    begin
      set local role authenticated;
      perform public.apply_enrollment_onboarding_projection(v_enrollment, v_gyu, v_le);
      v_privileged := true;
      reset role;
    exception when others then
      reset role;
    end;
    if v_privileged then
      raise exception 'a signed-in client can move a checklist without a decision';
    end if;

    -- ---- and the ordinary offer edit is still refused --------------------
    v_privileged := false;
    begin
      set local role authenticated;
      update deals set offer_id = v_gyu where id = v_deal;
      v_privileged := true;
      reset role;
    exception when others then
      reset role;
    end;
    if v_privileged then
      raise exception 'an ordinary authenticated edit moved an enrolled client''s offer';
    end if;

    raise notice 'reconcile proof: 1 of 4 outstanding, 2 retired with their Tasks cancelled, notion_access added once, one reconstructed GYU -> LE event with no invented date, replay a no-op, transfer unchanged';

    -- Fixtures never belong in a real database, and a migration cannot roll
    -- back only part of itself, so the whole proof unwinds on this sentinel.
    raise exception 'reconcile proof complete' using errcode = 'restrict_violation';
  exception
    when restrict_violation then
      null;
  end;
end;
$proof$;
