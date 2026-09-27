import { describe, expect, it } from "vitest";

import { createDataProvider } from "../providers/fakerest/dataProvider";
import { buildContact, createCrmDb } from "@/test/StoryWrapper";
import { describePlan, transferClientOffer } from "./transferClientOffer";

import { assessOnboarding } from "./assessOnboarding";
import type {
  Deal,
  Enrollment,
  EnrollmentOnboardingItem,
  Offer,
  OnboardingRequirementTemplate,
  Task,
} from "../types";

// Jenna Smith's exact shape, and what moving her programme has to do.
//
// She booked a Growing Yourself Up call and bought The Living Example. Her
// Opportunity was edited to LE three minutes after the sale; her onboarding
// stayed GYU — Slack, a Google Calendar invite, a GYU curriculum item, and four
// pending Tasks — because nothing reconciled the half that follows the sale.
//
// The keys are the identity, never the labels: curriculum_access exists in both
// programmes and means a different resource in each.

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

// The real production templates, verbatim.
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
] as unknown as OnboardingRequirementTemplate[];

const gyuItems = (): EnrollmentOnboardingItem[] =>
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
    source_offer_id: 2,
    created_at: "2026-09-26T18:53:34.000Z",
    updated_at: "2026-09-26T18:53:34.000Z",
  })) as unknown as EnrollmentOnboardingItem[];

const jennaTasks = (): Task[] =>
  gyuItems().map(
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

const buildJenna = () =>
  createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 269, first_name: "jenna", last_name: "smith" }),
      ],
      offers: [LE, GYU],
      onboarding_requirement_templates: templates,
      deals: [
        {
          id: 188,
          contact_id: 269,
          offer_id: 2,
          cohort_id: null,
          name: "jenna smith",
          stage: "won",
          outcome: null,
          owner_decision: "would_work_with",
          prospect_decision: "yes",
          pricing_mode: "standard",
          offer_name_snapshot: "Growing Yourself Up",
          offer_price_snapshot: 1400,
          amount: 1400,
          index: 0,
          sales_id: 0,
          created_at: "2026-08-17T18:48:10.000Z",
          updated_at: "2026-08-17T18:48:10.000Z",
          stage_entered_at: "2026-09-26T18:53:34.000Z",
        } as unknown as Deal,
      ],
      enrollments: [
        {
          id: 93,
          opportunity_id: 188,
          status: "onboarding",
          onboarding_tracking: "tracked",
          created_at: "2026-09-26T18:53:34.000Z",
          updated_at: "2026-09-26T18:53:34.000Z",
        } as unknown as Enrollment,
      ],
      enrollment_onboarding_items: gyuItems(),
      tasks: jennaTasks(),
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

const byKey = (items: EnrollmentOnboardingItem[], key: string) =>
  items.find((i) => i.requirement_key === key)!;

describe("moving Jenna from Growing Yourself Up to The Living Example", () => {
  it("moves the Opportunity and reconciles the checklist in one pass", async () => {
    const dp = buildJenna();

    const result = await transferClientOffer(dp, {
      opportunityId: 188,
      toOfferId: 1,
    });
    expect(result.status).toBe("transferred");

    const { data: deal } = await dp.getOne<Deal>("deals", { id: 188 });
    expect(String(deal.offer_id)).toBe("1");
    expect(deal.offer_name_snapshot).toBe("The Living Example");

    const items = await itemsOf(dp);
    // Exactly the four Living Example requirements are live, one of them done.
    const live = items.filter((i) => i.status !== "retired");
    expect(live.map((i) => i.requirement_key).sort()).toEqual([
      "contract",
      "curriculum_access",
      "meditation_library_access",
      "notion_access",
    ]);
    const assessment = assessOnboarding({ tracking: "tracked", items });
    expect(assessment.mode).toBe("tracked");
    if (assessment.mode === "tracked") {
      expect(assessment.requiredItems).toHaveLength(4);
      expect(assessment.requiredDoneCount).toBe(1);
      expect(assessment.allRequiredComplete).toBe(false);
    }
  });

  it("keeps the contract exactly as it was signed", async () => {
    const dp = buildJenna();
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });

    const contract = byKey(await itemsOf(dp), "contract");
    expect(contract.status).toBe("done");
    expect(contract.completed_at).toBe("2026-09-26T18:58:47.000Z");
    // And its Task is not recreated.
    const contractTasks = (await tasksOf(dp)).filter(
      (t) => t.onboarding_item_id === contract.id,
    );
    expect(contractTasks).toHaveLength(1);
    expect(contractTasks[0].status).toBe("completed");
  });

  it("retires the GYU-only requirements and cancels their Tasks", async () => {
    const dp = buildJenna();
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });

    const items = await itemsOf(dp);
    for (const key of ["slack_access", "calendar_access"]) {
      const item = byKey(items, key);
      expect(item.status, key).toBe("retired");
      expect(item.retired_at, key).not.toBeNull();
      expect(String(item.retired_from_offer_id), key).toBe("2");
      // Nothing is deleted: the row is still there to read.
      expect(item.label, key).toBeTruthy();
    }

    const tasks = await tasksOf(dp);
    const retiredIds = ["slack_access", "calendar_access"].map(
      (key) => byKey(items, key).id,
    );
    const theirTasks = tasks.filter((t) =>
      retiredIds.some((id) => String(id) === String(t.onboarding_item_id)),
    );
    expect(theirTasks).toHaveLength(2);
    for (const task of theirTasks) {
      expect(task.status).toBe("cancelled");
      // done_date is when a Task closed, and a cancellation is a closing —
      // tasks_completion_agreement_check refuses one without it.
      expect(task.done_date).not.toBeNull();
    }
  });

  it("re-points the shared curriculum requirement rather than duplicating it", async () => {
    const dp = buildJenna();
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });

    const items = await itemsOf(dp);
    const curriculum = items.filter(
      (i) => i.requirement_key === "curriculum_access",
    );
    // One row, not a retired GYU one plus a new LE one.
    expect(curriculum).toHaveLength(1);
    expect(curriculum[0].status).toBe("pending");
    expect(curriculum[0].label).toBe("Living Example curriculum access");
    expect(String(curriculum[0].source_offer_id)).toBe("1");

    const task = (await tasksOf(dp)).find(
      (t) => String(t.onboarding_item_id) === String(curriculum[0].id),
    )!;
    expect(task.status).toBe("pending");
    expect(task.text).toBe(
      "Grant jenna smith Living Example curriculum access",
    );
    expect(task.text).not.toMatch(/GYU/);
  });

  it("preserves the shared meditation requirement without assuming she has it", async () => {
    const dp = buildJenna();
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });

    const meditation = (await itemsOf(dp)).filter(
      (i) => i.requirement_key === "meditation_library_access",
    );
    expect(meditation).toHaveLength(1);
    expect(meditation[0].status).toBe("pending");
  });

  it("adds Notion access with exactly one Task", async () => {
    const dp = buildJenna();
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });

    const notion = (await itemsOf(dp)).filter(
      (i) => i.requirement_key === "notion_access",
    );
    expect(notion).toHaveLength(1);
    expect(notion[0].status).toBe("pending");

    const tasks = (await tasksOf(dp)).filter(
      (t) => String(t.onboarding_item_id) === String(notion[0].id),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].text).toBe(
      "Grant jenna smith Notion personal session-notes access",
    );
  });

  it("writes exactly one transfer event, and the history it names", async () => {
    const dp = buildJenna();
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });

    const { data: events } = await dp.getList("deal_offer_events", {
      filter: { opportunity_id: 188 },
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(events).toHaveLength(1);
    expect(String(events[0].from_offer_id)).toBe("2");
    expect(String(events[0].to_offer_id)).toBe("1");
    expect(String(events[0].enrollment_id)).toBe("93");
  });

  it("converges: a second move changes nothing", async () => {
    const dp = buildJenna();
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });
    const firstItems = await itemsOf(dp);
    const firstTasks = await tasksOf(dp);

    const replay = await transferClientOffer(dp, {
      opportunityId: 188,
      toOfferId: 1,
    });
    expect(replay.status).toBe("already-on-offer");

    expect(await itemsOf(dp)).toEqual(firstItems);
    expect(await tasksOf(dp)).toEqual(firstTasks);
    const { data: events } = await dp.getList("deal_offer_events", {
      filter: { opportunity_id: 188 },
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(events).toHaveLength(1);
  });

  it("keeps exactly one Enrollment", async () => {
    const dp = buildJenna();
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });
    const { data } = await dp.getList<Enrollment>("enrollments", {
      filter: { opportunity_id: 188 },
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(data).toHaveLength(1);
    expect(String(data[0].id)).toBe("93");
  });
});

describe("what the transfer refuses", () => {
  it("refuses to move a client into a group programme without a round", async () => {
    const dp = buildJenna();
    // LE -> GYU: a group programme needs somebody to choose the round.
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });
    const result = await transferClientOffer(dp, {
      opportunityId: 188,
      toOfferId: 2,
    });
    expect(result.status).toBe("needs-cohort");
  });

  it("says no-enrollment rather than guessing, when there is no client", async () => {
    const dp = createDataProvider({
      db: createCrmDb({
        contacts: [buildContact({ id: 1 })],
        offers: [LE, GYU],
        onboarding_requirement_templates: templates,
        deals: [
          {
            id: 5,
            contact_id: 1,
            offer_id: 2,
            name: "Not sold yet",
            stage: "call_booked",
            amount: 1400,
            index: 0,
            sales_id: 0,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            stage_entered_at: "2026-01-01T00:00:00.000Z",
          } as unknown as Deal,
        ],
      } as never),
      silent: true,
      latency: 0,
    });

    const result = await transferClientOffer(dp, {
      opportunityId: 5,
      toOfferId: 1,
    });
    expect(result.status).toBe("no-enrollment");
  });

  it("says not-found for an Opportunity that does not exist", async () => {
    const dp = buildJenna();
    const result = await transferClientOffer(dp, {
      opportunityId: 9999,
      toOfferId: 1,
    });
    expect(result.status).toBe("not-found");
  });
});

describe("the preview says what the transfer will do", () => {
  it("matches the plan the transfer then carries out", () => {
    const plan = describePlan(
      gyuItems(),
      templates.filter((t) => String(t.offer_id) === "1"),
    );
    expect(plan.keptDone).toEqual(["Contract signed"]);
    expect(plan.relabelled).toEqual([
      "Living Example curriculum access",
      "Meditation library access",
    ]);
    expect(plan.retired).toEqual(["Slack access", "Google Calendar access"]);
    expect(plan.added).toEqual(["Notion access"]);
  });
});

describe("a retired requirement is history, not work", () => {
  it("counts toward neither progress nor a missing checklist", () => {
    const items = gyuItems().map((item) =>
      item.requirement_key === "slack_access"
        ? ({
            ...item,
            status: "retired",
            retired_at: "2026-09-27T00:00:00.000Z",
          } as EnrollmentOnboardingItem)
        : item,
    );
    const assessment = assessOnboarding({ tracking: "tracked", items });
    expect(assessment.mode).toBe("tracked");
    if (assessment.mode === "tracked") {
      expect(assessment.requiredItems).toHaveLength(4);
      expect(
        assessment.requiredItems.map((i) => i.requirement_key),
      ).not.toContain("slack_access");
      expect(
        assessment.outstandingRequired.map((i) => i.requirement_key),
      ).not.toContain("slack_access");
      expect(assessment.isMissingChecklist).toBe(false);
    }
  });
});

// Provenance: said only where it is known.
//
// source_offer_id records which template a requirement came from. Every row
// that predates programme transfers has it null on purpose — inferring it from
// the Opportunity's current offer is precisely the mistake that produced
// Jenna's state — but an explicit transfer DOES know some of it for certain,
// and saying nothing there would be its own kind of dishonesty.
describe("what the transfer knows about where a requirement came from", () => {
  // Her production rows have no provenance at all: they were seeded before the
  // column existed.
  const withoutProvenance = () =>
    gyuItems().map(
      (item) =>
        ({ ...item, source_offer_id: null }) as EnrollmentOnboardingItem,
    );

  const transferred = async () => {
    const dp = createDataProvider({
      db: createCrmDb({
        contacts: [
          buildContact({ id: 269, first_name: "jenna", last_name: "smith" }),
        ],
        offers: [LE, GYU],
        onboarding_requirement_templates: templates,
        deals: [
          {
            id: 188,
            contact_id: 269,
            offer_id: 2,
            name: "jenna smith",
            stage: "won",
            pricing_mode: "standard",
            offer_name_snapshot: "Growing Yourself Up",
            offer_price_snapshot: 1400,
            amount: 1400,
            index: 0,
            sales_id: 0,
            created_at: "2026-08-17T18:48:10.000Z",
            updated_at: "2026-08-17T18:48:10.000Z",
            stage_entered_at: "2026-09-26T18:53:34.000Z",
          } as unknown as Deal,
        ],
        enrollments: [
          {
            id: 93,
            opportunity_id: 188,
            status: "onboarding",
            onboarding_tracking: "tracked",
            created_at: "2026-09-26T18:53:34.000Z",
            updated_at: "2026-09-26T18:53:34.000Z",
          } as unknown as Enrollment,
        ],
        // Exactly her production shape: no provenance recorded anywhere.
        enrollment_onboarding_items: withoutProvenance(),
        tasks: jennaTasks(),
      } as never),
      silent: true,
      latency: 0,
    });
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });
    return { dp, items: await itemsOf(dp) };
  };

  it("names GYU on the requirements it retires, because that is known", async () => {
    const { items } = await transferred();
    for (const key of ["slack_access", "calendar_access"]) {
      const item = byKey(items, key);
      // It exists on the programme being left and not on the one being joined:
      // the offer it came from is the offer we are leaving.
      expect(String(item.source_offer_id), key).toBe("2");
      expect(String(item.retired_from_offer_id), key).toBe("2");
    }
  });

  it("names LE on the re-pointed curriculum requirement", async () => {
    const { items } = await transferred();
    const curriculum = byKey(items, "curriculum_access");
    expect(String(curriculum.source_offer_id)).toBe("1");
    expect(curriculum.label).toBe("Living Example curriculum access");
  });

  it("names LE on the shared pending meditation requirement", async () => {
    const { items } = await transferred();
    const meditation = byKey(items, "meditation_library_access");
    expect(String(meditation.source_offer_id)).toBe("1");
    // Still pending: the move makes no claim about what she has received.
    expect(meditation.status).toBe("pending");
  });

  it("names LE on the requirement it adds", async () => {
    const { items } = await transferred();
    expect(String(byKey(items, "notion_access").source_offer_id)).toBe("1");
  });

  it("invents nothing for the shared requirement that is already done", async () => {
    const { items } = await transferred();
    const contract = byKey(items, "contract");
    // Contract is contract in both programmes. Knowing the Opportunity used to
    // be GYU says nothing about where this finished row came from, so it stays
    // exactly as unknown as it was.
    expect(contract.source_offer_id ?? null).toBeNull();
    expect(contract.status).toBe("done");
    expect(contract.completed_at).toBe("2026-09-26T18:58:47.000Z");
  });

  it("leaves a provenance the row already carried alone", async () => {
    // A row seeded after the column existed already says where it came from,
    // and a transfer never overwrites that with a guess.
    const dp = buildJenna();
    await transferClientOffer(dp, { opportunityId: 188, toOfferId: 1 });
    const items = await itemsOf(dp);
    // buildJenna seeds source_offer_id = 2 on every row.
    expect(String(byKey(items, "slack_access").source_offer_id)).toBe("2");
    // And the completed shared row keeps what it had, rather than being
    // re-pointed at the new programme.
    expect(String(byKey(items, "contract").source_offer_id)).toBe("2");
  });
});
