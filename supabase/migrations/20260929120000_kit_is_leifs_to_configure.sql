-- ===========================================================================
-- Kit is Leif's to configure
-- ===========================================================================
--
-- 20260928200000 made an application reach Kit. It also made every Kit tag a
-- thing only a migration could change, and left the people who predate the
-- integration with no way in at all. Both are fixed here, and the three
-- concerns stay deliberately separate:
--
--   CONFIGURATION   which tag should a FUTURE event apply?   (kit_tag_mappings,
--                   cohorts.kit_tag_id)
--   MANUAL WORK     which tag does Leif want on THIS human?  (an operation with
--                   origin = 'manual_owner')
--   OPERATIONAL     who still needs Kit attention right now?  (derived from the
--                   outbox and the applications, never stored)
--
-- The rule that makes configuration safe to hand over: **changing a mapping
-- changes nothing that already happened.** Every operation freezes its tag id
-- at enqueue, so a new tag applies to new events and to nothing else. No
-- historical retagging, no rewriting a pending row, no backfill. Proved below
-- rather than promised.

-- ---------------------------------------------------------------------------
-- A cohort may carry its own tag
-- ---------------------------------------------------------------------------
-- Optional, and additive: a round's applicant gets the programme's applicant
-- tag AND this one, as two separate auditable operations rather than one
-- operation that quietly did two things.
alter table public.cohorts add column if not exists kit_tag_id bigint;
alter table public.cohorts add column if not exists kit_tag_name text;

alter table public.cohorts drop constraint if exists cohorts_kit_tag_both_or_neither;
alter table public.cohorts add constraint cohorts_kit_tag_both_or_neither check (
  (kit_tag_id is null and kit_tag_name is null)
  or (kit_tag_id > 0 and btrim(coalesce(kit_tag_name, '')) <> '')
);

-- ---------------------------------------------------------------------------
-- The outbox learns three things it did not need before
-- ---------------------------------------------------------------------------
--
--   a cohort tag      a second automatic operation on the same application
--   a manual tag      an operation about a person, with no application at all
--   who asked         so a manual tag is answerable for
--
-- The deployed guarantee is preserved EXACTLY: one applicant operation and one
-- decision operation per application, forever. It simply becomes a partial
-- index scoped to automatic work, so manual work can live in the same table
-- with its own, different idempotency rule.
alter table public.kit_sync_operations alter column application_id drop not null;

alter table public.kit_sync_operations
  add column if not exists origin text not null default 'automatic_application';
-- Who asked for a manual tag. Null for automatic work, which nobody asked for
-- in the sense that matters: it followed from an application event.
alter table public.kit_sync_operations
  add column if not exists requested_by text;

alter table public.kit_sync_operations drop constraint if exists kit_sync_operations_origin_check;
alter table public.kit_sync_operations add constraint kit_sync_operations_origin_check
  check (origin in ('automatic_application', 'manual_owner'));

-- 'cohort' joins the automatic kinds; 'manual' is the only manual one.
alter table public.kit_sync_operations drop constraint if exists kit_sync_operations_kind_check;
alter table public.kit_sync_operations add constraint kit_sync_operations_kind_check
  check (kind in ('applicant', 'cohort', 'decision', 'manual'));

-- Automatic work is always about an application; manual work is always about a
-- person and may merely MENTION the application it was started from.
alter table public.kit_sync_operations drop constraint if exists kit_sync_operations_origin_shape_check;
alter table public.kit_sync_operations add constraint kit_sync_operations_origin_shape_check check (
  (origin = 'automatic_application'
     and application_id is not null
     and kind in ('applicant', 'cohort', 'decision'))
  or (origin = 'manual_owner' and kind = 'manual')
);

-- THE idempotency anchors, one per origin.
--
-- Automatic: unchanged in meaning from 20260928200000 — one operation per
-- application per kind, so every replay collides and writes nothing.
drop index if exists kit_sync_operations_application_kind_idx;
create unique index if not exists kit_sync_operations_application_kind_idx
  on public.kit_sync_operations using btree (application_id, kind)
  where origin = 'automatic_application';

-- Manual: one operation per person per tag, forever. Asking twice for the same
-- tag on the same human is the same request, not a second one — which is also
-- what Kit itself does, so the two agree.
create unique index if not exists kit_sync_operations_manual_tag_idx
  on public.kit_sync_operations using btree (contact_id, kit_tag_id)
  where origin = 'manual_owner';

create index if not exists kit_sync_operations_origin_idx
  on public.kit_sync_operations using btree (origin, status);

-- ---------------------------------------------------------------------------
-- One insert path for every Kit operation
-- ---------------------------------------------------------------------------
-- Automatic receipt, automatic cohort tag, automatic decision and manual owner
-- tagging all arrive here. Resolving WHICH tag is the caller's job; getting a
-- durable, idempotent, evidence-shaped row is this function's.
--
-- Returns the operation id, or null when there is nothing to do — an unusable
-- email, or a request that already exists.
create or replace function public.enqueue_kit_operation(
  p_contact_id bigint,
  p_application_id bigint,
  p_kind text,
  p_origin text,
  p_kit_tag_id bigint,
  p_kit_tag_name text,
  p_requested_by text default null
) returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_email text;
  v_id bigint;
begin
  if p_kit_tag_id is null or p_kit_tag_id <= 0 then
    return null;
  end if;

  -- The CRM's canonical address for this person, by the same rule the receipt
  -- path uses, so every operation for them is addressed identically.
  select a.normalized_email into v_email
    from contact_email_addresses a
   where a.contact_id = p_contact_id
   order by a.normalized_email
   limit 1;
  if v_email is null then
    return null;
  end if;

  insert into kit_sync_operations
    (application_id, contact_id, kind, origin, email, kit_tag_id, kit_tag_name,
     requested_by)
  values
    (p_application_id, p_contact_id, p_kind, p_origin, v_email, p_kit_tag_id,
     coalesce(nullif(btrim(p_kit_tag_name), ''), 'tag ' || p_kit_tag_id),
     p_requested_by)
  on conflict do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Automatic: the mapping-resolving enqueue, now including the cohort tag
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_kit_application_sync(
  p_application_id bigint,
  p_kind text,
  p_event text
) returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_app applications%rowtype;
  v_tag kit_tag_mappings%rowtype;
  v_not_before timestamp with time zone;
begin
  select * into v_app from applications where id = p_application_id;
  if not found then
    return null;
  end if;

  -- Origin. An imported record is what already happened, not work.
  if v_app.source not in ('public_form', 'manual') then
    return null;
  end if;

  -- The deployment boundary. Absent settings fail closed.
  select not_before into v_not_before from kit_integration_settings where id = 1;
  if v_not_before is null or v_app.created_at < v_not_before then
    return null;
  end if;

  if v_app.offer_id is null then
    return null;
  end if;

  select * into v_tag from kit_tag_mappings
   where offer_id = v_app.offer_id and event = p_event;
  if not found then
    -- No mapping is a refusal, never a guess. A programme Leif has not
    -- configured simply is not Kit-managed, and the UI says so rather than
    -- borrowing another programme's tag.
    return null;
  end if;

  return public.enqueue_kit_operation(
    v_app.contact_id, v_app.id, p_kind, 'automatic_application',
    v_tag.kit_tag_id, v_tag.kit_tag_name, null);
end;
$$;

-- The round's own tag, when it has one. Same eligibility as the programme tag
-- — it reuses enqueue_kit_application_sync's gates by only ever being called
-- after that one has produced an operation.
create or replace function public.enqueue_kit_cohort_tag(p_application_id bigint)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_app applications%rowtype;
  v_cohort cohorts%rowtype;
begin
  select * into v_app from applications where id = p_application_id;
  if not found or v_app.intended_cohort_id is null then
    return null;
  end if;

  select * into v_cohort from cohorts where id = v_app.intended_cohort_id;
  if not found or v_cohort.kit_tag_id is null then
    return null;
  end if;

  return public.enqueue_kit_operation(
    v_app.contact_id, v_app.id, 'cohort', 'automatic_application',
    v_cohort.kit_tag_id, v_cohort.kit_tag_name, null);
end;
$$;

-- The receipt trigger now owes up to two tags: the programme's, and the
-- round's if that round has one. The cohort tag is enqueued only when the
-- programme tag was — one gate, applied once.
create or replace function public.enqueue_kit_application_receipt()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status = 'pending'
     and public.enqueue_kit_application_sync(new.id, 'applicant', 'applicant') is not null
  then
    perform public.enqueue_kit_cohort_tag(new.id);
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner authorities
-- ---------------------------------------------------------------------------
--
-- Configuration and manual work are things Leif does, so they are RPCs he can
-- call and the tables stay closed to direct writes. That keeps one validated
-- door instead of a browser PATCHing whatever it likes into the mapping that
-- decides which email a future applicant receives.

-- Set (or clear) one programme/event tag. Future events only, by construction:
-- every operation froze its tag at enqueue, so nothing already written can be
-- reached from here.
create or replace function public.set_program_kit_tag(
  p_offer_id bigint,
  p_event text,
  p_kit_tag_id bigint,
  p_kit_tag_name text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from offers where id = p_offer_id) then
    return jsonb_build_object('status', 'offer-invalid');
  end if;
  if p_event not in ('applicant', 'approved', 'needs_higher_care', 'not_fit') then
    return jsonb_build_object('status', 'event-invalid');
  end if;

  -- Clearing is legitimate: a programme may stop being Kit-managed, and the
  -- honest way to say that is to have no mapping rather than a wrong one.
  if p_kit_tag_id is null then
    delete from kit_tag_mappings where offer_id = p_offer_id and event = p_event;
    return jsonb_build_object('status', 'cleared', 'offer_id', p_offer_id, 'event', p_event);
  end if;

  if p_kit_tag_id <= 0 or btrim(coalesce(p_kit_tag_name, '')) = '' then
    return jsonb_build_object('status', 'tag-invalid');
  end if;

  insert into kit_tag_mappings (offer_id, event, kit_tag_id, kit_tag_name)
  values (p_offer_id, p_event, p_kit_tag_id, btrim(p_kit_tag_name))
  on conflict (offer_id, event) do update
    set kit_tag_id = excluded.kit_tag_id,
        kit_tag_name = excluded.kit_tag_name;

  return jsonb_build_object(
    'status', 'set', 'offer_id', p_offer_id, 'event', p_event,
    'kit_tag_id', p_kit_tag_id, 'kit_tag_name', btrim(p_kit_tag_name));
end;
$$;

-- Ask for one tag on one human. The tag reaches Kit through the same worker,
-- with the same evidence and the same retry, as everything automatic — a
-- manual tag is not a button that calls an API and hopes.
--
-- Do Not Engage is refused. The CRM already declined to work with them; adding
-- them to a list and tagging them is the one thing that decision exists to
-- prevent, and a manual route around it would make the refusal decorative.
create or replace function public.request_kit_manual_tag(
  p_contact_id bigint,
  p_kit_tag_id bigint,
  p_kit_tag_name text,
  p_application_id bigint default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_contact contacts%rowtype;
  v_requested_by text;
  v_id bigint;
  v_existing kit_sync_operations%rowtype;
begin
  select * into v_contact from contacts where id = p_contact_id;
  if not found then
    return jsonb_build_object('status', 'contact-invalid');
  end if;
  if v_contact.sales_eligibility = 'do_not_engage' then
    return jsonb_build_object('status', 'do-not-engage');
  end if;
  if p_kit_tag_id is null or p_kit_tag_id <= 0 then
    return jsonb_build_object('status', 'tag-invalid');
  end if;
  if p_application_id is not null
     and not exists (select 1 from applications where id = p_application_id
                      and contact_id = p_contact_id) then
    -- A manual tag may MENTION the application it was started from, but only
    -- one that belongs to the same person.
    return jsonb_build_object('status', 'application-invalid');
  end if;

  select coalesce(s.email, s.first_name || ' ' || s.last_name) into v_requested_by
    from sales s where s.user_id = auth.uid();

  v_id := public.enqueue_kit_operation(
    p_contact_id, p_application_id, 'manual', 'manual_owner',
    p_kit_tag_id, p_kit_tag_name, coalesce(v_requested_by, 'owner'));

  if v_id is null then
    -- Either this person has no usable email, or the same tag was already
    -- asked for. The second is a no-op and must read as success.
    select * into v_existing from kit_sync_operations
     where contact_id = p_contact_id and kit_tag_id = p_kit_tag_id
       and origin = 'manual_owner';
    if found then
      return jsonb_build_object('status', 'already-requested',
        'operation_id', v_existing.id, 'operation_status', v_existing.status);
    end if;
    return jsonb_build_object('status', 'no-email');
  end if;

  return jsonb_build_object('status', 'requested', 'operation_id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- The configuration becomes READABLE by the browser, because the Programme
-- page has to show which tags a programme uses and the Application has to know
-- whether it predates the integration. It does NOT become writable: every
-- change goes through set_program_kit_tag, which validates, so a browser can
-- never PATCH an arbitrary number into the mapping that decides which email a
-- future applicant receives.
revoke all on public.kit_tag_mappings from anon;
grant select on public.kit_tag_mappings to authenticated;
revoke all on public.kit_integration_settings from anon;
grant select on public.kit_integration_settings to authenticated;

drop policy if exists "Kit tag mappings are readable" on public.kit_tag_mappings;
create policy "Kit tag mappings are readable" on public.kit_tag_mappings
  for select to authenticated using (true);
drop policy if exists "Kit integration settings are readable" on public.kit_integration_settings;
create policy "Kit integration settings are readable" on public.kit_integration_settings
  for select to authenticated using (true);
-- No insert/update/delete policy on either, deliberately.

-- The two owner authorities.
revoke all on function public.set_program_kit_tag(bigint, text, bigint, text) from public;
revoke all on function public.set_program_kit_tag(bigint, text, bigint, text) from anon;
grant execute on function public.set_program_kit_tag(bigint, text, bigint, text) to authenticated;
grant execute on function public.set_program_kit_tag(bigint, text, bigint, text) to service_role;

revoke all on function public.request_kit_manual_tag(bigint, bigint, text, bigint) from public;
revoke all on function public.request_kit_manual_tag(bigint, bigint, text, bigint) from anon;
grant execute on function public.request_kit_manual_tag(bigint, bigint, text, bigint) to authenticated;
grant execute on function public.request_kit_manual_tag(bigint, bigint, text, bigint) to service_role;

-- The insert primitives stay internal. Not even service_role: on their own
-- they would create a tag operation with nothing to justify one.
revoke all on function public.enqueue_kit_operation(bigint, bigint, text, text, bigint, text, text) from public;
revoke all on function public.enqueue_kit_operation(bigint, bigint, text, text, bigint, text, text) from anon;
revoke all on function public.enqueue_kit_operation(bigint, bigint, text, text, bigint, text, text) from authenticated;
revoke all on function public.enqueue_kit_operation(bigint, bigint, text, text, bigint, text, text) from service_role;
revoke all on function public.enqueue_kit_cohort_tag(bigint) from public;
revoke all on function public.enqueue_kit_cohort_tag(bigint) from anon;
revoke all on function public.enqueue_kit_cohort_tag(bigint) from authenticated;
revoke all on function public.enqueue_kit_cohort_tag(bigint) from service_role;

-- ---------------------------------------------------------------------------
-- Proof
-- ---------------------------------------------------------------------------
-- The claim that makes owner-editable configuration safe is "changing a tag
-- changes nothing that already happened". It is asserted here on throwaway
-- rows inside a subtransaction that is always unwound.
DO $proof$
DECLARE
  v_le constant bigint := 1;
  v_gyu constant bigint := 2;
  v_contact bigint;
  v_contact2 bigint;
  v_cohort bigint;
  v_app bigint;
  v_app2 bigint;
  v_result jsonb;
  v_ops integer;
  v_tag bigint;
  v_frozen bigint;
  v_refused boolean := false;
BEGIN
  -- The deployed guarantee must survive the index becoming partial.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE indexname = 'kit_sync_operations_application_kind_idx'
       AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%application_id, kind%'
  ) THEN
    RAISE EXCEPTION 'the automatic idempotency anchor is gone';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE indexname = 'kit_sync_operations_manual_tag_idx'
       AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%contact_id, kit_tag_id%'
  ) THEN
    RAISE EXCEPTION 'the manual idempotency anchor is missing';
  END IF;

  BEGIN
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Config', 'Proof',
            jsonb_build_array(jsonb_build_object('email', 'config.proof@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_contact;

    -- ---- a cohort tag is additive, and only when the round has one --------
    INSERT INTO cohorts (offer_id, name, status, applications_open_at, applications_close_at)
    VALUES (v_gyu, 'Kit config proof round', 'applications_open',
            current_date - 1, current_date + 30)
    RETURNING id INTO v_cohort;

    -- No cohort tag configured yet: the programme tag, and nothing else.
    v_result := public.submit_public_application(
      v_gyu, v_cohort, 'Ada', 'Byron', 'ada.config@example.com', null, '{}'::jsonb);
    v_app := (v_result ->> 'application_id')::bigint;
    SELECT count(*) INTO v_ops FROM kit_sync_operations WHERE application_id = v_app;
    IF v_ops <> 1 THEN
      RAISE EXCEPTION 'an untagged round produced % operation(s), expected only the programme tag', v_ops;
    END IF;

    -- Configure one, and a NEW application gets both — as two separate rows.
    UPDATE cohorts SET kit_tag_id = 991234, kit_tag_name = 'GYU_ProofRound' WHERE id = v_cohort;
    v_result := public.submit_public_application(
      v_gyu, v_cohort, 'Grace', 'Hopper', 'grace.config@example.com', null, '{}'::jsonb);
    v_app2 := (v_result ->> 'application_id')::bigint;
    SELECT count(*) INTO v_ops FROM kit_sync_operations WHERE application_id = v_app2;
    IF v_ops <> 2 THEN
      RAISE EXCEPTION 'a tagged round produced % operation(s), expected 2', v_ops;
    END IF;
    IF (SELECT kit_tag_id FROM kit_sync_operations WHERE application_id = v_app2 AND kind = 'cohort') <> 991234
       OR (SELECT kit_tag_id FROM kit_sync_operations WHERE application_id = v_app2 AND kind = 'applicant') <> 24082724 THEN
      RAISE EXCEPTION 'the round''s two tags are not the programme tag plus the cohort tag';
    END IF;
    -- And the earlier application is untouched by configuring it afterwards.
    SELECT count(*) INTO v_ops FROM kit_sync_operations WHERE application_id = v_app;
    IF v_ops <> 1 THEN
      RAISE EXCEPTION 'configuring a cohort tag retagged an application that already existed';
    END IF;

    -- ---- changing a programme mapping is FUTURE-ONLY ---------------------
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Future', 'Only',
            jsonb_build_array(jsonb_build_object('email', 'future.only@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_contact2;

    v_result := public.submit_public_application(
      v_le, null, 'Before', 'Change', 'before.change@example.com', null, '{}'::jsonb);
    v_app := (v_result ->> 'application_id')::bigint;
    SELECT kit_tag_id INTO v_frozen FROM kit_sync_operations WHERE application_id = v_app;
    IF v_frozen <> 24082722 THEN
      RAISE EXCEPTION 'the Living Example applicant tag was % before the change', v_frozen;
    END IF;

    v_result := public.set_program_kit_tag(v_le, 'applicant', 995555, 'MiniDD_Applicant_v2');
    IF v_result ->> 'status' <> 'set' THEN
      RAISE EXCEPTION 'the owner could not change a programme mapping: %', v_result;
    END IF;

    -- The operation that already existed keeps the tag it was created with.
    IF (SELECT kit_tag_id FROM kit_sync_operations WHERE application_id = v_app) <> v_frozen THEN
      RAISE EXCEPTION 'changing the mapping rewrote an existing operation';
    END IF;
    -- A NEW application uses the new tag.
    v_result := public.submit_public_application(
      v_le, null, 'After', 'Change', 'after.change@example.com', null, '{}'::jsonb);
    SELECT kit_tag_id INTO v_tag FROM kit_sync_operations
     WHERE application_id = (v_result ->> 'application_id')::bigint;
    IF v_tag <> 995555 THEN
      RAISE EXCEPTION 'a new application used % rather than the new mapping', v_tag;
    END IF;
    -- And nobody was backfilled by the change.
    IF EXISTS (SELECT 1 FROM kit_sync_operations WHERE kit_tag_id = 995555
                AND application_id = v_app) THEN
      RAISE EXCEPTION 'changing the mapping backfilled an old applicant';
    END IF;

    -- Clearing a mapping stops new work rather than guessing a tag.
    PERFORM public.set_program_kit_tag(v_le, 'applicant', null, null);
    v_result := public.submit_public_application(
      v_le, null, 'No', 'Mapping', 'no.mapping@example.com', null, '{}'::jsonb);
    IF EXISTS (SELECT 1 FROM kit_sync_operations
                WHERE application_id = (v_result ->> 'application_id')::bigint) THEN
      RAISE EXCEPTION 'an unmapped programme was given a guessed tag';
    END IF;
    PERFORM public.set_program_kit_tag(v_le, 'applicant', 24082722, 'MiniDD_Applicant');

    -- ---- manual owner tagging --------------------------------------------
    v_result := public.request_kit_manual_tag(v_contact2, 24082722, 'MiniDD_Applicant', null);
    IF v_result ->> 'status' <> 'requested' THEN
      RAISE EXCEPTION 'a manual tag was not accepted: %', v_result;
    END IF;
    IF (SELECT origin FROM kit_sync_operations WHERE id = (v_result ->> 'operation_id')::bigint)
       <> 'manual_owner' THEN
      RAISE EXCEPTION 'a manual tag was not recorded as the owner''s';
    END IF;
    IF (SELECT application_id FROM kit_sync_operations WHERE id = (v_result ->> 'operation_id')::bigint)
       IS NOT NULL THEN
      RAISE EXCEPTION 'a person-level manual tag claimed an application';
    END IF;

    -- Asking twice is the same request.
    v_result := public.request_kit_manual_tag(v_contact2, 24082722, 'MiniDD_Applicant', null);
    IF v_result ->> 'status' <> 'already-requested' THEN
      RAISE EXCEPTION 'a repeated manual tag was not a no-op: %', v_result;
    END IF;
    SELECT count(*) INTO v_ops FROM kit_sync_operations
     WHERE contact_id = v_contact2 AND origin = 'manual_owner';
    IF v_ops <> 1 THEN
      RAISE EXCEPTION 'asking twice produced % manual operation(s)', v_ops;
    END IF;

    -- Somebody the CRM refused is refused here too.
    UPDATE contacts SET sales_eligibility = 'do_not_engage' WHERE id = v_contact;
    v_result := public.request_kit_manual_tag(v_contact, 24082722, 'MiniDD_Applicant', null);
    IF v_result ->> 'status' <> 'do-not-engage' THEN
      RAISE EXCEPTION 'a Do Not Engage contact could be manually tagged: %', v_result;
    END IF;

    -- ---- the browser still cannot invent an operation or a mapping -------
    BEGIN
      SET LOCAL role authenticated;
      INSERT INTO kit_tag_mappings (offer_id, event, kit_tag_id, kit_tag_name)
      VALUES (v_le, 'approved', 999999, 'Anything');
      RESET role;
    EXCEPTION WHEN others THEN
      RESET role;
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'an authenticated session wrote a Kit mapping directly';
    END IF;

    v_refused := false;
    BEGIN
      SET LOCAL role authenticated;
      INSERT INTO kit_sync_operations
        (contact_id, kind, origin, email, kit_tag_id, kit_tag_name)
      VALUES (v_contact2, 'manual', 'manual_owner', 'future.only@example.com', 999999, 'Anything');
      RESET role;
    EXCEPTION WHEN others THEN
      RESET role;
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'an authenticated session inserted its own Kit operation';
    END IF;

    -- But it CAN read the configuration it has to display.
    BEGIN
      SET LOCAL role authenticated;
      PERFORM count(*) FROM kit_tag_mappings;
      PERFORM count(*) FROM kit_integration_settings;
      RESET role;
    EXCEPTION WHEN others THEN
      RESET role;
      RAISE EXCEPTION 'the owner cannot read the Kit configuration the UI needs';
    END;

    RAISE NOTICE 'kit config proof: a cohort tag is additive and future-only, a mapping change never touches an existing operation or backfills anybody, clearing a mapping stops new work rather than guessing, manual owner tags are idempotent per person per tag and refused for Do Not Engage, and the browser reads configuration but writes neither it nor an operation';

    RAISE EXCEPTION 'kit config proof complete' USING ERRCODE = 'restrict_violation';
  EXCEPTION
    WHEN restrict_violation THEN
      NULL;
  END;
END
$proof$;
