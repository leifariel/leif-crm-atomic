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
// Three phases, and a home for each. Committed and unscheduled now share
// Starting Later — one question about one of these people did not deserve
// two headings — so what this file holds the page to is that the person
// with the open question is VISIBLE, FIRST, and still has the button that
// answers it. First matters more than it sounds: the section shows three
// rows and hides the rest, so sorting an unscheduled client after six
// committed ones would lose them again behind "N more".

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
    "Upcoming Openings",
    "People Deciding",
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

// Where a client row takes you.
//
// From Clients, a row opens /enrollments/:id/show — the client container,
// with start and end dates, payment state, onboarding and sessions. From
// Programs -> The Living Example the SAME person opened /contacts/:id/show
// instead, because PersonCard falls back to the Contact when given no
// destination and this page never gave one. One person, two pages,
// depending on which list Leif happened to click them from.
//
// The invariant: presented as a client, opens the client profile.
describe("where a client row goes", () => {
  // MemoryRouter renders plain paths; the real app is hash-routed and
  // React Router writes the "#" itself. The destination is what matters.
  const CANONICAL = (id: number) => `/enrollments/${id}/show`;

  const rowLinks = (screen: { container: HTMLElement }) =>
    [...screen.container.querySelectorAll("a[href]")].map((a) =>
      (a as HTMLAnchorElement).getAttribute("href"),
    );

  it("opens the client profile from Current Clients", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: /^Starting Later/ }))
      .toBeVisible();

    await expect
      .element(screen.getByRole("link", { name: "Nadia Okoro" }))
      .toHaveAttribute("href", `${CANONICAL(1)}`);
  });

  it("opens the client profile from Starting Later", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: /^Starting Later/ }))
      .toBeVisible();

    await expect
      .element(screen.getByRole("link", { name: "Pete Bassett" }))
      .toHaveAttribute("href", `${CANONICAL(2)}`);
  });

  it("opens the client profile from a client who has no week yet", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: /^Starting Later/ }))
      .toBeVisible();

    await expect
      .element(screen.getByRole("link", { name: "Unscheduled Commitment" }))
      .toHaveAttribute("href", `${CANONICAL(3)}`);
  });

  it("never routes a client row at the generic Contact page", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: /^Starting Later/ }))
      .toBeVisible();

    const links = rowLinks(screen);
    expect(links.filter((href) => href?.includes("/contacts/"))).toEqual([]);
    // And all three clients are reachable.
    for (const id of [1, 2, 3]) {
      expect(links).toContain(CANONICAL(id));
    }
  });

  it("sets the start week without navigating anywhere", async () => {
    // The button lives inside the row, and the row is a link. Nesting a
    // button in an anchor would navigate on every click of it; the
    // stretched-link layout is what keeps the two apart.
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: /^Starting Later/ }))
      .toBeVisible();

    const before = window.location.hash;
    await screen
      .getByRole("button", { name: "Set start week" })
      .first()
      .click();

    // The editor opened, over the page it was opened from.
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect.element(screen.getByText("Edit client")).toBeVisible();
    expect(window.location.hash).toBe(before);
    // Still the programme page underneath.
    expect(screen.container.textContent).toContain("Current Clients");
  });
});

describe("the programme page's client sections", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a client with no start week a row, not a footnote", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);

    await expect
      .element(screen.getByRole("heading", { name: /^Current Clients/ }))
      .toBeVisible();

    // The regression: before this repair the only mention of them was one
    // sentence under the openings forecast.
    const body = screen.container.textContent ?? "";
    expect(sectionOf(body, "Unscheduled Commitment")).toBe("Starting Later");
    expect(sectionOf(body, "Nadia Okoro")).toBe("Current Clients");
    expect(sectionOf(body, "Pete Bassett")).toBe("Starting Later");

    // And they come first inside it, where the collapsed preview can
    // always reach them.
    expect(body.indexOf("Unscheduled Commitment")).toBeLessThan(
      body.indexOf("Pete Bassett"),
    );
  });

  it("puts that section with the other client sections, above the forecast", async () => {
    // Buried under Upcoming Openings is where Leif could not find him.
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: /^Starting Later/ }))
      .toBeVisible();

    const body = screen.container.textContent ?? "";
    expect(body.indexOf("Starting Later")).toBeGreaterThan(
      body.indexOf("Current Clients"),
    );
    expect(body.indexOf("Starting Later")).toBeLessThan(
      body.indexOf("Upcoming Openings"),
    );
  });

  it("names each person exactly once across the client sections", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByRole("heading", { name: /^Starting Later/ }))
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
      .element(screen.getByRole("heading", { name: /^Starting Later/ }))
      .toBeVisible();

    await expect
      .element(screen.getByText("Start week not set").first())
      .toBeVisible();
    // Flagged at a glance, so it reads as an open question rather than a
    // row that happens to be missing a date.
    await expect
      .element(screen.getByText("Needs start week").first())
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
      .element(screen.getByRole("heading", { name: /^Starting Later/ }))
      .toBeVisible();

    const body = screen.container.textContent ?? "";
    // One current client out of twelve. The unscheduled commitment is on
    // the page and still consumes no dated slot.
    expect(body).toContain("1 / 12 active");
    expect(body).not.toContain("2 / 12 active");
    expect(body).toContain("1 starting later");
  });
});
