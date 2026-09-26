import type { Deal, SalesCall } from "../types";

// Does this call still owe a decision?
//
// The Opportunity page used to ask a narrower question — "has attendance
// been recorded" — and treated the answer as the whole story:
//
//   const isPendingOutcome = salesCall.status === "booked" && !attendance;
//
// Becky Schmauch is what that misses. Her call reads Completed / Attended,
// so it is not pending by that test; but no decision was ever recorded,
// her Opportunity sits at Call Booked, and she has no Enrollment. The page
// showed "Sales Call · Completed / Attended" and no action at all, so the
// one person the convergence path was built for could not reach it.
//
// Two different questions, and both have to be asked:
//
//   did the call happen            sales_calls.attendance
//   what did we decide            deals.owner_decision / prospect_decision
//
// A decision is owed when the call was attended and the second question
// has no answer yet. It is NOT owed — and must not be offered — when:
//
//   the call was a no-show        a different answer to the same question,
//                                 with its own canonical path; reopening it
//                                 as "attended" would rewrite a recorded fact
//   a decision exists             nothing to record
//   the sale ended                outcome is set: declined, ghosted, lost,
//                                 workshops-only. Offering to decide again
//                                 invites overwriting somebody's recorded no
//   the sale was won              already the decision, already enrolled
export const salesCallDecisionOwed = (
  salesCall: Pick<SalesCall, "attendance"> | null | undefined,
  deal:
    | Pick<Deal, "owner_decision" | "prospect_decision" | "outcome" | "stage">
    | null
    | undefined,
): boolean => {
  if (!salesCall || !deal) return false;
  if (salesCall.attendance !== "attended") return false;
  if (deal.owner_decision != null) return false;
  if (deal.prospect_decision != null) return false;
  if (deal.outcome != null) return false;
  if (deal.stage === "won") return false;
  return true;
};
