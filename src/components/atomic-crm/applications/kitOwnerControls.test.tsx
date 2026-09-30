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
  Application,
  Deal,
  KitSyncOperation,
  Offer,
} from "@/components/atomic-crm/types";

// The owner-facing Kit controls: choosing a tag, adding one to a person, and
// seeing everything Kit still needs in one place. No test reaches Kit — the
// FakeRest provider stands in for it, which is also what proves no call site
// depends on the provider being up.

const BOUNDARY = "2026-09-28T23:04:40.000Z";
const PRE = "2026-09-21T14:00:00.000Z";

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

const MAPPINGS = [
  {
    id: 1,
    offer_id: 1,
    event: "applicant",
    kit_tag_id: 24082722,
    kit_tag_name: "MiniDD_Applicant",
    created_at: BOUNDARY,
  },
  {
    id: 2,
    offer_id: 1,
    event: "approved",
    kit_tag_id: 21784073,
    kit_tag_name: "MiniDD_Approved",
    created_at: BOUNDARY,
  },
  {
    id: 3,
    offer_id: 1,
    event: "needs_higher_care",
    kit_tag_id: 24082725,
    kit_tag_name: "MiniDD_NeedsHigherCare",
    created_at: BOUNDARY,
  },
  {
    id: 4,
    offer_id: 1,
    event: "not_fit",
    kit_tag_id: 21784076,
    kit_tag_name: "MiniDD_Denied",
    created_at: BOUNDARY,
  },
];

const CATALOG = [
  { id: 24082722, name: "MiniDD_Applicant" },
  { id: 21784073, name: "MiniDD_Approved" },
  { id: 24082725, name: "MiniDD_NeedsHigherCare" },
  { id: 21784076, name: "MiniDD_Denied" },
];

const build = ({
  route = "/applications/9/show",
  status = "pending",
  source = "public_form",
  createdAt = PRE,
  operations = [] as Partial<KitSyncOperation>[],
  eligibility = "normal",
  applications,
  tasks = [] as unknown[],
}: {
  route?: string;
  status?: string;
  source?: string;
  createdAt?: string;
  operations?: Partial<KitSyncOperation>[];
  eligibility?: string;
  applications?: unknown[];
  tasks?: unknown[];
} = {}) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        {
          ...buildContact({
            id: 3,
            first_name: "Michelle",
            last_name: "Smith",
          }),
          sales_eligibility: eligibility,
        },
      ],
      offers: [LE],
      deals: [
        {
          id: 5,
          contact_id: 3,
          offer_id: 1,
          name: "Michelle Smith",
          stage: "application_received",
          offer_name_snapshot: "The Living Example",
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: PRE,
          updated_at: PRE,
        } as unknown as Deal,
      ],
      applications: applications ?? [
        {
          id: 9,
          contact_id: 3,
          opportunity_id: 5,
          offer_id: 1,
          intended_cohort_id: null,
          status,
          source,
          raw_answers: {},
          submitted_at: createdAt,
          reviewed_at: null,
          created_at: createdAt,
          updated_at: createdAt,
        } as unknown as Application,
      ],
      kit_tag_mappings: MAPPINGS,
      kit_integration_settings: [{ id: 1, not_before: BOUNDARY }],
      kit_tags: CATALOG,
      kit_sync_operations: operations.map((over, index) => ({
        id: index + 1,
        application_id: null,
        contact_id: 3,
        kind: "manual",
        origin: "manual_owner",
        requested_by: "leif@leifariel.com",
        email: "michelle@example.com",
        kit_tag_id: 24082722,
        kit_tag_name: "MiniDD_Applicant",
        status: "pending",
        attempts: 0,
        last_attempt_at: null,
        succeeded_at: null,
        failed_at: null,
        failure_class: null,
        failure_reason: null,
        kit_subscriber_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...over,
      })),
      tasks,
      enrollment_onboarding_items: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return {
    dataProvider,
    element: (
      <MemoryRouter initialEntries={[route]}>
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

describe("the Application's manual Kit work", () => {
  it("names the required tag and offers both actions", async () => {
    await page.viewport(1280, 1400);
    const { element } = build();
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit: Manual — action needed"))
      .toBeVisible();
    expect(document.body.textContent ?? "").toContain("MiniDD_Applicant");
    await expect
      .element(screen.getByRole("button", { name: "Add required tags" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Manage Kit tags" }))
      .toBeVisible();
  });

  it("Add required tags enqueues exactly what is missing, and nothing else", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = build();
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add required tags" }).click();
    await expect
      .element(screen.getByText("MiniDD_Applicant queued for Kit."))
      .toBeVisible();

    const { data } = await dataProvider.getList<KitSyncOperation>(
      "kit_sync_operations",
      {
        filter: {},
        pagination: { page: 1, perPage: 50 },
        sort: { field: "id", order: "ASC" },
      },
    );
    expect(data).toHaveLength(1);
    expect(data[0].kit_tag_id).toBe(24082722);
    expect(data[0].origin).toBe("manual_owner");
    // It belongs to the human; the application is recorded as where it began.
    expect(String(data[0].application_id)).toBe("9");
  });

  it("does not re-enqueue a tag that already succeeded", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = build({
      status: "approved",
      operations: [
        {
          status: "succeeded",
          succeeded_at: new Date().toISOString(),
          kit_subscriber_id: "42",
        },
      ],
    });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add required tags" }).click();
    await expect.element(screen.getByText(/queued for Kit/)).toBeVisible();

    const { data } = await dataProvider.getList<KitSyncOperation>(
      "kit_sync_operations",
      {
        filter: {},
        pagination: { page: 1, perPage: 50 },
        sort: { field: "id", order: "ASC" },
      },
    );
    // The applicant tag was already confirmed; only the approved tag is new.
    expect(data).toHaveLength(2);
    expect(data.map((row) => row.kit_tag_id).sort()).toEqual([
      21784073, 24082722,
    ]);
  });

  // Michelle Smith's real state after the first human-accepted manual tag:
  // a pre-boundary Living Example application, still pending, whose applicant
  // tag reached Kit and came back with a subscriber id. Nothing is owed, so
  // nothing is asked for — and no decision tag was invented on the way.
  it("asks for nothing once the only required tag is confirmed", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({
      status: "pending",
      operations: [
        {
          status: "succeeded",
          succeeded_at: new Date().toISOString(),
          kit_subscriber_id: "4294987335",
        },
      ],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit: Manual — up to date ✓"))
      .toBeVisible();

    const body = document.body.textContent ?? "";
    expect(body).toContain("✓ MiniDD_Applicant");
    // No decision tag exists for a pending application, so none may appear.
    expect(body).not.toContain("MiniDD_Approved");
    expect(body).not.toContain("MiniDD_Denied");

    // The action is gone because there is nothing left to add; managing tags
    // by hand stays available.
    const buttons = Array.from(document.body.querySelectorAll("button")).map(
      (node) => node.textContent?.trim(),
    );
    expect(buttons).not.toContain("Add required tags");
    expect(buttons).toContain("Manage Kit tags");
  });

  it("says the Needs Higher Care email is still manual, even after the tag lands", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({
      status: "needs_higher_care",
      operations: [
        {
          status: "succeeded",
          succeeded_at: new Date().toISOString(),
          kit_subscriber_id: "42",
        },
        {
          kit_tag_id: 24082725,
          kit_tag_name: "MiniDD_NeedsHigherCare",
          status: "succeeded",
          succeeded_at: new Date().toISOString(),
          kit_subscriber_id: "42",
        },
      ],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit: Manual — up to date ✓"))
      .toBeVisible();
    // Tag success is not email success, and the page never lets that blur.
    await expect
      .element(
        screen.getByText(
          "Needs Higher Care email still needs to be sent manually.",
        ),
      )
      .toBeVisible();
  });

  it("offers no Kit action at all for somebody the CRM refused", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({
      status: "do_not_engage",
      eligibility: "do_not_engage",
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Kit: Not used")).toBeVisible();
    const buttons = Array.from(document.body.querySelectorAll("button")).map(
      (button) => button.textContent?.trim(),
    );
    expect(buttons).not.toContain("Add required tags");
    expect(buttons).not.toContain("Manage Kit tags");
  });
});

describe("the shared tag manager", () => {
  it("opens over the Application, warns about automations, and adds by id", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = build();
    const screen = await render(element);

    await screen.getByRole("button", { name: "Manage Kit tags" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Adding a Kit tag may trigger an automation connected to that tag.",
        ),
      )
      .toBeVisible();

    // The catalog is searchable, and selection is by the provider's own id.
    await screen.getByPlaceholder("Search your Kit tags").fill("Denied");
    await screen.getByRole("button", { name: "MiniDD_Denied" }).click();
    // An outcome tag earns one concise confirmation before it can send.
    await screen.getByRole("button", { name: "Add tag" }).first().click();
    await expect.element(screen.getByText("Add MiniDD_Denied?")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          "This tag is connected to one of your Kit email automations.",
        ),
      )
      .toBeVisible();

    const before = await dataProvider.getList<KitSyncOperation>(
      "kit_sync_operations",
      {
        filter: {},
        pagination: { page: 1, perPage: 50 },
        sort: { field: "id", order: "ASC" },
      },
    );
    // Nothing is queued until the confirmation is answered.
    expect(before.data).toHaveLength(0);
  });

  it("creates a tag that does not exist yet, and selects it", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = build();
    const screen = await render(element);

    await screen.getByRole("button", { name: "Manage Kit tags" }).click();
    await screen.getByPlaceholder("Search your Kit tags").fill("GYU_Jan2027");
    await screen.getByRole("button", { name: /Create/ }).click();

    const { data } = await dataProvider.getList<{ id: number; name: string }>(
      "kit_tags",
      {
        filter: {},
        pagination: { page: 1, perPage: 50 },
        sort: { field: "id", order: "ASC" },
      },
    );
    expect(data.map((tag) => tag.name)).toContain("GYU_Jan2027");
  });
});

describe("the Dashboard's one Kit item", () => {
  const fivePeople = () =>
    Array.from({ length: 5 }, (_, index) => ({
      id: 100 + index,
      contact_id: 3,
      opportunity_id: null,
      offer_id: 1,
      intended_cohort_id: null,
      status: "pending",
      source: "public_form",
      raw_answers: {},
      submitted_at: PRE,
      reviewed_at: null,
      created_at: PRE,
      updated_at: PRE,
    }));

  // A real Needs Attention item, so the box has something of its own to count
  // alongside Kit's one row.
  const unresolvedCall = () => [
    {
      id: 1,
      contact_id: 3,
      type: "resolve_sales_call",
      text: "Did this call happen?",
      due_date: PRE,
      done_date: null,
      status: "pending",
      sales_id: 0,
      sales_call_id: 1,
    },
  ];

  it("is one aggregate row, not one per applicant", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({ route: "/", applications: fivePeople() });
    const screen = await render(element);

    await expect
      .element(screen.getByText("5 applicants need attention"))
      .toBeVisible();
    // Five people, one thing to do.
    expect(
      (document.body.textContent ?? "").match(/applicants need attention/g) ??
        [],
    ).toHaveLength(1);
  });

  it("lives inside Needs Attention, not in a strip of its own", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({ route: "/", applications: fivePeople() });
    const screen = await render(element);

    await expect
      .element(screen.getByText("5 applicants need attention"))
      .toBeVisible();

    // The old full-width strip below the task cards is gone entirely.
    expect(document.body.textContent ?? "").not.toContain(
      "Kit needs attention ·",
    );

    // And the row is a descendant of the Needs Attention card rather than a
    // sibling section further down the page.
    const heading = [...document.querySelectorAll("p")].find(
      (node) => node.textContent?.trim() === "Needs Attention",
    );
    const card = heading?.closest("div.min-w-0, [data-slot='card']");
    expect(card?.textContent ?? "").toContain("5 applicants need attention");
  });

  it("adds exactly ONE to the Needs Attention count, whatever the backlog", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({
      route: "/",
      applications: fivePeople(),
      tasks: unresolvedCall(),
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("5 applicants need attention"))
      .toBeVisible();

    const heading = [...document.querySelectorAll("p")].find(
      (node) => node.textContent?.trim() === "Needs Attention",
    );
    // One real Task + one Kit row = 2. Emphatically not 1 + 5 = 6: the
    // heading counts rows of work, the Kit row states the people behind it.
    expect(heading?.nextElementSibling?.textContent?.trim()).toBe("2");
  });

  it("leaves the other Needs Attention items alone", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({
      route: "/",
      applications: fivePeople(),
      tasks: unresolvedCall(),
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("5 applicants need attention"))
      .toBeVisible();
    expect(document.body.textContent ?? "").toContain("Did this call happen?");
  });

  it("opens a modal over the Dashboard with the required tags", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({ route: "/", applications: fivePeople() });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: /applicants need attention/ })
      .click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect.element(screen.getByText("Manual Kit work")).toBeVisible();
    expect(document.body.textContent ?? "").toContain("MiniDD_Applicant");
  });

  it("gives every person in the modal the same row structure", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({ route: "/", applications: fivePeople() });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: /applicants need attention/ })
      .click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    const rows = [
      ...(document
        .querySelector("[role='dialog']")
        ?.querySelectorAll("[data-kit-work-row]") ?? []),
    ];
    expect(rows).toHaveLength(5);
    // One structure for everybody: the button cannot land on the right for
    // one person and under the text for the next because their programme
    // name happens to be longer.
    expect(new Set(rows.map((node) => node.className)).size).toBe(1);
  });

  it("keeps that one row structure on a narrow screen", async () => {
    await page.viewport(420, 900);
    const { element } = build({ route: "/", applications: fivePeople() });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: /applicants need attention/ })
      .click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    const rows = [
      ...(document
        .querySelector("[role='dialog']")
        ?.querySelectorAll("[data-kit-work-row]") ?? []),
    ];
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((node) => node.className)).size).toBe(1);
  });

  it("disappears when nothing is actionable", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({
      route: "/",
      operations: [
        {
          status: "succeeded",
          succeeded_at: new Date().toISOString(),
          kit_subscriber_id: "42",
        },
      ],
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Dashboard")).toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("need attention");
    // With nothing else needing attention either, the box goes too.
    expect(document.body.textContent ?? "").not.toContain("Needs Attention");
  });

  it("never lists an imported historical record as current work", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({
      route: "/",
      applications: [
        {
          id: 200,
          contact_id: 3,
          opportunity_id: null,
          offer_id: 1,
          intended_cohort_id: null,
          status: "pending",
          source: "historical_import",
          raw_answers: {},
          submitted_at: PRE,
          reviewed_at: null,
          created_at: PRE,
          updated_at: PRE,
        },
      ],
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Dashboard")).toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("need attention");
  });
});
