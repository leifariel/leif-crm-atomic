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
import type { Deal, Enrollment, Offer } from "../types";

// ONE PROGRAMME = ONE CLEARLY BOUNDED CONTAINER.
//
// Every group used to render its own Card, so The Living Example was three
// separate boxes with a floating heading above them and Past drifting below
// the previous box — reading as a fourth thing on the page rather than as
// that programme's history.
//
// These assertions fail against that layout: the card count was one per
// GROUP rather than one per programme, and Past was a sibling of the
// programme rather than a section inside it.
//
// Structure only. Geometry is proven against the real built CSS in
// e2e/informationArchitecture.spec.ts, because the vitest browser project has
// no Tailwind plugin and would measure the user agent instead.

const leOffer: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  max_active_clients: 6,
  is_active: true,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const gyuOffer: Offer = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 1400,
  is_active: true,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const deal = (id: number, contactId: number, offerId: number): Deal => ({
  id,
  name: `Client ${id}`,
  contact_id: contactId,
  offer_id: offerId,
  stage: "won",
  outcome: null,
  amount: 1400,
  sales_id: 0,
  index: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  stage_entered_at: "2026-01-01T00:00:00.000Z",
});

const enrollment = (id: number, status: Enrollment["status"]): Enrollment => ({
  id,
  opportunity_id: id,
  onboarding_tracking: "tracked" as const,
  status,
  start_date: "2026-01-05",
  end_date: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const buildPage = () => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 10, first_name: "Past", last_name: "OneToOne" }),
        buildContact({ id: 11, first_name: "Current", last_name: "OneToOne" }),
        buildContact({ id: 12, first_name: "Group", last_name: "Member" }),
      ],
      offers: [leOffer, gyuOffer],
      deals: [deal(10, 10, 1), deal(11, 11, 1), deal(12, 12, 2)],
      enrollments: [
        // A completed 1:1 client, so The Living Example has a Past group as
        // well as a current one — the two-box case this regrouping fixes.
        enrollment(10, "completed"),
        enrollment(11, "active"),
        enrollment(12, "active"),
      ],
      enrollment_onboarding_items: [],
    }),
    silent: true,
  });

  return (
    <MemoryRouter initialEntries={["/enrollments"]}>
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
  );
};

const programmes = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>(
    '[data-testid="client-programme"]',
  ),
];

const groups = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="client-group"]'),
];

describe("Clients information architecture", () => {
  it("names each programme once, as a container", async () => {
    await page.viewport(1280, 900);
    const screen = await render(buildPage());
    await expect
      .element(screen.getByText("The Living Example").first())
      .toBeInTheDocument();

    const names = programmes(screen.container).map((p) =>
      p.getAttribute("data-programme"),
    );
    expect(names).toContain("The Living Example");
    expect(names).toContain("Growing Yourself Up");
    // Named once each: no programme gets two containers.
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps every group inside its programme, Past included", async () => {
    await page.viewport(1280, 900);
    const screen = await render(buildPage());
    await expect
      .element(screen.getByText("The Living Example").first())
      .toBeInTheDocument();

    const all = programmes(screen.container);
    // No group floats outside a programme container.
    for (const group of groups(screen.container)) {
      expect(
        all.some((p) => p.contains(group)),
        `group ${group.getAttribute("data-group")} is inside a programme`,
      ).toBe(true);
    }

    const le = all.find(
      (p) => p.getAttribute("data-programme") === "The Living Example",
    );
    expect(le, "one Living Example container").toBeTruthy();

    // Past specifically: it used to be a separate box BELOW the programme.
    // "Past Clients" is what the translation resolves to; the component
    // default is "Past".
    const past = groups(screen.container).find((g) =>
      /^Past/.test(g.getAttribute("data-group") ?? ""),
    );
    expect(past, "the Past group exists").toBeTruthy();
    expect(le!.contains(past!), "Past sits inside the programme").toBe(true);
  });

  it("uses internal dividers rather than a card per group", async () => {
    // THE assertion that fails against the old layout: the only Cards on the
    // page are the programme containers themselves.
    await page.viewport(1280, 900);
    const screen = await render(buildPage());
    await expect
      .element(screen.getByText("The Living Example").first())
      .toBeInTheDocument();

    const cards = [...screen.container.querySelectorAll('[data-slot="card"]')];
    const all = programmes(screen.container);
    expect(all.length).toBeGreaterThan(1);
    expect(cards).toHaveLength(all.length);
    for (const card of cards) {
      expect(card.getAttribute("data-testid")).toBe("client-programme");
    }
  });

  it("still routes every row to its Enrollment", async () => {
    // Grouping is presentation; the destination is not.
    await page.viewport(1280, 900);
    const screen = await render(buildPage());
    await expect
      .element(screen.getByText("The Living Example").first())
      .toBeInTheDocument();

    const hrefs = [
      ...screen.container.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h.includes("/enrollments/"));

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toMatch(/\/enrollments\/\d+\/show$/);
    }
  });
});
