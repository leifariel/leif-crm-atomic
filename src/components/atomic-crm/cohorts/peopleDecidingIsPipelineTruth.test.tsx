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
import type { Application, Cohort, Deal, Offer } from "../types";

// An approved application is not a decision.
//
// THE PRODUCTION BUG. A round's page listed everybody whose Opportunity was
// not yet Won under "People Deciding" — Interested, Application Received,
// Approved and Call Booked included. So the moment Leif approved an
// application, that applicant appeared as though they were sitting on an
// offer, while the Pipeline and the Dashboard both said they were at
// Approved and had not been asked anything yet.
//
// The cause was a second definition of Decision. The page derived the
// section from classifyCohortOpportunity's "in_sales" bucket, which answers
// a capacity question ("is this Opportunity still being sold for this
// round") and is correct for that. Deciding has its own authority and
// already did: deals/peopleDeciding.ts — a live Opportunity at the Decision
// stage — which the Pipeline's Decision column and the Dashboard both use
// after the same two-definitions bug was fixed between THEM.
//
// Written against the real page, not the helper, because the bug was in
// which authority the page asked rather than in what either authority said.

const COHORT = 21;
const OTHER_COHORT = 22;
const AT = "2026-01-01T00:00:00.000Z";

const GYU: Offer = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 1400,
  is_active: true,
  created_at: AT,
  updated_at: AT,
} as Offer;

const cohort = (id: number, name: string) =>
  ({
    id,
    offer_id: 2,
    name,
    status: "applications_open",
    program_start_at: "2026-09-22",
    program_end_at: null,
    duration_value: 8,
    duration_unit: "weeks",
    maximum_capacity: 10,
    created_at: AT,
    updated_at: AT,
  }) as unknown as Cohort;

/**
 * One applicant: a Contact, an Application with its own status, and the
 * Opportunity the sales pipeline actually moves.
 *
 * The two statuses are deliberately independent here, because that is the
 * whole point — an application can be Approved while the Opportunity has
 * gone nowhere, which is precisely the state the page got wrong.
 */
type Person = {
  id: number;
  name: string;
  applicationStatus: string;
  stage: string;
  cohortId?: number;
  outcome?: string | null;
};

const PEOPLE: Person[] = [
  // A — approved application, Opportunity still at Approved.
  {
    id: 1,
    name: "Approved Applicant",
    applicationStatus: "approved",
    stage: "approved",
  },
  // B — approved application, Opportunity has reached Decision.
  {
    id: 2,
    name: "Deciding Applicant",
    applicationStatus: "approved",
    stage: "decision",
  },
  // C — application received, nothing decided.
  {
    id: 3,
    name: "Received Applicant",
    applicationStatus: "pending",
    stage: "application_received",
  },
  // D — Decision stage, but in a different round. Must not leak.
  {
    id: 4,
    name: "Other Round Decider",
    applicationStatus: "approved",
    stage: "decision",
    cohortId: OTHER_COHORT,
  },
  // E — reached Decision and then lost it. No longer live, no longer
  // deciding: the authority's own "active" half, exercised here.
  {
    id: 5,
    name: "Closed Decider",
    applicationStatus: "approved",
    stage: "decision",
    outcome: "lost",
  },
  // F — a second live decider, so the section's order can be checked.
  {
    id: 6,
    name: "Another Decider",
    applicationStatus: "approved",
    stage: "decision",
  },
];

const buildCrm = () => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: PEOPLE.map((person) =>
        buildContact({
          id: person.id,
          first_name: person.name.split(" ")[0]!,
          last_name: person.name.split(" ").slice(1).join(" "),
        }),
      ),
      offers: [GYU],
      cohorts: [
        cohort(COHORT, "Fall 2026"),
        cohort(OTHER_COHORT, "Winter 2027"),
      ],
      deals: PEOPLE.map(
        (person) =>
          ({
            id: person.id,
            contact_id: person.id,
            offer_id: 2,
            cohort_id: person.cohortId ?? COHORT,
            name: person.name,
            stage: person.stage,
            outcome: person.outcome ?? null,
            archived_at: null,
            offer_name_snapshot: "Growing Yourself Up",
            offer_price_snapshot: 1400,
            amount: 1400,
            index: 0,
            sales_id: 0,
            created_at: AT,
            updated_at: AT,
          }) as unknown as Deal,
      ),
      enrollments: [],
      applications: PEOPLE.map(
        (person) =>
          ({
            id: 100 + person.id,
            contact_id: person.id,
            opportunity_id: person.id,
            offer_id: 2,
            intended_cohort_id: person.cohortId ?? COHORT,
            status: person.applicationStatus,
            source: "public_form",
            submitted_at: `2026-02-0${person.id}T09:00:00.000Z`,
            created_at: AT,
            updated_at: AT,
          }) as unknown as Application,
      ),
      waitlist_entries: [],
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return (
    <MemoryRouter initialEntries={[`/cohorts/${COHORT}/show`]}>
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

/**
 * The text of one section, from its heading to the next one.
 *
 * Both sections name the same people, so "is this name on the page" cannot
 * tell them apart — which is exactly the confusion being tested.
 */
const sectionText = (body: string, heading: string, nextHeading: string) => {
  const from = body.indexOf(heading);
  const to = body.indexOf(nextHeading, from + 1);
  expect(from, `section "${heading}" is on the page`).toBeGreaterThan(-1);
  expect(to, `section "${nextHeading}" follows it`).toBeGreaterThan(from);
  return body.slice(from, to);
};

const openRound = async () => {
  await page.viewport(1280, 1600);
  const screen = await render(buildCrm());
  await expect
    .element(screen.getByRole("heading", { name: /^People Deciding · / }))
    .toBeVisible();
  // Everything, so a name cannot be missing merely because it is behind a
  // preview's "N more".
  for (const label of ["People Deciding", "Applications"]) {
    const heading = screen.getByRole("heading", {
      name: new RegExp(`^${label} · `),
    });
    await expect.element(heading).toBeVisible();
  }
  for (const more of await screen
    .getByRole("button", { name: /^\d+ more$/ })
    .elements()) {
    (more as HTMLButtonElement).click();
  }
  return screen;
};

describe("People Deciding on a round's page", () => {
  it("counts only the Opportunities the pipeline has at Decision", async () => {
    const screen = await openRound();
    const body = screen.container.ownerDocument.body.textContent ?? "";
    const deciding = sectionText(body, "People Deciding", "Applications");

    // B and F are at Decision in THIS round. Nobody else is.
    expect(deciding).toContain("Deciding Applicant");
    expect(deciding).toContain("Another Decider");
    // THE BUG: an approved application is not a decision.
    expect(deciding).not.toContain("Approved Applicant");
    expect(deciding).not.toContain("Received Applicant");
    // Nor is a decision somebody already closed.
    expect(deciding).not.toContain("Closed Decider");
    // Nor another round's.
    expect(deciding).not.toContain("Other Round Decider");

    await expect
      .element(screen.getByRole("heading", { name: "People Deciding · 2" }))
      .toBeVisible();
  });

  it("leaves the application history alone", async () => {
    // Applications is the round's application record, with each one's own
    // truthful status. Moving somebody into People Deciding must not take
    // their application off the page, and approving one must not take it
    // off either.
    const screen = await openRound();
    const body = screen.container.ownerDocument.body.textContent ?? "";
    const applications = sectionText(body, "Applications", "Waitlist");

    expect(applications).toContain("Approved Applicant");
    expect(applications).toContain("Deciding Applicant");
    expect(applications).toContain("Received Applicant");
    expect(applications).toContain("Closed Decider");
    // And it still says what each one actually is.
    expect(applications).toContain("Approved");
    expect(applications).toContain("Pending");
    // This round's applications only.
    expect(applications).not.toContain("Other Round Decider");
  });

  it("sits where a round's page says it sits", async () => {
    // Product IA, not incidental render order: clients, then who is
    // deciding, then the applications behind them, then who is waiting,
    // then the round's own dates.
    const screen = await openRound();
    const body = screen.container.ownerDocument.body.textContent ?? "";
    const at = (heading: string) => {
      const index = body.indexOf(heading);
      expect(index, `"${heading}" is on the page`).toBeGreaterThan(-1);
      return index;
    };
    // Matched on the counted headings — the sidebar has an
    // "Applications" link of its own, and plain text would find that
    // first and call the page out of order.
    const order = [
      "Enrolled Clients · ",
      "People Deciding · ",
      "Applications · ",
      "Waitlist · ",
      "Cohort Details",
    ].map(at);
    expect(
      order.every((index, i) => i === 0 || index > order[i - 1]!),
      `sections out of order: ${order.join(", ")}`,
    ).toBe(true);
  });

  it("orders the deciders the same way every time", async () => {
    const screen = await openRound();
    const body = screen.container.ownerDocument.body.textContent ?? "";
    const deciding = sectionText(body, "People Deciding", "Applications");
    // By name, like every other person list on this page.
    expect(deciding.indexOf("Another Decider")).toBeLessThan(
      deciding.indexOf("Deciding Applicant"),
    );
  });
});
