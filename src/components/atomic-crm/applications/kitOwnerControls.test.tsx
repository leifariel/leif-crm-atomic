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
  adoptedAt = null as string | null,
  operations = [] as Partial<KitSyncOperation>[],
  eligibility = "normal",
  applications,
  tasks = [] as unknown[],
}: {
  route?: string;
  status?: string;
  source?: string;
  createdAt?: string;
  adoptedAt?: string | null;
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
          crm_adopted_at: adoptedAt,
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
    // Only the outcome tag is still missing, and that one can send an email,
    // so it asks first.
    await expect.element(screen.getByText("Add 1 Kit tag?")).toBeVisible();
    await screen.getByRole("button", { name: "Add tag" }).click();
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

// Right after a decision, on the page where it was just made. Taylor Carr's
// shape: an imported Application the owner deliberately brought into the CRM,
// then approved. Provenance stays historical_import forever; being adopted is
// what makes it current work, and an approved decision adds a second required
// tag that somebody has to actually add.
describe("the Kit work a decision leaves behind", () => {
  const taylor = () =>
    build({
      status: "approved",
      source: "historical_import",
      adoptedAt: "2026-10-01T00:45:35.000Z",
      createdAt: PRE,
    });

  it("asks for the programme tag AND the outcome tag, without leaving the page", async () => {
    await page.viewport(1280, 1400);
    const { element } = taylor();
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit: Manual — action needed"))
      .toBeVisible();
    const body = () => document.body.textContent ?? "";
    await expect.poll(() => body().includes("MiniDD_Approved")).toBe(true);
    expect(body()).toContain("MiniDD_Applicant");
    await expect
      .element(screen.getByRole("button", { name: "Add required tags" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Manage Kit tags" }))
      .toBeVisible();
    // Still the Application, not a page it navigated to.
    await expect.element(screen.getByText("Review Decision")).toBeVisible();
  });

  it("requires exactly the two tags, because this round has no Kit tag of its own", async () => {
    await page.viewport(1280, 1400);
    const { element } = taylor();
    const screen = await render(element);
    await expect
      .element(screen.getByText("Kit: Manual — action needed"))
      .toBeVisible();
    await expect
      .poll(() => document.body.textContent ?? "")
      .toContain("2 tags still to add");
  });

  it("no longer claims nothing is outstanding while two tags are missing", async () => {
    await page.viewport(1280, 1400);
    const { element } = taylor();
    const screen = await render(element);
    await expect
      .element(screen.getByText("Kit: Manual — action needed"))
      .toBeVisible();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Decision recorded.");
    expect(body).not.toContain("no further action needed");
  });
});

// Approving never tags and never emails. THIS button is where that becomes
// possible, so it is the one that asks first.
describe("adding the tags a decision requires", () => {
  const taylor = () =>
    build({
      status: "approved",
      source: "historical_import",
      adoptedAt: "2026-10-01T00:45:35.000Z",
      createdAt: PRE,
    });

  it("asks before adding a tag connected to an email automation", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = taylor();
    const screen = await render(element);
    await screen.getByRole("button", { name: "Add required tags" }).click();

    await expect.element(screen.getByText("Add 2 Kit tags?")).toBeVisible();
    const body = document.body.textContent ?? "";
    // ONE conservative sentence. The CRM reads which event a tag is mapped
    // to, never Kit automation topology, so it never asserts the connection
    // and never promises an email.
    expect(body).toContain(
      "MiniDD_Approved may trigger a Kit automation connected to that tag.",
    );
    expect(body).not.toContain("is connected to one of your Kit email");
    expect(body).not.toContain(
      "Adding a Kit tag may trigger an automation connected to that tag.",
    );
    // No duplicate-click trap. The lightbox takes the page out of the
    // accessibility tree, so the action behind it is not merely disabled —
    // it cannot be reached or clicked at all while the question stands.
    await expect
      .element(screen.getByRole("button", { name: "Add required tags" }))
      .not.toBeInTheDocument();

    // Nothing has been queued merely by asking.
    const { total } = await dataProvider.getList("kit_sync_operations", {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    });
    expect(total).toBe(0);
  });

  it("Cancel queues nothing at all", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = taylor();
    const screen = await render(element);
    await screen.getByRole("button", { name: "Add required tags" }).click();
    await expect.element(screen.getByText("Add 2 Kit tags?")).toBeVisible();
    await screen.getByRole("button", { name: "Cancel" }).click();

    const { total } = await dataProvider.getList("kit_sync_operations", {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    });
    expect(total).toBe(0);
  });

  it("confirming uses the existing manual authority exactly once per missing tag", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = taylor();
    const screen = await render(element);
    await screen.getByRole("button", { name: "Add required tags" }).click();
    await expect.element(screen.getByText("Add 2 Kit tags?")).toBeVisible();
    await screen.getByRole("button", { name: "Add tags" }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getList<KitSyncOperation>(
          "kit_sync_operations",
          {
            filter: {},
            pagination: { page: 1, perPage: 50 },
            sort: { field: "id", order: "ASC" },
          },
        );
        return data.length;
      })
      .toBe(2);

    const { data } = await dataProvider.getList<KitSyncOperation>(
      "kit_sync_operations",
      {
        filter: {},
        pagination: { page: 1, perPage: 50 },
        sort: { field: "id", order: "ASC" },
      },
    );
    expect(data.every((op) => op.origin === "manual_owner")).toBe(true);
    expect(data.map((op) => op.kit_tag_name).sort()).toEqual([
      "MiniDD_Applicant",
      "MiniDD_Approved",
    ]);
  });

  it("closes the question and says the work is queued, so nobody clicks twice", async () => {
    await page.viewport(1280, 1400);
    const { element } = taylor();
    const screen = await render(element);
    await screen.getByRole("button", { name: "Add required tags" }).click();
    await expect.element(screen.getByText("Add 2 Kit tags?")).toBeVisible();
    await screen.getByRole("button", { name: "Add tags" }).click();

    // The lightbox goes.
    await expect
      .element(screen.getByText("Add 2 Kit tags?"))
      .not.toBeInTheDocument();

    // And the card no longer reads exactly as it did before the click.
    await expect.element(screen.getByText("Kit: Syncing…")).toBeVisible();
    await expect
      .poll(() => document.body.textContent ?? "")
      .toContain("2 tags queued");
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("Kit: Manual — action needed");
    expect(body).not.toContain("still to add");
    // Nothing left to click twice.
    await expect
      .element(screen.getByRole("button", { name: "Add required tags" }))
      .not.toBeInTheDocument();
    // The one thing that stays available.
    await expect
      .element(screen.getByRole("button", { name: "Manage Kit tags" }))
      .toBeVisible();
  });

  it("does not ask when nothing being added can send an email", async () => {
    await page.viewport(1280, 1400);
    // Pending: the programme tag only, which has no automation attached.
    const { dataProvider, element } = build();
    const screen = await render(element);
    await screen.getByRole("button", { name: "Add required tags" }).click();

    await expect
      .element(screen.getByText("MiniDD_Applicant queued for Kit."))
      .toBeVisible();
    // No dialog of any size: the quiet case is still one click.
    expect(document.body.textContent ?? "").not.toContain("Kit tag?");

    const { data } = await dataProvider.getList<KitSyncOperation>(
      "kit_sync_operations",
      {
        filter: {},
        pagination: { page: 1, perPage: 50 },
        sort: { field: "id", order: "ASC" },
      },
    );
    expect(data).toHaveLength(1);
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

  // The Dashboard offers the same provider work through a second door, so it
  // asks the same question. Otherwise the warning is only as good as which
  // button Leif happens to use.
  const approvedAdoptedImport = () => [
    {
      id: 101,
      contact_id: 3,
      opportunity_id: 5,
      offer_id: 1,
      intended_cohort_id: null,
      status: "approved",
      source: "historical_import",
      crm_adopted_at: "2026-10-01T00:45:35.000Z",
      raw_answers: {},
      submitted_at: PRE,
      reviewed_at: "2026-10-02T15:55:16.000Z",
      created_at: PRE,
      updated_at: PRE,
    },
  ];

  it("asks before adding an outcome tag from the Dashboard too", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = build({
      route: "/",
      applications: approvedAdoptedImport(),
    });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: /applicants? need(s)? attention/ })
      .click();
    await expect.element(screen.getByText("Manual Kit work")).toBeVisible();
    await screen.getByRole("button", { name: "Add required tags" }).click();

    await expect.element(screen.getByText(/Add 2 Kit tags for/)).toBeVisible();
    expect(document.body.textContent ?? "").toContain(
      "MiniDD_Approved may trigger a Kit automation connected to that tag.",
    );

    const before = await dataProvider.getList<KitSyncOperation>(
      "kit_sync_operations",
      {
        filter: {},
        pagination: { page: 1, perPage: 50 },
        sort: { field: "id", order: "ASC" },
      },
    );
    expect(before.data).toHaveLength(0);
  });

  it("Cancel on the Dashboard queues nothing", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = build({
      route: "/",
      applications: approvedAdoptedImport(),
    });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: /applicants? need(s)? attention/ })
      .click();
    await screen.getByRole("button", { name: "Add required tags" }).click();
    await expect.element(screen.getByText(/Add 2 Kit tags for/)).toBeVisible();
    await screen.getByRole("button", { name: "Cancel" }).click();

    const { data } = await dataProvider.getList<KitSyncOperation>(
      "kit_sync_operations",
      {
        filter: {},
        pagination: { page: 1, perPage: 50 },
        sort: { field: "id", order: "ASC" },
      },
    );
    expect(data).toHaveLength(0);
  });

  it("confirming on the Dashboard uses the same authority, once per tag", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = build({
      route: "/",
      applications: approvedAdoptedImport(),
    });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: /applicants? need(s)? attention/ })
      .click();
    await screen.getByRole("button", { name: "Add required tags" }).click();
    await expect.element(screen.getByText(/Add 2 Kit tags for/)).toBeVisible();
    await screen.getByRole("button", { name: "Add tags" }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getList<KitSyncOperation>(
          "kit_sync_operations",
          {
            filter: {},
            pagination: { page: 1, perPage: 50 },
            sort: { field: "id", order: "ASC" },
          },
        );
        return data
          .map((op) => op.kit_tag_name)
          .sort()
          .join(",");
      })
      .toBe("MiniDD_Applicant,MiniDD_Approved");
  });

  it("closes the same lightbox and stops asking, from the Dashboard too", async () => {
    await page.viewport(1280, 1400);
    const { element } = build({
      route: "/",
      applications: approvedAdoptedImport(),
    });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: /applicants? need(s)? attention/ })
      .click();
    await screen.getByRole("button", { name: "Add required tags" }).click();
    await expect.element(screen.getByText(/Add 2 Kit tags for/)).toBeVisible();
    await screen.getByRole("button", { name: "Add tags" }).click();

    // Same lightbox, same closing behaviour as the Application.
    await expect
      .element(screen.getByText(/Add 2 Kit tags for/))
      .not.toBeInTheDocument();
    // And the work is no longer asked for, because it is queued.
    await expect
      .element(screen.getByRole("button", { name: "Add required tags" }))
      .not.toBeInTheDocument();
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
