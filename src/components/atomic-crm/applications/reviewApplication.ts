import type { DataProvider, Identifier } from "ra-core";

import type { Application, Deal, Enrollment, Offer } from "../types";
import {
  applyDoNotEngageToContact,
  buildDoNotEngageDealUpdate,
} from "../deals/dneOutcome";
import { completeReviewApplicationTask } from "./reviewApplicationTask";

// Deliberately an explicit literal union, NOT `Exclude<ApplicationStatus,
// "pending">` — ApplicationStatus also carries 'denied'/'waitlist'
// (historical-import-only values, Phase 4H). Deriving this type from
// ApplicationStatus would silently let those two leak in here as if a live
// review action could set them, and buildDealUpdate's switch below would
// return undefined for them with no compiler error (no exhaustiveness
// check on a switch without a `never` default). Neither value is ever a
// choice Leif makes via a review action.
export type ApplicationReviewOutcome =
  | "approved"
  | "needs_higher_care"
  | "not_fit"
  | "do_not_engage"
  // Leif is willing to work with them, in the other programme. The direction
  // is never asked for: there is one other programme, and review_application()
  // refuses rather than guessing if that stops being true.
  | "offered_other_programme"
  // Accepted / rejected, answered by hand. Two values rather than one, because
  // "bespoke" on its own would be an unresolved state sitting in a queue that
  // only knows about decided and undecided.
  | "bespoke_accepted"
  | "bespoke_rejected";

export type ReviewApplicationResult =
  | { applied: true }
  | {
      applied: false;
      reason:
        | "already-reviewed"
        | "no-opportunity"
        | "opportunity-mismatch"
        | "outcome-invalid"
        | "application-invalid"
        | "opportunity-invalid"
        // Only the recommendation can hit these three, and all three are
        // checked before anything is written.
        | "recommendation-ambiguous"
        | "already-enrolled"
        | "scholarship-held";
    };

type ReviewCapableProvider = DataProvider & {
  reviewApplication?: (input: {
    applicationId: Identifier;
    outcome: ApplicationReviewOutcome;
  }) => Promise<{ status: string; application_status?: string }>;
};

// Centralizes every write an Application review decision requires across
// Application / Opportunity / Contact / Task (Native Applications slice,
// §19 — the UI calls this trustworthy domain operation, business rules
// never live in a button's onClick). Idempotent: re-running against an
// Application that is no longer "pending" is a safe no-op rather than a
// second write, so a double-click, a cached tab, or Back/Forward can never
// silently overwrite a newer decision (§17.F/G) — the caller checks
// `applied` and tells the user rather than assuming success. The pending
// check re-fetches the Application rather than trusting the caller's
// `application` argument: a stale UI's copy of that argument is exactly as
// stale as what it's meant to guard against, so only the server's current
// state can actually detect "someone else already reviewed this".
export const reviewApplication = async ({
  dataProvider,
  application,
  outcome,
}: {
  dataProvider: DataProvider;
  application: Pick<Application, "id">;
  // The Opportunity is deliberately NOT a parameter any more. It is resolved
  // from the Application under the lock, because a caller's copy of it is
  // exactly as stale as the status check it was meant to accompany.
  outcome: ApplicationReviewOutcome;
}): Promise<ReviewApplicationResult> => {
  // ONE authority, one transaction, one lock.
  //
  // This used to be four separate writes with nothing holding them together,
  // and a test proved what that cost: fail between the Application and the
  // Opportunity and the Application carries a decision its Opportunity has
  // never heard of. The re-read below was also check-then-act — two reviewers
  // could both see 'pending' and both proceed.
  //
  // review_application() takes FOR UPDATE on both rows, so the second caller
  // waits, re-reads, and is told which decision already won instead of
  // overwriting it. See 20261001090000.
  const rpc = (dataProvider as ReviewCapableProvider).reviewApplication;
  if (typeof rpc === "function") {
    const result = await rpc({ applicationId: application.id, outcome });
    if (result.status === "reviewed") return { applied: true };
    return {
      applied: false,
      reason: (result.status ?? "already-reviewed") as Exclude<
        ReviewApplicationResult,
        { applied: true }
      >["reason"],
    };
  }
  return await reviewApplicationMirror({
    dataProvider,
    applicationId: application.id,
    outcome,
  });
};

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------
// A provider with no database function behind it makes the same decisions in
// the same order. What it cannot reproduce is the transaction or the row
// locks — nothing in a browser can, which is exactly why production does not
// run this.
export const reviewApplicationMirror = async ({
  dataProvider,
  applicationId,
  outcome,
}: {
  dataProvider: DataProvider;
  applicationId: Identifier;
  outcome: ApplicationReviewOutcome;
}): Promise<ReviewApplicationResult> => {
  const { data: currentApplication } = await dataProvider.getOne<Application>(
    "applications",
    { id: applicationId },
  );
  if (currentApplication.status !== "pending") {
    return { applied: false, reason: "already-reviewed" };
  }

  // Resolved from the Application, exactly as the authority does — never from
  // whatever the caller happened to be holding.
  if (currentApplication.opportunity_id == null) {
    return { applied: false, reason: "no-opportunity" };
  }
  const { data: currentDeal } = await dataProvider.getOne<Deal>("deals", {
    id: currentApplication.opportunity_id,
  });
  if (currentDeal.contact_id !== currentApplication.contact_id) {
    return { applied: false, reason: "opportunity-mismatch" };
  }

  // Everything the recommendation can refuse, resolved BEFORE the first
  // write, so a refusal still means nothing happened.
  let recommended: Offer | null = null;
  if (outcome === "offered_other_programme") {
    const resolved = await resolveRecommendedProgramme(
      dataProvider,
      currentDeal.offer_id,
    );
    if (resolved.status !== "ok") {
      return { applied: false, reason: resolved.status };
    }
    recommended = resolved.offer;

    const { total: enrollments } = await dataProvider.getList<Enrollment>(
      "enrollments",
      {
        filter: { opportunity_id: currentDeal.id },
        pagination: { page: 1, perPage: 1 },
        sort: { field: "id", order: "ASC" },
      },
    );
    if ((enrollments ?? 0) > 0) {
      return { applied: false, reason: "already-enrolled" };
    }
    if (currentDeal.pricing_mode === "scholarship") {
      return { applied: false, reason: "scholarship-held" };
    }
  }

  const reviewedAt = new Date().toISOString();

  await dataProvider.update("applications", {
    id: currentApplication.id,
    data: {
      status: outcome,
      reviewed_at: reviewedAt,
      // What they applied for is never touched. This is the second fact.
      recommended_offer_id: recommended ? recommended.id : null,
    },
    previousData: currentApplication,
  });

  await dataProvider.update("deals", {
    id: currentDeal.id,
    data: buildDealUpdate(outcome, recommended, currentDeal),
    previousData: currentDeal,
  });

  if (recommended) {
    // The database writes this from a trigger, because deal_offer_events is
    // deliberately closed to a browser. The mirror writes it directly for the
    // same reason it writes anything: so the shape a FakeRest surface sees is
    // the shape production produces.
    await dataProvider.create("deal_offer_events", {
      data: {
        opportunity_id: currentDeal.id,
        enrollment_id: null,
        from_offer_id: currentDeal.offer_id,
        to_offer_id: recommended.id,
        source: "app",
        occurred_at: reviewedAt,
        recorded_at: reviewedAt,
        note: "The sales path moved because their application was answered with a recommendation to the other programme. The application itself still records the programme they applied for.",
      } as never,
    });
  }

  if (outcome === "do_not_engage") {
    await applyDoNotEngageToContact(dataProvider, currentDeal.contact_id);
  }

  // Review Application completes automatically on any outcome (§4-§7) —
  // never the reverse (see reviewApplicationTask.ts).
  await completeReviewApplicationTask(
    dataProvider,
    currentDeal.contact_id,
    reviewedAt,
  );

  return { applied: true };
};

/**
 * Which programme a recommendation points at.
 *
 * Never asked for, and never guessed: the one OTHER active programme. If the
 * catalog ever holds more than one, this refuses — the destination becomes
 * part of somebody's history the moment it is recorded, and a coin toss is
 * not a decision Leif made.
 */
const resolveRecommendedProgramme = async (
  dataProvider: DataProvider,
  fromOfferId: Identifier | null | undefined,
): Promise<
  { status: "ok"; offer: Offer } | { status: "recommendation-ambiguous" }
> => {
  const { data: offers } = await dataProvider.getList<Offer>("offers", {
    filter: { is_active: true },
    pagination: { page: 1, perPage: 100 },
    sort: { field: "id", order: "ASC" },
  });
  const candidates = (offers ?? []).filter(
    (offer) =>
      offer.is_active !== false && String(offer.id) !== String(fromOfferId),
  );
  if (candidates.length !== 1) return { status: "recommendation-ambiguous" };
  return { status: "ok", offer: candidates[0] };
};

const buildDealUpdate = (
  outcome: ApplicationReviewOutcome,
  recommended: Offer | null,
  currentDeal: Pick<Deal, "cohort_id">,
): Partial<Deal> => {
  switch (outcome) {
    case "approved":
      // "Qualified enough for a sales call" — the pipeline moves forward;
      // final personal fit is still undecided (§1/§4). outcome stays null,
      // explicitly re-asserted here in case a prior review round set one.
      return { stage: "approved", outcome: null };
    case "bespoke_accepted":
      // Accepted is accepted. Bespoke changes who writes the reply, not what
      // the sales path may now do.
      return { stage: "approved", outcome: null };
    case "offered_other_programme":
      // The SAME Opportunity moves to the recommended programme and behaves
      // like that programme's approved path. A round belongs to the programme
      // that has rounds, so moving into an individual programme leaves any
      // cohort behind — and moving into a group one does not pick a round.
      return {
        offer_id: recommended!.id,
        cohort_id: recommended!.type === "group" ? currentDeal.cohort_id : null,
        stage: "approved",
        outcome: null,
      };
    case "needs_higher_care":
      return { outcome: "needs_higher_care" };
    case "not_fit":
      return { outcome: "not_fit" };
    case "bespoke_rejected":
      // A rejection reads as the same exit everywhere that counts exits.
      return { outcome: "not_fit" };
    case "do_not_engage":
      // See deals/dneOutcome.ts for why this is 'lost' + owner_decision
      // rather than a dedicated Opportunity outcome value (§7) — shared
      // with sales-calls/completeSalesCallOutcome.ts's own Do Not Engage
      // branch so the logic lives in exactly one place.
      return buildDoNotEngageDealUpdate();
  }
};
