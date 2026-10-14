-- WHAT A DELIVERED DAY-0 INVITATION MEANS FOR THE PIPELINE.
--
-- §4b Phase 2C. One authoritative command turns a CONFIRMED successful Day-0
-- delivery into lifecycle truth: the right same-offer Opportunity, and exactly
-- one Application Outreach episode governed by application_outreach_v1.
--
-- DORMANT ON PURPOSE. Nothing calls this yet -- no worker, no UI, no cron, no
-- webhook, no Gmail. It is proved here and wired in a later slice, so
-- production keeps 0 application_outreach_attempts rows after this deploys.
--
-- DELIVERY TRUTH IS THE PREREQUISITE, and it already exists structurally:
-- waitlist_invitations.status = 'sent' is guaranteed by
-- waitlist_invitations_sent_evidence_check to carry both a sent_at and a
-- delivery_method. A click, a queued Kit operation, an attempted send, a
-- preflight membership or a waitlist status are NONE of them delivery, and
-- this command reads none of them as such. `sent_at` is Day 0.
--
-- executor = 'gmail' says GMAIL OWNS FUTURE AUTOMATED FOLLOW-UP. It does not
-- claim Gmail sent Day 0. The Day-0 provider truth stays where it happened --
-- on the invitation's own delivery_method and its Kit operation -- and is not
-- overwritten here. (HANDOFF §8t.)
--
-- BUSINESS TRUTH CHOOSES THE RESULT. There is deliberately no caller-supplied
-- mode: whether this opens an active episode or records a concluded historical
-- one is decided by what is true about the person right now, re-read inside
-- the transaction rather than taken from whenever they were judged eligible.
--
-- Deterministic: creates a function and its grants, asserts only structure,
-- reads no business row at migration time. It belongs in the deterministic set.

create or replace function public.converge_delivered_invitation(
  p_invitation_id bigint,
  p_next_action_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_inv waitlist_invitations%rowtype;
  v_entry waitlist_entries%rowtype;
  v_deal deals%rowtype;
  v_contact contacts%rowtype;
  v_existing application_outreach_attempts%rowtype;
  v_app_id bigint;
  v_app_submitted_at timestamptz;
  v_client_deal_id bigint;
  v_attempt_id bigint;
  v_reused boolean := false;
begin
  -- 1. THE DELIVERED INVITATION ITSELF.
  select * into v_inv from waitlist_invitations where id = p_invitation_id for update;
  if not found then
    return jsonb_build_object('status', 'invitation-missing');
  end if;

  -- Only a genuine delivery converges. Everything else is retryable later by
  -- the same call, which is why this is a status and not an exception.
  if v_inv.status <> 'sent' or v_inv.sent_at is null then
    return jsonb_build_object(
      'status', 'invitation-not-delivered',
      'invitation_id', v_inv.id,
      'invitation_status', v_inv.status);
  end if;

  select * into v_entry from waitlist_entries where id = v_inv.waitlist_entry_id;
  if not found then
    return jsonb_build_object('status', 'invitation-invalid',
      'invitation_id', v_inv.id, 'reason', 'waitlist entry missing');
  end if;

  -- Provenance has to agree with itself before anything is written from it.
  if v_entry.contact_id is distinct from v_inv.contact_id then
    return jsonb_build_object('status', 'invitation-invalid',
      'invitation_id', v_inv.id, 'reason', 'invitation and waitlist entry disagree about the contact');
  end if;

  -- 2. IDEMPOTENCY, BEFORE ANY DECISION. One episode per delivered
  -- invitation is a database guarantee (the Phase 2A partial unique index);
  -- this makes a replay cheap and deterministic instead of a constraint
  -- violation. Worker retry, duplicate callback, lost response, an operator
  -- running reconciliation twice: all land here.
  select * into v_existing from application_outreach_attempts
   where waitlist_invitation_id = v_inv.id;
  if found then
    return jsonb_build_object(
      'status', 'already-converged',
      'invitation_id', v_inv.id,
      'opportunity_id', v_existing.opportunity_id,
      'outreach_attempt_id', v_existing.id,
      'outreach_status', v_existing.status,
      'stage', (select d.stage from deals d where d.id = v_existing.opportunity_id),
      'reused_opportunity', false);
  end if;

  select * into v_contact from contacts where id = v_inv.contact_id;
  if not found then
    return jsonb_build_object('status', 'invitation-invalid',
      'invitation_id', v_inv.id, 'reason', 'contact missing');
  end if;

  -- 3. THE DURABLE "NO FUTURE DIRECT SALES" GATE, honoured wherever a sales
  -- process would start -- before any lifecycle row is created.
  if v_contact.sales_eligibility = 'do_not_engage' then
    return jsonb_build_object('status', 'do-not-engage',
      'invitation_id', v_inv.id, 'contact_id', v_contact.id);
  end if;

  -- 4. Serialize this person+programme for the rest of the transaction, so
  -- two concurrent deliveries cannot both read "no active Opportunity" and
  -- both create one. Same key shape as create_manual_application.
  perform pg_advisory_xact_lock(
    hashtext('converge_delivered_invitation:' || v_entry.contact_id || ':'
             || v_entry.offer_id || ':' || coalesce(v_entry.cohort_id::text, '-')));

  -- 5. ALREADY A CLIENT for this programme. deal_is_active() calls a won
  -- Opportunity INACTIVE, so the active lookup below would happily open an
  -- Interested cycle beside a sale that already closed. This is the explicit
  -- check that stops it.
  select d.id into v_client_deal_id
    from deals d
   where d.contact_id = v_entry.contact_id
     and d.offer_id = v_entry.offer_id
     and (v_entry.cohort_id is null or d.cohort_id = v_entry.cohort_id)
     and d.archived_at is null
     and (d.stage in ('won', 'onboarding')
          or exists (select 1 from enrollments e where e.opportunity_id = d.id))
   order by d.id asc
   limit 1;
  if v_client_deal_id is not null then
    return jsonb_build_object(
      'status', 'already-client',
      'invitation_id', v_inv.id,
      'opportunity_id', v_client_deal_id,
      'stage', (select d.stage from deals d where d.id = v_client_deal_id),
      'reused_opportunity', false);
  end if;

  -- 6. THE SAME-OFFER ACTIVE SALES CYCLE, via the canonical predicate rather
  -- than a second definition of "active". A terminal attempt (any non-null
  -- outcome -- nurture, lost, not_fit, needs_higher_care, workshops_only) is
  -- NOT active and is deliberately not found here: a genuinely new invitation
  -- cycle gets a NEW Opportunity beside the concluded one, and the old row is
  -- never touched (deals/dealActivity.ts).
  select * into v_deal
    from deals d
   where d.contact_id = v_entry.contact_id
     and d.offer_id = v_entry.offer_id
     and (v_entry.cohort_id is null or d.cohort_id = v_entry.cohort_id)
     and public.deal_is_active(d.archived_at, d.stage, d.outcome)
   order by d.id asc
   limit 1;

  -- 7. APPLICATION ALWAYS WINS. Re-read here, inside the lock, because
  -- eligibility was judged when the invitation was prepared and the person
  -- may have applied since -- including between the provider's delivery and
  -- this call.
  if v_deal.id is not null then
    select a.id, a.submitted_at into v_app_id, v_app_submitted_at
      from applications a
     where a.opportunity_id = v_deal.id
     order by a.id desc
     limit 1;
  end if;

  if v_deal.id is not null
     and v_deal.stage in ('application_received', 'approved', 'call_booked', 'decision')
  then
    -- NO REGRESSION, and no active reminder episode for somebody already
    -- further along. The truthful historical record is the concluded episode
    -- below, when an application is what carried them there.
    if v_app_id is not null and v_app_submitted_at is not null then
      if v_app_submitted_at < v_inv.sent_at then
        -- The application predates the delivery, so this invitation did not
        -- produce it and an episode ending before it began would be a lie.
        -- Surfaced rather than invented.
        return jsonb_build_object(
          'status', 'ambiguous',
          'invitation_id', v_inv.id,
          'opportunity_id', v_deal.id,
          'stage', v_deal.stage,
          'reason', 'the same-offer application predates this delivery',
          'reused_opportunity', true);
      end if;

      -- THE CONCLUDED HISTORICAL EPISODE. We asked, they applied, the episode
      -- is over: recorded with the application's own timestamp as its end, no
      -- future moment, and therefore no reminder can ever be computed for it.
      insert into application_outreach_attempts (
        opportunity_id, source, channel, executor, schedule_key,
        status, started_at, step,
        next_action_at, externally_managed_until,
        ended_at, end_reason, resulting_application_id, waitlist_invitation_id
      ) values (
        v_deal.id, 'waitlist', 'email', 'gmail', 'application_outreach_v1',
        'closed', v_inv.sent_at, 0,
        null, null,
        v_app_submitted_at, 'application_submitted', v_app_id, v_inv.id
      ) returning id into v_attempt_id;

      return jsonb_build_object(
        'status', 'application-already-submitted',
        'invitation_id', v_inv.id,
        'opportunity_id', v_deal.id,
        'outreach_attempt_id', v_attempt_id,
        'outreach_status', 'closed',
        'application_id', v_app_id,
        'stage', v_deal.stage,
        'reused_opportunity', true);
    end if;

    return jsonb_build_object(
      'status', 'already-later-stage',
      'invitation_id', v_inv.id,
      'opportunity_id', v_deal.id,
      'stage', v_deal.stage,
      'reused_opportunity', true);
  end if;

  -- 8. From here an ACTIVE episode is being opened, which needs its first
  -- future moment. The calendar has ONE semantic authority
  -- (outreach/applicationOutreachSchedule.ts); this command does not hold a
  -- day offset and so cannot recompute it. What it CAN enforce is that the
  -- moment exists and genuinely lies after Day 0.
  if p_next_action_at is null or p_next_action_at <= v_inv.sent_at then
    return jsonb_build_object(
      'status', 'invalid-next-action',
      'invitation_id', v_inv.id,
      'reason', 'an active episode needs a next action strictly after its Day-0 delivery');
  end if;

  if v_deal.id is not null then
    -- An active Interested cycle for this programme already exists: reuse it.
    -- No second Opportunity, and nothing written to deals -- so
    -- on_deal_waitlist_sync does not fire on this branch either.
    v_reused := true;

    if exists (select 1 from application_outreach_attempts
                where opportunity_id = v_deal.id and status = 'active') then
      -- One running episode per Opportunity. The database enforces it; this
      -- returns the existing lifecycle instead of provoking the violation.
      select * into v_existing from application_outreach_attempts
       where opportunity_id = v_deal.id and status = 'active';
      return jsonb_build_object(
        'status', 'already-converged',
        'invitation_id', v_inv.id,
        'opportunity_id', v_deal.id,
        'outreach_attempt_id', v_existing.id,
        'outreach_status', v_existing.status,
        'stage', v_deal.stage,
        'reused_opportunity', true);
    end if;
  else
    -- 9. THE NEW INTERESTED CYCLE. entry_path is 'other', never
    -- 'application_form': no form produced this, and saying one did is the
    -- lie create_manual_application avoids for the same reason. Everything
    -- else an Opportunity needs -- the commercial snapshot, the
    -- Contact-derived name, stage_entered_at, the stage event -- is written
    -- by the deals triggers, which is why this is a plain INSERT.
    --
    -- And at stage 'interested' the waitlist place is NOT spent:
    -- handle_deal_waitlist_sync converts only from application_received
    -- onward (Phase 2A0, §8r). Being invited is not the same as having
    -- started, so the entry stays 'invited' and nothing here converts it.
    insert into deals (
      contact_id, offer_id, cohort_id, stage, outcome, owner_decision,
      amount, entry_path, description
    )
    select v_entry.contact_id, v_entry.offer_id, v_entry.cohort_id,
           'interested', null, null, o.current_price, 'other', ''
      from offers o where o.id = v_entry.offer_id
    returning * into v_deal;

    if v_deal.id is null then
      return jsonb_build_object('status', 'invitation-invalid',
        'invitation_id', v_inv.id, 'reason', 'offer missing for the waitlist entry');
    end if;
  end if;

  -- 10. EXACTLY ONE ACTIVE EPISODE, governed by v1, anchored to the real
  -- Day-0 delivery, with Day 0 already behind it (step 0) and never resent.
  insert into application_outreach_attempts (
    opportunity_id, source, channel, executor, schedule_key,
    status, started_at, step,
    next_action_at, externally_managed_until, waitlist_invitation_id
  ) values (
    v_deal.id, 'waitlist', 'email', 'gmail', 'application_outreach_v1',
    'active', v_inv.sent_at, 0,
    p_next_action_at, null, v_inv.id
  ) returning id into v_attempt_id;

  return jsonb_build_object(
    'status', case when v_reused then 'reused' else 'created' end,
    'invitation_id', v_inv.id,
    'opportunity_id', v_deal.id,
    'outreach_attempt_id', v_attempt_id,
    'outreach_status', 'active',
    'stage', v_deal.stage,
    'next_action_at', p_next_action_at,
    'reused_opportunity', v_reused);
end;
$fn$;

-- SERVICE-OWNED. This command writes application_outreach_attempts, a table
-- `authenticated` deliberately cannot write at all (§8s), and it opens a sales
-- cycle. There is no UI caller and there is not meant to be one: it runs from
-- the delivery path. So unlike create_manual_application -- a signed-in owner
-- action -- this is granted to service_role ALONE.
revoke all on function public.converge_delivered_invitation(bigint, timestamptz) from public;
revoke all on function public.converge_delivered_invitation(bigint, timestamptz) from anon;
revoke all on function public.converge_delivered_invitation(bigint, timestamptz) from authenticated;
grant execute on function public.converge_delivered_invitation(bigint, timestamptz) to service_role;

-- SECURITY DEFINER runs as the owner, so the canonical predicate it calls must
-- be reachable by that owner. Asserted rather than assumed, so a clean room
-- that ever tightens it fails here instead of at runtime.
do $$
begin
  if not has_function_privilege(
       'postgres',
       'public.deal_is_active(timestamptz, text, text)',
       'EXECUTE') then
    raise exception 'converge_delivered_invitation needs EXECUTE on deal_is_active';
  end if;
end $$;
