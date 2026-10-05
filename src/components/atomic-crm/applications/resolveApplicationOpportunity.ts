import type { Application, Deal } from "../types";
import { isActiveOpportunity } from "../deals/dealActivity";

// Which existing sales conversation this Application belongs to — asked,
// never guessed.
//
// Samantha Herold (application 97) and Celia (146) were both stuck in a
// contradiction the page stated out loud: "There is already a live sales
// conversation with this person for this programme" AND "No sales
// opportunity is linked to this application, so a decision cannot be
// recorded here yet." Both sentences were true. Together they were a dead
// end, and Leif could not record a decision at all.
//
// The shape, from production: a historical_import Application for Growing
// Yourself Up with intended_cohort 4 and no opportunity_id, beside a live
// Deal for the same person and the same offer at `call_booked` carrying
// cohort_id NULL. Adoption refuses — correctly — because creating a second
// Opportunity beside a live one is worse than the dead end. What was
// missing was the third option: link the Application to the Opportunity
// that already exists.
//
// Cohort is deliberately NOT part of the match. The Deal carries no cohort
// at all, which is why `adoptionConflict` could not pair them, and a Deal
// with no round is not a Deal for a DIFFERENT round. The offer and the
// person are what make this the same conversation; the round is something
// the Opportunity may acquire later.
//
// The database is still the authority. enforce_application_opportunity_
// agreement() refuses any link whose Opportunity does not exist, belongs to
// another Contact, or is for another Offer without a recorded offer change.
// This decides what to OFFER; the trigger decides what is allowed.

export type OpportunityCandidate = {
  id: Deal["id"];
  stage: string;
  cohortId: Deal["cohort_id"];
  createdAt: string;
  stageEnteredAt: string | null;
  amount: number | null;
};

export type ResolutionVerdict =
  // Nothing live to link to. Adoption's own path applies instead.
  | { kind: "none" }
  // Exactly one live conversation for this person and programme. Certain
  // enough to offer, still confirmed by Leif before it is written.
  | { kind: "one"; candidate: OpportunityCandidate }
  // More than one. ATOMIC HANDLES CERTAINTY. LEIF HANDLES AMBIGUITY —
  // the CRM shows them and says nothing about which is right.
  | { kind: "many"; candidates: OpportunityCandidate[] };

const toCandidate = (deal: Deal): OpportunityCandidate => ({
  id: deal.id,
  stage: deal.stage,
  cohortId: deal.cohort_id ?? null,
  createdAt: deal.created_at,
  stageEnteredAt: deal.stage_entered_at ?? null,
  amount: deal.amount ?? null,
});

export const resolveApplicationOpportunity = (
  application: Pick<Application, "contact_id" | "offer_id" | "opportunity_id">,
  deals: readonly Deal[],
): ResolutionVerdict => {
  // Already linked: there is nothing to resolve, and offering to would
  // invite relinking something that is already correct.
  if (application.opportunity_id != null) return { kind: "none" };

  const candidates = deals
    .filter(
      (deal) =>
        String(deal.contact_id) === String(application.contact_id) &&
        String(deal.offer_id) === String(application.offer_id) &&
        isActiveOpportunity(deal),
    )
    .map(toCandidate)
    // Oldest first: the conversation that has been running longest is the
    // one a reviewer is most likely to mean, and a stable order means the
    // list does not reshuffle between renders.
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1)
    return { kind: "one", candidate: candidates[0]! };
  return { kind: "many", candidates };
};
