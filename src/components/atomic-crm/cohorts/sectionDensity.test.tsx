import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { localStorageStore, memoryStore, type Store } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import { PREVIEW_LIMIT } from "../misc/PreviewList";
import type {
  Application,
  Cohort,
  Deal,
  Enrollment,
  Offer,
  WaitlistEntry,
} from "../types";

// A round's page says how many, and shows a few.
//
// Leif opens a Growing Yourself Up round to answer one question — usually
// "who still needs something from me" — and the page used to render every
// row of every section on the way there: eleven clients, then everybody
// deciding, then every application the round has ever received, then the
// waitlist. The Cohort Details he scrolled for sat under all of it.
//
// So each section states its SIZE in its heading and shows the first few
// rows. The count is the part that matters: a collapsed list that doesn't
// say what it is hiding is worse than a long one.
//
// Written against the real Cohort page with volumes big enough that the
// collapse actually happens — a fixture of three would pass against the
// old unbounded page and prove nothing.

const COHORT_ID = 77;
const AT = "2026-01-01T00:00:00.000Z";

// Chosen so every section hides a DIFFERENT number of rows, which is what
// makes each disclosure control identifiable by its own name.
const ENROLLED = 11; // "8 more"
const DECIDING = 3; // exactly the preview limit, so it never collapses
const APPLICATIONS = 20; // "17 more"
const WAITING = 12; // "9 more"

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

const cohort = {
  id: COHORT_ID,
  offer_id: 2,
  name: "Fall 2026",
  status: "applications_open",
  program_start_at: "2026-09-22",
  program_end_at: null,
  duration_value: 8,
  duration_unit: "weeks",
  maximum_capacity: 20,
  created_at: AT,
  updated_at: AT,
} as unknown as Cohort;

// Ids are laid out in blocks so a failure message says which population a
// row came from.
const ENROLLED_BASE = 1000;
const DECIDING_BASE = 2000;
const APPLICANT_BASE = 3000;
const WAITING_BASE = 4000;

const range = (count: number) => Array.from({ length: count }, (_, i) => i);

const buildCrm = () => {
  const contacts = [
    ...range(ENROLLED).map((i) =>
      buildContact({
        id: ENROLLED_BASE + i,
        first_name: "Client",
        last_name: `No${String(i).padStart(2, "0")}`,
      }),
    ),
    ...range(DECIDING).map((i) =>
      buildContact({
        id: DECIDING_BASE + i,
        first_name: "Deciding",
        last_name: `No${String(i).padStart(2, "0")}`,
      }),
    ),
    ...range(APPLICATIONS).map((i) =>
      buildContact({
        id: APPLICANT_BASE + i,
        first_name: "Applicant",
        last_name: `No${String(i).padStart(2, "0")}`,
      }),
    ),
    ...range(WAITING).map((i) =>
      buildContact({
        id: WAITING_BASE + i,
        first_name: "Waiting",
        last_name: `No${String(i).padStart(2, "0")}`,
      }),
    ),
  ];

  const deal = (id: number, contactId: number, stage: string) =>
    ({
      id,
      contact_id: contactId,
      offer_id: 2,
      cohort_id: COHORT_ID,
      name: `Deal ${id}`,
      stage,
      offer_name_snapshot: "Growing Yourself Up",
      offer_price_snapshot: 1400,
      amount: 1400,
      index: 0,
      sales_id: 0,
      created_at: AT,
      updated_at: AT,
    }) as unknown as Deal;

  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts,
      offers: [GYU],
      cohorts: [cohort],
      deals: [
        ...range(ENROLLED).map((i) =>
          deal(ENROLLED_BASE + i, ENROLLED_BASE + i, "won"),
        ),
        // Decision stage: People Deciding is the Pipeline's Decision
        // column, scoped to this round (see peopleDecidingIsPipelineTruth).
        ...range(DECIDING).map((i) =>
          deal(DECIDING_BASE + i, DECIDING_BASE + i, "decision"),
        ),
      ],
      enrollments: range(ENROLLED).map(
        (i) =>
          ({
            id: ENROLLED_BASE + i,
            opportunity_id: ENROLLED_BASE + i,
            status: "active",
            onboarding_tracking: "tracked",
            start_date: "2026-09-22",
            start_date_source: "owner",
            end_date: null,
            created_at: AT,
            updated_at: AT,
          }) as unknown as Enrollment,
      ),
      // Applicants with no Opportunity: the legitimate population that only
      // intended_cohort_id can place on this page.
      applications: range(APPLICATIONS).map(
        (i) =>
          ({
            id: APPLICANT_BASE + i,
            contact_id: APPLICANT_BASE + i,
            opportunity_id: null,
            offer_id: 2,
            intended_cohort_id: COHORT_ID,
            status: "submitted",
            submitted_at: `2026-0${1 + (i % 9)}-0${1 + (i % 9)}T09:00:00.000Z`,
            created_at: AT,
            updated_at: AT,
          }) as unknown as Application,
      ),
      waitlist_entries: range(WAITING).map(
        (i) =>
          ({
            id: WAITING_BASE + i,
            contact_id: WAITING_BASE + i,
            offer_id: 2,
            cohort_id: COHORT_ID,
            status: "waiting",
            source: "manual",
            joined_at: `2026-02-${String(1 + i).padStart(2, "0")}T09:00:00.000Z`,
            created_at: AT,
            updated_at: AT,
          }) as unknown as WaitlistEntry,
      ),
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

  // The store is the caller's, so a test can render the page twice against
  // the same remembered state — which is what a refresh is.
  const element = (store: Store) => (
    <MemoryRouter initialEntries={[`/cohorts/${COHORT_ID}/show`]}>
      <CRM
        dataProvider={dataProvider}
        authProvider={createTestAuthProvider()}
        i18nProvider={testI18nProvider}
        store={store}
        disableTelemetry
      />
    </MemoryRouter>
  );

  return { dataProvider, element };
};

const rowsLinkingTo = (screen: { container: HTMLElement }, prefix: string) =>
  [...screen.container.ownerDocument.querySelectorAll("a[href]")]
    .map((anchor) => anchor.getAttribute("href") ?? "")
    .filter((href) => href.startsWith(prefix));

const openPage = async (store = memoryStore()) => {
  await page.viewport(1280, 1200);
  const { element } = buildCrm();
  const screen = await render(element(store));
  await expect
    .element(screen.getByRole("heading", { name: /^Applications · / }))
    .toBeVisible();
  return { screen, store };
};

// The real app's store is localStorage-backed (root/CRM.tsx), which is what
// makes an expanded section survive a reload. memoryStore throws its
// contents away on unmount, so the reload test uses a persistent store of
// its own — under its own app key, cleared between tests, so nothing leaks
// into another test's run.
const PERSISTENT_KEY = "DENSITY_TEST";

describe("a long section on a round's page", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("states its size in its own heading", async () => {
    const { screen } = await openPage();

    // Every section, including the one short enough never to collapse —
    // the count is how Leif reads the round, not a side effect of hiding
    // rows.
    await expect
      .element(screen.getByRole("heading", { name: "Enrolled Clients · 11" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("heading", { name: "People Deciding · 3" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("heading", { name: "Applications · 20" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("heading", { name: "Waitlist · 12" }))
      .toBeVisible();
  });

  it("shows the preview rows only, and says how many it is holding back", async () => {
    const { screen } = await openPage();

    // Twenty applications, three rows. This is the assertion that fails
    // if anybody restores unbounded rendering.
    expect(rowsLinkingTo(screen, "/applications/")).toHaveLength(PREVIEW_LIMIT);
    expect(rowsLinkingTo(screen, "/enrollments/")).toHaveLength(PREVIEW_LIMIT);
    await expect
      .element(screen.getByRole("button", { name: "17 more" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "8 more" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "9 more" }))
      .toBeVisible();
  });

  it("opens in place when Leif asks for the rest", async () => {
    const { screen } = await openPage();

    await screen.getByRole("button", { name: "17 more" }).click();

    expect(rowsLinkingTo(screen, "/applications/")).toHaveLength(APPLICATIONS);
    // Still the same page, with its heading and the sections below it.
    await expect
      .element(screen.getByRole("heading", { name: "Fall 2026" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("heading", { name: "Waitlist · 12" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Show less" }))
      .toBeVisible();
  });

  it("closes again, so the page can be made short", async () => {
    const { screen } = await openPage();

    await screen.getByRole("button", { name: "17 more" }).click();
    await screen.getByRole("button", { name: "Show less" }).click();

    expect(rowsLinkingTo(screen, "/applications/")).toHaveLength(PREVIEW_LIMIT);
    await expect
      .element(screen.getByRole("button", { name: "17 more" }))
      .toBeVisible();
  });

  it("opens one section without opening the others", async () => {
    const { screen } = await openPage();

    await screen.getByRole("button", { name: "17 more" }).click();

    expect(rowsLinkingTo(screen, "/applications/")).toHaveLength(APPLICATIONS);
    // Enrolled Clients is untouched: three of eleven, still offering its
    // own eight.
    expect(rowsLinkingTo(screen, "/enrollments/")).toHaveLength(PREVIEW_LIMIT);
    await expect
      .element(screen.getByRole("button", { name: "8 more" }))
      .toBeVisible();
  });

  it("stays open across a reload", async () => {
    // What Leif actually does between two reads of a section: refreshes,
    // or opens a lightbox and closes it. Either one remounts the page, and
    // a section that collapsed every time would make the expansion useless
    // — so the state lives in the admin store, not in the component.
    const { screen, store } = await openPage(
      localStorageStore(undefined, PERSISTENT_KEY),
    );
    await screen.getByRole("button", { name: "17 more" }).click();
    expect(rowsLinkingTo(screen, "/applications/")).toHaveLength(APPLICATIONS);
    screen.unmount();

    const { element } = buildCrm();
    const reopened = await render(element(store));
    await expect
      .element(reopened.getByRole("heading", { name: "Applications · 20" }))
      .toBeVisible();
    expect(rowsLinkingTo(reopened, "/applications/")).toHaveLength(
      APPLICATIONS,
    );
  });
});
