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
  Offer,
  SalesCall,
  Task,
} from "@/components/atomic-crm/types";

// Matching a booking is a bounded question asked from the page Leif is already
// on. Clicking it on the Dashboard must open it over the Dashboard, not take
// the Dashboard away — while /sales-calls/:id/resolve keeps working for a
// direct link or a reload, rendering the same component.

const leOffer: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "6 months",
  current_price: 4000,
  is_active: true,
  acuity_appointment_type_id: "99001",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const buildSalesCall = (overrides: Partial<SalesCall> = {}): SalesCall =>
  ({
    id: 1,
    opportunity_id: null,
    contact_id: 1,
    status: "booked",
    original_scheduled_at: "2026-09-10T18:00:00.000Z",
    scheduled_at: "2026-09-10T18:00:00.000Z",
    scheduled_on: "2026-09-10",
    schedule_precision: "exact",
    reschedule_count: 0,
    source: "acuity",
    acuity_appointment_id: "acuity-1",
    acuity_appointment_type_id: "99001",
    dismissed_at: null,
    dismissal_reason: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as SalesCall;

const matchingTask: Task = {
  id: 500,
  contact_id: 1,
  type: "sales_call_needs_matching",
  text: "Ada Lovelace · The Living Example · Sep 10, 2026, 12:00 PM",
  due_date: "2026-09-10T00:00:00.000Z",
  status: "pending",
  done_date: null,
  sales_call_id: 1,
  sales_id: 0,
} as unknown as Task;

const buildCrm = ({
  route,
  salesCall = buildSalesCall(),
  deals = [],
  tasks = [],
}: {
  route: string;
  salesCall?: SalesCall;
  deals?: Deal[];
  tasks?: Task[];
}) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 1, first_name: "Ada", last_name: "Lovelace" }),
      ],
      offers: [leOffer],
      cohorts: [],
      deals,
      sales_calls: [salesCall],
      sales_call_events: [],
      tasks,
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

describe("matching a booking from a Task row", () => {
  it("opens over the page instead of navigating away", async () => {
    await page.viewport(1280, 900);
    const { element } = buildCrm({
      route: "/contacts/1/show",
      tasks: [matchingTask],
    });
    const screen = await render(element);

    // The Contact page, with the Task on it.
    await expect
      .element(screen.getByText("Ada Lovelace", { exact: false }).first())
      .toBeVisible();
    const row = screen
      .getByRole("button", { name: /The Living Example/ })
      .first();
    await row.click();

    // The resolution workflow, in a dialog.
    const dialog = screen.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect
      .element(screen.getByText("No matching opportunity found"))
      .toBeVisible();

    // And the page underneath is still the page: this is a lightbox, not a
    // destination. The Contact's own heading is still mounted behind it.
    await expect
      .element(screen.getByText("Ada Lovelace", { exact: false }).first())
      .toBeVisible();
  });

  it("is a button, not a link, so nothing can navigate on click", async () => {
    await page.viewport(1280, 900);
    const { element } = buildCrm({
      route: "/contacts/1/show",
      tasks: [matchingTask],
    });
    const screen = await render(element);

    await expect
      .element(
        screen.getByRole("button", { name: /The Living Example/ }).first(),
      )
      .toBeVisible();
    expect(
      screen.container.querySelector('a[href="/sales-calls/1/resolve"]'),
    ).toBeNull();
  });
});

describe("the route still exists for a direct link or a reload", () => {
  it("renders the same workflow at /sales-calls/:id/resolve", async () => {
    await page.viewport(1280, 900);
    const { element } = buildCrm({ route: "/sales-calls/1/resolve" });
    const screen = await render(element);

    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect
      .element(screen.getByText("Sales call needs matching"))
      .toBeVisible();
    await expect
      .element(screen.getByText("No matching opportunity found"))
      .toBeVisible();
  });

  it("renders an already-attached booking cleanly, rather than an empty page", async () => {
    await page.viewport(1280, 900);
    const { element } = buildCrm({
      route: "/sales-calls/1/resolve",
      salesCall: buildSalesCall({ opportunity_id: 10 }),
      deals: [
        {
          id: 10,
          name: "Ada Lovelace — The Living Example",
          contact_id: 1,
          offer_id: 1,
          offer_name_snapshot: "The Living Example",
          stage: "call_booked",
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        } as unknown as Deal,
      ],
    });
    const screen = await render(element);

    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect
      .element(
        screen.getByText("This booking is already attached to an Opportunity."),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "View the Opportunity" }))
      .toHaveAttribute("href", "/deals/10/show");
  });
});

describe("automatic matching stays automatic", () => {
  it("shows no Task and no dialog when a booking matched on its own", async () => {
    await page.viewport(1280, 900);
    // An attached booking never had a matching Task created for it, and the
    // database closes any that existed the moment opportunity_id is set.
    const { element } = buildCrm({
      route: "/contacts/1/show",
      salesCall: buildSalesCall({ opportunity_id: 10 }),
      deals: [
        {
          id: 10,
          name: "Ada Lovelace — The Living Example",
          contact_id: 1,
          offer_id: 1,
          offer_name_snapshot: "The Living Example",
          stage: "call_booked",
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        } as unknown as Deal,
      ],
      tasks: [],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Ada Lovelace", { exact: false }).first())
      .toBeVisible();
    expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
  });
});
