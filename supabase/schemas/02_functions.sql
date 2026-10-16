--
-- Functions
-- This file declares all PL/pgSQL functions in the public schema.
--

CREATE OR REPLACE FUNCTION "public"."cleanup_note_attachments"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    DECLARE
      payload jsonb;
      request_headers jsonb;
      auth_header text;
    BEGIN
      request_headers := coalesce(
        nullif(current_setting('request.headers', true), '')::jsonb,
        '{}'::jsonb
      );
      auth_header := request_headers ->> 'authorization';

      IF auth_header IS NULL OR auth_header = '' THEN
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;

        RETURN NEW;
      END IF;

      payload := jsonb_build_object(
        'old_record', OLD,
        'record', NEW,
        'type', TG_OP
      );

      PERFORM net.http_post(
        url := public.get_note_attachments_function_url(),
        body := payload,
        params := '{}'::jsonb,
        headers := jsonb_build_object(
          'Content-Type',
          'application/json',
          'Authorization',
          auth_header
        ),
        timeout_milliseconds := 10000
      );

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;

      RETURN NEW;
    END;
    $$;

CREATE OR REPLACE FUNCTION "public"."get_avatar_for_email"("email" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare email_hash text;
declare gravatar_url text;
declare gravatar_status int8;
declare email_domain text;
declare favicon_url text;
declare domain_status int8;

begin
    -- Try to fetch a gravatar image
    email_hash = encode(extensions.digest(email, 'sha256'), 'hex');
    gravatar_url = concat('https://www.gravatar.com/avatar/', email_hash, '?d=404');

    select status from extensions.http_get(gravatar_url) into gravatar_status;

    if gravatar_status = 200 then
        return gravatar_url;
    end if;

    -- Fallback to email's domain favicon if not excluded
    email_domain = split_part(email, '@', 2);
    return get_domain_favicon(email_domain);
exception
    when others then
        return 'ERROR';
end;
$$;

CREATE OR REPLACE FUNCTION "public"."get_domain_favicon"("domain_name" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare domain_status int8;

begin
    if exists (select from favicons_excluded_domains as fav where fav.domain = domain_name) then
        return null;
    end if;

    return concat(
        'https://favicon.show/',
        (regexp_matches(domain_name, '^(?:https?:\/\/)?(?:[^@\/\n]+@)?(?:www\.)?([^:\/?\n]+)', 'i'))[1]
    );
end;
$$;

CREATE OR REPLACE FUNCTION "public"."get_note_attachments_function_url"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
    DECLARE
      issuer text;
      function_url text;
    BEGIN
      issuer := coalesce(
        nullif(current_setting('request.jwt.claim.iss', true), ''),
        (
          coalesce(
            nullif(current_setting('request.jwt.claims', true), ''),
            '{}'
          )::jsonb ->> 'iss'
        )
      );
      issuer := nullif(issuer, '');
      IF issuer IS NOT NULL THEN
        issuer := rtrim(issuer, '/');
        IF right(issuer, 8) = '/auth/v1' THEN
          function_url :=
            left(issuer, length(issuer) - 8) || '/functions/v1/delete_note_attachments';

          IF function_url LIKE 'http://127.0.0.1:%' THEN
            RETURN replace(
              function_url,
              'http://127.0.0.1:',
              'http://host.docker.internal:'
            );
          END IF;

          IF function_url LIKE 'http://localhost:%' THEN
            RETURN replace(
              function_url,
              'http://localhost:',
              'http://host.docker.internal:'
            );
          END IF;

          RETURN function_url;
        END IF;
      END IF;

      RETURN 'http://host.docker.internal:54321/functions/v1/delete_note_attachments';
    END;
    $$;

CREATE OR REPLACE FUNCTION "public"."get_user_id_by_email"("email" "text") RETURNS TABLE("id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
BEGIN
  RETURN QUERY SELECT au.id FROM auth.users au WHERE au.email = $1;
END;
$_$;

CREATE OR REPLACE FUNCTION "public"."handle_company_saved"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare company_logo text;

begin
    if new.logo is not null then
        return new;
    end if;

    company_logo = get_domain_favicon(new.website);
    if company_logo is null then
        return new;
    end if;

    new.logo = concat('{"src":"', company_logo, '","title":"Company favicon"}');
    return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."handle_contact_note_created_or_updated"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  update public.contacts set last_seen = new.date where contacts.id = new.contact_id and contacts.last_seen < new.date;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."handle_contact_saved"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$declare contact_avatar text;
declare emails_length int8;
declare item jsonb;

begin
    if new.avatar is not null then
        return new;
    end if;

    -- Historical Migration slice: everything below this point is OUTBOUND
    -- HTTP enrichment — get_avatar_for_email() calls gravatar.com and then
    -- the email domain's favicon service. A bulk historical import fires
    -- one lookup per imported Contact, transmitting a hash of each real
    -- person's email address to third parties purely to decorate
    -- back-filled records (Gate A measured 271 such lookups). Migration
    -- mode skips the network enrichment ONLY: avatar is simply left null,
    -- to be filled by any later ordinary save. Every database-local
    -- contact invariant is untouched — sales_id defaulting and email
    -- lowercasing are their own separate triggers and still run. See
    -- set_historical_migration_mode()'s header for why this GUC is safe.
    if current_setting('app.migration_mode', true) = 'true' then
        return new;
    end if;

    select coalesce(jsonb_array_length(new.email_jsonb), 0) into emails_length;

    if emails_length = 0 then
        return new;
    end if;

    for item in select jsonb_array_elements(new.email_jsonb)
    loop
        select public.get_avatar_for_email(item->>'email') into contact_avatar;
        if (contact_avatar is not null) then
            exit;
        end if;
    end loop;

    if contact_avatar is null then
        return new;
    end if;

    new.avatar = concat('{"src":"', contact_avatar, '"}');
    return new;
end;$$;

CREATE OR REPLACE FUNCTION "public"."handle_deal_saved"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_offer offers%ROWTYPE;
  v_cohort_offer_id bigint;
  v_contact contacts%ROWTYPE;
  v_option_offer_id bigint;
  v_option_pricing_mode text;
  v_rows int;
begin
  -- Won is a SALES fact: the prospect accepted. Not paid, not enrolled,
  -- not onboarded (20260918180000). Still not something to type into a
  -- field by hand, because handle_deal_won() turns it into an Enrollment,
  -- an onboarding checklist and possibly a claimed scholarship slot.
  if new.stage = 'won'
     and (tg_op = 'INSERT' or old.stage is distinct from 'won')
     and current_user in ('anon', 'authenticated')
  then
    raise exception 'Deal % cannot be set to Won by editing its stage — record the sale through the sales-call outcome or the prospect decision', new.id;
  end if;

  select * into v_offer from offers where id = new.offer_id;
  if v_offer.id is null then
    raise exception 'Invalid offer_id %', new.offer_id;
  end if;

  if new.cohort_id is not null then
    select offer_id into v_cohort_offer_id from cohorts where id = new.cohort_id;
    if v_cohort_offer_id is null then
      raise exception 'Invalid cohort_id %', new.cohort_id;
    end if;
    if v_offer.type <> 'group' then
      raise exception 'cohort_id can only be set on a group offer (offer_id %)', new.offer_id;
    end if;
    if v_cohort_offer_id <> new.offer_id then
      raise exception 'cohort_id % does not belong to offer_id %', new.cohort_id, new.offer_id;
    end if;
  end if;

  if current_setting('app.migration_mode', true) is distinct from 'true' then
    if tg_op = 'UPDATE' and old.stage = 'won' and new.pricing_mode is distinct from old.pricing_mode then
      raise exception 'Cannot change pricing_mode on deal % once it has reached Won', new.id;
    end if;

    -- An enrolled client's programme is not a form field. Changing it leaves
    -- an Enrollment, an onboarding checklist and its Tasks describing a
    -- programme nobody bought — which is what happened to Jenna Smith, three
    -- minutes after her sale.
    if tg_op = 'UPDATE'
       and new.offer_id is distinct from old.offer_id
       and current_user in ('anon', 'authenticated')
       and exists (select 1 from enrollments where opportunity_id = new.id)
    then
      raise exception 'Opportunity % has an Enrollment: move the client with transfer_enrolled_opportunity_offer() rather than editing the offer, so their onboarding and Tasks follow', new.id;
    end if;

    if tg_op = 'INSERT' and new.pricing_mode = 'scholarship' then
      raise exception 'A new Opportunity cannot be created directly as scholarship — grant scholarship pricing via Deal edit after creation';
    end if;

    if tg_op = 'UPDATE'
       and old.pricing_mode = 'scholarship'
       and new.offer_id is distinct from old.offer_id
    then
      raise exception 'Cannot change offer_id on deal % while it holds a scholarship reservation — release scholarship pricing first', new.id;
    end if;

    if tg_op = 'UPDATE' and new.pricing_mode is distinct from old.pricing_mode then
      if new.pricing_mode = 'scholarship' then
        if v_offer.scholarship_price is null then
          raise exception 'Offer % has no scholarship price configured', new.offer_id;
        end if;

        insert into scholarship_slots (offer_id, holder_deal_id, reserved_at)
        values (new.offer_id, new.id, now())
        on conflict (offer_id) do update
          set holder_deal_id = excluded.holder_deal_id,
              reserved_at = excluded.reserved_at
          where scholarship_slots.holder_deal_id is null
            and scholarship_slots.holder_enrollment_id is null;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          raise exception 'Scholarship slot for offer % is already held', new.offer_id;
        end if;

        insert into scholarship_slot_events (offer_id, deal_id, event_type, occurred_at)
        values (new.offer_id, new.id, 'scholarship_granted', now());
      elsif old.pricing_mode = 'scholarship' then
        update scholarship_slots
          set holder_deal_id = null, reserved_at = null, updated_at = now()
          where offer_id = old.offer_id and holder_deal_id = new.id;

        insert into scholarship_slot_events (offer_id, deal_id, event_type, occurred_at)
        values (old.offer_id, new.id, 'scholarship_released', now());
      end if;
    end if;
  end if;

  if tg_op = 'INSERT'
     or new.offer_id is distinct from old.offer_id
     or new.pricing_mode is distinct from old.pricing_mode
  then
    new.offer_name_snapshot := v_offer.name;
    new.offer_price_snapshot := case
      when new.pricing_mode = 'scholarship' then v_offer.scholarship_price
      else v_offer.current_price
    end;
  end if;

  if new.selected_payment_option_id is not null
     and (tg_op = 'INSERT'
          or new.selected_payment_option_id is distinct from old.selected_payment_option_id
          or new.pricing_mode is distinct from old.pricing_mode)
  then
    select offer_id, pricing_mode, total, installments, installment_amount
      into v_option_offer_id, v_option_pricing_mode,
           new.selected_payment_total, new.selected_installment_count, new.selected_installment_amount
      from offer_payment_options
      where id = new.selected_payment_option_id;

    if v_option_offer_id is null then
      raise exception 'Invalid selected_payment_option_id %', new.selected_payment_option_id;
    end if;
    if v_option_offer_id <> new.offer_id or v_option_pricing_mode <> new.pricing_mode then
      raise exception 'Payment option % does not match deal %''s offer/pricing_mode', new.selected_payment_option_id, new.id;
    end if;
  end if;

  select * into v_contact from contacts where id = new.contact_id;
  if v_contact.id is not null then
    new.name := trim(both ' ' from coalesce(v_contact.first_name, '') || ' ' || coalesce(v_contact.last_name, ''));
  end if;

  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."handle_waitlist_entry_saved"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_offer offers%ROWTYPE;
  v_cohort_offer_id bigint;
begin
  select * into v_offer from offers where id = new.offer_id;
  if v_offer.id is null then
    raise exception 'Invalid offer_id %', new.offer_id;
  end if;

  if new.cohort_id is not null then
    select offer_id into v_cohort_offer_id from cohorts where id = new.cohort_id;
    if v_cohort_offer_id is null then
      raise exception 'Invalid cohort_id %', new.cohort_id;
    end if;
    if v_offer.type <> 'group' then
      raise exception 'cohort_id can only be set on a group offer (offer_id %)', new.offer_id;
    end if;
    if v_cohort_offer_id <> new.offer_id then
      raise exception 'cohort_id % does not belong to offer_id %', new.cohort_id, new.offer_id;
    end if;
  end if;

  return new;
end;
$$;

-- Historical Migration slice: the one deliberately narrow entry point that
-- may enable app.migration_mode for the CURRENT transaction only (the
-- is_local=true third argument to set_config is what makes it reset
-- automatically on COMMIT or ROLLBACK — never a session-wide or database-
-- wide setting, never persists past the transaction that set it).
--
-- SECURITY DEFINER + a pinned search_path so this can't be tricked by a
-- caller-controlled search_path into resolving set_config from anywhere
-- but pg_catalog. The internal auth.role() check mirrors handle_deal_saved()'s
-- own Won-authority guard exactly: NULL (a direct database/migration
-- connection that never went through PostgREST) is the trusted admin
-- context this whole historical-import mechanism is built for; a real
-- 'authenticated' PostgREST caller is explicitly rejected even if grants
-- were ever accidentally widened later — defense in depth on top of the
-- REVOKE in 06_grants.sql, not instead of it.
--
-- This function does nothing else — it does not itself write any business
-- data. The historical importer calls this to turn migration mode on,
-- performs its own plain INSERT/UPDATE statements (still running as
-- service_role) inside the same transaction, then calls this again to turn
-- it off before COMMIT (belt-and-suspenders: COMMIT already resets it on
-- its own).
CREATE OR REPLACE FUNCTION "public"."set_historical_migration_mode"("enable" boolean) RETURNS "void"
    LANGUAGE "plpgsql"
    SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if auth.role() is not null and auth.role() <> 'service_role' then
    raise exception 'set_historical_migration_mode() is restricted to a service_role/direct-connection context';
  end if;
  perform set_config('app.migration_mode', case when enable then 'true' else 'false' end, true);
end;
$$;

CREATE OR REPLACE FUNCTION public.handle_deal_won()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cohort cohorts%ROWTYPE;
  v_enrollment_id bigint;
begin
  -- A historical Won Deal must never fire live onboarding: the importer
  -- inserts the truthful final-state Enrollment itself. Only
  -- set_historical_migration_mode() can set this GUC, transaction-locally.
  if current_setting('app.migration_mode', true) = 'true' then
    return new;
  end if;

  if new.stage = 'won' and (tg_op = 'INSERT' or old.stage is distinct from 'won') then
    if new.cohort_id is not null then
      select * into v_cohort from cohorts where id = new.cohort_id;
    end if;

    -- Idempotent: the unique constraint on enrollments.opportunity_id means
    -- re-saving Won never creates a duplicate. `returning ... into` only
    -- assigns on a genuine insert, so the block below stays replay-safe.
    insert into enrollments (opportunity_id, status, start_date, end_date, onboarding_tracking, start_date_source)
    values (
      new.id,
      'onboarding',
      v_cohort.program_start_at::date,
      v_cohort.program_end_at::date,
      -- A sale made today is tracked. legacy_untracked is only ever a
      -- statement about the past, never a default for new work.
      'tracked',
      -- A Cohort start is a date Leif published when he created the round,
      -- so a cohort Enrollment begins life with an owner-stated Start Week.
      -- An individual Offer has no such date to snapshot: the Start Week is
      -- Leif's to set, and until he does it stays unknown rather than being
      -- inferred from a booking, a Won date or a payment.
      case when v_cohort.program_start_at is not null then 'owner' end
    )
    on conflict (opportunity_id) do nothing
    returning id into v_enrollment_id;

    if v_enrollment_id is not null then
      perform public.seed_enrollment_onboarding(v_enrollment_id);

      -- Scholarship slot occupancy moves from Deal to Enrollment in the
      -- same transaction, so the slot is never observably free between the
      -- two.
      if new.pricing_mode = 'scholarship' then
        update scholarship_slots
           set holder_deal_id = null, holder_enrollment_id = v_enrollment_id, updated_at = now()
         where offer_id = new.offer_id and holder_deal_id = new.id;
        if not found then
          raise exception 'Deal % reached Won as scholarship but held no scholarship slot for offer % — data inconsistency', new.id, new.offer_id;
        end if;

        insert into scholarship_slot_events (offer_id, deal_id, enrollment_id, event_type, occurred_at)
        values (new.offer_id, new.id, v_enrollment_id, 'deal_converted_to_enrollment', now());
      end if;
    end if;
  end if;
  return new;
end;
$function$
;

-- Scholarship Pricing + Capacity slice: the other half of the atomic
-- grant/convert/release lifecycle (see handle_deal_saved()/handle_deal_won()
-- for the Deal-side grant/release/convert steps) — releases the slot the
-- instant an Enrollment genuinely completes (a completed Enrollment never
-- occupies capacity, exactly like every other Enrollment-capacity
-- convention in this schema), and handles the one remaining transition:
-- a backward lifecycle correction OFF of completed (enforce_enrollment_
-- lifecycle_sequence() already allows backward corrections generally) must
-- attempt to RECLAIM the slot rather than silently leaving the Enrollment
-- "current" again with no capacity accounting. If another Deal/Enrollment
-- has since claimed that Offer's slot, the correction is rejected outright
-- (raising here aborts the whole enrollments UPDATE, same as any other
-- guard trigger in this schema) — never silently displacing another
-- holder. Only ever touches offers this Enrollment's own Deal was actually
-- granted scholarship pricing for; a standard Enrollment's lifecycle
-- changes never reach the scholarship_slots table at all.
CREATE OR REPLACE FUNCTION "public"."handle_enrollment_scholarship_slot_transition"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_offer_id bigint;
  v_rows int;
begin
  if new.status is distinct from old.status then
    if new.status = 'completed' then
      update scholarship_slots
        set holder_enrollment_id = null, updated_at = now()
        where holder_enrollment_id = new.id;
      if found then
        select offer_id into v_offer_id from deals where id = new.opportunity_id;
        insert into scholarship_slot_events (offer_id, enrollment_id, event_type, occurred_at)
        values (v_offer_id, new.id, 'enrollment_completed_slot_released', now());
      end if;
    elsif old.status = 'completed' then
      select offer_id into v_offer_id
        from deals
        where id = new.opportunity_id and pricing_mode = 'scholarship';

      if v_offer_id is not null then
        insert into scholarship_slots (offer_id, holder_enrollment_id, reserved_at)
        values (v_offer_id, new.id, now())
        on conflict (offer_id) do update
          set holder_enrollment_id = excluded.holder_enrollment_id,
              reserved_at = excluded.reserved_at
          where scholarship_slots.holder_deal_id is null
            and scholarship_slots.holder_enrollment_id is null;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          raise exception 'Cannot reopen enrollment %: scholarship slot for offer % is already held by another Deal/Enrollment', new.id, v_offer_id;
        end if;

        insert into scholarship_slot_events (offer_id, enrollment_id, event_type, occurred_at)
        values (v_offer_id, new.id, 'slot_reclaimed_after_backward_lifecycle_correction', now());
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- Contracts + Onboarding slice: Task -> business-context integrity. A Task
-- pointing at a specific checklist item must always also point at that
-- item's own Enrollment (never onboarding_item_id set with a mismatched or
-- missing enrollment_id) — cheap to enforce here rather than trusting every
-- future insert/update call site to get both columns right by hand.
-- Client Offboarding slice: extended with the identical check for
-- offboarding_item_id — same integrity requirement, same reasoning, one
-- shared function rather than a near-duplicate second trigger function.
CREATE OR REPLACE FUNCTION "public"."set_task_enrollment_id_consistency"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_item_enrollment_id bigint;
begin
  if new.onboarding_item_id is not null then
    select enrollment_id into v_item_enrollment_id
      from enrollment_onboarding_items where id = new.onboarding_item_id;
    if v_item_enrollment_id is null then
      raise exception 'Invalid onboarding_item_id %', new.onboarding_item_id;
    end if;
    if new.enrollment_id is null then
      new.enrollment_id := v_item_enrollment_id;
    elsif new.enrollment_id <> v_item_enrollment_id then
      raise exception 'enrollment_id % does not match onboarding_item_id %''s own enrollment_id %',
        new.enrollment_id, new.onboarding_item_id, v_item_enrollment_id;
    end if;
  end if;
  if new.offboarding_item_id is not null then
    select enrollment_id into v_item_enrollment_id
      from enrollment_offboarding_items where id = new.offboarding_item_id;
    if v_item_enrollment_id is null then
      raise exception 'Invalid offboarding_item_id %', new.offboarding_item_id;
    end if;
    if new.enrollment_id is null then
      new.enrollment_id := v_item_enrollment_id;
    elsif new.enrollment_id <> v_item_enrollment_id then
      raise exception 'enrollment_id % does not match offboarding_item_id %''s own enrollment_id %',
        new.enrollment_id, new.offboarding_item_id, v_item_enrollment_id;
    end if;
  end if;
  return new;
end;
$$;

-- Contracts + Onboarding slice: the Task -> checklist-item half of the
-- two-way sync (architecture review, §8). Fires whenever a Task pointing
-- at a specific item transitions its done-ness in either direction —
-- completing (or reopening) the Task marks that ONE item done (or
-- reopens it back to pending). Deliberately does NOT run the other way
-- (a cancelled Task never completes its item, and never reverts a
-- directly-completed item to pending) — the checklist item is the
-- durable source of truth Leif approved; a Task is only ever a reminder.
-- The reverse direction (completing an item directly also completes its
-- linked Task) is application-layer (completeOnboardingItem.ts) rather
-- than a second DB trigger — checklist items only have one write surface
-- in this slice, so there's no "many entry points" risk to guard against
-- at the DB level the way Task edits (checkbox, edit sheet, mobile list)
-- already have.
CREATE OR REPLACE FUNCTION "public"."sync_onboarding_item_from_task"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.onboarding_item_id is null then
    return new;
  end if;

  if new.done_date is not null and old.done_date is null and new.status = 'completed' then
    update enrollment_onboarding_items
      set status = 'done', completed_at = coalesce(completed_at, new.done_date), updated_at = now()
      where id = new.onboarding_item_id and status not in ('done', 'retired');
  elsif new.done_date is null and old.done_date is not null then
    -- Reopened. A retired requirement is not reopened by its Task coming
    -- back: only another transfer brings it back.
    update enrollment_onboarding_items
      set status = 'pending', completed_at = null, updated_at = now()
      where id = new.onboarding_item_id and status = 'done';
  end if;

  return new;
end;
$$;

-- Client Offboarding slice, §1: the fulfillment lifecycle is a strict
-- sequence (onboarding -> active -> offboarding -> completed) — nothing
-- may skip a stage, whether written through a guarded domain function
-- (activateEnrollment.ts/startOffboarding.ts/completeClient.ts already
-- each only accept one specific FROM status, so they can never produce a
-- skip) or directly through ClientEdit.tsx's plain status field (the
-- same "direct write path" gap enforce_enrollment_activation_requirements
-- below already closes for its own narrower transition). Rank-based
-- rather than an enumerated list of forbidden pairs, so it stays correct
-- automatically if a stage is ever inserted into the sequence. Backward
-- corrections (completed -> active, offboarding -> onboarding, etc.) are
-- deliberately NOT rejected here — same "a manual correction stays
-- ungated" precedent as the activation guard below; only a FORWARD skip
-- (new rank more than one ahead of old rank) is nonsensical.
CREATE OR REPLACE FUNCTION "public"."enforce_enrollment_lifecycle_sequence"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_old_rank int;
  v_new_rank int;
begin
  -- Terminal exits are reachable from anywhere; only the fulfillment
  -- sequence itself can be skipped.
  if new.status in ('withdrawn', 'ended') then
    return new;
  end if;

  v_old_rank := case old.status
    when 'onboarding' then 0
    when 'active' then 1
    when 'offboarding' then 2
    when 'completed' then 3
  end;
  v_new_rank := case new.status
    when 'onboarding' then 0
    when 'active' then 1
    when 'offboarding' then 2
    when 'completed' then 3
  end;
  if v_new_rank > v_old_rank + 1 then
    raise exception 'Cannot transition enrollment % directly from % to % — the fulfillment lifecycle (onboarding -> active -> offboarding -> completed) cannot skip a stage', new.id, old.status, new.status;
  end if;
  return new;
end;
$$;

-- Contracts + Onboarding slice: the DB-level half of the Onboarding ->
-- Active guard (architecture review, §6). activateEnrollment.ts is the
-- normal write path and already checks this before writing, but
-- ClientEdit.tsx's plain status field (and any direct API write) goes
-- through this same table — this closes that gap rather than trusting
-- every future write path to remember the invariant. Only guards the
-- onboarding -> active direction; a manual correction back to onboarding
-- stays ungated.
CREATE OR REPLACE FUNCTION "public"."enforce_enrollment_activation_requirements"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_required int;
  v_outstanding int;
begin
  if new.status is distinct from 'active' or old.status is not distinct from 'active' then
    return new;
  end if;

  if current_setting('app.migration_mode', true) = 'true' then
    return new;
  end if;

  if new.onboarding_tracking = 'legacy_untracked' then
    return new;
  end if;

  select count(*) filter (where is_required),
         count(*) filter (where is_required and status <> 'done')
    into v_required, v_outstanding
    from enrollment_onboarding_items
   where enrollment_id = new.id
     and status <> 'retired';

  if v_required = 0 then
    raise exception 'Cannot activate enrollment %: it is tracked but has no required onboarding items. Either its Offer has no active onboarding templates, or seeding did not run. An empty checklist is not a finished one.', new.id
      using hint = 'Seed it with seed_enrollment_onboarding(), or record it as legacy_untracked if its onboarding genuinely happened outside the CRM.';
  end if;

  if v_outstanding > 0 then
    raise exception 'Cannot activate enrollment %: % of % required onboarding items are not done', new.id, v_outstanding, v_required;
  end if;

  return new;
end;
$$;

-- Client Offboarding slice: mirrors handle_deal_won()'s own checklist +
-- Task seeding exactly, but fires on the Enrollment's own active ->
-- offboarding transition rather than a Deal event (offboarding is a
-- fulfillment-lifecycle concern, never a sales-stage one — Won stays
-- terminal sales state). AFTER trigger, so it only fires once the
-- transition is genuinely committed; guarded to the exact transition
-- (old.status = 'active' and new.status = 'offboarding'), so it can never
-- re-fire for an unrelated field edit or a later manual correction, and a
-- duplicate "Start offboarding" write (already offboarding) is a safe
-- no-op the same way handle_deal_won()'s ON CONFLICT DO NOTHING is —
-- Postgres's own row-level locking during the UPDATE means a genuine
-- concurrent double-click race still only ever sees one row transition
-- through old.status = 'active' exactly once.
CREATE OR REPLACE FUNCTION "public"."handle_enrollment_offboarding_started"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_offer_id bigint;
  v_contact_id bigint;
  v_contact_name text;
  v_item record;
begin
  if new.status = 'offboarding' and old.status = 'active' then
    select d.offer_id, d.contact_id into v_offer_id, v_contact_id
      from deals d where d.id = new.opportunity_id;

    select trim(both ' ' from coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
      into v_contact_name
      from contacts where id = v_contact_id;
    if v_contact_name is null or v_contact_name = '' then
      select name into v_contact_name from deals where id = new.opportunity_id;
    end if;

    -- Zero configured requirements for this Offer is a valid, explicit
    -- state (Client Offboarding slice, §5) — the loop below simply
    -- inserts nothing and no Task is created, rather than manufacturing
    -- a fake requirement.
    for v_item in
      insert into enrollment_offboarding_items
        (enrollment_id, requirement_key, label, task_text_template, is_required, sort_order)
      select new.id, t.key, t.label, t.task_text_template, t.is_required, t.sort_order
      from offboarding_requirement_templates t
      where t.offer_id = v_offer_id and t.is_active
      returning id, is_required, task_text_template
    loop
      if v_item.is_required then
        insert into tasks (contact_id, type, text, due_date, status, enrollment_id, offboarding_item_id)
        values (
          v_contact_id,
          'offboarding_item',
          replace(v_item.task_text_template, '{name}', v_contact_name),
          now() + interval '3 days',
          'pending',
          new.id,
          v_item.id
        );
      end if;
    end loop;
  end if;
  return new;
end;
$$;

-- Client Offboarding slice: the offboarding mirror of
-- sync_onboarding_item_from_task() — identical Task -> checklist-item
-- sync semantics (a cancelled Task never completes its item; the
-- checklist item stays the durable source of truth), scoped to
-- offboarding_item_id instead.
CREATE OR REPLACE FUNCTION "public"."sync_offboarding_item_from_task"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.offboarding_item_id is null then
    return new;
  end if;

  if new.done_date is not null and old.done_date is null then
    update enrollment_offboarding_items
      set status = 'done', completed_at = coalesce(completed_at, new.done_date), updated_at = now()
      where id = new.offboarding_item_id and status <> 'done';
  elsif new.done_date is null and old.done_date is not null then
    update enrollment_offboarding_items
      set status = 'pending', completed_at = null, updated_at = now()
      where id = new.offboarding_item_id and status = 'done';
  end if;

  return new;
end;
$$;

-- Client Offboarding slice: the DB-level half of the Offboarding ->
-- Completed guard, mirroring enforce_enrollment_activation_requirements()
-- exactly — completeClient.ts is the normal write path and already
-- checks this, but ClientEdit.tsx's plain status field (and any other
-- direct write) goes through this same table. Only guards the
-- offboarding -> completed direction; a manual correction back to
-- offboarding (or any other direction) stays ungated.
CREATE OR REPLACE FUNCTION "public"."enforce_enrollment_completion_requirements"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.status = 'completed' and old.status = 'offboarding' then
    if exists (
      select 1 from enrollment_offboarding_items
      where enrollment_id = new.id and is_required and status <> 'done'
    ) then
      raise exception 'Cannot complete enrollment %: required offboarding items incomplete', new.id;
    end if;
  end if;
  return new;
end;
$$;

-- Client Offboarding slice: the smallest append-only audit trail for
-- Enrollment lifecycle transitions — mirrors record_deal_stage_event()'s
-- own guard shape (INSERT or a genuine status change), minus the
-- BEFORE-trigger companion deal_stage_events needs for its own
-- denormalized stage_entered_at column (enrollments has no equivalent to
-- keep in sync, so `now()` directly in this one AFTER trigger is
-- sufficient — NEW.id is already populated by the time an AFTER INSERT
-- trigger fires, unlike deals' own BEFORE-trigger constraint).
CREATE OR REPLACE FUNCTION "public"."record_enrollment_status_event"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  -- Historical Migration slice: enrollments has no per-status timestamp
  -- column of its own to source a truthful entered_at from (unlike deals'
  -- stage_entered_at), so there is nothing safe to substitute here — the
  -- importer inserts the correct, truthful enrollment_status_events row(s)
  -- itself, directly, with the real historical date(s). See
  -- set_historical_migration_mode()'s own header.
  if current_setting('app.migration_mode', true) = 'true' then
    return new;
  end if;

  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into enrollment_status_events (enrollment_id, status, entered_at)
    values (new.id, new.status, now());
  end if;
  return new;
end;
$$;

-- Acuity/Sales Call Lifecycle slice: keeps deals.sales_call_at (the
-- existing "next scheduled call" denormalized convenience field, read by
-- DealShow/DealInputs unchanged) in sync with sales_calls, the new source
-- of truth. Recomputes from scratch on every insert/update/delete rather
-- than trying to track "was this row the one currently reflected" —
-- always the scheduled_at of the Opportunity's most recent still-booked
-- call, or null if none. Mirrors providers/fakerest/dataProvider.ts's own
-- "sales_calls" resource hooks (dual-implementation convention).
CREATE OR REPLACE FUNCTION "public"."sync_deal_sales_call_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_opportunity_id bigint;
  v_latest timestamptz;
begin
  v_opportunity_id := coalesce(new.opportunity_id, old.opportunity_id);
  if v_opportunity_id is null then
    return coalesce(new, old);
  end if;

  select sc.scheduled_at into v_latest
    from sales_calls sc
   where sc.opportunity_id = v_opportunity_id
     and sc.status = 'booked'
     and sc.schedule_precision = 'exact'
   order by sc.scheduled_at desc
   limit 1;

  update deals
     set sales_call_at = v_latest
   where id = v_opportunity_id
     and sales_call_at is distinct from v_latest;

  return coalesce(new, old);
end;
$$;

-- Kanban queue-ordering slice: sets deals.stage_entered_at to "now" exactly
-- once per genuine stage change (mirrors handle_deal_won()'s own
-- tg_op/is-distinct-from guard so it is safe on both INSERT and UPDATE,
-- and never re-fires for an unrelated field edit, a note, or metadata
-- change on the same row). BEFORE trigger so the new value lands in the
-- same row write instead of a second UPDATE.
CREATE OR REPLACE FUNCTION "public"."set_deal_stage_entered_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  -- Historical Migration slice: preserve the caller-supplied historical
  -- stage_entered_at verbatim instead of overwriting it with now() — see
  -- set_historical_migration_mode()'s own header.
  if current_setting('app.migration_mode', true) = 'true' then
    return new;
  end if;

  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    new.stage_entered_at := now();
  end if;
  return new;
end;
$$;

-- Companion AFTER trigger: appends the permanent deal_stage_events row for
-- the same genuine stage change set_deal_stage_entered_at() just recorded.
-- Split into BEFORE/AFTER (rather than one trigger) because NEW.id is not
-- yet populated for a GENERATED BY DEFAULT AS IDENTITY primary key inside
-- a BEFORE INSERT trigger; this AFTER trigger runs once the row (and its
-- id) is committed. Guard is identical to set_deal_stage_entered_at()'s so
-- the two can never disagree about what counts as a genuine transition.
CREATE OR REPLACE FUNCTION "public"."record_deal_stage_event"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    insert into deal_stage_events (opportunity_id, stage, entered_at)
    values (new.id, new.stage, new.stage_entered_at);
  end if;
  return new;
end;
$$;

-- A Contact cannot stay Waiting/Invited once a same-offer sale has really
-- started. "Really started" means stage application_received or later, NOT
-- merely an active Opportunity: §4b Phase 2 creates an Interested
-- Opportunity the moment an invitation is delivered, and the older rule
-- would have converted everybody the instant that happened (migration
-- 20261012100000). Invited means invited and not yet progressed
-- (mirrors src/components/atomic-crm/waitlist/waitlistSync.ts exactly —
-- keep both in sync). "Active" = not archived and no exit outcome
-- (needs_higher_care/not_fit/nurture/lost); Won counts as active here too,
-- since it is certainly not "still waiting". Compatible = same Contact +
-- Offer, and either the Waitlist Entry is cohort-specific and matches this
-- Deal's own cohort exactly, or it is offer-level (cohort_id null — "I
-- want this generally") and therefore satisfied by ANY cohort of that
-- Offer. Runs AFTER (like handle_deal_won()) so it only fires once the
-- deals row is committed.
CREATE OR REPLACE FUNCTION "public"."handle_deal_waitlist_sync"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $
begin
  -- A place is spent when the SALE really starts. Stage says whether it has.
  --
  -- The stages listed are every stage at or past application_received,
  -- enumerated rather than ordered, so a stage added later converts nobody
  -- until somebody decides it should. 'won' belongs here because a won sale
  -- carries no outcome and certainly is not still waiting; legacy
  -- 'onboarding' is far past a review and belongs for the same reason.
  if new.archived_at is null
     and new.outcome is null
     and new.stage in (
       'application_received', 'approved', 'call_booked', 'decision',
       'won', 'onboarding'
     )
  then
    update waitlist_entries
    set status = 'converted',
        converted_at = now(),
        converted_opportunity_id = new.id
    where contact_id = new.contact_id
      and offer_id = new.offer_id
      and status in ('waiting', 'invited')
      and (cohort_id is null or cohort_id = new.cohort_id);
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  sales_count int;
begin
  select count(id) into sales_count
  from public.sales;

  insert into public.sales (first_name, last_name, email, user_id, administrator)
  values (
    coalesce(new.raw_user_meta_data ->> 'first_name', new.raw_user_meta_data -> 'custom_claims' ->> 'first_name', 'Pending'),
    coalesce(new.raw_user_meta_data ->> 'last_name', new.raw_user_meta_data -> 'custom_claims' ->> 'last_name', 'Pending'),
    new.email,
    new.id,
    case when sales_count > 0 then FALSE else TRUE end
  );
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."handle_update_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  update public.sales
  set
    first_name = coalesce(new.raw_user_meta_data ->> 'first_name', new.raw_user_meta_data -> 'custom_claims' ->> 'first_name', 'Pending'),
    last_name = coalesce(new.raw_user_meta_data ->> 'last_name', new.raw_user_meta_data -> 'custom_claims' ->> 'last_name', 'Pending'),
    email = new.email
  where user_id = new.id;

  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  return exists (
    select 1 from public.sales where user_id = auth.uid() and administrator = true
  );
end;
$$;

CREATE OR REPLACE FUNCTION "public"."merge_contacts"("loser_id" bigint, "winner_id" bigint) RETURNS bigint
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  winner_contact contacts%ROWTYPE;
  loser_contact contacts%ROWTYPE;
  merged_emails jsonb;
  merged_phones jsonb;
  merged_tags bigint[];
  winner_emails jsonb;
  loser_emails jsonb;
  winner_phones jsonb;
  loser_phones jsonb;
  email_map jsonb;
  phone_map jsonb;
BEGIN
  -- Fetch both contacts
  SELECT * INTO winner_contact FROM contacts WHERE id = winner_id;
  SELECT * INTO loser_contact FROM contacts WHERE id = loser_id;

  IF winner_contact IS NULL OR loser_contact IS NULL THEN
    RAISE EXCEPTION 'Contact not found';
  END IF;

  -- 1. Reassign tasks from loser to winner
  UPDATE tasks SET contact_id = winner_id WHERE contact_id = loser_id;

  -- 2. Reassign contact notes from loser to winner
  UPDATE contact_notes SET contact_id = winner_id WHERE contact_id = loser_id;

  -- 3. Reassign opportunities from loser to winner (single contact_id FK)
  UPDATE deals SET contact_id = winner_id WHERE contact_id = loser_id;

  -- 4. Merge contact data

  -- Get email arrays
  winner_emails := COALESCE(winner_contact.email_jsonb, '[]'::jsonb);
  loser_emails := COALESCE(loser_contact.email_jsonb, '[]'::jsonb);

  -- Merge emails with deduplication by email address
  -- Build a map of email -> email object, then convert back to array
  email_map := '{}'::jsonb;

  -- Add winner emails to map
  IF jsonb_array_length(winner_emails) > 0 THEN
    FOR i IN 0..jsonb_array_length(winner_emails)-1 LOOP
      email_map := email_map || jsonb_build_object(
        winner_emails->i->>'email',
        winner_emails->i
      );
    END LOOP;
  END IF;

  -- Add loser emails to map (won't overwrite existing keys)
  IF jsonb_array_length(loser_emails) > 0 THEN
    FOR i IN 0..jsonb_array_length(loser_emails)-1 LOOP
      IF NOT email_map ? (loser_emails->i->>'email') THEN
        email_map := email_map || jsonb_build_object(
          loser_emails->i->>'email',
          loser_emails->i
        );
      END IF;
    END LOOP;
  END IF;

  -- Convert map back to array
  merged_emails := (SELECT jsonb_agg(value) FROM jsonb_each(email_map));
  merged_emails := COALESCE(merged_emails, '[]'::jsonb);

  -- Get phone arrays
  winner_phones := COALESCE(winner_contact.phone_jsonb, '[]'::jsonb);
  loser_phones := COALESCE(loser_contact.phone_jsonb, '[]'::jsonb);

  -- Merge phones with deduplication by number
  phone_map := '{}'::jsonb;

  -- Add winner phones to map
  IF jsonb_array_length(winner_phones) > 0 THEN
    FOR i IN 0..jsonb_array_length(winner_phones)-1 LOOP
      phone_map := phone_map || jsonb_build_object(
        winner_phones->i->>'number',
        winner_phones->i
      );
    END LOOP;
  END IF;

  -- Add loser phones to map (won't overwrite existing keys)
  IF jsonb_array_length(loser_phones) > 0 THEN
    FOR i IN 0..jsonb_array_length(loser_phones)-1 LOOP
      IF NOT phone_map ? (loser_phones->i->>'number') THEN
        phone_map := phone_map || jsonb_build_object(
          loser_phones->i->>'number',
          loser_phones->i
        );
      END IF;
    END LOOP;
  END IF;

  -- Convert map back to array
  merged_phones := (SELECT jsonb_agg(value) FROM jsonb_each(phone_map));
  merged_phones := COALESCE(merged_phones, '[]'::jsonb);

  -- Merge tags (remove duplicates)
  merged_tags := ARRAY(
    SELECT DISTINCT unnest(
      COALESCE(winner_contact.tags, ARRAY[]::bigint[]) ||
      COALESCE(loser_contact.tags, ARRAY[]::bigint[])
    )
  );

  -- 5. Update winner with merged data
  UPDATE contacts SET
    avatar = COALESCE(winner_contact.avatar, loser_contact.avatar),
    gender = COALESCE(winner_contact.gender, loser_contact.gender),
    first_name = COALESCE(winner_contact.first_name, loser_contact.first_name),
    last_name = COALESCE(winner_contact.last_name, loser_contact.last_name),
    title = COALESCE(winner_contact.title, loser_contact.title),
    company_id = COALESCE(winner_contact.company_id, loser_contact.company_id),
    email_jsonb = merged_emails,
    phone_jsonb = merged_phones,
    linkedin_url = COALESCE(winner_contact.linkedin_url, loser_contact.linkedin_url),
    background = COALESCE(winner_contact.background, loser_contact.background),
    has_newsletter = COALESCE(winner_contact.has_newsletter, loser_contact.has_newsletter),
    first_seen = LEAST(COALESCE(winner_contact.first_seen, loser_contact.first_seen), COALESCE(loser_contact.first_seen, winner_contact.first_seen)),
    last_seen = GREATEST(COALESCE(winner_contact.last_seen, loser_contact.last_seen), COALESCE(loser_contact.last_seen, winner_contact.last_seen)),
    sales_id = COALESCE(winner_contact.sales_id, loser_contact.sales_id),
    tags = merged_tags
  WHERE id = winner_id;

  -- 6. Delete loser contact
  DELETE FROM contacts WHERE id = loser_id;

  RETURN winner_id;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."lowercase_email_jsonb"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.email_jsonb IS NOT NULL THEN
    NEW.email_jsonb = COALESCE((
      SELECT jsonb_agg(
        jsonb_set(elem, '{email}', to_jsonb(LOWER(elem->>'email')))
      )
      FROM jsonb_array_elements(NEW.email_jsonb) AS elem
    ), '[]'::jsonb);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."set_sales_id_default"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.sales_id IS NULL THEN
    SELECT id INTO NEW.sales_id FROM sales WHERE user_id = auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

-- Application Intake Atomicity + Idempotency slice: the single
-- server-authoritative transactional operation for the public application
-- intake path (mirrors, and is called by, supabase/functions/
-- public_application/index.ts's handleSubmit — see that file's header for
-- the caller-side validation it still does BEFORE calling this: honeypot,
-- name/email/answer-length checks, and full offer/cohort existence + open-
-- window validation, none of which needs to be inside this transaction
-- since a rejection there means zero calls into this function at all).
--
-- Root-cause fix for the known intake gap: the previous implementation
-- issued Contact -> Deal -> (Waitlist sync) -> Application -> Task as
-- separate PostgREST round-trips with no shared transaction. A failure
-- between any two steps left durable partial state (e.g. a bare Contact,
-- or worse: an Application with no Review Task that NO retry could ever
-- fix, because the exact-answers-match fast path above short-circuits
-- before ever re-attempting Task creation). Wrapping the whole sequence in
-- one PL/pgSQL function call gives it Postgres's own transaction boundary
-- for free: any exception anywhere below rolls back every write this
-- function made, so the only two possible outcomes are "fully applied" or
-- "nothing happened" — never a partial result a retry can't repair.
--
-- Idempotency key: deliberately the request's own natural business key
-- (normalized email, offer_id, cohort_id) plus a value-equality check on
-- the answers themselves — not a generated/random idempotency token. A
-- token tied to one browser/session would fail to recognize a genuine
-- resubmission from a different device as the same logical application;
-- the natural key already does, and is exactly what findActiveDeal /
-- findPendingApplication / answersEqual already used before this change.
--
-- Concurrency: an advisory transaction lock keyed by the normalized email
-- serializes two near-simultaneous submissions for the same applicant
-- (there is no unique constraint on an email inside contacts.email_jsonb
-- to lean on instead — introducing one is a larger, separate schema change
-- this slice deliberately does not force). Released automatically at
-- transaction end; never held past this call.
--
-- Security: SECURITY INVOKER (not DEFINER) — this function is reachable
-- ONLY via service_role (see 06_grants.sql: EXECUTE is revoked from
-- anon/authenticated entirely, tighter than every other callable function
-- in this file, merge_contacts included). service_role already bypasses
-- RLS on its own; DEFINER semantics would only add unneeded owner-
-- privilege elevation. The public HTTP surface remains exactly
-- public_application/index.ts — this function is not a new public
-- capability, it's the existing one made atomic.
CREATE OR REPLACE FUNCTION public.submit_public_application(p_offer_id bigint, p_cohort_id bigint, p_first_name text, p_last_name text, p_email text, p_phone text, p_answers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(trim(p_email));
  v_contact contacts%ROWTYPE;
  v_is_dne boolean;
  v_deal deals%ROWTYPE;
  v_deal_reused boolean := false;
  v_pending_app applications%ROWTYPE;
  v_answers_match boolean := false;
  v_application_id bigint;
  v_existing_application_id bigint;
  v_sales_id bigint;
  v_has_pending_task boolean;
  v_applicant_name text;
BEGIN
  IF p_offer_id IS NULL THEN
    RAISE EXCEPTION 'offer_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(trim(p_first_name), '') = '' OR coalesce(trim(p_last_name), '') = '' THEN
    RAISE EXCEPTION 'name_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_email = '' THEN
    RAISE EXCEPTION 'email_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM offers WHERE id = p_offer_id AND is_active) THEN
    RAISE EXCEPTION 'offer_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_cohort_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cohorts WHERE id = p_cohort_id AND offer_id = p_offer_id
  ) THEN
    RAISE EXCEPTION 'cohort_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('submit_public_application:' || v_email));

  SELECT * INTO v_contact
  FROM contacts c
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(c.email_jsonb, '[]'::jsonb)) AS e
    WHERE lower(trim(e ->> 'email')) = v_email
  )
  ORDER BY c.id ASC
  LIMIT 1;

  v_is_dne := v_contact.id IS NOT NULL AND v_contact.sales_eligibility = 'do_not_engage';

  IF v_contact.id IS NOT NULL AND NOT v_is_dne THEN
    SELECT * INTO v_deal
    FROM deals d
    WHERE d.contact_id = v_contact.id
      AND d.offer_id = p_offer_id
      AND (p_cohort_id IS NULL OR d.cohort_id = p_cohort_id)
      AND d.archived_at IS NULL
      AND d.stage <> 'won'
      AND d.outcome IS NULL
    ORDER BY d.id ASC
    LIMIT 1;
  END IF;

  IF v_deal.id IS NOT NULL THEN
    SELECT * INTO v_pending_app
    FROM applications a
    WHERE a.opportunity_id = v_deal.id
    ORDER BY a.id DESC
    LIMIT 1;
    IF v_pending_app.id IS NOT NULL AND v_pending_app.status <> 'pending' THEN
      v_pending_app := NULL;
    END IF;
  END IF;

  IF v_pending_app.id IS NOT NULL THEN
    v_answers_match := p_answers = v_pending_app.raw_answers;
  END IF;

  IF v_contact.id IS NOT NULL AND NOT v_is_dne THEN
    SELECT EXISTS (
      SELECT 1 FROM tasks
      WHERE contact_id = v_contact.id
        AND type = 'review_application'
        AND done_date IS NULL
    ) INTO v_has_pending_task;
  END IF;

  IF v_pending_app.id IS NOT NULL AND v_answers_match AND coalesce(v_has_pending_task, false) THEN
    RETURN jsonb_build_object(
      'status', 'submitted',
      'application_id', v_pending_app.id,
      'dne_auto_resolved', false
    );
  END IF;

  IF v_contact.id IS NOT NULL THEN
    UPDATE contacts SET last_seen = now() WHERE id = v_contact.id RETURNING * INTO v_contact;
  ELSE
    INSERT INTO contacts (
      first_name, last_name, email_jsonb, phone_jsonb, tags,
      has_newsletter, first_seen, last_seen, sales_eligibility
    ) VALUES (
      p_first_name, p_last_name,
      jsonb_build_array(jsonb_build_object('email', p_email, 'type', 'Other')),
      CASE WHEN coalesce(p_phone, '') <> ''
        THEN jsonb_build_array(jsonb_build_object('number', p_phone, 'type', 'Other'))
        ELSE '[]'::jsonb
      END,
      ARRAY[]::bigint[],
      false, now(), now(), 'normal'
    ) RETURNING * INTO v_contact;
  END IF;

  IF v_deal.id IS NULL THEN
    INSERT INTO deals (
      contact_id, offer_id, cohort_id, stage, outcome, owner_decision,
      amount, entry_path, description
    ) VALUES (
      v_contact.id, p_offer_id, p_cohort_id, 'application_received',
      CASE WHEN v_is_dne THEN 'lost' ELSE NULL END,
      CASE WHEN v_is_dne THEN 'do_not_engage' ELSE NULL END,
      (SELECT current_price FROM offers WHERE id = p_offer_id),
      'application_form', ''
    ) RETURNING * INTO v_deal;
  ELSE
    v_deal_reused := true;
    IF NOT v_is_dne THEN
      UPDATE waitlist_entries
      SET status = 'converted', converted_at = now(), converted_opportunity_id = v_deal.id
      WHERE contact_id = v_deal.contact_id
        AND offer_id = v_deal.offer_id
        AND status IN ('waiting', 'invited')
        AND (cohort_id IS NULL OR cohort_id = v_deal.cohort_id);
    END IF;
  END IF;

  IF v_pending_app.id IS NOT NULL THEN
    UPDATE applications
    SET raw_answers = p_answers, submitted_at = now()
    WHERE id = v_pending_app.id
    RETURNING id INTO v_application_id;
  ELSE
    SELECT a.id INTO v_existing_application_id
    FROM applications a
    WHERE a.opportunity_id = v_deal.id
    ORDER BY a.id DESC
    LIMIT 1;

    IF v_existing_application_id IS NOT NULL THEN
      v_application_id := v_existing_application_id;
    ELSE
      -- Phase 4J: offer_id/intended_cohort_id stamped directly from the
      -- already-validated parameters, never re-derived from v_deal.
      -- Phase 4J: offer_id/intended_cohort_id stamped directly from the
      -- already-validated parameters, never re-derived from v_deal.
      -- Gate A final candidate: contact_id is the Application's canonical
      -- person relationship (the Deal remains the optional Opportunity
      -- relationship), and source marks this as a live submission that
      -- legitimately represents outstanding review work.
      INSERT INTO applications (contact_id, opportunity_id, offer_id, intended_cohort_id, raw_answers, submitted_at, status, reviewed_at, source)
      VALUES (
        v_contact.id, v_deal.id, p_offer_id, p_cohort_id, p_answers, now(),
        CASE WHEN v_is_dne THEN 'do_not_engage' ELSE 'pending' END,
        CASE WHEN v_is_dne THEN now() ELSE NULL END,
        'public_form'
      ) RETURNING id INTO v_application_id;
    END IF;
  END IF;

  IF NOT v_is_dne THEN
    SELECT EXISTS (
      SELECT 1 FROM tasks
      WHERE contact_id = v_contact.id
        AND type = 'review_application'
        AND done_date IS NULL
    ) INTO v_has_pending_task;

    IF FALSE THEN  -- review Tasks are now created only on SLA breach, by reconcile_application_review_tasks()
      SELECT id INTO v_sales_id FROM sales WHERE administrator = true LIMIT 1;
      v_applicant_name := trim(both ' ' from coalesce(v_contact.first_name, '') || ' ' || coalesce(v_contact.last_name, ''));
      INSERT INTO tasks (contact_id, type, text, due_date, status, sales_id)
      VALUES (
        v_contact.id, 'review_application',
        'Review ' || v_applicant_name || '''s application',
        now(), 'pending', v_sales_id
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', 'submitted',
    'application_id', v_application_id,
    'dne_auto_resolved', v_is_dne
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.record_sales_call_cancelled(p_sales_call_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_call sales_calls%ROWTYPE;
  v_now timestamptz := now();
  v_tasks_closed int := 0;
begin
  select * into v_call from sales_calls where id = p_sales_call_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- Never overwrite a call that genuinely happened. Someone attended it;
  -- cancelling it afterwards would erase that.
  if v_call.attendance = 'attended' then
    return jsonb_build_object('status', 'already-attended');
  end if;

  -- 1. The Sales Call is the canonical record of the cancellation.
  --    original_scheduled_at is untouched — when it WAS going to happen is
  --    part of the history. attendance stays exactly as it is: null for a
  --    call that was cancelled before it was due, and a previously recorded
  --    no_show is never rewritten by a later cancellation of a DIFFERENT
  --    call (each call is its own record).
  --    status leaves 'booked', which also frees
  --    sales_calls_one_booked_per_opportunity_idx for a genuine rebooking.
  if v_call.status <> 'cancelled' then
    update sales_calls
       set status = 'cancelled',
           cancelled_at = coalesce(v_call.cancelled_at, v_now),
           updated_at = v_now
     where id = v_call.id;

    insert into sales_call_events (sales_call_id, kind, occurred_at)
    values (v_call.id, 'cancelled', v_now);
  end if;

  -- 2. A task telling Leif to deal with this specific call is no longer
  --    real work. Cancelled rather than completed — nobody did it — using
  --    the status vocabulary tasks already has. done_date is deliberately
  --    left alone: a cancelled task was never done.
  update tasks
     set status = 'cancelled', done_date = v_now
   where sales_call_id = v_call.id
     and status in ('pending', 'waiting');
  get diagnostics v_tasks_closed = row_count;

  -- 3. The Opportunity is NOT touched. The sale reached wherever it
  --    reached; a cancelled meeting is not a reason to say it reached less.
  --    Leif decides what happens next, and until he does the Opportunity
  --    stays exactly where it is with the cancellation visible on it.

  return jsonb_build_object(
    'status', case when v_call.status = 'cancelled' then 'already-cancelled' else 'cancelled' end,
    'sales_call_id', v_call.id,
    'opportunity_id', v_call.opportunity_id,
    'opportunity_stage_unchanged', true,
    'tasks_closed', v_tasks_closed,
    -- Reported so a caller can be explicit that nothing was decided about
    -- pursuing this person.
    'outcome_left_undecided', true
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_sales_call_no_show(p_sales_call_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_call sales_calls%rowtype;
  v_now timestamptz := now();
  v_already_no_show boolean;
  v_tag_id bigint;
begin
  select * into v_call from sales_calls where id = p_sales_call_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;
  if v_call.opportunity_id is null then
    return jsonb_build_object('status', 'no-opportunity');
  end if;
  if v_call.attendance = 'attended' then
    -- Never silently overwrite a recorded attended outcome.
    return jsonb_build_object('status', 'already-completed');
  end if;

  v_already_no_show := v_call.attendance is not distinct from 'no_show';

  -- 1. The Sales Call is the CANONICAL historical record of the no-show.
  if not v_already_no_show then
    update sales_calls
       set attendance = 'no_show',
           attendance_recorded_at = v_now,
           status = 'completed',
           updated_at = v_now
     where id = v_call.id;

    insert into sales_call_events (sales_call_id, kind, occurred_at, attendance)
    values (v_call.id, 'attendance_recorded', v_now, 'no_show');
  elsif v_call.status is distinct from 'completed' then
    -- Recorded as a no-show before concluded calls had to leave 'booked'.
    -- Converge the status without inventing a second attendance timestamp
    -- or a duplicate history event.
    update sales_calls set status = 'completed', updated_at = v_now
     where id = v_call.id;
  end if;

  -- 2. The Opportunity is NOT touched — see record_sales_call_cancelled().
  --    They did not turn up. That is a fact about the meeting, not a
  --    demotion of the sale.

  -- 3. The Contact carries a durable, visible No-show tag — a SUMMARY for
  --    at-a-glance history, never the source of truth, attached once.
  select id into v_tag_id from tags where lower(name) = 'no-show' limit 1;
  if v_tag_id is null then
    insert into tags (name, color) values ('No-show', '#fde2e4')
    returning id into v_tag_id;
  end if;

  update contacts
     set tags = coalesce(tags, '{}'::bigint[]) || v_tag_id
   where id = v_call.contact_id
     and not (coalesce(tags, '{}'::bigint[]) @> array[v_tag_id]);

  -- 4. The call concluded, so its own task is done. No follow-up task is
  --    invented: the open question is derived, and a task duplicating it
  --    could be deleted while the question remained.
  --    Every open task about THIS call, whatever its type — including the
  -- resolve_sales_call question this no-show has just answered. Scoped by
  -- the call, never by the Contact: a returning applicant can have an
  -- open question about a different call that this one says nothing about.
  perform public.close_tasks_for_sales_call(v_call.id, v_now);

  -- Legacy rows from before tasks carried sales_call_id. Still scoped to
  -- the superseded types only, so nothing else of this Contact's is swept up.
  update tasks
     set done_date = v_now, status = 'completed'
   where contact_id = v_call.contact_id
     and sales_call_id is null
     and type in ('sales_call', 'sales_call_no_show')
     and done_date is null;

  return jsonb_build_object(
    'status', case when v_already_no_show then 'already-no-show' else 'completed' end,
    'opportunity_stage_unchanged', true
  );
end;
$function$
;

revoke all on function public.record_sales_call_no_show(bigint) from public;
grant execute on function public.record_sales_call_no_show(bigint) to authenticated;
grant execute on function public.record_sales_call_no_show(bigint) to service_role;


-- =====================================================================
-- Declarative-schema reconciliation, 2026-09-18
-- =====================================================================
-- Functions that migrations added.
--
-- Everything below was extracted from the live database with the
-- server's own catalog functions rather than written by hand, because a
-- hand-copied function body differs from pg_dump's normalised form in
-- whitespace alone and produces a permanent phantom diff.
--
-- These objects were created by migrations and exist on MAIN; they were
-- simply never mirrored here. Migrations, MAIN and this file now
-- describe the same database.

CREATE OR REPLACE FUNCTION public.acuity_type_period_no_overlap()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_conflict text;
begin
  select coalesce(m.label, m.id::text) into v_conflict
    from acuity_appointment_type_map m
   where m.acuity_appointment_type_id = new.acuity_appointment_type_id
     and m.id <> coalesce(new.id, -1)
     -- Two half-open periods [a,b) and [c,d) overlap iff a < d and c < b,
     -- with NULL upper bounds read as infinity.
     and new.valid_from < coalesce(m.valid_to, 'infinity'::date)
     and m.valid_from < coalesce(new.valid_to, 'infinity'::date)
   limit 1;

  if v_conflict is not null then
    raise exception 'acuity appointment type % already has a mapping covering that period (%)',
      new.acuity_appointment_type_id, v_conflict;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.clamp_contact_last_seen()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_occurred timestamptz;
begin
  if new.last_seen is not null and new.last_seen > now() then
    -- On INSERT there is no prior row; TG_OP tells us which fallback is
    -- honest. Either way, now() is never the answer.
    v_occurred := contact_last_occurred_activity(new.id);
    if v_occurred is not null then
      new.last_seen := v_occurred;
    elsif tg_op = 'UPDATE' then
      new.last_seen := old.last_seen;
    else
      new.last_seen := null;
    end if;
  end if;

  if new.first_seen is not null and new.last_seen is not null
     and new.last_seen < new.first_seen then
    new.last_seen := new.first_seen;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.close_tasks_for_sales_call(p_sales_call_id bigint, p_completed_at timestamp with time zone)
 RETURNS bigint
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  with closed as (
    update tasks
       set done_date = p_completed_at, status = 'completed'
     where sales_call_id = p_sales_call_id
       and done_date is null
       and status in ('pending', 'waiting')
    returning 1
  )
  select count(*) from closed;
$function$
;

CREATE OR REPLACE FUNCTION public.complete_sales_call_matching_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  -- Only the NULL -> attached transition answers the question. An
  -- already-attached call being re-saved changes nothing, and a call that
  -- is still unmatched must keep its task.
  if old.opportunity_id is not null or new.opportunity_id is null then
    return new;
  end if;

  update tasks
     set done_date = coalesce(done_date, now()),
         status    = 'completed'
   where sales_call_id = new.id
     and type = 'sales_call_needs_matching'
     and done_date is null;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.contact_first_occurred_evidence(p_contact_id bigint)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select min(at) from (
    select a.submitted_at as at from applications a where a.contact_id = p_contact_id and a.submitted_at <= now()
    union all
    select coalesce(sc.scheduled_at, (sc.scheduled_on + time '12:00') at time zone 'UTC')
      from sales_calls sc where sc.contact_id = p_contact_id
    union all
    select cs.scheduled_at from client_sessions cs where cs.contact_id = p_contact_id
    union all
    select d.created_at from deals d where d.contact_id = p_contact_id
    union all
    select w.joined_at from waitlist_entries w where w.contact_id = p_contact_id
    union all
    -- The same doorway, read from the other end.
    select i.first_seen_at from contact_external_identities i
     where i.contact_id = p_contact_id and i.first_seen_at <= now()
  ) evidence;
$function$
;

CREATE OR REPLACE FUNCTION public.contact_last_occurred_activity(p_contact_id bigint)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select max(at) from (
    select a.submitted_at as at from applications a where a.contact_id = p_contact_id and a.submitted_at <= now()
    union all
    select a.reviewed_at from applications a where a.contact_id = p_contact_id and a.reviewed_at <= now()
    union all
    -- A sales call counts once its own time has passed. A date-only
    -- historical call is read at the end of its day: the earliest moment
    -- the whole day is certainly behind us, inventing no clock time.
    select coalesce(sc.scheduled_at, (sc.scheduled_on + time '23:59') at time zone 'UTC')
      from sales_calls sc
     where sc.contact_id = p_contact_id
       and coalesce(sc.scheduled_at, (sc.scheduled_on + time '23:59') at time zone 'UTC') <= now()
    union all
    select sc.cancelled_at from sales_calls sc where sc.contact_id = p_contact_id and sc.cancelled_at <= now()
    union all
    select sc.attendance_recorded_at from sales_calls sc where sc.contact_id = p_contact_id and sc.attendance_recorded_at <= now()
    union all
    select e.occurred_at from sales_call_events e join sales_calls sc on sc.id = e.sales_call_id
     where sc.contact_id = p_contact_id and e.occurred_at <= now()
    union all
    select cs.scheduled_at from client_sessions cs where cs.contact_id = p_contact_id and cs.scheduled_at <= now()
    union all
    select cs.cancelled_at from client_sessions cs where cs.contact_id = p_contact_id and cs.cancelled_at <= now()
    union all
    select cs.no_show_at from client_sessions cs where cs.contact_id = p_contact_id and cs.no_show_at <= now()
    union all
    select d.created_at from deals d where d.contact_id = p_contact_id and d.created_at <= now()
    union all
    select se.entered_at from deal_stage_events se join deals d on d.id = se.opportunity_id
     where d.contact_id = p_contact_id and se.entered_at <= now()
    union all
    select w.joined_at from waitlist_entries w where w.contact_id = p_contact_id and w.joined_at <= now()
    union all
    select n.date from contact_notes n where n.contact_id = p_contact_id and n.date <= now()
    union all
    select n.date from deal_notes n join deals d on d.id = n.deal_id
     where d.contact_id = p_contact_id and n.date <= now()
    union all
    -- The doorway. Any provider that records an observation through
    -- record_external_identity() contributes here, and nowhere else.
    select i.last_seen_at from contact_external_identities i
     where i.contact_id = p_contact_id and i.last_seen_at <= now()
  ) occurred;
$function$
;

CREATE OR REPLACE FUNCTION public.derive_sales_call_scheduled_on()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  -- An exact call knows its instant, so the day comes from it. Written
  -- unconditionally rather than only when null: a reschedule moves the
  -- instant, and a date left behind pointing at the old day would be a
  -- quieter bug than the one this replaces.
  if new.schedule_precision = 'exact' and new.scheduled_at is not null then
    new.scheduled_on := (new.scheduled_at at time zone 'America/Denver')::date;
  end if;
  -- A date-only call has no instant to project; its scheduled_on is the
  -- fact itself and is left exactly as supplied.
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.deal_is_active(p_archived_at timestamp with time zone, p_stage text, p_outcome text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select p_archived_at is null
     and p_stage is distinct from 'won'
     and p_outcome is null;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_persisted_onboarding_stage()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.stage = 'onboarding'
     and (tg_op = 'INSERT' or old.stage is distinct from 'onboarding') then
    raise exception
      'stage "onboarding" is legacy storage and cannot be written. A sale that succeeded is stage = won; the Onboarding column is derived from Won plus an Enrollment plus unfinished setup.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_deal_outcome_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_source text := coalesce(
    nullif(current_setting('app.outcome_event_source', true), ''), 'app');
  v_note text := nullif(current_setting('app.outcome_event_note', true), '');
begin
  if tg_op = 'INSERT' then
    if new.outcome is not null then
      insert into public.deal_outcome_events
        (opportunity_id, old_outcome, new_outcome, exit_reason, occurred_at, source, note)
      values (new.id, null, new.outcome, new.exit_reason, now(), v_source, v_note);
    end if;
  elsif new.outcome is distinct from old.outcome
     or (new.outcome is not null and new.exit_reason is distinct from old.exit_reason) then
    insert into public.deal_outcome_events
      (opportunity_id, old_outcome, new_outcome, exit_reason, occurred_at, source, note)
    values (new.id, old.outcome, new.outcome, new.exit_reason, now(), v_source, v_note);
  end if;
  return new;
end;
$function$
;

-- deal_outcome_events grants no role INSERT: an exit is recorded as a
-- consequence of a Deal changing, never by a client asserting one. That is
-- why the trigger is SECURITY DEFINER, and why nothing needs EXECUTE on it.
-- service_role is named here too, which the original revoke
-- (20260919180000) did not do. MAIN has held this function at
-- postgres-only all along; the chain only caught up in 20261015120000.
-- Its sole caller is the trigger on_deal_outcome_changed, and PostgreSQL
-- does not check EXECUTE on a trigger function when a trigger fires it.
revoke all on function public.record_deal_outcome_event()
  from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_sales_call_reinstated(p_sales_call_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_call sales_calls%ROWTYPE;
  v_now timestamptz := now();
  v_deal_advanced boolean := false;
begin
  select * into v_call from sales_calls where id = p_sales_call_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- Never re-open something that actually concluded. If a human recorded
  -- attendance, that is the truth about this call and a live upstream
  -- booking cannot overwrite it.
  if v_call.attendance is not null then
    return jsonb_build_object('status', 'already-concluded');
  end if;

  -- Only a future call can be "still booked". A past cancelled call is
  -- history, and this is exactly where Aurelie must be left alone.
  if coalesce(v_call.scheduled_at, (v_call.scheduled_on + time '23:59') at time zone 'UTC') <= v_now then
    return jsonb_build_object('status', 'in-the-past');
  end if;

  if v_call.status = 'booked' then
    return jsonb_build_object('status', 'already-booked');
  end if;

  update sales_calls
     set status = 'booked',
         cancelled_at = null,
         updated_at = v_now
   where id = v_call.id;

  insert into sales_call_events (sales_call_id, kind, occurred_at, new_scheduled_at)
  values (v_call.id, 'booked', v_now, v_call.scheduled_at);

  -- The Opportunity returns to Call Booked, but only from Approved and
  -- only while still active — the exact inverse of the cancellation path,
  -- and never dragging a Deal backwards from Decision or further on.
  if v_call.opportunity_id is not null then
    update deals
       set stage = 'call_booked',
           stage_entered_at = v_now,
           updated_at = v_now
     where id = v_call.opportunity_id
       and stage = 'approved'
       and outcome is null
       and archived_at is null;
    v_deal_advanced := found;
  end if;

  return jsonb_build_object(
    'status', 'reinstated',
    'sales_call_id', v_call.id,
    'opportunity_id', v_call.opportunity_id,
    'deal_advanced_to_call_booked', v_deal_advanced
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_contact_last_activity()
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_updated bigint;
begin
  update contacts c
     set last_seen = contact_last_occurred_activity(c.id)
   where contact_last_occurred_activity(c.id) is not null
     and c.last_seen is distinct from contact_last_occurred_activity(c.id);
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_completed_future_session()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- now() is not immutable, so this cannot be a CHECK constraint.
  if new.status = 'completed' and new.scheduled_at > now() then
    raise exception
      'client session % is scheduled at % and cannot be completed before it happens',
      new.id, new.scheduled_at;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_completion_with_sessions_remaining()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_remaining int;
begin
  if new.status <> 'completed' then
    return new;
  end if;

  select count(*) into v_remaining
  from public.client_sessions s
  where s.enrollment_id = new.id
    and s.status <> 'cancelled'
    and s.no_show_at is null
    and s.scheduled_at > now();

  if v_remaining > 0 then
    raise exception
      'enrollment % still has % session(s) scheduled and cannot be completed',
      new.id, v_remaining;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.resolve_acuity_appointment_type(p_appointment_type_id text, p_on date)
 RETURNS TABLE(offer_id bigint, offer_name text, kind text, cohort_id bigint, label text, resolution text, valid_from date, valid_to date)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select m.offer_id, o.name, m.kind, m.cohort_id, m.label, m.resolution,
         m.valid_from, m.valid_to
    from acuity_appointment_type_map m
    left join offers o on o.id = m.offer_id
   where m.acuity_appointment_type_id = p_appointment_type_id
     and p_on >= m.valid_from
     and (m.valid_to is null or p_on < m.valid_to)
   limit 1;
$function$
;

CREATE OR REPLACE FUNCTION "public"."seed_enrollment_onboarding"("p_enrollment_id" bigint, "p_due_at" timestamp with time zone DEFAULT ("now"() + '3 days'::interval)) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deal deals%rowtype;
  v_contact_name text;
  v_item record;
  v_seeded int := 0;
begin
  select d.* into v_deal
    from deals d
    join enrollments e on e.opportunity_id = d.id
   where e.id = p_enrollment_id;
  if not found then
    raise exception 'enrollment % does not exist', p_enrollment_id;
  end if;

  select nullif(trim(both ' ' from coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
    into v_contact_name
    from contacts where id = v_deal.contact_id;
  v_contact_name := coalesce(v_contact_name, v_deal.name);

  for v_item in
    insert into enrollment_onboarding_items
      (enrollment_id, requirement_key, label, task_text_template, is_required, sort_order, source_offer_id)
    select p_enrollment_id, t.key, t.label, t.task_text_template, t.is_required, t.sort_order, v_deal.offer_id
      from onboarding_requirement_templates t
     where t.offer_id = v_deal.offer_id and t.is_active
    on conflict (enrollment_id, requirement_key) do nothing
    returning id, is_required
  loop
    v_seeded := v_seeded + 1;
    if v_item.is_required and not exists (
      select 1 from tasks where onboarding_item_id = v_item.id
    ) then
      insert into tasks (contact_id, type, text, due_date, status, enrollment_id, onboarding_item_id)
      select v_deal.contact_id, 'onboarding_item',
             replace(i.task_text_template, '{name}', v_contact_name),
             p_due_at, 'pending', p_enrollment_id, i.id
        from enrollment_onboarding_items i
       where i.id = v_item.id;
    end if;
  end loop;

  return v_seeded;
end;
$$;


CREATE OR REPLACE FUNCTION "public"."close_tasks_for_terminal_enrollment"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.status not in ('completed', 'withdrawn', 'ended')
     or old.status in ('completed', 'withdrawn', 'ended') then
    return new;
  end if;

  update tasks
     set done_date = now(), status = 'cancelled'
   where enrollment_id = new.id
     and done_date is null
     and type in ('onboarding_item', 'offboarding_item',
                  'resolve_client_session_cadence');

  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."close_tasks_for_terminal_opportunity"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if public.deal_is_active(new.archived_at, new.stage, new.outcome)
     or (tg_op = 'UPDATE'
         and not public.deal_is_active(old.archived_at, old.stage, old.outcome)) then
    return new;
  end if;

  update tasks
     set done_date = now(), status = 'cancelled'
   where opportunity_id = new.id
     and done_date is null
     -- Only the families whose premise was an ACTIVE sales attempt.
     -- 'other' is Leif's own note and is never closed by machinery.
     and type in ('sales_call', 'follow_up', 'nurture_follow_up',
                  'sales_call_cancelled', 'sales_call_no_show',
                  'review_application');

  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."sync_task_from_onboarding_item"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_enrollment enrollments%rowtype;
  v_deal deals%rowtype;
  v_contact_name text;
begin
  -- Withdrawn: its Task is withdrawn too, and stays that way.
  --
  -- done_date moves with it because tasks_completion_agreement_check reads it
  -- as "closed at", not "finished at": only pending and waiting Tasks may
  -- have none. Cancelling without it is refused by the database, which is how
  -- this was found.
  if new.status = 'retired' then
    update tasks
       set status = 'cancelled',
           done_date = coalesce(done_date, now())
     where onboarding_item_id = new.id and status <> 'completed';
    return new;
  end if;

  -- Item finished: close its open Task, if it still has one.
  if new.status = 'done' then
    update tasks
       set done_date = coalesce(done_date, coalesce(new.completed_at, now())),
           status = 'completed'
     where onboarding_item_id = new.id and done_date is null;
    return new;
  end if;

  -- Item is outstanding again (or still). One open Task, no more. A
  -- cancelled Task does not count as open: a requirement that comes back
  -- from retirement needs its request back.
  if exists (
    select 1 from tasks
     where onboarding_item_id = new.id
       and done_date is null
       and status <> 'cancelled'
  ) then
    return new;
  end if;

  select * into v_enrollment from enrollments where id = new.enrollment_id;
  if not found then
    return new;
  end if;
  -- A finished client has no outstanding setup work.
  if v_enrollment.status in ('completed', 'withdrawn', 'ended') then
    return new;
  end if;

  select * into v_deal from deals where id = v_enrollment.opportunity_id;

  -- Prefer reopening the Task that already exists over creating a second
  -- record of the same request.
  update tasks
     set done_date = null, status = 'pending'
   where id = (
     select id from tasks
      where onboarding_item_id = new.id
      order by done_date desc nulls first, id desc
      limit 1);
  if found then
    return new;
  end if;

  select nullif(trim(both ' ' from coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
    into v_contact_name from contacts where id = v_deal.contact_id;

  insert into tasks (contact_id, type, text, due_date, status, enrollment_id, onboarding_item_id)
  values (
    v_deal.contact_id,
    'onboarding_item',
    replace(new.task_text_template, '{name}', coalesce(v_contact_name, v_deal.name)),
    now() + interval '3 days',
    'pending',
    new.enrollment_id,
    new.id
  );

  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."enforce_application_opportunity_agreement"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_deal deals%rowtype;
begin
  if new.opportunity_id is null then
    return new;
  end if;

  select * into v_deal from deals where id = new.opportunity_id;
  if not found then
    raise exception 'Application % points at Opportunity %, which does not exist',
      coalesce(new.id::text, 'new'), new.opportunity_id;
  end if;

  if v_deal.contact_id is distinct from new.contact_id then
    raise exception 'Application % belongs to Contact % but Opportunity % belongs to Contact %',
      coalesce(new.id::text, 'new'), new.contact_id, v_deal.id, v_deal.contact_id;
  end if;

  if v_deal.offer_id is distinct from new.offer_id
     and not exists (
       select 1 from deal_offer_events ev
        where ev.opportunity_id = v_deal.id
          and ev.from_offer_id = new.offer_id
     )
  then
    raise exception 'Application % is for Offer % but Opportunity % is for Offer %; an application cannot belong to a sales attempt for a different programme',
      coalesce(new.id::text, 'new'), new.offer_id, v_deal.id, v_deal.offer_id
      using hint = 'If this client genuinely changed programmes, move them with transfer_enrolled_opportunity_offer() — that records the change and makes the original application legal history.';
  end if;

  return new;
end;
$$;

CREATE OR REPLACE FUNCTION public.materialize_application_responses(p_snapshot_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_snapshot historical_application_source_snapshots%rowtype;
  v_written int := 0;
  v_metadata constant text[] := array[
    'Full Name', 'Your name:', 'Email', 'Status', 'Submission time',
    'Call Booked', 'Notes', 'My notes', 'Respondent'
  ];
begin
  select * into v_snapshot
    from historical_application_source_snapshots where id = p_snapshot_id;
  if not found then
    raise exception 'snapshot % does not exist', p_snapshot_id;
  end if;

  if v_snapshot.application_id is null then
    raise exception 'snapshot % is not attached to an Application; copy artifacts and evidence-only rows must never produce responses', p_snapshot_id;
  end if;
  if v_snapshot.is_copy_artifact then
    raise exception 'snapshot % is a copy artifact', p_snapshot_id;
  end if;

  insert into application_responses
    (application_id, position, question_key, question_text,
     answer_text, answered, source_snapshot_id)
  select
    v_snapshot.application_id,
    row_number() over (order by c.ordinality)::smallint,
    null,
    c.value #>> '{}',
    nullif(btrim(coalesce(v.value #>> '{}', '')), ''),
    nullif(btrim(coalesce(v.value #>> '{}', '')), '') is not null,
    v_snapshot.id
  from jsonb_array_elements(v_snapshot.raw_snapshot->'columns')
         with ordinality c(value, ordinality)
  join jsonb_array_elements(v_snapshot.raw_snapshot->'values')
         with ordinality v(value, ordinality)
    on v.ordinality = c.ordinality
  where not ((c.value #>> '{}') = any (v_metadata))
  on conflict (application_id, position) do nothing;

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$
;

-- No client role may call this. It is reached only from the historical
-- backfill inside 20260919070000/20260919080000, which runs as the
-- migration role. MAIN has held it at postgres-only by hand since then;
-- 20261010210000 found the divergence and deliberately left production
-- alone "because nothing calls it", and 20261015120000 finally brought the
-- replay chain into line.
revoke all on function public.materialize_application_responses(bigint)
  from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.materialize_native_application_responses()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_version application_form_versions%rowtype;
begin
  -- Recovered history is materialised from its preserved snapshot
  -- instead, and carries no raw_answers at all.
  if new.raw_answers is null or new.raw_answers = '{}'::jsonb then
    return new;
  end if;

  select * into v_version from application_form_versions
   where offer_id = new.offer_id and is_current;
  if not found then
    -- No registered wording for this Offer. The Application still stands;
    -- it simply has no question text to store, which is honest and
    -- visible rather than a guess from a labels file.
    return new;
  end if;

  update applications
     set form_key = v_version.form_key, form_label = v_version.form_label
   where id = new.id;

  insert into application_responses
    (application_id, position, question_key, question_text, answer_text, answered)
  select new.id,
         q.position,
         q.question_key,
         q.question_text,
         nullif(btrim(coalesce(new.raw_answers ->> q.question_key, '')), ''),
         nullif(btrim(coalesce(new.raw_answers ->> q.question_key, '')), '') is not null
    from application_form_questions q
   where q.form_version_id = v_version.id
  on conflict (application_id, position) do nothing;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_application_response_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if current_setting('app.migration_mode', true) = 'true' then
    return coalesce(new, old);
  end if;
  raise exception 'application_responses is an immutable submission record; % is not allowed', tg_op
    using hint = 'Responses are written once by materialize_application_responses() or at submission time. Correcting one means re-materialising from its source snapshot.';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reconcile_application_review_tasks()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_created int := 0;
  v_closed int;
  v_sales_id bigint;
begin
  select id into v_sales_id from sales where administrator = true limit 1;

  -- Close escalations whose Application is no longer overdue review work:
  -- reviewed, its attempt moved on, or its attempt ended.
  update tasks t
     set done_date = now(), status = 'completed'
   where t.type = 'review_application'
     and t.done_date is null
     and not exists (
       select 1 from applications_awaiting_review r
        where r.application_id = t.application_id and r.is_overdue
     );
  get diagnostics v_closed = row_count;

  -- One escalation per overdue Application that has none. The partial
  -- unique index on (application_id) where done_date is null is what makes
  -- this safe to run as often as we like.
  insert into tasks (contact_id, type, text, due_date, status,
                     application_id, opportunity_id, sales_id)
  select r.contact_id,
         'review_application',
         format('Review %s''s application',
                nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '')),
         -- The day it SHOULD have been reviewed by, not the day it
         -- arrived. A due date in the past is now a true statement.
         (r.review_due_on::timestamp at time zone 'America/Denver'),
         'pending',
         r.application_id,
         r.opportunity_id,
         v_sales_id
    from applications_awaiting_review r
    join contacts c on c.id = r.contact_id
   where r.is_overdue
     and not exists (
       select 1 from tasks t
        where t.type = 'review_application'
          and t.done_date is null
          and t.application_id = r.application_id
     );
  get diagnostics v_created = row_count;

  return v_created + v_closed;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sales_call_open_question(p_opportunity_id bigint, p_dismissed_at timestamp with time zone, p_status text, p_attendance text, p_scheduled_at timestamp with time zone, p_scheduled_on date, p_resolution_requested_at timestamp with time zone, p_now timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    -- Explicitly not a sales situation: nothing to ask about it ever again.
    when p_dismissed_at is not null then 'none'
    -- Nobody knows whose booking this is. That outranks every other
    -- question, because the others are about a sales relationship this
    -- call has not yet been attributed to.
    when p_opportunity_id is null then 'matching'
    -- Cancelled is itself an answer to "what happened".
    when p_status = 'cancelled' then 'none'
    when p_attendance is not null then 'none'
    -- Never derived from "attendance is null" alone.
    when p_resolution_requested_at is null then 'none'
    -- A call that has not happened has no outcome to record. A date-only
    -- call counts as past once the whole DAY is over, never earlier — its
    -- clock time is genuinely unknown.
    when coalesce(p_scheduled_at,
                  (p_scheduled_on + time '23:59') at time zone 'America/Denver')
         >= p_now then 'none'
    else 'attendance'
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.reconcile_sales_call_tasks()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_refiled    int;
  v_closed     int;
  v_created    int;
  v_appointments int;
  v_sales_id   bigint;
begin
  -- 2a. Ask the question the booking actually poses.
  update tasks t
     set type = 'sales_call_needs_matching'
    from sales_calls sc
   where sc.id = t.sales_call_id
     and t.type = 'resolve_sales_call'
     and t.done_date is null
     and public.sales_call_open_question(
           sc.opportunity_id, sc.dismissed_at, sc.status, sc.attendance,
           sc.scheduled_at, sc.scheduled_on, sc.resolution_requested_at,
           now()) = 'matching'
     and not exists (
       select 1 from tasks other
        where other.sales_call_id = sc.id
          and other.type = 'sales_call_needs_matching'
          and other.done_date is null);
  get diagnostics v_refiled = row_count;

  -- 2b. A task whose question is no longer the one its booking poses is
  --     finished.
  update tasks t
     set done_date = coalesce(t.done_date, now()),
         status = 'completed'
    from sales_calls sc
   where sc.id = t.sales_call_id
     and t.type in ('sales_call_needs_matching', 'resolve_sales_call')
     and t.done_date is null
     and public.sales_call_open_question(
           sc.opportunity_id, sc.dismissed_at, sc.status, sc.attendance,
           sc.scheduled_at, sc.scheduled_on, sc.resolution_requested_at,
           now())
         <> case t.type when 'sales_call_needs_matching' then 'matching'
                        else 'attendance' end;
  get diagnostics v_closed = row_count;

  -- 2c. An open attendance question with nothing asking it.
  select id into v_sales_id from sales where administrator = true limit 1;

  insert into tasks (contact_id, type, text, due_date, status,
                     sales_call_id, opportunity_id, sales_id)
  select sc.contact_id,
         'resolve_sales_call',
         format('%s · what happened on this call?',
                nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '')),
         now(),
         'pending',
         sc.id,
         sc.opportunity_id,
         v_sales_id
    from sales_calls sc
    join contacts c on c.id = sc.contact_id
   where public.sales_call_open_question(
           sc.opportunity_id, sc.dismissed_at, sc.status, sc.attendance,
           sc.scheduled_at, sc.scheduled_on, sc.resolution_requested_at,
           now()) = 'attendance'
     and not exists (
       select 1 from tasks t
        where t.sales_call_id = sc.id
          and t.type = 'resolve_sales_call'
          and t.done_date is null);
  get diagnostics v_created = row_count;

  -- 2d. The appointment is not a task.
  update tasks
     set done_date = coalesce(done_date, now()),
         status = 'completed'
   where type = 'sales_call'
     and done_date is null;
  get diagnostics v_appointments = row_count;

  return jsonb_build_object(
    'refiled_as_matching', v_refiled,
    'closed_question_answered', v_closed,
    'created_attendance_question', v_created,
    'closed_appointment_tasks', v_appointments);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sales_call_is_resolved(p_attendance text, p_status text, p_dismissed_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  -- Any of the three canonical answers, or an explicit dismissal.
  -- Attendance covers attended and no_show; a cancelled call has no
  -- attendance to record and needs none.
  select p_attendance is not null
      or p_dismissed_at is not null
      or p_status = 'cancelled';
$function$
;


CREATE OR REPLACE FUNCTION public.contact_merge_conflicts(p_source bigint, p_destination bigint)
 RETURNS TABLE(code text, detail text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  if p_source = p_destination then
    return query select 'same_contact'::text, 'A Contact cannot be merged into itself'::text;
    return;
  end if;
  if not exists (select 1 from contacts where id = p_source) then
    return query select 'source_missing'::text, format('Contact %s does not exist', p_source);
  end if;
  if not exists (select 1 from contacts where id = p_destination) then
    return query select 'destination_missing'::text, format('Contact %s does not exist', p_destination);
  end if;

  -- Different real addresses on each side. Legitimate for one human with
  -- two addresses; also exactly what two different humans look like.
  return query
  select 'different_emails'::text,
         format('%s address(es) on one side, %s on the other, none shared',
                (select count(*) from contact_email_addresses where contact_id = p_source),
                (select count(*) from contact_email_addresses where contact_id = p_destination))
   where exists (select 1 from contact_email_addresses where contact_id = p_source)
     and exists (select 1 from contact_email_addresses where contact_id = p_destination)
     and not exists (
       select 1 from contact_email_addresses a
        join contact_email_addresses b on b.normalized_email = a.normalized_email
       where a.contact_id = p_source and b.contact_id = p_destination);

  -- Both sides still in play. Merging identity is fine; assuming the two
  -- sales attempts are one is not, and somebody should look.
  return query
  select 'both_have_live_opportunities'::text,
         format('%s live on one side, %s on the other',
                (select count(*) from deals d where d.contact_id = p_source
                  and public.deal_is_active(d.archived_at, d.stage, d.outcome)),
                (select count(*) from deals d where d.contact_id = p_destination
                  and public.deal_is_active(d.archived_at, d.stage, d.outcome)))
   where (select count(*) from deals d where d.contact_id = p_source
           and public.deal_is_active(d.archived_at, d.stage, d.outcome)) > 0
     and (select count(*) from deals d where d.contact_id = p_destination
           and public.deal_is_active(d.archived_at, d.stage, d.outcome)) > 0;

  -- Two people cannot both be mid-programme and be one person.
  return query
  select 'both_have_active_enrollments'::text, 'Both Contacts have a non-terminal Enrollment'::text
   where exists (select 1 from enrollments e join deals d on d.id = e.opportunity_id
                  where d.contact_id = p_source and e.status not in ('completed','withdrawn','ended'))
     and exists (select 1 from enrollments e join deals d on d.id = e.opportunity_id
                  where d.contact_id = p_destination and e.status not in ('completed','withdrawn','ended'));

  -- Separate Stripe customers may be one person's two checkouts, or two
  -- people's money. Never guessed.
  return query
  select 'different_stripe_customers'::text,
         format('%s Stripe customer(s) on one side, %s on the other',
                (select count(*) from contact_stripe_customers where contact_id = p_source),
                (select count(*) from contact_stripe_customers where contact_id = p_destination))
   where (select count(*) from contact_stripe_customers where contact_id = p_source) > 0
     and (select count(*) from contact_stripe_customers where contact_id = p_destination) > 0;

  -- The same provider identity already naming the other Contact is the
  -- one case that is evidence FOR a merge; a DIFFERENT one on each side
  -- for the same provider+account is evidence against.
  return query
  select 'conflicting_provider_identity'::text,
         format('both hold a different %s identity', a.provider)
    from contact_external_identities a
    join contact_external_identities b
      on b.provider = a.provider
     and b.provider_account_id is not distinct from a.provider_account_id
     and b.external_user_id <> a.external_user_id
   where a.contact_id = p_source and b.contact_id = p_destination
   group by a.provider;

  -- Already merged away.
  return query
  select 'already_merged'::text,
         format('Contact %s was already merged into %s', p_source, c.merged_into_contact_id)
    from contacts c where c.id = p_source and c.merged_into_contact_id is not null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.merge_contacts_safely(p_source bigint, p_destination bigint, p_actor text, p_evidence text, p_acknowledged_conflicts text[] DEFAULT '{}'::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_unacknowledged text[];
  v_moved jsonb := '{}'::jsonb;
  v_n bigint;
  v_merge_id bigint;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'a merge must record who performed it';
  end if;
  if p_evidence is null or btrim(p_evidence) = '' then
    raise exception 'a merge must record the evidence it rests on';
  end if;

  -- Lock both, lowest id first, so two merges cannot interleave.
  perform 1 from contacts where id in (p_source, p_destination)
   order by id for update;

  if not exists (select 1 from contacts where id = p_source) then
    raise exception 'source Contact % does not exist', p_source;
  end if;
  if not exists (select 1 from contacts where id = p_destination) then
    raise exception 'destination Contact % does not exist', p_destination;
  end if;

  select coalesce(array_agg(code), '{}')
    into v_unacknowledged
    from public.contact_merge_conflicts(p_source, p_destination)
   where code <> all (coalesce(p_acknowledged_conflicts, '{}'));

  if array_length(v_unacknowledged, 1) is not null then
    raise exception 'merge refused: unacknowledged conflict(s) %', v_unacknowledged
      using hint = 'Review each with contact_merge_conflicts(), then pass the codes you accept as p_acknowledged_conflicts.';
  end if;

  -- ---- Every child, named explicitly. ----
  -- Applications carry their own Opportunity agreement check, so they are
  -- moved with their Opportunities rather than independently.
  update deals set contact_id = p_destination where contact_id = p_source;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('deals', v_n);

  update applications set contact_id = p_destination where contact_id = p_source;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('applications', v_n);

  update sales_calls set contact_id = p_destination where contact_id = p_source;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('sales_calls', v_n);

  update client_sessions set contact_id = p_destination where contact_id = p_source;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('client_sessions', v_n);

  update tasks set contact_id = p_destination where contact_id = p_source;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('tasks', v_n);

  update contact_notes set contact_id = p_destination where contact_id = p_source;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('contact_notes', v_n);

  update waitlist_entries set contact_id = p_destination where contact_id = p_source;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('waitlist_entries', v_n);

  update waitlist_invitations set contact_id = p_destination where contact_id = p_source;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('waitlist_invitations', v_n);

  -- Stripe relations move as evidence. The unique key is the Stripe
  -- customer id, so nothing can be duplicated by this; is_primary is left
  -- alone rather than guessed at, and payment truth is untouched.
  update contact_stripe_customers set contact_id = p_destination where contact_id = p_source;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('contact_stripe_customers', v_n);

  -- Provider identities move too; their uniqueness is on the provider id,
  -- so a genuine duplicate identity would already have been a conflict.
  update contact_external_identities set contact_id = p_destination, updated_at = now()
   where contact_id = p_source;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('external_identities', v_n);

  -- historical_import_records is deliberately NOT touched. It is keyed by
  -- (entity_table, entity_id) and records how a particular ROW was
  -- imported, not who a person is. The source Contact row still exists —
  -- this merge does not delete it — so its provenance stays attached to
  -- something real, and moving it would collide with the destination's
  -- own row on that unique key.

  -- ---- The surviving Contact keeps the earliest evidence. ----
  -- first_seen is "when did this person first appear", so the earlier of
  -- the two is the true answer; last_seen is the later.
  update contacts d
     set first_seen = least(d.first_seen, s.first_seen),
         last_seen = greatest(d.last_seen, s.last_seen)
    from contacts s
   where d.id = p_destination and s.id = p_source;

  -- ---- The losing Contact stays, and says what it became. ----
  update contacts set merged_into_contact_id = p_destination where id = p_source;

  insert into contact_merges
    (source_contact_id, destination_contact_id, actor, evidence, moved_counts)
  values (p_source, p_destination, p_actor, p_evidence, v_moved)
  returning id into v_merge_id;

  return jsonb_build_object(
    'merge_id', v_merge_id,
    'source_contact_id', p_source,
    'destination_contact_id', p_destination,
    'moved', v_moved
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.normalize_email(p_email text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select nullif(lower(btrim(p_email)), '');
$function$
;

CREATE OR REPLACE FUNCTION public.record_external_identity(p_provider text, p_provider_account_id text, p_external_user_id text, p_display_identifier text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_observed_at timestamp with time zone DEFAULT now(), p_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_existing contact_external_identities%rowtype;
  v_contact_id bigint;
  v_matches int;
begin
  if p_external_user_id is null or btrim(p_external_user_id) = '' then
    raise exception 'an external identity needs the provider''s own id, never a handle';
  end if;

  -- A. Already known. The handle may have changed; that is metadata.
  select * into v_existing from contact_external_identities
   where provider = p_provider
     and provider_account_id is not distinct from p_provider_account_id
     and external_user_id = p_external_user_id;

  if found then
    update contact_external_identities
       set display_identifier = coalesce(p_display_identifier, display_identifier),
           metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
           first_seen_at = least(coalesce(first_seen_at, p_observed_at), p_observed_at),
           last_seen_at = greatest(coalesce(last_seen_at, p_observed_at), p_observed_at),
           updated_at = now()
     where id = v_existing.id;

    -- Follow a merge rather than resurrecting a merged-away Contact.
    select coalesce(c.merged_into_contact_id, c.id) into v_contact_id
      from contacts c where c.id = v_existing.contact_id;

    return jsonb_build_object('status', 'known', 'contact_id', v_contact_id,
                              'identity_id', v_existing.id);
  end if;

  -- B. Not known, but an exact address match names exactly one Contact.
  if public.normalize_email(p_email) is not null then
    select count(distinct contact_id) into v_matches
      from contact_email_addresses
     where normalized_email = public.normalize_email(p_email);

    if v_matches = 1 then
      select coalesce(c.merged_into_contact_id, c.id) into v_contact_id
        from contact_email_addresses a
        join contacts c on c.id = a.contact_id
       where a.normalized_email = public.normalize_email(p_email)
       limit 1;

      insert into contact_external_identities
        (contact_id, provider, provider_account_id, external_user_id,
         display_identifier, metadata, first_seen_at, last_seen_at)
      values (v_contact_id, p_provider, p_provider_account_id, p_external_user_id,
              p_display_identifier, coalesce(p_metadata, '{}'::jsonb),
              p_observed_at, p_observed_at)
      returning id into v_existing.id;

      return jsonb_build_object('status', 'linked_by_email', 'contact_id', v_contact_id,
                                'identity_id', v_existing.id);
    end if;

    -- D. The address names more than one person. Refuse, loudly.
    if v_matches > 1 then
      return jsonb_build_object('status', 'ambiguous',
        'reason', format('%s Contacts hold that address; a person must decide', v_matches));
    end if;
  end if;

  -- C. Nothing deterministic to attach to. The caller decides whether its
  --    integration rules justify creating a Contact; this will not do it
  --    on a handle's say-so.
  return jsonb_build_object('status', 'unresolved',
    'reason', 'no existing identity and no exact email match');
end;
$function$
;

-- The Opportunity a manually entered Application cannot do without.
--
-- The CRM's first pipeline stage IS "Application Received", and every
-- review outcome writes to the Application AND its Opportunity together
-- (reviewApplication.ts). So an Application with no Opportunity is a
-- record that looks like review work and cannot be reviewed.
--
-- This mirrors submit_public_application()'s INVARIANT rather than its
-- signature — same stage, same Deal shape, same reuse rule via the same
-- canonical deal_is_active() predicate, same advisory lock, same single
-- transaction — because that function cannot be reused here: it resolves
-- the applicant BY EMAIL (Leif picks a specific Contact, who may have
-- none), it is service_role-only by design, and it stamps
-- source='public_form' / entry_path='application_form', both of which
-- would claim a submission that never happened.
--
-- SECURITY INVOKER: authenticated already holds insert on deals and
-- applications (06_grants.sql), so this adds no capability, only
-- atomicity. Everything else an Opportunity needs — offer/cohort
-- validation, the commercial snapshot, the Contact-derived name,
-- stage_entered_at, the stage event, waitlist conversion — is written by
-- the deals triggers, which is why the Deal below is a plain INSERT.
CREATE OR REPLACE FUNCTION "public"."create_manual_application"("p_contact_id" bigint, "p_offer_id" bigint, "p_cohort_id" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_offer offers%ROWTYPE;
  v_contact contacts%ROWTYPE;
  v_deal deals%ROWTYPE;
  v_reused boolean := false;
  v_pending_app_id bigint;
  v_application_id bigint;
BEGIN
  -- Same structural backstop submit_public_application() applies, for the
  -- same reason: the dialog already scoped the choices, and this is what
  -- holds when the dialog is not the caller.
  SELECT * INTO v_offer FROM offers WHERE id = p_offer_id AND is_active;
  IF v_offer.id IS NULL THEN
    RETURN jsonb_build_object('status', 'offer-invalid');
  END IF;

  IF p_cohort_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cohorts WHERE id = p_cohort_id AND offer_id = p_offer_id
  ) THEN
    RETURN jsonb_build_object('status', 'cohort-invalid');
  END IF;

  SELECT * INTO v_contact FROM contacts WHERE id = p_contact_id;
  IF v_contact.id IS NULL THEN
    RETURN jsonb_build_object('status', 'contact-invalid');
  END IF;

  -- A durable "no future direct sales" gate, honoured wherever a sales
  -- process would start.
  IF v_contact.sales_eligibility = 'do_not_engage' THEN
    RETURN jsonb_build_object('status', 'do-not-engage');
  END IF;

  -- Serialize concurrent creations for this person+programme for the rest
  -- of this transaction, so two clicks cannot both read "no active
  -- Opportunity" and both create one. Mirrors the advisory lock
  -- submit_public_application() takes on the applicant's email.
  PERFORM pg_advisory_xact_lock(
    hashtext('create_manual_application:' || p_contact_id || ':' || p_offer_id
             || ':' || coalesce(p_cohort_id::text, '-'))
  );

  -- One active sales attempt per person per Offer (per Cohort where there
  -- is one), oldest first — the same rule, via the same canonical
  -- predicate, that the public form uses to avoid opening a second sale
  -- beside a live one.
  SELECT * INTO v_deal
  FROM deals d
  WHERE d.contact_id = p_contact_id
    AND d.offer_id = p_offer_id
    AND (p_cohort_id IS NULL OR d.cohort_id = p_cohort_id)
    AND public.deal_is_active(d.archived_at, d.stage, d.outcome)
  ORDER BY d.id ASC
  LIMIT 1;

  IF v_deal.id IS NOT NULL THEN
    -- Already past the point a review speaks to.
    --
    -- Approving an Application WRITES stage = 'approved' onto its
    -- Opportunity. Forward from interested or application_received, a
    -- no-op at approved — but on a sale at call_booked or decision it
    -- would drag the person BACKWARD through the pipeline on the strength
    -- of a review. So a new pending Application is refused here rather
    -- than set up to regress a live sale later, and rather than opening a
    -- second Opportunity beside it. The caller shows Leif the sale.
    --
    -- Order comes from ACTIVE_SALES_STAGES (deals/dealActivity.ts), and
    -- contracts/applications/oneReviewableStageRule.test.ts pins the two
    -- lists together. Anything NOT in it fails closed — including the
    -- legacy 'onboarding' value, which deal_is_active() still calls
    -- active (fourteen rows renamed from 'committed') but which is far
    -- past any review.
    IF coalesce(
         array_position(
           array['interested', 'application_received', 'approved', 'call_booked', 'decision'],
           v_deal.stage),
         0) NOT BETWEEN 1 AND 3
    THEN
      RETURN jsonb_build_object(
        'status', 'later-stage',
        'opportunity_id', v_deal.id,
        'stage', v_deal.stage,
        'reused_opportunity', false
      );
    END IF;

    v_reused := true;

    -- Already waiting on Leif for this programme. Surfaced rather than
    -- duplicated: a second pending Application against one live sale is
    -- two claims on the same decision.
    SELECT a.id INTO v_pending_app_id
    FROM applications a
    WHERE a.opportunity_id = v_deal.id
      AND a.status = 'pending'
    ORDER BY a.id DESC
    LIMIT 1;

    IF v_pending_app_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'already-pending',
        'application_id', v_pending_app_id,
        'opportunity_id', v_deal.id,
        'reused_opportunity', true
      );
    END IF;

    -- Reuse writes nothing to deals, so on_deal_waitlist_sync never fires
    -- for this branch. submit_public_application() runs the same explicit
    -- sync for the same reason.
    UPDATE waitlist_entries
    SET status = 'converted', converted_at = now(), converted_opportunity_id = v_deal.id
    WHERE contact_id = v_deal.contact_id
      AND offer_id = v_deal.offer_id
      AND status IN ('waiting', 'invited')
      AND (cohort_id IS NULL OR cohort_id = v_deal.cohort_id);
  ELSE
    -- The canonical Application Received Opportunity. Same shape
    -- submit_public_application() writes, with one honest difference:
    -- entry_path is 'other', never 'application_form' — no public form
    -- produced this, and saying it did would be the exact lie that
    -- source='manual' exists to avoid. Everything else the Opportunity
    -- needs (offer/cohort validation, the commercial snapshot, the
    -- Contact-derived name, stage_entered_at, the stage event, waitlist
    -- conversion) is written by the deals triggers, which is why this is
    -- a plain INSERT and not a second copy of those rules.
    INSERT INTO deals (
      contact_id, offer_id, cohort_id, stage, outcome, owner_decision,
      amount, entry_path, description
    ) VALUES (
      p_contact_id, p_offer_id, p_cohort_id, 'application_received',
      NULL, NULL, v_offer.current_price, 'other', ''
    ) RETURNING * INTO v_deal;
  END IF;

  INSERT INTO applications (
    contact_id, opportunity_id, offer_id, intended_cohort_id,
    raw_answers, submitted_at, status, reviewed_at, source
  ) VALUES (
    p_contact_id, v_deal.id, p_offer_id, p_cohort_id,
    '{}'::jsonb, now(), 'pending', NULL, 'manual'
  ) RETURNING id INTO v_application_id;

  RETURN jsonb_build_object(
    'status', 'created',
    'application_id', v_application_id,
    'opportunity_id', v_deal.id,
    'reused_opportunity', v_reused
  );
END;
$$;

-- Every way a sale is accepted, through one door.
--
-- Won means the sale was accepted — not paid, not enrolled, not onboarded
-- (20260918180000). Three UIs record that same business event, so there is
-- one primitive underneath and thin wrappers only where the surrounding
-- facts differ. handle_deal_saved() above permits it because these run
-- SECURITY DEFINER as the owner, which a client cannot become; an ordinary
-- browser PATCH of stage='won' is still refused.
--
-- accept_sale() is CONVERGENT, not merely idempotent: a sale that landed
-- halfway — Becky Schmauch's, whose call read attended while her
-- Opportunity sat at Call Booked with no Enrollment — is finished by
-- resubmitting the decision, not refused forever.
CREATE OR REPLACE FUNCTION "public"."ensure_sale_enrollment"("p_deal_id" bigint) RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deal deals%rowtype;
  v_cohort cohorts%rowtype;
  v_enrollment_id bigint;
begin
  select * into v_deal from deals where id = p_deal_id;
  if not found or v_deal.stage <> 'won' then
    return null;
  end if;

  if v_deal.cohort_id is not null then
    select * into v_cohort from cohorts where id = v_deal.cohort_id;
  end if;

  -- Idempotent: enrollments.opportunity_id is unique, so this can run any
  -- number of times and create at most one.
  insert into enrollments (opportunity_id, status, start_date, end_date, onboarding_tracking, start_date_source)
  values (
    v_deal.id,
    'onboarding',
    v_cohort.program_start_at::date,
    v_cohort.program_end_at::date,
    -- A sale made today is tracked. legacy_untracked is only ever a
    -- statement about the past, never a default for new work.
    'tracked',
    -- A Cohort start is a date Leif published when she created the round.
    -- An individual Offer has no such date: the Start Week is hers to set,
    -- and until she does it stays unknown rather than inferred.
    case when v_cohort.program_start_at is not null then 'owner' end
  )
  on conflict (opportunity_id) do nothing
  returning id into v_enrollment_id;

  if v_enrollment_id is not null then
    perform public.seed_enrollment_onboarding(v_enrollment_id);
  end if;

  return v_enrollment_id;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."accept_sale"("p_deal_id" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deal deals%rowtype;
  v_already boolean;
  v_enrollments int;
begin
  select * into v_deal from deals where id = p_deal_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- A sale may not overwrite somebody's recorded no, and an archived
  -- Opportunity is not quietly reopened by a click.
  if v_deal.archived_at is not null then
    return jsonb_build_object('status', 'conflicting-outcome',
      'reason', 'This opportunity has been archived.');
  end if;
  if v_deal.outcome is not null then
    return jsonb_build_object('status', 'conflicting-outcome',
      'reason', format('This opportunity already ended as "%s".', v_deal.outcome));
  end if;

  v_already := v_deal.stage = 'won';

  if not v_already then
    -- Permitted because this function runs as its owner, which is what
    -- handle_deal_saved() above is actually checking.
    update deals
       set stage = 'won',
           prospect_decision = 'yes'
     where id = p_deal_id;
  end if;

  -- Either way, the facts a Won sale has must exist. On the transition the
  -- trigger has already made them and this is a no-op; on a sale that
  -- landed halfway it is the repair.
  perform public.ensure_sale_enrollment(p_deal_id);
  select count(*) into v_enrollments from enrollments where opportunity_id = p_deal_id;

  return jsonb_build_object(
    'status', case when v_already then 'already-won' else 'won' end,
    'opportunity_id', p_deal_id,
    'contact_id', v_deal.contact_id,
    'enrollments', v_enrollments
  );
end;
$$;

CREATE OR REPLACE FUNCTION "public"."complete_attended_sales_call"("p_sales_call_id" bigint, "p_owner_decision" "text", "p_prospect_decision" "text" DEFAULT NULL::"text", "p_follow_up_date" "date" DEFAULT NULL::"date", "p_impressions" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

  -- A call recorded as a no-show is a different answer to the same
  -- question, and this is not the place to overturn it.
  if v_call.attendance = 'no_show' then
    return jsonb_build_object('status', 'already-completed');
  end if;

  if v_call.attendance is null then
    -- The normal path: the call has not been resolved yet.
    update sales_calls
       set attendance = 'attended',
           attendance_recorded_at = v_now,
           status = 'completed',
           -- Blank stays blank; it erases nothing, because there is nothing
           -- yet to erase.
           impressions = v_impressions,
           updated_at = v_now
     where id = v_call.id;
  else
    -- Already attended. The question is whether the DECISION landed.
    -- Becky's did not: her call reads attended while her Opportunity sits
    -- at Call Booked with no Enrollment. Resubmitting is how she finishes
    -- it, so this is a convergence rather than a refusal.
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

    -- A converging replay may carry an impression the first pass did not. It
    -- may NEVER erase one: an omitted or blank value means "unchanged", not
    -- "delete what he wrote". Clearing one deliberately is Part 2's
    -- correction path, which does not exist yet.
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
$$;

CREATE OR REPLACE FUNCTION "public"."record_prospect_accepted"("p_opportunity_id" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  return public.accept_sale(p_opportunity_id);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."transfer_enrolled_opportunity_offer"("p_opportunity_id" bigint, "p_to_offer_id" bigint, "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deal deals%rowtype;
  v_offer offers%rowtype;
  v_enrollment enrollments%rowtype;
  v_enrollment_count int;
  v_item record;
  v_retired int := 0;
  v_relabelled int := 0;
  v_added int := 0;
  v_kept int := 0;
  v_kept_historical int := 0;
  v_from_offer_id bigint;
  v_existing_status text;
begin
  select * into v_deal from deals where id = p_opportunity_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  select * into v_offer from offers where id = p_to_offer_id;
  if not found then
    return jsonb_build_object('status', 'invalid-offer');
  end if;

  if v_deal.offer_id = p_to_offer_id then
    -- A replay, a double click, or a stale tab. Nothing to do, and saying so
    -- is not an error. It is also the honest answer for a client whose
    -- Opportunity was already edited before the guard existed: the offer is
    -- right and only the checklist is stale, which is
    -- reconcile_enrollment_to_current_offer()'s question, not this one.
    return jsonb_build_object('status', 'already-on-offer', 'offer_id', p_to_offer_id);
  end if;

  select count(*) into v_enrollment_count from enrollments where opportunity_id = p_opportunity_id;
  if v_enrollment_count = 0 then
    -- Nothing downstream exists yet, so an ordinary edit is the right tool and
    -- is still allowed. Refusing here keeps this function honest about what it
    -- is for.
    return jsonb_build_object('status', 'no-enrollment');
  end if;
  if v_enrollment_count > 1 then
    -- Structurally impossible today (enrollments.opportunity_id is unique),
    -- and if it ever becomes possible this must not guess which one moves.
    return jsonb_build_object('status', 'ambiguous-enrollment', 'enrollments', v_enrollment_count);
  end if;

  select * into v_enrollment from enrollments where opportunity_id = p_opportunity_id for update;

  -- A group programme needs a round, and this function does not pick one.
  if v_offer.type = 'group' then
    return jsonb_build_object(
      'status', 'needs-cohort',
      'reason', format('%s is a group programme: choose the round before moving a client into it', v_offer.name)
    );
  end if;
  -- Leaving a group programme means leaving its round behind.
  v_from_offer_id := v_deal.offer_id;

  -- ---- the Opportunity itself --------------------------------------------
  -- handle_deal_saved() refreshes the commercial snapshot and revalidates the
  -- pairing; its enrolled-client guard lets this through because this function
  -- runs as the owner, not as the caller.
  update deals
     set offer_id = p_to_offer_id,
         cohort_id = case when v_offer.type = 'group' then cohort_id else null end
   where id = p_opportunity_id;

  v_counts := public.apply_enrollment_onboarding_projection(
    v_enrollment.id, v_from_offer_id, p_to_offer_id
  );

  -- ---- the history this never had ----------------------------------------
  -- occurred_at is now(), because the change is happening now.
  insert into deal_offer_events (opportunity_id, enrollment_id, from_offer_id, to_offer_id, source, note)
  values (p_opportunity_id, v_enrollment.id, v_from_offer_id, p_to_offer_id, 'app', p_note);

  return jsonb_build_object(
    'status', 'transferred',
    'opportunity_id', p_opportunity_id,
    'enrollment_id', v_enrollment.id,
    'from_offer_id', v_from_offer_id,
    'to_offer_id', p_to_offer_id
  ) || v_counts;
end;
$$;

CREATE FUNCTION public.apply_enrollment_onboarding_projection(p_enrollment_id bigint, p_from_offer_id bigint, p_to_offer_id bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_deal deals%rowtype;
  v_item record;
  v_retired int := 0;
  v_relabelled int := 0;
  v_added int := 0;
  v_kept int := 0;
  v_kept_historical int := 0;
  v_existing_status text;
begin
  select d.* into v_deal
    from deals d
    join enrollments e on e.opportunity_id = d.id
   where e.id = p_enrollment_id;
  if not found then
    raise exception 'apply_enrollment_onboarding_projection: enrollment % has no Opportunity', p_enrollment_id;
  end if;

  -- ---- requirements that no longer apply ---------------------------------
  for v_item in
    select i.* from enrollment_onboarding_items i
     where i.enrollment_id = p_enrollment_id
       and i.status <> 'retired'
       and not exists (
         select 1 from onboarding_requirement_templates t
          where t.offer_id = p_to_offer_id and t.is_active and t.key = i.requirement_key
       )
  loop
    if v_item.status = 'done' then
      -- Completed work under the old programme is history, not a requirement
      -- of the new one. Kept as it is, with its provenance made explicit.
      -- Completed work that belongs only to the old programme. Provenance is
      -- known here too — it is not a requirement of the new one — and saying
      -- so is what keeps it readable as history rather than as a stray row.
      update enrollment_onboarding_items
         set source_offer_id = coalesce(source_offer_id, v_from_offer_id),
             updated_at = now()
       where id = v_item.id;
      v_kept_historical := v_kept_historical + 1;
    else
      -- Retiring one IS a moment where provenance is known: the requirement
      -- exists on the programme being left and not on the one being joined, so
      -- the offer it came from is the offer we are leaving. Filled only when
      -- the row does not already say.
      update enrollment_onboarding_items
         set status = 'retired',
             retired_at = now(),
             retired_from_offer_id = v_from_offer_id,
             source_offer_id = coalesce(source_offer_id, v_from_offer_id),
             updated_at = now()
       where id = v_item.id;
      v_retired := v_retired + 1;
    end if;
  end loop;

  -- ---- requirements the target programme shares or adds -------------------
  for v_item in
    select t.* from onboarding_requirement_templates t
     where t.offer_id = p_to_offer_id and t.is_active
  loop
    select status into v_existing_status
      from enrollment_onboarding_items
     where enrollment_id = v_enrollment.id and requirement_key = v_item.key;

    if v_existing_status is not null then
      -- Shared key. A done item keeps everything, including its wording: it
      -- describes what was actually done. A pending one is only a request, so
      -- it becomes the target's request.
      update enrollment_onboarding_items
         set label = case when v_existing_status = 'done' then label else v_item.label end,
             task_text_template = case when v_existing_status = 'done' then task_text_template else v_item.task_text_template end,
             is_required = v_item.is_required,
             sort_order = v_item.sort_order,
             -- A requirement coming back from retirement (a move back to the
             -- programme it belonged to) becomes real work again.
             status = case when v_existing_status = 'retired' then 'pending' else status end,
             retired_at = case when v_existing_status = 'retired' then null else retired_at end,
             retired_from_offer_id = case when v_existing_status = 'retired' then null else retired_from_offer_id end,
             -- Provenance, said only where it is known:
             --
             --   done      LEFT ALONE, including null. A shared requirement
             --             that is already finished is the same requirement in
             --             both programmes — "contract" is contract — so the
             --             Opportunity having once been GYU says nothing about
             --             where THIS row came from. Stamping it would invent a
             --             fact about completed work.
             --   otherwise the target template, which is now genuinely where
             --             this requirement comes from. Re-pointing a pending
             --             row is a change of request, not a claim about
             --             history; the transfer event carries the history.
             source_offer_id = case when v_existing_status = 'done' then source_offer_id else p_to_offer_id end,
             updated_at = now()
       where enrollment_id = v_enrollment.id
         and requirement_key = v_item.key;

      if v_existing_status = 'done' then
        v_kept := v_kept + 1;
      else
        v_relabelled := v_relabelled + 1;
      end if;
    else
      insert into enrollment_onboarding_items
        (enrollment_id, requirement_key, label, task_text_template, is_required, sort_order, source_offer_id)
      values (v_enrollment.id, v_item.key, v_item.label, v_item.task_text_template,
              v_item.is_required, v_item.sort_order, p_to_offer_id);
      v_added := v_added + 1;
    end if;
  end loop;

  -- ---- every outstanding requirement has exactly one open Task -----------
  -- The relabelled ones need their wording corrected; the added ones need a
  -- Task at all. sync_task_from_onboarding_item() creates on insert, so this
  -- only repairs text and fills genuine gaps.
  update tasks t
     set text = replace(i.task_text_template, '{name}',
                        coalesce(nullif(trim(both ' ' from coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), v_deal.name))
    from enrollment_onboarding_items i
    join contacts c on c.id = v_deal.contact_id
   where t.onboarding_item_id = i.id
     and i.enrollment_id = v_enrollment.id
     and i.status not in ('done', 'retired')
     and t.status = 'pending';

  insert into tasks (contact_id, type, text, due_date, status, enrollment_id, onboarding_item_id)
  select v_deal.contact_id, 'onboarding_item',
         replace(i.task_text_template, '{name}',
                 coalesce(nullif(trim(both ' ' from coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), v_deal.name)),
         now() + interval '3 days', 'pending', v_enrollment.id, i.id
    from enrollment_onboarding_items i
    join contacts c on c.id = v_deal.contact_id
   where i.enrollment_id = v_enrollment.id
     and i.is_required
     and i.status not in ('done', 'retired')
     and not exists (
       select 1 from tasks tk
        where tk.onboarding_item_id = i.id
          and tk.status not in ('completed', 'cancelled')
     );

  -- ---- the history this never had ----------------------------------------
  insert into deal_offer_events (opportunity_id, enrollment_id, from_offer_id, to_offer_id, source, note)
  values (p_opportunity_id, v_enrollment.id, v_from_offer_id, p_to_offer_id, 'app', p_note);

  return jsonb_build_object(
    'status', 'transferred',
    'opportunity_id', p_opportunity_id,
    'enrollment_id', v_enrollment.id,
    'from_offer_id', v_from_offer_id,
    'to_offer_id', p_to_offer_id,
    'retired', v_retired,
    'relabelled', v_relabelled,
    'added', v_added,
    'kept_done', v_kept,
    'kept_historical', v_kept_historical,
    -- sync_task_from_onboarding_item() cancelled these as each item retired.
    'cancelled_tasks', (
      select count(*) from tasks tk
        join enrollment_onboarding_items i on i.id = tk.onboarding_item_id
       where i.enrollment_id = p_enrollment_id
         and i.status = 'retired'
         and tk.status = 'cancelled'
    ),
    'required_outstanding', (
      select count(*) from enrollment_onboarding_items
       where enrollment_id = p_enrollment_id and is_required
         and status not in ('done', 'retired')
    ),
    'required_total', (
      select count(*) from enrollment_onboarding_items
       where enrollment_id = p_enrollment_id and is_required and status <> 'retired'
    )
  );
end;
$$;

CREATE FUNCTION public.enrollment_onboarding_matches_offer(p_enrollment_id bigint, p_offer_id bigint) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select not exists (
      select 1
        from enrollment_onboarding_items i
       where i.enrollment_id = p_enrollment_id
         and i.status <> 'retired'
         and not exists (
           select 1 from onboarding_requirement_templates t
            where t.offer_id = p_offer_id and t.is_active and t.key = i.requirement_key
         )
    )
    and not exists (
      select 1
        from onboarding_requirement_templates t
       where t.offer_id = p_offer_id and t.is_active
         and not exists (
           select 1 from enrollment_onboarding_items i
            where i.enrollment_id = p_enrollment_id
              and i.status <> 'retired'
              and i.requirement_key = t.key
         )
    );
$$;

CREATE FUNCTION public.reconcile_enrollment_to_current_offer(p_opportunity_id bigint, p_from_offer_id bigint DEFAULT NULL::bigint, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_deal deals%rowtype;
  v_enrollment enrollments%rowtype;
  v_enrollment_count int;
  v_from_offer offers%rowtype;
  v_foreign_keys text[];
  v_unclaimed text[];
  v_counts jsonb;
begin
  select * into v_deal from deals where id = p_opportunity_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  if p_from_offer_id is not null then
    select * into v_from_offer from offers where id = p_from_offer_id;
    if not found then
      return jsonb_build_object('status', 'invalid-offer');
    end if;
    if p_from_offer_id = v_deal.offer_id then
      -- "It came from the programme it is already on" says nothing, and
      -- deal_offer_events would refuse it too.
      return jsonb_build_object('status', 'same-offer', 'offer_id', p_from_offer_id);
    end if;
  end if;

  select count(*) into v_enrollment_count from enrollments where opportunity_id = p_opportunity_id;
  if v_enrollment_count = 0 then
    -- There is no projection to reconcile. An ordinary offer edit is still
    -- available for an Opportunity with nothing downstream.
    return jsonb_build_object('status', 'no-enrollment');
  end if;
  if v_enrollment_count > 1 then
    return jsonb_build_object('status', 'ambiguous-enrollment', 'enrollments', v_enrollment_count);
  end if;

  select * into v_enrollment from enrollments where opportunity_id = p_opportunity_id for update;

  -- A finished client's record is history. Reopening their checklist because
  -- a template disagrees with it would rewrite what their programme was.
  if v_enrollment.status in ('completed', 'withdrawn', 'ended') then
    return jsonb_build_object(
      'status', 'terminal-enrollment',
      'enrollment_status', v_enrollment.status
    );
  end if;

  -- Onboarding this client's programme does not track. 'legacy_untracked' is a
  -- deliberate statement about a client who was onboarded before the CRM
  -- modelled it (Slice 2): the absence of a checklist is the recorded fact, not
  -- a defect, and seeding one now would invent four requirements and four Tasks
  -- for work that finished long ago. Refused here as well as in the UI, because
  -- an authority that depends on a screen not offering a button is not an
  -- authority. Checked BEFORE alignment, so this never answers
  -- 'already-aligned': their checklist genuinely does not match the template,
  -- and that is not the question being asked about them.
  if v_enrollment.onboarding_tracking is distinct from 'tracked' then
    return jsonb_build_object(
      'status', 'onboarding-not-tracked',
      'enrollment_id', v_enrollment.id,
      'onboarding_tracking', v_enrollment.onboarding_tracking
    );
  end if;

  if public.enrollment_onboarding_matches_offer(v_enrollment.id, v_deal.offer_id) then
    -- Nothing is stale. A second click, a stale tab, or a client who was
    -- always aligned: all three deserve the same quiet answer.
    return jsonb_build_object(
      'status', 'already-aligned',
      'enrollment_id', v_enrollment.id,
      'offer_id', v_deal.offer_id
    );
  end if;

  -- The live requirements the current programme does not have. These are the
  -- evidence that another programme's template is in play.
  select coalesce(array_agg(i.requirement_key order by i.requirement_key), '{}')
    into v_foreign_keys
    from enrollment_onboarding_items i
   where i.enrollment_id = v_enrollment.id
     and i.status <> 'retired'
     and not exists (
       select 1 from onboarding_requirement_templates t
        where t.offer_id = v_deal.offer_id and t.is_active and t.key = i.requirement_key
     );

  if array_length(v_foreign_keys, 1) is null then
    -- Only missing requirements, no foreign ones: the current programme's
    -- template gained something since this client was seeded. Reconciling that
    -- is right; calling it a programme change is not.
    if p_from_offer_id is not null then
      return jsonb_build_object(
        'status', 'source-offer-not-applicable',
        'reason', 'nothing on this checklist belongs to another programme, so there is no programme change to record'
      );
    end if;
  else
    if p_from_offer_id is null then
      -- Provenance is not guessed. Even where exactly one offer's template
      -- matches, saying so is Leif's call, made in front of the evidence.
      return jsonb_build_object(
        'status', 'needs-source-offer',
        'foreign_keys', to_jsonb(v_foreign_keys)
      );
    end if;

    -- The named programme has to be able to account for what is being
    -- retired. Anything it cannot explain means the claim is wrong, and a
    -- wrong from_offer_id is false history that would outlive the repair.
    select coalesce(array_agg(k order by k), '{}')
      into v_unclaimed
      from unnest(v_foreign_keys) as k
     where not exists (
       select 1 from onboarding_requirement_templates t
        where t.offer_id = p_from_offer_id and t.is_active and t.key = k
     );

    if array_length(v_unclaimed, 1) is not null then
      return jsonb_build_object(
        'status', 'source-offer-mismatch',
        'from_offer_id', p_from_offer_id,
        'unmatched_keys', to_jsonb(v_unclaimed)
      );
    end if;
  end if;

  -- The Opportunity is deliberately NOT written here. Its offer is already
  -- what it should be; that is the whole premise.
  v_counts := public.apply_enrollment_onboarding_projection(
    v_enrollment.id, p_from_offer_id, v_deal.offer_id
  );

  if p_from_offer_id is not null then
    -- Recorded now, because that is when it was recorded. occurred_at stays
    -- null: the programme change itself predates the guard and nothing
    -- anywhere says which day it was. 'reconstructed' is what makes that
    -- readable instead of looking like an event that happened at repair time.
    insert into deal_offer_events
      (opportunity_id, enrollment_id, from_offer_id, to_offer_id, occurred_at, source, note)
    values (
      p_opportunity_id, v_enrollment.id, p_from_offer_id, v_deal.offer_id, null, 'reconstructed',
      coalesce(
        p_note,
        'Onboarding reconciled to the programme the Opportunity already carried. The programme change itself happened before transfer_enrolled_opportunity_offer() existed and its date is not recorded anywhere.'
      )
    );
  end if;

  return jsonb_build_object(
    'status', 'reconciled',
    'opportunity_id', p_opportunity_id,
    'enrollment_id', v_enrollment.id,
    'from_offer_id', p_from_offer_id,
    'to_offer_id', v_deal.offer_id,
    'event_recorded', p_from_offer_id is not null
  ) || v_counts;
end;
$$;


-- ---------------------------------------------------------------------------
-- Enqueue: one body, called from receipt and from decision
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER because the two callers are different principals — the
-- public receipt path writes as service_role, an application decision writes as
-- Leif's own authenticated browser session — and NEITHER may hold write
-- privilege on kit_sync_operations directly. If the browser could insert here
-- it could name any Kit tag id it liked; it can't, and this is why. The tag is
-- resolved from the mapping table inside this function or there is no row.
--
-- Returns the operation id, or null when the application is not Kit-managed.
-- Not-managed is a silent, deliberate answer, not a failure: an unmapped
-- programme, an imported row, a row that predates the integration and an
-- application with no usable email address all mean "Kit was never going to
-- hear about this", and inventing a failed row for them would fill the
-- operator's attention with work nobody ever intended.
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
  v_email text;
  v_tag kit_tag_mappings%rowtype;
  v_not_before timestamp with time zone;
  v_id bigint;
begin
  select * into v_app from applications where id = p_application_id;
  if not found then
    return null;
  end if;

  -- Origin. An imported record is what already happened, not work; it must
  -- never subscribe or tag anybody merely because this integration exists.
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
    -- No mapping is a refusal, never a guess.
    return null;
  end if;

  select a.normalized_email into v_email
    from contact_email_addresses a
   where a.contact_id = v_app.contact_id
   order by a.normalized_email
   limit 1;
  if v_email is null then
    return null;
  end if;

  insert into kit_sync_operations
    (application_id, contact_id, kind, email, kit_tag_id, kit_tag_name)
  values
    (v_app.id, v_app.contact_id, p_kind, v_email, v_tag.kit_tag_id, v_tag.kit_tag_name)
  on conflict (application_id, kind) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Receipt
-- ---------------------------------------------------------------------------
-- Fires inside submit_public_application()'s and create_manual_application()'s
-- own transactions — the only honest boundary either path has — so the durable
-- Kit intent and the application that owes it commit together or not at all.
--
-- status <> 'pending' is the Do Not Engage gate. A submission from somebody
-- already marked do_not_engage is written straight to that status by
-- submit_public_application(), and that receipt creates no Kit work at all:
-- no subscriber, no tag, nothing removed. The submitter still gets the same
-- undifferentiated response they get today.
create or replace function public.enqueue_kit_application_receipt()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status = 'pending' then
    perform public.enqueue_kit_application_sync(new.id, 'applicant', 'applicant');
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Decision
-- ---------------------------------------------------------------------------
-- reviewApplication.ts records a decision as four separate browser writes, so
-- there is no shared transaction to hook. There is, however, one write that
-- IS the decision — applications.status leaving 'pending' — and a trigger on
-- it runs inside that statement's own transaction. That is the boundary.
--
-- The Kit intent is created AFTER the decision row is written, by the same
-- statement, so a Kit failure cannot roll it back: nothing in this path ever
-- raises. The worst case is a pending row in the outbox and a card asking Leif
-- to retry.
--
-- Guarded on the application already being Kit-managed — that is, on its
-- applicant operation existing. One condition carries all of it: right origin,
-- after the boundary, mapped programme, usable email. It is also what keeps
-- the five real applicants who predate this integration from being tagged the
-- moment Leif reviews them: their receipt was never Kit-managed, so their
-- decision is not either, and adopting them stays a deliberate act.
--
-- do_not_engage is absent from the list for the same reason it is absent from
-- the mapping: that decision stays inside the CRM.
create or replace function public.enqueue_kit_application_decision()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.status = 'pending'
     and new.status in (
       'approved', 'needs_higher_care', 'not_fit',
       'offered_other_programme', 'bespoke_accepted', 'bespoke_denied'
     )
     and exists (
       select 1 from kit_sync_operations
        where application_id = new.id and kind = 'applicant'
     )
  then
    perform public.enqueue_kit_application_sync(new.id, 'decision', new.status);
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner retry
-- ---------------------------------------------------------------------------
-- What the "Retry Kit sync" button reaches, through the Edge Function that
-- holds the credential. It only ever returns failed work to pending; it cannot
-- create an operation, cannot choose a tag, and cannot touch a succeeded row,
-- so pressing it twice — or pressing it after it worked — is safe.
create or replace function public.retry_kit_application_sync(p_application_id bigint)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  update kit_sync_operations
     set status = 'pending',
         failure_class = null,
         failure_reason = null,
         failed_at = null,
         updated_at = now()
   where application_id = p_application_id
     and status = 'failed';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- The worker's claim
-- ---------------------------------------------------------------------------
-- `for update skip locked` so two overlapping runs — the five-minute cron and
-- Leif pressing Retry — cannot both take the same operation, and so a row one
-- worker is holding never blocks the other from getting on with someone else's.
--
-- A 'processing' row whose attempt started more than ten minutes ago is
-- reclaimed: the only way to be there that long is a worker that died mid-call,
-- and an operation stuck forever in processing is invisible work, which is the
-- failure mode this whole slice exists to end.
create or replace function public.claim_kit_sync_operations(p_limit integer default 25)
returns setof public.kit_sync_operations
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  return query
  update kit_sync_operations o
     set status = 'processing',
         attempts = o.attempts + 1,
         last_attempt_at = now(),
         updated_at = now()
   where o.id in (
     select c.id from kit_sync_operations c
      where c.status = 'pending'
         or (c.status = 'processing' and c.last_attempt_at < now() - interval '10 minutes')
      order by c.created_at
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning o.*;
end;
$$;


-- ---------------------------------------------------------------------------
-- One insert path for every Kit operation
-- ---------------------------------------------------------------------------
-- Automatic receipt, automatic cohort tag, automatic decision and manual owner
-- tagging all arrive here. Resolving WHICH tag is the caller's job; getting a
-- durable, idempotent, evidence-shaped row is this function's.
--
-- Returns the operation id, or null when there is nothing to do — an unusable
-- email, or a request that already exists.
-- The waitlist invitation this operation belongs to, when it belongs to one.
-- Added by 20261010120000; the declarative source described the earlier
-- SEVEN-argument shape for a while after that, which is a drift worth naming:
-- a db diff reading the old signature would have CREATED it alongside the real
-- one, and a newly created function starts with proacl NULL — which in
-- Postgres means EXECUTE TO PUBLIC. 06_grants.sql revokes the exact signature
-- below for that reason.
create or replace function public.enqueue_kit_operation(
  p_contact_id bigint,
  p_application_id bigint,
  p_kind text,
  p_origin text,
  p_kit_tag_id bigint,
  p_kit_tag_name text,
  p_requested_by text default null,
  p_waitlist_invitation_id bigint default null
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
     requested_by, waitlist_invitation_id)
  values
    (p_application_id, p_contact_id, p_kind, p_origin, v_email, p_kit_tag_id,
     coalesce(nullif(btrim(p_kit_tag_name), ''), 'tag ' || p_kit_tag_id),
     p_requested_by, p_waitlist_invitation_id)
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
  -- Every event kit_tag_mappings_event_check allows, and nothing else.
  -- It allowed eight from 20261010120000 onward while this list still had
  -- seven, so `waitlist_invited` was refused as 'event-invalid' and the
  -- picker — which checked only for an error, not the status — said saved.
  -- contracts/applications/kitMappingEvents.test.ts holds the two together.
  if p_event not in (
    'applicant', 'approved', 'needs_higher_care', 'not_fit',
    'offered_other_programme', 'bespoke_accepted', 'bespoke_denied',
    'waitlist_invited'
  ) then
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

  -- A named answer rather than a raised exception, so the picker can say what
  -- happened. enforce_bespoke_kit_separation() refuses it either way — this is
  -- the readable version of the same rule, not a softer one.
  if exists (
    select 1 from kit_tag_mappings m
     where m.offer_id = p_offer_id
       and m.kit_tag_id = p_kit_tag_id
       and m.event <> p_event
       and (
         (p_event in ('bespoke_accepted', 'bespoke_denied')
            and m.event in ('approved', 'not_fit', 'offered_other_programme'))
         or (p_event in ('approved', 'not_fit', 'offered_other_programme')
            and m.event in ('bespoke_accepted', 'bespoke_denied'))
       )
  ) then
    return jsonb_build_object(
      'status', 'tag-already-used-by-another-decision',
      'offer_id', p_offer_id, 'event', p_event);
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

CREATE OR REPLACE FUNCTION "public"."adopt_imported_application"("p_application_id" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_app applications%ROWTYPE;
  v_offer offers%ROWTYPE;
  v_contact contacts%ROWTYPE;
  v_cohort cohorts%ROWTYPE;
  v_deal deals%ROWTYPE;
  v_exact_count integer;
  v_other deals%ROWTYPE;
  v_reused boolean := false;
  v_pending_app_id bigint;
BEGIN
  SELECT * INTO v_app FROM applications WHERE id = p_application_id;
  IF v_app.id IS NULL THEN
    RETURN jsonb_build_object('status', 'application-invalid');
  END IF;

  -- Adoption is a statement about an IMPORTED record. A live submission is
  -- already current by construction and has nothing to adopt.
  IF v_app.source <> 'historical_import' THEN
    RETURN jsonb_build_object('status', 'not-imported', 'source', v_app.source);
  END IF;

  -- Idempotent, and the first thing checked after provenance: a replay, a
  -- double click and a retry all land here and write nothing.
  IF v_app.crm_adopted_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already-adopted',
      'application_id', v_app.id,
      'opportunity_id', v_app.opportunity_id,
      'adopted_at', v_app.crm_adopted_at
    );
  END IF;

  -- Only statuses whose mapping to the current lifecycle is PROVEN. 'pending'
  -- maps to the CRM's own first pipeline stage and nothing has to be invented.
  -- An imported 'approved' would need a stage for a decision made outside this
  -- system at an unknown time (reviewed_at is null on all 59 of them), and
  -- 'denied' and 'waitlist' are old vocabulary with no modern equivalent that
  -- is not a guess. Refused by name so the UI can say which.
  IF v_app.status <> 'pending' THEN
    RETURN jsonb_build_object('status', 'status-unsupported', 'application_status', v_app.status);
  END IF;

  -- The same narrow condition classifyApplication() uses to call an imported
  -- record current work. Without it, 99 old questionnaires become adoptable.
  IF v_app.intended_cohort_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no-open-cohort');
  END IF;
  SELECT * INTO v_cohort FROM cohorts WHERE id = v_app.intended_cohort_id;
  IF v_cohort.id IS NULL OR v_cohort.status <> 'applications_open' THEN
    RETURN jsonb_build_object('status', 'no-open-cohort', 'cohort_status', v_cohort.status);
  END IF;

  SELECT * INTO v_offer FROM offers WHERE id = v_app.offer_id AND is_active;
  IF v_offer.id IS NULL THEN
    RETURN jsonb_build_object('status', 'offer-invalid');
  END IF;

  SELECT * INTO v_contact FROM contacts WHERE id = v_app.contact_id;
  IF v_contact.id IS NULL THEN
    RETURN jsonb_build_object('status', 'contact-invalid');
  END IF;

  -- The same durable "no future direct sales" gate every path that would
  -- start a sales process honours.
  IF v_contact.sales_eligibility = 'do_not_engage' THEN
    RETURN jsonb_build_object('status', 'do-not-engage');
  END IF;

  -- Serialize this person+programme+round for the rest of the transaction, so
  -- two clicks cannot both read "no Opportunity" and both create one.
  PERFORM pg_advisory_xact_lock(
    hashtext('adopt_imported_application:' || v_app.contact_id || ':' || v_app.offer_id
             || ':' || v_app.intended_cohort_id)
  );

  -- Re-read under the lock: the other transaction may have just adopted it.
  SELECT * INTO v_app FROM applications WHERE id = p_application_id;
  IF v_app.crm_adopted_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already-adopted',
      'application_id', v_app.id,
      'opportunity_id', v_app.opportunity_id,
      'adopted_at', v_app.crm_adopted_at
    );
  END IF;

  IF v_app.opportunity_id IS NOT NULL THEN
    -- Nothing was blocked; it already had its Opportunity. Record the act and
    -- touch nothing else.
    UPDATE applications SET crm_adopted_at = now() WHERE id = v_app.id;
    RETURN jsonb_build_object(
      'status', 'adopted',
      'application_id', v_app.id,
      'opportunity_id', v_app.opportunity_id,
      'created_opportunity', false,
      'reused_opportunity', true
    );
  END IF;

  -- One active sales attempt per person per Offer per Cohort, via the same
  -- canonical predicate every other path uses.
  SELECT count(*) INTO v_exact_count
  FROM deals d
  WHERE d.contact_id = v_app.contact_id
    AND d.offer_id = v_app.offer_id
    AND d.cohort_id = v_app.intended_cohort_id
    AND public.deal_is_active(d.archived_at, d.stage, d.outcome);

  IF v_exact_count > 1 THEN
    -- The invariant says this cannot happen. If it ever does, ownership of the
    -- Application is a question about the business, so nobody guesses.
    RETURN jsonb_build_object('status', 'ambiguous-opportunity', 'candidates', v_exact_count);
  END IF;

  IF v_exact_count = 1 THEN
    SELECT * INTO v_deal
    FROM deals d
    WHERE d.contact_id = v_app.contact_id
      AND d.offer_id = v_app.offer_id
      AND d.cohort_id = v_app.intended_cohort_id
      AND public.deal_is_active(d.archived_at, d.stage, d.outcome);

    -- Already past the point a review speaks to. Approving writes
    -- stage='approved' onto the Opportunity, which from call_booked or
    -- decision would drag a live sale BACKWARD. Same rule, same list, same
    -- refusal create_manual_application() makes.
    IF coalesce(
         array_position(
           array['interested', 'application_received', 'approved', 'call_booked', 'decision'],
           v_deal.stage),
         0) NOT BETWEEN 1 AND 3
    THEN
      RETURN jsonb_build_object(
        'status', 'later-stage',
        'opportunity_id', v_deal.id,
        'stage', v_deal.stage
      );
    END IF;

    -- One Opportunity is one claim on one decision.
    --
    -- Found by the adversarial pre-use gate. create_manual_application()
    -- refuses exactly this shape and says why: "a second pending Application
    -- against one live sale is two claims on the same decision". Adoption
    -- reused the Opportunity regardless, so two pending Applications could end
    -- up pointing at it — and approving either one moves the shared
    -- Opportunity, leaving the other reading pending against a decision that
    -- has already been made.
    --
    -- Refused by name instead, with the Application already waiting, so Leif
    -- can see whether these are two records of the same person.
    SELECT a.id INTO v_pending_app_id
      FROM applications a
     WHERE a.opportunity_id = v_deal.id
       AND a.status = 'pending'
       AND a.id <> v_app.id
     ORDER BY a.id DESC
     LIMIT 1;

    IF v_pending_app_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'already-pending',
        'application_id', v_pending_app_id,
        'opportunity_id', v_deal.id
      );
    END IF;

    v_reused := true;
  ELSE
    -- No Opportunity at this round's scope. Before opening one, check the
    -- person is not already being sold this same programme on another
    -- footing: deals 267 and 268 are live GYU conversations carrying no
    -- cohort at all, and opening a second live Opportunity beside one of them
    -- would be a duplicate in everything but the letter of the invariant.
    -- Refused, named, and left for Leif.
    SELECT * INTO v_other
    FROM deals d
    WHERE d.contact_id = v_app.contact_id
      AND d.offer_id = v_app.offer_id
      AND public.deal_is_active(d.archived_at, d.stage, d.outcome)
    ORDER BY d.id ASC
    LIMIT 1;

    IF v_other.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'other-active-sale',
        'opportunity_id', v_other.id,
        'stage', v_other.stage
      );
    END IF;

    -- The canonical Application Received Opportunity, the same shape
    -- create_manual_application() writes. entry_path is 'other': no public
    -- form produced this, and the offer/cohort validation, commercial
    -- snapshot, Contact-derived name, stage_entered_at, stage event and
    -- waitlist conversion are all written by the deals triggers, which is why
    -- this is a plain INSERT and not a second copy of those rules.
    INSERT INTO deals (
      contact_id, offer_id, cohort_id, stage, outcome, owner_decision,
      amount, entry_path, description
    ) VALUES (
      v_app.contact_id, v_app.offer_id, v_app.intended_cohort_id,
      'application_received', NULL, NULL, v_offer.current_price, 'other', ''
    ) RETURNING * INTO v_deal;
  END IF;

  -- The only columns adoption is allowed to touch. Status, source,
  -- raw_answers, submitted_at, reviewed_at, offer and cohort are all left
  -- exactly as imported.
  UPDATE applications
     SET opportunity_id = v_deal.id,
         crm_adopted_at = now()
   WHERE id = v_app.id;

  RETURN jsonb_build_object(
    'status', 'adopted',
    'application_id', v_app.id,
    'opportunity_id', v_deal.id,
    'created_opportunity', NOT v_reused,
    'reused_opportunity', v_reused
  );
END;
$$;

create or replace function public.review_application(
  p_application_id bigint,
  p_outcome text,
  p_cohort_id bigint default null
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_app applications%rowtype;
  v_deal deals%rowtype;
  v_task_id bigint;
  v_reviewed_at timestamptz;
  v_recommended_offer_id bigint;
  v_recommended offers%rowtype;
  v_candidates int;
  v_destination_cohort_id bigint;
  v_eligible_cohorts int;
begin
  -- The decisions a live review can record. 'denied' and 'waitlist' are
  -- historical-import vocabulary and are not decisions anybody makes here.
  IF p_outcome NOT IN (
    'approved', 'needs_higher_care', 'not_fit', 'do_not_engage',
    'offered_other_programme', 'bespoke_accepted', 'bespoke_denied'
  ) THEN
    RETURN jsonb_build_object('status', 'outcome-invalid', 'outcome', p_outcome);
  END IF;

  -- The lock, and the whole point of this function. Everything below decides
  -- from state nobody else can move until this transaction ends.
  SELECT * INTO v_app FROM applications WHERE id = p_application_id FOR UPDATE;
  IF v_app.id IS NULL THEN
    RETURN jsonb_build_object('status', 'application-invalid');
  END IF;

  -- Re-read under the lock. A second reviewer arriving at the same moment
  -- waits here, then finds the decision already recorded and is told which —
  -- rather than both reading 'pending' and the last writer silently winning.
  IF v_app.status <> 'pending' THEN
    RETURN jsonb_build_object(
      'status', 'already-reviewed',
      'application_id', v_app.id,
      'application_status', v_app.status,
      'reviewed_at', v_app.reviewed_at
    );
  END IF;

  -- Every outcome writes to the Application AND its Opportunity, so there is
  -- nothing to record a decision against without one.
  IF v_app.opportunity_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no-opportunity', 'application_id', v_app.id);
  END IF;

  SELECT * INTO v_deal FROM deals WHERE id = v_app.opportunity_id FOR UPDATE;
  IF v_deal.id IS NULL THEN
    RETURN jsonb_build_object('status', 'opportunity-invalid', 'opportunity_id', v_app.opportunity_id);
  END IF;

  IF v_deal.contact_id IS DISTINCT FROM v_app.contact_id THEN
    RETURN jsonb_build_object(
      'status', 'opportunity-mismatch',
      'opportunity_id', v_deal.id,
      'opportunity_contact_id', v_deal.contact_id,
      'application_contact_id', v_app.contact_id
    );
  END IF;

  -- ---- what recommending the other programme needs before it writes -------
  IF p_outcome = 'offered_other_programme' THEN
    -- Direction is not asked, because there is only one other programme to
    -- move to. If that ever stops being true this refuses rather than
    -- guessing which one Leif meant.
    SELECT count(*), min(id) INTO v_candidates, v_recommended_offer_id
      FROM offers WHERE is_active AND id IS DISTINCT FROM v_deal.offer_id;
    IF v_candidates <> 1 THEN
      RETURN jsonb_build_object(
        'status', 'recommendation-ambiguous',
        'candidates', v_candidates
      );
    END IF;
    SELECT * INTO v_recommended FROM offers WHERE id = v_recommended_offer_id;

    -- An enrolled client's programme is not an application decision. That
    -- move is transfer_enrolled_opportunity_offer()'s, because it has to
    -- carry an onboarding checklist and its Tasks with it.
    IF EXISTS (SELECT 1 FROM enrollments WHERE opportunity_id = v_deal.id) THEN
      RETURN jsonb_build_object('status', 'already-enrolled', 'opportunity_id', v_deal.id);
    END IF;

    -- handle_deal_saved() refuses an offer change while a scholarship slot is
    -- held. Named here so the page can say why instead of showing a raised
    -- exception.
    IF v_deal.pricing_mode = 'scholarship' THEN
      RETURN jsonb_build_object('status', 'scholarship-held', 'opportunity_id', v_deal.id);
    END IF;

    -- A round, when the destination has rounds.
    --
    -- Assign where there is nothing to choose between; refuse where there is
    -- nothing to assign; ask where there is a choice. Never infer one, because
    -- nothing in this CRM infers a round and the answer becomes part of
    -- somebody's history.
    IF v_recommended.type = 'group' THEN
      SELECT count(*) INTO v_eligible_cohorts
        FROM public.offer_accepting_cohorts(v_recommended_offer_id);

      IF v_eligible_cohorts = 0 THEN
        -- Refused rather than written cohortless. A GYU sale with no round
        -- wins into a client with no round and no start date.
        RETURN jsonb_build_object(
          'status', 'no-eligible-cohort',
          'recommended_offer_id', v_recommended_offer_id,
          'recommended_offer_name', v_recommended.name
        );
      END IF;

      IF p_cohort_id IS NOT NULL THEN
        -- Leif chose. It still has to be a round of the recommended programme
        -- that is actually taking people, so a stale tab cannot place somebody
        -- in a round that closed while it was open.
        IF NOT EXISTS (
          SELECT 1 FROM public.offer_accepting_cohorts(v_recommended_offer_id) c
           WHERE c.id = p_cohort_id
        ) THEN
          RETURN jsonb_build_object(
            'status', 'cohort-invalid',
            'cohort_id', p_cohort_id,
            'recommended_offer_id', v_recommended_offer_id
          );
        END IF;
        v_destination_cohort_id := p_cohort_id;
      ELSIF v_eligible_cohorts = 1 THEN
        SELECT c.id INTO v_destination_cohort_id
          FROM public.offer_accepting_cohorts(v_recommended_offer_id) c;
      ELSE
        -- Two rounds are both open. Which one somebody joins is a real
        -- decision, so it is asked for rather than guessed.
        RETURN jsonb_build_object(
          'status', 'cohort-choice-required',
          'recommended_offer_id', v_recommended_offer_id,
          'recommended_offer_name', v_recommended.name,
          'candidates', (
            SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
                             ORDER BY c.applications_close_at NULLS LAST, c.id)
              FROM public.offer_accepting_cohorts(v_recommended_offer_id) c
          )
        );
      END IF;
    END IF;
  END IF;

  v_reviewed_at := now();

  -- 1. The decision itself. This UPDATE is what fires
  --    on_application_kit_decision, inside this transaction, once.
  UPDATE applications
     SET status = p_outcome,
         reviewed_at = v_reviewed_at,
         recommended_offer_id = v_recommended_offer_id
   WHERE id = v_app.id;

  -- 2. The Opportunity, aligned with it.
  IF p_outcome = 'approved' THEN
    -- "Qualified enough for a sales call" — the pipeline moves forward; final
    -- personal fit is still undecided. outcome is explicitly re-cleared in
    -- case a prior review round set one.
    UPDATE deals SET stage = 'approved', outcome = NULL WHERE id = v_deal.id;
  ELSIF p_outcome = 'bespoke_accepted' THEN
    -- Accepted is accepted. The only thing bespoke changes is who writes the
    -- reply, so the operational approved path stays exactly as available.
    UPDATE deals SET stage = 'approved', outcome = NULL WHERE id = v_deal.id;
  ELSIF p_outcome = 'offered_other_programme' THEN
    -- The sales path moves to the recommended programme and behaves like that
    -- programme's approved path. The SAME Opportunity: nothing here creates a
    -- second one.
    --
    -- A round belongs to the programme that has rounds, and the round was
    -- settled above: assigned when exactly one is taking people, chosen by
    -- Leif when several are, and the decision refused outright when none is.
    -- Moving into an individual programme leaves any round behind, exactly as
    -- transfer_enrolled_opportunity_offer() does.
    UPDATE deals
       SET offer_id = v_recommended_offer_id,
           -- The round resolved above for a group destination, and NULL for an
           -- individual one, which is how a GYU applicant offered The Living
           -- Example leaves their old round behind. Their APPLICATION keeps
           -- it: intended_cohort_id is what they asked for and is never
           -- rewritten here.
           cohort_id = v_destination_cohort_id,
           stage = 'approved',
           outcome = NULL
     WHERE id = v_deal.id;
  ELSIF p_outcome = 'needs_higher_care' THEN
    UPDATE deals SET outcome = 'needs_higher_care' WHERE id = v_deal.id;
  ELSIF p_outcome = 'not_fit' THEN
    UPDATE deals SET outcome = 'not_fit' WHERE id = v_deal.id;
  ELSIF p_outcome = 'bespoke_denied' THEN
    -- Denied is denied, and reads as the same exit everywhere that counts
    -- exits. Only the reply is different.
    UPDATE deals SET outcome = 'not_fit' WHERE id = v_deal.id;
  ELSE
    UPDATE deals SET outcome = 'lost', owner_decision = 'do_not_engage' WHERE id = v_deal.id;
    -- The durable Contact-level gate. Never erases the Contact, never touches
    -- unrelated history.
    UPDATE contacts SET sales_eligibility = 'do_not_engage' WHERE id = v_app.contact_id;
  END IF;

  -- 3. The Review Application task closes because the review happened — never
  --    the reverse. Same heuristic as reviewApplicationTask.ts: the oldest
  --    still-open review_application task for this Contact.
  SELECT t.id INTO v_task_id
    FROM tasks t
   WHERE t.contact_id = v_app.contact_id
     AND t.type = 'review_application'
     AND t.done_date IS NULL
   ORDER BY t.id ASC
   LIMIT 1;

  IF v_task_id IS NOT NULL THEN
    UPDATE tasks
       SET done_date = v_reviewed_at,
           status = 'completed'
     WHERE id = v_task_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'reviewed',
    'application_id', v_app.id,
    'application_status', p_outcome,
    'opportunity_id', v_deal.id,
    'reviewed_at', v_reviewed_at,
    'recommended_offer_id', v_recommended_offer_id,
    'destination_cohort_id', v_destination_cohort_id,
    'completed_task_id', v_task_id
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Asking for a testimonial, twice, and then stopping (20261006120000)
-- ---------------------------------------------------------------------------
-- The sequence deliberately hangs off the Enrollment and the task system
-- rather than off an offboarding requirement item:
-- enforce_enrollment_completion_requirements() refuses
-- offboarding -> completed while a required item is undone, and a
-- testimonial depends on the client replying. Completing a stage means
-- Leif ASKED; only enrollments.testimonial_received_at means it ARRIVED.
-- Day 0 is the entered_at of the Enrollment's 'offboarding' status event,
-- which survives the Enrollment later becoming completed or ended.

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

-- One definition of "in the sequence": either Leif put this client in by
-- hand, or their programme was already asking when they offboarded.
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


-- ---------------------------------------------------------------------------
-- A decision can recommend the other programme (20261008140000)
-- ---------------------------------------------------------------------------
create or replace function public.enforce_bespoke_kit_separation()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_bespoke constant text[] := array['bespoke_accepted', 'bespoke_denied'];
  v_sending constant text[] := array['approved', 'not_fit', 'offered_other_programme'];
  v_clash text;
begin
  if new.event = any (v_bespoke) then
    new.followup_mode := 'manual_email';
    new.automation_name := null;

    select m.event into v_clash
      from kit_tag_mappings m
     where m.offer_id = new.offer_id
       and m.event = any (v_sending)
       and m.kit_tag_id = new.kit_tag_id
     limit 1;
    if v_clash is not null then
      raise exception
        'Tag % is already this programme''s % tag, so a bespoke decision cannot use it',
        new.kit_tag_name, v_clash
        using hint = 'A bespoke decision must apply a tag of its own, because an automation attached to the shared one would send the standard reply to somebody you meant to answer yourself.';
    end if;
  end if;

  -- And the same refusal from the other direction, so the order the two
  -- mappings are configured in cannot decide whether the rule holds.
  if new.event = any (v_sending) then
    select m.event into v_clash
      from kit_tag_mappings m
     where m.offer_id = new.offer_id
       and m.event = any (v_bespoke)
       and m.kit_tag_id = new.kit_tag_id
     limit 1;
    if v_clash is not null then
      raise exception
        'Tag % is already this programme''s % tag, so it cannot also be the % tag',
        new.kit_tag_name, v_clash, new.event
        using hint = 'A bespoke decision must apply a tag of its own, because an automation attached to the shared one would send the standard reply to somebody you meant to answer yourself.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.record_recommended_programme_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from applications a
     where a.opportunity_id = new.id
       and a.status = 'offered_other_programme'
       and a.recommended_offer_id = new.offer_id
  ) then
    return null;
  end if;

  if exists (select 1 from enrollments where opportunity_id = new.id) then
    return null;
  end if;

  -- A replay cannot double the history.
  if exists (
    select 1 from deal_offer_events e
     where e.opportunity_id = new.id
       and e.from_offer_id = old.offer_id
       and e.to_offer_id = new.offer_id
  ) then
    return null;
  end if;

  insert into deal_offer_events
    (opportunity_id, enrollment_id, from_offer_id, to_offer_id, source, note)
  values
    (new.id, null, old.offer_id, new.offer_id, 'app',
     'The sales path moved because their application was answered with a recommendation to the other programme. The application itself still records the programme they applied for.');

  return null;
end;
$$;


-- ---------------------------------------------------------------------------
-- Configuring what a programme offers (20261009120000)
-- ---------------------------------------------------------------------------
-- Superseded by the 9-argument form in the Deposits section at the end of
-- this file (20261016140000): the signature gained p_deposit_amount.


create or replace function public.set_offer_payment_option_active(
  p_option_id bigint,
  p_is_active boolean
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existing offer_payment_options%rowtype;
begin
  select * into v_existing from offer_payment_options
   where id = p_option_id for update;
  if v_existing.id is null then
    return jsonb_build_object('status', 'option-invalid');
  end if;

  update offer_payment_options
     set is_active = coalesce(p_is_active, false), updated_at = now()
   where id = p_option_id;

  return jsonb_build_object(
    'status', 'set', 'option_id', p_option_id,
    'is_active', coalesce(p_is_active, false));
end;
$$;

-- ---------------------------------------------------------------------------
-- An episode is history, and history does not change its mind
-- ---------------------------------------------------------------------------
-- CHECK constraints are row-local: they see NEW and nothing else, so they
-- cannot express "this column may not change" or "closed may not become
-- active again". Those are OLD-versus-NEW questions, and in this schema that
-- means a BEFORE UPDATE trigger — the shape
-- reject_application_response_mutation() already uses for an immutable
-- submission record, including its app.migration_mode escape hatch.
--
-- WHAT THIS PROTECTS. An Outreach attempt is the durable record of one
-- invitation episode. If its Opportunity, its source, its start or its
-- originating invitation could be rewritten, the history would say something
-- that never happened. And if a closed attempt could be set active again, a
-- second outreach cycle would overwrite the first instead of standing beside
-- it — which is exactly what §4b says must not happen. A genuinely new cycle
-- is a NEW row.
--
-- IT ALSO MAINTAINS updated_at. Everywhere else in this schema updated_at is
-- written by whoever happens to be doing the UPDATE, and
-- waitlist_entries.updated_at proves how that ends: it still read 2026-09-17
-- on a row whose status had changed that same day, and a zero-mutation proof
-- built on it was wrong. A column that looks authoritative and is not is
-- worse than no column, so this one is set by the database on every update
-- and never trusted from the caller.
create or replace function public.guard_outreach_attempt_mutation()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  -- The backfill of the 11 Oct invitations runs as a migration and may need
  -- to correct what it wrote; the same hatch every other guard here uses.
  if current_setting('app.migration_mode', true) = 'true' then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.opportunity_id is distinct from old.opportunity_id
     or new.source is distinct from old.source
     or new.started_at is distinct from old.started_at
     or new.schedule_key is distinct from old.schedule_key
     or new.waitlist_invitation_id is distinct from old.waitlist_invitation_id
     or new.created_at is distinct from old.created_at
  then
    raise exception
      'application_outreach_attempts: identity and provenance are immutable'
      using hint = 'id, opportunity_id, source, started_at, schedule_key, waitlist_invitation_id and created_at describe an episode that already happened. A different Opportunity, source, schedule or invitation is a different episode: insert a new attempt.';
  end if;

  if old.status = 'closed' then
    raise exception
      'application_outreach_attempts: a closed attempt is history and cannot be changed'
      using hint = 'Re-inviting somebody starts a NEW attempt beside this one. Closed attempts are never reopened, so the record of what was tried before survives.';
  end if;

  -- Set by the database, never taken from the caller.
  new.updated_at := now();
  return new;
end;
$$;

-- §4b Phase 2C: what a delivered Day-0 invitation means for the pipeline.
-- Mirrors migration 20261014140000. DORMANT -- nothing calls it yet.
-- Delivery truth is waitlist_invitations.status = 'sent', which
-- waitlist_invitations_sent_evidence_check guarantees carries a sent_at and a
-- delivery_method. executor = 'gmail' claims future follow-up, never that
-- Gmail sent Day 0. Business truth -- not a caller flag -- decides whether the
-- episode opens active or is recorded as concluded history.

create or replace function public.converge_delivered_invitation(
  p_invitation_id bigint,
  p_next_action_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_inv waitlist_invitations%rowtype;
  v_entry waitlist_entries%rowtype;
  v_deal deals%rowtype;
  v_contact contacts%rowtype;
  v_existing application_outreach_attempts%rowtype;
  v_app_id bigint;
  v_app_submitted_at timestamptz;
  v_client_deal_id bigint;
  v_attempt_id bigint;
  v_reused boolean := false;
begin
  -- 1. THE DELIVERED INVITATION ITSELF.
  select * into v_inv from waitlist_invitations where id = p_invitation_id for update;
  if not found then
    return jsonb_build_object('status', 'invitation-missing');
  end if;

  -- Only a genuine delivery converges. Everything else is retryable later by
  -- the same call, which is why this is a status and not an exception.
  if v_inv.status <> 'sent' or v_inv.sent_at is null then
    return jsonb_build_object(
      'status', 'invitation-not-delivered',
      'invitation_id', v_inv.id,
      'invitation_status', v_inv.status);
  end if;

  select * into v_entry from waitlist_entries where id = v_inv.waitlist_entry_id;
  if not found then
    return jsonb_build_object('status', 'invitation-invalid',
      'invitation_id', v_inv.id, 'reason', 'waitlist entry missing');
  end if;

  -- Provenance has to agree with itself before anything is written from it.
  if v_entry.contact_id is distinct from v_inv.contact_id then
    return jsonb_build_object('status', 'invitation-invalid',
      'invitation_id', v_inv.id, 'reason', 'invitation and waitlist entry disagree about the contact');
  end if;

  -- 2. IDEMPOTENCY, BEFORE ANY DECISION. One episode per delivered
  -- invitation is a database guarantee (the Phase 2A partial unique index);
  -- this makes a replay cheap and deterministic instead of a constraint
  -- violation. Worker retry, duplicate callback, lost response, an operator
  -- running reconciliation twice: all land here.
  select * into v_existing from application_outreach_attempts
   where waitlist_invitation_id = v_inv.id;
  if found then
    return jsonb_build_object(
      'status', 'already-converged',
      'invitation_id', v_inv.id,
      'opportunity_id', v_existing.opportunity_id,
      'outreach_attempt_id', v_existing.id,
      'outreach_status', v_existing.status,
      'stage', (select d.stage from deals d where d.id = v_existing.opportunity_id),
      'reused_opportunity', false);
  end if;

  select * into v_contact from contacts where id = v_inv.contact_id;
  if not found then
    return jsonb_build_object('status', 'invitation-invalid',
      'invitation_id', v_inv.id, 'reason', 'contact missing');
  end if;

  -- 3. THE DURABLE "NO FUTURE DIRECT SALES" GATE, honoured wherever a sales
  -- process would start -- before any lifecycle row is created.
  if v_contact.sales_eligibility = 'do_not_engage' then
    return jsonb_build_object('status', 'do-not-engage',
      'invitation_id', v_inv.id, 'contact_id', v_contact.id);
  end if;

  -- 4. Serialize this person+programme for the rest of the transaction, so
  -- two concurrent deliveries cannot both read "no active Opportunity" and
  -- both create one. Same key shape as create_manual_application.
  perform pg_advisory_xact_lock(
    hashtext('converge_delivered_invitation:' || v_entry.contact_id || ':'
             || v_entry.offer_id || ':' || coalesce(v_entry.cohort_id::text, '-')));

  -- 5. ALREADY A CLIENT for this programme. deal_is_active() calls a won
  -- Opportunity INACTIVE, so the active lookup below would happily open an
  -- Interested cycle beside a sale that already closed. This is the explicit
  -- check that stops it.
  select d.id into v_client_deal_id
    from deals d
   where d.contact_id = v_entry.contact_id
     and d.offer_id = v_entry.offer_id
     and (v_entry.cohort_id is null or d.cohort_id = v_entry.cohort_id)
     and d.archived_at is null
     and (d.stage in ('won', 'onboarding')
          or exists (select 1 from enrollments e where e.opportunity_id = d.id))
   order by d.id asc
   limit 1;
  if v_client_deal_id is not null then
    return jsonb_build_object(
      'status', 'already-client',
      'invitation_id', v_inv.id,
      'opportunity_id', v_client_deal_id,
      'stage', (select d.stage from deals d where d.id = v_client_deal_id),
      'reused_opportunity', false);
  end if;

  -- 6. THE SAME-OFFER ACTIVE SALES CYCLE, via the canonical predicate rather
  -- than a second definition of "active". A terminal attempt (any non-null
  -- outcome -- nurture, lost, not_fit, needs_higher_care, workshops_only) is
  -- NOT active and is deliberately not found here: a genuinely new invitation
  -- cycle gets a NEW Opportunity beside the concluded one, and the old row is
  -- never touched (deals/dealActivity.ts).
  select * into v_deal
    from deals d
   where d.contact_id = v_entry.contact_id
     and d.offer_id = v_entry.offer_id
     and (v_entry.cohort_id is null or d.cohort_id = v_entry.cohort_id)
     and public.deal_is_active(d.archived_at, d.stage, d.outcome)
   order by d.id asc
   limit 1;

  -- 7. APPLICATION ALWAYS WINS. Re-read here, inside the lock, because
  -- eligibility was judged when the invitation was prepared and the person
  -- may have applied since -- including between the provider's delivery and
  -- this call.
  if v_deal.id is not null then
    select a.id, a.submitted_at into v_app_id, v_app_submitted_at
      from applications a
     where a.opportunity_id = v_deal.id
     order by a.id desc
     limit 1;
  end if;

  if v_deal.id is not null
     and v_deal.stage in ('application_received', 'approved', 'call_booked', 'decision')
  then
    -- NO REGRESSION, and no active reminder episode for somebody already
    -- further along. The truthful historical record is the concluded episode
    -- below, when an application is what carried them there.
    if v_app_id is not null and v_app_submitted_at is not null then
      if v_app_submitted_at < v_inv.sent_at then
        -- The application predates the delivery, so this invitation did not
        -- produce it and an episode ending before it began would be a lie.
        -- Surfaced rather than invented.
        return jsonb_build_object(
          'status', 'ambiguous',
          'invitation_id', v_inv.id,
          'opportunity_id', v_deal.id,
          'stage', v_deal.stage,
          'reason', 'the same-offer application predates this delivery',
          'reused_opportunity', true);
      end if;

      -- THE CONCLUDED HISTORICAL EPISODE. We asked, they applied, the episode
      -- is over: recorded with the application's own timestamp as its end, no
      -- future moment, and therefore no reminder can ever be computed for it.
      insert into application_outreach_attempts (
        opportunity_id, source, channel, executor, schedule_key,
        status, started_at, step,
        next_action_at, externally_managed_until,
        ended_at, end_reason, resulting_application_id, waitlist_invitation_id
      ) values (
        v_deal.id, 'waitlist', 'email', 'gmail', 'application_outreach_v1',
        'closed', v_inv.sent_at, 0,
        null, null,
        v_app_submitted_at, 'application_submitted', v_app_id, v_inv.id
      ) returning id into v_attempt_id;

      return jsonb_build_object(
        'status', 'application-already-submitted',
        'invitation_id', v_inv.id,
        'opportunity_id', v_deal.id,
        'outreach_attempt_id', v_attempt_id,
        'outreach_status', 'closed',
        'application_id', v_app_id,
        'stage', v_deal.stage,
        'reused_opportunity', true);
    end if;

    return jsonb_build_object(
      'status', 'already-later-stage',
      'invitation_id', v_inv.id,
      'opportunity_id', v_deal.id,
      'stage', v_deal.stage,
      'reused_opportunity', true);
  end if;

  -- 8. From here an ACTIVE episode is being opened, which needs its first
  -- future moment. The calendar has ONE semantic authority
  -- (outreach/applicationOutreachSchedule.ts); this command does not hold a
  -- day offset and so cannot recompute it. What it CAN enforce is that the
  -- moment exists and genuinely lies after Day 0.
  if p_next_action_at is null or p_next_action_at <= v_inv.sent_at then
    return jsonb_build_object(
      'status', 'invalid-next-action',
      'invitation_id', v_inv.id,
      'reason', 'an active episode needs a next action strictly after its Day-0 delivery');
  end if;

  if v_deal.id is not null then
    -- An active Interested cycle for this programme already exists: reuse it.
    -- No second Opportunity, and nothing written to deals -- so
    -- on_deal_waitlist_sync does not fire on this branch either.
    v_reused := true;

    if exists (select 1 from application_outreach_attempts
                where opportunity_id = v_deal.id and status = 'active') then
      -- One running episode per Opportunity. The database enforces it; this
      -- returns the existing lifecycle instead of provoking the violation.
      select * into v_existing from application_outreach_attempts
       where opportunity_id = v_deal.id and status = 'active';
      return jsonb_build_object(
        'status', 'already-converged',
        'invitation_id', v_inv.id,
        'opportunity_id', v_deal.id,
        'outreach_attempt_id', v_existing.id,
        'outreach_status', v_existing.status,
        'stage', v_deal.stage,
        'reused_opportunity', true);
    end if;
  else
    -- 9. THE NEW INTERESTED CYCLE. entry_path is 'other', never
    -- 'application_form': no form produced this, and saying one did is the
    -- lie create_manual_application avoids for the same reason. Everything
    -- else an Opportunity needs -- the commercial snapshot, the
    -- Contact-derived name, stage_entered_at, the stage event -- is written
    -- by the deals triggers, which is why this is a plain INSERT.
    --
    -- And at stage 'interested' the waitlist place is NOT spent:
    -- handle_deal_waitlist_sync converts only from application_received
    -- onward (Phase 2A0, §8r). Being invited is not the same as having
    -- started, so the entry stays 'invited' and nothing here converts it.
    insert into deals (
      contact_id, offer_id, cohort_id, stage, outcome, owner_decision,
      amount, entry_path, description
    )
    select v_entry.contact_id, v_entry.offer_id, v_entry.cohort_id,
           'interested', null, null, o.current_price, 'other', ''
      from offers o where o.id = v_entry.offer_id
    returning * into v_deal;

    if v_deal.id is null then
      return jsonb_build_object('status', 'invitation-invalid',
        'invitation_id', v_inv.id, 'reason', 'offer missing for the waitlist entry');
    end if;
  end if;

  -- 10. EXACTLY ONE ACTIVE EPISODE, governed by v1, anchored to the real
  -- Day-0 delivery, with Day 0 already behind it (step 0) and never resent.
  insert into application_outreach_attempts (
    opportunity_id, source, channel, executor, schedule_key,
    status, started_at, step,
    next_action_at, externally_managed_until, waitlist_invitation_id
  ) values (
    v_deal.id, 'waitlist', 'email', 'gmail', 'application_outreach_v1',
    'active', v_inv.sent_at, 0,
    p_next_action_at, null, v_inv.id
  ) returning id into v_attempt_id;

  return jsonb_build_object(
    'status', case when v_reused then 'reused' else 'created' end,
    'invitation_id', v_inv.id,
    'opportunity_id', v_deal.id,
    'outreach_attempt_id', v_attempt_id,
    'outreach_status', 'active',
    'stage', v_deal.stage,
    'next_action_at', p_next_action_at,
    'reused_opportunity', v_reused);
end;
$fn$;

-- SERVICE-OWNED. This command writes application_outreach_attempts, a table
-- `authenticated` deliberately cannot write at all (§8s), and it opens a sales
-- cycle. There is no UI caller and there is not meant to be one: it runs from
-- the delivery path. So unlike create_manual_application -- a signed-in owner
-- action -- this is granted to service_role ALONE.
revoke all on function public.converge_delivered_invitation(bigint, timestamptz) from public;
revoke all on function public.converge_delivered_invitation(bigint, timestamptz) from anon;
revoke all on function public.converge_delivered_invitation(bigint, timestamptz) from authenticated;
grant execute on function public.converge_delivered_invitation(bigint, timestamptz) to service_role;

-- ============================================================================
-- LIVE FUNCTION AUTHORITY MIRRORED FROM PRODUCTION (2026-10-14)
--
-- These ten functions were live in production and absent from this file.
--
-- WHY IT MATTERS, stated accurately after actually checking. AGENTS.md calls
-- this directory the source of truth and says migrations are "auto-generated"
-- from it, and a first pass here claimed `supabase db diff` would therefore
-- propose DROPping a function missing from this file. **That is not what the
-- CLI does.** `supabase db diff --help` (2.121.0) says it compares "a shadow
-- built from supabase/migrations with a live database" and that "declarative
-- files under supabase/schemas are not part of this baseline" -- there is no
-- `schema_paths` configured, and the diff never reads this file. So the DROP
-- risk is not real in this configuration.
--
-- What is real: this file is the human reference for what the database
-- contains, the thing a reader and a reviewer trust, and the place anyone
-- following AGENTS.md will look and edit. A live function missing from it is
-- a lie in the documented source of truth, and the next person to edit a
-- neighbouring definition has no way to see that the authority exists.
--
-- Nothing here is new, redesigned or tidied. Each definition is production's
-- own `pg_get_functiondef` output, and each body was verified byte-identical
-- to the migration that last established it before being copied. The grants
-- are derived from production's `proacl`, not transcribed from migration text.
--
-- The clean room could never have caught this, because it replays MIGRATIONS
-- rather than this file. `contracts/schema/liveFunctionsAreDeclared.test.ts`
-- is what catches it now.
-- ============================================================================

-- The invitation eligibility authority. Every exclusion reason the preflight shows comes from here, which is why invite_from_preflight re-asks it at consume time.
CREATE OR REPLACE FUNCTION public.waitlist_invitation_candidates(p_offer_id bigint, p_cohort_id bigint DEFAULT NULL::bigint)
 RETURNS TABLE(waitlist_entry_id bigint, contact_id bigint, contact_name text, email text, joined_at timestamp with time zone, cohort_id bigint, eligible boolean, exclusion_reason text, rank_if_eligible bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with waiting as (
    select w.*
      from waitlist_entries w
     where w.offer_id = p_offer_id
       and (p_cohort_id is null or w.cohort_id = p_cohort_id)
       and w.status in ('waiting', 'invited')
  ),
  -- A person may hold more than one place for the same programme: a general
  -- one and a round's. That is two records of intent and one person, and
  -- inviting both would tag them twice. The oldest place is the one that
  -- carries the invitation.
  oldest_per_person as (
    select distinct on (w.contact_id) w.*
      from waiting w
     order by w.contact_id, w.joined_at asc, w.id asc
  ),
  judged as (
    select
      w.id as waitlist_entry_id,
      w.contact_id,
      btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))
        as contact_name,
      (select a.normalized_email
         from contact_email_addresses a
        where a.contact_id = w.contact_id
        order by a.normalized_email
        limit 1) as email,
      w.joined_at,
      w.cohort_id,
      case
        -- Already holding an invitation for this programme. Re-inviting is a
        -- real workflow, but it is a decision rather than part of "the
        -- oldest N who have not been asked".
        when w.status = 'invited' then 'already-invited'
        when exists (
          select 1 from waitlist_invitations i
           where i.waitlist_entry_id = w.id and i.status = 'sent'
        ) then 'already-invited'
        -- An invitation already on its way. Asking again before Kit has
        -- answered is how somebody gets tagged twice.
        when exists (
          select 1 from waitlist_invitations i
            join kit_sync_operations o on o.waitlist_invitation_id = i.id
           where i.waitlist_entry_id = w.id
             and o.status in ('pending', 'processing')
        ) then 'invitation-in-flight'
        when c.id is null then 'contact-missing'
        when c.sales_eligibility = 'do_not_engage' then 'do-not-engage'
        when not exists (
          select 1 from contact_email_addresses a where a.contact_id = w.contact_id
        ) then 'no-email'
        -- Inviting somebody to apply who has already applied is nonsense,
        -- whatever became of the application afterwards.
        when exists (
          select 1 from applications ap
           where ap.contact_id = w.contact_id and ap.offer_id = p_offer_id
        ) then 'already-applied'
        -- Sold, or in the programme. Either way they are past being asked.
        when exists (
          select 1 from deals d
           where d.contact_id = w.contact_id and d.offer_id = p_offer_id
             and (d.stage = 'won' or exists (
                   select 1 from enrollments e
                    where e.opportunity_id = d.id
                      and e.status in ('onboarding', 'active', 'offboarding')))
        ) then 'already-a-client'
        -- Kit refused this address before. 'rejected' is the class that means
        -- Kit will say the same thing again — a suppression, a bounce, a
        -- complaint — so repeating the call is not a retry, it is the same
        -- refusal twice.
        when exists (
          select 1 from kit_sync_operations o
           where o.contact_id = w.contact_id
             and o.status = 'failed'
             and o.failure_class = 'rejected'
        ) then 'kit-refused-this-address-before'
        else null
      end as exclusion_reason
    from oldest_per_person w
    left join contacts c on c.id = w.contact_id
  )
  select
    j.waitlist_entry_id,
    j.contact_id,
    j.contact_name,
    j.email,
    j.joined_at,
    j.cohort_id,
    j.exclusion_reason is null as eligible,
    j.exclusion_reason,
    case
      when j.exclusion_reason is null
      then row_number() over (
             partition by (j.exclusion_reason is null)
             order by j.joined_at asc, j.waitlist_entry_id asc)
    end as rank_if_eligible
  from judged j
  order by j.joined_at asc, j.waitlist_entry_id asc;
$function$
;

revoke all on function public.waitlist_invitation_candidates(bigint, bigint) from public;
grant execute on function public.waitlist_invitation_candidates(bigint, bigint) to authenticated, service_role;

-- LANGUAGE sql and it calls waitlist_invitation_candidates, so it must be declared after it: a SQL body is parsed and validated when the function is created.
CREATE OR REPLACE FUNCTION public.waitlist_invitation_overlap(p_offer_a bigint, p_limit_a integer, p_offer_b bigint, p_limit_b integer)
 RETURNS TABLE(contact_id_a bigint, contact_id_b bigint, name text, email text, joined_a timestamp with time zone, joined_b timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with a as (
    select * from waitlist_invitation_candidates(p_offer_a, null)
     where eligible and rank_if_eligible <= p_limit_a
  ),
  b as (
    select * from waitlist_invitation_candidates(p_offer_b, null)
     where eligible and rank_if_eligible <= p_limit_b
  )
  select a.contact_id, b.contact_id, a.contact_name, a.email,
         a.joined_at, b.joined_at
    from a
    join b on b.contact_id = a.contact_id
           or (a.email is not null and b.email is not null and b.email = a.email)
   order by a.joined_at asc;
$function$
;

revoke all on function public.waitlist_invitation_overlap(bigint, integer, bigint, integer) from public;
grant execute on function public.waitlist_invitation_overlap(bigint, integer, bigint, integer) to authenticated, service_role;

-- The same overlap question asked of two prepared preflights rather than two offer limits.
CREATE OR REPLACE FUNCTION public.waitlist_preflight_overlap(p_preflight_a bigint, p_preflight_b bigint)
 RETURNS TABLE(contact_id_a bigint, contact_id_b bigint, name text, email text, joined_a timestamp with time zone, joined_b timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select a.contact_id, b.contact_id, a.contact_name, a.email,
         a.joined_at, b.joined_at
    from waitlist_invitation_preflight_candidates a
    join waitlist_invitation_preflight_candidates b
      on b.preflight_id = p_preflight_b
     and b.final_eligible
     and (b.contact_id = a.contact_id
          or (a.email is not null and b.email is not null and b.email = a.email))
   where a.preflight_id = p_preflight_a
     and a.final_eligible
   order by a.joined_at;
$function$
;

revoke all on function public.waitlist_preflight_overlap(bigint, bigint) from public;
grant execute on function public.waitlist_preflight_overlap(bigint, bigint) to authenticated, service_role;

-- Which cohorts of an Offer can still take somebody. Its grants live in 06_grants.sql, unlike the rest of this block.
CREATE OR REPLACE FUNCTION public.offer_accepting_cohorts(p_offer_id bigint)
 RETURNS SETOF cohorts
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select c.*
    from cohorts c
   where c.offer_id = p_offer_id
     and c.status = 'applications_open'
     and (c.applications_open_at is null
          or (now() at time zone 'America/Denver')::date >= c.applications_open_at)
     and (c.applications_close_at is null
          or (now() at time zone 'America/Denver')::date <= c.applications_close_at)
   order by c.applications_close_at nulls last, c.id;
$function$
;

-- EXECUTE grants for this function live in 06_grants.sql, which already
-- declares them; they are deliberately not duplicated here.

-- Turns a Kit operation's outcome into the invitation's own delivery truth -- this is what writes status 'sent' with delivery_method 'kit_tag' and a real sent_at.
CREATE OR REPLACE FUNCTION public.apply_waitlist_invitation_result()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_entry_id bigint;
begin
  if new.origin <> 'waitlist_invitation' then
    return new;
  end if;

  if new.status = 'succeeded' and old.status is distinct from 'succeeded' then
    update waitlist_invitations
       set status = 'sent',
           sent_at = coalesce(new.succeeded_at, now()),
           delivery_method = 'kit_tag',
           failed_at = null,
           failure_reason = null
     where id = new.waitlist_invitation_id
       and status <> 'sent'
    returning waitlist_entry_id into v_entry_id;

    -- Only a still-waiting place moves. An already-invited one is simply
    -- invited again, and its status is already what it should be.
    if v_entry_id is not null then
      update waitlist_entries
         set status = 'invited', invited_at = coalesce(new.succeeded_at, now())
       where id = v_entry_id and status = 'waiting';
    end if;

  elsif new.status = 'failed' and old.status is distinct from 'failed' then
    -- Recorded against the invitation so the batch can say who to try again,
    -- and NOBODY's waitlist place moves.
    update waitlist_invitations
       set status = 'failed',
           failed_at = coalesce(new.failed_at, now()),
           failure_reason = left(coalesce(new.failure_reason, new.failure_class,
                                          'Kit did not accept this'), 300)
     where id = new.waitlist_invitation_id
       and status <> 'sent';
  end if;

  return new;
end;
$function$
;

revoke all on function public.apply_waitlist_invitation_result() from public;

-- The owner's bulk invitation command, service_role only.
CREATE OR REPLACE FUNCTION public.invite_oldest_waiting(p_offer_id bigint, p_cohort_id bigint DEFAULT NULL::bigint, p_limit integer DEFAULT NULL::integer, p_entry_ids bigint[] DEFAULT NULL::bigint[], p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mapping kit_tag_mappings%rowtype;
  v_batch_id bigint;
  v_row record;
  v_invitation_id bigint;
  v_operation_id bigint;
  v_requested_by text;
  v_invited jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_taken integer := 0;
begin
  if p_limit is null and p_entry_ids is null then
    return jsonb_build_object('status', 'nothing-asked-for');
  end if;
  if p_limit is not null and p_limit <= 0 then
    return jsonb_build_object('status', 'nothing-asked-for');
  end if;

  -- No mapping, no invitation. A programme that has not been told which tag
  -- it means by an invitation is not ready to send one, and guessing a tag
  -- id is the one thing this architecture exists to prevent.
  select * into v_mapping from kit_tag_mappings
   where offer_id = p_offer_id and event = 'waitlist_invited';
  if not found then
    return jsonb_build_object('status', 'not-configured', 'offer_id', p_offer_id);
  end if;

  select coalesce(s.email, btrim(s.first_name || ' ' || s.last_name))
    into v_requested_by
    from sales s where s.user_id = auth.uid();

  -- Lock the places being considered, so two people clicking Invite at once
  -- cannot both claim the same person.
  perform 1 from waitlist_entries w
   where w.offer_id = p_offer_id
     and (p_cohort_id is null or w.cohort_id = p_cohort_id)
     and w.status in ('waiting', 'invited')
   order by w.id
   for update;

  insert into waitlist_invitation_batches (offer_id, cohort_id, label, status)
  values (p_offer_id, p_cohort_id,
          coalesce(nullif(btrim(p_label), ''), 'Invite to apply'), 'prepared')
  returning id into v_batch_id;

  for v_row in
    select c.*
      from waitlist_invitation_candidates(p_offer_id, p_cohort_id) c
     where (p_entry_ids is null or c.waitlist_entry_id = any (p_entry_ids))
     order by c.joined_at asc, c.waitlist_entry_id asc
  loop
    -- An asked-for person who cannot be invited is REPORTED, never silently
    -- dropped; and they do not consume one of the requested N, because the
    -- request was for N people to be invited rather than N rows to be read.
    if not v_row.eligible then
      v_skipped := v_skipped || jsonb_build_object(
        'waitlist_entry_id', v_row.waitlist_entry_id,
        'contact_id', v_row.contact_id,
        'name', v_row.contact_name,
        'email', v_row.email,
        'joined_at', v_row.joined_at,
        'reason', v_row.exclusion_reason);
      continue;
    end if;

    exit when p_limit is not null and v_taken >= p_limit;

    insert into waitlist_invitations
      (batch_id, waitlist_entry_id, contact_id, status, prepared_at)
    values (v_batch_id, v_row.waitlist_entry_id, v_row.contact_id,
            'prepared', now())
    returning id into v_invitation_id;

    v_operation_id := public.enqueue_kit_operation(
      v_row.contact_id, null, 'waitlist_invited', 'waitlist_invitation',
      v_mapping.kit_tag_id, v_mapping.kit_tag_name,
      coalesce(v_requested_by, 'owner'), v_invitation_id);

    if v_operation_id is null then
      -- enqueue refuses without a usable address. The candidate list already
      -- checks that, so reaching here means the address disappeared between
      -- the two — recorded as a skip rather than an invitation nobody can
      -- deliver.
      update waitlist_invitations
         set status = 'failed', failed_at = now(),
             failure_reason = 'No usable email address at the moment of sending'
       where id = v_invitation_id;
      v_skipped := v_skipped || jsonb_build_object(
        'waitlist_entry_id', v_row.waitlist_entry_id,
        'contact_id', v_row.contact_id,
        'name', v_row.contact_name,
        'reason', 'no-email');
      continue;
    end if;

    v_taken := v_taken + 1;
    v_invited := v_invited || jsonb_build_object(
      'waitlist_entry_id', v_row.waitlist_entry_id,
      'contact_id', v_row.contact_id,
      'name', v_row.contact_name,
      'email', v_row.email,
      'joined_at', v_row.joined_at,
      'invitation_id', v_invitation_id,
      'operation_id', v_operation_id);
  end loop;

  -- A batch that claimed nobody is not a batch. Removing it keeps the
  -- history readable: every row in it is an invitation somebody actually
  -- made.
  if v_taken = 0 then
    delete from waitlist_invitation_batches where id = v_batch_id;
    v_batch_id := null;
  end if;

  return jsonb_build_object(
    'status', case when v_taken = 0 then 'nobody-eligible' else 'queued' end,
    'batch_id', v_batch_id,
    'offer_id', p_offer_id,
    'cohort_id', p_cohort_id,
    'kit_tag_id', v_mapping.kit_tag_id,
    'kit_tag_name', v_mapping.kit_tag_name,
    'requested', coalesce(p_limit, coalesce(array_length(p_entry_ids, 1), 0)),
    'queued', v_taken,
    'invited', v_invited,
    'skipped', v_skipped);
end;
$function$
;

revoke all on function public.invite_oldest_waiting(bigint, bigint, integer, bigint[], text) from public;
grant execute on function public.invite_oldest_waiting(bigint, bigint, integer, bigint[], text) to service_role;

-- The command that consumes an approved preflight. Calls waitlist_invitation_candidates and enqueue_kit_operation, both declared above.
CREATE OR REPLACE FUNCTION public.invite_from_preflight(p_preflight_id bigint, p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pre waitlist_invitation_preflights%rowtype;
  v_mapping kit_tag_mappings%rowtype;
  v_batch_id bigint;
  v_row record;
  v_invitation_id bigint;
  v_operation_id bigint;
  v_requested_by text;
  v_invited jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_taken integer := 0;
begin
  select * into v_pre from waitlist_invitation_preflights
   where id = p_preflight_id for update;
  if not found then
    return jsonb_build_object('status', 'preflight-missing');
  end if;
  if v_pre.status <> 'open' then
    -- Already used is a SUCCESS to report, not an error to retry: the batch
    -- it made is the answer.
    return jsonb_build_object('status', 'preflight-already-used',
      'batch_id', v_pre.batch_id, 'used_at', v_pre.used_at);
  end if;
  if v_pre.expires_at < now() then
    update waitlist_invitation_preflights set status = 'expired' where id = v_pre.id;
    return jsonb_build_object('status', 'preflight-expired',
      'checked_at', v_pre.created_at);
  end if;

  select * into v_mapping from kit_tag_mappings
   where offer_id = v_pre.offer_id and event = 'waitlist_invited';
  if not found then
    return jsonb_build_object('status', 'not-configured', 'offer_id', v_pre.offer_id);
  end if;

  select coalesce(s.email, btrim(s.first_name || ' ' || s.last_name))
    into v_requested_by from sales s where s.user_id = auth.uid();

  insert into waitlist_invitation_batches (offer_id, cohort_id, label, status)
  values (v_pre.offer_id, v_pre.cohort_id,
          coalesce(nullif(btrim(p_label), ''), 'Invite to apply'), 'prepared')
  returning id into v_batch_id;

  for v_row in
    select c.*
      from waitlist_invitation_preflight_candidates c
     where c.preflight_id = v_pre.id and c.final_eligible
     order by c.final_rank
  loop
    -- The database's own answer, now. Kit is re-asked at delivery by the
    -- worker; this is the CRM half, and it has to be current.
    if not exists (
      select 1 from waitlist_invitation_candidates(v_pre.offer_id, v_pre.cohort_id) j
       where j.waitlist_entry_id = v_row.waitlist_entry_id and j.eligible
    ) then
      v_skipped := v_skipped || jsonb_build_object(
        'waitlist_entry_id', v_row.waitlist_entry_id,
        'contact_id', v_row.contact_id,
        'name', v_row.contact_name,
        'reason', 'changed-since-preflight');
      continue;
    end if;

    insert into waitlist_invitations
      (batch_id, waitlist_entry_id, contact_id, status, prepared_at)
    values (v_batch_id, v_row.waitlist_entry_id, v_row.contact_id, 'prepared', now())
    returning id into v_invitation_id;

    v_operation_id := public.enqueue_kit_operation(
      v_row.contact_id, null, 'waitlist_invited', 'waitlist_invitation',
      v_mapping.kit_tag_id, v_mapping.kit_tag_name,
      coalesce(v_requested_by, 'owner'), v_invitation_id);

    if v_operation_id is null then
      update waitlist_invitations
         set status = 'failed', failed_at = now(),
             failure_reason = 'No usable email address at the moment of sending'
       where id = v_invitation_id;
      v_skipped := v_skipped || jsonb_build_object(
        'waitlist_entry_id', v_row.waitlist_entry_id,
        'contact_id', v_row.contact_id,
        'name', v_row.contact_name,
        'reason', 'no-email');
      continue;
    end if;

    v_taken := v_taken + 1;
    v_invited := v_invited || jsonb_build_object(
      'waitlist_entry_id', v_row.waitlist_entry_id,
      'contact_id', v_row.contact_id,
      'name', v_row.contact_name,
      'email', v_row.email,
      'joined_at', v_row.joined_at,
      'invitation_id', v_invitation_id,
      'operation_id', v_operation_id);
  end loop;

  if v_taken = 0 then
    delete from waitlist_invitation_batches where id = v_batch_id;
    v_batch_id := null;
  end if;

  update waitlist_invitation_preflights
     set status = 'used', used_at = now(), batch_id = v_batch_id
   where id = v_pre.id;

  return jsonb_build_object(
    'status', case when v_taken = 0 then 'nobody-eligible' else 'queued' end,
    'preflight_id', v_pre.id,
    'batch_id', v_batch_id,
    'offer_id', v_pre.offer_id,
    'kit_tag_id', v_mapping.kit_tag_id,
    'kit_tag_name', v_mapping.kit_tag_name,
    'requested', v_pre.requested,
    'queued', v_taken,
    'invited', v_invited,
    'skipped', v_skipped);
end;
$function$
;

revoke all on function public.invite_from_preflight(bigint, text) from public;
grant execute on function public.invite_from_preflight(bigint, text) to authenticated, service_role;

-- Rebuilds one enrollment's expected session slots. Called by the two below.
CREATE OR REPLACE FUNCTION public.rebuild_enrollment_expected_sessions(p_enrollment_id bigint)
 RETURNS TABLE(required_weeks integer, canonical_weeks integer, kept integer, renumbered integer, inserted integer, retired_with_history integer, discarded integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_start date;
  v_offer_id bigint;
  v_extensions int;
  v_required int;
  v_stale int;
begin
  canonical_weeks := 0; required_weeks := 0; kept := 0; renumbered := 0;
  inserted := 0; retired_with_history := 0; discarded := 0;

  select e.start_date, d.offer_id
    into v_start, v_offer_id
    from enrollments e
    join deals d on d.id = e.opportunity_id
   where e.id = p_enrollment_id;

  -- One eligible week per cross-week reschedule, on top of the twelve.
  -- A cadence issue exists only for a week that closed with NO session
  -- inside it, so a same-week time change never produces one and can never
  -- reach this count. A known skip, a no-show and a ghosted session are all
  -- forfeited under the no-rollover rule and extend nothing.
  select count(*)
    into v_extensions
    from client_session_cadence_issues i
   where i.enrollment_id = p_enrollment_id
     and i.classification = 'rescheduled';

  v_required := 12 + coalesce(v_extensions, 0);

  -- The canonical schedule: the eligible `1:1s` weeks from this
  -- Enrollment's own Start Date, in order. Session Week #1 is the week the
  -- Start Date falls IN — window_end is exclusive, so that is exactly
  -- `window_end > start_date`.
  --
  -- DISTINCT ON the week itself, because what is being counted is weeks
  -- Leif is open, not calendar entries. Two identical events for one week
  -- are one week; counting them twice spends two of a client's twelve
  -- sessions on a week that can only hold one, and leaves a slot nothing
  -- can ever fulfil.
  create temporary table _canonical on commit drop as
  with distinct_weeks as (
    select distinct on (w.window_start, w.window_end)
           w.id as window_id, w.window_start, w.window_end, w.raw_title
      from expected_session_windows w
     where v_start is not null
       and w.offer_id = v_offer_id
       and w.deleted_at is null
       and w.window_end > v_start
     order by w.window_start, w.window_end, w.id
  )
  select window_id,
         row_number() over (
           order by window_start, window_end, window_id
         )::int as ordinal,
         window_start,
         window_end,
         raw_title
    from distinct_weeks
   order by window_start, window_end, window_id
   limit v_required;

  -- Retire every live slot whose week is no longer in the schedule. Done
  -- FIRST so those ordinals leave the unique index before anything is
  -- renumbered into them.
  update enrollment_expected_sessions s
     set retired_at = now()
   where s.enrollment_id = p_enrollment_id
     and s.retired_at is null
     and not exists (
       select 1 from _canonical c where c.window_id = s.source_window_id
     );
  get diagnostics retired_with_history = row_count;

  -- A retired slot with nothing historical attached is a pure projection
  -- and is simply wrong now; keeping it would clutter the record with a
  -- week that never meant anything. One with a cadence issue stays, and is
  -- reported.
  delete from enrollment_expected_sessions s
   where s.enrollment_id = p_enrollment_id
     and s.retired_at is not null
     and not exists (
       select 1 from client_session_cadence_issues i
        where i.enrollment_expected_session_id = s.id
     );
  get diagnostics discarded = row_count;
  retired_with_history := retired_with_history - discarded;

  -- And stop asking about the survivors.
  --
  -- The slot stays — something historical points at it and that is the
  -- whole reason it was kept. But a week that is no longer part of the
  -- schedule is not a week Leif owes anyone a decision about, and leaving
  -- the issue open leaves a Needs Attention item he cannot clear by any
  -- honest answer. `classification` is left null on purpose: nobody
  -- decided anything, and recording a decision that was never made would
  -- be worse than the stale task.
  with retired_issues as (
    update client_session_cadence_issues i
       set resolved_at = now()
      from enrollment_expected_sessions s
     where s.id = i.enrollment_expected_session_id
       and s.enrollment_id = p_enrollment_id
       and s.retired_at is not null
       and i.resolved_at is null
    returning i.id
  ),
  logged as (
    insert into client_session_cadence_issue_events (cadence_issue_id, kind)
    select id, 'retired' from retired_issues
    returning 1
  )
  select count(*)::int into v_stale from logged;

  -- The Task is the surface Leif actually sees, so it closes with the
  -- issue. Same shape as the app's own completeResolveCadenceIssueTask.
  update tasks t
     set done_date = now(), status = 'completed'
    from client_session_cadence_issues i
    join enrollment_expected_sessions s
      on s.id = i.enrollment_expected_session_id
   where t.cadence_issue_id = i.id
     and t.done_date is null
     and s.enrollment_id = p_enrollment_id
     and s.retired_at is not null;

  -- Park the survivors out of the way so a renumber can never collide with
  -- an ordinal it is about to take. The check constraint no longer caps
  -- the value, which is what makes this legal.
  update enrollment_expected_sessions s
     set ordinal = s.ordinal + 1000
   where s.enrollment_id = p_enrollment_id
     and s.retired_at is null;

  -- Renumber what survives to its canonical position, and refresh the
  -- snapshot: if Leif moved a `1:1s` week in Google Calendar, the slot's
  -- displayed dates should follow it. The slot's IDENTITY — and therefore
  -- every issue, note and event hanging off it — is untouched.
  with parked as (
    select s.id, s.ordinal - 1000 as previous_ordinal
      from enrollment_expected_sessions s
     where s.enrollment_id = p_enrollment_id and s.retired_at is null
  ),
  applied as (
    update enrollment_expected_sessions s
       set ordinal = c.ordinal,
           window_start = c.window_start,
           window_end = c.window_end,
           raw_title = c.raw_title
      from _canonical c
     where s.enrollment_id = p_enrollment_id
       and s.retired_at is null
       and s.source_window_id = c.window_id
    returning s.id, c.ordinal as new_ordinal
  )
  select count(*)::int,
         count(*) filter (where a.new_ordinal <> p.previous_ordinal)::int
    into kept, renumbered
    from applied a join parked p on p.id = a.id;

  -- And add the weeks that were not assigned before.
  with added as (
    insert into enrollment_expected_sessions
      (enrollment_id, source_window_id, ordinal, window_start, window_end, raw_title)
    select p_enrollment_id, c.window_id, c.ordinal, c.window_start, c.window_end, c.raw_title
      from _canonical c
     where not exists (
       select 1 from enrollment_expected_sessions s
        where s.enrollment_id = p_enrollment_id
          and s.retired_at is null
          and s.source_window_id = c.window_id
     )
    returning 1
  )
  select count(*)::int into inserted from added;

  select count(*)::int into canonical_weeks from _canonical;
  required_weeks := v_required;

  drop table if exists _canonical;
  return next;
end;
$function$
;

revoke all on function public.rebuild_enrollment_expected_sessions(bigint) from public;
grant execute on function public.rebuild_enrollment_expected_sessions(bigint) to authenticated, service_role;

-- Calls rebuild_enrollment_expected_sessions for every enrollment.
CREATE OR REPLACE FUNCTION public.rebuild_all_expected_sessions()
 RETURNS TABLE(enrollments_rebuilt integer, slots_inserted integer, slots_renumbered integer, slots_retired_with_history integer, slots_discarded integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row record;
  v_result record;
begin
  enrollments_rebuilt := 0;
  slots_inserted := 0;
  slots_renumbered := 0;
  slots_retired_with_history := 0;
  slots_discarded := 0;

  for v_row in
    select e.id
      from enrollments e
      join deals d on d.id = e.opportunity_id
      join offers o on o.id = d.offer_id
     -- Branch on the PROGRAM TYPE, never on a name or an id. Any 1:1
     -- program schedules this way; a group program runs to its
     -- cohort's own published dates and must never reach here.
     where o.type = 'individual'
       and e.status in ('onboarding', 'active', 'offboarding')
       and e.start_date is not null
     order by e.id
  loop
    select * into v_result
      from public.rebuild_enrollment_expected_sessions(v_row.id);
    enrollments_rebuilt := enrollments_rebuilt + 1;
    slots_inserted := slots_inserted + coalesce(v_result.inserted, 0);
    slots_renumbered := slots_renumbered + coalesce(v_result.renumbered, 0);
    slots_retired_with_history :=
      slots_retired_with_history + coalesce(v_result.retired_with_history, 0);
    slots_discarded := slots_discarded + coalesce(v_result.discarded, 0);
  end loop;

  return next;
end;
$function$
;

revoke all on function public.rebuild_all_expected_sessions() from public;
grant execute on function public.rebuild_all_expected_sessions() to authenticated, service_role;

-- Trigger wrapper around the same rebuild. NOTE: production holds proacl = NULL for this one, so no grant or revoke is mirrored here -- see HANDOFF for why that is reported rather than quietly changed.
CREATE OR REPLACE FUNCTION public.rebuild_expected_sessions_on_start_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.start_date is distinct from old.start_date then
    perform public.rebuild_enrollment_expected_sessions(new.id);
  end if;
  return new;
end;
$function$
;

-- No ACL statements: production holds proacl = NULL for this function.
-- Mirrored as-is rather than tightened, because changing intended authority
-- is not this task.

-- =====================================================================
-- Sales Call Workflow Part 2, 2026-10-16: correcting a recorded result
-- =====================================================================
-- See supabase/migrations/20261016120000_a_recorded_result_can_be_corrected.sql
-- for the full reasoning. In short:
--
--   complete_attended_sales_call()  the FIRST resolution of a call episode,
--                                   which still refuses a materially
--                                   different re-completion
--   correct_completed_sales_call()  a human changing an already-recorded
--                                   resolution, explicitly, with its own
--                                   audit event
--
-- reconcile_decision_follow_up_task() is the single authority over the
-- Decision follow-up Task projection, reached through the trigger
-- on_deal_decision_follow_up_task (04_triggers.sql) so that every path that
-- moves an Opportunity reconciles it -- the correction, the completion, the
-- pipeline-exit path, a Kanban drag, an archive.
--
-- Declared in the hand-written lowercase style, same as
-- converge_delivered_invitation() and guard_outreach_attempt_mutation()
-- above. Appended at the end of the file because all three are plpgsql, so
-- declaration order carries no dependency (only a LANGUAGE sql body is
-- parsed at creation -- see contracts/schema/liveFunctionsAreDeclared.test.ts).

create or replace function public.reconcile_decision_follow_up_task(p_opportunity_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_wanted boolean;
  v_task tasks%rowtype;
  v_adoptable boolean;
  v_unlinked_id bigint;
  v_sales_id bigint;
  v_contact_name text;
  v_due timestamptz;
  v_action text;
begin
  select * into v_deal from deals where id = p_opportunity_id;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- The premise of the Task, stated once: an ACTIVE Opportunity sitting at
  -- Decision with a date Leif committed to.
  v_wanted := public.deal_is_active(v_deal.archived_at, v_deal.stage, v_deal.outcome)
              and v_deal.stage = 'decision'
              and v_deal.follow_up_date is not null;

  select * into v_task from tasks
   where opportunity_id = v_deal.id
     and type = 'follow_up'
     and done_date is null
   order by id
   limit 1;

  -- Adopt a legacy unlinked Task -- but only when this Opportunity is
  -- unambiguously the one it is about, which means the Contact has no OTHER
  -- active Opportunity that could equally claim it. Guessing which sale a
  -- Task belongs to is Leif's call, not ours, and a wrong guess would move a
  -- commitment from one programme onto another.
  if not found then
    select not exists (
      select 1 from deals other
       where other.contact_id = v_deal.contact_id
         and other.id <> v_deal.id
         and public.deal_is_active(other.archived_at, other.stage, other.outcome)
    ) into v_adoptable;

    select id into v_unlinked_id from tasks
     where contact_id = v_deal.contact_id
       and opportunity_id is null
       and type = 'follow_up'
       and done_date is null
     order by id
     limit 1;

    if v_adoptable and v_unlinked_id is not null then
      update tasks set opportunity_id = v_deal.id where id = v_unlinked_id;
      select * into v_task from tasks where id = v_unlinked_id;
      v_unlinked_id := null;
    end if;
  end if;

  if not v_wanted then
    if v_task.id is null then
      -- An unlinked Task we declined to adopt is also one we must not
      -- close: it may be about the Contact's OTHER active Opportunity.
      return jsonb_build_object('status', 'none-wanted',
        'action', case when v_unlinked_id is not null
                       then 'deferred-to-unlinked-task'
                       else 'nothing-to-close' end,
        'task_id', v_unlinked_id);
    end if;
    -- Cancelled rather than completed: nobody did it. done_date moves with
    -- it because tasks_completion_agreement_check reads it as "closed at".
    update tasks
       set status = 'cancelled',
           done_date = coalesce(done_date, now())
     where id = v_task.id;
    return jsonb_build_object('status', 'none-wanted', 'action', 'closed',
                              'task_id', v_task.id);
  end if;

  v_due := (v_deal.follow_up_date + time '12:00') at time zone 'America/Denver';

  if v_task.id is not null then
    -- Already on the right day? Then it is already right. Only a genuine
    -- change of commitment rewrites it.
    if (v_task.due_date at time zone 'America/Denver')::date
       is distinct from v_deal.follow_up_date then
      update tasks set due_date = v_due where id = v_task.id;
      v_action := 'retargeted';
    else
      v_action := 'unchanged';
    end if;
    return jsonb_build_object('status', 'wanted', 'action', v_action,
                              'task_id', v_task.id);
  end if;

  -- An unlinked legacy Task we declined to adopt is still a Task telling
  -- Leif to follow up with this person, and one of them is this
  -- Opportunity. Adding a second "Follow up with X" beside it would be
  -- noise, not safety, so this defers to it rather than duplicating it.
  if v_unlinked_id is not null then
    return jsonb_build_object('status', 'wanted',
                              'action', 'deferred-to-unlinked-task',
                              'task_id', v_unlinked_id);
  end if;

  -- Same owner resolution reconcile_sales_call_tasks() uses.
  select id into v_sales_id from sales where administrator = true limit 1;
  select nullif(btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
    into v_contact_name
    from contacts where id = v_deal.contact_id;

  insert into tasks (contact_id, type, text, due_date, status,
                     opportunity_id, sales_id)
  values (v_deal.contact_id, 'follow_up',
          format('Follow up with %s', coalesce(v_contact_name, 'this contact')),
          v_due, 'pending', v_deal.id, v_sales_id)
  returning * into v_task;

  return jsonb_build_object('status', 'wanted', 'action', 'created',
                            'task_id', v_task.id);
end;
$fn$;

create or replace function public.sync_decision_follow_up_task()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  -- A historical import states its own final truth and must not spawn live
  -- Tasks, exactly as handle_deal_won() refuses to fire live onboarding.
  if current_setting('app.migration_mode', true) = 'true' then
    return new;
  end if;
  perform public.reconcile_decision_follow_up_task(new.id);
  return new;
end;
$fn$;

create or replace function public.correct_completed_sales_call(
  p_sales_call_id bigint,
  p_attendance text default null,
  p_owner_decision text default null,
  p_prospect_decision text default null,
  p_follow_up_date date default null,
  p_impressions text default null,
  p_impressions_mode text default 'unchanged'
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_call sales_calls%rowtype;
  v_deal deals%rowtype;
  v_now timestamptz := now();
  v_instant timestamptz;
  v_newer_id bigint;
  v_lifecycle_requested boolean;
  v_attendance text;
  v_owner text;
  v_prospect text;
  v_target_stage text;
  v_target_outcome text;
  v_target_follow_up date;
  v_impressions text;
  v_impressions_changing boolean := false;
  v_blockers text[] := '{}';
  v_sale jsonb;
  v_before jsonb;
  v_after jsonb;
  v_remaining_no_shows int;
  v_tag_id bigint;
begin
  -- 3a. The shape of the request, before anything is read or written.
  if p_impressions_mode is null
     or p_impressions_mode not in ('unchanged', 'set', 'clear') then
    return jsonb_build_object('status', 'validation-error',
      'message', 'Impressions mode must be unchanged, set or clear.');
  end if;
  if p_impressions_mode = 'set'
     and nullif(btrim(coalesce(p_impressions, ''), E' \t\r\n'), '') is null then
    return jsonb_build_object('status', 'validation-error',
      'message', 'Setting an impression needs some text.');
  end if;
  if p_impressions_mode <> 'set' and p_impressions is not null then
    return jsonb_build_object('status', 'validation-error',
      'message', format('Impressions mode "%s" does not take any text.', p_impressions_mode));
  end if;
  if p_attendance is not null and p_attendance not in ('attended', 'no_show') then
    return jsonb_build_object('status', 'validation-error',
      'message', 'Attendance must be attended or no_show.');
  end if;

  select * into v_call from sales_calls where id = p_sales_call_id for update;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- 3b. Only an already-resolved episode has a result to correct. A booked
  --     call is completed, not corrected; a cancelled one never had an
  --     outcome; a completed historical row with no attendance at all (135
  --     of them) has nothing recorded to change either.
  if v_call.status <> 'completed' or v_call.attendance is null then
    return jsonb_build_object('status', 'not-completed',
      'reason', 'This call has no recorded result to correct.');
  end if;
  if v_call.opportunity_id is null then
    return jsonb_build_object('status', 'no-opportunity');
  end if;

  v_lifecycle_requested := p_attendance is not null
                        or p_owner_decision is not null
                        or p_prospect_decision is not null
                        or p_follow_up_date is not null;

  -- 3c. Does a NEWER attended episode already own this Opportunity's
  --     current truth? Same ordering the app's one call-selection model
  --     uses (sales-calls/salesCallSelection.ts): the call's instant
  --     descending, id as the tiebreak, a call with no knowable time
  --     sorting earliest.
  v_instant := coalesce(v_call.scheduled_at,
                        (v_call.scheduled_on + time '23:59') at time zone 'America/Denver',
                        '-infinity'::timestamptz);
  select other.id into v_newer_id
    from sales_calls other
   where other.opportunity_id = v_call.opportunity_id
     and other.id <> v_call.id
     and other.attendance = 'attended'
     and (coalesce(other.scheduled_at,
                   (other.scheduled_on + time '23:59') at time zone 'America/Denver',
                   '-infinity'::timestamptz), other.id) > (v_instant, v_call.id)
   order by coalesce(other.scheduled_at,
                     (other.scheduled_on + time '23:59') at time zone 'America/Denver',
                     '-infinity'::timestamptz) desc, other.id desc
   limit 1;

  if v_newer_id is not null and v_lifecycle_requested then
    return jsonb_build_object('status', 'superseded-call-episode',
      'category', 'newer_attended_episode',
      'superseded_by_sales_call_id', v_newer_id,
      'reason', 'A later call on this Opportunity holds its current result. This one''s impressions can still be corrected.');
  end if;

  select * into v_deal from deals where id = v_call.opportunity_id for update;
  if not found then
    return jsonb_build_object('status', 'no-opportunity');
  end if;

  -- An archived Opportunity is not quietly brought back to life by editing
  -- an old call, the same refusal accept_sale() makes for the same reason.
  if v_deal.archived_at is not null and v_lifecycle_requested then
    return jsonb_build_object('status', 'ambiguous-downstream-state',
      'category', 'archived_opportunity',
      'blockers', to_jsonb(array['archived']::text[]),
      'reason', 'This Opportunity is archived. Un-archive it first if its result really needs changing.');
  end if;

  -- 3d. Attendance. A no-show never touched the Opportunity, so correcting
  --     AWAY from one only ever adds facts. Correcting TO one would have to
  --     retract a decision that has already moved the Opportunity's stage,
  --     and this schema has no backward stage transition and no canonical
  --     command that reverses one. So that direction is refused rather than
  --     guessed at.
  v_attendance := coalesce(p_attendance, v_call.attendance);
  if v_call.attendance = 'attended' and v_attendance = 'no_show' then
    return jsonb_build_object('status', 'ambiguous-downstream-state',
      'category', 'attendance_retraction',
      'reason', 'Recording this call as a no-show would have to undo the decision it already produced on the Opportunity. Change the Opportunity''s own outcome instead.');
  end if;

  -- 3e. The target decision, from the same five-way table
  --     complete_attended_sales_call() uses. No new outcomes, no new
  --     transitions.
  v_owner := coalesce(p_owner_decision, v_deal.owner_decision);
  if v_owner is null then
    return jsonb_build_object('status', 'validation-error',
      'message', 'An owner-fit decision is required for an attended call.');
  end if;
  if v_owner not in ('would_work_with', 'workshops_only', 'do_not_engage') then
    return jsonb_build_object('status', 'validation-error',
      'message', format('"%s" is not an owner decision.', v_owner));
  end if;

  if v_owner = 'would_work_with' then
    v_prospect := coalesce(p_prospect_decision, v_deal.prospect_decision);
    if v_prospect is null then
      return jsonb_build_object('status', 'validation-error',
        'message', 'A prospect decision is required when Would Work With.');
    end if;
    if v_prospect not in ('yes', 'thinking', 'no') then
      -- 'ghosted' is a legal stored value, but it is produced by the
      -- pipeline-exit authority (deals/pipelineExit.ts), never by a call
      -- outcome. Correcting a call's result must not become a second way to
      -- exit the pipeline.
      return jsonb_build_object('status', 'invalid-transition',
        'category', 'not_a_call_outcome',
        'reason', format('"%s" is not something a sales call records. Use Remove from pipeline.', v_prospect));
    end if;
  else
    -- Derived, never independently cleared: only Would Work With has one.
    v_prospect := null;
  end if;

  if v_owner = 'would_work_with' and v_prospect = 'thinking' then
    v_target_stage := 'decision';
    v_target_outcome := null;
    v_target_follow_up := coalesce(p_follow_up_date, v_deal.follow_up_date);
    if v_target_follow_up is null then
      return jsonb_build_object('status', 'missing-decision-date',
        'reason', 'A Decision needs the date the follow-up is owed.');
    end if;
  elsif v_owner = 'would_work_with' and v_prospect = 'yes' then
    v_target_stage := 'won';
    v_target_outcome := null;
    v_target_follow_up := null;
  elsif v_owner = 'would_work_with' and v_prospect = 'no' then
    v_target_stage := v_deal.stage;
    v_target_outcome := 'lost';
    v_target_follow_up := null;
  elsif v_owner = 'do_not_engage' then
    v_target_stage := v_deal.stage;
    v_target_outcome := 'lost';
    v_target_follow_up := null;
  else
    v_target_stage := v_deal.stage;
    v_target_outcome := 'workshops_only';
    v_target_follow_up := null;
  end if;

  -- 3f. CONSEQUENTIAL DOWNSTREAM STATE. Checked here, before a single write,
  --     and the whole correction stops rather than half-applying.
  --
  --     Creating consequential state forward is fine -- a correction to
  --     "they said yes" goes through accept_sale(), the same convergent
  --     primitive the completion uses. What is refused is UNDOING something
  --     outside this transaction's power to undo.
  -- Keyed on the target DECISION, not on the derived stage. The completion's
  -- 'no' branch leaves stage alone, so a Won deal corrected to "they said
  -- no" would compute a target stage of 'won' and slip past a stage
  -- comparison while still writing outcome = 'lost' -- a sale that is won
  -- and lost at once.
  if v_deal.stage = 'won'
     and not (v_owner = 'would_work_with' and v_prospect = 'yes') then
    if exists (select 1 from enrollments where opportunity_id = v_deal.id) then
      v_blockers := v_blockers || 'enrollment'::text;
    end if;
    if exists (select 1 from deal_payment_schedule_items
                where deal_id = v_deal.id
                  and (status = 'paid' or source = 'stripe')) then
      v_blockers := v_blockers || 'payment'::text;
    end if;
    if exists (select 1 from deal_stripe_plan_objects where deal_id = v_deal.id) then
      v_blockers := v_blockers || 'stripe_plan'::text;
    end if;
    if v_deal.offer_page_token is not null then
      v_blockers := v_blockers || 'offer_page_link'::text;
    end if;
    if v_deal.payment_setup_confirmed_at is not null then
      v_blockers := v_blockers || 'payment_setup'::text;
    end if;
    if exists (select 1 from scholarship_slots
                where offer_id = v_deal.offer_id
                  and holder_enrollment_id in
                      (select id from enrollments where opportunity_id = v_deal.id)) then
      v_blockers := v_blockers || 'scholarship_slot'::text;
    end if;
    -- A Won sale with none of the above still means a client was told yes.
    v_blockers := v_blockers || 'won_sale'::text;

    return jsonb_build_object('status', 'ambiguous-downstream-state',
      'category', 'won_opportunity',
      'blockers', to_jsonb(v_blockers),
      'reason', 'This sale is already Won, and what follows a Won sale cannot be safely undone from here.');
  end if;

  -- An Enrollment can exist on a non-Won Opportunity (a historical import,
  -- a repair). Ending the sale underneath a live Enrollment is the same
  -- ambiguity by another route.
  if v_target_outcome is not null
     and exists (select 1 from enrollments
                  where opportunity_id = v_deal.id
                    and status <> 'withdrawn') then
    return jsonb_build_object('status', 'ambiguous-downstream-state',
      'category', 'existing_enrollment',
      'blockers', to_jsonb(array['enrollment']::text[]),
      'reason', 'This Opportunity has a live Enrollment. Ending the sale here would leave a client enrolled in something nobody bought.');
  end if;

  -- Do-not-engage is a STANDING gate on the Contact, not a fact about this
  -- call, and it may be true for reasons this Opportunity knows nothing
  -- about. Setting it is this command's business; deciding it is no longer
  -- true is Leif's.
  if v_deal.owner_decision = 'do_not_engage' and v_owner <> 'do_not_engage' then
    return jsonb_build_object('status', 'ambiguous-downstream-state',
      'category', 'contact_sales_eligibility',
      'blockers', to_jsonb(array['contact_do_not_engage']::text[]),
      'reason', 'This Contact carries a standing do-not-engage decision. Lifting it is a decision about the person, not about this call.');
  end if;

  -- 3g. Impressions.
  if p_impressions_mode = 'set' then
    v_impressions := nullif(btrim(p_impressions, E' \t\r\n'), '');
  elsif p_impressions_mode = 'clear' then
    v_impressions := null;
  else
    v_impressions := v_call.impressions;
  end if;
  v_impressions_changing := p_impressions_mode <> 'unchanged'
                            and v_impressions is distinct from v_call.impressions;

  -- 3h. Nothing to do is an answer, and it writes no audit event. A repeated
  --     identical correction must be a genuine no-op, not a second row in
  --     the history saying nothing changed.
  if v_attendance is not distinct from v_call.attendance
     and v_owner is not distinct from v_deal.owner_decision
     and v_prospect is not distinct from v_deal.prospect_decision
     and v_target_follow_up is not distinct from v_deal.follow_up_date
     and v_target_outcome is not distinct from v_deal.outcome
     and v_target_stage is not distinct from v_deal.stage
     and not v_impressions_changing then
    return jsonb_build_object('status', 'no-change',
      'sales_call_id', v_call.id,
      'opportunity_id', v_deal.id);
  end if;

  v_before := jsonb_build_object(
    'attendance', v_call.attendance,
    'owner_decision', v_deal.owner_decision,
    'prospect_decision', v_deal.prospect_decision,
    'follow_up_date', v_deal.follow_up_date,
    'impressions', v_call.impressions,
    'stage', v_deal.stage,
    'outcome', v_deal.outcome);

  -- 3i. The call episode itself.
  update sales_calls
     set attendance = v_attendance,
         attendance_recorded_at = case
           when v_attendance is distinct from v_call.attendance then v_now
           else attendance_recorded_at end,
         impressions = v_impressions,
         updated_at = v_now
   where id = v_call.id;

  -- 3j. The Opportunity, through the same five branches as the completion.
  if v_owner = 'do_not_engage' then
    update deals
       set owner_decision = 'do_not_engage', prospect_decision = null,
           follow_up_date = null, outcome = 'lost'
     where id = v_deal.id;
    update contacts set sales_eligibility = 'do_not_engage' where id = v_deal.contact_id;

  elsif v_owner = 'workshops_only' then
    update deals
       set owner_decision = 'workshops_only', prospect_decision = null,
           follow_up_date = null, outcome = 'workshops_only'
     where id = v_deal.id;

  elsif v_prospect = 'yes' then
    update deals
       set owner_decision = 'would_work_with', follow_up_date = null,
           outcome = null
     where id = v_deal.id;
    v_sale := public.accept_sale(v_deal.id);
    if v_sale ->> 'status' = 'conflicting-outcome' then
      -- accept_sale() refuses rather than overwriting a recorded end. Its
      -- own words, not a translation of them.
      raise exception 'correction refused by accept_sale: %', v_sale ->> 'reason'
        using errcode = 'raise_exception';
    end if;

  elsif v_prospect = 'no' then
    update deals
       set owner_decision = 'would_work_with', prospect_decision = 'no',
           follow_up_date = null, outcome = 'lost'
     where id = v_deal.id;

  else
    update deals
       set owner_decision = 'would_work_with', prospect_decision = 'thinking',
           follow_up_date = v_target_follow_up, outcome = null,
           stage = 'decision'
     where id = v_deal.id;
  end if;

  -- 3k. The No-show tag is a SUMMARY of the Contact's history, never its
  --     source of truth (record_sales_call_no_show()'s own words). Once no
  --     no-showed call remains, the summary is simply false.
  if v_call.attendance = 'no_show' and v_attendance <> 'no_show' then
    select count(*) into v_remaining_no_shows
      from sales_calls
     where contact_id = v_call.contact_id and attendance = 'no_show';
    if v_remaining_no_shows = 0 then
      select id into v_tag_id from tags where lower(name) = 'no-show' limit 1;
      if v_tag_id is not null then
        update contacts
           set tags = array_remove(coalesce(tags, '{}'::bigint[]), v_tag_id)
         where id = v_call.contact_id;
      end if;
    end if;
  end if;

  -- 3l. Derived internal state. The trigger on deals has already run; this
  --     is belt and braces for the case where the correction changed only
  --     the call row.
  perform public.reconcile_decision_follow_up_task(v_deal.id);

  select * into v_deal from deals where id = v_deal.id;
  select * into v_call from sales_calls where id = v_call.id;

  v_after := jsonb_build_object(
    'attendance', v_call.attendance,
    'owner_decision', v_deal.owner_decision,
    'prospect_decision', v_deal.prospect_decision,
    'follow_up_date', v_deal.follow_up_date,
    'impressions', v_call.impressions,
    'stage', v_deal.stage,
    'outcome', v_deal.outcome);

  -- 3m. The history. The original attendance_recorded event is untouched:
  --     what was first recorded stays recorded, and this says what changed
  --     on top of it.
  insert into sales_call_events (sales_call_id, kind, occurred_at, attendance, correction)
  values (v_call.id, 'outcome_corrected', v_now, v_call.attendance,
          jsonb_build_object('before', v_before, 'after', v_after));

  return jsonb_build_object(
    'status', 'corrected',
    'sales_call_id', v_call.id,
    'opportunity_id', v_deal.id,
    'contact_id', v_deal.contact_id,
    'attendance', v_call.attendance,
    'stage', v_deal.stage,
    'outcome', v_deal.outcome,
    'owner_decision', v_deal.owner_decision,
    'prospect_decision', v_deal.prospect_decision,
    'follow_up_date', v_deal.follow_up_date,
    'impressions', v_call.impressions,
    'enrollments', (select count(*) from enrollments where opportunity_id = v_deal.id),
    'before', v_before);
end;
$fn$;

-- =====================================================================
-- Deposits, 2026-10-17: a deposit is credited, not charged twice
-- =====================================================================
-- See supabase/migrations/20261016140000_a_deposit_is_credited_not_charged_twice.sql
-- for the full reasoning. In short: the deposit is versioned on the payment
-- OPTION and snapshotted onto the Deal, the balance is agreed total minus it,
-- the balance is anchored on date_trunc('month', enrollments.start_date), and
-- an uneven split is exact in integer cents rather than distorting the agreed
-- total.
--
-- allocate_balance_cents() is mirrored by deals/depositAllocation.ts and
-- supabase/functions/_shared/depositAllocation.ts; the three are cross-checked
-- by contracts/deals/oneDepositAllocation.test.ts.

create or replace function public.set_offer_payment_option(
  p_offer_id bigint,
  p_name text,
  p_total numeric,
  p_installments smallint,
  p_installment_amount numeric,
  p_is_public boolean default true,
  p_pricing_mode text default 'standard',
  p_option_id bigint default null,
  p_deposit_amount numeric default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_existing offer_payment_options%rowtype;
  v_references int;
  v_new_id bigint;
  v_deposit numeric;
begin
  if not exists (select 1 from offers where id = p_offer_id) then
    return jsonb_build_object('status', 'offer-invalid');
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    return jsonb_build_object('status', 'name-required');
  end if;
  if p_pricing_mode not in ('standard', 'scholarship') then
    return jsonb_build_object('status', 'pricing-mode-invalid');
  end if;
  if p_installments is null or p_installments < 1 then
    return jsonb_build_object('status', 'installments-invalid');
  end if;
  if p_total is null or p_total < 0
     or p_installment_amount is null or p_installment_amount < 0 then
    return jsonb_build_object('status', 'amount-invalid');
  end if;
  -- UNCHANGED. An option's instalment_amount is the PRE-deposit figure, so
  -- a deposit never makes this impossible and relaxing it would only admit
  -- plans that do not add up for unrelated reasons. See this migration's
  -- header, decision 3.
  if p_installments > 1
     and round(p_installment_amount * p_installments, 2) <> round(p_total, 2) then
    return jsonb_build_object(
      'status', 'instalments-do-not-add-up',
      'total', p_total,
      'reconstructed', round(p_installment_amount * p_installments, 2));
  end if;

  -- A deposit larger than the thing it is a deposit on is not a deposit.
  v_deposit := case when p_deposit_amount is null then null
                    else round(p_deposit_amount, 2) end;
  if v_deposit is not null and v_deposit < 0 then
    return jsonb_build_object('status', 'deposit-invalid');
  end if;
  if v_deposit is not null and v_deposit > round(p_total, 2) then
    return jsonb_build_object('status', 'deposit-exceeds-total',
      'deposit', v_deposit, 'total', round(p_total, 2));
  end if;

  -- ---- a new one -----------------------------------------------------------
  if p_option_id is null then
    insert into offer_payment_options
      (offer_id, name, total, installments, installment_amount, is_public,
       pricing_mode, deposit_amount)
    values
      (p_offer_id, btrim(p_name), p_total, p_installments, p_installment_amount,
       coalesce(p_is_public, true), p_pricing_mode, v_deposit)
    returning id into v_new_id;
    return jsonb_build_object('status', 'added', 'option_id', v_new_id);
  end if;

  select * into v_existing from offer_payment_options where id = p_option_id;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;
  if v_existing.offer_id <> p_offer_id then
    return jsonb_build_object('status', 'offer-mismatch');
  end if;

  -- Nothing changed is not a new version.
  if v_existing.name = btrim(p_name)
     and round(v_existing.total, 2) = round(p_total, 2)
     and v_existing.installments = p_installments
     and round(v_existing.installment_amount, 2) = round(p_installment_amount, 2)
     and v_existing.is_public = coalesce(p_is_public, true)
     and v_existing.pricing_mode = p_pricing_mode
     and v_existing.deposit_amount is not distinct from v_deposit then
    return jsonb_build_object('status', 'unchanged', 'option_id', v_existing.id);
  end if;

  -- An option somebody has agreed to is immutable. Editing it creates the
  -- NEXT version and retires this one; the Deals that reference it keep
  -- the terms they actually agreed, deposit included.
  select count(*) into v_references
    from deals where selected_payment_option_id = v_existing.id;

  if v_references > 0 then
    insert into offer_payment_options
      (offer_id, name, total, installments, installment_amount, is_public,
       pricing_mode, deposit_amount, replaces_option_id)
    values
      (p_offer_id, btrim(p_name), p_total, p_installments, p_installment_amount,
       coalesce(p_is_public, true), p_pricing_mode, v_deposit, v_existing.id)
    returning id into v_new_id;

    update offer_payment_options set is_active = false, updated_at = now()
     where id = v_existing.id;

    return jsonb_build_object(
      'status', 'versioned',
      'option_id', v_new_id,
      'replaced_option_id', v_existing.id,
      'agreements_preserved', v_references);
  end if;

  update offer_payment_options
     set name = btrim(p_name), total = p_total, installments = p_installments,
         installment_amount = p_installment_amount,
         is_public = coalesce(p_is_public, true),
         pricing_mode = p_pricing_mode,
         deposit_amount = v_deposit,
         updated_at = now()
   where id = v_existing.id;

  return jsonb_build_object('status', 'updated', 'option_id', v_existing.id);
end;
$fn$;

create or replace function public.allocate_balance_cents(
  p_balance_cents bigint,
  p_installments int
) returns bigint[]
language sql
immutable
set search_path to 'public'
as $fn$
  select array_agg(
           (p_balance_cents / p_installments)
           + case when i <= (p_balance_cents % p_installments) then 1 else 0 end
           order by i)
    from generate_series(1, p_installments) as i;
$fn$;

create or replace function public.plan_balance_schedule(p_opportunity_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_enrollment enrollments%rowtype;
  v_deposit_cents bigint;
  v_total_cents bigint;
  v_balance_cents bigint;
  v_installments int;
  v_anchor date;
  v_parts bigint[];
  v_collected_cents bigint;
  v_balance_paid_cents bigint;
  v_phases jsonb;
  v_amount bigint;
  v_run int;
  v_i int;
begin
  select * into v_deal from deals where id = p_opportunity_id;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- The sale has to exist before its balance can be scheduled.
  if v_deal.stage <> 'won' then
    return jsonb_build_object('status', 'not-won', 'stage', v_deal.stage);
  end if;
  if v_deal.archived_at is not null or v_deal.outcome is not null then
    return jsonb_build_object('status', 'not-won',
      'stage', v_deal.stage, 'outcome', v_deal.outcome);
  end if;

  if v_deal.selected_payment_total is null then
    return jsonb_build_object('status', 'terms-unknown');
  end if;
  v_total_cents := round(v_deal.selected_payment_total * 100)::bigint;
  v_installments := coalesce(v_deal.selected_installment_count, 1);
  if v_installments < 1 then
    return jsonb_build_object('status', 'terms-unknown');
  end if;

  -- No deposit agreed means this whole mechanism does not apply: the Deal
  -- is paid for however it was already being paid for, and nothing here
  -- changes that. Every Deal in production today is in this branch.
  if v_deal.selected_deposit_amount is null
     or round(v_deal.selected_deposit_amount, 2) = 0 then
    return jsonb_build_object('status', 'no-deposit-plan');
  end if;
  v_deposit_cents := round(v_deal.selected_deposit_amount * 100)::bigint;
  if v_deposit_cents > v_total_cents then
    return jsonb_build_object('status', 'terms-unknown',
      'reason', 'the agreed deposit is larger than the agreed total');
  end if;

  v_balance_cents := v_total_cents - v_deposit_cents;
  if v_balance_cents = 0 then
    return jsonb_build_object('status', 'nothing-to-schedule',
      'opportunity_id', v_deal.id,
      'agreed_total_cents', v_total_cents,
      'deposit_cents', v_deposit_cents);
  end if;

  -- THE DEPOSIT HAS TO BE IN. Scheduling a balance before the deposit has
  -- arrived would charge the larger half of an agreement nobody has
  -- started honouring, off a card that may not even be saved.
  select coalesce(sum(round(amount * 100)::bigint), 0) into v_collected_cents
    from deal_payment_schedule_items
   where deal_id = v_deal.id and status = 'paid';
  if v_collected_cents < v_deposit_cents then
    return jsonb_build_object('status', 'deposit-not-paid',
      'collected_cents', v_collected_cents,
      'deposit_cents', v_deposit_cents);
  end if;

  -- THE ANCHOR. The first calendar day of the month the client's programme
  -- starts in, and nothing else.
  select * into v_enrollment from enrollments
   where opportunity_id = v_deal.id
     and status <> 'withdrawn'
   order by id limit 1;
  if not found then
    return jsonb_build_object('status', 'enrollment-missing');
  end if;
  if v_enrollment.start_date is null then
    -- Valid and expected for The Living Example: Won, enrolled, onboarding
    -- under way, start week still Leif's to state. Never invented.
    return jsonb_build_object('status', 'start-date-unknown',
      'enrollment_id', v_enrollment.id);
  end if;
  v_anchor := date_trunc('month', v_enrollment.start_date)::date;

  -- Money already collected BEYOND the deposit is a balance payment, and
  -- once one has succeeded the schedule is history rather than a plan.
  v_balance_paid_cents := v_collected_cents - v_deposit_cents;

  if v_balance_paid_cents > 0 then
    perform public.reconcile_payment_health_tasks(v_deal.id);
    return jsonb_build_object('status', 'balance-already-started',
      'balance_paid_cents', v_balance_paid_cents,
      'balance_start_date', v_anchor,
      'reason', 'A balance payment has already succeeded. Changing the schedule now would rewrite financial history.');
  end if;

  -- THE PAST-DUE REFUSAL.
  if v_anchor <= current_date then
    perform public.reconcile_payment_health_tasks(v_deal.id);
    return jsonb_build_object('status', 'balance-start-requires-review',
      'balance_start_date', v_anchor,
      'today', current_date,
      'reason', 'The first of the programme start month has already passed. The balance schedule needs Leif, not a backdated charge.');
  end if;

  v_parts := public.allocate_balance_cents(v_balance_cents, v_installments);

  -- Consecutive equal amounts grouped into Stripe phases, order preserved.
  v_phases := '[]'::jsonb;
  v_amount := v_parts[1];
  v_run := 0;
  for v_i in 1 .. array_length(v_parts, 1) loop
    if v_parts[v_i] = v_amount then
      v_run := v_run + 1;
    else
      v_phases := v_phases || jsonb_build_object('iterations', v_run, 'amount_cents', v_amount);
      v_amount := v_parts[v_i];
      v_run := 1;
    end if;
  end loop;
  v_phases := v_phases || jsonb_build_object('iterations', v_run, 'amount_cents', v_amount);

  return jsonb_build_object(
    'status', 'ready',
    'opportunity_id', v_deal.id,
    'contact_id', v_deal.contact_id,
    'agreed_total_cents', v_total_cents,
    'deposit_cents', v_deposit_cents,
    'balance_cents', v_balance_cents,
    'installments', v_installments,
    'balance_start_date', v_anchor,
    'per_installment_cents', to_jsonb(v_parts),
    'phases', v_phases,
    'existing_schedule_id', v_deal.stripe_subscription_schedule_id);
end;
$fn$;

-- ONE SENTENCE PER PREMISE, IN ONE PLACE.
--
-- Used by the insert and by the refresh below, so a Task that changes
-- premise cannot end up describing the premise it used to have -- and so
-- the refresh can tell a sentence this function wrote from a sentence
-- somebody typed, which is what makes it safe to rewrite at all.
create or replace function public.payment_health_task_reason(p_premise text)
returns text
language sql
immutable
set search_path to 'public'
as $fn$
  select case p_premise
           when 'plan_not_collecting'
             then 'a scheduled payment did not go through'
           when 'balance_start_requires_review'
             then 'the balance start month has already passed -- the remaining balance needs scheduling by hand'
           when 'balance_not_scheduled'
             then 'the remaining balance is not scheduled yet'
         end;
$fn$;

create or replace function public.reconcile_payment_health_tasks(
  p_opportunity_id bigint default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_created int := 0;
  v_closed int := 0;
  v_restated int := 0;
  v_sales_id bigint;
begin
  select id into v_sales_id from sales where administrator = true limit 1;

  -- THREE DURABLE PREMISES, all declarative, so the same query that opens a
  -- Task is the one that closes it.
  --
  --   A  plan_not_collecting            the current Stripe plan is not
  --                                     collecting (Stripe's own vocabulary:
  --                                     past_due / unpaid for a failed
  --                                     charge, incomplete(_expired) when
  --                                     the customer has to authenticate)
  --   B  balance_start_requires_review  deposit in, balance outstanding, the
  --                                     first of the start month has gone, and
  --                                     nothing carrying it
  --   C  balance_not_scheduled          deposit in, balance outstanding, a
  --                                     USABLE FUTURE start month, and no
  --                                     balance schedule exists
  --
  -- C is the one that closes the stranding hole. The CRM and Stripe cannot
  -- share a transaction: enrollments.start_date commits first and the
  -- schedule is a consequence, so every way that consequence can fail --
  -- the Edge call never made, a network error, a provider error, no saved
  -- card -- used to leave a committed client with a balance owed, a known
  -- start month, no schedule and nothing saying so. It is a CONDITION, not
  -- an event: it holds until a schedule exists and then stops on its own,
  -- which is exactly what makes a later success close it with no retry
  -- bookkeeping. deals_awaiting_balance_schedule() below states the same
  -- predicate for the hourly sweep that retries it.
  --
  -- The three cannot overlap: A requires a current plan object and B and C
  -- require none, and B needs the anchor past where C needs it future. The
  -- distinct on () is belt as well as braces.
  with collected as (
    select deal_id, sum(round(amount * 100)::bigint) as cents
      from deal_payment_schedule_items where status = 'paid' group by deal_id
  ),
  -- A sale that is agreed and has not ended, carrying a deposit, with the
  -- deposit in and the balance not. Stated once for both B and C.
  owed as (
    select d.id as deal_id,
           d.contact_id,
           date_trunc('month', e.start_date)::date as anchor,
           d.stripe_subscription_schedule_id as schedule_id
      from deals d
      join enrollments e on e.opportunity_id = d.id and e.status <> 'withdrawn'
      left join collected c on c.deal_id = d.id
      -- Stated directly rather than through deal_is_active(), whose whole
      -- point is that a WON deal is not 'active' -- true here, and
      -- confusing to read.
     where d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
       and d.selected_deposit_amount is not null
       and round(d.selected_deposit_amount, 2) > 0
       and d.selected_payment_total is not null
       and e.start_date is not null
       and coalesce(c.cents, 0) >= round(d.selected_deposit_amount * 100)::bigint
       and coalesce(c.cents, 0) < round(d.selected_payment_total * 100)::bigint
       and not exists (select 1 from deal_stripe_plan_objects p2
                        where p2.deal_id = d.id and p2.is_current)
  ),
  premises as (
    select distinct d.id as deal_id, d.contact_id, 'plan_not_collecting'::text as premise
      from deals d
      join deal_stripe_plan_objects p on p.deal_id = d.id
     where p.is_current
       and p.status in ('past_due', 'unpaid', 'incomplete', 'incomplete_expired')
       and d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
    union all
    select o.deal_id, o.contact_id, 'balance_start_requires_review'
      from owed o where o.anchor <= current_date
    union all
    select o.deal_id, o.contact_id, 'balance_not_scheduled'
      from owed o where o.anchor > current_date and o.schedule_id is null
  ),
  raised as (
    select distinct on (deal_id) deal_id, contact_id, premise
      from premises
     where p_opportunity_id is null or deal_id = p_opportunity_id
     order by deal_id, premise
  )
  insert into tasks (contact_id, type, text, due_date, status, opportunity_id, sales_id)
  select r.contact_id, 'check_payment',
         format('%s · %s', nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                public.payment_health_task_reason(r.premise)),
         now(), 'pending', r.deal_id, v_sales_id
    from raised r
    join contacts c on c.id = r.contact_id
   where not exists (
     select 1 from tasks t
      where t.opportunity_id = r.deal_id
        and t.type = 'check_payment'
        and t.done_date is null);
  get diagnostics v_created = row_count;

  -- A TASK WHOSE REASON CHANGED SAYS THE NEW REASON.
  --
  -- The text is written once, at insert, and the dedupe above deliberately
  -- does not add a second Task -- so a Deal that moves from "the start
  -- month has already passed" to "not scheduled yet" would otherwise keep
  -- telling Leif about a month that is now perfectly fine. The premise it
  -- was raised under is not the premise it is still open under.
  --
  -- Rewrites ONLY a sentence this function itself wrote, which is what
  -- payment_health_task_reason() being single-sourced buys: a check_payment
  -- Task somebody typed by hand matches none of the three and is left
  -- exactly as typed.
  with collected as (
    select deal_id, sum(round(amount * 100)::bigint) as cents
      from deal_payment_schedule_items where status = 'paid' group by deal_id
  ),
  owed as (
    select d.id as deal_id,
           d.contact_id,
           date_trunc('month', e.start_date)::date as anchor,
           d.stripe_subscription_schedule_id as schedule_id
      from deals d
      join enrollments e on e.opportunity_id = d.id and e.status <> 'withdrawn'
      left join collected c on c.deal_id = d.id
     where d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
       and d.selected_deposit_amount is not null
       and round(d.selected_deposit_amount, 2) > 0
       and d.selected_payment_total is not null
       and e.start_date is not null
       and coalesce(c.cents, 0) >= round(d.selected_deposit_amount * 100)::bigint
       and coalesce(c.cents, 0) < round(d.selected_payment_total * 100)::bigint
       and not exists (select 1 from deal_stripe_plan_objects p2
                        where p2.deal_id = d.id and p2.is_current)
  ),
  premises as (
    select distinct d.id as deal_id, d.contact_id, 'plan_not_collecting'::text as premise
      from deals d
      join deal_stripe_plan_objects p on p.deal_id = d.id
     where p.is_current
       and p.status in ('past_due', 'unpaid', 'incomplete', 'incomplete_expired')
       and d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
    union all
    select o.deal_id, o.contact_id, 'balance_start_requires_review'
      from owed o where o.anchor <= current_date
    union all
    select o.deal_id, o.contact_id, 'balance_not_scheduled'
      from owed o where o.anchor > current_date and o.schedule_id is null
  ),
  wanted as (
    select distinct on (p.deal_id)
           p.deal_id,
           format('%s · %s', nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                  public.payment_health_task_reason(p.premise)) as says
      from premises p
      join contacts c on c.id = p.contact_id
     where p_opportunity_id is null or p.deal_id = p_opportunity_id
     order by p.deal_id, p.premise
  )
  update tasks t
     set text = w.says
    from wanted w
   where t.opportunity_id = w.deal_id
     and t.type = 'check_payment'
     and t.done_date is null
     and t.text <> w.says
     and t.text in (
       select format('%s · %s', nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                     public.payment_health_task_reason(premise))
         from contacts c
         cross join unnest(array['plan_not_collecting',
                                 'balance_start_requires_review',
                                 'balance_not_scheduled']) as premise
        where c.id = t.contact_id);
  get diagnostics v_restated = row_count;

  -- Recovered, scheduled, or the plan is gone. Either way the question is
  -- answered, so the Task is finished rather than left to rot. The premise
  -- set is recomputed rather than restated, so opening and closing can
  -- never drift apart -- which is what a third premise would otherwise
  -- have made very easy.
  --
  -- This closes the CONDITION. It deliberately cannot touch
  -- deals.payment_review_code = 'balance_schedule_frozen', which is the
  -- DECISION Leif owns after money has already moved: different artefact,
  -- different table, different lifecycle.
  with collected as (
    select deal_id, sum(round(amount * 100)::bigint) as cents
      from deal_payment_schedule_items where status = 'paid' group by deal_id
  ),
  owed as (
    select d.id as deal_id,
           date_trunc('month', e.start_date)::date as anchor,
           d.stripe_subscription_schedule_id as schedule_id
      from deals d
      join enrollments e on e.opportunity_id = d.id and e.status <> 'withdrawn'
      left join collected c on c.deal_id = d.id
     where d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
       and d.selected_deposit_amount is not null
       and round(d.selected_deposit_amount, 2) > 0
       and d.selected_payment_total is not null
       and e.start_date is not null
       and coalesce(c.cents, 0) >= round(d.selected_deposit_amount * 100)::bigint
       and coalesce(c.cents, 0) < round(d.selected_payment_total * 100)::bigint
       and not exists (select 1 from deal_stripe_plan_objects p2
                        where p2.deal_id = d.id and p2.is_current)
  ),
  premises as (
    select distinct d.id as deal_id
      from deals d
      join deal_stripe_plan_objects p on p.deal_id = d.id
     where p.is_current
       and p.status in ('past_due', 'unpaid', 'incomplete', 'incomplete_expired')
       and d.stage = 'won'
       and d.archived_at is null
       and d.outcome is null
    union
    select o.deal_id from owed o where o.anchor <= current_date
    union
    select o.deal_id from owed o where o.anchor > current_date and o.schedule_id is null
  )
  update tasks t
     set done_date = coalesce(t.done_date, now()), status = 'completed'
   where t.type = 'check_payment'
     and t.done_date is null
     and t.opportunity_id is not null
     and (p_opportunity_id is null or t.opportunity_id = p_opportunity_id)
     and not exists (select 1 from premises pr where pr.deal_id = t.opportunity_id);
  get diagnostics v_closed = row_count;

  return jsonb_build_object('created', v_created, 'closed', v_closed,
                            'restated', v_restated);
end;
$fn$;

comment on function public.reconcile_payment_health_tasks(bigint) is
    'One open check_payment Task per Opportunity whose current Stripe plan is not collecting, or whose paid-deposit balance has no schedule carrying it -- closed when the condition stops. Reads the status the reconciler already stores; no new financial column. Never touches deals.payment_review_code.';

-- ---------------------------------------------------------------------
-- The decision Leif owns, after money has already moved
-- ---------------------------------------------------------------------
-- THIS ONE IS AN EVENT, NOT A CONDITION, which is why it is not a Task.
--
-- Before the first balance payment, moving the start week re-anchors the
-- not_started schedule in place: automatic, safe, reversible. After one has
-- succeeded, re-anchoring would rewrite financial history, so the CRM
-- refuses -- and a refusal nobody is told about is the same as a silent
-- failure. But "somebody asked to move a charged schedule" never stops
-- being true, so a declarative reconciler would close it on its next pass,
-- and it is not a condition about the client's account that recovery could
-- resolve.
--
-- So it goes where this schema already keeps "a human must decide about
-- this payment": deals.payment_review_reason with its machine-readable
-- payment_review_code. That slot is the right shape for three structural
-- reasons rather than by preference.
--
--   DEDUPE IS STRUCTURAL. One column on one Deal. A repeated refusal
--   cannot make a second artefact, because there is nowhere to put one.
--
--   IT CANNOT BE AUTO-CLOSED. ingestStripePayments() resolves
--   `existingReviewReason ?? ambiguity ?? computed`, so a stored reason
--   wins over anything the hourly reconciliation computes and is carried
--   forward untouched; and reconcile_payment_health_tasks() above only ever
--   writes `tasks` rows of type check_payment. Recovery of the card, a
--   later successful charge, a new schedule: none of them can erase it.
--
--   IT ALREADY HAS A MANUAL RESOLUTION. canMarkReviewed() in
--   deals/paymentReview.ts allows a stored, deliberately-raised review to
--   be closed by a person, and PaymentPanel's "Mark reviewed" is that
--   action. Leif resolves it exactly the way she resolves every other
--   payment review.
--
-- It derives its own context instead of being handed any: the Edge Function
-- passes an Opportunity id and nothing else, so it cannot be told a start
-- month or an amount that is not in the database.

create or replace function public.flag_balance_schedule_frozen(
  p_opportunity_id bigint
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_deal deals%rowtype;
  v_start date;
  v_collected bigint;
  v_balance_paid bigint;
  v_reason text;
begin
  select * into v_deal from deals where id = p_opportunity_id;
  if not found then
    return jsonb_build_object('status', 'not-found');
  end if;

  -- Already asked, or a different question is already standing. Either way
  -- this does not stack: an older review is somebody else's unanswered
  -- question and overwriting it would lose it.
  if v_deal.payment_review_reason is not null
     or v_deal.payment_review_code is not null then
    return jsonb_build_object(
      'status', case when v_deal.payment_review_code = 'balance_schedule_frozen'
                     then 'already-raised'
                     else 'another-review-stands' end,
      'review_code', v_deal.payment_review_code);
  end if;

  select e.start_date into v_start
    from enrollments e
   where e.opportunity_id = v_deal.id and e.status <> 'withdrawn'
   order by e.id limit 1;

  select coalesce(sum(round(amount * 100)::bigint), 0) into v_collected
    from deal_payment_schedule_items
   where deal_id = v_deal.id and status = 'paid';
  v_balance_paid := greatest(
    v_collected - round(coalesce(v_deal.selected_deposit_amount, 0) * 100)::bigint, 0);

  -- Answer first, mechanism second: what is true, what was NOT done, and
  -- what the decision is. No Stripe object ids and no lifecycle vocabulary.
  v_reason :=
    'The programme start month changed after the remaining balance had already begun collecting, so the payment schedule was NOT moved. Nothing was charged and no schedule was rewritten.'
    || coalesce(' The start month now reads ' ||
                to_char(date_trunc('month', v_start), 'FMMonth YYYY') || '.', '')
    || ' $' || to_char(v_balance_paid / 100.0, 'FM999999990.00')
    || ' of the balance has already been collected.'
    || ' Decide whether to leave the remaining payments as they stand or change them deliberately.';

  update deals
     set payment_review_reason = v_reason,
         payment_review_code = 'balance_schedule_frozen'
   where id = v_deal.id;

  return jsonb_build_object('status', 'raised',
    'opportunity_id', v_deal.id,
    'start_date', v_start,
    'balance_paid_cents', v_balance_paid);
end;
$fn$;

comment on function public.flag_balance_schedule_frozen(bigint) is
    'Durable manual review when a start-month change could not re-anchor a balance schedule that has already begun collecting. One per Deal, never stacked on another review, never auto-closed -- Leif closes it with Mark reviewed.';

-- ---------------------------------------------------------------------
-- What the hourly sweep retries
-- ---------------------------------------------------------------------
-- Premise C of the reconciler above, stated as a list so the sweep can act
-- on it. Deliberately the SAME predicate: the Deals the reconciler raises a
-- Task for are exactly the Deals the sweep tries to schedule, so a Task
-- appearing and a retry happening can never describe different sets.
--
-- This is what makes the invariant hold without Leif doing anything.
-- Growing Yourself Up takes its start authority from the cohort at Won, so
-- its schedule is created by the deposit webhook itself and no Start Week
-- save is ever needed -- but if that one attempt fails, nothing else used to
-- try again. Now the hourly reconcile-stripe job does, and keeps doing it
-- until there is a schedule or the start month arrives and premise B takes
-- over.
create or replace function public.deals_awaiting_balance_schedule()
returns setof bigint
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select d.id
    from deals d
    join enrollments e on e.opportunity_id = d.id and e.status <> 'withdrawn'
   where d.stage = 'won'
     and d.archived_at is null
     and d.outcome is null
     and d.selected_deposit_amount is not null
     and round(d.selected_deposit_amount, 2) > 0
     and d.selected_payment_total is not null
     and e.start_date is not null
     and date_trunc('month', e.start_date)::date > current_date
     and d.stripe_subscription_schedule_id is null
     and not exists (select 1 from deal_stripe_plan_objects p
                      where p.deal_id = d.id and p.is_current)
     and coalesce((select sum(round(i.amount * 100)::bigint)
                     from deal_payment_schedule_items i
                    where i.deal_id = d.id and i.status = 'paid'), 0)
         >= round(d.selected_deposit_amount * 100)::bigint
     and coalesce((select sum(round(i.amount * 100)::bigint)
                     from deal_payment_schedule_items i
                    where i.deal_id = d.id and i.status = 'paid'), 0)
         < round(d.selected_payment_total * 100)::bigint
   order by d.id;
$fn$;

comment on function public.deals_awaiting_balance_schedule() is
    'Opportunities with a paid deposit, a balance outstanding, a usable future start month and no balance schedule -- premise C of reconcile_payment_health_tasks(), as a list for the hourly sweep to retry.';
