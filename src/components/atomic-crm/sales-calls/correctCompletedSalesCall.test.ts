import { describe, expect, it } from "vitest";

import { createDataProvider } from "../providers/fakerest/dataProvider";
import { createCrmDb, buildContact } from "@/test/StoryWrapper";
import type {
  Deal,
  Enrollment,
  Offer,
  SalesCall,
  SalesCallEvent,
  Task,
} from "../types";
import { correctCompletedSalesCall } from "./correctCompletedSalesCall";

// The FakeRest mirror of correct_completed_sales_call(), which is what the
// demo and these tests run against.
//
// The mirror's JOB is to be indistinguishable from the real function to its
// caller: same decision table, same refusals, same statuses. Atomicity and
// "refuse before mutating" are the real function's guarantees and are
// proven against real Postgres in e2e/correctingARecordedResult.spec.ts --
// never here, because FakeRest has no transactions and a test that claimed
// otherwise would be describing the mirror rather than the database.

const CONTACT_ID = 1;
const OFFER_ID = 1;
const DEAL_ID = 1;
const CALL_ID = 1;

const buildOffer = (): Offer => ({
  id: OFFER_ID,
  name: "The Living Example",
  type: "individual",
  duration: "6 months",
  current_price: 4000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const buildDeal = (overrides: Partial<Deal> = {}): Deal => ({
  pricing_mode: "standard",
  id: DEAL_ID,
  name: "Ada Lovelace",
  contact_id: CONTACT_ID,
  offer_id: OFFER_ID,
  stage: "decision",
  outcome: null,
  owner_decision: "would_work_with",
  prospect_decision: "thinking",
  follow_up_date: "2026-10-20",
  amount: 4000,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  sales_id: 0,
  index: 0,
  stage_entered_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const buildCall = (overrides: Partial<SalesCall> = {}): SalesCall => ({
  id: CALL_ID,
  opportunity_id: DEAL_ID,
  contact_id: CONTACT_ID,
  status: "completed",
  attendance: "attended",
  attendance_recorded_at: "2026-10-14T16:00:00.000Z",
  original_scheduled_at: "2026-10-14T15:00:00.000Z",
  scheduled_at: "2026-10-14T15:00:00.000Z",
  reschedule_count: 0,
  source: "manual",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const build = ({
  deal = {},
  call = {},
  extraCalls = [],
  extraDeals = [],
  enrollments = [],
  tasks = [],
}: {
  deal?: Partial<Deal>;
  call?: Partial<SalesCall>;
  extraCalls?: SalesCall[];
  extraDeals?: Deal[];
  enrollments?: Enrollment[];
  tasks?: Task[];
} = {}) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [buildContact({ id: CONTACT_ID })],
      offers: [buildOffer()],
      deals: [buildDeal(deal), ...extraDeals],
      sales_calls: [buildCall(call), ...extraCalls],
      enrollments,
      tasks,
    }),
    silent: true,
    latency: 0,
  });
  return dataProvider;
};

const theDeal = async (
  dataProvider: ReturnType<typeof build>,
  id: number = DEAL_ID,
) => (await dataProvider.getOne<Deal>("deals", { id })).data;

const theCall = async (
  dataProvider: ReturnType<typeof build>,
  id: number = CALL_ID,
) => (await dataProvider.getOne<SalesCall>("sales_calls", { id })).data;

const openFollowUps = async (dataProvider: ReturnType<typeof build>) => {
  const { data } = await dataProvider.getList<Task>("tasks", {
    filter: { type: "follow_up" },
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });
  return data.filter((task) => !task.done_date);
};

const corrections = async (dataProvider: ReturnType<typeof build>) => {
  const { data } = await dataProvider.getList<SalesCallEvent>(
    "sales_call_events",
    {
      filter: { kind: "outcome_corrected" },
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    },
  );
  return data;
};

describe("a recorded result is corrected in place", () => {
  it("a new Decision date edits the same episode and retargets one Task", async () => {
    const dataProvider = build({
      tasks: [
        {
          id: 1,
          contact_id: CONTACT_ID,
          opportunity_id: DEAL_ID,
          type: "follow_up",
          text: "Follow up with Ada Lovelace",
          due_date: "2026-10-20T12:00:00.000Z",
          done_date: null,
          status: "pending",
          sales_id: 0,
        },
      ],
    });

    const result = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      followUpDate: "2026-11-02",
    });

    expect(result.status).toBe("corrected");
    expect((await theDeal(dataProvider)).follow_up_date).toBe("2026-11-02");

    const open = await openFollowUps(dataProvider);
    expect(open).toHaveLength(1);
    expect(open[0].due_date).toContain("2026-11-02");

    // One call episode, still.
    const { total } = await dataProvider.getList<SalesCall>("sales_calls", {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    });
    expect(total).toBe(1);
  });

  it("the identical correction again is a no-change, and records nothing new", async () => {
    const dataProvider = build();

    await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      followUpDate: "2026-11-02",
    });
    const again = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      followUpDate: "2026-11-02",
    });

    expect(again.status).toBe("no-change");
    expect(await corrections(dataProvider)).toHaveLength(1);
    expect(await openFollowUps(dataProvider)).toHaveLength(1);
  });

  it("leaving Decision clears the date and closes the Task that was its premise", async () => {
    const dataProvider = build();

    const result = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      prospectDecision: "no",
    });
    expect(result.status).toBe("corrected");

    const deal = await theDeal(dataProvider);
    expect(deal.outcome).toBe("lost");
    expect(deal.follow_up_date).toBeNull();
    expect(await openFollowUps(dataProvider)).toHaveLength(0);
  });

  it("correcting to yes goes through the one place a sale is accepted", async () => {
    // Not a hand-written stage: "won". The real function clears the
    // outcome and calls accept_sale(); this calls acceptSaleMirror(), and
    // contracts/deals/wonIsWritableByItsOwnWriter.test.ts is what noticed
    // the first draft of this file writing Won by hand.
    const dataProvider = build();

    const result = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      prospectDecision: "yes",
    });
    expect(result.status).toBe("corrected");

    const deal = await theDeal(dataProvider);
    expect(deal.stage).toBe("won");
    expect(deal.prospect_decision).toBe("yes");
    expect(deal.outcome).toBeNull();
    expect(deal.follow_up_date).toBeNull();
    // The Decision follow-up Task was the premise of a decision that is
    // now made.
    expect(await openFollowUps(dataProvider)).toHaveLength(0);
  });
  it("correcting the owner's decision derives the prospect's away", async () => {
    const dataProvider = build();

    await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      ownerDecision: "workshops_only",
    });

    const deal = await theDeal(dataProvider);
    expect(deal.owner_decision).toBe("workshops_only");
    expect(deal.outcome).toBe("workshops_only");
    // Only Would Work With has a prospect decision.
    expect(deal.prospect_decision).toBeNull();
  });

  it("coming back to Decision needs the date the follow-up is owed", async () => {
    const dataProvider = build({
      deal: {
        stage: "call_booked",
        prospect_decision: "no",
        follow_up_date: null,
        outcome: "lost",
      },
    });

    const refused = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      prospectDecision: "thinking",
    });
    expect(refused.status).toBe("missing-decision-date");
    expect((await theDeal(dataProvider)).outcome).toBe("lost");

    const allowed = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      prospectDecision: "thinking",
      followUpDate: "2026-11-20",
    });
    expect(allowed.status).toBe("corrected");
    expect(await openFollowUps(dataProvider)).toHaveLength(1);
  });

  it("records what was there and what is there now", async () => {
    const dataProvider = build({ call: { impressions: "Warm." } });

    await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      prospectDecision: "no",
      impressions: "Warmer than her answer.",
      impressionsMode: "set",
    });

    const events = await corrections(dataProvider);
    expect(events).toHaveLength(1);
    expect(events[0].correction?.before).toMatchObject({
      prospect_decision: "thinking",
      follow_up_date: "2026-10-20",
      impressions: "Warm.",
    });
    expect(events[0].correction?.after).toMatchObject({
      prospect_decision: "no",
      follow_up_date: null,
      impressions: "Warmer than her answer.",
      outcome: "lost",
    });
  });
});

describe("impressions have three answers, not an overloaded blank", () => {
  it("replaces, clears, and leaves alone", async () => {
    const dataProvider = build({ call: { impressions: "First read." } });

    expect(
      (
        await correctCompletedSalesCall({
          dataProvider,
          salesCallId: CALL_ID,
          impressions: "Second read.",
          impressionsMode: "set",
        })
      ).status,
    ).toBe("corrected");
    expect((await theCall(dataProvider)).impressions).toBe("Second read.");

    expect(
      (
        await correctCompletedSalesCall({
          dataProvider,
          salesCallId: CALL_ID,
          impressionsMode: "unchanged",
        })
      ).status,
    ).toBe("no-change");
    expect((await theCall(dataProvider)).impressions).toBe("Second read.");

    expect(
      (
        await correctCompletedSalesCall({
          dataProvider,
          salesCallId: CALL_ID,
          impressionsMode: "clear",
        })
      ).status,
    ).toBe("corrected");
    expect((await theCall(dataProvider)).impressions).toBeNull();
  });

  it("whitespace is not an impression, and a contradiction is not a guess", async () => {
    const dataProvider = build({ call: { impressions: "Kept." } });

    expect(
      (
        await correctCompletedSalesCall({
          dataProvider,
          salesCallId: CALL_ID,
          impressions: " \n\t ",
          impressionsMode: "set",
        })
      ).status,
    ).toBe("validation-error");
    expect((await theCall(dataProvider)).impressions).toBe("Kept.");
  });
});

describe("episodes stay separate, and only the latest one owns the result", () => {
  it("an older episode may not rewrite current Opportunity truth", async () => {
    const dataProvider = build({
      call: {
        scheduled_at: "2026-09-01T15:00:00.000Z",
        original_scheduled_at: "2026-09-01T15:00:00.000Z",
        impressions: "September read.",
      },
      extraCalls: [
        buildCall({
          id: 2,
          scheduled_at: "2026-10-10T15:00:00.000Z",
          original_scheduled_at: "2026-10-10T15:00:00.000Z",
          impressions: "October read.",
        }),
      ],
    });

    const refused = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      prospectDecision: "no",
    });
    expect(refused.status).toBe("superseded-call-episode");
    expect((await theDeal(dataProvider)).prospect_decision).toBe("thinking");

    // What Leif made of that older conversation is still his to fix.
    const allowed = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      impressions: "September read, corrected.",
      impressionsMode: "set",
    });
    expect(allowed.status).toBe("corrected");
    expect((await theCall(dataProvider)).impressions).toBe(
      "September read, corrected.",
    );
    // And the newer episode is untouched by it.
    expect((await theCall(dataProvider, 2)).impressions).toBe("October read.");
  });

  it("correcting the later episode leaves the earlier one alone", async () => {
    const dataProvider = build({
      call: {
        scheduled_at: "2026-09-01T15:00:00.000Z",
        original_scheduled_at: "2026-09-01T15:00:00.000Z",
        impressions: "September read.",
      },
      extraCalls: [
        buildCall({
          id: 2,
          scheduled_at: "2026-10-10T15:00:00.000Z",
          original_scheduled_at: "2026-10-10T15:00:00.000Z",
        }),
      ],
    });

    expect(
      (
        await correctCompletedSalesCall({
          dataProvider,
          salesCallId: 2,
          prospectDecision: "no",
        })
      ).status,
    ).toBe("corrected");

    const older = await theCall(dataProvider, CALL_ID);
    expect(older.impressions).toBe("September read.");
    expect(older.attendance).toBe("attended");
  });
});

describe("what cannot be undone safely is refused", () => {
  it("a Won sale with an Enrollment, naming its blockers", async () => {
    const dataProvider = build({
      deal: { stage: "won", prospect_decision: "yes", follow_up_date: null },
      enrollments: [
        {
          id: 1,
          opportunity_id: DEAL_ID,
          status: "onboarding",
          onboarding_tracking: "tracked",
          created_at: "2026-10-14T16:00:00.000Z",
          updated_at: "2026-10-14T16:00:00.000Z",
        } as Enrollment,
      ],
    });

    const refused = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      prospectDecision: "no",
    });
    expect(refused.status).toBe("ambiguous-downstream-state");
    if (refused.status !== "ambiguous-downstream-state") return;
    expect(refused.category).toBe("won_opportunity");
    expect(refused.blockers).toContain("enrollment");
    expect(refused.blockers).toContain("won_sale");

    const deal = await theDeal(dataProvider);
    expect(deal.stage).toBe("won");
    expect(deal.outcome).toBeNull();
  });

  it("retracting a recorded attendance", async () => {
    const dataProvider = build();

    const refused = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      attendance: "no_show",
    });
    expect(refused.status).toBe("ambiguous-downstream-state");
    if (refused.status !== "ambiguous-downstream-state") return;
    expect(refused.category).toBe("attendance_retraction");
    expect((await theCall(dataProvider)).attendance).toBe("attended");
  });

  it("lifting a standing do-not-engage decision", async () => {
    const dataProvider = build({
      deal: {
        stage: "call_booked",
        owner_decision: "do_not_engage",
        prospect_decision: null,
        follow_up_date: null,
        outcome: "lost",
      },
    });

    const refused = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-11-30",
    });
    expect(refused.status).toBe("ambiguous-downstream-state");
    if (refused.status !== "ambiguous-downstream-state") return;
    expect(refused.category).toBe("contact_sales_eligibility");
  });

  it("an archived Opportunity, while still allowing its impressions", async () => {
    const dataProvider = build({
      deal: { archived_at: "2026-10-01T00:00:00.000Z" },
    });

    const refused = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      prospectDecision: "no",
    });
    expect(refused.status).toBe("ambiguous-downstream-state");
    if (refused.status !== "ambiguous-downstream-state") return;
    expect(refused.category).toBe("archived_opportunity");

    expect(
      (
        await correctCompletedSalesCall({
          dataProvider,
          salesCallId: CALL_ID,
          impressions: "Worth remembering.",
          impressionsMode: "set",
        })
      ).status,
    ).toBe("corrected");
  });

  it("a result a sales call never records", async () => {
    const dataProvider = build();

    const refused = await correctCompletedSalesCall({
      dataProvider,
      salesCallId: CALL_ID,
      prospectDecision: "ghosted" as never,
    });
    expect(refused.status).toBe("invalid-transition");
  });

  it("a call with no recorded result at all", async () => {
    const dataProvider = build({
      call: {
        status: "booked",
        attendance: null,
        attendance_recorded_at: null,
      },
    });

    expect(
      (
        await correctCompletedSalesCall({
          dataProvider,
          salesCallId: CALL_ID,
          prospectDecision: "no",
        })
      ).status,
    ).toBe("not-completed");
  });
});
