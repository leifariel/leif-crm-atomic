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
import type { Application, Deal, Offer } from "@/components/atomic-crm/types";
import { classifyApplication } from "./classifyApplication";
import { applicationAdoption } from "./applicationAdoption";
import { adoptImportedApplicationMirror } from "./adoptApplication";
import { kitStatus } from "./kitStatus";

// Bringing an imported Application into current work.
//
// Taylor Carr applied to a round still taking applications, her answers are
// real and current, and her page could only say that no decision could be
// recorded — because the import never gave her the Opportunity every review
// outcome writes to. `historical_import` says how her record arrived. It was
// being read as when she belongs to.

const BOUNDARY = "2026-09-28T23:04:40.000Z";
const IMPORTED_AT = "2026-09-17T16:19:12.000Z";

const GYU: Offer = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 2000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Offer;

const MAPPINGS = [
  {
    id: 1,
    offer_id: 2,
    event: "applicant",
    kit_tag_id: 24082724,
    kit_tag_name: "GYU-Applicant",
    created_at: BOUNDARY,
  },
  {
    id: 2,
    offer_id: 2,
    event: "approved",
    kit_tag_id: 21481248,
    kit_tag_name: "GYU-Approved",
    created_at: BOUNDARY,
  },
];

const openCohort = {
  id: 4,
  offer_id: 2,
  name: "Growing Yourself Up — January 2027",
  status: "applications_open" as const,
  duration_value: 8,
  duration_unit: "weeks",
  kit_tag_id: null,
  kit_tag_name: null,
  created_at: IMPORTED_AT,
  updated_at: IMPORTED_AT,
};

const closedCohort = {
  ...openCohort,
  id: 3,
  status: "applications_closed" as const,
};

// Taylor's exact production shape: imported, pending, no Opportunity, aimed
// at a round still open, with answers on the record.
const taylor = (over: Partial<Application> = {}): Application =>
  ({
    id: 148,
    contact_id: 3,
    opportunity_id: null,
    offer_id: 2,
    intended_cohort_id: 4,
    status: "pending",
    source: "historical_import",
    raw_answers: { why: "I have children - the biggest mirror." },
    submitted_at: "2026-08-28T18:26:46.000Z",
    reviewed_at: null,
    crm_adopted_at: null,
    created_at: IMPORTED_AT,
    updated_at: IMPORTED_AT,
    ...over,
  }) as unknown as Application;

const build = ({
  route = "/applications/148/show",
  applications,
  cohorts = [openCohort, closedCohort],
  deals = [] as unknown[],
  operations = [] as unknown[],
}: {
  route?: string;
  applications?: unknown[];
  cohorts?: unknown[];
  deals?: unknown[];
  operations?: unknown[];
} = {}) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 3, first_name: "Taylor", last_name: "Carr" }),
      ],
      offers: [GYU],
      cohorts,
      deals,
      applications: applications ?? [taylor()],
      kit_tag_mappings: MAPPINGS,
      kit_integration_settings: [{ id: 1, not_before: BOUNDARY }],
      kit_tags: [
        { id: 24082724, name: "GYU-Applicant" },
        { id: 21481248, name: "GYU-Approved" },
      ],
      kit_sync_operations: operations,
      tasks: [],
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

describe("which imported applications are current work", () => {
  it("offers adoption for a pending import to a round still taking applications", () => {
    expect(applicationAdoption(taylor(), openCohort)).toEqual({
      canAdopt: true,
    });
  });

  it("does not offer it for a round that has closed", () => {
    expect(
      applicationAdoption(
        taylor({ intended_cohort_id: 3 } as Partial<Application>),
        closedCohort,
      ),
    ).toEqual({ canAdopt: false, reason: "no-open-cohort" });
  });

  it("does not offer it for a decision already recorded elsewhere", () => {
    expect(
      applicationAdoption(taylor({ status: "approved" }), openCohort),
    ).toEqual({ canAdopt: false, reason: "status-unsupported" });
  });

  it("never translates old vocabulary", () => {
    for (const status of ["waitlist", "denied"] as const) {
      expect(applicationAdoption(taylor({ status }), openCohort)).toEqual({
        canAdopt: false,
        reason: "status-unsupported",
      });
    }
  });

  it("has nothing to offer a live submission", () => {
    expect(
      applicationAdoption(taylor({ source: "public_form" }), openCohort),
    ).toEqual({ canAdopt: false, reason: "not-imported" });
  });

  it("stops offering it once it has been done", () => {
    expect(
      applicationAdoption(taylor({ crm_adopted_at: IMPORTED_AT }), openCohort),
    ).toEqual({ canAdopt: false, reason: "already-adopted" });
  });

  it("has nothing to offer an import that already has its opportunity", () => {
    expect(
      applicationAdoption(taylor({ opportunity_id: 99 }), openCohort),
    ).toEqual({ canAdopt: false, reason: "already-linked" });
  });

  // The owner said this is current work, and that outlives the round.
  it("keeps an adopted applicant in review once the round closes", () => {
    expect(
      classifyApplication(taylor({ crm_adopted_at: IMPORTED_AT }), {
        cohort: closedCohort,
        deal: { stage: "application_received", outcome: null },
      }),
    ).toBe("needs-review");
    // Whereas one nobody adopted is not promoted by the same closure.
    expect(
      classifyApplication(taylor(), {
        cohort: closedCohort,
        deal: null,
      }),
    ).toBe("historical");
  });
});

describe("bringing an imported application into the CRM", () => {
  it("creates exactly one Application Received opportunity and records the act", async () => {
    const { dataProvider } = build();
    const result = await adoptImportedApplicationMirror(dataProvider, 148);

    expect(result.status).toBe("adopted");
    expect(result.created_opportunity).toBe(true);

    const { data: deals } = await dataProvider.getList<Deal>("deals", {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    });
    expect(deals).toHaveLength(1);
    expect(deals[0].stage).toBe("application_received");
    expect(String(deals[0].cohort_id)).toBe("4");
  });

  it("leaves provenance, answers, round and the decision exactly as imported", async () => {
    const { dataProvider } = build();
    await adoptImportedApplicationMirror(dataProvider, 148);

    const { data } = await dataProvider.getOne<Application>("applications", {
      id: 148,
    });
    expect(data.source).toBe("historical_import");
    expect(data.status).toBe("pending");
    expect(data.reviewed_at ?? null).toBeNull();
    expect(String(data.intended_cohort_id)).toBe("4");
    expect(data.raw_answers).toEqual({
      why: "I have children - the biggest mirror.",
    });
    expect(data.crm_adopted_at).toBeTruthy();
  });

  it("replays without opening a second opportunity", async () => {
    const { dataProvider } = build();
    const first = await adoptImportedApplicationMirror(dataProvider, 148);
    const second = await adoptImportedApplicationMirror(dataProvider, 148);
    const third = await adoptImportedApplicationMirror(dataProvider, 148);

    expect(second.status).toBe("already-adopted");
    expect(third.status).toBe("already-adopted");
    expect(String(second.opportunity_id)).toBe(String(first.opportunity_id));

    const { data: deals } = await dataProvider.getList<Deal>("deals", {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    });
    expect(deals).toHaveLength(1);
  });

  it("reuses an opportunity that a review still speaks to", async () => {
    const { dataProvider } = build({
      deals: [
        {
          id: 77,
          contact_id: 3,
          offer_id: 2,
          cohort_id: 4,
          stage: "interested",
          outcome: null,
          archived_at: null,
          name: "Taylor Carr",
          amount: 2000,
          index: 0,
          sales_id: 0,
          created_at: IMPORTED_AT,
          updated_at: IMPORTED_AT,
        },
      ],
    });
    const result = await adoptImportedApplicationMirror(dataProvider, 148);

    expect(result.status).toBe("adopted");
    expect(result.reused_opportunity).toBe(true);
    expect(String(result.opportunity_id)).toBe("77");

    const { data: deals } = await dataProvider.getList<Deal>("deals", {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    });
    expect(deals).toHaveLength(1);
  });

  it("refuses a sale already past the point a review speaks to, and writes nothing", async () => {
    const { dataProvider } = build({
      deals: [
        {
          id: 78,
          contact_id: 3,
          offer_id: 2,
          cohort_id: 4,
          stage: "call_booked",
          outcome: null,
          archived_at: null,
          name: "Taylor Carr",
          amount: 2000,
          index: 0,
          sales_id: 0,
          created_at: IMPORTED_AT,
          updated_at: IMPORTED_AT,
        },
      ],
    });
    const result = await adoptImportedApplicationMirror(dataProvider, 148);

    expect(result.status).toBe("later-stage");
    const { data } = await dataProvider.getOne<Application>("applications", {
      id: 148,
    });
    expect(data.crm_adopted_at ?? null).toBeNull();
    expect(data.opportunity_id ?? null).toBeNull();
  });

  // Samantha Herold and Celia are both in this shape in production: a live
  // GYU conversation carrying no cohort at all.
  it("refuses to open a second live opportunity beside an existing one", async () => {
    const { dataProvider } = build({
      deals: [
        {
          id: 268,
          contact_id: 3,
          offer_id: 2,
          cohort_id: null,
          stage: "call_booked",
          outcome: null,
          archived_at: null,
          name: "Taylor Carr",
          amount: 2000,
          index: 0,
          sales_id: 0,
          created_at: IMPORTED_AT,
          updated_at: IMPORTED_AT,
        },
      ],
    });
    const result = await adoptImportedApplicationMirror(dataProvider, 148);

    expect(result.status).toBe("other-active-sale");
    const { data: deals } = await dataProvider.getList<Deal>("deals", {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    });
    expect(deals).toHaveLength(1);
  });

  it("creates no Kit work at all", async () => {
    const { dataProvider } = build();
    await adoptImportedApplicationMirror(dataProvider, 148);

    const { data } = await dataProvider.getList("kit_sync_operations", {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    });
    expect(data).toHaveLength(0);
  });
});

describe("Kit after adoption", () => {
  const status = (application: Application) =>
    kitStatus({
      application,
      operations: [],
      mappings: MAPPINGS as never,
      cohortTag: null,
      notBefore: BOUNDARY,
    });

  it("says nothing about an import nobody adopted", () => {
    expect(status(taylor()).kind).toBe("historical");
  });

  it("asks for the programme's applicant tag once adopted", () => {
    const result = status(taylor({ crm_adopted_at: IMPORTED_AT }));
    expect(result.kind).toBe("manual-action");
    expect(result.required.map((tag) => tag.kitTagName)).toEqual([
      "GYU-Applicant",
    ]);
  });

  it("asks for the outcome tag too once a decision is recorded", () => {
    const result = status(
      taylor({ crm_adopted_at: IMPORTED_AT, status: "approved" }),
    );
    expect(result.kind).toBe("manual-action");
    expect(result.required.map((tag) => tag.kitTagName).sort()).toEqual([
      "GYU-Applicant",
      "GYU-Approved",
    ]);
  });

  it("never becomes automatic: adoption creates no operation to be tagged by", () => {
    // The tagged state requires a SUCCEEDED automatic operation, and an
    // adopted import has none — so it can never read as Kit-handled.
    expect(status(taylor({ crm_adopted_at: IMPORTED_AT })).kind).not.toBe(
      "tagged",
    );
  });

  it("asks for no Kit work at all for somebody the CRM refused", () => {
    expect(
      status(taylor({ crm_adopted_at: IMPORTED_AT, status: "do_not_engage" }))
        .kind,
    ).toBe("not-used");
  });
});

describe("the Application page", () => {
  it("offers Bring into CRM instead of only explaining the problem", async () => {
    await page.viewport(1280, 1200);
    const { element } = build();
    const screen = await render(element);

    await expect
      .element(screen.getByRole("button", { name: "Bring into CRM" }))
      .toBeVisible();
    // Her answers are still the point of the page.
    expect(document.body.textContent ?? "").toContain(
      "I have children - the biggest mirror.",
    );
  });

  it("asks first, over the page, and writes nothing on cancel", async () => {
    await page.viewport(1280, 1200);
    const { dataProvider, element } = build();
    const screen = await render(element);

    await screen.getByRole("button", { name: "Bring into CRM" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect
      .element(screen.getByText("Bring Taylor Carr into CRM?"))
      .toBeVisible();

    await screen.getByRole("button", { name: "Cancel" }).click();

    const { data } = await dataProvider.getOne<Application>("applications", {
      id: 148,
    });
    expect(data.crm_adopted_at ?? null).toBeNull();
    expect(data.opportunity_id ?? null).toBeNull();
    const { data: deals } = await dataProvider.getList<Deal>("deals", {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    });
    expect(deals).toHaveLength(0);
  });

  it("does not offer it on an imported record that is real history", async () => {
    await page.viewport(1280, 1200);
    const { element } = build({
      applications: [taylor({ intended_cohort_id: 3 } as Partial<Application>)],
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Taylor Carr")).toBeVisible();
    const buttons = Array.from(document.body.querySelectorAll("button")).map(
      (node) => node.textContent?.trim(),
    );
    expect(buttons).not.toContain("Bring into CRM");
  });

  it("does not offer it once it has been done, and a decision can be recorded", async () => {
    await page.viewport(1280, 1200);
    const { element } = build({
      applications: [
        taylor({ crm_adopted_at: IMPORTED_AT, opportunity_id: 77 }),
      ],
      deals: [
        {
          id: 77,
          contact_id: 3,
          offer_id: 2,
          cohort_id: 4,
          stage: "application_received",
          outcome: null,
          archived_at: null,
          name: "Taylor Carr",
          amount: 2000,
          index: 0,
          sales_id: 0,
          created_at: IMPORTED_AT,
          updated_at: IMPORTED_AT,
        },
      ],
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Taylor Carr")).toBeVisible();
    const buttons = Array.from(document.body.querySelectorAll("button")).map(
      (node) => node.textContent?.trim(),
    );
    expect(buttons).not.toContain("Bring into CRM");
    // The review controls the whole slice exists to reach.
    expect(buttons).toContain("Approve");
    expect(document.body.textContent ?? "").not.toContain(
      "No sales opportunity is linked",
    );
  });
});
