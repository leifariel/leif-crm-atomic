import type { DataProvider, Identifier } from "ra-core";

import { reconcileClientOnboarding } from "./reconcileClientOnboarding";

// The provider-shaped entry point for the FakeRest reconcile mirror.
//
// reconcileClientOnboarding() prefers this provider method when it exists, so
// it cannot call itself: this reaches the mirror deliberately, by handing it a
// provider WITHOUT the method, and returns the snake_case shape the real
// Postgres function returns so the caller cannot tell them apart.
export const reconcileClientOnboardingMirrorEntry = async (
  dataProvider: DataProvider,
  opportunityId: Identifier,
  fromOfferId: Identifier | null,
): Promise<Record<string, unknown>> => {
  const result = await reconcileClientOnboarding(
    { ...dataProvider, reconcileEnrollmentToCurrentOffer: undefined } as never,
    { opportunityId, fromOfferId },
  );

  if (result.status === "reconciled") {
    return {
      status: "reconciled",
      opportunity_id: opportunityId,
      from_offer_id: result.fromOfferId,
      to_offer_id: result.toOfferId,
      retired: result.retired,
      relabelled: result.relabelled,
      added: result.added,
      kept_done: result.keptDone,
      event_recorded: result.eventRecorded,
    };
  }
  if (result.status === "terminal-enrollment") {
    return {
      status: result.status,
      enrollment_status: result.enrollmentStatus,
    };
  }
  if (result.status === "needs-source-offer") {
    return { status: result.status, foreign_keys: result.foreignKeys };
  }
  if (result.status === "source-offer-mismatch") {
    return { status: result.status, unmatched_keys: result.unmatchedKeys };
  }
  return { status: result.status };
};
