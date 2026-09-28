-- ===========================================================================
-- Onboarding that was never tracked is not onboarding that needs repairing
-- ===========================================================================
--
-- Verifying the repair UI against real production data found it offering
-- "Onboarding needs repair" to twenty real clients whose onboarding is
-- deliberately outside tracking: enrollments.onboarding_tracking =
-- 'legacy_untracked', people who were already working with Leif before the CRM
-- modelled onboarding at all. They have no checklist because there is nothing
-- to track, and every other consumer already says so —
-- computeOnboardingProgress returns isLegacyUntracked with
-- isMissingChecklist FALSE, because "legacy onboarding makes no claim either
-- way".
--
-- 20260926020000 asked one question — do the live requirement keys equal the
-- programme's active template keys? — and for a legacy client the honest answer
-- is no. That answer was then read as "stale, offer to repair it", and clicking
-- the button would have seeded four requirements and four pending Tasks for
-- work finished years ago, with no source programme to name and no history
-- event to record it.
--
-- The predicate keeps its meaning: enrollment_onboarding_matches_offer() is
-- about checklist/template equivalence and nothing else, so nothing downstream
-- can start reading "legacy" as "aligned". What changes is eligibility, which
-- is a different question and now has its own answer:
--
--   onboarding-not-tracked   this client's onboarding is not modelled here,
--                            so there is nothing to reconcile it to
--
-- The refusal writes nothing at all, and it is checked before alignment so a
-- legacy client is never told their checklist matches.

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

  -- Onboarding this client's programme does not track. 'legacy_untracked' is a
  -- deliberate statement about a client who was onboarded before the CRM
  -- modelled it (Slice 2): the absence of a checklist is the recorded fact, not
  -- a defect, and seeding one now would invent four requirements and four Tasks
  -- for work that finished long ago. Refused here as well as in the UI, because
  -- an authority that depends on a screen not offering a button is not an
  -- authority. Checked BEFORE alignment, so this never answers
  -- 'already-aligned': their checklist genuinely does not match the template,
  -- and that is not the question being asked about them.
  if v_enrollment.onboarding_tracking is distinct from 'tracked' then
    return jsonb_build_object(
      'status', 'onboarding-not-tracked',
      'enrollment_id', v_enrollment.id,
      'onboarding_tracking', v_enrollment.onboarding_tracking
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
-- PROOF
-- ---------------------------------------------------------------------------
-- Fixture rows only, rolled back on a sentinel. No real client is touched: the
-- twenty this protects are read-only evidence, not test subjects.
do $proof$
declare
  v_contact bigint;
  v_tracked_deal bigint;
  v_tracked_enrollment bigint;
  v_aligned_deal bigint;
  v_aligned_enrollment bigint;
  v_legacy_deal bigint;
  v_legacy_enrollment bigint;
  v_partial_deal bigint;
  v_partial_enrollment bigint;
  v_transfer_deal bigint;
  v_result jsonb;
  v_before jsonb;
  v_after jsonb;
  v_le bigint;
  v_gyu bigint;
  v_refused boolean := false;
begin
  select id into v_le from offers where name = 'The Living Example';
  select id into v_gyu from offers where name = 'Growing Yourself Up';
  if v_le is null or v_gyu is null then
    raise notice 'tracking-guard proof skipped: the two offers are not both present';
    return;
  end if;

  begin
    insert into contacts (first_name, last_name) values ('Proof', 'Tracking') returning id into v_contact;

    -- ---- tracked + stale: the accepted repair still works -----------------
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, v_gyu, 'call_booked', 1400, 'other', '', 0) returning id into v_tracked_deal;
    perform public.accept_sale(v_tracked_deal);
    select id into v_tracked_enrollment from enrollments where opportunity_id = v_tracked_deal;
    -- Jenna's shape: the contract signed under the old programme, with its
    -- provenance unknown, and then the pre-guard offer edit.
    update enrollment_onboarding_items
       set status = 'done', completed_at = now() - interval '1 hour', source_offer_id = null
     where enrollment_id = v_tracked_enrollment and requirement_key = 'contract';
    update deals set offer_id = v_le, cohort_id = null where id = v_tracked_deal;

    v_result := public.reconcile_enrollment_to_current_offer(v_tracked_deal, v_gyu, null);
    if v_result ->> 'status' <> 'reconciled' then
      raise exception 'a tracked stale client is no longer repairable: %', v_result;
    end if;
    if (v_result ->> 'required_outstanding')::int <> 3
       or (v_result ->> 'required_total')::int <> 4 then
      raise exception 'the tracked repair changed shape: %', v_result;
    end if;

    -- ---- tracked + aligned: unchanged ------------------------------------
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, v_le, 'call_booked', 4000, 'other', '', 0) returning id into v_aligned_deal;
    perform public.accept_sale(v_aligned_deal);
    select id into v_aligned_enrollment from enrollments where opportunity_id = v_aligned_deal;
    v_result := public.reconcile_enrollment_to_current_offer(v_aligned_deal, v_gyu, null);
    if v_result ->> 'status' <> 'already-aligned' then
      raise exception 'an aligned tracked client no longer answers already-aligned: %', v_result;
    end if;

    -- ---- legacy_untracked + no checklist: refused, and writes nothing ----
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, v_le, 'call_booked', 4000, 'other', '', 0) returning id into v_legacy_deal;
    perform public.accept_sale(v_legacy_deal);
    select id into v_legacy_enrollment from enrollments where opportunity_id = v_legacy_deal;
    -- A historical client: onboarding outside tracking, and no checklist. The
    -- Tasks go with the items, exactly as the import left them.
    delete from tasks where onboarding_item_id in (
      select id from enrollment_onboarding_items where enrollment_id = v_legacy_enrollment
    );
    delete from enrollment_onboarding_items where enrollment_id = v_legacy_enrollment;
    update enrollments set onboarding_tracking = 'legacy_untracked' where id = v_legacy_enrollment;

    select jsonb_build_object(
      'items', (select count(*) from enrollment_onboarding_items where enrollment_id = v_legacy_enrollment),
      'tasks', (select count(*) from tasks where enrollment_id = v_legacy_enrollment),
      'events', (select count(*) from deal_offer_events where opportunity_id = v_legacy_deal),
      'offer', (select offer_id from deals where id = v_legacy_deal),
      'status', (select status from enrollments where id = v_legacy_enrollment),
      'tracking', (select onboarding_tracking from enrollments where id = v_legacy_enrollment))
      into v_before;

    v_result := public.reconcile_enrollment_to_current_offer(v_legacy_deal, v_gyu, null);
    if v_result ->> 'status' <> 'onboarding-not-tracked' then
      raise exception 'a legacy client was not refused: %', v_result;
    end if;
    -- And with no source offer named either, which must not change the answer.
    v_result := public.reconcile_enrollment_to_current_offer(v_legacy_deal, null, null);
    if v_result ->> 'status' <> 'onboarding-not-tracked' then
      raise exception 'a legacy client was not refused without a source offer: %', v_result;
    end if;

    select jsonb_build_object(
      'items', (select count(*) from enrollment_onboarding_items where enrollment_id = v_legacy_enrollment),
      'tasks', (select count(*) from tasks where enrollment_id = v_legacy_enrollment),
      'events', (select count(*) from deal_offer_events where opportunity_id = v_legacy_deal),
      'offer', (select offer_id from deals where id = v_legacy_deal),
      'status', (select status from enrollments where id = v_legacy_enrollment),
      'tracking', (select onboarding_tracking from enrollments where id = v_legacy_enrollment))
      into v_after;
    if v_before is distinct from v_after then
      raise exception 'the refusal wrote something: before=% after=%', v_before, v_after;
    end if;
    if (v_after ->> 'items')::int <> 0 or (v_after ->> 'tasks')::int <> 0 then
      raise exception 'a historical client gained a checklist or a Task';
    end if;

    -- ---- legacy_untracked + a partial historical checklist: still refused -
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, v_gyu, 'call_booked', 1400, 'other', '', 0) returning id into v_partial_deal;
    perform public.accept_sale(v_partial_deal);
    select id into v_partial_enrollment from enrollments where opportunity_id = v_partial_deal;
    update deals set offer_id = v_le, cohort_id = null where id = v_partial_deal;
    -- Whatever the import happened to leave behind: one finished requirement.
    update enrollment_onboarding_items set status = 'done', completed_at = now()
     where enrollment_id = v_partial_enrollment and requirement_key = 'contract';
    delete from tasks where onboarding_item_id in (
      select id from enrollment_onboarding_items
       where enrollment_id = v_partial_enrollment and requirement_key <> 'contract'
    );
    delete from enrollment_onboarding_items
     where enrollment_id = v_partial_enrollment and requirement_key <> 'contract';
    update enrollments set onboarding_tracking = 'legacy_untracked' where id = v_partial_enrollment;

    select jsonb_build_object(
      'items', (select count(*) from enrollment_onboarding_items where enrollment_id = v_partial_enrollment),
      'tasks', (select count(*) from tasks where enrollment_id = v_partial_enrollment),
      'events', (select count(*) from deal_offer_events where opportunity_id = v_partial_deal))
      into v_before;
    v_result := public.reconcile_enrollment_to_current_offer(v_partial_deal, v_gyu, null);
    if v_result ->> 'status' <> 'onboarding-not-tracked' then
      raise exception 'a legacy client with a partial checklist was not refused: %', v_result;
    end if;
    select jsonb_build_object(
      'items', (select count(*) from enrollment_onboarding_items where enrollment_id = v_partial_enrollment),
      'tasks', (select count(*) from tasks where enrollment_id = v_partial_enrollment),
      'events', (select count(*) from deal_offer_events where opportunity_id = v_partial_deal))
      into v_after;
    if v_before is distinct from v_after then
      raise exception 'the partial-checklist refusal wrote something: before=% after=%', v_before, v_after;
    end if;

    -- ---- a real transfer is untouched by any of this ----------------------
    insert into deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    values (v_contact, v_gyu, 'call_booked', 1400, 'other', '', 0) returning id into v_transfer_deal;
    perform public.accept_sale(v_transfer_deal);
    v_result := public.transfer_enrolled_opportunity_offer(v_transfer_deal, v_le, 'proof');
    if v_result ->> 'status' <> 'transferred'
       or (v_result ->> 'retired')::int <> 2
       or (v_result ->> 'added')::int <> 1
       or (v_result ->> 'required_total')::int <> 4 then
      raise exception 'the transfer changed shape: %', v_result;
    end if;

    -- ---- and the ordinary offer edit is still refused --------------------
    begin
      set local role authenticated;
      update deals set offer_id = v_gyu where id = v_tracked_deal;
      reset role;
    exception when others then
      reset role;
      v_refused := true;
    end;
    if not v_refused then
      raise exception 'an ordinary authenticated edit moved an enrolled client''s offer';
    end if;

    raise notice 'tracking-guard proof: tracked stale still repairs, tracked aligned still answers already-aligned, legacy (empty and partial) refused with zero writes, transfer and the offer-edit guard unchanged';

    raise exception 'tracking-guard proof complete' using errcode = 'restrict_violation';
  exception
    when restrict_violation then
      null;
  end;
end;
$proof$;
