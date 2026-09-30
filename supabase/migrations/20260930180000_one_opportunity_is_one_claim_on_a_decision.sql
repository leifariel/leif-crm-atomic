-- ===========================================================================
-- One Opportunity is one claim on one decision
-- ===========================================================================
--
-- Found by the adversarial pre-use gate run before any human used
-- adopt_imported_application(), and it is the reason that gate exists.
--
-- The authority reused an existing reviewable Opportunity — correctly, that is
-- the rule — but it never asked whether that Opportunity was ALREADY carrying
-- a pending Application. So two pending Applications could end up pointing at
-- one Opportunity.
--
-- That is not cosmetic. reviewApplication.ts writes an outcome to the
-- Application AND its Opportunity together, so approving either one moves the
-- shared Opportunity, and the other Application is left reading `pending`
-- against a decision that has already been made. Which of the two the
-- Opportunity now speaks for is unanswerable.
--
-- create_manual_application() already refuses this exact shape, in these exact
-- words: "a second pending Application against one live sale is two claims on
-- the same decision". Adoption now refuses it the same way, returning the
-- Application that is already waiting so Leif can see whether the two records
-- are the same person.
--
-- Nothing else changes: same eligibility, same stage, same lock, same
-- refusals, same zero Kit work. Deterministic — it replaces a function
-- definition and asserts only structure.
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
$function$;
-- ---------------------------------------------------------------------------
-- Proof
-- ---------------------------------------------------------------------------
DO $proof$
DECLARE
  v_offer bigint; v_cohort bigint; v_contact bigint;
  v_deal bigint; v_live bigint; v_imported bigint; v_result jsonb;
  v_kit_before integer;
BEGIN
  BEGIN
    SELECT count(*) INTO v_kit_before FROM kit_sync_operations;

    INSERT INTO offers (name, type, duration, current_price, is_active)
    VALUES ('One Claim Proof', 'group', '8 weeks', 1234, true) RETURNING id INTO v_offer;
    INSERT INTO cohorts (offer_id, name, status, duration_value, duration_unit)
    VALUES (v_offer, 'One Claim Proof — Open', 'applications_open', 8, 'weeks') RETURNING id INTO v_cohort;
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('One', 'Claim',
            jsonb_build_array(jsonb_build_object('email', 'one.claim@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_contact;

    -- A live Opportunity a review still speaks to, already carrying a pending
    -- Application of its own.
    INSERT INTO deals (contact_id, offer_id, cohort_id, stage, amount, entry_path, description)
    VALUES (v_contact, v_offer, v_cohort, 'application_received', 1234, 'other', '')
    RETURNING id INTO v_deal;
    INSERT INTO applications (contact_id, opportunity_id, offer_id, intended_cohort_id,
                              raw_answers, submitted_at, status, reviewed_at, source)
    VALUES (v_contact, v_deal, v_offer, v_cohort, '{}'::jsonb, now(), 'pending', NULL, 'public_form')
    RETURNING id INTO v_live;

    -- And an imported Application for the same person and round.
    INSERT INTO applications (contact_id, opportunity_id, offer_id, intended_cohort_id,
                              raw_answers, submitted_at, status, reviewed_at, source)
    VALUES (v_contact, NULL, v_offer, v_cohort, '{}'::jsonb, now(), 'pending', NULL, 'historical_import')
    RETURNING id INTO v_imported;

    v_result := public.adopt_imported_application(v_imported);
    IF v_result ->> 'status' <> 'already-pending' THEN
      RAISE EXCEPTION 'two claims were allowed on one opportunity: %', v_result;
    END IF;
    IF (v_result ->> 'application_id')::bigint <> v_live THEN
      RAISE EXCEPTION 'the refusal did not name the application already waiting';
    END IF;

    -- Zero writes.
    IF (SELECT crm_adopted_at FROM applications WHERE id = v_imported) IS NOT NULL
       OR (SELECT opportunity_id FROM applications WHERE id = v_imported) IS NOT NULL THEN
      RAISE EXCEPTION 'the refusal still adopted the application';
    END IF;
    IF (SELECT count(*) FROM applications WHERE opportunity_id = v_deal) <> 1 THEN
      RAISE EXCEPTION 'the opportunity ended up carrying more than one application';
    END IF;
    IF (SELECT count(*) FROM deals WHERE contact_id = v_contact) <> 1 THEN
      RAISE EXCEPTION 'the refusal opened a second opportunity';
    END IF;

    -- Once that Application is decided, the Opportunity is free again and the
    -- ordinary reuse rule applies. Nothing is permanently blocked.
    UPDATE applications SET status = 'not_fit', reviewed_at = now() WHERE id = v_live;
    v_result := public.adopt_imported_application(v_imported);
    IF v_result ->> 'status' <> 'adopted'
       OR (v_result ->> 'reused_opportunity')::boolean IS NOT TRUE
       OR (v_result ->> 'opportunity_id')::bigint <> v_deal THEN
      RAISE EXCEPTION 'a decided application still blocked reuse: %', v_result;
    END IF;

    IF (SELECT count(*) FROM kit_sync_operations) <> v_kit_before THEN
      RAISE EXCEPTION 'the repair created Kit work';
    END IF;

    RAISE NOTICE 'one claim proof: an opportunity already carrying a pending application is refused by name with zero writes, and becomes reusable again once that application is decided';

    RAISE EXCEPTION 'one claim proof complete' USING ERRCODE = 'restrict_violation';
  EXCEPTION
    WHEN restrict_violation THEN
      NULL;
  END;
END
$proof$;
