-- AN APPROVAL NEVER MOVES A SALE BACKWARD.
--
-- review_application() wrote stage = 'approved' unconditionally on an
-- approval (approved, bespoke_accepted, offered_other_programme). On a sale
-- that had already gone further, that dragged it BACKWARD through the
-- pipeline. Production holds four deal_stage_events rows where an
-- application review moved an Opportunity from Call Booked or Decision back
-- to Approved (Opportunities 193, 204, 211, 267; nine further backward rows
-- on 2026-09-17/19 were historical bulk writes, not reviews). Celia (contact 335, Opportunity 267) is the one that made it
-- visible -- reviewed while at Call Booked, she dropped out of the Call
-- Booked column and reappeared in Approved.
--
-- The rule is now forward only, and the Application decision is untouched:
--
--   stage before approved  ->  advances to approved (unchanged behaviour)
--   stage = approved       ->  no stage change
--   stage after approved   ->  preserved (call_booked, decision, won, and
--                              legacy onboarding, which fails closed)
--
-- Order comes from ACTIVE_SALES_STAGES (deals/dealActivity.ts), the same
-- array and fail-closed coalesce create_manual_application() and
-- adopt_imported_application() already use. A preserved stage is written
-- back unchanged, which both stage triggers read as no transition, so no
-- deal_stage_events row claims a move that did not happen.
--
-- Deterministic: replaces one function body, repairs no rows. The
-- historical backward moves are carried to the Health Sweep, not repaired
-- here. Signature and grants are unchanged; they are restated so the
-- migration is self-contained.

begin;

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
  v_advances_stage boolean;
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

  -- Approval is FORWARD ONLY with respect to the sale's stage. It moves a
  -- sale that has not yet reached Approved up to Approved, is a no-op at
  -- Approved, and never drags a sale that has already gone further --
  -- Call Booked, Decision, Won, legacy Onboarding -- back to Approved on
  -- the strength of a review. Production did exactly that four times
  -- (Celia, contact 335: call_booked -> approved). The APPLICATION is still
  -- approved; only the Opportunity's stage is left where the sale got to.
  --
  -- Order comes from ACTIVE_SALES_STAGES (deals/dealActivity.ts) -- the
  -- same array and the same fail-closed coalesce create_manual_application()
  -- uses, pinned by contracts/applications/approvalIsForwardOnly.test.ts.
  -- Positions 1..2 are the stages BEFORE 'approved'. A stage the array does
  -- not know (won, legacy onboarding, anything added later) is preserved,
  -- never assumed to be earlier.
  v_advances_stage := coalesce(
    array_position(
      array['interested', 'application_received', 'approved', 'call_booked', 'decision'],
      v_deal.stage),
    0) BETWEEN 1 AND 2;

  -- 1. The decision itself. This UPDATE is what fires
  --    on_application_kit_decision, inside this transaction, once.
  UPDATE applications
     SET status = p_outcome,
         reviewed_at = v_reviewed_at,
         recommended_offer_id = v_recommended_offer_id
   WHERE id = v_app.id;

  -- 2. The Opportunity, aligned with it. Where the stage is preserved it is
  --    written back unchanged, which set_deal_stage_entered_at() and
  --    record_deal_stage_event() both read as no transition: no
  --    stage_entered_at stamp and no deal_stage_events row claiming a move
  --    to Approved that never happened.
  IF p_outcome = 'approved' THEN
    -- "Qualified enough for a sales call" — the pipeline moves forward; final
    -- personal fit is still undecided. outcome is explicitly re-cleared in
    -- case a prior review round set one.
    UPDATE deals
       SET stage = CASE WHEN v_advances_stage THEN 'approved' ELSE stage END,
           outcome = NULL
     WHERE id = v_deal.id;
  ELSIF p_outcome = 'bespoke_accepted' THEN
    -- Accepted is accepted. The only thing bespoke changes is who writes the
    -- reply, so the operational approved path stays exactly as available.
    UPDATE deals
       SET stage = CASE WHEN v_advances_stage THEN 'approved' ELSE stage END,
           outcome = NULL
     WHERE id = v_deal.id;
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
           stage = CASE WHEN v_advances_stage THEN 'approved' ELSE stage END,
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
    'completed_task_id', v_task_id,
    'opportunity_stage', (SELECT stage FROM deals WHERE id = v_deal.id)
  );
END;
$$;

revoke all on function public.review_application(bigint, text, bigint) from public;
revoke all on function public.review_application(bigint, text, bigint) from anon;
grant execute on function public.review_application(bigint, text, bigint) to authenticated;
grant execute on function public.review_application(bigint, text, bigint) to service_role;

commit;
