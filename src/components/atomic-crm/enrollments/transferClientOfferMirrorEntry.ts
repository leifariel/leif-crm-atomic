import type { DataProvider, Identifier } from "ra-core";

import { transferClientOffer } from "./transferClientOffer";

// The provider-shaped entry point for the FakeRest transfer mirror.
//
// transferClientOffer() prefers this provider method when it exists, so it
// cannot call itself: this reaches the mirror deliberately, by handing it a
// provider WITHOUT the method, and returns the snake_case shape the real
// Postgres function returns so the caller cannot tell them apart.
export const transferClientOfferMirrorEntry = async (
  dataProvider: DataProvider,
  opportunityId: Identifier,
  toOfferId: Identifier,
): Promise<Record<string, unknown>> => {
  const result = await transferClientOffer(
    { ...dataProvider, transferEnrolledOpportunityOffer: undefined } as never,
    { opportunityId, toOfferId },
  );

  if (result.status === "transferred") {
    return {
      status: "transferred",
      opportunity_id: opportunityId,
      from_offer_id: result.fromOfferId,
      to_offer_id: result.toOfferId,
      retired: result.retired,
      relabelled: result.relabelled,
      added: result.added,
      kept_done: result.keptDone,
    };
  }
  if (result.status === "needs-cohort") {
    return { status: result.status, reason: result.reason };
  }
  return { status: result.status };
};
