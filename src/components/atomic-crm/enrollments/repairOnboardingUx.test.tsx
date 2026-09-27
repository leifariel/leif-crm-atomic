import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { Notification } from "@/components/admin/notification";
import { testI18nProvider } from "@/components/atomic-crm/providers/commons/i18nProvider";
import { createDataProvider } from "@/components/atomic-crm/providers/fakerest";
import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import type {
  Deal,
  Enrollment,
  EnrollmentOnboardingItem,
  Offer,
  OnboardingRequirementTemplate,
  Task,
} from "@/components/atomic-crm/types";

// Jenna Smith's shape on the client page: her Opportunity says The Living
// Example and her onboarding is still Growing Yourself Up's. The page has to
// say what is wrong in a card, ask the one question it cannot answer in a
// modal, and say nothing at all once the onboarding matches.

const LE: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Offer;

const GYU: Offer = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 1400,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Offer;

const templates = [
  ...[
    ["contract", "Contract signed", "Send contract to {name}", 1],
    ["notion_access", "Notion access", "Grant {name} Notion access", 2],
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

const itemsFor = (offerId: 1 | 2): EnrollmentOnboardingItem[] =>
  templates
    .filter((template) => Number(template.offer_id) === offerId)
    .map((template, i) => ({
      id: 300 + i + offerId * 20,
      enrollment_id: 93,
      requirement_key: template.key,
      label: template.label,
      task_text_template: template.task_text_template,
      is_required: true,
      sort_order: template.sort_order,
      status: template.key === "contract" ? "done" : "pending",
      completed_at:
        template.key === "contract" ? "2026-09-26T18:58:47.000Z" : null,
      source_offer_id: null,
      created_at: "2026-09-26T18:53:34.000Z",
      updated_at: "2026-09-26T18:53:34.000Z",
    })) as unknown as EnrollmentOnboardingItem[];

const tasksFor = (items: EnrollmentOnboardingItem[]): Task[] =>
  items.map(
    (item, i) =>
      ({
        id: 700 + i,
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

const buildCrm = ({ stale }: { stale: boolean }) => {
  const items = itemsFor(stale ? 2 : 1);
  const dataProvider = createDataProvider({
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
          offer_id: 1,
          cohort_id: null,
          name: "jenna smith",
          stage: "won",
          prospect_decision: "yes",
          owner_decision: "would_work_with",
          pricing_mode: "standard",
          offer_name_snapshot: "The Living Example",
          offer_price_snapshot: 4000,
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: "2026-08-17T18:48:10.000Z",
          updated_at: "2026-08-17T18:48:10.000Z",
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
      enrollment_onboarding_items: items,
      tasks: tasksFor(items),
    } as never),
    silent: true,
    latency: 0,
  });
  return {
    dataProvider,
    element: (
      <MemoryRouter initialEntries={["/enrollments/93/show"]}>
        <CRM
          dataProvider={dataProvider}
          authProvider={createTestAuthProvider()}
          i18nProvider={testI18nProvider}
          store={memoryStore()}
          disableTelemetry
          layout={({ children }) => (
            <>
              {children}
              <Notification />
            </>
          )}
        />
      </MemoryRouter>
    ),
  };
};

describe("a client whose onboarding is not their programme's", () => {
  it("says so in a card, naming both programmes", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ stale: true });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Onboarding needs repair"))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "This client is in The Living Example, but their onboarding is still set up for Growing Yourself Up.",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Repair onboarding" }))
      .toBeVisible();
  });

  it("opens the repair in a modal, with the question it cannot answer itself", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ stale: true });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Repair onboarding" }).click();

    const dialog = screen.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(screen.getByText("Current programme")).toBeVisible();
    await expect.element(screen.getByText("Previous setup")).toBeVisible();
    // Deterministic, so it is suggested — and still confirmed.
    await expect
      .element(screen.getByText("Suggested from the current onboarding setup."))
      .toBeVisible();
  });

  it("states the outcome in the operator's own terms", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ stale: true });
    const screen = await render(element);
    await screen.getByRole("button", { name: "Repair onboarding" }).click();
    await expect.element(screen.getByText("This will:")).toBeVisible();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Keep Contract signed");
    expect(text).toContain("Add Notion access");
    expect(text).toContain(
      "Update Living Example curriculum access to The Living Example",
    );
    expect(text).toContain(
      "Remove Slack access and Google Calendar access from current onboarding",
    );
    expect(text).toContain("Keep the original application and sales call");

    // Answer first, mechanism second: no implementation language in front of
    // somebody deciding whether to click.
    for (const forbidden of [
      "projection",
      "offer_id",
      "Opportunity exactly as it is",
      "reconcile",
      "source_offer",
      "retired",
      "database",
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("repairs, closes itself, and leaves the card gone", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = buildCrm({ stale: true });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Repair onboarding" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await screen
      .getByRole("button", { name: "Repair onboarding" })
      .last()
      .click();

    await expect.element(screen.getByText("Onboarding repaired")).toBeVisible();

    // The checklist is the current programme's, and the warning has nothing
    // left to warn about.
    const { data: items } = await dataProvider.getList(
      "enrollment_onboarding_items",
      {
        filter: { enrollment_id: 93 },
        pagination: { page: 1, perPage: 50 },
        sort: { field: "sort_order", order: "ASC" },
      },
    );
    const live = items.filter((item) => item.status !== "retired");
    expect(live.map((item) => item.requirement_key).sort()).toEqual([
      "contract",
      "curriculum_access",
      "meditation_library_access",
      "notion_access",
    ]);
    expect(items.filter((item) => item.status === "retired").length).toBe(2);
  });
});

describe("a client whose onboarding is already their programme's", () => {
  it("shows no card and no repair action at all", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ stale: false });
    const screen = await render(element);

    // The page itself is up.
    await expect
      .element(screen.getByText("Notion access").first())
      .toBeVisible();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Onboarding needs repair");
    expect(text).not.toContain("Repair onboarding");
  });
});
