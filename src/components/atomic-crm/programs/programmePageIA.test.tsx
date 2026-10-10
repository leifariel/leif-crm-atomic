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

// What a 1:1 programme page says, and in what order.
//
// The order is product IA, not render order that happened: Leif reads this
// page top to bottom and the sequence is who is here now, who is coming,
// when the next room frees up, who is deciding, and who is waiting.
//
// "People Deciding" is new to this page and means exactly what it means
// everywhere else — deals/peopleDeciding.ts, a live Opportunity at the
// Decision stage. A round's page had derived it from "not Won yet"
// instead, which put approved applicants in it; this one is built on the
// shared authority from the start, and this file holds it there.

const NOW = new Date("2026-09-21T12:00:00Z");
const AT = "2026-01-01T00:00:00.000Z";

const livingExample: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  max_active_clients: 12,
  is_active: true,
  created_at: AT,
  updated_at: AT,
};

const CALENDAR_WEEKS: [string, string][] = Array.from(
  { length: 80 },
  (_, i) => {
    const start = new Date("2026-06-01T00:00:00Z");
    start.setUTCDate(start.getUTCDate() + i * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 5);
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
  },
);

// Two clients, so Current Clients and Starting Later both exist…
const CLIENTS = [
  { id: 1, name: "Current Client", start: "2026-08-03" },
  { id: 2, name: "Later Client", start: "2026-11-09" },
];

// …and four prospects, only ONE of whom is deciding anything.
const PROSPECTS = [
  { id: 11, name: "Approved Prospect", stage: "approved" },
  { id: 12, name: "Booked Prospect", stage: "call_booked" },
  { id: 13, name: "Received Prospect", stage: "application_received" },
  { id: 14, name: "Deciding Prospect", stage: "decision" },
];

const deal = (id: number, name: string, stage: string): Deal =>
  ({
    id,
    contact_id: id,
    offer_id: 1,
    name,
    stage,
    outcome: null,
    archived_at: null,
    offer_name_snapshot: "The Living Example",
    offer_price_snapshot: 4000,
    amount: 4000,
    index: 0,
    sales_id: 0,
    created_at: AT,
    updated_at: AT,
  }) as unknown as Deal;

const buildCrm = ({ anyoneDeciding = true } = {}) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [...CLIENTS, ...PROSPECTS].map((person) =>
        buildContact({
          id: person.id,
          first_name: person.name.split(" ")[0]!,
          last_name: person.name.split(" ").slice(1).join(" "),
        }),
      ),
      offers: [livingExample],
      deals: [
        ...CLIENTS.map((client) => deal(client.id, client.name, "won")),
        ...PROSPECTS.map((p) =>
          deal(
            p.id,
            p.name,
            // The same people, with the one decider moved back a step —
            // which is the only difference between a section with somebody
            // in it and a section that has to say so.
            !anyoneDeciding && p.stage === "decision" ? "call_booked" : p.stage,
          ),
        ),
      ],
      enrollments: CLIENTS.map(
        (client) =>
          ({
            id: client.id,
            opportunity_id: client.id,
            status: "active",
            onboarding_tracking: "tracked",
            start_date: client.start,
            start_date_source: "owner",
            end_date: null,
            created_at: AT,
            updated_at: AT,
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
        created_at: AT,
        updated_at: "2026-09-20T00:00:00.000Z",
      })),
      client_session_cadence_issues: [],
      waitlist_entries: [],
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return (
    <MemoryRouter initialEntries={["/programs/individual/1"]}>
      <CRM
        dataProvider={dataProvider}
        authProvider={createTestAuthProvider()}
        i18nProvider={testI18nProvider}
        store={memoryStore()}
        disableTelemetry
      />
    </MemoryRouter>
  );
};

const openProgramme = async (options?: { anyoneDeciding: boolean }) => {
  await page.viewport(1280, 1600);
  const screen = await render(buildCrm(options));
  await expect
    .element(screen.getByRole("heading", { name: /^People Deciding · / }))
    .toBeVisible();
  return screen;
};

describe("the 1:1 programme page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads in the order Leif works through it", async () => {
    const screen = await openProgramme();
    const body = screen.container.textContent ?? "";

    const at = (heading: string) => {
      const index = body.indexOf(heading);
      expect(index, `"${heading}" is on the page`).toBeGreaterThan(-1);
      return index;
    };
    // Counted headings, so a navigation link with the same word cannot
    // answer for a section.
    const order = [
      "Current Clients · ",
      "Starting Later · ",
      "Upcoming Openings · ",
      "People Deciding · ",
      "Waitlist · ",
    ].map(at);
    expect(
      order.every((index, i) => i === 0 || index > order[i - 1]!),
      `sections out of order: ${order.join(", ")}`,
    ).toBe(true);
  });

  it("counts as deciding only the Opportunity the pipeline has at Decision", async () => {
    const screen = await openProgramme();
    const body = screen.container.textContent ?? "";
    const deciding = body.slice(
      body.indexOf("People Deciding"),
      body.indexOf("Waitlist"),
    );

    expect(deciding).toContain("Deciding Prospect");
    // Everyone else is somewhere in the pipeline and has decided nothing.
    expect(deciding).not.toContain("Approved Prospect");
    expect(deciding).not.toContain("Booked Prospect");
    expect(deciding).not.toContain("Received Prospect");
    // And a client is not a prospect.
    expect(deciding).not.toContain("Current Client");

    await expect
      .element(screen.getByRole("heading", { name: "People Deciding · 1" }))
      .toBeVisible();
  });

  it("says so plainly when nobody is deciding", async () => {
    // The empty state is the honest answer, not an absent section: "is
    // anybody deciding" is a question Leif asks of this page, and "no" is
    // an answer to it.
    const screen = await openProgramme({ anyoneDeciding: false });
    await expect
      .element(screen.getByRole("heading", { name: "People Deciding · 0" }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Nobody is currently deciding."))
      .toBeVisible();
    // The person who moved back a step is not quietly still listed.
    const body = screen.container.textContent ?? "";
    expect(
      body.slice(body.indexOf("People Deciding"), body.indexOf("Waitlist")),
    ).not.toContain("Deciding Prospect");
  });
});
