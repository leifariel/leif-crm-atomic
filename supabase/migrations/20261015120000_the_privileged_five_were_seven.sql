-- THE PRIVILEGED FIVE WERE SEVEN.
--
-- 20260920120000 transcribed MAIN's hand-applied function hardening into the
-- deterministic chain, and said so in its own words: it narrows "the
-- privileged five and nothing else". The five were
-- merge_contacts_safely, record_external_identity, reconcile_sales_call_tasks,
-- reconcile_application_review_tasks and seed_enrollment_onboarding.
--
-- Two more SECURITY DEFINER functions carry the same hand-applied narrowing on
-- MAIN and were never added to that list, so the clean room has been rebuilding
-- them MORE PERMISSIVE than production ever since:
--
--     materialize_application_responses(bigint)
--     record_deal_outcome_event()
--
-- MAIN holds `postgres=X/postgres` for both. A replayed database holds
-- `postgres=X/postgres service_role=X/postgres`, because the only grant
-- statements the chain ever ran for them were
-- `revoke all ... from public, anon, authenticated` (20260919070000,
-- 20260919180000) -- which never named service_role.
--
-- PRODUCTION IS THE CORRECT SIDE, and a previous slice already ruled on half
-- of it: 20261010210000 found the same divergence on
-- materialize_application_responses(bigint) and deliberately left it alone
-- "because nothing calls it". That ruling stands. This migration does not
-- change production's effective privileges at all -- revoking an absent
-- privilege is a no-op -- it makes the CHAIN reproduce what MAIN already is,
-- which is the whole promise of the deterministic set.
--
-- WHY NEITHER NEEDS service_role EXECUTE:
--
--   record_deal_outcome_event() RETURNS TRIGGER. Its only caller is the
--   trigger on_deal_outcome_changed on public.deals (04_triggers.sql).
--   PostgreSQL does not check EXECUTE on a trigger function when a trigger
--   fires it -- the writing role needs privileges on the TABLE -- so removing
--   EXECUTE cannot break the audit trail. Production proves it: MAIN has had
--   it revoked all along while Leif ends sales daily (§8 "A 403 from the
--   database is not a logout").
--
--   materialize_application_responses(bigint) is called from exactly two
--   places, neither of them a client: the historical backfill inside
--   20260919080000, which runs as the migration role, and nothing else.
--   No src/, no Edge Function, no cron, no RPC wrapper.
--
-- No function body is touched. No PUBLIC, anon or authenticated privilege
-- changes -- they were already revoked and stay revoked.
--
-- Deterministic: revokes by identity, asserts only privileges, reads no
-- business row, and replays into an empty database.

-- Revoked by identity rather than by name so an overload cannot slip through,
-- exactly as 20260920120000 does it.
do $$
declare
  v_name text;
  v_ident text;
begin
  foreach v_name in array array[
    'materialize_application_responses',
    'record_deal_outcome_event'
  ] loop
    for v_ident in
      select p.oid::regprocedure::text
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
    loop
      execute format(
        'revoke all on function %s from public, anon, authenticated, service_role',
        v_ident);
    end loop;
  end loop;
end $$;

-- PROVE IT
do $$
declare
  v_name text;
  v_role text;
  v_ok boolean;
begin
  foreach v_name in array array[
    'materialize_application_responses',
    'record_deal_outcome_event'
  ] loop
    -- The function must still exist. A revoke on nothing is silent, and a
    -- silent pass here would be worse than a failure.
    if not exists (
      select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
    ) then
      raise exception '%() is missing -- this migration narrows it, it does not create it', v_name;
    end if;

    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      select bool_or(has_function_privilege(v_role, p.oid, 'EXECUTE'))
        into v_ok
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name;

      if coalesce(v_ok, false) then
        raise exception '% can still execute %()', v_role, v_name;
      end if;
    end loop;
  end loop;

  -- And the trigger that is the ONLY caller of record_deal_outcome_event()
  -- is still attached. Revoking EXECUTE must not have disturbed it, and if
  -- the trigger ever disappears the audit trail stops silently.
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'deals'
       and t.tgname = 'on_deal_outcome_changed'
       and not t.tgisinternal
  ) then
    raise exception 'on_deal_outcome_changed is gone -- the outcome audit trail has no writer';
  end if;
end $$;
