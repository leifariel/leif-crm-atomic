-- A REBOOKED CALL CARRIES ITS OWN RESULT.
--
-- Cancel-and-rebook is two upstream appointments, so it is two call
-- episodes, and the call that happened is the replacement. When the result
-- was recorded on the ORIGINAL booking instead -- because that was the row
-- on screen and the replacement had not arrived from Acuity yet -- nothing
-- in the CRM could move it: the completion refuses a call that already has
-- a result, the cancellation refuses an attended call, and correction edits
-- the facts of one episode, never which episode they belong to.
--
-- Celia, contact 335, Opportunity 267, is the production case:
--
--   call 330   Acuity 1773916549, Nov 3 18:00 -- the original booking.
--              Recorded attended on Oct 30 at 18:28, with impressions.
--   call 1330  Acuity 1774520411, Oct 30 18:00 -- the call that happened.
--              Arrived from Acuity at 19:17, still booked.
--
-- reconcile_rebooked_sales_call_result(original, replacement) moves the
-- recorded result to the replacement and gives the original the canonical
-- cancellation shape, auditing both, without rewriting either row's schedule
-- or Acuity id, without creating a third episode, and without touching the
-- Opportunity. Its header comment in supabase/schemas/02_functions.sql says
-- exactly what it moves, keeps and refuses.
--
-- Deterministic: one event kind, one widened CHECK, one internal function.
-- It repairs no rows. Celia's repair is a separate, explicit invocation
-- after this is deployed.

begin;

alter table public.sales_call_events
    drop constraint if exists sales_call_events_kind_check;
alter table public.sales_call_events
    add constraint sales_call_events_kind_check check (kind in (
        'booked', 'rescheduled', 'cancelled', 'attendance_recorded',
        'opportunity_attached', 'dismissed', 'outcome_corrected',
        'result_reconciled'));

alter table public.sales_call_events
    drop constraint if exists sales_call_events_correction_kind_check;
alter table public.sales_call_events
    add constraint sales_call_events_correction_kind_check check (
        correction is null or kind in ('outcome_corrected', 'result_reconciled'));

comment on column public.sales_call_events.correction is
    'Set only for kind = ''outcome_corrected'' ({"before": {...}, "after": {...}} over the five correctable facts) and kind = ''result_reconciled'' (a recorded result moved from a cancelled original booking to the rebooked call that happened: both episode ids, the moved facts, and both rows before). The original ''attendance_recorded'' event is never rewritten.';

create or replace function public.reconcile_rebooked_sales_call_result(
  p_original_sales_call_id bigint,
  p_replacement_sales_call_id bigint
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_original sales_calls%rowtype;
  v_replacement sales_calls%rowtype;
  v_now timestamptz := now();
  v_other_attended bigint;
  v_moved jsonb;
  v_original_before jsonb;
  v_replacement_before jsonb;
  v_tasks_cancelled int := 0;
  v_tasks_completed bigint := 0;
begin
  if p_original_sales_call_id is null or p_replacement_sales_call_id is null
     or p_original_sales_call_id = p_replacement_sales_call_id then
    return jsonb_build_object('status', 'validation-error',
      'reason', 'Two different calls are needed: the original booking and the one that replaced it.');
  end if;

  -- Both rows, locked in id order so two concurrent attempts cannot
  -- deadlock on each other.
  perform 1 from sales_calls
   where id in (p_original_sales_call_id, p_replacement_sales_call_id)
   order by id for update;
  select * into v_original from sales_calls where id = p_original_sales_call_id;
  select * into v_replacement from sales_calls where id = p_replacement_sales_call_id;
  if v_original.id is null or v_replacement.id is null then
    return jsonb_build_object('status', 'not-found');
  end if;

  if v_original.opportunity_id is null
     or v_original.opportunity_id is distinct from v_replacement.opportunity_id then
    return jsonb_build_object('status', 'refused', 'category', 'different_opportunity',
      'reason', 'The two calls do not belong to the same Opportunity.');
  end if;
  if v_original.contact_id is distinct from v_replacement.contact_id then
    return jsonb_build_object('status', 'refused', 'category', 'different_contact',
      'reason', 'The two calls do not belong to the same person.');
  end if;
  if v_original.acuity_appointment_id is not null
     and v_original.acuity_appointment_id = v_replacement.acuity_appointment_id then
    return jsonb_build_object('status', 'refused', 'category', 'same_upstream_appointment',
      'reason', 'One upstream appointment moved in time is a reschedule, not a rebooking.');
  end if;

  -- Already done: the replacement carries a result moved from exactly this
  -- original, and the original is cancelled with none. Nothing to write.
  if v_original.status = 'cancelled'
     and v_original.attendance is null
     and v_replacement.status = 'completed'
     and v_replacement.attendance is not null
     and exists (select 1 from sales_call_events e
                  where e.sales_call_id = v_replacement.id
                    and e.kind = 'result_reconciled'
                    and (e.correction ->> 'from_sales_call_id')::bigint = v_original.id) then
    return jsonb_build_object('status', 'already-reconciled',
      'original_sales_call_id', v_original.id,
      'replacement_sales_call_id', v_replacement.id);
  end if;

  if v_replacement.created_at <= v_original.created_at then
    return jsonb_build_object('status', 'refused', 'category', 'not_a_rebooking',
      'reason', 'The replacement was booked before the original, so it did not replace it.');
  end if;
  if v_original.status <> 'completed' or v_original.attendance is null then
    return jsonb_build_object('status', 'refused', 'category', 'nothing_to_move',
      'reason', 'The original booking carries no recorded result to move.');
  end if;
  if v_replacement.status <> 'booked' or v_replacement.attendance is not null then
    return jsonb_build_object('status', 'refused', 'category', 'replacement_not_open',
      'reason', 'The replacement already has a result of its own; moving another onto it would make two.');
  end if;

  select s.id into v_other_attended
    from sales_calls s
   where s.opportunity_id = v_original.opportunity_id
     and s.attendance is not null
     and s.id not in (v_original.id, v_replacement.id)
   order by s.id
   limit 1;
  if v_other_attended is not null then
    return jsonb_build_object('status', 'refused', 'category', 'ambiguous_episode',
      'other_sales_call_id', v_other_attended,
      'reason', 'Another call on this Opportunity also has a recorded result, so which call happened is not certain.');
  end if;

  v_moved := jsonb_build_object(
    'attendance', v_original.attendance,
    'attendance_recorded_at', v_original.attendance_recorded_at,
    'impressions', v_original.impressions);
  v_original_before := jsonb_build_object(
    'status', v_original.status,
    'attendance', v_original.attendance,
    'attendance_recorded_at', v_original.attendance_recorded_at,
    'impressions', v_original.impressions,
    'scheduled_at', v_original.scheduled_at,
    'acuity_appointment_id', v_original.acuity_appointment_id);
  v_replacement_before := jsonb_build_object(
    'status', v_replacement.status,
    'attendance', v_replacement.attendance,
    'attendance_recorded_at', v_replacement.attendance_recorded_at,
    'impressions', v_replacement.impressions,
    'scheduled_at', v_replacement.scheduled_at,
    'acuity_appointment_id', v_replacement.acuity_appointment_id);

  -- The original first, so the one-booked-per-Opportunity index never sees
  -- two live rows. Schedule, original schedule and Acuity id stay as the
  -- upstream booking recorded them.
  update sales_calls
     set status = 'cancelled',
         cancelled_at = coalesce(v_original.cancelled_at, v_now),
         attendance = null,
         attendance_recorded_at = null,
         impressions = null,
         updated_at = v_now
   where id = v_original.id;

  update sales_calls
     set status = 'completed',
         attendance = v_original.attendance,
         -- When Leif recorded it, not now: this moves a fact, it does not
         -- record a new one.
         attendance_recorded_at = v_original.attendance_recorded_at,
         impressions = v_original.impressions,
         updated_at = v_now
   where id = v_replacement.id;

  -- The canonical cancellation's history and Task treatment, for the
  -- booking that did not happen.
  insert into sales_call_events (sales_call_id, kind, occurred_at)
  values (v_original.id, 'cancelled', v_now);
  update tasks
     set status = 'cancelled', done_date = v_now
   where sales_call_id = v_original.id
     and status in ('pending', 'waiting');
  get diagnostics v_tasks_cancelled = row_count;

  -- A Task about the replacement booking is done: the call happened.
  v_tasks_completed := public.close_tasks_for_sales_call(v_replacement.id, v_now);

  insert into sales_call_events (sales_call_id, kind, occurred_at, attendance, correction)
  values
    (v_replacement.id, 'result_reconciled', v_now, v_original.attendance,
     jsonb_build_object(
       'direction', 'moved_in',
       'reason', 'cancel_rebook',
       'from_sales_call_id', v_original.id,
       'to_sales_call_id', v_replacement.id,
       'moved', v_moved,
       'original_before', v_original_before,
       'replacement_before', v_replacement_before)),
    (v_original.id, 'result_reconciled', v_now, v_original.attendance,
     jsonb_build_object(
       'direction', 'moved_out',
       'reason', 'cancel_rebook',
       'from_sales_call_id', v_original.id,
       'to_sales_call_id', v_replacement.id,
       'moved', v_moved,
       'original_before', v_original_before,
       'replacement_before', v_replacement_before));

  return jsonb_build_object(
    'status', 'reconciled',
    'opportunity_id', v_original.opportunity_id,
    'original_sales_call_id', v_original.id,
    'replacement_sales_call_id', v_replacement.id,
    'moved', v_moved,
    'original_tasks_cancelled', v_tasks_cancelled,
    'replacement_tasks_completed', v_tasks_completed,
    'opportunity_unchanged', true);
end;
$fn$;

revoke all on function public.reconcile_rebooked_sales_call_result(bigint, bigint) from public, anon, authenticated, service_role;

do $$
begin
  if to_regprocedure('public.reconcile_rebooked_sales_call_result(bigint, bigint)') is null then
    raise exception 'reconcile_rebooked_sales_call_result is missing';
  end if;
  if has_function_privilege('authenticated',
       'public.reconcile_rebooked_sales_call_result(bigint, bigint)', 'EXECUTE')
     or has_function_privilege('anon',
       'public.reconcile_rebooked_sales_call_result(bigint, bigint)', 'EXECUTE')
     or has_function_privilege('service_role',
       'public.reconcile_rebooked_sales_call_result(bigint, bigint)', 'EXECUTE') then
    raise exception 'an API role can call the rebook reconciliation';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'sales_call_events_kind_check'
       and pg_get_constraintdef(oid) like '%result_reconciled%'
  ) then
    raise exception 'sales_call_events still refuses the result_reconciled kind';
  end if;
end;
$$;

commit;
