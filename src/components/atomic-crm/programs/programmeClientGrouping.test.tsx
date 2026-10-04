import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
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
import type { Deal, Enrollment, Offer } from "../types";

// Every enrolled client has a home on this page.
//
// Giving a commitment with no start week its own capacity phase was right
// — it consumes no dated slot — but it took those people off the page. The
// sections were Current Clients (occupied) and Starting Later (committed),
// so an unscheduled client appeared in NEITHER. Leif found Todd Jacobsen
// in production reduced to one sentence of grey footnote text under the
// openings forecast, with no row to click and no way through to set his
// start week. The arithmetic was correct and the page had lost a client.
//
// Three phases, three sections, and nobody in between.

const NOW = new Date("2026-09-21T12:00:00Z");

const livingExample: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  max_active_clients: 12,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

// Weekly `1:1s` weeks around the pinned clock, long enough that no end is
// "incomplete" for want of calendar.
const CALENDAR_WEEKS: [string, string][] = Array.from(
  { length: 80 },
  (_, i) => {
    const start = new Date("2026-06-01T00:00:00Z");
    start.setUTCDate(start.getUTCDate() + i * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 5);
    return [
      start.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10),
    ] as [string, string];
  },
);

type Person = {
  id: number;
  first: string;
  last: string;
  start: string | null;
  status: Enrollment["status"];
};

// One of each phase, which is the whole point.
const PEOPLE: Person[] = [
  {
    id: 1,
    first: "Nadia",
    last: "Okoro",
    start: "2026-08-03",
    status: "active",
  },
  {
    id: 2,
    first: "Pete",
    last: "Bassett",
    start: "2026-11-09",
    status: "active",
  },
  // The Todd shape: Won, enrolled, onboarding, and nobody has said when.
  {
    id: 3,
    first: "Unscheduled",
    last: "Commitment",
    start: null,
    status: "onboarding",
  },
];

const buildCrm = (route = "/programs/individual/1") => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: PEOPLE.map((p) =>
        buildContact({ id: p.id, first_name: p.first, last_name: p.last }),
      ),
      offers: [livingExample],
      deals: PEOPLE.map(
        (p) =>
          ({
            id: p.id,
            contact_id: p.id,
            offer_id: 1,
            name: `${p.first} ${p.last}`,
            stage: "won",
            offer_name_snapshot: "The Living Example",
            offer_price_snapshot: 4000,
            amount: 4000,
            index: 0,
            sales_id: 0,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          }) as unknown as Deal,
      ),
      enrollments: PEOPLE.map(
        (p) =>
          ({
            id: p.id,
            opportunity_id: p.id,
            status: p.status,
            onboarding_tracking: "tracked",
            start_date: p.start,
            start_date_source: p.start ? "owner" : null,
            end_date: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          }) as unknown as Enrollment,
      ),
      expected_session_windows: CALENDAR_WEEKS.map(([start, end], i) => ({
        id: i + 1,
        offer_id: 1,
        external_calendar_id: "year-tracking",
        external_event_id: `week-${i + 1}`,
        raw_title: "1:1s",
        window_start: start,
        window_end: end,
        deleted_at: null,
        synced_at: "2026-09-20T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-09-20T00:00:00.000Z",
      })),
      client_session_cadence_issues: [],
      waitlist_entries: [],
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
        />
      </MemoryRouter>
    ),
  };
};

// Which section a name is rendered under, by reading the page in order.
const sectionOf = (body: string, name: string): string | null => {
  const headings = [
    "Current Clients",
    "Starting Later",
    "Needs Start Week",
    "Upcoming Openings",
    "Waitlist",
  ];
  const at = body.indexOf(name);
  if (at === -1) return null;
  let found: string | null = null;
  for (const heading of headings) {
    const h = body.indexOf(heading);
    if (h !== -1 && h < at) found = heading;
  }
  return found;
};

describe("the programme page's client sections", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a client with no start week their own section, not a footnote", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);

    await expect
      .element(screen.getByRole("heading", { name: "Current Clients" }))
      .toBeVisible();

    // The regression: before this repair the only mention of them was one
    // sentence under the openings forecast.
    await expect
      .element(screen.getByRole("heading", { name: "Needs Start Week" }))
      .toBeVisible();

    const body = screen.container.textContent ?? "";
    expect(sectionOf(body, "Unscheduled Commitment")).toBe("Needs Start Week");
    expect(sectionOf(body, "Nadia Okoro")).toBe("Current Clients");
    expect(sectionOf(body, "Pete Bassett")).toBe("Starting Later");
  });

  it("puts that section with the other client sections, above the forecast", async () => {
    // Buried under Upcoming Openings is where Leif could not find him.
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: "Needs Start Week" }))
      .toBeVisible();

    const body = screen.container.textContent ?? "";
    expect(body.indexOf("Needs Start Week")).toBeGreaterThan(
      body.indexOf("Current Clients"),
    );
    expect(body.indexOf("Needs Start Week")).toBeLessThan(
      body.indexOf("Upcoming Openings"),
    );
  });

  it("names each person exactly once across the three sections", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: "Needs Start Week" }))
      .toBeVisible();

    const body = screen.container.textContent ?? "";
    for (const name of [
      "Nadia Okoro",
      "Pete Bassett",
      "Unscheduled Commitment",
    ]) {
      expect(body.split(name).length - 1).toBe(1);
    }
  });

  it("says what the row needs, and offers the action that sets it", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: "Needs Start Week" }))
      .toBeVisible();

    await expect
      .element(screen.getByText("Start week not set").first())
      .toBeVisible();
    // Actionable from here, not only from somewhere else.
    await expect
      .element(screen.getByRole("button", { name: "Set start week" }).first())
      .toBeVisible();
  });

  it("keeps the arithmetic it was built to protect", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: "Needs Start Week" }))
      .toBeVisible();

    const body = screen.container.textContent ?? "";
    // One current client out of twelve. The unscheduled commitment is on
    // the page and still consumes no dated slot.
    expect(body).toContain("1 / 12 active");
    expect(body).not.toContain("2 / 12 active");
    expect(body).toContain("1 starting later");
  });
});
