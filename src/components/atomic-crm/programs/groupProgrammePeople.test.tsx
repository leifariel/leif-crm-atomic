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
import type {
  Application,
  Cohort,
  Deal,
  Enrollment,
  Offer,
  WaitlistEntry,
} from "../types";

// A group programme outlives any one of its rounds.
//
// "Who is in Growing Yourself Up", "who is deciding about it", "who has
// applied" are questions about the PROGRAMME, and until now each had to be
// asked of every round in turn. The programme's page answers them.
//
// Two scope mistakes are possible here and both are tested: showing
// somebody from another PROGRAMME (The Living Example has its own
// deciders), and showing somebody twice because a person can be reached
// through more than one join. The third — turning the programme page into
// a copy of one round — is tested from the other side, by asserting the
// round's page stayed narrow.
//
// The meanings are not re-derived. People Deciding is isPersonDeciding, a
// client is an active Enrollment, and an application is an application.

const AT = "2026-01-01T00:00:00.000Z";
const GYU_ID = 2;
const LE_ID = 1;
const SPRING = 301;
const AUTUMN = 302;

const offer = (id: number, name: string, type: string): Offer =>
  ({
    id,
    name,
    type,
    duration: "8 weeks",
    current_price: 1400,
    max_active_clients: 12,
    is_active: true,
    created_at: AT,
    updated_at: AT,
  }) as Offer;

const cohort = (id: number, name: string): Cohort =>
  ({
    id,
    offer_id: GYU_ID,
    name,
    status: "applications_open",
    program_start_at: id === SPRING ? "2027-03-01" : "2027-09-01",
    program_end_at: null,
    duration_value: 8,
    duration_unit: "weeks",
    maximum_capacity: 12,
    created_at: AT,
    updated_at: AT,
  }) as unknown as Cohort;

type Seeded = {
  id: number;
  name: string;
  offerId: number;
  cohortId: number | null;
  stage: string;
  /** Present when this person is a client. */
  enrolled?: boolean;
  /** Present when this person applied. */
  applicationStatus?: string;
  /** An applicant who never became a sales Opportunity. */
  noOpportunity?: boolean;
};

const PEOPLE: Seeded[] = [
  {
    id: 1,
    name: "Spring Client",
    offerId: GYU_ID,
    cohortId: SPRING,
    stage: "won",
    enrolled: true,
  },
  {
    id: 2,
    name: "Autumn Client",
    offerId: GYU_ID,
    cohortId: AUTUMN,
    stage: "won",
    enrolled: true,
  },
  {
    id: 3,
    name: "Spring Approved",
    offerId: GYU_ID,
    cohortId: SPRING,
    stage: "approved",
    applicationStatus: "approved",
  },
  {
    id: 4,
    name: "Autumn Decider",
    offerId: GYU_ID,
    cohortId: AUTUMN,
    stage: "decision",
    applicationStatus: "approved",
  },
  {
    id: 5,
    name: "Autumn Received",
    offerId: GYU_ID,
    cohortId: AUTUMN,
    stage: "application_received",
    applicationStatus: "pending",
  },
  // Applied and never entered the pipeline. Real, and the reason
  // Applications is its own section rather than a view of Opportunities.
  {
    id: 7,
    name: "Spring Hopeful",
    offerId: GYU_ID,
    cohortId: SPRING,
    stage: "application_received",
    applicationStatus: "pending",
    noOpportunity: true,
  },
  {
    id: 8,
    name: "Autumn Hopeful",
    offerId: GYU_ID,
    cohortId: AUTUMN,
    stage: "application_received",
    applicationStatus: "pending",
    noOpportunity: true,
  },
  // THE CROSS-OFFER CONTROL. A live Decision-stage Opportunity, for the
  // other programme entirely.
  {
    id: 6,
    name: "Example Decider",
    offerId: LE_ID,
    cohortId: null,
    stage: "decision",
  },
];

const buildCrm = (route: string) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        ...PEOPLE.map((person) =>
          buildContact({
            id: person.id,
            first_name: person.name.split(" ")[0]!,
            last_name: person.name.split(" ").slice(1).join(" "),
          }),
        ),
        buildContact({ id: 50, first_name: "General", last_name: "Waiter" }),
        buildContact({ id: 51, first_name: "Spring", last_name: "Waiter" }),
      ],
      offers: [
        offer(LE_ID, "The Living Example", "individual"),
        offer(GYU_ID, "Growing Yourself Up", "group"),
      ],
      cohorts: [
        cohort(SPRING, "Growing Yourself Up — Spring 2027"),
        cohort(AUTUMN, "Growing Yourself Up — Autumn 2027"),
      ],
      deals: PEOPLE.filter((person) => !person.noOpportunity).map(
        (person) =>
          ({
            id: person.id,
            contact_id: person.id,
            offer_id: person.offerId,
            cohort_id: person.cohortId,
            name: person.name,
            stage: person.stage,
            outcome: null,
            archived_at: null,
            offer_name_snapshot: "x",
            offer_price_snapshot: 1400,
            amount: 1400,
            index: 0,
            sales_id: 0,
            created_at: AT,
            updated_at: AT,
          }) as unknown as Deal,
      ),
      enrollments: PEOPLE.filter((person) => person.enrolled).map(
        (person) =>
          ({
            id: 100 + person.id,
            opportunity_id: person.id,
            status: "active",
            onboarding_tracking: "tracked",
            start_date: "2027-03-01",
            start_date_source: "owner",
            end_date: null,
            created_at: AT,
            updated_at: AT,
          }) as unknown as Enrollment,
      ),
      applications: PEOPLE.filter((person) => person.applicationStatus).map(
        (person) =>
          ({
            id: 200 + person.id,
            contact_id: person.id,
            opportunity_id: person.noOpportunity ? null : person.id,
            offer_id: person.offerId,
            intended_cohort_id: person.cohortId,
            status: person.applicationStatus,
            source: "public_form",
            submitted_at: `2026-0${person.id}-01T09:00:00.000Z`,
            created_at: AT,
            updated_at: AT,
          }) as unknown as Application,
      ),
      waitlist_entries: [
        // No round in mind…
        {
          id: 400,
          contact_id: 50,
          offer_id: GYU_ID,
          cohort_id: null,
          status: "waiting",
          source: "manual",
          joined_at: "2026-02-01T09:00:00.000Z",
          created_at: AT,
          updated_at: AT,
        },
        // …and one waiting for a particular round.
        {
          id: 401,
          contact_id: 51,
          offer_id: GYU_ID,
          cohort_id: SPRING,
          status: "waiting",
          source: "manual",
          joined_at: "2026-02-02T09:00:00.000Z",
          created_at: AT,
          updated_at: AT,
        },
      ] as unknown as WaitlistEntry[],
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return (
    <MemoryRouter initialEntries={[route]}>
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

const openProgramme = async () => {
  await page.viewport(1280, 1600);
  const screen = await render(buildCrm(`/programs/group/${GYU_ID}`));
  await expect
    .element(screen.getByRole("heading", { name: /^Clients · / }))
    .toBeVisible();
  return screen;
};

/** The text of one section, from its heading to the next. */
const sectionText = (body: string, heading: string, next: string) => {
  const from = body.indexOf(heading);
  const to = body.indexOf(next, from + 1);
  expect(from, `"${heading}" is on the page`).toBeGreaterThan(-1);
  expect(to, `"${next}" follows it`).toBeGreaterThan(from);
  return body.slice(from, to);
};

const occurrences = (body: string, name: string) => body.split(name).length - 1;

describe("a group programme's own page", () => {
  it("lists the programme's clients, across its rounds", async () => {
    const screen = await openProgramme();
    const body = screen.container.ownerDocument.body.textContent ?? "";
    const clients = sectionText(body, "Clients · ", "People Deciding · ");

    expect(clients).toContain("Spring Client");
    expect(clients).toContain("Autumn Client");
    // Each with the round that disambiguates them, and the programme's own
    // name stripped back out of it.
    expect(clients).toContain("Spring 2027");
    expect(clients).toContain("Autumn 2027");
    expect(clients).not.toContain("Growing Yourself Up — Spring 2027");

    await expect
      .element(screen.getByRole("heading", { name: "Clients · 2" }))
      .toBeVisible();
    // Once each. A client is reachable through their Opportunity and
    // through their Enrollment, and only one of those is a row.
    expect(occurrences(clients, "Spring Client")).toBe(1);
    expect(occurrences(clients, "Autumn Client")).toBe(1);
  });

  it("counts as deciding only a live Decision-stage Opportunity for THIS programme", async () => {
    const screen = await openProgramme();
    const body = screen.container.ownerDocument.body.textContent ?? "";
    const deciding = sectionText(body, "People Deciding · ", "Applications · ");

    expect(deciding).toContain("Autumn Decider");
    // An approved application is not a decision.
    expect(deciding).not.toContain("Spring Approved");
    expect(deciding).not.toContain("Autumn Received");
    // AND NOT THE OTHER PROGRAMME'S. This person is at Decision, live, and
    // belongs to The Living Example.
    expect(deciding).not.toContain("Example Decider");

    await expect
      .element(screen.getByRole("heading", { name: "People Deciding · 1" }))
      .toBeVisible();
  });

  it("keeps every application, with the status it actually has", async () => {
    const screen = await openProgramme();
    // Five of them, so the section is collapsed — opened the way Leif
    // opens it, because the claim is about all five.
    await screen.getByRole("button", { name: "2 more" }).click();
    const body = screen.container.ownerDocument.body.textContent ?? "";
    const applications = sectionText(body, "Applications · ", "Waitlist · ");

    // Including the one whose Opportunity has since reached Decision:
    // history is added to, never moved.
    expect(applications).toContain("Spring Approved");
    expect(applications).toContain("Autumn Decider");
    expect(applications).toContain("Autumn Received");
    expect(applications).toContain("Approved");
    expect(applications).toContain("Pending");
    // Named by round, and counted once each — an application that both
    // names this programme and intends one of its rounds comes back from
    // two queries and is still one application.
    expect(applications).toContain("Spring 2027");
    expect(occurrences(applications, "Autumn Decider")).toBe(1);
    // An applicant who never entered the pipeline is still an applicant.
    expect(applications).toContain("Spring Hopeful");

    await expect
      .element(screen.getByRole("heading", { name: "Applications · 5" }))
      .toBeVisible();
  });

  it("collapses like every other section, and opens in place", async () => {
    const screen = await openProgramme();
    const rows = () =>
      [...screen.container.ownerDocument.querySelectorAll("a[href]")].filter(
        (anchor) =>
          /\/applications\/\d+\/show$/.test(anchor.getAttribute("href") ?? ""),
      ).length;

    // Five applications, three rows: the shared preview limit, not a
    // number this page chose for itself.
    expect(rows()).toBe(3);
    await screen.getByRole("button", { name: "2 more" }).click();
    expect(rows()).toBe(5);
    // Still the programme's page, with the sections below it.
    await expect
      .element(screen.getByRole("heading", { name: /^Waitlist · / }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Show less" }).click();
    expect(rows()).toBe(3);
  });

  it("shows everyone waiting for the programme, round or no round", async () => {
    const screen = await openProgramme();
    const body = screen.container.ownerDocument.body.textContent ?? "";
    const waiting = sectionText(body, "Waitlist · ", "Cohorts · ");

    expect(waiting).toContain("General Waiter");
    expect(waiting).toContain("Spring Waiter");
    // The one with a round in mind says so; the one without does not
    // acquire one.
    expect(occurrences(waiting, "Spring 2027")).toBe(1);
    expect(occurrences(waiting, "General Waiter")).toBe(1);

    await expect
      .element(screen.getByRole("heading", { name: "Waitlist · 2" }))
      .toBeVisible();
  });

  it("reads in the order Leif asked for", async () => {
    const screen = await openProgramme();
    const body = screen.container.ownerDocument.body.textContent ?? "";
    const at = (heading: string) => {
      const index = body.indexOf(heading);
      expect(index, `"${heading}" is on the page`).toBeGreaterThan(-1);
      return index;
    };
    const order = [
      "Clients · ",
      "People Deciding · ",
      "Applications · ",
      "Waitlist · ",
      "Cohorts · ",
    ].map(at);
    expect(
      order.every((index, i) => i === 0 || index > order[i - 1]!),
      `sections out of order: ${order.join(", ")}`,
    ).toBe(true);
  });

  it("leaves a round's own page scoped to that round", async () => {
    // The programme page must not be one round's page widened, and the
    // round's page must not become the programme's.
    await page.viewport(1280, 1600);
    const screen = await render(buildCrm(`/cohorts/${SPRING}/show`));
    await expect
      .element(screen.getByRole("heading", { name: /^Applications · / }))
      .toBeVisible();
    const body = screen.container.ownerDocument.body.textContent ?? "";

    // Spring's people only.
    expect(body).toContain("Spring Client");
    expect(body).not.toContain("Autumn Client");
    expect(body).not.toContain("Autumn Decider");
    expect(body).not.toContain("Autumn Received");
    expect(body).not.toContain("Example Decider");
    // Spring's waiting list, not the programme's: the person with no round
    // in mind is not waiting for Spring.
    expect(body).toContain("Spring Waiter");
    expect(body).not.toContain("General Waiter");
  });
});
