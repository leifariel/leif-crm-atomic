// Centralizes the Waitlist <-> Opportunity consistency invariant (Human-
// acceptance repair pass, §4/§5): a Contact cannot stay Waiting/Invited for
// a relationship they already have an active Opportunity for — Sarah Jones
// had an Approved Opportunity while her Living Example entry still said
// Waiting, because nothing but the Waitlist's OWN "Convert to Opportunity"
// button ever flipped an entry, and an Opportunity created or advanced
// through any other path (New Opportunity, an Application, drag-and-drop
// on the Kanban, a future integration) never went through it.
//
// This is wired into dataProvider.ts's ONE "deals" resource's
// afterCreate/afterUpdate lifecycle callbacks — every write to a Deal,
// regardless of which UI screen made it, funnels through those two hooks,
// so this is the single place the invariant is enforced (never scattered
// "also update the waitlist" calls across individual pages).
// waitlistActions.ts's own convertToOpportunity calls this directly too
// (its reuse-existing-deal branch writes nothing to "deals", so the
// dataProvider hook never fires for it) — see that file's own comment.
import type { DataProvider } from "ra-core";

import type { Deal, WaitlistEntry } from "../types";
import { ACTIVE_WAITLIST_STATUSES } from "./waitlistConstants";

// A Deal spends a waitlist place once the SALE HAS REALLY STARTED: it has
// not exited (archived, or an exit outcome) AND it has reached stage
// application_received or later.
//
// The stage half is the §4b Phase 2A0 ruling. Phase 2 creates an Interested
// Opportunity the moment an invitation is delivered, and without it every
// invited person would be converted the instant that happened. Invited means
// invited and not yet progressed; converted begins at Application Received.
//
// Stages are ENUMERATED rather than ordered, so one added later converts
// nobody until somebody decides it should. Won is here because a won sale
// carries no outcome and is certainly not still waiting; legacy onboarding
// for the same reason. Mirrors handle_deal_waitlist_sync() exactly —
// migration 20261012100000 — and contracts/waitlist/aPlaceIsSpentWhenTheSale
// Starts.test.ts pins the two lists together.
const SPENDS_A_WAITLIST_PLACE: ReadonlySet<string> = new Set([
  "application_received",
  "approved",
  "call_booked",
  "decision",
  "won",
  "onboarding",
]);

const theSaleHasReallyStarted = (
  deal: Pick<Deal, "archived_at" | "outcome" | "stage">,
) =>
  deal.archived_at == null &&
  deal.outcome == null &&
  SPENDS_A_WAITLIST_PLACE.has(deal.stage);

// Compatible = same Contact + Offer, and:
// - a cohort-specific entry (cohort_id set) matches only that exact Cohort
//   ("a September-specific waitlist because the person has a November
//   Opportunity" must NOT convert), or
// - an offer-level entry (cohort_id null — "I want this generally") is
//   satisfied by ANY cohort of that Offer, since that's what "generally"
//   meant, and trivially by an individual Offer's own null cohort (LE).
const isCompatible = (entry: WaitlistEntry, deal: Deal) =>
  entry.contact_id === deal.contact_id &&
  entry.offer_id === deal.offer_id &&
  (entry.cohort_id == null || entry.cohort_id === deal.cohort_id);

/**
 * Marks every compatible Waitlist Entry Converted, linked to this Deal,
 * WITHOUT asking what stage the Deal is at.
 *
 * For the callers that already know the place is spent because of something
 * that just happened outside the Deal row: an application arrived
 * (submitApplication, createManualApplication) or Leif pressed Convert to
 * Opportunity (waitlistActions). Each reuses an existing Deal and so writes
 * nothing to "deals", which is why the automatic path below never fires for
 * them. The SQL side does exactly this too — submit_public_application() and
 * the manual-application RPC run their own UPDATE in the reuse branch, and
 * only the TRIGGER is stage-gated.
 *
 * Idempotent: only touches entries still waiting/invited.
 */
export const convertCompatibleWaitlistEntries = async (
  deal: Deal,
  dataProvider: DataProvider,
): Promise<void> => {
  const { data: entries } = await dataProvider.getList<WaitlistEntry>(
    "waitlist_entries",
    {
      filter: { contact_id: deal.contact_id, offer_id: deal.offer_id },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    },
  );

  const compatible = entries.filter(
    (entry) =>
      ACTIVE_WAITLIST_STATUSES.has(entry.status) && isCompatible(entry, deal),
  );
  if (compatible.length === 0) return;

  const convertedAt = new Date().toISOString();
  await Promise.all(
    compatible.map((entry) =>
      dataProvider.update("waitlist_entries", {
        id: entry.id,
        data: {
          status: "converted",
          converted_at: convertedAt,
          converted_opportunity_id: deal.id,
        },
        previousData: entry,
      }),
    ),
  );
};

/**
 * The AUTOMATIC rule, wired into the "deals" afterCreate/afterUpdate hooks:
 * a Deal that has really started a sale spends any compatible waitlist place.
 *
 * This is the mirror of the `on_deal_waitlist_sync` trigger, and it is
 * stage-gated for the same reason the trigger is — see
 * `theSaleHasReallyStarted`. An Interested Opportunity, including the one
 * §4b Phase 2 will create when an invitation is delivered, leaves the place
 * exactly where it was.
 */
export const syncWaitlistForActiveDeal = async (
  deal: Deal,
  dataProvider: DataProvider,
): Promise<void> => {
  if (!theSaleHasReallyStarted(deal)) return;
  await convertCompatibleWaitlistEntries(deal, dataProvider);
};
