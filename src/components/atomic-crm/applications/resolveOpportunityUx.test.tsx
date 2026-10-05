import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { Notification } from "@/components/admin/notification";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import type { Application, Deal, Offer } from "../types";

// Samantha Herold (application 97) and Celia (146), as production holds
// them, and the dead end they were in.
//
// The page told Leif BOTH "There is already a live sales conversation with
// this person for this programme" AND "No sales opportunity is linked to
// this application, so a decision cannot be recorded here yet." Both true.
// Together, nothing he could do.
//
// The shape: a historical_import Application for Growing Yourself Up with
// intended_cohort 4 and no opportunity_id, beside a live Deal for the same
// person and offer at call_booked carrying cohort_id NULL. The missing
// round is why adoption could not pair them.

const AT = "2026-09-01T00:00:00.000Z";

const GYU = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 1400,
  is_active: true,
  created_at: AT,
  updated_at: AT,
} as Offer;

const openCohort = {
  id: 4,
  offer_id: 2,
  name: "Growing Yourself Up — January 2027",
  status: "applications_open" as const,
  duration_value: 8,
  duration_unit: "weeks",
  kit_tag_id: null,
  kit_tag_name: null,
  created_at: AT,
  updated_at: AT,
};

const samantha = (over: Partial<Application> = {}): Application =>
  ({
    id: 97,
    contact_id: 3,
    opportunity_id: null,
    offer_id: 2,
    intended_cohort_id: 4,
    status: "pending",
    source: "historical_import",
    raw_answers: { why: "Because of my children." },
    submitted_at: AT,
    reviewed_at: null,
    crm_adopted_at: null,
    created_at: AT,
    updated_at: AT,
    ...over,
  }) as unknown as Application;

const liveDeal = (over: Partial<Deal> = {}): Deal =>
  ({
    id: 268,
    name: "Samantha Herold",
    contact_id: 3,
    offer_id: 2,
    cohort_id: null,
    stage: "call_booked",
    outcome: null,
    amount: 1400,
    index: 0,
    sales_id: 0,
    created_at: AT,
    updated_at: AT,
    stage_entered_at: AT,
    archived_at: null,
    ...over,
  }) as unknown as Deal;

const build = ({ deals = [liveDeal()], applications = [samantha()] } = {}) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 3, first_name: "Samantha", last_name: "Herold" }),
      ],
      offers: [GYU],
      cohorts: [openCohort],
      deals,
      applications,
      kit_tag_mappings: [],
      kit_sync_operations: [],
      tasks: [],
      enrollment_onboarding_items: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return {
    dataProvider,
    element: (
      <MemoryRouter initialEntries={["/applications/97/show"]}>
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

describe("an Application blocked behind a live conversation", () => {
  it("offers a way out instead of two contradictory sentences", async () => {
    await page.viewport(1280, 1200);
    const { element } = build();
    const screen = await render(element);

    await expect
      .element(
        screen.getByText("already a live sales conversation", { exact: false }),
      )
      .toBeVisible();
    // The third option that was missing.
    await expect
      .element(
        screen.getByRole("button", { name: "Resolve sales conversation" }),
      )
      .toBeVisible();
  });

  it("names the conversation, including the round it does not have", async () => {
    await page.viewport(1280, 1200);
    const { element } = build();
    const screen = await render(element);

    await screen
      .getByRole("button", { name: "Resolve sales conversation" })
      .click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect
      .element(screen.getByText("Opportunity 268", { exact: false }))
      .toBeVisible();
    // Said plainly: the missing round is what kept these two apart.
    await expect
      .element(screen.getByText("no round recorded", { exact: false }))
      .toBeVisible();
  });

  it("links the exact existing Opportunity, and creates nothing", async () => {
    await page.viewport(1280, 1200);
    const { dataProvider, element } = build();
    const screen = await render(element);

    const before = await dataProvider.getList("deals", {
      filter: {},
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    });

    await screen
      .getByRole("button", { name: "Resolve sales conversation" })
      .click();
    await screen.getByRole("button", { name: "Link" }).click();

    await expect
      .element(
        screen.getByText("linked to that sales conversation", { exact: false }),
      )
      .toBeVisible();

    const { data: application } = await dataProvider.getOne<Application>(
      "applications",
      { id: 97 },
    );
    expect(String(application.opportunity_id)).toBe("268");

    // No second Opportunity, and the existing one untouched.
    const after = await dataProvider.getList("deals", {
      filter: {},
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    });
    expect(after.data).toHaveLength(before.data.length);
    expect(after.data[0]!.stage).toBe("call_booked");
  });

  it("is idempotent: once linked there is nothing left to resolve", async () => {
    await page.viewport(1280, 1200);
    const { element } = build({
      applications: [samantha({ opportunity_id: 268 } as Partial<Application>)],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Samantha Herold", { exact: false }).first())
      .toBeVisible();
    expect(screen.container.textContent).not.toContain(
      "Resolve sales conversation",
    );
    expect(screen.container.textContent).not.toContain(
      "No sales opportunity is linked",
    );
  });
});

describe("ambiguity", () => {
  it("shows both conversations and picks neither", async () => {
    await page.viewport(1280, 1200);
    const { element } = build({
      deals: [
        liveDeal(),
        liveDeal({ id: 269, created_at: "2026-09-15T00:00:00.000Z" }),
      ],
    });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: "Resolve sales conversation" })
      .click();
    await expect
      .element(
        screen.getByText("more than one live sales conversation", {
          exact: false,
        }),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText("Opportunity 268", { exact: false }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Opportunity 269", { exact: false }))
      .toBeVisible();
  });
});

describe("what is not offered", () => {
  it("says nothing to resolve when the conversation is for another programme", async () => {
    await page.viewport(1280, 1200);
    const { element } = build({ deals: [liveDeal({ offer_id: 1 })] });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Samantha Herold", { exact: false }).first())
      .toBeVisible();
    expect(screen.container.textContent).not.toContain(
      "Resolve sales conversation",
    );
  });
});
