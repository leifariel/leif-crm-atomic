import { describe, expect, it } from "vitest";

import { createDataProvider } from "../providers/fakerest/dataProvider";
import { buildContact, createCrmDb } from "@/test/StoryWrapper";
import {
  foreignRequirementKeys,
  onboardingMatchesOffer,
  onboardingRepairState,
  proposePreviousOffer,
  reconcileClientOnboarding,
} from "./reconcileClientOnboarding";
import { assessOnboarding } from "./assessOnboarding";
import type {
  Deal,
  DealOfferEvent,
  Enrollment,
  EnrollmentOnboardingItem,
  Offer,
  OnboardingRequirementTemplate,
  Task,
} from "../types";

// Jenna Smith's ACTUAL production shape, which is not the one the transfer was
// built for.
//
// Her Opportunity already says The Living Example — it was edited three minutes
// after the sale, before any guard existed — and her onboarding is still Growing
// Yourself Up's, with every source_offer_id null because those rows predate the
// column. So transfer_enrolled_opportunity_offer(188, LE) correctly answers
// "already on that programme" and leaves her exactly as she was. This is the
// other authority: the programme stays, the projection moves.

const LE: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  is_active: true,
  acuity_appointment_type_id: "91345095",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const GYU: Offer = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 1400,
  is_active: true,
  acuity_appointment_type_id: "64654501",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

// A third programme that shares only the two requirements every programme has,
// so it can never account for Slack or the calendar invite.
const LEGACY: Offer = {
  id: 4,
  name: "1:1 Coaching (Legacy)",
  type: "individual",
  duration: "3 months",
  current_price: 3000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as unknown as Offer;

const templates: OnboardingRequirementTemplate[] = [
  ...[
    ["contract", "Contract signed", "Send contract to {name}", 1],
    [
      "notion_access",
      "Notion access",
      "Grant {name} Notion personal session-notes access",
      2,
    ],
    [
      "curriculum_access",
      "Living Example curriculum access",
      "Grant {name} Living Example curriculum access",
      3,
    ],
    [
      "meditation_library_access",
      "Meditation library access",
      "Grant {name} meditation library access",
      4,
    ],
  ].map(([key, label, task, sort], i) => ({
    id: 100 + i,
    offer_id: 1,
    key,
    label,
    task_text_template: task,
    is_required: true,
    sort_order: sort,
    is_active: true,
  })),
  ...[
    ["contract", "Contract signed", "Send contract to {name}", 1],
    ["slack_access", "Slack access", "Invite {name} to GYU Slack", 2],
    [
      "calendar_access",
      "Google Calendar access",
      "Grant {name} GYU calendar access",
      3,
    ],
    [
      "curriculum_access",
      "GYU curriculum access",
      "Grant {name} GYU curriculum access",
      4,
    ],
    [
      "meditation_library_access",
      "Meditation library access",
      "Grant {name} meditation library access",
      5,
    ],
  ].map(([key, label, task, sort], i) => ({
    id: 200 + i,
    offer_id: 2,
    key,
    label,
    task_text_template: task,
    is_required: true,
    sort_order: sort,
    is_active: true,
  })),
  ...[["contract", "Contract signed", "Send contract to {name}", 1]].map(
    ([key, label, task, sort], i) => ({
      id: 300 + i,
      offer_id: 4,
      key,
      label,
      task_text_template: task,
      is_required: true,
      sort_order: sort,
      is_active: true,
    }),
  ),
] as unknown as OnboardingRequirementTemplate[];

const templatesFor = (offerId: number) =>
  templates.filter((template) => Number(template.offer_id) === offerId);

// Her checklist as production holds it: GYU's five, contract done, and no
// provenance on any row.
const staleItems = (): EnrollmentOnboardingItem[] =>
  [
    ["contract", "Contract signed", "Send contract to {name}", "done", 1],
    [
      "slack_access",
      "Slack access",
      "Invite {name} to GYU Slack",
      "pending",
      2,
    ],
    [
      "calendar_access",
      "Google Calendar access",
      "Grant {name} GYU calendar access",
      "pending",
      3,
    ],
    [
      "curriculum_access",
      "GYU curriculum access",
      "Grant {name} GYU curriculum access",
      "pending",
      4,
    ],
    [
      "meditation_library_access",
      "Meditation library access",
      "Grant {name} meditation library access",
      "pending",
      5,
    ],
  ].map(([key, label, task, status, sort], i) => ({
    id: 184 + i,
    enrollment_id: 93,
    requirement_key: key,
    label,
    task_text_template: task,
    is_required: true,
    sort_order: sort,
    status,
    completed_at: status === "done" ? "2026-09-26T18:58:47.000Z" : null,
    source_offer_id: null,
    created_at: "2026-09-26T18:53:34.000Z",
    updated_at: "2026-09-26T18:53:34.000Z",
  })) as unknown as EnrollmentOnboardingItem[];

const tasksForItems = (items: EnrollmentOnboardingItem[]): Task[] =>
  items.map(
    (item, i) =>
      ({
        id: 278 + i,
        contact_id: 269,
        type: "onboarding_item",
        text: item.task_text_template.replace("{name}", "jenna smith"),
        status: item.status === "done" ? "completed" : "pending",
        done_date: item.status === "done" ? "2026-09-26T18:58:47.000Z" : null,
        due_date: "2026-09-29T18:53:34.000Z",
        enrollment_id: 93,
        onboarding_item_id: item.id,
        sales_id: 0,
      }) as unknown as Task,
  );

const buildJenna = ({
  enrollmentStatus = "onboarding",
  items = staleItems(),
  withEnrollment = true,
  tracking = "tracked",
}: {
  enrollmentStatus?: string;
  items?: EnrollmentOnboardingItem[];
  withEnrollment?: boolean;
  tracking?: string;
} = {}) =>
  createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 269, first_name: "jenna", last_name: "smith" }),
      ],
      offers: [LE, GYU, LEGACY],
      onboarding_requirement_templates: templates,
      deals: [
        {
          id: 188,
          contact_id: 269,
          // Already The Living Example. That is the whole point.
          offer_id: 1,
          cohort_id: null,
          name: "jenna smith",
          stage: "won",
          outcome: null,
          owner_decision: "would_work_with",
          prospect_decision: "yes",
          pricing_mode: "standard",
          offer_name_snapshot: "The Living Example",
          offer_price_snapshot: 4000,
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: "2026-08-17T18:48:10.000Z",
          updated_at: "2026-08-17T18:48:10.000Z",
          stage_entered_at: "2026-09-26T18:53:34.000Z",
        } as unknown as Deal,
      ],
      enrollments: withEnrollment
        ? [
            {
              id: 93,
              opportunity_id: 188,
              status: enrollmentStatus,
              onboarding_tracking: tracking,
              created_at: "2026-09-26T18:53:34.000Z",
              updated_at: "2026-09-26T18:53:34.000Z",
            } as unknown as Enrollment,
          ]
        : [],
      enrollment_onboarding_items: withEnrollment ? items : [],
      tasks: withEnrollment ? tasksForItems(items) : [],
    } as never),
    silent: true,
    latency: 0,
  });

const itemsOf = async (dp: ReturnType<typeof createDataProvider>) => {
  const { data } = await dp.getList<EnrollmentOnboardingItem>(
    "enrollment_onboarding_items",
    {
      filter: { enrollment_id: 93 },
      pagination: { page: 1, perPage: 50 },
      sort: { field: "sort_order", order: "ASC" },
    },
  );
  return data;
};

const tasksOf = async (dp: ReturnType<typeof createDataProvider>) => {
  const { data } = await dp.getList<Task>("tasks", {
    filter: { enrollment_id: 93 },
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });
  return data;
};

const eventsOf = async (dp: ReturnType<typeof createDataProvider>) => {
  const { data } = await dp.getList<DealOfferEvent>("deal_offer_events", {
    filter: { opportunity_id: 188 },
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });
  return data;
};

describe("noticing that a checklist is not its programme's", () => {
  it("says a GYU checklist under an LE Opportunity does not match", () => {
    expect(onboardingMatchesOffer(staleItems(), templatesFor(1))).toBe(false);
  });

  it("says a checklist that is its own programme's matches", () => {
    const aligned = templatesFor(1).map((template, i) => ({
      ...staleItems()[0],
      id: 900 + i,
      requirement_key: template.key,
      label: template.label,
      status: "pending",
      completed_at: null,
    })) as unknown as EnrollmentOnboardingItem[];
    expect(onboardingMatchesOffer(aligned, templatesFor(1))).toBe(true);
  });

  it("ignores retired rows, which are history rather than outstanding work", () => {
    const withRetired = [
      ...templatesFor(1).map((template, i) => ({
        ...staleItems()[0],
        id: 900 + i,
        requirement_key: template.key,
        status: "pending",
        completed_at: null,
      })),
      {
        ...staleItems()[1],
        id: 950,
        requirement_key: "slack_access",
        status: "retired",
        retired_at: "2026-09-27T00:00:00.000Z",
      },
    ] as unknown as EnrollmentOnboardingItem[];
    expect(onboardingMatchesOffer(withRetired, templatesFor(1))).toBe(true);
  });

  it("names the requirements that belong to some other programme", () => {
    expect(foreignRequirementKeys(staleItems(), templatesFor(1))).toEqual([
      "calendar_access",
      "slack_access",
    ]);
  });
});

describe("which programme the stale setup came from", () => {
  const candidates = [
    { offerId: 2, keys: templatesFor(2).map((t) => t.key) },
    { offerId: 4, keys: templatesFor(4).map((t) => t.key) },
  ];

  it("proposes the one programme whose setup accounts for it", () => {
    expect(
      proposePreviousOffer(["calendar_access", "slack_access"], candidates),
    ).toBe(2);
  });

  it("proposes nothing when two programmes could both account for it", () => {
    expect(
      proposePreviousOffer(
        ["contract"],
        [
          { offerId: 2, keys: ["contract"] },
          { offerId: 4, keys: ["contract"] },
        ],
      ),
    ).toBeNull();
  });

  it("proposes nothing when there is nothing foreign to explain", () => {
    expect(proposePreviousOffer([], candidates)).toBeNull();
  });
});

describe("repairing the setup to the programme already on the Opportunity", () => {
  it("leaves her at 1 of 4, with the contract still signed", async () => {
    const dp = buildJenna();
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });
    expect(result.status).toBe("reconciled");

    const items = await itemsOf(dp);
    const assessment = assessOnboarding({ tracking: "tracked", items });
    if (assessment.mode !== "tracked")
      throw new Error("expected a tracked checklist");
    // 1 of 4: the signed contract done, Notion / curriculum / meditation
    // outstanding, and the two GYU requirements no longer counted at all.
    expect(assessment.requiredDoneCount).toBe(1);
    expect(assessment.requiredItems).toHaveLength(4);
    expect(assessment.outstandingRequired).toHaveLength(3);

    const contract = items.find((i) => i.requirement_key === "contract");
    expect(contract?.status).toBe("done");
    expect(contract?.completed_at).toBe("2026-09-26T18:58:47.000Z");
    // Unknown provenance stays unknown: "contract" is contract in both
    // programmes, so nothing here knows which one this row came from.
    expect(contract?.source_offer_id ?? null).toBeNull();
  });

  it("retires the two GYU-only requirements and cancels their tasks", async () => {
    const dp = buildJenna();
    await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });

    const items = await itemsOf(dp);
    for (const key of ["slack_access", "calendar_access"]) {
      const item = items.find((i) => i.requirement_key === key);
      expect(item?.status).toBe("retired");
      expect(item?.retired_from_offer_id).toBe(2);
    }

    const tasks = await tasksOf(dp);
    const closed = tasks.filter(
      (task) =>
        task.text.includes("GYU Slack") || task.text.includes("GYU calendar"),
    );
    expect(closed).toHaveLength(2);
    for (const task of closed) {
      expect(task.status).toBe("cancelled");
      expect(task.done_date).not.toBeNull();
    }
    // Cancelled, never completed: nobody did this work.
    expect(tasks.filter((t) => t.status === "completed")).toHaveLength(1);
  });

  it("re-points the shared curriculum requirement instead of duplicating it", async () => {
    const dp = buildJenna();
    await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });

    const items = await itemsOf(dp);
    const curriculum = items.filter(
      (i) => i.requirement_key === "curriculum_access",
    );
    expect(curriculum).toHaveLength(1);
    expect(curriculum[0].label).toBe("Living Example curriculum access");
    expect(curriculum[0].status).toBe("pending");
    expect(curriculum[0].source_offer_id).toBe(1);

    const tasks = await tasksOf(dp);
    expect(
      tasks.filter(
        (t) =>
          t.status === "pending" &&
          t.text.includes("Living Example curriculum access"),
      ),
    ).toHaveLength(1);
  });

  it("adds Notion access once, with a task", async () => {
    const dp = buildJenna();
    await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });

    const items = await itemsOf(dp);
    const notion = items.filter((i) => i.requirement_key === "notion_access");
    expect(notion).toHaveLength(1);
    expect(notion[0].status).toBe("pending");
    expect(notion[0].source_offer_id).toBe(1);

    const tasks = await tasksOf(dp);
    expect(
      tasks.filter((t) => t.text.includes("Notion") && t.status === "pending"),
    ).toHaveLength(1);
  });

  it("records one reconstructed event that does not invent a date", async () => {
    const dp = buildJenna();
    await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });

    const events = await eventsOf(dp);
    expect(events).toHaveLength(1);
    expect(events[0].from_offer_id).toBe(2);
    expect(events[0].to_offer_id).toBe(1);
    expect(events[0].source).toBe("reconstructed");
    expect(events[0].occurred_at).toBeNull();
    expect(events[0].recorded_at).not.toBeNull();
    expect(events[0].note).toMatch(/before/i);
  });

  it("does not touch the programme on the Opportunity", async () => {
    const dp = buildJenna();
    await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });
    const { data: deal } = await dp.getOne<Deal>("deals", { id: 188 });
    expect(deal.offer_id).toBe(1);
    expect(deal.offer_name_snapshot).toBe("The Living Example");
  });

  it("is a no-op the second time, with no second event", async () => {
    const dp = buildJenna();
    await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });
    const afterFirst = await itemsOf(dp);

    const replay = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });
    expect(replay.status).toBe("already-aligned");

    expect(await itemsOf(dp)).toHaveLength(afterFirst.length);
    expect(await eventsOf(dp)).toHaveLength(1);
    const tasks = await tasksOf(dp);
    const pendingPerItem = new Map<string, number>();
    for (const task of tasks.filter((t) => t.status === "pending")) {
      const key = String(task.onboarding_item_id);
      pendingPerItem.set(key, (pendingPerItem.get(key) ?? 0) + 1);
    }
    expect([...pendingPerItem.values()].every((n) => n === 1)).toBe(true);
  });
});

describe("what it refuses", () => {
  it("will not guess which programme the setup came from", async () => {
    const dp = buildJenna();
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: null,
    });
    expect(result.status).toBe("needs-source-offer");
    if (result.status === "needs-source-offer") {
      expect(result.foreignKeys).toEqual(["calendar_access", "slack_access"]);
    }
    expect(await eventsOf(dp)).toHaveLength(0);
  });

  it("will not accept a programme the requirements contradict", async () => {
    const dp = buildJenna();
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 4,
    });
    expect(result.status).toBe("source-offer-mismatch");
    if (result.status === "source-offer-mismatch") {
      expect(result.unmatchedKeys).toEqual(["calendar_access", "slack_access"]);
    }
    // Refusing writes nothing at all.
    const items = await itemsOf(dp);
    expect(
      items.find((i) => i.requirement_key === "slack_access")?.status,
    ).toBe("pending");
    expect(await eventsOf(dp)).toHaveLength(0);
  });

  it("will not treat the current programme as its own source", async () => {
    const dp = buildJenna();
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 1,
    });
    expect(result.status).toBe("same-offer");
  });

  it("will not reopen a finished client's record", async () => {
    const dp = buildJenna({ enrollmentStatus: "completed" });
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });
    expect(result.status).toBe("terminal-enrollment");
    const items = await itemsOf(dp);
    expect(
      items.find((i) => i.requirement_key === "slack_access")?.status,
    ).toBe("pending");
  });

  it("says so when there is no client yet", async () => {
    const dp = buildJenna({ withEnrollment: false });
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });
    expect(result.status).toBe("no-enrollment");
  });

  it("says so when the Opportunity does not exist", async () => {
    const dp = buildJenna();
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 999999,
      fromOfferId: 2,
    });
    expect(result.status).toBe("not-found");
  });

  it("refuses a source programme that does not exist", async () => {
    const dp = buildJenna();
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 999999,
    });
    expect(result.status).toBe("invalid-offer");
  });
});

describe("a template that merely gained a requirement", () => {
  // Nothing foreign is present, so there is no programme change — and calling
  // it one would write history that never happened.
  const grownTemplate = (): EnrollmentOnboardingItem[] =>
    staleItems()
      .filter((item) =>
        ["contract", "curriculum_access", "meditation_library_access"].includes(
          item.requirement_key,
        ),
      )
      .map((item) => ({
        ...item,
        label:
          item.requirement_key === "curriculum_access"
            ? "Living Example curriculum access"
            : item.label,
      }));

  it("fills the gap without claiming a transfer", async () => {
    const dp = buildJenna({ items: grownTemplate() });
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: null,
    });
    expect(result.status).toBe("reconciled");
    if (result.status === "reconciled") {
      expect(result.eventRecorded).toBe(false);
      expect(result.added).toBe(1);
      expect(result.retired).toBe(0);
    }
    expect(await eventsOf(dp)).toHaveLength(0);
  });

  it("refuses a source programme, because none was involved", async () => {
    const dp = buildJenna({ items: grownTemplate() });
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });
    expect(result.status).toBe("source-offer-not-applicable");
  });
});

describe("onboarding that was never tracked here", () => {
  // Twenty real clients: working with Leif before the CRM modelled onboarding,
  // so no checklist, deliberately. "Does this match the template?" and "should
  // this be repaired?" are different questions, and only the second one is
  // about them.
  it("keeps the match predicate about the checklist, and answers eligibility separately", () => {
    // Strictly about equivalence: an empty checklist does NOT match a
    // four-requirement template, and saying otherwise would leave every future
    // caller reading "untracked" as "aligned".
    expect(onboardingMatchesOffer([], templatesFor(1))).toBe(false);

    // Eligibility is its own answer, and it is not "aligned".
    expect(
      onboardingRepairState({
        tracking: "legacy_untracked",
        items: [],
        templates: templatesFor(1),
      }),
    ).toBe("not-tracked");
    expect(
      onboardingRepairState({
        tracking: "tracked",
        items: staleItems(),
        templates: templatesFor(1),
      }),
    ).toBe("stale");
    expect(
      onboardingRepairState({
        tracking: "tracked",
        items: [],
        templates: templatesFor(1),
      }),
    ).toBe("stale");
  });

  it("treats an unknown tracking value as not repairable", () => {
    // A write authority refuses what it cannot be sure of; assessOnboarding's
    // opposite default is right for SHOWING a missing checklist.
    expect(
      onboardingRepairState({
        tracking: null,
        items: staleItems(),
        templates: templatesFor(1),
      }),
    ).toBe("not-tracked");
  });

  it("refuses to reconcile one, and writes nothing", async () => {
    const dp = buildJenna({ tracking: "legacy_untracked", items: [] });
    const before = await itemsOf(dp);
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });
    expect(result.status).toBe("onboarding-not-tracked");

    expect(await itemsOf(dp)).toHaveLength(before.length);
    expect(await eventsOf(dp)).toHaveLength(0);
    const { data: deal } = await dp.getOne<Deal>("deals", { id: 188 });
    expect(deal.offer_id).toBe(1);
  });

  it("refuses one with a partial historical checklist too", async () => {
    const dp = buildJenna({
      tracking: "legacy_untracked",
      items: staleItems().filter((item) => item.requirement_key === "contract"),
    });
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });
    expect(result.status).toBe("onboarding-not-tracked");
    expect(await itemsOf(dp)).toHaveLength(1);
    expect(await eventsOf(dp)).toHaveLength(0);
  });

  it("stays a refusal when asked twice, still with no writes", async () => {
    const dp = buildJenna({ tracking: "legacy_untracked", items: [] });
    await reconcileClientOnboarding(dp, { opportunityId: 188, fromOfferId: 2 });
    const second = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: null,
    });
    expect(second.status).toBe("onboarding-not-tracked");
    expect(await itemsOf(dp)).toHaveLength(0);
    expect(await eventsOf(dp)).toHaveLength(0);
    expect(await tasksOf(dp)).toHaveLength(0);
  });

  it("still repairs a tracked client, unchanged", async () => {
    const dp = buildJenna();
    const result = await reconcileClientOnboarding(dp, {
      opportunityId: 188,
      fromOfferId: 2,
    });
    expect(result.status).toBe("reconciled");
  });
});
