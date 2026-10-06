-- Two clients who offboarded three hours too early.
--
-- MAIN-ONLY. This repairs two specific real records and owns no structure,
-- so it is listed in replay-manifest.json and never replayed into an empty
-- database. The structure it depends on —
-- enrollments.testimonial_sequence_opted_in_at — is created by the
-- deterministic migration immediately before this one, which is what lets
-- that one still rebuild from nothing.
--
-- Jules Litman-Cleper (Enrollment 48) and Adriano Castro (Enrollment 50)
-- both entered offboarding at 2026-10-06 16:56, about three hours before
-- The Living Example's testimonial activation at 21:59. They are not stale
-- history; they are today's clients who happened to land on the wrong side
-- of an hour. Leif decided they should be asked.
--
-- WHY NOT MOVE LE'S BOUNDARY BACK. Because a boundary that moves to catch
-- two people also catches everyone earlier, which is the broad backfill
-- this whole design refuses. An explicit per-Enrollment opt-in says what is
-- actually true: a decision was made about these two, and about nobody
-- else.
--
-- What this does NOT do: it does not touch their status (50 stays
-- 'completed', 48 stays 'offboarding'), it does not touch their offboarding
-- requirements or notes_archived, it does not rewrite when they offboarded,
-- and it does not create tasks by hand. The engine raises Day 0 on its next
-- reconciliation, and Day 7 and Day 14 follow from their real
-- offboarding date.

do $$
declare
  v_le bigint;
  v_le_at timestamp with time zone;
  v_before_status text;
  v_after_status text;
  v_count int;
begin
  select id, testimonial_activated_at into v_le, v_le_at
    from public.offers
   where name = 'The Living Example'
     and collects_testimonial
     and exists (
       select 1 from public.offboarding_requirement_templates t
        where t.offer_id = offers.id);

  if v_le is null or v_le_at is null then
    raise exception 'The Living Example is not configured to ask for testimonials';
  end if;

  -- Both Enrollments must be exactly what Leif described: LE, already
  -- offboarded, before the boundary, no testimonial, no stage task yet.
  -- A production assertion is what makes a main-only migration safe.
  select count(*) into v_count
    from public.enrollments e
    join public.deals d on d.id = e.opportunity_id
   where e.id in (48, 50)
     and d.offer_id = v_le
     and e.testimonial_received_at is null;
  if v_count <> 2 then
    raise exception
      'expected Enrollments 48 and 50 to be Living Example clients with no testimonial, matched %',
      v_count;
  end if;

  select count(*) into v_count
    from public.enrollments e
   where e.id in (48, 50)
     and (select max(s.entered_at) from public.enrollment_status_events s
           where s.enrollment_id = e.id and s.status = 'offboarding') < v_le_at;
  if v_count <> 2 then
    raise exception
      'expected both Enrollments to have offboarded BEFORE the boundary, matched %',
      v_count;
  end if;

  if exists (
    select 1 from public.tasks
     where enrollment_id in (48, 50)
       and type in ('collect_testimonial', 'testimonial_followup_1',
                    'testimonial_followup_2')
  ) then
    raise exception 'these Enrollments already carry a testimonial stage task';
  end if;

  -- Remember their statuses, to prove this changed neither.
  select string_agg(id::text || '=' || status, ',' order by id)
    into v_before_status
    from public.enrollments where id in (48, 50);

  -- The decision itself.
  update public.enrollments
     set testimonial_sequence_opted_in_at = now()
   where id in (48, 50)
     and testimonial_sequence_opted_in_at is null;

  -- Exactly these two, and nobody else, is now in the sequence despite the
  -- boundary.
  select count(*) into v_count
    from public.enrollments
   where testimonial_sequence_opted_in_at is not null;
  if v_count <> 2 then
    raise exception 'only Enrollments 48 and 50 may be opted in, found %', v_count;
  end if;

  select count(*) into v_count
    from public.testimonial_sequence_enrollments()
   where enrollment_id in (48, 50);
  if v_count <> 2 then
    raise exception 'both opted-in Enrollments should now be eligible, found %', v_count;
  end if;

  -- No OTHER pre-boundary Living Example client became eligible.
  select count(*) into v_count
    from public.testimonial_sequence_enrollments() s
    join public.enrollments e on e.id = s.enrollment_id
   where s.started_at < v_le_at
     and e.id not in (48, 50);
  if v_count <> 0 then
    raise exception
      'moving these two in must not sweep in % other pre-boundary clients', v_count;
  end if;

  -- Their lifecycle is untouched: 50 is still completed, 48 still
  -- offboarding.
  select string_agg(id::text || '=' || status, ',' order by id)
    into v_after_status
    from public.enrollments where id in (48, 50);
  if v_after_status <> v_before_status then
    raise exception 'enrollment status changed from % to %',
      v_before_status, v_after_status;
  end if;
end $$;

-- Raise Day 0 for them through the engine rather than by hand, so the task
-- is identical to every other one and the unique index is still what
-- guarantees there is only one.
select public.reconcile_testimonial_tasks();

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.tasks
   where enrollment_id in (48, 50) and type = 'collect_testimonial';
  if v_count <> 2 then
    raise exception 'each opted-in Enrollment should have exactly one ask, found %', v_count;
  end if;

  -- Idempotent: running the reconciler again changes nothing.
  perform public.reconcile_testimonial_tasks();
  select count(*) into v_count from public.tasks
   where enrollment_id in (48, 50)
     and type in ('collect_testimonial', 'testimonial_followup_1',
                  'testimonial_followup_2');
  if v_count <> 2 then
    raise exception 'reconciling twice must not duplicate their stages, found %', v_count;
  end if;
end $$;
