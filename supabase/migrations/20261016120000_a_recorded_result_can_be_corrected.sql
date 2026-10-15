-- A RECORDED RESULT CAN BE CORRECTED, AND A CORRECTION IS NOT A SECOND RESULT.
--
-- Sales Call Workflow Part 2.
--
-- Part 1 gave a completed call an authoritative result. It gave Leif no way
-- to change it: complete_attended_sales_call() refuses a materially
-- different re-completion with 'conflicting-outcome', deliberately, because
-- until this migration there was nothing better to do than refuse. "She
-- actually said no" had no front door at all.
--
-- WHY A SEPARATE COMMAND AND NOT A LOOSER COMPLETION. The two are different
-- business events and the audit trail has to be able to tell them apart:
--
--   complete  the FIRST authoritative resolution of this call episode
--   correct   a human changing an already-recorded resolution
--
-- Turning every conflicting completion into a silent edit would mean a
-- stale browser tab, a double-click or a replayed webhook could rewrite a
-- recorded answer and leave no trace that it had. So completion keeps
-- refusing, and correction is explicit, separately granted, and writes its
-- own event.
--
-- ONE AUTHORITATIVE RESULT PER CALL EPISODE. Correction edits ONE
-- sales_calls row. It never inserts a second call, never touches a sibling
-- episode, and never creates a competing "current" answer. Rebooking is
-- real -- an Opportunity legitimately has several completed calls -- so the
-- only episode allowed to correct the OPPORTUNITY's current truth is the
-- latest ATTENDED one. Why attended specifically: record_sales_call_cancelled()
-- and record_sales_call_no_show() both leave the Opportunity untouched on
-- purpose ("a fact about the meeting, not a demotion of the sale"), so a
-- newer cancelled or no-showed call has written nothing that an older
-- episode's correction could contradict. Only an attended call ever wrote
-- lifecycle facts. A superseded episode may still have its impressions
-- corrected, because impressions live on the call row and nothing derives
-- from them.
--
-- WHAT IT WILL NOT DO. It reconciles internal deterministic state and
-- refuses, before mutating anything, when the correction would imply
-- reversing something consequential: a Won sale, an Enrollment, money, a
-- Stripe plan, an issued Offer Page link, a standing do-not-engage gate on
-- the Contact. There is no canonical reversible command for any of those,
-- and a half-reversal is worse than a refusal. Atomic handles certainty;
-- Leif handles ambiguity.
--
-- Deterministic: adds a nullable column, widens a CHECK, and creates
-- functions and one trigger. It asserts structure only and replays into an
-- empty database.

-- ---------------------------------------------------------------------
-- 1. The audit vocabulary.
-- ---------------------------------------------------------------------
-- sales_call_events is already the append-only history of a call episode
-- and already carries the "only set for kind = X" convention (attendance
-- for attendance_recorded, previous/new_scheduled_at for rescheduled,
-- dismissal_reason for dismissed). A correction joins it the same way:
-- one new kind, one new column holding the before/after facts.
--
-- Deliberately NOT a generic event-sourcing framework and NOT a diff of
-- arbitrary columns: the five facts a correction can change are named, so
-- the payload is a fixed shape anyone can read six months from now.

alter table public.sales_call_events
    add column if not exists correction jsonb;

comment on column public.sales_call_events.correction is
    'Only set for kind = ''outcome_corrected'': {"before": {...}, "after": {...}} over the five correctable facts (attendance, owner_decision, prospect_decision, follow_up_date, impressions). The original ''attendance_recorded'' event is never rewritten -- what was first recorded stays recorded.';

alter table public.sales_call_events
    drop constraint if exists sales_call_events_kind_check;
alter table public.sales_call_events
    add constraint sales_call_events_kind_check check (kind in (
        'booked', 'rescheduled', 'cancelled', 'attendance_recorded',
        'opportunity_attached', 'dismissed', 'outcome_corrected'));

alter table public.sales_call_events
    drop constraint if exists sales_call_events_correction_kind_check;
alter table public.sales_call_events
    add constraint sales_call_events_correction_kind_check check (
        correction is null or kind = 'outcome_corrected');

-- ---------------------------------------------------------------------
-- 2. The Decision follow-up Task has one reconciler, and it is here.
-- ---------------------------------------------------------------------
-- The Task that says "follow up with this person on the 19th" is a
-- PROJECTION of deals.follow_up_date on an active Opportunity at Decision.
-- It was created by the app layer (sales-calls/followUpTask.ts) keyed on
-- the CONTACT and carrying no opportunity_id, which had two consequences:
--
--   * close_tasks_for_terminal_opportunity() filters on opportunity_id, so
--     it could never close one. Production holds 2 pending follow_up Tasks,
--     both unlinked, and 1 of them is already stale -- its Contact has no
--     Opportunity at Decision at all.
--   * nothing reconciled the due date when the commitment moved.
--
-- So this is a trigger on deals rather than a step inside the correction
-- command: then EVERY authority that moves an Opportunity's Decision truth
-- reconciles it -- the correction, the completion, the pipeline-exit path
-- (deals/pipelineExit.ts), a Kanban drag, an archive -- instead of each one
-- remembering to. The correction gets its atomicity for free.
--
-- It is idempotent, and it coexists with followUpTask.ts rather than
-- fighting it: the commitment is a DAY, so an existing Task already due on
-- the right calendar day (America/Denver, the CRM's one calendar timezone)
-- is left exactly as it is. followUpTask.ts builds its timestamp at the
-- VIEWER's local noon, which no server-side function can reproduce; if this
-- compared instants the two would overwrite each other forever.

create or replace function public.reconcile_decision_follow_up_task(p_opportunity_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_wanted boolean;
  v_task tasks%rowtype;
  v_adoptable boolean;
  v_unlinked_id bigint;
  v_sales_id bigint;
  v_contact_name text;
  v_due timestamptz;
  v_action text;
begin
  select * into v_deal from deals where id = p_opportunity_id;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- The premise of the Task, stated once: an ACTIVE Opportunity sitting at
  -- Decision with a date Leif committed to.
  v_wanted := public.deal_is_active(v_deal.archived_at, v_deal.stage, v_deal.outcome)
              and v_deal.stage = 'decision'
              and v_deal.follow_up_date is not null;

  select * into v_task from tasks
   where opportunity_id = v_deal.id
     and type = 'follow_up'
     and done_date is null
   order by id
   limit 1;

  -- Adopt a legacy unlinked Task -- but only when this Opportunity is
  -- unambiguously the one it is about, which means the Contact has no OTHER
  -- active Opportunity that could equally claim it. Guessing which sale a
  -- Task belongs to is Leif's call, not ours, and a wrong guess would move a
  -- commitment from one programme onto another.
  if not found then
    select not exists (
      select 1 from deals other
       where other.contact_id = v_deal.contact_id
         and other.id <> v_deal.id
         and public.deal_is_active(other.archived_at, other.stage, other.outcome)
    ) into v_adoptable;

    select id into v_unlinked_id from tasks
     where contact_id = v_deal.contact_id
       and opportunity_id is null
       and type = 'follow_up'
       and done_date is null
     order by id
     limit 1;

    if v_adoptable and v_unlinked_id is not null then
      update tasks set opportunity_id = v_deal.id where id = v_unlinked_id;
      select * into v_task from tasks where id = v_unlinked_id;
      v_unlinked_id := null;
    end if;
  end if;

  if not v_wanted then
    if v_task.id is null then
      -- An unlinked Task we declined to adopt is also one we must not
      -- close: it may be about the Contact's OTHER active Opportunity.
      return jsonb_build_object('status', 'none-wanted',
        'action', case when v_unlinked_id is not null
                       then 'deferred-to-unlinked-task'
                       else 'nothing-to-close' end,
        'task_id', v_unlinked_id);
    end if;
    -- Cancelled rather than completed: nobody did it. done_date moves with
    -- it because tasks_completion_agreement_check reads it as "closed at".
    update tasks
       set status = 'cancelled',
           done_date = coalesce(done_date, now())
     where id = v_task.id;
    return jsonb_build_object('status', 'none-wanted', 'action', 'closed',
                              'task_id', v_task.id);
  end if;

  v_due := (v_deal.follow_up_date + time '12:00') at time zone 'America/Denver';

  if v_task.id is not null then
    -- Already on the right day? Then it is already right. Only a genuine
    -- change of commitment rewrites it.
    if (v_task.due_date at time zone 'America/Denver')::date
       is distinct from v_deal.follow_up_date then
      update tasks set due_date = v_due where id = v_task.id;
      v_action := 'retargeted';
    else
      v_action := 'unchanged';
    end if;
    return jsonb_build_object('status', 'wanted', 'action', v_action,
                              'task_id', v_task.id);
  end if;

  -- An unlinked legacy Task we declined to adopt is still a Task telling
  -- Leif to follow up with this person, and one of them is this
  -- Opportunity. Adding a second "Follow up with X" beside it would be
  -- noise, not safety, so this defers to it rather than duplicating it.
  if v_unlinked_id is not null then
    return jsonb_build_object('status', 'wanted',
                              'action', 'deferred-to-unlinked-task',
                              'task_id', v_unlinked_id);
  end if;

  -- Same owner resolution reconcile_sales_call_tasks() uses.
  select id into v_sales_id from sales where administrator = true limit 1;
  select nullif(btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
    into v_contact_name
    from contacts where id = v_deal.contact_id;

  insert into tasks (contact_id, type, text, due_date, status,
                     opportunity_id, sales_id)
  values (v_deal.contact_id, 'follow_up',
          format('Follow up with %s', coalesce(v_contact_name, 'this contact')),
          v_due, 'pending', v_deal.id, v_sales_id)
  returning * into v_task;

  return jsonb_build_object('status', 'wanted', 'action', 'created',
                            'task_id', v_task.id);
end;
$fn$;

comment on function public.reconcile_decision_follow_up_task(bigint) is
    'The single authority over the Decision follow-up Task projection of deals.follow_up_date. Idempotent. Called by the trigger below, so every path that moves an Opportunity reconciles it.';

create or replace function public.sync_decision_follow_up_task()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- A historical import states its own final truth and must not spawn live
  -- Tasks, exactly as handle_deal_won() refuses to fire live onboarding.
  if current_setting('app.migration_mode', true) = 'true' then
    return new;
  end if;
  perform public.reconcile_decision_follow_up_task(new.id);
  return new;
end;
$fn$;

drop trigger if exists on_deal_decision_follow_up_task on public.deals;
create trigger on_deal_decision_follow_up_task
  after insert or update of stage, outcome, follow_up_date, archived_at
  on public.deals
  for each row execute function public.sync_decision_follow_up_task();

-- ---------------------------------------------------------------------
-- 3. The correction command.
-- ---------------------------------------------------------------------
-- IMPRESSIONS ARE TRI-STATE, AND SAY SO. Part 1 reads a blank impression on
-- a converging completion as "unchanged", because a replay must never erase
-- what Leif wrote. A correction genuinely needs all three answers, so the
-- mode is a separate parameter rather than another meaning squeezed into the
-- empty string:
--
--   'unchanged'  leave it exactly as it is   (p_impressions must be null)
--   'set'        replace it                  (p_impressions must be non-blank)
--   'clear'      deliberately empty it       (p_impressions must be null)
--
-- A contradictory pair is a validation-error rather than a silent guess.
--
-- EVERY OTHER PARAMETER IS "null = unchanged", which is unambiguous because
-- none of them has a legal cleared state on a completed attended call: such
-- a call always has an owner decision, and prospect_decision/follow_up_date
-- are DERIVED from the target decision rather than independently clearable.

create or replace function public.correct_completed_sales_call(
  p_sales_call_id bigint,
  p_attendance text default null,
  p_owner_decision text default null,
  p_prospect_decision text default null,
  p_follow_up_date date default null,
  p_impressions text default null,
  p_impressions_mode text default 'unchanged'
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_call sales_calls%rowtype;
  v_deal deals%rowtype;
  v_now timestamptz := now();
  v_instant timestamptz;
  v_newer_id bigint;
  v_lifecycle_requested boolean;
  v_attendance text;
  v_owner text;
  v_prospect text;
  v_target_stage text;
  v_target_outcome text;
  v_target_follow_up date;
  v_impressions text;
  v_impressions_changing boolean := false;
  v_blockers text[] := '{}';
  v_sale jsonb;
  v_before jsonb;
  v_after jsonb;
  v_remaining_no_shows int;
  v_tag_id bigint;
begin
  -- 3a. The shape of the request, before anything is read or written.
  if p_impressions_mode is null
     or p_impressions_mode not in ('unchanged', 'set', 'clear') then
    return jsonb_build_object('status', 'validation-error',
      'message', 'Impressions mode must be unchanged, set or clear.');
  end if;
  if p_impressions_mode = 'set'
     and nullif(btrim(coalesce(p_impressions, ''), E' \t\r\n'), '') is null then
    return jsonb_build_object('status', 'validation-error',
      'message', 'Setting an impression needs some text.');
  end if;
  if p_impressions_mode <> 'set' and p_impressions is not null then
    return jsonb_build_object('status', 'validation-error',
      'message', format('Impressions mode "%s" does not take any text.', p_impressions_mode));
  end if;
  if p_attendance is not null and p_attendance not in ('attended', 'no_show') then
    return jsonb_build_object('status', 'validation-error',
      'message', 'Attendance must be attended or no_show.');
  end if;

  select * into v_call from sales_calls where id = p_sales_call_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- 3b. Only an already-resolved episode has a result to correct. A booked
  --     call is completed, not corrected; a cancelled one never had an
  --     outcome; a completed historical row with no attendance at all (135
  --     of them) has nothing recorded to change either.
  if v_call.status <> 'completed' or v_call.attendance is null then
    return jsonb_build_object('status', 'not-completed',
      'reason', 'This call has no recorded result to correct.');
  end if;
  if v_call.opportunity_id is null then
    return jsonb_build_object('status', 'no-opportunity');
  end if;

  v_lifecycle_requested := p_attendance is not null
                        or p_owner_decision is not null
                        or p_prospect_decision is not null
                        or p_follow_up_date is not null;

  -- 3c. Does a NEWER attended episode already own this Opportunity's
  --     current truth? Same ordering the app's one call-selection model
  --     uses (sales-calls/salesCallSelection.ts): the call's instant
  --     descending, id as the tiebreak, a call with no knowable time
  --     sorting earliest.
  v_instant := coalesce(v_call.scheduled_at,
                        (v_call.scheduled_on + time '23:59') at time zone 'America/Denver',
                        '-infinity'::timestamptz);
  select other.id into v_newer_id
    from sales_calls other
   where other.opportunity_id = v_call.opportunity_id
     and other.id <> v_call.id
     and other.attendance = 'attended'
     and (coalesce(other.scheduled_at,
                   (other.scheduled_on + time '23:59') at time zone 'America/Denver',
                   '-infinity'::timestamptz), other.id) > (v_instant, v_call.id)
   order by coalesce(other.scheduled_at,
                     (other.scheduled_on + time '23:59') at time zone 'America/Denver',
                     '-infinity'::timestamptz) desc, other.id desc
   limit 1;

  if v_newer_id is not null and v_lifecycle_requested then
    return jsonb_build_object('status', 'superseded-call-episode',
      'category', 'newer_attended_episode',
      'superseded_by_sales_call_id', v_newer_id,
      'reason', 'A later call on this Opportunity holds its current result. This one''s impressions can still be corrected.');
  end if;

  select * into v_deal from deals where id = v_call.opportunity_id for update;
  if not found then
    return jsonb_build_object('status', 'no-opportunity');
  end if;

  -- An archived Opportunity is not quietly brought back to life by editing
  -- an old call, the same refusal accept_sale() makes for the same reason.
  if v_deal.archived_at is not null and v_lifecycle_requested then
    return jsonb_build_object('status', 'ambiguous-downstream-state',
      'category', 'archived_opportunity',
      'blockers', to_jsonb(array['archived']::text[]),
      'reason', 'This Opportunity is archived. Un-archive it first if its result really needs changing.');
  end if;

  -- 3d. Attendance. A no-show never touched the Opportunity, so correcting
  --     AWAY from one only ever adds facts. Correcting TO one would have to
  --     retract a decision that has already moved the Opportunity's stage,
  --     and this schema has no backward stage transition and no canonical
  --     command that reverses one. So that direction is refused rather than
  --     guessed at.
  v_attendance := coalesce(p_attendance, v_call.attendance);
  if v_call.attendance = 'attended' and v_attendance = 'no_show' then
    return jsonb_build_object('status', 'ambiguous-downstream-state',
      'category', 'attendance_retraction',
      'reason', 'Recording this call as a no-show would have to undo the decision it already produced on the Opportunity. Change the Opportunity''s own outcome instead.');
  end if;

  -- 3e. The target decision, from the same five-way table
  --     complete_attended_sales_call() uses. No new outcomes, no new
  --     transitions.
  v_owner := coalesce(p_owner_decision, v_deal.owner_decision);
  if v_owner is null then
    return jsonb_build_object('status', 'validation-error',
      'message', 'An owner-fit decision is required for an attended call.');
  end if;
  if v_owner not in ('would_work_with', 'workshops_only', 'do_not_engage') then
    return jsonb_build_object('status', 'validation-error',
      'message', format('"%s" is not an owner decision.', v_owner));
  end if;

  if v_owner = 'would_work_with' then
    v_prospect := coalesce(p_prospect_decision, v_deal.prospect_decision);
    if v_prospect is null then
      return jsonb_build_object('status', 'validation-error',
        'message', 'A prospect decision is required when Would Work With.');
    end if;
    if v_prospect not in ('yes', 'thinking', 'no') then
      -- 'ghosted' is a legal stored value, but it is produced by the
      -- pipeline-exit authority (deals/pipelineExit.ts), never by a call
      -- outcome. Correcting a call's result must not become a second way to
      -- exit the pipeline.
      return jsonb_build_object('status', 'invalid-transition',
        'category', 'not_a_call_outcome',
        'reason', format('"%s" is not something a sales call records. Use Remove from pipeline.', v_prospect));
    end if;
  else
    -- Derived, never independently cleared: only Would Work With has one.
    v_prospect := null;
  end if;

  if v_owner = 'would_work_with' and v_prospect = 'thinking' then
    v_target_stage := 'decision';
    v_target_outcome := null;
    v_target_follow_up := coalesce(p_follow_up_date, v_deal.follow_up_date);
    if v_target_follow_up is null then
      return jsonb_build_object('status', 'missing-decision-date',
        'reason', 'A Decision needs the date the follow-up is owed.');
    end if;
  elsif v_owner = 'would_work_with' and v_prospect = 'yes' then
    v_target_stage := 'won';
    v_target_outcome := null;
    v_target_follow_up := null;
  elsif v_owner = 'would_work_with' and v_prospect = 'no' then
    v_target_stage := v_deal.stage;
    v_target_outcome := 'lost';
    v_target_follow_up := null;
  elsif v_owner = 'do_not_engage' then
    v_target_stage := v_deal.stage;
    v_target_outcome := 'lost';
    v_target_follow_up := null;
  else
    v_target_stage := v_deal.stage;
    v_target_outcome := 'workshops_only';
    v_target_follow_up := null;
  end if;

  -- 3f. CONSEQUENTIAL DOWNSTREAM STATE. Checked here, before a single write,
  --     and the whole correction stops rather than half-applying.
  --
  --     Creating consequential state forward is fine -- a correction to
  --     "they said yes" goes through accept_sale(), the same convergent
  --     primitive the completion uses. What is refused is UNDOING something
  --     outside this transaction's power to undo.
  -- Keyed on the target DECISION, not on the derived stage. The completion's
  -- 'no' branch leaves stage alone, so a Won deal corrected to "they said
  -- no" would compute a target stage of 'won' and slip past a stage
  -- comparison while still writing outcome = 'lost' -- a sale that is won
  -- and lost at once.
  if v_deal.stage = 'won'
     and not (v_owner = 'would_work_with' and v_prospect = 'yes') then
    if exists (select 1 from enrollments where opportunity_id = v_deal.id) then
      v_blockers := v_blockers || 'enrollment'::text;
    end if;
    if exists (select 1 from deal_payment_schedule_items
                where deal_id = v_deal.id
                  and (status = 'paid' or source = 'stripe')) then
      v_blockers := v_blockers || 'payment'::text;
    end if;
    if exists (select 1 from deal_stripe_plan_objects where deal_id = v_deal.id) then
      v_blockers := v_blockers || 'stripe_plan'::text;
    end if;
    if v_deal.offer_page_token is not null then
      v_blockers := v_blockers || 'offer_page_link'::text;
    end if;
    if v_deal.payment_setup_confirmed_at is not null then
      v_blockers := v_blockers || 'payment_setup'::text;
    end if;
    if exists (select 1 from scholarship_slots
                where offer_id = v_deal.offer_id
                  and holder_enrollment_id in
                      (select id from enrollments where opportunity_id = v_deal.id)) then
      v_blockers := v_blockers || 'scholarship_slot'::text;
    end if;
    -- A Won sale with none of the above still means a client was told yes.
    v_blockers := v_blockers || 'won_sale'::text;

    return jsonb_build_object('status', 'ambiguous-downstream-state',
      'category', 'won_opportunity',
      'blockers', to_jsonb(v_blockers),
      'reason', 'This sale is already Won, and what follows a Won sale cannot be safely undone from here.');
  end if;

  -- An Enrollment can exist on a non-Won Opportunity (a historical import,
  -- a repair). Ending the sale underneath a live Enrollment is the same
  -- ambiguity by another route.
  if v_target_outcome is not null
     and exists (select 1 from enrollments
                  where opportunity_id = v_deal.id
                    and status <> 'withdrawn') then
    return jsonb_build_object('status', 'ambiguous-downstream-state',
      'category', 'existing_enrollment',
      'blockers', to_jsonb(array['enrollment']::text[]),
      'reason', 'This Opportunity has a live Enrollment. Ending the sale here would leave a client enrolled in something nobody bought.');
  end if;

  -- Do-not-engage is a STANDING gate on the Contact, not a fact about this
  -- call, and it may be true for reasons this Opportunity knows nothing
  -- about. Setting it is this command's business; deciding it is no longer
  -- true is Leif's.
  if v_deal.owner_decision = 'do_not_engage' and v_owner <> 'do_not_engage' then
    return jsonb_build_object('status', 'ambiguous-downstream-state',
      'category', 'contact_sales_eligibility',
      'blockers', to_jsonb(array['contact_do_not_engage']::text[]),
      'reason', 'This Contact carries a standing do-not-engage decision. Lifting it is a decision about the person, not about this call.');
  end if;

  -- 3g. Impressions.
  if p_impressions_mode = 'set' then
    v_impressions := nullif(btrim(p_impressions, E' \t\r\n'), '');
  elsif p_impressions_mode = 'clear' then
    v_impressions := null;
  else
    v_impressions := v_call.impressions;
  end if;
  v_impressions_changing := p_impressions_mode <> 'unchanged'
                            and v_impressions is distinct from v_call.impressions;

  -- 3h. Nothing to do is an answer, and it writes no audit event. A repeated
  --     identical correction must be a genuine no-op, not a second row in
  --     the history saying nothing changed.
  if v_attendance is not distinct from v_call.attendance
     and v_owner is not distinct from v_deal.owner_decision
     and v_prospect is not distinct from v_deal.prospect_decision
     and v_target_follow_up is not distinct from v_deal.follow_up_date
     and v_target_outcome is not distinct from v_deal.outcome
     and v_target_stage is not distinct from v_deal.stage
     and not v_impressions_changing then
    return jsonb_build_object('status', 'no-change',
      'sales_call_id', v_call.id,
      'opportunity_id', v_deal.id);
  end if;

  v_before := jsonb_build_object(
    'attendance', v_call.attendance,
    'owner_decision', v_deal.owner_decision,
    'prospect_decision', v_deal.prospect_decision,
    'follow_up_date', v_deal.follow_up_date,
    'impressions', v_call.impressions,
    'stage', v_deal.stage,
    'outcome', v_deal.outcome);

  -- 3i. The call episode itself.
  update sales_calls
     set attendance = v_attendance,
         attendance_recorded_at = case
           when v_attendance is distinct from v_call.attendance then v_now
           else attendance_recorded_at end,
         impressions = v_impressions,
         updated_at = v_now
   where id = v_call.id;

  -- 3j. The Opportunity, through the same five branches as the completion.
  if v_owner = 'do_not_engage' then
    update deals
       set owner_decision = 'do_not_engage', prospect_decision = null,
           follow_up_date = null, outcome = 'lost'
     where id = v_deal.id;
    update contacts set sales_eligibility = 'do_not_engage' where id = v_deal.contact_id;

  elsif v_owner = 'workshops_only' then
    update deals
       set owner_decision = 'workshops_only', prospect_decision = null,
           follow_up_date = null, outcome = 'workshops_only'
     where id = v_deal.id;

  elsif v_prospect = 'yes' then
    update deals
       set owner_decision = 'would_work_with', follow_up_date = null,
           outcome = null
     where id = v_deal.id;
    v_sale := public.accept_sale(v_deal.id);
    if v_sale ->> 'status' = 'conflicting-outcome' then
      -- accept_sale() refuses rather than overwriting a recorded end. Its
      -- own words, not a translation of them.
      raise exception 'correction refused by accept_sale: %', v_sale ->> 'reason'
        using errcode = 'raise_exception';
    end if;

  elsif v_prospect = 'no' then
    update deals
       set owner_decision = 'would_work_with', prospect_decision = 'no',
           follow_up_date = null, outcome = 'lost'
     where id = v_deal.id;

  else
    update deals
       set owner_decision = 'would_work_with', prospect_decision = 'thinking',
           follow_up_date = v_target_follow_up, outcome = null,
           stage = 'decision'
     where id = v_deal.id;
  end if;

  -- 3k. The No-show tag is a SUMMARY of the Contact's history, never its
  --     source of truth (record_sales_call_no_show()'s own words). Once no
  --     no-showed call remains, the summary is simply false.
  if v_call.attendance = 'no_show' and v_attendance <> 'no_show' then
    select count(*) into v_remaining_no_shows
      from sales_calls
     where contact_id = v_call.contact_id and attendance = 'no_show';
    if v_remaining_no_shows = 0 then
      select id into v_tag_id from tags where lower(name) = 'no-show' limit 1;
      if v_tag_id is not null then
        update contacts
           set tags = array_remove(coalesce(tags, '{}'::bigint[]), v_tag_id)
         where id = v_call.contact_id;
      end if;
    end if;
  end if;

  -- 3l. Derived internal state. The trigger on deals has already run; this
  --     is belt and braces for the case where the correction changed only
  --     the call row.
  perform public.reconcile_decision_follow_up_task(v_deal.id);

  select * into v_deal from deals where id = v_deal.id;
  select * into v_call from sales_calls where id = v_call.id;

  v_after := jsonb_build_object(
    'attendance', v_call.attendance,
    'owner_decision', v_deal.owner_decision,
    'prospect_decision', v_deal.prospect_decision,
    'follow_up_date', v_deal.follow_up_date,
    'impressions', v_call.impressions,
    'stage', v_deal.stage,
    'outcome', v_deal.outcome);

  -- 3m. The history. The original attendance_recorded event is untouched:
  --     what was first recorded stays recorded, and this says what changed
  --     on top of it.
  insert into sales_call_events (sales_call_id, kind, occurred_at, attendance, correction)
  values (v_call.id, 'outcome_corrected', v_now, v_call.attendance,
          jsonb_build_object('before', v_before, 'after', v_after));

  return jsonb_build_object(
    'status', 'corrected',
    'sales_call_id', v_call.id,
    'opportunity_id', v_deal.id,
    'contact_id', v_deal.contact_id,
    'attendance', v_call.attendance,
    'stage', v_deal.stage,
    'outcome', v_deal.outcome,
    'owner_decision', v_deal.owner_decision,
    'prospect_decision', v_deal.prospect_decision,
    'follow_up_date', v_deal.follow_up_date,
    'impressions', v_call.impressions,
    'enrollments', (select count(*) from enrollments where opportunity_id = v_deal.id),
    'before', v_before);
end;
$fn$;

comment on function public.correct_completed_sales_call(bigint, text, text, text, date, text, text) is
    'Corrects the recorded result of ONE completed sales-call episode. Never inserts a second call, never edits a sibling episode, and refuses before mutating anything when the correction would imply reversing consequential downstream state. Distinct from complete_attended_sales_call(), which stays the first-resolution command and keeps refusing conflicting re-completion.';

-- ---------------------------------------------------------------------
-- 4. Who may correct.
-- ---------------------------------------------------------------------
-- The same posture as the completion command it sits beside: the owner's
-- browser and the service role, nobody else. The two reconcilers are
-- internal -- reconcile_decision_follow_up_task() is reached through the
-- trigger and through the correction command, and PostgreSQL does not check
-- EXECUTE on a trigger function when a trigger fires it.

revoke all on function public.correct_completed_sales_call(bigint, text, text, text, date, text, text) from public, anon;
grant execute on function public.correct_completed_sales_call(bigint, text, text, text, date, text, text) to authenticated;
grant execute on function public.correct_completed_sales_call(bigint, text, text, text, date, text, text) to service_role;

revoke all on function public.reconcile_decision_follow_up_task(bigint) from public, anon, authenticated, service_role;
revoke all on function public.sync_decision_follow_up_task() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. PROVE IT.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'sales_call_events'
       and column_name = 'correction' and data_type = 'jsonb'
  ) then
    raise exception 'sales_call_events.correction is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'sales_call_events_kind_check'
       and pg_get_constraintdef(oid) like '%outcome_corrected%'
  ) then
    raise exception 'sales_call_events still refuses the outcome_corrected kind';
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'sales_call_events_correction_kind_check') then
    raise exception 'nothing stops a correction payload on an unrelated event kind';
  end if;

  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = 'deals' and t.tgname = 'on_deal_decision_follow_up_task'
  ) then
    raise exception 'the Decision follow-up Task reconciler is not attached to deals';
  end if;

  -- The completion command is untouched: correction is a second command,
  -- never a loosening of the first.
  --
  -- Checked with to_regprocedure rather than by matching a string from
  -- pg_get_function_identity_arguments. On PostgreSQL 17 that function
  -- includes parameter NAMES ("p_sales_call_id bigint, ..."), so Part 1's
  -- own assertion that the superseded 4-argument form was gone could never
  -- have failed -- it compared against a bare type list that never matches
  -- anything. to_regprocedure resolves a real signature or returns null,
  -- which is the question both assertions were actually asking. The real
  -- check Part 1 meant to make is carried forward below.
  if to_regprocedure(
       'public.complete_attended_sales_call(bigint, text, text, date, text)') is null then
    raise exception 'complete_attended_sales_call lost its Part 1 signature';
  end if;
  if to_regprocedure(
       'public.complete_attended_sales_call(bigint, text, text, date)') is not null then
    raise exception 'the superseded 4-argument complete_attended_sales_call is back -- a named-argument call would be ambiguous';
  end if;
  if to_regprocedure(
       'public.correct_completed_sales_call(bigint, text, text, text, date, text, text)') is null then
    raise exception 'correct_completed_sales_call is not callable at the signature its grants name';
  end if;

  if not has_function_privilege('authenticated',
       'public.correct_completed_sales_call(bigint, text, text, text, date, text, text)', 'EXECUTE') then
    raise exception 'authenticated cannot correct a sales call';
  end if;
  if has_function_privilege('anon',
       'public.correct_completed_sales_call(bigint, text, text, text, date, text, text)', 'EXECUTE') then
    raise exception 'anon gained EXECUTE on correct_completed_sales_call';
  end if;
  if has_function_privilege('authenticated',
       'public.reconcile_decision_follow_up_task(bigint)', 'EXECUTE') then
    raise exception 'the Task reconciler is reachable from a browser';
  end if;
end $$;
