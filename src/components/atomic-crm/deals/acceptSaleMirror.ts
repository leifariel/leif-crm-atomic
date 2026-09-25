import type { DataProvider, Identifier } from "ra-core";

import type { Deal } from "../types";

// The FakeRest mirror of accept_sale().
//
// Production accepts a sale inside one transaction, through a function
// that runs as the database owner — which is what lets it past the guard
// that refuses a browser hand-edit of stage. FakeRest has neither the
// transaction nor the guard, so this mirrors only the DECISION TABLE, and
// the atomicity is proven against a real Postgres rather than against this.
//
// Convergent, not merely idempotent: a deal already at Won returns
// 'already-won' rather than refusing, because a sale that landed halfway
// is finished here, not rejected.
export const acceptSaleMirror = async (
  dataProvider: DataProvider,
  opportunityId: Identifier,
): Promise<Record<string, unknown>> => {
  const { data: deal } = await dataProvider
    .getOne<Deal>("deals", { id: opportunityId })
    .catch(() => ({ data: null as Deal | null }));
  if (!deal) return { status: "not-found" };

  // Fail closed on anything that already ended differently. A sale may not
  // overwrite somebody's recorded no.
  if (deal.archived_at != null) {
    return {
      status: "conflicting-outcome",
      reason: "This opportunity has been archived.",
    };
  }
  if (deal.outcome != null) {
    return {
      status: "conflicting-outcome",
      reason: `This opportunity already ended as "${deal.outcome}".`,
    };
  }

  if (deal.stage === "won") {
    return {
      status: "already-won",
      opportunity_id: deal.id,
      contact_id: deal.contact_id,
    };
  }

  await dataProvider.update<Deal>("deals", {
    id: deal.id,
    data: {
      stage: "won",
      stage_entered_at: new Date().toISOString(),
      prospect_decision: "yes",
    },
    previousData: deal,
  });

  return {
    status: "won",
    opportunity_id: deal.id,
    contact_id: deal.contact_id,
  };
};
