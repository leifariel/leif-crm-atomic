import { describe, expect, it } from "vitest";

import { salesCallDecisionOwed } from "./salesCallDecisionOwed";

// Becky Schmauch's Opportunity showed "Sales Call · Completed / Attended"
// and no action, so the one person the convergence path was built for could
// not reach it. The page was asking whether attendance had been recorded;
// the question it needed to ask is whether a DECISION had been.

const attended = { attendance: "attended" as const };
const noShow = { attendance: "no_show" as const };
const unresolved = { attendance: null };

const undecided = {
  owner_decision: null,
  prospect_decision: null,
  outcome: null,
  stage: "call_booked",
};

describe("when a decision is still owed", () => {
  it("is owed on Becky's exact shape: attended, nothing decided", () => {
    expect(salesCallDecisionOwed(attended, undecided)).toBe(true);
  });

  it("is owed whatever active stage the Opportunity is parked at", () => {
    for (const stage of ["call_booked", "decision", "approved"]) {
      expect(salesCallDecisionOwed(attended, { ...undecided, stage })).toBe(
        true,
      );
    }
  });
});

describe("when it is not owed, and must not be offered", () => {
  it("is not owed before the call has been resolved at all", () => {
    // That is the original "Complete Sales Call" action's job, not this one.
    expect(salesCallDecisionOwed(unresolved, undecided)).toBe(false);
  });

  it("is not owed on a no-show", () => {
    // A no-show is a different answer to the same question and has its own
    // canonical path. Reopening it as attended would rewrite a recorded fact.
    expect(salesCallDecisionOwed(noShow, undecided)).toBe(false);
  });

  it("is not owed once an owner decision exists", () => {
    expect(
      salesCallDecisionOwed(attended, {
        ...undecided,
        owner_decision: "would_work_with",
      }),
    ).toBe(false);
  });

  it("is not owed once a prospect decision exists", () => {
    expect(
      salesCallDecisionOwed(attended, {
        ...undecided,
        prospect_decision: "thinking",
        stage: "decision",
      }),
    ).toBe(false);
  });

  it("is not owed once the sale has ended", () => {
    // Declined, ghosted, lost, workshops-only. Offering to decide again
    // invites overwriting somebody's recorded no.
    for (const outcome of ["lost", "not_fit", "workshops_only"] as const) {
      expect(salesCallDecisionOwed(attended, { ...undecided, outcome })).toBe(
        false,
      );
    }
  });

  it("is not owed once the sale is Won", () => {
    expect(
      salesCallDecisionOwed(attended, { ...undecided, stage: "won" }),
    ).toBe(false);
  });

  it("is not owed when there is no call or no Opportunity to ask about", () => {
    expect(salesCallDecisionOwed(null, undecided)).toBe(false);
    expect(salesCallDecisionOwed(attended, null)).toBe(false);
    expect(salesCallDecisionOwed(undefined, undefined)).toBe(false);
  });
});
