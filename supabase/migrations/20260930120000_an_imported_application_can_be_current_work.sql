-- ===========================================================================
-- An imported Application can be current work
-- ===========================================================================
--
-- `source = 'historical_import'` says HOW a record arrived. It has never said
-- WHEN it belongs to, and the two got conflated.
--
-- Taylor Carr applied to Growing Yourself Up — January 2027 on 28 August. Her
-- answers came into the CRM through the Notion migration, so her Application
-- says `historical_import`. Her cohort is still taking applications and Leif
-- needs to decide on her today. But she has no Opportunity, and every review
-- outcome writes to the Application AND its Opportunity together
-- (reviewApplication.ts), so her page can only say that no decision can be
-- recorded — about a live applicant, in an open cohort, with real answers on
-- the screen above the sentence.
--
-- The app already knows she is current work. classifyApplication() puts an
-- imported pending Application aimed at a cohort still taking applications
-- into `needs-review`, and says so in its own comment: "the six January 2027
-- records". Nothing about provenance has to change to see her; what is
-- missing is the Opportunity that makes a decision recordable.
--
-- So this adds ONE explicit owner act — Bring into CRM — and the smallest
-- durable fact that records it happened.
--
--   source stays 'historical_import' FOREVER. It is provenance. Rewriting it
--   to 'manual' would claim Leif typed answers she wrote herself.
--
--   crm_adopted_at is the new fact, and it is not a second classification.
--   It answers one question nothing else can: has the owner deliberately
--   brought this imported record into current operations? "Has an
--   Opportunity" cannot answer it — four already-approved January imports
--   have one and must stay out of today's queues. "Is classified
--   needs-review" cannot either — that is already true of Taylor BEFORE
--   anybody decides anything, and it is the condition for OFFERING the act,
--   not evidence of it.
--
-- What it is for, concretely: Kit. An adopted record enters MANUAL Kit mode,
-- because its receipt was never Kit-managed. That is not new behaviour —
-- enqueue_kit_application_decision() already requires an existing applicant
-- operation precisely so "adopting them stays a deliberate act". This marker
-- is how the UI can tell an adopted record from the 99 old questionnaires
-- that must never appear in a Kit queue.

alter table public.applications
  add column if not exists crm_adopted_at timestamptz;

comment on column public.applications.crm_adopted_at is
  'When the owner brought this imported Application into current CRM operations. Null for every record that was never adopted, including live public_form submissions, which never needed adopting. Never a substitute for source, which keeps saying how the record arrived.';

-- ---------------------------------------------------------------------------
-- The act itself
-- ---------------------------------------------------------------------------
-- Mirrors create_manual_application()'s INVARIANTS rather than its signature,
-- for the same reasons that function gives for not reusing
-- submit_public_application(): the same canonical stage, the same active-Deal
-- predicate, the same reviewable-stage rule, the same advisory lock, the same
-- single transaction.
--
-- Where it is STRICTER, deliberately: an Application already carries the
-- person, the programme and the round, so there is nothing to infer — and
-- anything that is not certain is refused rather than guessed. Two of the six
-- eligible January records are refused today for exactly that reason, and
-- both refusals name what Leif should look at.
--
-- SECURITY INVOKER, like create_manual_application(): `authenticated` already
-- holds insert/update on deals and applications, so this grants no capability
-- that role does not have. It only makes the writes atomic, and RLS still
-- applies to every statement inside it.
--
-- It makes NO Kit work and NO provider call, and that is structural rather
-- than remembered: on_application_kit_receipt fires AFTER INSERT on
-- applications (this only updates), and on_application_kit_decision fires
-- only when status changes (this never touches status).
create or replace function public.adopt_imported_application(p_application_id bigint)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
DECLARE
  v_app applications%ROWTYPE;
  v_offer offers%ROWTYPE;
  v_contact contacts%ROWTYPE;
  v_cohort cohorts%ROWTYPE;
  v_deal deals%ROWTYPE;
  v_exact_count integer;
  v_other deals%ROWTYPE;
  v_reused boolean := false;
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
$function$;

-- Leif does this, signed in as `authenticated`. anon never.
revoke all on function public.adopt_imported_application(bigint) from public;
revoke all on function public.adopt_imported_application(bigint) from anon;
grant execute on function public.adopt_imported_application(bigint) to authenticated;
grant execute on function public.adopt_imported_application(bigint) to service_role;

-- ---------------------------------------------------------------------------
-- Proof
-- ---------------------------------------------------------------------------
DO $proof$
DECLARE
  v_offer bigint;
  v_cohort bigint;
  v_closed bigint;
  v_contact bigint;
  v_second bigint;
  v_third bigint;
  v_app bigint;
  v_other_app bigint;
  v_result jsonb;
  v_deal bigint;
  v_deal_count integer;
  v_kit_before integer;
  v_kit_after integer;
BEGIN
  BEGIN
    SELECT count(*) INTO v_kit_before FROM kit_sync_operations;

    INSERT INTO offers (name, type, duration, current_price, is_active)
    VALUES ('Adoption Proof Programme', 'group', '8 weeks', 1234, true)
    RETURNING id INTO v_offer;

    INSERT INTO cohorts (offer_id, name, status, duration_value, duration_unit)
    VALUES (v_offer, 'Adoption Proof — Open', 'applications_open', 8, 'weeks')
    RETURNING id INTO v_cohort;

    INSERT INTO cohorts (offer_id, name, status, duration_value, duration_unit)
    VALUES (v_offer, 'Adoption Proof — Closed', 'applications_closed', 8, 'weeks')
    RETURNING id INTO v_closed;

    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Adoption', 'Proof',
            jsonb_build_array(jsonb_build_object('email', 'adoption.proof@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_contact;

    -- A Taylor-shaped record: imported, pending, open cohort, no Opportunity.
    INSERT INTO applications (contact_id, opportunity_id, offer_id, intended_cohort_id,
                              raw_answers, submitted_at, status, reviewed_at, source)
    VALUES (v_contact, NULL, v_offer, v_cohort, '{"q":"a"}'::jsonb,
            '2026-08-28 18:26:46+00', 'pending', NULL, 'historical_import')
    RETURNING id INTO v_app;

    IF EXISTS (SELECT 1 FROM kit_sync_operations WHERE application_id = v_app) THEN
      RAISE EXCEPTION 'an imported application enqueued Kit work on insert';
    END IF;

    -- ---- it adopts, and creates exactly one Opportunity ----
    v_result := public.adopt_imported_application(v_app);
    IF v_result ->> 'status' <> 'adopted' THEN
      RAISE EXCEPTION 'a current imported application was not adopted: %', v_result;
    END IF;
    IF (v_result ->> 'created_opportunity')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'expected a new opportunity, got %', v_result;
    END IF;
    v_deal := (v_result ->> 'opportunity_id')::bigint;

    IF (SELECT stage FROM deals WHERE id = v_deal) <> 'application_received' THEN
      RAISE EXCEPTION 'the opportunity did not land at application_received';
    END IF;
    IF (SELECT cohort_id FROM deals WHERE id = v_deal) <> v_cohort THEN
      RAISE EXCEPTION 'the opportunity lost the intended cohort';
    END IF;

    -- ---- provenance and content are untouched ----
    IF (SELECT source FROM applications WHERE id = v_app) <> 'historical_import' THEN
      RAISE EXCEPTION 'adoption rewrote provenance';
    END IF;
    IF (SELECT status FROM applications WHERE id = v_app) <> 'pending' THEN
      RAISE EXCEPTION 'adoption changed the decision';
    END IF;
    IF (SELECT raw_answers FROM applications WHERE id = v_app) <> '{"q":"a"}'::jsonb THEN
      RAISE EXCEPTION 'adoption touched the answers';
    END IF;
    IF (SELECT intended_cohort_id FROM applications WHERE id = v_app) <> v_cohort THEN
      RAISE EXCEPTION 'adoption moved the round';
    END IF;
    IF (SELECT reviewed_at FROM applications WHERE id = v_app) IS NOT NULL THEN
      RAISE EXCEPTION 'adoption fabricated a review';
    END IF;
    IF (SELECT crm_adopted_at FROM applications WHERE id = v_app) IS NULL THEN
      RAISE EXCEPTION 'adoption was not recorded';
    END IF;

    -- ---- and it made no Kit work whatsoever ----
    SELECT count(*) INTO v_kit_after FROM kit_sync_operations;
    IF v_kit_after <> v_kit_before THEN
      RAISE EXCEPTION 'adoption created Kit work';
    END IF;

    -- ---- replay is idempotent: same rows, no second Opportunity ----
    v_result := public.adopt_imported_application(v_app);
    IF v_result ->> 'status' <> 'already-adopted' THEN
      RAISE EXCEPTION 'replaying adoption did not report it was already done: %', v_result;
    END IF;
    IF (v_result ->> 'opportunity_id')::bigint <> v_deal THEN
      RAISE EXCEPTION 'replaying adoption pointed somewhere else';
    END IF;
    SELECT count(*) INTO v_deal_count FROM deals
     WHERE contact_id = v_contact AND offer_id = v_offer;
    IF v_deal_count <> 1 THEN
      RAISE EXCEPTION 'replaying adoption produced % opportunities', v_deal_count;
    END IF;

    -- ---- a closed cohort is not current work ----
    INSERT INTO applications (contact_id, opportunity_id, offer_id, intended_cohort_id,
                              raw_answers, submitted_at, status, reviewed_at, source)
    VALUES (v_contact, NULL, v_offer, v_closed, '{}'::jsonb, now(), 'pending', NULL, 'historical_import')
    RETURNING id INTO v_other_app;
    IF public.adopt_imported_application(v_other_app) ->> 'status' <> 'no-open-cohort' THEN
      RAISE EXCEPTION 'an application to a closed round was adoptable';
    END IF;

    -- ---- old vocabulary is never translated ----
    UPDATE applications SET status = 'waitlist' WHERE id = v_other_app;
    IF public.adopt_imported_application(v_other_app) ->> 'status' <> 'status-unsupported' THEN
      RAISE EXCEPTION 'a legacy status was operationalized';
    END IF;
    UPDATE applications SET status = 'approved' WHERE id = v_other_app;
    IF public.adopt_imported_application(v_other_app) ->> 'status' <> 'status-unsupported' THEN
      RAISE EXCEPTION 'an imported approval was silently given a live stage';
    END IF;

    -- ---- a live submission has nothing to adopt ----
    UPDATE applications SET source = 'public_form', status = 'pending' WHERE id = v_other_app;
    IF public.adopt_imported_application(v_other_app) ->> 'status' <> 'not-imported' THEN
      RAISE EXCEPTION 'a live submission was treated as adoptable';
    END IF;

    -- ---- a live sale on another footing is refused, not duplicated ----
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Adoption', 'Selling',
            jsonb_build_array(jsonb_build_object('email', 'adoption.selling@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_second;
    INSERT INTO deals (contact_id, offer_id, cohort_id, stage, amount, entry_path, description)
    VALUES (v_second, v_offer, NULL, 'call_booked', 1234, 'other', '');
    INSERT INTO applications (contact_id, opportunity_id, offer_id, intended_cohort_id,
                              raw_answers, submitted_at, status, reviewed_at, source)
    VALUES (v_second, NULL, v_offer, v_cohort, '{}'::jsonb, now(), 'pending', NULL, 'historical_import')
    RETURNING id INTO v_other_app;
    v_result := public.adopt_imported_application(v_other_app);
    IF v_result ->> 'status' <> 'other-active-sale' THEN
      RAISE EXCEPTION 'a second live opportunity was opened beside one: %', v_result;
    END IF;
    IF (SELECT count(*) FROM deals WHERE contact_id = v_second) <> 1 THEN
      RAISE EXCEPTION 'the refusal still wrote an opportunity';
    END IF;
    IF (SELECT crm_adopted_at FROM applications WHERE id = v_other_app) IS NOT NULL THEN
      RAISE EXCEPTION 'the refusal still recorded an adoption';
    END IF;

    -- ---- an Opportunity at this round's scope is LINKED, never duplicated ----
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Adoption', 'Linking',
            jsonb_build_array(jsonb_build_object('email', 'adoption.linking@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_third;
    INSERT INTO deals (contact_id, offer_id, cohort_id, stage, amount, entry_path, description)
    VALUES (v_third, v_offer, v_cohort, 'interested', 1234, 'other', '')
    RETURNING id INTO v_deal;
    INSERT INTO applications (contact_id, opportunity_id, offer_id, intended_cohort_id,
                              raw_answers, submitted_at, status, reviewed_at, source)
    VALUES (v_third, NULL, v_offer, v_cohort, '{}'::jsonb, now(), 'pending', NULL, 'historical_import')
    RETURNING id INTO v_other_app;
    v_result := public.adopt_imported_application(v_other_app);
    IF v_result ->> 'status' <> 'adopted'
       OR (v_result ->> 'reused_opportunity')::boolean IS NOT TRUE
       OR (v_result ->> 'opportunity_id')::bigint <> v_deal THEN
      RAISE EXCEPTION 'an existing reviewable opportunity was not reused: %', v_result;
    END IF;
    IF (SELECT count(*) FROM deals WHERE contact_id = v_third) <> 1 THEN
      RAISE EXCEPTION 'linking created a second opportunity';
    END IF;

    -- ---- and a sale past the point a review speaks to is refused ----
    UPDATE deals SET stage = 'call_booked' WHERE id = v_deal;
    UPDATE applications SET crm_adopted_at = NULL, opportunity_id = NULL WHERE id = v_other_app;
    IF public.adopt_imported_application(v_other_app) ->> 'status' <> 'later-stage' THEN
      RAISE EXCEPTION 'a review was set up to drag a live sale backward';
    END IF;

    -- ---- browser roles cannot reach past their own rights ----
    IF has_function_privilege('anon', 'public.adopt_imported_application(bigint)', 'EXECUTE') THEN
      RAISE EXCEPTION 'anon may adopt an application';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.adopt_imported_application(bigint)', 'EXECUTE') THEN
      RAISE EXCEPTION 'the owner cannot adopt an application';
    END IF;

    -- ---- nothing in any of that reached Kit ----
    SELECT count(*) INTO v_kit_after FROM kit_sync_operations;
    IF v_kit_after <> v_kit_before THEN
      RAISE EXCEPTION 'adoption created Kit work somewhere in this proof';
    END IF;

    RAISE NOTICE 'adoption proof: an imported pending application to an open round gains exactly one Application Received opportunity and a recorded adoption, keeps its provenance, answers, round and undecided status, replays without duplicating, reuses a reviewable opportunity rather than opening a second, refuses a later-stage sale, another live sale, a closed round, a legacy status and a live submission, and creates no Kit work at any point';

    RAISE EXCEPTION 'adoption proof complete' USING ERRCODE = 'restrict_violation';
  EXCEPTION
    WHEN restrict_violation THEN
      NULL;
  END;
END
$proof$;
