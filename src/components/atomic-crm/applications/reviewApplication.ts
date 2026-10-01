import type { DataProvider, Identifier } from "ra-core";

import type { Application, Deal } from "../types";
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
  | "do_not_engage";

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
        | "opportunity-invalid";
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

  const reviewedAt = new Date().toISOString();

  await dataProvider.update("applications", {
    id: currentApplication.id,
    data: { status: outcome, reviewed_at: reviewedAt },
    previousData: currentApplication,
  });

  await dataProvider.update("deals", {
    id: currentDeal.id,
    data: buildDealUpdate(outcome),
    previousData: currentDeal,
  });

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

const buildDealUpdate = (outcome: ApplicationReviewOutcome): Partial<Deal> => {
  switch (outcome) {
    case "approved":
      // "Qualified enough for a sales call" — the pipeline moves forward;
      // final personal fit is still undecided (§1/§4). outcome stays null,
      // explicitly re-asserted here in case a prior review round set one.
      return { stage: "approved", outcome: null };
    case "needs_higher_care":
      return { outcome: "needs_higher_care" };
    case "not_fit":
      return { outcome: "not_fit" };
    case "do_not_engage":
      // See deals/dneOutcome.ts for why this is 'lost' + owner_decision
      // rather than a dedicated Opportunity outcome value (§7) — shared
      // with sales-calls/completeSalesCallOutcome.ts's own Do Not Engage
      // branch so the logic lives in exactly one place.
      return buildDoNotEngageDealUpdate();
  }
};
