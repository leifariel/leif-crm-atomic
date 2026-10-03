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
import type { Deal, Enrollment, Offer } from "@/components/atomic-crm/types";

// A Start Week is Leif's decision. The CRM may ask for it, show that it is
// missing, and take his answer — it may never work one out. These cover the
// two places the question now appears: on the client's own page while it is
// unanswered, and in the edit modal that answers it.

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

const buildCrm = ({
  startDate = null,
  startDateSource = null,
  status = "active",
  offerId = 1,
  route = "/enrollments/7/show",
}: {
  startDate?: string | null;
  startDateSource?: string | null;
  status?: string;
  offerId?: number;
  route?: string;
} = {}) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 3, first_name: "Nadia", last_name: "Okoro" }),
      ],
      offers: [LE, GYU],
      deals: [
        {
          id: 5,
          contact_id: 3,
          offer_id: offerId,
          name: "Nadia Okoro",
          stage: "won",
          offer_name_snapshot:
            offerId === 1 ? "The Living Example" : "Growing Yourself Up",
          offer_price_snapshot: 4000,
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z",
        } as unknown as Deal,
      ],
      enrollments: [
        {
          id: 7,
          opportunity_id: 5,
          status,
          onboarding_tracking: "tracked",
          start_date: startDate,
          start_date_source: startDateSource,
          end_date: null,
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z",
        } as unknown as Enrollment,
      ],
      enrollment_onboarding_items: [],
      tasks: [],
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

describe("a client with no start week", () => {
  it("says so on their page, and says what it costs", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);

    await expect.element(screen.getByText("Start week not set")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          "They aren't counted in The Living Example openings until you set the week they start, so those numbers may look more open than they really are.",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Set start week" }))
      .toBeVisible();
  });

  it("opens the edit modal over the page rather than navigating", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);

    await screen.getByRole("button", { name: "Set start week" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect.element(screen.getByText("Edit client")).toBeVisible();
    // Still the client's own page underneath.
    await expect
      .element(screen.getByText("Nadia Okoro", { exact: false }).first())
      .toBeVisible();
  });

  it("writes nothing when the modal is cancelled", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = buildCrm();
    const screen = await render(element);

    await screen.getByRole("button", { name: "Set start week" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await screen.getByRole("button", { name: "Cancel" }).click();

    const { data } = await dataProvider.getOne<Enrollment>("enrollments", {
      id: 7,
    });
    expect(data.start_date ?? null).toBeNull();
    expect(data.start_date_source ?? null).toBeNull();
  });
});

describe("a client whose start week is already Leif's own", () => {
  it("says nothing at all", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      startDate: "2026-10-05",
      startDateSource: "owner",
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Nadia Okoro", { exact: false }).first())
      .toBeVisible();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Start week not set");
    expect(text).not.toContain("Start week needs confirming");
  });
});

describe("a start week the CRM inferred", () => {
  it("asks for confirmation instead of pretending it is settled", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      startDate: "2026-10-05",
      startDateSource: "session_derived",
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Start week needs confirming"))
      .toBeVisible();
    await expect
      .element(
        screen.getByText("came from their first booked session", {
          exact: false,
        }),
      )
      .toBeVisible();
  });
});

describe("a group programme", () => {
  it("is never asked, because its round already published a start", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ offerId: 2 });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Nadia Okoro", { exact: false }).first())
      .toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("Start week not set");
  });
});

describe("a finished client", () => {
  it("is history, and is not asked either", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ status: "completed" });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Nadia Okoro", { exact: false }).first())
      .toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("Start week not set");
  });
});

describe("the edit route", () => {
  it("still renders the same form for a direct link", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ route: "/enrollments/7/edit" });
    const screen = await render(element);

    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect.element(screen.getByText("Edit client")).toBeVisible();
  });
});
