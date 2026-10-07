-- Fifty-one applications that were always Fall 2026.
--
-- MAIN-ONLY. This repairs specific real records and owns no structure, so it
-- is listed in replay-manifest.json and never replayed into an empty
-- database. Meaningless there: the rows it corrects exist only in production.
--
-- WHAT WAS WRONG. The Applications page files a group application by
-- `applications.intended_cohort_id`, falling back to its Opportunity's
-- `deals.cohort_id` (useApplicationsGrouped). Fifty-one Growing Yourself Up
-- applications have neither, so the page groups them under "No cohort
-- recorded". Leif's decision: all of them are Fall 2026. They are not
-- genuinely cohortless, they simply never had the column written.
--
-- WHY NOT A UI RULE. "GYU with no cohort, show it as Fall 2026" would leave
-- the records wrong forever and hide a permanent exception in the renderer.
-- The repair writes the truth instead, and the page needs no special case.
--
-- WHICH COLUMN, AND WHY ONLY ONE. `intended_cohort_id` is a snapshot of
-- intent AT APPLICATION TIME; `deals.cohort_id` is a separate, later fact
-- about what the client actually joined, and 01_tables.sql says outright
-- that the two are never kept in sync and may legitimately differ. Every
-- target here has no Deal cohort at all (that is part of why it renders
-- cohortless, and it is asserted below), so there is nothing to reconcile
-- and no conflicting evidence to overrule. Writing a Deal cohort would be
-- asserting something about enrolment that this repair has no authority
-- over, so it does not.
--
-- WHY NO BUCKET MOVES. classifyApplication reads the cohort in exactly one
-- clause: a `historical_import` application still `pending` is lifted into
-- Needs Review when its cohort is `applications_open`. So assigning a cohort
-- can only reclassify a record if that cohort is open. This migration
-- therefore ASSERTS that Fall 2026 is not open, and refuses if it is —
-- because reclassifying fifty-one records into review work is precisely what
-- Leif said must not happen. Every other clause reads only the
-- application's own status, source, reviewed_at and crm_adopted_at, none of
-- which this touches.

do $$
declare
  v_gyu bigint;
  v_fall bigint;
  v_fall_status text;
  v_count int;
  v_expected constant int := 51;
  v_before_jan int;
  v_after_jan int;
  v_before_le int;
  v_after_le int;
  v_before_fingerprint text;
  v_after_fingerprint text;
  v_before_answers text;
  v_after_answers text;
  v_before_deals text;
  v_after_deals text;
begin
  -- The canonical Growing Yourself Up offer. By shape, never by id: ids
  -- differ between environments and a recreated row must not be inherited
  -- by name alone, so the group type is asserted too.
  select id into v_gyu
    from public.offers
   where name = 'Growing Yourself Up'
     and type = 'group';
  if v_gyu is null then
    raise exception 'no single canonical Growing Yourself Up group offer';
  end if;

  -- The canonical Fall 2026 cohort of THAT offer. Exactly one, or stop.
  select count(*) into v_count
    from public.cohorts
   where offer_id = v_gyu
     and name ilike '%fall 2026%';
  if v_count <> 1 then
    raise exception
      'expected exactly one Fall 2026 cohort under Growing Yourself Up, found %',
      v_count;
  end if;

  select id, status into v_fall, v_fall_status
    from public.cohorts
   where offer_id = v_gyu
     and name ilike '%fall 2026%';

  -- THE GUARD THAT MATTERS. An open cohort would lift every pending
  -- historical_import target into Needs Review, which would reclassify the
  -- very records this repair must leave classified exactly as they are.
  if v_fall_status = 'applications_open' then
    raise exception
      'Fall 2026 is still applications_open (%); assigning it would move pending imported records into Needs Review',
      v_fall_status;
  end if;

  -- The target population, defined exactly as the page defines cohortless:
  -- no intended cohort of its own, and no Opportunity cohort to fall back on.
  create temporary table repair_targets on commit drop as
  select a.id
    from public.applications a
    left join public.deals d on d.id = a.opportunity_id
   where a.offer_id = v_gyu
     and a.intended_cohort_id is null
     and (a.opportunity_id is null or d.cohort_id is null);

  select count(*) into v_count from repair_targets;

  -- Idempotent and fail-loud are both required, and they only conflict if
  -- "already done" is treated as an unexpected premise. Nothing cohortless
  -- left means this repair has already run — the only thing that empties
  -- that population — so the second run is a clean no-op rather than an
  -- error. Any OTHER count is a premise that no longer matches, and that
  -- does stop everything.
  if v_count = 0 then
    raise notice
      'no cohortless Growing Yourself Up applications remain; repair already applied';
    return;
  end if;

  if v_count <> v_expected then
    raise exception
      'expected exactly % cohortless Growing Yourself Up applications, found %',
      v_expected, v_count;
  end if;

  -- No target may carry conflicting cohort evidence anywhere. By the
  -- definition above this cannot happen, and it is asserted rather than
  -- assumed: a bulk cohort write on a record that already names a different
  -- round is the mistake this whole migration exists to avoid.
  select count(*) into v_count
    from repair_targets t
    join public.applications a on a.id = t.id
    left join public.deals d on d.id = a.opportunity_id
   where a.intended_cohort_id is not null
      or d.cohort_id is not null;
  if v_count <> 0 then
    raise exception '% target(s) carry conflicting cohort evidence', v_count;
  end if;

  -- And none of them is a Living Example application.
  select count(*) into v_count
    from repair_targets t
    join public.applications a on a.id = t.id
    join public.offers o on o.id = a.offer_id
   where o.type <> 'group' or o.id <> v_gyu;
  if v_count <> 0 then
    raise exception '% target(s) do not belong to Growing Yourself Up', v_count;
  end if;

  -- Everything this repair must not disturb, measured before.
  select count(*) into v_before_jan
    from public.applications a
    join public.cohorts c on c.id = a.intended_cohort_id
   where c.offer_id = v_gyu and c.name ilike '%january 2027%';

  select count(*) into v_before_le
    from public.applications a
    join public.offers o on o.id = a.offer_id
   where o.type = 'individual';

  -- Decisions and review state of every target, as one comparable string.
  select string_agg(
           a.id::text || ':' || a.status || ':' ||
           coalesce(a.reviewed_at::text, '-') || ':' ||
           coalesce(a.source, '-') || ':' ||
           coalesce(a.crm_adopted_at::text, '-'),
           ',' order by a.id)
    into v_before_fingerprint
    from repair_targets t join public.applications a on a.id = t.id;

  -- The submitted answers themselves, which this repair has no business
  -- touching.
  select md5(string_agg(coalesce(a.raw_answers::text, ''), ',' order by a.id))
    into v_before_answers
    from repair_targets t join public.applications a on a.id = t.id;

  -- And the linked Opportunities' own state.
  select coalesce(
           string_agg(d.id::text || ':' || d.stage || ':' ||
                      coalesce(d.outcome, '-') || ':' ||
                      coalesce(d.cohort_id::text, '-'),
                      ',' order by d.id),
           '')
    into v_before_deals
    from repair_targets t
    join public.applications a on a.id = t.id
    join public.deals d on d.id = a.opportunity_id;

  -- The repair itself: one column, on exactly those rows.
  update public.applications a
     set intended_cohort_id = v_fall
   where a.id in (select id from repair_targets)
     and a.intended_cohort_id is null;

  -- Every target now resolves to Fall 2026.
  select count(*) into v_count
    from repair_targets t
    join public.applications a on a.id = t.id
   where a.intended_cohort_id = v_fall;
  if v_count <> v_expected then
    raise exception 'only % of % targets now name Fall 2026', v_count, v_expected;
  end if;

  -- And nothing of Growing Yourself Up is cohortless any more.
  select count(*) into v_count
    from public.applications a
    left join public.deals d on d.id = a.opportunity_id
   where a.offer_id = v_gyu
     and a.intended_cohort_id is null
     and (a.opportunity_id is null or d.cohort_id is null);
  if v_count <> 0 then
    raise exception '% Growing Yourself Up application(s) remain cohortless', v_count;
  end if;

  -- January 2027 untouched.
  select count(*) into v_after_jan
    from public.applications a
    join public.cohorts c on c.id = a.intended_cohort_id
   where c.offer_id = v_gyu and c.name ilike '%january 2027%';
  if v_after_jan <> v_before_jan then
    raise exception 'January 2027 moved from % to %', v_before_jan, v_after_jan;
  end if;

  -- The Living Example untouched.
  select count(*) into v_after_le
    from public.applications a
    join public.offers o on o.id = a.offer_id
   where o.type = 'individual';
  if v_after_le <> v_before_le then
    raise exception 'Living Example applications moved from % to %',
      v_before_le, v_after_le;
  end if;

  -- No decision, status, source or adoption changed, so no bucket can have
  -- moved for any reason other than the cohort — and the open-cohort guard
  -- above already refused the one cohort-sensitive case.
  select string_agg(
           a.id::text || ':' || a.status || ':' ||
           coalesce(a.reviewed_at::text, '-') || ':' ||
           coalesce(a.source, '-') || ':' ||
           coalesce(a.crm_adopted_at::text, '-'),
           ',' order by a.id)
    into v_after_fingerprint
    from repair_targets t join public.applications a on a.id = t.id;
  if v_after_fingerprint <> v_before_fingerprint then
    raise exception 'an application status, decision, source or adoption changed';
  end if;

  -- No submitted answers changed.
  select md5(string_agg(coalesce(a.raw_answers::text, ''), ',' order by a.id))
    into v_after_answers
    from repair_targets t join public.applications a on a.id = t.id;
  if v_after_answers <> v_before_answers then
    raise exception 'submitted answers changed';
  end if;

  -- No linked Opportunity changed, cohort_id included: this repair writes
  -- the application-time intent only.
  select coalesce(
           string_agg(d.id::text || ':' || d.stage || ':' ||
                      coalesce(d.outcome, '-') || ':' ||
                      coalesce(d.cohort_id::text, '-'),
                      ',' order by d.id),
           '')
    into v_after_deals
    from repair_targets t
    join public.applications a on a.id = t.id
    join public.deals d on d.id = a.opportunity_id;
  if v_after_deals <> v_before_deals then
    raise exception 'a linked Opportunity changed';
  end if;
end $$;

-- Idempotent: a second run finds nothing cohortless, so the population
-- assertion refuses rather than re-writing anything. That refusal is the
-- intended behaviour of a one-time historical repair, which is why this
-- migration is listed MAIN-only and runs exactly once.
