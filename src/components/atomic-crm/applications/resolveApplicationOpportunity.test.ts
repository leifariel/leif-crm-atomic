import { describe, expect, it } from "vitest";

import { resolveApplicationOpportunity } from "./resolveApplicationOpportunity";
import type { Application, Deal } from "../types";

// Samantha Herold (97) and Celia (146), as production holds them.
const application = {
  contact_id: 51,
  offer_id: 2,
  opportunity_id: null,
} as unknown as Application;

const deal = (over: Partial<Deal> = {}): Deal =>
  ({
    id: 268,
    contact_id: 51,
    offer_id: 2,
    cohort_id: null,
    stage: "call_booked",
    outcome: null,
    amount: 1400,
    created_at: "2026-09-01T00:00:00.000Z",
    stage_entered_at: "2026-09-10T00:00:00.000Z",
    archived_at: null,
    ...over,
  }) as unknown as Deal;

describe("the Samantha and Celia shape", () => {
  it("finds the live conversation the cohort mismatch was hiding", () => {
    // The Deal carries cohort_id NULL while the Application expects cohort
    // 4. That is what adoptionConflict could not pair — and a Deal with no
    // round is not a Deal for a different round.
    const verdict = resolveApplicationOpportunity(application, [deal()]);
    expect(verdict.kind).toBe("one");
    expect(verdict.kind === "one" && verdict.candidate.id).toBe(268);
    expect(verdict.kind === "one" && verdict.candidate.cohortId).toBeNull();
  });
});

describe("what is not a match", () => {
  it("ignores a conversation for a different programme", () => {
    expect(
      resolveApplicationOpportunity(application, [deal({ offer_id: 1 })]).kind,
    ).toBe("none");
  });

  it("ignores a different person", () => {
    expect(
      resolveApplicationOpportunity(application, [deal({ contact_id: 99 })])
        .kind,
    ).toBe("none");
  });

  it("ignores a conversation that is over", () => {
    expect(
      resolveApplicationOpportunity(application, [
        deal({ stage: "lost", outcome: "lost" }),
      ]).kind,
    ).toBe("none");
    expect(
      resolveApplicationOpportunity(application, [
        deal({ archived_at: "2026-09-20T00:00:00.000Z" }),
      ]).kind,
    ).toBe("none");
  });

  it("offers nothing when the Application is already linked", () => {
    // Relinking something already correct is its own way to break a record.
    expect(
      resolveApplicationOpportunity(
        { ...application, opportunity_id: 268 } as unknown as Application,
        [deal()],
      ).kind,
    ).toBe("none");
  });
});

describe("ambiguity", () => {
  it("never picks between two live conversations", () => {
    const verdict = resolveApplicationOpportunity(application, [
      deal({ id: 268 }),
      deal({ id: 269, created_at: "2026-09-15T00:00:00.000Z" }),
    ]);
    expect(verdict.kind).toBe("many");
    // Oldest first, so the list is stable between renders.
    expect(
      verdict.kind === "many" && verdict.candidates.map((c) => c.id),
    ).toEqual([268, 269]);
  });

  it("is not confused by an inactive one sitting beside a live one", () => {
    const verdict = resolveApplicationOpportunity(application, [
      deal({ id: 268 }),
      deal({ id: 270, stage: "lost", outcome: "lost" }),
    ]);
    expect(verdict.kind).toBe("one");
    expect(verdict.kind === "one" && verdict.candidate.id).toBe(268);
  });
});
