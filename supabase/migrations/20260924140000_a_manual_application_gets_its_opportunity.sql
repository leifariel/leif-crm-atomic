-- The Opportunity a manually entered Application cannot do without.
--
-- The CRM's first pipeline stage IS "Application Received", and every
-- review outcome writes to the Application AND its Opportunity together
-- (reviewApplication.ts -> applications.status/reviewed_at plus
-- deals.stage/outcome). So an Application with no Opportunity is a record
-- that looks like review work and cannot be reviewed — which is exactly
-- what "+ New Application" produced when it wrote the Application alone.
--
-- The canonical public-form path already establishes this pair inside one
-- transaction: submit_public_application() resolves the Contact, reuses or
-- creates a Deal at 'application_received', then writes the Application
-- pointing at it. That function is not reusable here, for three reasons
-- that are all about truth rather than convenience:
--
--   it identifies the applicant BY EMAIL, and Leif picks a specific
--   Contact, who may not have an email address yet;
--
--   it is granted to service_role ONLY, deliberately — it is the
--   transactional primitive behind the anonymous /apply intake, and Leif
--   signs in as `authenticated`;
--
--   it stamps source='public_form' and entry_path='application_form',
--   both of which would claim a submission that never happened.
--
-- So this mirrors its INVARIANT, not its signature: the same stage, the
-- same Deal shape, the same reuse rule via the same canonical
-- public.deal_is_active() predicate, the same advisory lock against a
-- double click, and the same single transaction. Everything else an
-- Opportunity needs — offer/cohort validation, the commercial snapshot,
-- the Contact-derived name, stage_entered_at, the stage event, waitlist
-- conversion — is written by the deals triggers, which is why the Deal
-- below is a plain INSERT and not a second copy of those rules.
--
-- SECURITY INVOKER on purpose. `authenticated` already holds insert on
-- deals and applications (06_grants.sql), so this grants no capability
-- that role does not have; it only makes the two writes atomic. RLS still
-- applies to every statement inside it.
--
-- Deterministic: it creates a function and its grants, reads no business
-- row, and asserts only structure. It belongs in the deterministic set.

CREATE OR REPLACE FUNCTION public.create_manual_application(p_contact_id bigint, p_offer_id bigint, p_cohort_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$
;

-- 20260920120000 narrowed the default privileges for new functions in
-- public, so this one arrives reachable by its owner and nobody else.
-- The grant is therefore explicit, and deliberately excludes anon: this
-- is a signed-in CRM action, never a public capability.
revoke all on function public.create_manual_application(bigint, bigint, bigint) from public;
revoke all on function public.create_manual_application(bigint, bigint, bigint) from anon;
grant execute on function public.create_manual_application(bigint, bigint, bigint) to authenticated;
grant execute on function public.create_manual_application(bigint, bigint, bigint) to service_role;

-- The function is useless to `authenticated` if the canonical predicate it
-- calls is not. Functions created before 20260920120000 kept Postgres's
-- EXECUTE-to-PUBLIC default, so this is normally already true — asserted
-- rather than assumed, because a clean room that ever tightens it would
-- otherwise fail at runtime instead of here.
do $$
begin
  if not has_function_privilege(
       'authenticated',
       'public.deal_is_active(timestamptz, text, text)',
       'EXECUTE') then
    raise exception 'authenticated cannot execute deal_is_active() — create_manual_application() would fail at runtime';
  end if;

  if not has_function_privilege(
       'authenticated',
       'public.create_manual_application(bigint, bigint, bigint)',
       'EXECUTE') then
    raise exception 'authenticated cannot execute create_manual_application()';
  end if;

  if has_function_privilege(
       'anon',
       'public.create_manual_application(bigint, bigint, bigint)',
       'EXECUTE') then
    raise exception 'create_manual_application() must never be reachable by anon';
  end if;
end $$;
