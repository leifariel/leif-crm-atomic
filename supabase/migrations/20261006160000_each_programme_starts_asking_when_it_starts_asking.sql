-- Each programme starts asking for testimonials when IT starts asking.
--
-- The Living Example switched on at 2026-10-06 21:59. Growing Yourself Up
-- switches on now. One global boundary cannot express that: with a single
-- not_before, enabling GYU today would either drag LE's boundary forward
-- (silently un-enrolling LE clients) or hand GYU every historical client
-- it ever offboarded. So the boundary moves onto the Offer, beside the
-- flag that says whether it asks at all.
--
-- AND IT REMOVES A FRAGILITY. Enablement used to be a flag seeded by exact
-- Offer name, so recreating an Offer called "The Living Example" would
-- produce a row that quietly never asks. Configuration now lives on the
-- canonical row — `collects_testimonial` plus `testimonial_activated_at`,
-- both defaulting to "no" — so a new Offer row is never enabled by
-- accident, and never enabled merely because its name matches. The seeding
-- below is a ONE-TIME deliberate act, scoped to the row the offboarding
-- requirement templates themselves point at, not to a name alone.
--
-- A SECOND, NARROWER QUESTION. Two real LE clients offboarded three hours
-- before LE's boundary and are excluded by it. Moving the boundary
-- backwards to catch them would also catch anybody else who happened to
-- offboard earlier, which is exactly the broad backfill this design
-- refuses. So eligibility gains one explicit per-Enrollment door —
-- `enrollments.testimonial_sequence_opted_in_at` — and the two specific
-- Enrollments are opted in by the SEPARATE main-only migration that
-- follows this one. This migration owns only the structure, so it still
-- replays into an empty database; that split is what the replay boundary
-- exists to enforce.
--
-- Nothing here touches offboarding requirements. A testimonial still
-- depends on the client replying, so it is still not an is_required item,
-- and GYU still completes on the two things Leif controls: Slack and
-- Calendar removal.

-- ---------------------------------------------------------------------
-- 1. When did this programme start asking?
-- ---------------------------------------------------------------------
alter table public.offers
    add column if not exists testimonial_activated_at timestamp with time zone;

comment on column public.offers.testimonial_activated_at is
  'When this Offer began asking its clients for testimonials. NULL means it never has, so no Enrollment of it is eligible. Together with collects_testimonial this is the whole configuration: a recreated Offer row is not enabled by inheriting a name.';

-- ---------------------------------------------------------------------
-- 2. The explicit per-Enrollment door
-- ---------------------------------------------------------------------
-- Set, an Enrollment is in the sequence whatever its Offer's boundary
-- says. It does not falsify when they offboarded and it does not move any
-- programme's boundary — it records a decision about one client.
alter table public.enrollments
    add column if not exists testimonial_sequence_opted_in_at
      timestamp with time zone;

comment on column public.enrollments.testimonial_sequence_opted_in_at is
  'Leif deliberately included this one Enrollment in the testimonial sequence even though its Offer''s activation boundary excludes it. Never set in bulk: the point of the boundary is that history is not backfilled.';

-- ---------------------------------------------------------------------
-- 3. Carry LE's boundary forward, exactly, and switch GYU on
-- ---------------------------------------------------------------------
-- LE's existing activation is preserved to the second from the singleton
-- it used to live in. Scoped to the CANONICAL row — the one the
-- offboarding requirement templates point at — so the duplicate
-- Offer rows that e2e fixtures leave behind are never enabled.
update public.offers o
   set testimonial_activated_at = (
         select not_before from public.testimonial_sequence_settings where id = 1)
 where o.collects_testimonial
   and o.testimonial_activated_at is null
   and exists (
     select 1 from public.offboarding_requirement_templates t
      where t.offer_id = o.id
   );

-- Growing Yourself Up asks from now. Same engine, same task types, same
-- cadence, same card — nothing about it is GYU-specific.
update public.offers o
   set collects_testimonial = true,
       testimonial_activated_at = coalesce(o.testimonial_activated_at, now())
 where o.name = 'Growing Yourself Up'
   and exists (
     select 1 from public.offboarding_requirement_templates t
      where t.offer_id = o.id
   );

-- ---------------------------------------------------------------------
-- 4. Eligibility, re-expressed
-- ---------------------------------------------------------------------
create or replace function public.testimonial_sequence_enrollments()
  returns table (enrollment_id bigint, contact_id bigint,
                 started_at timestamp with time zone)
  language sql
  stable
  security definer
  set search_path to 'public'
as $$
  -- One definition of "in the sequence", read by the reconciler and by
  -- anything that needs to ask the same question later.
  select e.id,
         d.contact_id,
         ev.started_at
    from enrollments e
    join deals d on d.id = e.opportunity_id
    join offers o on o.id = d.offer_id
    cross join lateral (
      select max(s.entered_at) as started_at
        from enrollment_status_events s
       where s.enrollment_id = e.id
         and s.status = 'offboarding'
    ) ev
   where o.collects_testimonial
     and e.testimonial_received_at is null
     and ev.started_at is not null
     and (
       -- Either Leif put this one client in by hand...
       e.testimonial_sequence_opted_in_at is not null
       -- ...or their programme was already asking when they offboarded.
       or (o.testimonial_activated_at is not null
           and ev.started_at >= o.testimonial_activated_at)
     );
$$;

create or replace function public.reconcile_testimonial_tasks()
  returns integer
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  v_sales_id bigint;
  v_created int := 0;
  v_cancelled int;
begin
  select id into v_sales_id from sales where administrator = true
   order by id limit 1;

  -- The testimonial arrived, so nothing further is wanted. Cancelled, not
  -- completed: Leif did not do these, they stopped being necessary.
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

  with dated as (
    select * from testimonial_sequence_enrollments()
  ),
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

-- Day 0 immediately, now asking the same eligibility question.
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
       where d.id = new.opportunity_id
         and o.collects_testimonial
         and (new.testimonial_sequence_opted_in_at is not null
              or (o.testimonial_activated_at is not null
                  and now() >= o.testimonial_activated_at))
    ) then
      select d.contact_id into v_contact_id
        from deals d where d.id = new.opportunity_id;
      select id into v_sales_id from sales where administrator = true
       order by id limit 1;

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

-- ---------------------------------------------------------------------
-- 5. The singleton has nothing left to say
-- ---------------------------------------------------------------------
-- Its value now lives on the Offer it was always about. Keeping it would
-- leave two places claiming to hold the boundary, and the stale one would
-- eventually be believed.
drop table if exists public.testimonial_sequence_settings;

-- ---------------------------------------------------------------------
-- 6. Same posture as before
-- ---------------------------------------------------------------------
revoke all on function public.reconcile_testimonial_tasks() from public;
revoke all on function public.reconcile_testimonial_tasks() from anon;
revoke all on function public.reconcile_testimonial_tasks() from authenticated;
grant execute on function public.reconcile_testimonial_tasks() to service_role;

-- Read by the reconciler (SECURITY DEFINER, so it needs nothing) and by
-- nobody in a browser.
revoke all on function public.testimonial_sequence_enrollments() from public;
revoke all on function public.testimonial_sequence_enrollments() from anon;
revoke all on function public.testimonial_sequence_enrollments() from authenticated;
grant execute on function public.testimonial_sequence_enrollments() to service_role;

revoke all on function public.handle_enrollment_testimonial_start() from public;
revoke all on function public.handle_enrollment_testimonial_start() from anon;
revoke all on function public.handle_enrollment_testimonial_start() from authenticated;

-- ---------------------------------------------------------------------
-- 7. Self-proving
-- ---------------------------------------------------------------------
do $$
declare
  v_le bigint;
  v_gyu bigint;
  v_le_at timestamp with time zone;
  v_gyu_at timestamp with time zone;
  v_contact bigint;
  v_deal bigint;
  v_enrollment bigint;
  v_count int;
begin
  -- Structure.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'offers'
       and column_name = 'testimonial_activated_at'
  ) then
    raise exception 'offers.testimonial_activated_at must exist';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'enrollments'
       and column_name = 'testimonial_sequence_opted_in_at'
  ) then
    raise exception 'enrollments.testimonial_sequence_opted_in_at must exist';
  end if;
  if exists (
    select 1 from pg_tables
     where schemaname = 'public' and tablename = 'testimonial_sequence_settings'
  ) then
    raise exception 'the global boundary singleton should be gone';
  end if;

  -- Exactly one cron job, still.
  if (select count(*) from cron.job
       where jobname like '%testimonial%') <> 1 then
    raise exception 'there must be exactly one testimonial cron job';
  end if;

  -- Both programmes ask, each from its own moment.
  select id, testimonial_activated_at into v_le, v_le_at
    from offers
   where name = 'The Living Example' and collects_testimonial
     and exists (select 1 from offboarding_requirement_templates t where t.offer_id = offers.id);
  select id, testimonial_activated_at into v_gyu, v_gyu_at
    from offers
   where name = 'Growing Yourself Up' and collects_testimonial;

  if v_le is null or v_le_at is null then
    raise exception 'The Living Example must keep an activation moment';
  end if;
  if v_gyu is null or v_gyu_at is null then
    raise exception 'Growing Yourself Up must now have one too';
  end if;
  if v_gyu_at < v_le_at then
    raise exception 'GYU cannot have started asking before LE did';
  end if;

  -- Nothing else was switched on — in particular not the duplicate Offer
  -- rows that test fixtures leave behind.
  select count(*) into v_count from offers where collects_testimonial;
  if v_count <> 2 then
    raise exception 'exactly two Offers should ask, found %', v_count;
  end if;

  -- GYU's own offboarding requirements are untouched, and a testimonial is
  -- still not one of them.
  if not exists (
    select 1 from offboarding_requirement_templates
     where offer_id = v_gyu and key = 'slack_removed' and is_required
  ) or not exists (
    select 1 from offboarding_requirement_templates
     where offer_id = v_gyu and key = 'calendar_removed' and is_required
  ) then
    raise exception 'GYU must still require Slack and Calendar removal';
  end if;
  if exists (
    select 1 from offboarding_requirement_templates
     where key like '%testimonial%'
  ) then
    raise exception 'a testimonial must never be an offboarding requirement';
  end if;

  -- Behaviour, on rows that cannot survive: a GYU client offboarding now
  -- is in the sequence, and its ordinary offboarding still completes
  -- without a testimonial.
  begin
    insert into contacts (first_name, last_name, email_jsonb, phone_jsonb,
                          tags, sales_eligibility, first_seen, last_seen)
    values ('Gyu', 'Assertion', '[]'::jsonb, '[]'::jsonb, '{}',
            'normal', now(), now())
    returning id into v_contact;

    insert into deals (name, contact_id, offer_id, stage, amount, index,
                       created_at, updated_at, stage_entered_at)
    values ('Gyu Assertion — probe', v_contact, v_gyu, 'won', 0, 0,
            now(), now(), now())
    returning id into v_deal;

    select id into v_enrollment from enrollments where opportunity_id = v_deal;
    update enrollment_onboarding_items set status = 'done'
     where enrollment_id = v_enrollment;
    update enrollments set status = 'active' where id = v_enrollment;
    update enrollments set status = 'offboarding' where id = v_enrollment;

    -- Day 0, once.
    select count(*) into v_count from tasks
     where enrollment_id = v_enrollment and type = 'collect_testimonial';
    if v_count <> 1 then
      raise exception 'a GYU offboarding must raise exactly one ask, found %', v_count;
    end if;

    perform reconcile_testimonial_tasks();
    perform reconcile_testimonial_tasks();
    select count(*) into v_count from tasks
     where enrollment_id = v_enrollment
       and type in ('collect_testimonial', 'testimonial_followup_1',
                    'testimonial_followup_2');
    if v_count <> 1 then
      raise exception 'repeated reconciliation must not duplicate a stage, found %', v_count;
    end if;

    -- Both GYU requirements are raised, and completing them completes the
    -- Enrollment with no testimonial.
    if (select count(*) from enrollment_offboarding_items
         where enrollment_id = v_enrollment
           and requirement_key in ('slack_removed', 'calendar_removed')) <> 2 then
      raise exception 'GYU offboarding must raise Slack and Calendar removal';
    end if;

    update enrollment_offboarding_items set status = 'done'
     where enrollment_id = v_enrollment;
    update enrollments set status = 'completed' where id = v_enrollment;
    if (select testimonial_received_at from enrollments where id = v_enrollment)
       is not null then
      raise exception 'completing offboarding must not invent a testimonial';
    end if;

    -- An Enrollment whose programme was not asking yet is NOT eligible,
    -- even after offboarding — which is what the boundary is for.
    update offers set testimonial_activated_at = now() + interval '1 day'
     where id = v_gyu;
    if exists (
      select 1 from testimonial_sequence_enrollments()
       where enrollment_id = v_enrollment
    ) then
      raise exception 'an Enrollment before its programme boundary must not be eligible';
    end if;

    -- ...unless Leif explicitly put that one client in.
    update enrollments set testimonial_sequence_opted_in_at = now()
     where id = v_enrollment;
    if not exists (
      select 1 from testimonial_sequence_enrollments()
       where enrollment_id = v_enrollment
    ) then
      raise exception 'an explicitly opted-in Enrollment must be eligible';
    end if;

    raise exception 'ASSERTIONS_PASSED_ROLL_BACK_THE_FIXTURES';
  exception
    when others then
      if sqlerrm <> 'ASSERTIONS_PASSED_ROLL_BACK_THE_FIXTURES' then
        raise;
      end if;
  end;
end $$;
