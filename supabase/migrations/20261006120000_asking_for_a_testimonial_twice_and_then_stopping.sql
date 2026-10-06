-- Asking for a testimonial, twice, and then stopping.
--
-- Day 0 at the active -> offboarding transition: collect the testimonial.
-- Day 7: ask again, but only if it has not arrived AND the first ask is
-- done. Day 14: ask once more, same conditions. Then stop, for good.
--
-- WHY THIS IS NOT AN OFFBOARDING REQUIREMENT.
-- enforce_enrollment_completion_requirements() refuses
-- `offboarding -> completed` while any is_required offboarding item is not
-- 'done'. A testimonial depends on the CLIENT replying, which Leif does
-- not control, so a required item would strand the Enrollment in
-- offboarding on somebody who may never answer. Leif controls whether he
-- ASKS; he does not control whether they ANSWER, and the schema must not
-- confuse the two. So the sequence hangs off the Enrollment and the task
-- system, touches no offboarding item, and routine offboarding completes
-- without it.
--
-- OUTREACH DONE IS NOT A TESTIMONIAL RECEIVED. Completing
-- `collect_testimonial` means Leif asked. Only testimonial_received_at
-- means it arrived. Exhausting both follow-ups never sets it: the honest
-- end state is "asked twice, never received".
--
-- THE ANCHOR ALREADY EXISTS. enrollment_status_events records every
-- transition with its own entered_at, so Day 0 is the entered_at of the
-- 'offboarding' event — durable, and it survives the Enrollment later
-- becoming 'completed' or 'ended'. Nothing is inferred from updated_at,
-- and the sequence keeps running after routine offboarding finishes.
--
-- Deterministic: structure and configuration only. The one seeded value
-- is matched on the Offer's NAME, so it reconstructs in any database.

-- ---------------------------------------------------------------------
-- 1. Did the testimonial arrive? The one authoritative answer.
-- ---------------------------------------------------------------------
-- On the Enrollment, because that is the engagement the testimonial is
-- about, and because it must outlive the offboarding status. Nullable:
-- NULL is a truthful "not received", including after both asks are spent.
alter table public.enrollments
    add column if not exists testimonial_received_at timestamp with time zone;

-- ---------------------------------------------------------------------
-- 2. Which programmes ask, and from when
-- ---------------------------------------------------------------------
-- Growing Yourself Up uses this same offboarding engine (it has its own
-- requirement templates, slack_removed and calendar_removed), so "LE
-- only" has to be stated rather than assumed. Switching GYU on later is
-- one update, and it is Leif's decision, not a side effect of this one.
alter table public.offers
    add column if not exists collects_testimonial boolean not null default false;

update public.offers
   set collects_testimonial = true
 where name = 'The Living Example';

-- Prospective only, the same posture as kit_integration_settings: an
-- Enrollment that began offboarding before this boundary is never
-- enrolled in the sequence, so deploying this surprises nobody with
-- tasks about clients who left months ago.
create table if not exists public.testimonial_sequence_settings (
    id integer not null default 1 primary key,
    not_before timestamp with time zone not null,
    created_at timestamp with time zone not null default now(),
    constraint testimonial_sequence_settings_singleton check (id = 1)
);

insert into public.testimonial_sequence_settings (id, not_before)
values (1, now())
on conflict (id) do nothing;

alter table public.testimonial_sequence_settings enable row level security;

drop policy if exists "Enable read access for authenticated users" on public.testimonial_sequence_settings;
create policy "Enable read access for authenticated users"
  on public.testimonial_sequence_settings for select to authenticated using (true);

grant all on table public.testimonial_sequence_settings to anon;
grant all on table public.testimonial_sequence_settings to authenticated;
grant all on table public.testimonial_sequence_settings to service_role;
revoke select, insert, update, delete on table public.testimonial_sequence_settings from anon;

-- ---------------------------------------------------------------------
-- 3. Three stages with machine identity
-- ---------------------------------------------------------------------
-- Distinct task types, not parsed descriptions. `other` is deliberately
-- NOT reused: the schema already describes it as Leif's own task that
-- machinery never closes, and these three are machinery's.
alter table public.tasks
    drop constraint if exists tasks_type_check;
alter table public.tasks
    add constraint tasks_type_check CHECK ((type = ANY (ARRAY[
      'sales_call_needs_matching'::text, 'resolve_sales_call'::text,
      'sales_call'::text, 'follow_up'::text,
      'resolve_client_session_cadence'::text, 'onboarding_item'::text,
      'offboarding_item'::text, 'review_application'::text, 'other'::text,
      'nurture_follow_up'::text, 'sales_call_cancelled'::text,
      'sales_call_no_show'::text, 'check_payment'::text,
      'collect_testimonial'::text, 'testimonial_followup_1'::text,
      'testimonial_followup_2'::text])));

-- The idempotency AUTHORITY, not a check-then-insert in a function: at
-- most ONE task per stage per Enrollment, ever. Unlike the other task
-- context indexes this is not scoped to open tasks, because a spent stage
-- must never come back — that is what "then stopping" means. Two
-- concurrent reconciler runs cannot both win.
create unique index if not exists tasks_one_testimonial_stage_per_enrollment
  on public.tasks (enrollment_id, type)
  where enrollment_id is not null
    and type in ('collect_testimonial', 'testimonial_followup_1',
                 'testimonial_followup_2');

-- ---------------------------------------------------------------------
-- 4. The reconciler
-- ---------------------------------------------------------------------
-- The person the task is about, named the same way the offboarding
-- trigger names them, so a testimonial task reads like its neighbours.
create or replace function public.testimonial_person(p_enrollment_id bigint)
  returns text
  language sql
  stable
  set search_path to 'public'
as $$
  select coalesce(
    nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
    d.name,
    'this client')
    from enrollments e
    join deals d on d.id = e.opportunity_id
    left join contacts c on c.id = d.contact_id
   where e.id = p_enrollment_id;
$$;


-- Same shape as reconcile_application_review_tasks(): safe to run as
-- often as anything likes, creating only what is due and closing only
-- what is no longer wanted. Hourly by cron, below.
create or replace function public.reconcile_testimonial_tasks()
  returns integer
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  v_sales_id bigint;
  v_not_before timestamp with time zone;
  v_created int := 0;
  v_cancelled int;
begin
  select id into v_sales_id from sales where administrator = true
   order by id limit 1;
  select not_before into v_not_before
    from testimonial_sequence_settings where id = 1;
  if v_not_before is null then
    return 0;
  end if;

  -- The testimonial arrived, so nothing further is wanted. Cancelled, not
  -- completed: Leif did not do these, they stopped being necessary. The
  -- status says which, and the history stays.
  update tasks t
     set status = 'cancelled', done_date = now()
   where t.type in ('collect_testimonial', 'testimonial_followup_1',
                    'testimonial_followup_2')
     and t.done_date is null
     and exists (
       select 1 from enrollments e
        where e.id = t.enrollment_id
          and e.testimonial_received_at is not null
     );
  get diagnostics v_cancelled = row_count;

  -- Every Enrollment eligible for the sequence, with its Day 0.
  with eligible as (
    select e.id as enrollment_id,
           d.contact_id,
           (select max(ev.entered_at)
              from enrollment_status_events ev
             where ev.enrollment_id = e.id
               and ev.status = 'offboarding') as started_at
      from enrollments e
      join deals d on d.id = e.opportunity_id
      join offers o on o.id = d.offer_id
     where o.collects_testimonial
       and e.testimonial_received_at is null
  ),
  dated as (
    select * from eligible
     where started_at is not null
       and started_at >= v_not_before
  ),
  -- Stage 1 the moment offboarding starts. The trigger below normally
  -- gets there first; this is what makes a missed trigger recoverable.
  stage_1 as (
    insert into tasks (contact_id, type, text, due_date, status,
                       enrollment_id, sales_id)
    select dated.contact_id,
           'collect_testimonial',
           format('Collect %s''s testimonial', testimonial_person(dated.enrollment_id)),
           dated.started_at,
           'pending',
           dated.enrollment_id,
           v_sales_id
      from dated
     where not exists (
       select 1 from tasks t
        where t.enrollment_id = dated.enrollment_id
          and t.type = 'collect_testimonial'
     )
    on conflict do nothing
    returning 1
  ),
  -- Day 7, and only once the first ask is genuinely DONE. If the initial
  -- request is still open on day 7 there is no honest "follow-up" to
  -- raise, so none is raised; when Leif finishes it later, this becomes
  -- due on the next run, because its date has already passed.
  stage_2 as (
    insert into tasks (contact_id, type, text, due_date, status,
                       enrollment_id, sales_id)
    select dated.contact_id,
           'testimonial_followup_1',
           format('Follow up for %s''s testimonial — 1/2', testimonial_person(dated.enrollment_id)),
           dated.started_at + interval '7 days',
           'pending',
           dated.enrollment_id,
           v_sales_id
      from dated
     where now() >= dated.started_at + interval '7 days'
       and exists (
         select 1 from tasks t
          where t.enrollment_id = dated.enrollment_id
            and t.type = 'collect_testimonial'
            and t.status = 'completed'
       )
       and not exists (
         select 1 from tasks t
          where t.enrollment_id = dated.enrollment_id
            and t.type = 'testimonial_followup_1'
       )
    on conflict do nothing
    returning 1
  ),
  -- Day 14, same rule one stage along. After this one there is nothing.
  stage_3 as (
    insert into tasks (contact_id, type, text, due_date, status,
                       enrollment_id, sales_id)
    select dated.contact_id,
           'testimonial_followup_2',
           format('Follow up for %s''s testimonial — 2/2', testimonial_person(dated.enrollment_id)),
           dated.started_at + interval '14 days',
           'pending',
           dated.enrollment_id,
           v_sales_id
      from dated
     where now() >= dated.started_at + interval '14 days'
       and exists (
         select 1 from tasks t
          where t.enrollment_id = dated.enrollment_id
            and t.type = 'testimonial_followup_1'
            and t.status = 'completed'
       )
       and not exists (
         select 1 from tasks t
          where t.enrollment_id = dated.enrollment_id
            and t.type = 'testimonial_followup_2'
       )
    on conflict do nothing
    returning 1
  )
  select (select count(*) from stage_1)
       + (select count(*) from stage_2)
       + (select count(*) from stage_3)
    into v_created;

  return v_created + v_cancelled;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Day 0 immediately, rather than up to an hour later
-- ---------------------------------------------------------------------
create or replace function public.handle_enrollment_testimonial_start()
  returns trigger
  language plpgsql
  set search_path to 'public'
as $$
declare
  v_contact_id bigint;
  v_sales_id bigint;
begin
  if new.status = 'offboarding' and old.status = 'active'
     and new.testimonial_received_at is null then
    if exists (
      select 1 from deals d
        join offers o on o.id = d.offer_id
       where d.id = new.opportunity_id and o.collects_testimonial
    ) and exists (
      select 1 from testimonial_sequence_settings
       where id = 1 and now() >= not_before
    ) then
      select d.contact_id into v_contact_id
        from deals d where d.id = new.opportunity_id;
      select id into v_sales_id from sales where administrator = true
       order by id limit 1;

      -- ON CONFLICT so the unique index, not this function, is what
      -- guarantees one stage-1 task.
      insert into tasks (contact_id, type, text, due_date, status,
                         enrollment_id, sales_id)
      values (v_contact_id, 'collect_testimonial',
              format('Collect %s''s testimonial', testimonial_person(new.id)),
              now(), 'pending', new.id, v_sales_id)
      on conflict do nothing;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_enrollment_testimonial_start on public.enrollments;
create trigger on_enrollment_testimonial_start
  after update on public.enrollments
  for each row execute function public.handle_enrollment_testimonial_start();

-- ---------------------------------------------------------------------
-- 6. Receipt suppresses the open ask immediately
-- ---------------------------------------------------------------------
-- Without this, an open reminder would keep surfacing until the next
-- hourly run — which is the CRM telling Leif to chase something it
-- already knows arrived.
create or replace function public.handle_testimonial_received()
  returns trigger
  language plpgsql
  set search_path to 'public'
as $$
begin
  if new.testimonial_received_at is not null
     and old.testimonial_received_at is null then
    update tasks
       set status = 'cancelled', done_date = now()
     where enrollment_id = new.id
       and done_date is null
       and type in ('collect_testimonial', 'testimonial_followup_1',
                    'testimonial_followup_2');
  end if;
  return new;
end;
$$;

drop trigger if exists on_testimonial_received on public.enrollments;
create trigger on_testimonial_received
  after update of testimonial_received_at on public.enrollments
  for each row execute function public.handle_testimonial_received();

-- ---------------------------------------------------------------------
-- 6b. Nobody's to call but the scheduler's
-- ---------------------------------------------------------------------
-- A SECURITY DEFINER function is created with EXECUTE to PUBLIC, which
-- would let anon drive the reconciler through PostgREST. Both sibling
-- reconcilers are locked to postgres (postgres=X/postgres), so these match
-- them. service_role is added deliberately: it is the server-side key, is
-- never shipped to a browser, and it is how the e2e harness legitimately
-- drives a maintenance function on demand instead of waiting an hour.
--
-- testimonial_person() is locked down for a plainer reason: it returns a
-- client's NAME, and it is only ever called from inside the two functions
-- above.
revoke all on function public.reconcile_testimonial_tasks() from public;
revoke all on function public.reconcile_testimonial_tasks() from anon;
revoke all on function public.reconcile_testimonial_tasks() from authenticated;
grant execute on function public.reconcile_testimonial_tasks() to service_role;

-- testimonial_person() stays callable by the signed-in owner and the
-- server key, and is revoked from anon. It is NOT locked to postgres: the
-- offboarding trigger is a plain trigger function, so it runs as whoever
-- made the UPDATE, and locking this away made "Start offboarding" fail
-- outright with "permission denied for function testimonial_person" for
-- every real user. The function only formats a name out of contacts and
-- deals, both of which an authenticated owner can already read, so this
-- grants nothing they did not have — while anon still gets nothing.
revoke all on function public.testimonial_person(bigint) from public;
revoke all on function public.testimonial_person(bigint) from anon;
grant execute on function public.testimonial_person(bigint) to authenticated;
grant execute on function public.testimonial_person(bigint) to service_role;

revoke all on function public.handle_enrollment_testimonial_start() from public;
revoke all on function public.handle_enrollment_testimonial_start() from anon;
revoke all on function public.handle_enrollment_testimonial_start() from authenticated;

revoke all on function public.handle_testimonial_received() from public;
revoke all on function public.handle_testimonial_received() from anon;
revoke all on function public.handle_testimonial_received() from authenticated;

-- ---------------------------------------------------------------------
-- 7. Hourly, like its siblings
-- ---------------------------------------------------------------------
select cron.unschedule('reconcile-testimonial-tasks')
 where exists (select 1 from cron.job where jobname = 'reconcile-testimonial-tasks');

select cron.schedule(
  'reconcile-testimonial-tasks',
  '53 * * * *',
  $job$ select public.reconcile_testimonial_tasks(); $job$
);

-- ---------------------------------------------------------------------
-- 8. Self-proving
-- ---------------------------------------------------------------------
-- Shape first, then the cadence itself, exercised on rows inside a
-- subtransaction that is always rolled back.
do $$
declare
  v_offer bigint;
  v_contact bigint;
  v_deal bigint;
  v_enrollment bigint;
  v_started timestamp with time zone;
  v_count int;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'enrollments'
       and column_name = 'testimonial_received_at'
  ) then
    raise exception 'enrollments.testimonial_received_at must exist';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'tasks_one_testimonial_stage_per_enrollment'
  ) then
    raise exception 'the testimonial stage uniqueness index is missing';
  end if;

  -- The Living Example asks; nothing else was switched on by this.
  if not exists (
    select 1 from offers where name = 'The Living Example' and collects_testimonial
  ) then
    raise exception 'The Living Example must collect testimonials';
  end if;
  select count(*) into v_count from offers
   where collects_testimonial and name <> 'The Living Example';
  if v_count <> 0 then
    raise exception 'only The Living Example may be switched on here, found % others', v_count;
  end if;

  if not exists (select 1 from cron.job where jobname = 'reconcile-testimonial-tasks') then
    raise exception 'the testimonial reconciler is not scheduled';
  end if;

  -- Nothing a browser holds may drive the reconciler or read a client's
  -- name out of testimonial_person().
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('reconcile_testimonial_tasks',
                         'handle_enrollment_testimonial_start',
                         'handle_testimonial_received')
       and (has_function_privilege('anon', p.oid, 'execute')
         or has_function_privilege('authenticated', p.oid, 'execute'))
  ) then
    raise exception 'a testimonial function is still reachable from the browser';
  end if;

  -- anon must not reach the name formatter either, but the signed-in owner
  -- MUST: the offboarding trigger calls it as whoever pressed the button.
  if has_function_privilege('anon', 'public.testimonial_person(bigint)', 'execute') then
    raise exception 'anon must not be able to read a client name through testimonial_person';
  end if;
  if not has_function_privilege('authenticated', 'public.testimonial_person(bigint)', 'execute') then
    raise exception 'the owner must be able to start offboarding';
  end if;

  -- Behaviour, on rows that cannot survive.
  select id into v_offer from offers where name = 'The Living Example';
  if v_offer is null then
    return;
  end if;

  begin
    insert into contacts (first_name, last_name, email_jsonb, phone_jsonb,
                          tags, sales_eligibility, first_seen, last_seen)
    values ('Cadence', 'Assertion', '[]'::jsonb, '[]'::jsonb, '{}',
            'normal', now(), now())
    returning id into v_contact;

    -- Winning the Opportunity is what creates the Enrollment
    -- (handle_deal_won), and opportunity_id is unique — so the fixture
    -- takes the one the CRM made rather than inserting a second.
    insert into deals (name, contact_id, offer_id, stage, amount, index,
                       created_at, updated_at, stage_entered_at)
    values ('Cadence Assertion — probe', v_contact, v_offer, 'won', 0, 0,
            now(), now(), now())
    returning id into v_deal;

    select id into v_enrollment from enrollments where opportunity_id = v_deal;
    if v_enrollment is null then
      raise exception 'winning the opportunity should have created an enrollment';
    end if;

    -- The lifecycle refuses skipped stages, and activation refuses an
    -- unfinished onboarding checklist, so walk it properly.
    update enrollment_onboarding_items set status = 'done'
     where enrollment_id = v_enrollment;
    update enrollments set status = 'active' where id = v_enrollment;

    -- Day 0: the transition raises exactly one ask.
    update enrollments set status = 'offboarding' where id = v_enrollment;

    select count(*) into v_count from tasks
     where enrollment_id = v_enrollment and type = 'collect_testimonial';
    if v_count <> 1 then
      raise exception 'offboarding must raise exactly one testimonial ask, found %', v_count;
    end if;

    -- Repeated reconciliation adds nothing.
    perform reconcile_testimonial_tasks();
    perform reconcile_testimonial_tasks();
    -- Only the testimonial stages: this Enrollment also legitimately
    -- carries its onboarding and offboarding checklist tasks.
    select count(*) into v_count from tasks
     where enrollment_id = v_enrollment
       and type in ('collect_testimonial', 'testimonial_followup_1',
                    'testimonial_followup_2');
    if v_count <> 1 then
      raise exception 'the reconciler must be idempotent, found % testimonial tasks', v_count;
    end if;

    -- Day 7 with the first ask still OPEN: no follow-up, because there is
    -- nothing honest to follow up on.
    -- Travel the fixture back in time rather than waiting a week. The
    -- prospective boundary moves with it: an anchor backdated past
    -- not_before would simply stop being eligible, which is the boundary
    -- doing its job, not the cadence failing.
    update testimonial_sequence_settings
       set not_before = now() - interval '60 days' where id = 1;

    select max(entered_at) into v_started from enrollment_status_events
     where enrollment_id = v_enrollment and status = 'offboarding';
    update enrollment_status_events
       set entered_at = v_started - interval '8 days'
     where enrollment_id = v_enrollment and status = 'offboarding';

    perform reconcile_testimonial_tasks();
    if exists (select 1 from tasks
                where enrollment_id = v_enrollment
                  and type = 'testimonial_followup_1') then
      raise exception 'an open initial ask must not produce a follow-up';
    end if;

    -- Finish the ask: now the follow-up is due.
    update tasks set status = 'completed', done_date = now()
     where enrollment_id = v_enrollment and type = 'collect_testimonial';
    perform reconcile_testimonial_tasks();
    select count(*) into v_count from tasks
     where enrollment_id = v_enrollment and type = 'testimonial_followup_1';
    if v_count <> 1 then
      raise exception 'day 7 must raise exactly one follow-up, found %', v_count;
    end if;

    -- Day 13 equivalent: still no second follow-up.
    if exists (select 1 from tasks
                where enrollment_id = v_enrollment
                  and type = 'testimonial_followup_2') then
      raise exception 'follow-up 2 must not appear before day 14';
    end if;

    -- The testimonial arrives: the open follow-up is CANCELLED, not
    -- completed, and nothing new is ever raised.
    update enrollments set testimonial_received_at = now() where id = v_enrollment;
    select count(*) into v_count from tasks
     where enrollment_id = v_enrollment
       and type = 'testimonial_followup_1'
       and status = 'cancelled' and done_date is not null;
    if v_count <> 1 then
      raise exception 'receipt must cancel the open follow-up truthfully';
    end if;

    perform reconcile_testimonial_tasks();
    if exists (select 1 from tasks
                where enrollment_id = v_enrollment
                  and type = 'testimonial_followup_2') then
      raise exception 'nothing may be raised once the testimonial arrived';
    end if;

    -- And routine offboarding can still finish, which is the whole point.
    update enrollment_offboarding_items set status = 'done'
     where enrollment_id = v_enrollment;
    update enrollments set status = 'completed' where id = v_enrollment;

    -- ---------------------------------------------------------------
    -- A second client, who never replies. Two things to prove: the
    -- sequence ends after the second ask, and routine offboarding
    -- completes anyway with testimonial_received_at still NULL.
    -- ---------------------------------------------------------------
    insert into contacts (first_name, last_name, email_jsonb, phone_jsonb,
                          tags, sales_eligibility, first_seen, last_seen)
    values ('Silent', 'Assertion', '[]'::jsonb, '[]'::jsonb, '{}',
            'normal', now(), now())
    returning id into v_contact;

    insert into deals (name, contact_id, offer_id, stage, amount, index,
                       created_at, updated_at, stage_entered_at)
    values ('Silent Assertion — probe', v_contact, v_offer, 'won', 0, 0,
            now(), now(), now())
    returning id into v_deal;

    select id into v_enrollment from enrollments where opportunity_id = v_deal;
    update enrollment_onboarding_items set status = 'done'
     where enrollment_id = v_enrollment;
    update enrollments set status = 'active' where id = v_enrollment;
    update enrollments set status = 'offboarding' where id = v_enrollment;

    -- Day 15, so both follow-ups are reachable.
    select max(entered_at) into v_started from enrollment_status_events
     where enrollment_id = v_enrollment and status = 'offboarding';
    update enrollment_status_events
       set entered_at = v_started - interval '15 days'
     where enrollment_id = v_enrollment and status = 'offboarding';

    update tasks set status = 'completed', done_date = now()
     where enrollment_id = v_enrollment and type = 'collect_testimonial';
    perform reconcile_testimonial_tasks();

    update tasks set status = 'completed', done_date = now()
     where enrollment_id = v_enrollment and type = 'testimonial_followup_1';
    perform reconcile_testimonial_tasks();

    select count(*) into v_count from tasks
     where enrollment_id = v_enrollment and type = 'testimonial_followup_2';
    if v_count <> 1 then
      raise exception 'day 14 must raise exactly one second follow-up, found %', v_count;
    end if;

    -- Spend the last ask. After this the CRM stops asking, for good.
    update tasks set status = 'completed', done_date = now()
     where enrollment_id = v_enrollment and type = 'testimonial_followup_2';
    perform reconcile_testimonial_tasks();
    perform reconcile_testimonial_tasks();

    select count(*) into v_count from tasks
     where enrollment_id = v_enrollment
       and type in ('collect_testimonial', 'testimonial_followup_1',
                    'testimonial_followup_2');
    if v_count <> 3 then
      raise exception 'an exhausted sequence must hold exactly 3 tasks, found %', v_count;
    end if;

    -- The honest end state: asked twice, never received. Nothing
    -- anywhere pretended otherwise.
    if (select testimonial_received_at from enrollments where id = v_enrollment)
       is not null then
      raise exception 'exhausting the follow-ups must never mark a testimonial received';
    end if;

    -- And this is the point of the whole design: offboarding completes
    -- even though the client never replied.
    update enrollment_offboarding_items set status = 'done'
     where enrollment_id = v_enrollment;
    update enrollments set status = 'completed' where id = v_enrollment;
    if (select status from enrollments where id = v_enrollment) <> 'completed' then
      raise exception 'a missing testimonial must not block offboarding completion';
    end if;

    raise exception 'ASSERTIONS_PASSED_ROLL_BACK_THE_FIXTURES';
  exception
    when others then
      if sqlerrm <> 'ASSERTIONS_PASSED_ROLL_BACK_THE_FIXTURES' then
        raise;
      end if;
  end;
end $$;
