import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import type { Cohort, Deal, Enrollment, Offer } from "../types";

// A group client is still a client.
//
// The invariant: presented in a client-management context, a person opens
// the canonical client/enrollment profile. The Contact page is not a
// substitute — it shows no start or end dates, no payment state, no
// onboarding and no sessions.
//
// Enrolled cohort rows were falling back to /contacts/:id/show, because
// PersonCard defaults there when given no destination. Shipping that
// invariant for the Living Example and not for Growing Yourself Up would
// have left the same person opening two different pages depending on which
// programme they were in.
//
// There is no guessing involved. A row in this list cannot exist without
// its Enrollment — useCohortPageData only pushes one once it has found it —
// and the database holds enrollments_opportunity_id_key unique
// (opportunity_id), so there is exactly one per Opportunity. The row links
// to the same Enrollment its status badge comes from.

const COHORT_ID = 11;
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

const cohort = {
  id: COHORT_ID,
  offer_id: 2,
  name: "Fall 2026",
  status: "scheduled",
  program_start_at: "2026-09-22",
  program_end_at: null,
  duration_value: 8,
  duration_unit: "weeks",
  maximum_capacity: 10,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as unknown as Cohort;

// One enrolled client, and one person still deciding — the second is NOT a
// client and correctly keeps the Contact page.
const ENROLLED = { dealId: 31, contactId: 41, enrollmentId: 51 };
const DECIDING = { dealId: 32, contactId: 42 };

const buildCrm = () => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({
          id: ENROLLED.contactId,
          first_name: "Group",
          last_name: "Client",
        }),
        buildContact({
          id: DECIDING.contactId,
          first_name: "Still",
          last_name: "Deciding",
        }),
      ],
      offers: [GYU],
      cohorts: [cohort],
      deals: [
        {
          id: ENROLLED.dealId,
          contact_id: ENROLLED.contactId,
          offer_id: 2,
          cohort_id: COHORT_ID,
          name: "Group Client",
          stage: "won",
          offer_name_snapshot: "Growing Yourself Up",
          offer_price_snapshot: 1400,
          amount: 1400,
          index: 0,
          sales_id: 0,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        } as unknown as Deal,
        {
          id: DECIDING.dealId,
          contact_id: DECIDING.contactId,
          offer_id: 2,
          cohort_id: COHORT_ID,
          name: "Still Deciding",
          stage: "application_received",
          offer_name_snapshot: "Growing Yourself Up",
          offer_price_snapshot: 1400,
          amount: 1400,
          index: 0,
          sales_id: 0,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        } as unknown as Deal,
      ],
      enrollments: [
        {
          id: ENROLLED.enrollmentId,
          opportunity_id: ENROLLED.dealId,
          status: "active",
          onboarding_tracking: "tracked",
          start_date: "2026-09-22",
          start_date_source: "owner",
          end_date: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        } as unknown as Enrollment,
      ],
      applications: [],
      waitlist_entries: [],
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return {
    dataProvider,
    element: (
      <MemoryRouter initialEntries={[`/cohorts/${COHORT_ID}/show`]}>
        <CRM
          dataProvider={dataProvider}
          authProvider={createTestAuthProvider()}
          i18nProvider={testI18nProvider}
          store={memoryStore()}
          disableTelemetry
        />
      </MemoryRouter>
    ),
  };
};

const hrefs = (screen: { container: HTMLElement }) =>
  [...screen.container.querySelectorAll("a[href]")].map((a) =>
    (a as HTMLAnchorElement).getAttribute("href"),
  );

describe("an enrolled cohort client", () => {
  it("opens the client profile, the same route the Clients page uses", async () => {
    await page.viewport(1280, 1200);
    const { element } = buildCrm();
    const screen = await render(element);

    await expect
      .element(screen.getByText("Group Client").first())
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Group Client" }))
      .toHaveAttribute("href", `/enrollments/${ENROLLED.enrollmentId}/show`);
  });

  it("never falls back to the generic Contact page", async () => {
    await page.viewport(1280, 1200);
    const { element } = buildCrm();
    const screen = await render(element);

    await expect
      .element(screen.getByText("Group Client").first())
      .toBeVisible();
    expect(hrefs(screen)).not.toContain(`/contacts/${ENROLLED.contactId}/show`);
  });

  it("links to the Enrollment its own status badge came from", async () => {
    // Not inferred from the contact, and not guessed: the row is built from
    // that Enrollment, and the database allows only one per Opportunity.
    await page.viewport(1280, 1200);
    const { element } = buildCrm();
    const screen = await render(element);

    await expect
      .element(screen.getByText("Group Client").first())
      .toBeVisible();
    const links = hrefs(screen).filter((href) =>
      href?.includes("/enrollments/"),
    );
    expect(links).toEqual([`/enrollments/${ENROLLED.enrollmentId}/show`]);
    await expect.element(screen.getByText("Active").first()).toBeVisible();
  });
});

describe("somebody who is not a client yet", () => {
  it("still opens their Contact page, because they have no client profile", async () => {
    // People Deciding are prospects. There is no Enrollment to open, and
    // inventing a destination would be worse than the Contact page.
    await page.viewport(1280, 1200);
    const { element } = buildCrm();
    const screen = await render(element);

    await expect
      .element(screen.getByText("Still Deciding").first())
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Still Deciding" }))
      .toHaveAttribute("href", `/contacts/${DECIDING.contactId}/show`);
  });
});
