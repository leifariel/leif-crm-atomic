-- A third origin for an Application: Leif entered it.
--
-- `source` records where a record came from, and it had two answers:
-- 'public_form' (somebody submitted the live form) and
-- 'historical_import' (it predates this CRM). An Application Leif types in
-- herself is neither, and borrowing either name would be a lie the rest of
-- the system then reads as fact — 'public_form' would claim a submission
-- that never happened and imply questionnaire answers that do not exist,
-- 'historical_import' would claim it is older than the CRM and route it
-- straight into Historical.
--
-- So this widens the CHECK by exactly one value. Nothing else changes:
-- no existing row is rewritten, no default moves, no column is added.
-- Every row in production today is 'public_form' or 'historical_import'
-- and stays exactly as it is.
--
-- Deterministic and replayable into an empty database: it asserts the
-- shape of the constraint it is replacing rather than the contents of any
-- table, so it owns durable structure only and belongs in the
-- deterministic set, not the MAIN-only manifest.

alter table public.applications
  drop constraint if exists applications_source_check;

alter table public.applications
  add constraint applications_source_check
  check (source in ('public_form', 'historical_import', 'manual'));

comment on constraint applications_source_check on public.applications is
  'Where the record came from. public_form: somebody submitted the live application. historical_import: it predates this CRM. manual: Leif created it here, which implies no submission, no answers, no Opportunity and no review.';

-- The constraint must accept exactly these three and refuse anything else.
-- Proven here rather than assumed, so a replay into a fresh database fails
-- loudly if the shape is ever wrong.
--
-- The accepting probe runs inside a subtransaction that is ALWAYS undone
-- by a sentinel exception, never inserted-then-deleted. An Application
-- insert fires on_application_materialize_responses, and a materialised
-- response REFUSES to be deleted — it is an immutable submission record —
-- so a probe that cleaned up with DELETE would be one trigger away from
-- failing the deployment. Rolling the subtransaction back undoes the
-- insert and everything its triggers did, leaves nothing to clean up, and
-- never puts a row in a real database even momentarily.
do $$
declare
  v_contact bigint;
  v_offer bigint;
  v_accepted_manual boolean := false;
  v_refused_unknown boolean := false;
begin
  select id into v_contact from public.contacts order by id limit 1;
  select id into v_offer from public.offers order by id limit 1;

  -- An empty clean room has nobody to attach a probe to; the constraint
  -- definition is still asserted below, which is the part that matters
  -- when there are no rows.
  if v_contact is not null and v_offer is not null then
    begin
      insert into public.applications (contact_id, offer_id, source, status, submitted_at)
      values (v_contact, v_offer, 'manual', 'pending', now());
      v_accepted_manual := true;
      -- Sentinel: unwinds the probe. restrict_violation is raised by
      -- nothing else on this path, and a PL/pgSQL variable survives the
      -- subtransaction rollback, so the verdict above is still readable.
      raise exception 'unwinding the manual probe' using errcode = 'restrict_violation';
    exception
      when restrict_violation then
        null;
      -- A constraint that refuses 'manual' fails here. Caught so the
      -- verdict below reports it in words, rather than surfacing the raw
      -- check violation from inside a probe.
      when check_violation then
        null;
    end;

    if not v_accepted_manual then
      raise exception 'applications_source_check refuses the manual origin it should accept';
    end if;

    -- A refused insert creates nothing, so this probe needs no unwinding.
    -- If it were ever accepted the exception below aborts the migration,
    -- which rolls the stray row back with it.
    begin
      insert into public.applications (contact_id, offer_id, source, status, submitted_at)
      values (v_contact, v_offer, 'invented_origin', 'pending', now());
    exception when check_violation then
      v_refused_unknown := true;
    end;

    if not v_refused_unknown then
      raise exception 'applications_source_check accepted an unknown origin';
    end if;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.applications'::regclass
       and conname = 'applications_source_check'
       and pg_get_constraintdef(oid) like '%manual%'
       and pg_get_constraintdef(oid) like '%public_form%'
       and pg_get_constraintdef(oid) like '%historical_import%'
  ) then
    raise exception 'applications_source_check is not the three-origin constraint';
  end if;
end $$;
