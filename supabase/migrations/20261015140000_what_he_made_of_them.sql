-- WHAT LEIF MADE OF THEM, IN HIS OWN WORDS.
--
-- Sales Call Workflow Part 1. A completed call records whether they showed,
-- whether Leif would work with them, and what they decided. It has never had
-- anywhere to put the thing Leif actually remembers afterwards: the
-- impression. So it went into a note, or nowhere.
--
-- WHY ON sales_calls AND NOT ON deals. An impression belongs to the CALL, not
-- to the Opportunity. Rebooking is a real supported workflow -- 20
-- Opportunities in production already carry more than one completed call --
-- and what Leif made of somebody in September is not what he made of them in
-- November. One authoritative result PER SALES-CALL EPISODE; putting this on
-- the Opportunity would overwrite the first episode's memory with the
-- second's.
--
-- NULLABLE, AND NOT BACKFILLED. 176 completed calls exist and 135 of them do
-- not even record attendance, because they predate the field. A historical
-- call with no impression is a historical fact, not a gap to fill.
--
-- It joins the EXISTING atomic completion path rather than getting a save of
-- its own: complete_attended_sales_call() already commits attendance, the
-- owner's fit decision, the prospect's decision, the follow-up date, the
-- sales_call_events row and the task reconciliation in one transaction. A
-- second request for the impression is how you end up with a call whose
-- outcome saved and whose impression did not.
--
-- Deterministic: adds a nullable column and replaces a function. Asserts
-- structure only and replays into an empty database.

alter table public.sales_calls
    add column if not exists impressions text;

comment on column public.sales_calls.impressions is
    'Optional free text: what Leif made of this specific call. Per call episode, never per Opportunity -- a rebooked call is a different conversation. Nullable and never backfilled; a historical call without one is a fact, not a gap.';

-- The signature gains one optional parameter. Replaced rather than
-- overloaded: the dataProvider calls this with NAMED arguments through
-- PostgREST, and two candidates differing only by a defaulted trailing
-- parameter is exactly how a named-argument call becomes ambiguous.
drop function if exists public.complete_attended_sales_call(bigint, text, text, date);

create or replace function public.complete_attended_sales_call(
  p_sales_call_id bigint,
  p_owner_decision text,
  p_prospect_decision text default null,
  p_follow_up_date date default null,
  p_impressions text default null
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
  -- btrim() with no character set trims SPACES ONLY -- a value of just a
  -- newline survived it and got stored, while the fakerest mirror's JS
  -- .trim() stripped it. The two runtimes disagreed until a real-Postgres
  -- test caught it, so the whitespace set is named explicitly.
  v_impressions text := nullif(btrim(coalesce(p_impressions, ''), E' \t\r\n'), '');
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

  if v_call.attendance = 'no_show' then
    return jsonb_build_object('status', 'already-completed');
  end if;

  if v_call.attendance is null then
    update sales_calls
       set attendance = 'attended',
           attendance_recorded_at = v_now,
           status = 'completed',
           -- Blank stays blank; it does not erase anything, because there is
           -- nothing yet to erase.
           impressions = v_impressions,
           updated_at = v_now
     where id = v_call.id;
  else
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

    -- A converging replay may carry an impression the first pass did not.
    -- It may NEVER erase one: an omitted or blank value means "unchanged",
    -- not "delete what he wrote". Clearing an impression deliberately is
    -- Part 2's correction path, which does not exist yet.
    if v_impressions is not null then
      update sales_calls
         set impressions = v_impressions,
             updated_at = v_now
       where id = v_call.id;
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
  select * into v_call from sales_calls where id = v_call.id;

  return jsonb_build_object(
    'status', case when v_converged then 'converged' else 'completed' end,
    'opportunity_id', v_deal.id,
    'contact_id', v_deal.contact_id,
    'stage', v_deal.stage,
    'outcome', v_deal.outcome,
    'follow_up_date', v_follow_up,
    'impressions', v_call.impressions,
    'enrollments', (select count(*) from enrollments where opportunity_id = v_deal.id)
  );
end;
$fn$;

revoke all on function public.complete_attended_sales_call(bigint, text, text, date, text) from public;
revoke all on function public.complete_attended_sales_call(bigint, text, text, date, text) from anon;
grant execute on function public.complete_attended_sales_call(bigint, text, text, date, text) to authenticated;
grant execute on function public.complete_attended_sales_call(bigint, text, text, date, text) to service_role;

-- PROVE IT: the column exists and is nullable, the old 4-argument signature
-- is gone, and the new one is reachable by exactly the roles the old one was.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'sales_calls'
       and column_name = 'impressions' and is_nullable = 'YES'
  ) then
    raise exception 'sales_calls.impressions is missing or NOT NULL';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'complete_attended_sales_call'
       and pg_get_function_identity_arguments(p.oid) = 'bigint, text, text, date'
  ) then
    raise exception 'the 4-argument complete_attended_sales_call still exists -- a named-argument call would be ambiguous';
  end if;

  if not has_function_privilege('authenticated',
       'public.complete_attended_sales_call(bigint, text, text, date, text)', 'EXECUTE') then
    raise exception 'authenticated lost EXECUTE on complete_attended_sales_call';
  end if;
  if has_function_privilege('anon',
       'public.complete_attended_sales_call(bigint, text, text, date, text)', 'EXECUTE') then
    raise exception 'anon gained EXECUTE on complete_attended_sales_call';
  end if;
end $$;
