-- ===========================================================================
-- An application decision is all of it, or none of it
-- ===========================================================================
--
-- Recording a review was four separate browser writes with nothing holding
-- them together:
--
--   applications.status + reviewed_at
--   deals.stage / outcome / owner_decision
--   contacts.sales_eligibility   (Do Not Engage only)
--   tasks.done_date              (the Review Application task)
--
-- Anything that interrupted that sequence — a dropped connection, a refused
-- request, a closed tab — left the Application carrying a decision its
-- Opportunity had never heard of. That is not a theoretical race: it needs
-- one failure in the middle, and a test now proves it happens.
--
-- Concurrency was the second problem. The old path re-read the Application
-- and returned early if it was no longer pending, which is check-then-act:
-- two reviews could both read `pending` and both proceed, and the final
-- Application and Opportunity could disagree about which outcome won.
--
-- This is the same shape as create_manual_application() and
-- adopt_imported_application(): one transaction, SECURITY INVOKER, pinned
-- search_path, granting nothing the caller does not already hold. The
-- difference is the lock. `FOR UPDATE` on the Application is what makes
-- "is this still pending" a decision rather than a guess — the second caller
-- waits, re-reads under the lock, finds a decision already recorded, and is
-- told so instead of overwriting it.
--
-- What it deliberately does NOT do:
--
--   It does not re-implement the Kit decision rule. Updating
--   applications.status fires on_application_kit_decision inside this
--   transaction, exactly as before and exactly once — including its guard
--   that an applicant operation must already exist, which is what keeps an
--   adopted import in MANUAL Kit mode instead of inventing automatic work.
--
--   It does not send anything. No email path exists here, and none is added.
--   Approved and Not Fit reach Leif's Kit automations through the tag, via
--   the outbox, exactly as they did yesterday.
--
--   It does not decide which Task to complete differently. Same heuristic as
--   reviewApplicationTask.ts: the oldest pending review_application task for
--   that Contact.

create or replace function public.review_application(
  p_application_id bigint,
  p_outcome text
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
DECLARE
  v_app applications%ROWTYPE;
  v_deal deals%ROWTYPE;
  v_task_id bigint;
  v_reviewed_at timestamptz;
BEGIN
  -- The four outcomes a live review can record. 'denied' and 'waitlist' are
  -- historical-import vocabulary and are not decisions anybody makes here.
  IF p_outcome NOT IN ('approved', 'needs_higher_care', 'not_fit', 'do_not_engage') THEN
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
  -- nothing to record a decision against without one. The page does not offer
  -- the controls in that case; this is what makes it true rather than
  -- presentational.
  IF v_app.opportunity_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no-opportunity', 'application_id', v_app.id);
  END IF;

  SELECT * INTO v_deal FROM deals WHERE id = v_app.opportunity_id FOR UPDATE;
  IF v_deal.id IS NULL THEN
    RETURN jsonb_build_object('status', 'opportunity-invalid', 'opportunity_id', v_app.opportunity_id);
  END IF;

  -- enforce_application_opportunity_agreement already refuses a mismatched
  -- pair on write. Checked here too so the caller gets a named answer instead
  -- of an exception, and so a pair that drifted historically cannot be decided
  -- against the wrong person.
  IF v_deal.contact_id IS DISTINCT FROM v_app.contact_id THEN
    RETURN jsonb_build_object(
      'status', 'opportunity-mismatch',
      'opportunity_id', v_deal.id,
      'opportunity_contact_id', v_deal.contact_id,
      'application_contact_id', v_app.contact_id
    );
  END IF;

  v_reviewed_at := now();

  -- 1. The decision itself. This UPDATE is what fires
  --    on_application_kit_decision, inside this transaction, once.
  UPDATE applications
     SET status = p_outcome,
         reviewed_at = v_reviewed_at
   WHERE id = v_app.id;

  -- 2. The Opportunity, aligned with it. Same shapes buildDealUpdate() used:
  --    approved moves the pipeline forward and explicitly clears any outcome a
  --    previous round left; the three exits record an outcome and leave the
  --    stage where it stands; Do Not Engage is 'lost' plus the owner decision,
  --    the same pair dneOutcome.ts writes everywhere else.
  IF p_outcome = 'approved' THEN
    UPDATE deals SET stage = 'approved', outcome = NULL WHERE id = v_deal.id;
  ELSIF p_outcome = 'needs_higher_care' THEN
    UPDATE deals SET outcome = 'needs_higher_care' WHERE id = v_deal.id;
  ELSIF p_outcome = 'not_fit' THEN
    UPDATE deals SET outcome = 'not_fit' WHERE id = v_deal.id;
  ELSE
    UPDATE deals SET outcome = 'lost', owner_decision = 'do_not_engage' WHERE id = v_deal.id;
    -- 3. The durable Contact-level gate. Never erases the Contact, never
    --    touches unrelated history.
    UPDATE contacts SET sales_eligibility = 'do_not_engage' WHERE id = v_app.contact_id;
  END IF;

  -- 4. The Review Application task closes because the review happened — never
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
    'completed_task_id', v_task_id
  );
END;
$function$;

-- Leif does this signed in as `authenticated`; anon never. It grants no
-- capability that role does not already hold on applications, deals, contacts
-- and tasks — it only makes the writes one transaction.
revoke all on function public.review_application(bigint, text) from public;
revoke all on function public.review_application(bigint, text) from anon;
grant execute on function public.review_application(bigint, text) to authenticated;
grant execute on function public.review_application(bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- Proof
-- ---------------------------------------------------------------------------
DO $proof$
DECLARE
  v_offer bigint; v_cohort bigint; v_contact bigint; v_second bigint;
  v_deal bigint; v_app bigint; v_task bigint; v_result jsonb;
  v_other_deal bigint; v_other_app bigint;
BEGIN
  BEGIN
    INSERT INTO offers (name, type, duration, current_price, is_active)
    VALUES ('Decision Proof', 'group', '8 weeks', 1500, true) RETURNING id INTO v_offer;
    INSERT INTO cohorts (offer_id, name, status, duration_value, duration_unit)
    VALUES (v_offer, 'Decision Proof — Open', 'applications_open', 8, 'weeks') RETURNING id INTO v_cohort;

    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Decision', 'Proof',
            jsonb_build_array(jsonb_build_object('email', 'decision.proof@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_contact;

    INSERT INTO deals (contact_id, offer_id, cohort_id, stage, amount, entry_path, description)
    VALUES (v_contact, v_offer, v_cohort, 'application_received', 1500, 'other', '')
    RETURNING id INTO v_deal;
    INSERT INTO applications (contact_id, opportunity_id, offer_id, intended_cohort_id,
                              raw_answers, submitted_at, status, reviewed_at, source)
    VALUES (v_contact, v_deal, v_offer, v_cohort, '{}'::jsonb, now(), 'pending', NULL, 'public_form')
    RETURNING id INTO v_app;
    INSERT INTO tasks (contact_id, type, text, due_date, status)
    VALUES (v_contact, 'review_application', 'Review the proof application', now(), 'pending')
    RETURNING id INTO v_task;

    -- ---- refusals, every one of them writing nothing ----
    IF public.review_application(v_app, 'denied') ->> 'status' <> 'outcome-invalid' THEN
      RAISE EXCEPTION 'historical vocabulary was accepted as a live decision';
    END IF;
    IF public.review_application(v_app, 'waitlist') ->> 'status' <> 'outcome-invalid' THEN
      RAISE EXCEPTION 'historical vocabulary was accepted as a live decision';
    END IF;
    IF public.review_application(-1, 'approved') ->> 'status' <> 'application-invalid' THEN
      RAISE EXCEPTION 'a missing application was reviewable';
    END IF;
    IF (SELECT status FROM applications WHERE id = v_app) <> 'pending' THEN
      RAISE EXCEPTION 'a refusal still recorded a decision';
    END IF;

    -- ---- an application with no Opportunity cannot be decided ----
    INSERT INTO applications (contact_id, opportunity_id, offer_id, intended_cohort_id,
                              raw_answers, submitted_at, status, reviewed_at, source)
    VALUES (v_contact, NULL, v_offer, v_cohort, '{}'::jsonb, now(), 'pending', NULL, 'historical_import')
    RETURNING id INTO v_other_app;
    IF public.review_application(v_other_app, 'approved') ->> 'status' <> 'no-opportunity' THEN
      RAISE EXCEPTION 'a decision was recorded against no opportunity';
    END IF;
    IF (SELECT status FROM applications WHERE id = v_other_app) <> 'pending' THEN
      RAISE EXCEPTION 'the no-opportunity refusal still wrote a decision';
    END IF;

    -- ---- Approve: application, opportunity and task move together ----
    v_result := public.review_application(v_app, 'approved');
    IF v_result ->> 'status' <> 'reviewed' THEN
      RAISE EXCEPTION 'approve did not apply: %', v_result;
    END IF;
    IF (SELECT status FROM applications WHERE id = v_app) <> 'approved'
       OR (SELECT reviewed_at FROM applications WHERE id = v_app) IS NULL THEN
      RAISE EXCEPTION 'the application did not record the decision';
    END IF;
    IF (SELECT stage FROM deals WHERE id = v_deal) <> 'approved'
       OR (SELECT outcome FROM deals WHERE id = v_deal) IS NOT NULL THEN
      RAISE EXCEPTION 'the opportunity did not follow the decision';
    END IF;
    IF (SELECT done_date FROM tasks WHERE id = v_task) IS NULL THEN
      RAISE EXCEPTION 'the review task did not close';
    END IF;

    -- ---- and a second decision cannot overwrite the first ----
    v_result := public.review_application(v_app, 'not_fit');
    IF v_result ->> 'status' <> 'already-reviewed'
       OR v_result ->> 'application_status' <> 'approved' THEN
      RAISE EXCEPTION 'an already-decided application was decided again: %', v_result;
    END IF;
    IF (SELECT status FROM applications WHERE id = v_app) <> 'approved' THEN
      RAISE EXCEPTION 'the second decision overwrote the first';
    END IF;
    IF (SELECT stage FROM deals WHERE id = v_deal) <> 'approved'
       OR (SELECT outcome FROM deals WHERE id = v_deal) IS NOT NULL THEN
      RAISE EXCEPTION 'the second decision moved the opportunity';
    END IF;

    -- ---- Do Not Engage carries the Contact gate, and nothing else does ----
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Decision', 'Refused',
            jsonb_build_array(jsonb_build_object('email', 'decision.refused@example.com', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_second;
    INSERT INTO deals (contact_id, offer_id, cohort_id, stage, amount, entry_path, description)
    VALUES (v_second, v_offer, v_cohort, 'application_received', 1500, 'other', '')
    RETURNING id INTO v_other_deal;
    INSERT INTO applications (contact_id, opportunity_id, offer_id, intended_cohort_id,
                              raw_answers, submitted_at, status, reviewed_at, source)
    VALUES (v_second, v_other_deal, v_offer, v_cohort, '{}'::jsonb, now(), 'pending', NULL, 'public_form')
    RETURNING id INTO v_other_app;

    v_result := public.review_application(v_other_app, 'do_not_engage');
    IF v_result ->> 'status' <> 'reviewed' THEN
      RAISE EXCEPTION 'do not engage did not apply: %', v_result;
    END IF;
    IF (SELECT sales_eligibility FROM contacts WHERE id = v_second) <> 'do_not_engage' THEN
      RAISE EXCEPTION 'do not engage did not reach the contact';
    END IF;
    IF (SELECT outcome FROM deals WHERE id = v_other_deal) <> 'lost'
       OR (SELECT owner_decision FROM deals WHERE id = v_other_deal) <> 'do_not_engage' THEN
      RAISE EXCEPTION 'do not engage did not exit the opportunity correctly';
    END IF;
    -- The approved person's eligibility was never touched by somebody else's
    -- refusal.
    IF (SELECT sales_eligibility FROM contacts WHERE id = v_contact) <> 'normal' THEN
      RAISE EXCEPTION 'a refusal changed an unrelated contact';
    END IF;

    -- ---- browser roles ----
    IF has_function_privilege('anon', 'public.review_application(bigint, text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'anon may record a decision';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.review_application(bigint, text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'the owner cannot record a decision';
    END IF;

    RAISE NOTICE 'decision proof: one transaction records the application, its opportunity, the contact gate on do-not-engage and the review task together; a second decision is refused by name rather than overwriting the first; historical vocabulary and a missing opportunity are refused with no writes; anon may not run it';

    RAISE EXCEPTION 'decision proof complete' USING ERRCODE = 'restrict_violation';
  EXCEPTION
    WHEN restrict_violation THEN
      NULL;
  END;
END
$proof$;
