import { describe, expect, it } from "vitest";

import { createDataProvider } from "../providers/fakerest/dataProvider";
import { buildContact, createCrmDb } from "@/test/StoryWrapper";
import type { Deal, Offer } from "../types";
import {
  CALL_RESULT_OWNS_STAGE_MESSAGE,
  contradictsCallResult,
  describeStageEditRefusal,
  stageEditContradictsCallResult,
} from "./stageEditRefusal";
import { isPipelineTruncated } from "./pipelineQuery";

// A raw stage edit may not leave "they said yes" on a sale that is not Won.
// The database half is guard_deal_stage_against_call_result(), proven in
// e2e/pipelineStaysTrue.spec.ts; this is the rule and its FakeRest mirror.

const porsche = {
  stage: "decision",
  prospect_decision: "yes",
  outcome: null,
  archived_at: null,
};

describe("the rule", () => {
  it("yes on an open, non-Won sale is the contradiction", () => {
    expect(contradictsCallResult(porsche)).toBe(true);
    expect(contradictsCallResult({ ...porsche, stage: "won" })).toBe(false);
    expect(contradictsCallResult({ ...porsche, outcome: "lost" })).toBe(false);
    expect(
      contradictsCallResult({ ...porsche, archived_at: "2026-10-01" }),
    ).toBe(false);
    expect(
      contradictsCallResult({ ...porsche, prospect_decision: "thinking" }),
    ).toBe(false);
  });

  it("refuses won -> decision on a yes (what happened to Porsche)", () => {
    expect(
      stageEditContradictsCallResult(
        { ...porsche, stage: "won" },
        { ...porsche, stage: "decision" },
      ),
    ).toBe(true);
  });

  it("refuses moving the stage while already in the contradiction", () => {
    expect(
      stageEditContradictsCallResult(porsche, {
        ...porsche,
        stage: "call_booked",
      }),
    ).toBe(true);
  });

  it("lets a contradictory row save unrelated fields with its stage unchanged", () => {
    expect(stageEditContradictsCallResult(porsche, porsche)).toBe(false);
  });

  it("lets the correction take it out of the contradiction", () => {
    expect(
      stageEditContradictsCallResult(porsche, {
        ...porsche,
        prospect_decision: "thinking",
      }),
    ).toBe(false);
  });

  it("leaves every legitimate stage edit alone", () => {
    const open = {
      stage: "approved",
      prospect_decision: null,
      outcome: null,
      archived_at: null,
    };
    for (const stage of ["interested", "call_booked", "decision"]) {
      expect(stageEditContradictsCallResult(open, { ...open, stage })).toBe(
        false,
      );
    }
  });
});

describe("what Leif is told", () => {
  it("names Edit call result for the call-result refusal", () => {
    const refusal = describeStageEditRefusal(
      new Error(
        'call_result_owns_stage: Opportunity 217 records that the prospect said yes, so it cannot be at stage "decision".',
      ),
    );
    expect(refusal.callResult).toBe(true);
    expect(refusal.message).toBe(CALL_RESULT_OWNS_STAGE_MESSAGE);
    expect(refusal.message).toContain("Edit call result");
  });

  it("never reports any other failure as success", () => {
    const refusal = describeStageEditRefusal({ message: "network down" });
    expect(refusal.callResult).toBe(false);
    expect(refusal.message).toBe("The change was not saved: network down");
  });
});

describe("the board never quietly shows fewer people than exist", () => {
  it("reports truncation only when the server holds more than was loaded", () => {
    expect(isPipelineTruncated(100, 105)).toBe(true);
    expect(isPipelineTruncated(105, 105)).toBe(false);
    expect(isPipelineTruncated(0, undefined)).toBe(false);
  });
});

describe("the FakeRest mirror refuses the same write", () => {
  const STAMP = "2026-10-29T17:37:31.000Z";
  const offer: Offer = {
    id: 1,
    name: "The Living Example",
    type: "individual",
    duration: "6 months",
    current_price: 4000,
    is_active: true,
    created_at: STAMP,
    updated_at: STAMP,
  };
  const deal = (overrides: Partial<Deal>): Deal => ({
    id: 217,
    name: "Porsche-shaped",
    contact_id: 8,
    offer_id: 1,
    cohort_id: null,
    stage: "decision",
    outcome: null,
    owner_decision: "would_work_with",
    prospect_decision: "yes",
    amount: 4000,
    created_at: STAMP,
    updated_at: STAMP,
    sales_id: 0,
    index: 0,
    stage_entered_at: STAMP,
    ...overrides,
  });
  const provider = (row: Deal) =>
    createDataProvider({
      db: createCrmDb({
        contacts: [buildContact({ id: 8 })],
        offers: [offer],
        offer_payment_options: [],
        cohorts: [],
        deals: [row],
        enrollments: [],
        tasks: [],
      }),
      silent: true,
      latency: 0,
    });

  it("a drag of a decision+yes card is refused and the row is unchanged", async () => {
    const row = deal({});
    const dataProvider = provider(row);
    await expect(
      dataProvider.update("deals", {
        id: row.id,
        data: { stage: "call_booked" },
        previousData: row,
      }),
    ).rejects.toThrow(/call_result_owns_stage/);
    const { data } = await dataProvider.getOne<Deal>("deals", { id: 217 });
    expect(data.stage).toBe("decision");
  });

  it("an unrelated field on that same row still saves", async () => {
    const row = deal({});
    const dataProvider = provider(row);
    await dataProvider.update("deals", {
      id: row.id,
      data: { description: "still editable" },
      previousData: row,
    });
    const { data } = await dataProvider.getOne<Deal>("deals", { id: 217 });
    expect(data.description).toBe("still editable");
  });

  it("an ordinary drag still moves", async () => {
    const row = deal({ stage: "approved", prospect_decision: null });
    const dataProvider = provider(row);
    await dataProvider.update("deals", {
      id: row.id,
      data: { stage: "call_booked" },
      previousData: row,
    });
    const { data } = await dataProvider.getOne<Deal>("deals", { id: 217 });
    expect(data.stage).toBe("call_booked");
  });
});
