-- A WAITLIST PLACE IS SPENT WHEN THE SALE REALLY STARTS.
--
-- §4b Phase 2A0, and a prerequisite for the rest of Phase 2.
--
-- `handle_deal_waitlist_sync()` converted a waiting/invited waitlist entry
-- whenever ANY active same-offer Opportunity was written, whatever stage it
-- was at. Phase 2 will create an Interested Opportunity the moment an
-- invitation is delivered, so that rule would have flipped all 54 people
-- currently resting at `invited` straight to `converted` — as an invisible
-- side effect of a backfill, which is exactly the kind of data movement this
-- project refuses.
--
-- Leif's ruling: `invited` means invited and not yet progressed into the
-- sales process. `converted` begins at same-offer Application Received or
-- later. So the trigger now asks what stage the sale is at.
--
-- It is AFTER INSERT OR UPDATE and stays that way, because a sale reaches
-- Application Received two different ways: created there directly (the public
-- form, which is how shimes06's place was spent on 11 Oct), or advanced there
-- from Interested later. Keying the rule to INSERT alone would miss the
-- second.
--
-- The stages are ENUMERATED rather than ordered, so a stage added later
-- converts nobody until somebody decides it should. 'won' is included because
-- a won sale carries no outcome and is certainly not still waiting; legacy
-- 'onboarding' for the same reason.
--
-- RECLASSIFIES NOTHING ON DEPLOY. Production holds zero active Opportunities
-- at stage 'interested' — all 39 interested rows are concluded (18 lost, 21
-- nurture) — so no existing waitlist entry changes because of this. Verified
-- against production before writing it.
--
-- Deterministic and replay-safe: it replaces a function body and asserts
-- nothing about any row.

CREATE OR REPLACE FUNCTION "public"."handle_deal_waitlist_sync"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
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
