-- ===========================================================================
-- A person Kit knows about is recorded as known to Kit
-- ===========================================================================
--
-- Found during the first real acceptance event. Terry Robinson Whitney applied
-- to Growing Yourself Up on 2026-09-29, the receipt outbox enqueued his
-- programme tag, and forty seconds later the worker had upserted him in Kit as
-- subscriber 4315021388 and applied GYU-Applicant. All of that worked.
--
-- What did not happen is the one line afterwards: the canonical person-to-Kit
-- link in contact_external_identities. Two reasons, and both are fixed here.
--
--   1. 20260919130000 revoked record_external_identity() from public and anon
--      and never granted it to service_role, so the worker — which runs as
--      service_role — is refused. Its ACL is postgres=X and nothing else.
--
--   2. The worker asked and never looked at the answer. supabaseAdmin.rpc()
--      RETURNS an error rather than throwing one, so the try/catch around the
--      call never fired; the refusal was simply discarded. (Fixed in the
--      function itself, not here.)
--
-- The consequence is narrow but real: Manage Kit tags resolves a person's Kit
-- subscriber through that table, so it reports somebody as "not in Kit yet"
-- when Kit demonstrably knows them.
--
-- Nothing about the provider was wrong, so nothing here calls Kit. The
-- subscriber id is already recorded on the operation that succeeded, which is
-- all a repair needs.

-- ---------------------------------------------------------------------------
-- The grant the worker was missing
-- ---------------------------------------------------------------------------
-- service_role only. anon and authenticated stay refused: recording an
-- external identity is something the CRM's own server-side work does, never
-- something a browser asks for directly.
grant execute on function public.record_external_identity(text, text, text, text, jsonb, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------
-- Repair, from evidence the CRM already holds
-- ---------------------------------------------------------------------------
-- A succeeded Kit operation carries the subscriber id Kit returned. That is
-- enough to record the identity later, so a failure to record it is a delay
-- rather than a loss — and emphatically NOT a reason to tag anybody again.
--
-- Deliberately not a reconciliation framework: one query, one authority, one
-- purpose. It calls record_external_identity() and nothing else, so the rules
-- about what may become an identity stay in exactly one place — including its
-- refusal to guess when an address belongs to more than one Contact, which
-- stays a decision for a person rather than something a sweep forces.
--
-- Returns the number of people it recorded.
create or replace function public.reconcile_kit_identities()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row record;
  v_result jsonb;
  v_recorded integer := 0;
begin
  for v_row in
    -- One per person, using their most recent confirmed operation: the
    -- subscriber id is the same either way, and the newest is the freshest
    -- evidence that Kit still knows them.
    select distinct on (o.contact_id)
           o.contact_id, o.kit_subscriber_id, o.email
      from kit_sync_operations o
     where o.status = 'succeeded'
       and o.kit_subscriber_id is not null
       and not exists (
         select 1 from contact_external_identities i
          where i.contact_id = o.contact_id and i.provider = 'kit'
       )
     order by o.contact_id, o.succeeded_at desc nulls last
  loop
    v_result := public.record_external_identity(
      'kit', null, v_row.kit_subscriber_id, v_row.email,
      '{}'::jsonb, now(), v_row.email);
    -- 'ambiguous' and 'unresolved' are left exactly as they are. An address
    -- two Contacts share is a question for Leif, and a sweep that answered it
    -- would be inventing an identity rather than recording one.
    if v_result ->> 'status' in ('known', 'linked_by_email') then
      v_recorded := v_recorded + 1;
    end if;
  end loop;
  return v_recorded;
end;
$$;

revoke all on function public.reconcile_kit_identities() from public;
revoke all on function public.reconcile_kit_identities() from anon;
revoke all on function public.reconcile_kit_identities() from authenticated;
grant execute on function public.reconcile_kit_identities() to service_role;

-- ---------------------------------------------------------------------------
-- Proof
-- ---------------------------------------------------------------------------
DO $proof$
DECLARE
  v_contact bigint;
  v_second bigint;
  v_app bigint;
  v_result jsonb;
  v_before integer;
  v_recorded integer;
  v_refused boolean := false;
  v_le constant bigint := 1;
BEGIN
  -- The grant itself, read from the live catalogue rather than assumed.
  IF NOT has_function_privilege('service_role',
        'public.record_external_identity(text, text, text, text, jsonb, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role still cannot record an external identity';
  END IF;
  IF has_function_privilege('authenticated',
        'public.record_external_identity(text, text, text, text, jsonb, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated gained the identity authority';
  END IF;
  IF has_function_privilege('anon',
        'public.record_external_identity(text, text, text, text, jsonb, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon gained the identity authority';
  END IF;
  IF has_function_privilege('authenticated', 'public.reconcile_kit_identities()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reconcile_kit_identities()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can run the identity sweep';
  END IF;

  BEGIN
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Identity', 'Proof',
            jsonb_build_array(jsonb_build_object('email', 'identity.proof@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_contact;

    -- A person Kit already tagged, with the subscriber id on the operation and
    -- no identity recorded — exactly the state Terry is in.
    v_result := public.submit_public_application(
      v_le, null, 'Identity', 'Proof', 'identity.proof@example.com', null, '{}'::jsonb);
    v_app := (v_result ->> 'application_id')::bigint;
    UPDATE kit_sync_operations
       SET status = 'succeeded', succeeded_at = now(), kit_subscriber_id = '4315021388'
     WHERE application_id = v_app;
    IF EXISTS (SELECT 1 FROM contact_external_identities
                WHERE contact_id = v_contact AND provider = 'kit') THEN
      RAISE EXCEPTION 'the fixture already had a Kit identity';
    END IF;

    -- The sweep repairs it from that evidence alone.
    v_recorded := public.reconcile_kit_identities();
    IF v_recorded < 1 THEN
      RAISE EXCEPTION 'the sweep recorded nothing';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM contact_external_identities
       WHERE contact_id = v_contact AND provider = 'kit'
         AND external_user_id = '4315021388'
    ) THEN
      RAISE EXCEPTION 'the identity was not recorded from the stored subscriber id';
    END IF;
    -- And it did not touch the tag: no re-tagging, no second operation.
    IF (SELECT count(*) FROM kit_sync_operations WHERE application_id = v_app) <> 1
       OR (SELECT status FROM kit_sync_operations WHERE application_id = v_app) <> 'succeeded' THEN
      RAISE EXCEPTION 'the repair disturbed the tag operation';
    END IF;

    -- Running it again is a no-op, and cannot fork a second identity.
    SELECT count(*) INTO v_before FROM contact_external_identities WHERE provider = 'kit';
    PERFORM public.reconcile_kit_identities();
    PERFORM public.reconcile_kit_identities();
    IF (SELECT count(*) FROM contact_external_identities WHERE provider = 'kit') <> v_before THEN
      RAISE EXCEPTION 'repeating the sweep created another identity';
    END IF;
    IF (SELECT count(*) FROM contact_external_identities
         WHERE contact_id = v_contact AND provider = 'kit') <> 1 THEN
      RAISE EXCEPTION 'one person ended up with two Kit identities';
    END IF;

    -- A shared address is a question for a person, not something a sweep
    -- decides. The identity is left unrecorded and nothing is invented.
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Shared', 'Address',
            jsonb_build_array(jsonb_build_object('email', 'shared.address@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_second;
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Shared', 'Twin',
            jsonb_build_array(jsonb_build_object('email', 'shared.address@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal');
    INSERT INTO kit_sync_operations
      (contact_id, kind, origin, email, kit_tag_id, kit_tag_name, status,
       succeeded_at, kit_subscriber_id)
    VALUES (v_second, 'manual', 'manual_owner', 'shared.address@example.com',
            24082722, 'MiniDD_Applicant', 'succeeded', now(), '999888777');
    PERFORM public.reconcile_kit_identities();
    IF EXISTS (SELECT 1 FROM contact_external_identities
                WHERE contact_id = v_second AND provider = 'kit') THEN
      RAISE EXCEPTION 'the sweep resolved a shared address it had no business deciding';
    END IF;

    -- And a browser still cannot run any of it.
    BEGIN
      SET LOCAL role authenticated;
      PERFORM public.reconcile_kit_identities();
      RESET role;
    EXCEPTION WHEN others THEN
      RESET role;
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'an authenticated session ran the identity sweep';
    END IF;

    RAISE NOTICE 'kit identity proof: service_role may record an identity and browser roles may not, a succeeded tag repairs its missing identity from the stored subscriber id with no provider call and no second operation, repeating the sweep forks nothing, and a shared address is left for a person to decide';

    RAISE EXCEPTION 'kit identity proof complete' USING ERRCODE = 'restrict_violation';
  EXCEPTION
    WHEN restrict_violation THEN
      NULL;
  END;
END
$proof$;
