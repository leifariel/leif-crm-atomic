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
import type { Application, Cohort, Deal, Offer } from "../types";

// What the review area says, and what it refuses to say.
//
// The button NAMES the destination — "Offer Growing Yourself Up" — because
// "Offer the other programme" would make Leif hover to find out what she is
// about to recommend. And the page prints what they applied for beside what
// was decided, because once the Opportunity reads Growing Yourself Up the page
// would otherwise look as though the application itself had changed programme.
//
// Bespoke is one menu with two endings. There is deliberately no third
// control, and no "bespoke" state to be left sitting in.

const AT = "2026-09-01T00:00:00.000Z";

const LE = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "6 months",
  current_price: 4500,
  is_active: true,
  created_at: AT,
  updated_at: AT,
} as Offer;

const GYU = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 1400,
  is_active: true,
  created_at: AT,
  updated_at: AT,
} as Offer;

const LEGACY = {
  id: 3,
  name: "1:1 Coaching (Legacy)",
  type: "individual",
  duration: "Varies (historical)",
  current_price: 0,
  is_active: false,
  created_at: AT,
  updated_at: AT,
} as Offer;

const FALL = {
  id: 4,
  offer_id: 2,
  name: "Growing Yourself Up — Fall 2026",
  status: "applications_open" as const,
  created_at: AT,
  updated_at: AT,
} as unknown as Cohort;

const deal = (over: Partial<Deal> = {}): Deal =>
  ({
    id: 70,
    name: "Robin Avery",
    contact_id: 5,
    offer_id: 1,
    cohort_id: null,
    stage: "application_received",
    outcome: null,
    amount: 4500,
    index: 0,
    sales_id: 0,
    created_at: AT,
    updated_at: AT,
    stage_entered_at: AT,
    archived_at: null,
    ...over,
  }) as unknown as Deal;

const application = (over: Partial<Application> = {}): Application =>
  ({
    id: 70,
    contact_id: 5,
    opportunity_id: 70,
    offer_id: 1,
    intended_cohort_id: null,
    status: "pending",
    source: "public_form",
    raw_answers: { le_main_pattern: "The same argument, over and over." },
    submitted_at: AT,
    reviewed_at: null,
    crm_adopted_at: null,
    created_at: AT,
    updated_at: AT,
    ...over,
  }) as unknown as Application;

const build = ({
  offers = [LE, GYU, LEGACY],
  applications = [application()],
  deals = [deal()],
  cohorts = [FALL],
}: {
  offers?: Offer[];
  applications?: Application[];
  deals?: Deal[];
  cohorts?: Cohort[];
} = {}) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 5, first_name: "Robin", last_name: "Avery" }),
      ],
      offers,
      cohorts,
      deals,
      applications,
      kit_tag_mappings: [],
      kit_sync_operations: [],
      tasks: [],
      deal_offer_events: [],
      enrollments: [],
      enrollment_onboarding_items: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return {
    dataProvider,
    element: (
      <MemoryRouter initialEntries={["/applications/70/show"]}>
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

const body = () => document.body.innerText.replace(/\s+/g, " ");

describe("the review area offers the two new decisions", () => {
  it("names the programme it would recommend, rather than making Leif find out", async () => {
    await page.viewport(1280, 1200);
    const { element } = build();
    const screen = await render(element);

    await expect
      .element(screen.getByRole("button", { name: "Approve" }))
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("button", { name: "Offer Growing Yourself Up" }),
      )
      .toBeVisible();
    // The retired programme is never a destination, so it is never named.
    expect(body()).not.toContain("1:1 Coaching (Legacy)");
  });

  it("says nothing about recommending when there is more than one other programme", async () => {
    await page.viewport(1280, 1200);
    const { element } = build({
      offers: [
        LE,
        GYU,
        { ...GYU, id: 5, name: "A Third Programme" } as Offer,
        LEGACY,
      ],
    });
    const screen = await render(element);

    // Still a reviewable application…
    await expect
      .element(screen.getByRole("button", { name: "Approve" }))
      .toBeVisible();
    // …and no recommendation offered, because which one is no longer obvious.
    expect(body()).not.toContain("Offer Growing Yourself Up");
    expect(body()).not.toContain("A Third Programme");
  });

  it("asks before it recommends, and says what will and will not change", async () => {
    await page.viewport(1280, 1200);
    const { element } = build();
    const screen = await render(element);

    await screen
      .getByRole("button", { name: "Offer Growing Yourself Up" })
      .click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const dialog = body();
    expect(dialog).toContain("still records the programme they applied for");
    expect(dialog).toContain("Growing Yourself Up");
    // "may send" — the CRM reads which event a tag is configured for, never
    // Kit's automation topology.
    expect(dialog).toContain("may send");
    // And the ROUND they would join, named, because Growing Yourself Up has
    // rounds and exactly one is taking people.
    expect(dialog).toContain("Growing Yourself Up — Fall 2026");
    expect(dialog).toContain("the only round still taking applications");
  });

  it("asks WHICH round when two are open, and offers no single confirm", async () => {
    await page.viewport(1280, 1200);
    const { element } = build({
      cohorts: [
        {
          ...FALL,
          id: 4,
          name: "Spring 2027",
          applications_close_at: "2027-06-30",
        } as unknown as Cohort,
        {
          ...FALL,
          id: 5,
          name: "Summer 2027",
          applications_close_at: "2027-09-30",
        } as unknown as Cohort,
      ],
    });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: "Offer Growing Yourself Up" })
      .click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const dialog = body();
    expect(dialog).toContain("Which round?");
    expect(dialog).toContain("Spring 2027");
    expect(dialog).toContain("Summer 2027");
    // One button per round, and no single "Offer Growing Yourself Up"
    // confirm, because confirming without choosing would be a guess.
    await expect
      .element(screen.getByRole("button", { name: "Offer this round" }).first())
      .toBeVisible();
    expect(
      await screen
        .getByRole("dialog")
        .getByRole("button", { name: "Offer Growing Yourself Up" })
        .elements().length,
    ).toBe(0);
  });

  it("records the round Leif picks", async () => {
    await page.viewport(1280, 1200);
    const { dataProvider, element } = build({
      cohorts: [
        {
          ...FALL,
          id: 4,
          name: "Spring 2027",
          applications_close_at: "2027-06-30",
        } as unknown as Cohort,
        {
          ...FALL,
          id: 5,
          name: "Summer 2027",
          applications_close_at: "2027-09-30",
        } as unknown as Cohort,
      ],
    });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: "Offer Growing Yourself Up" })
      .click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    // The second row: Summer 2027.
    await screen
      .getByRole("button", { name: "Offer this round" })
      .nth(1)
      .click();
    await expect
      .element(screen.getByText("Decision recorded.", { exact: false }))
      .toBeVisible();

    const { data: movedDeal } = await dataProvider.getOne<Deal>("deals", {
      id: 70,
    });
    expect(movedDeal.offer_id).toBe(2);
    expect(movedDeal.cohort_id).toBe(5);
  });

  it("says no round is open rather than offering a sale with none", async () => {
    await page.viewport(1280, 1200);
    const { dataProvider, element } = build({
      cohorts: [
        { ...FALL, status: "applications_closed" } as unknown as Cohort,
      ],
    });
    const screen = await render(element);

    await screen
      .getByRole("button", { name: "Offer Growing Yourself Up" })
      .click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    const dialog = body();
    expect(dialog).toContain("has no round open");
    expect(dialog).toContain("a client with no round and no start date");
    // Nothing to click but Cancel.
    expect(
      await screen
        .getByRole("dialog")
        .getByRole("button", { name: /^Offer/ })
        .elements().length,
    ).toBe(0);

    // And nothing was written.
    const { data: untouched } = await dataProvider.getOne<Application>(
      "applications",
      { id: 70 },
    );
    expect(untouched.status).toBe("pending");
  });

  it("offers bespoke as one menu with two endings, and no third state", async () => {
    await page.viewport(1280, 1200);
    const { element } = build();
    const screen = await render(element);

    await screen.getByRole("button", { name: "Bespoke response" }).click();
    await expect
      .element(screen.getByRole("menuitem", { name: "Bespoke Accepted" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("menuitem", { name: "Bespoke Denied" }))
      .toBeVisible();
  });

  it("records a bespoke acceptance straight away, with no email promised", async () => {
    await page.viewport(1280, 1200);
    const { dataProvider, element } = build();
    const screen = await render(element);

    await screen.getByRole("button", { name: "Bespoke response" }).click();
    await screen.getByRole("menuitem", { name: "Bespoke Accepted" }).click();

    // The status badge renders in the page header AND in the decision area,
    // which is the existing layout and not this test's business.
    await expect
      .element(screen.getByText("Bespoke Accepted", { exact: false }).first())
      .toBeVisible();

    const { data: saved } = await dataProvider.getOne<Application>(
      "applications",
      { id: 70 },
    );
    expect(saved.status).toBe("bespoke_accepted");
    expect(saved.reviewed_at).not.toBeNull();
    // Nothing anywhere says a reply went out.
    expect(body()).not.toContain("Email sent");
    expect(body()).not.toContain("email sent");
  });
});

describe("a recommended application says both programmes", () => {
  it("prints what they applied for beside what was decided", async () => {
    await page.viewport(1280, 1200);
    const { element } = build({
      applications: [
        application({
          status: "offered_other_programme",
          recommended_offer_id: 2,
          reviewed_at: "2026-09-02T00:00:00.000Z",
        }),
      ],
      // The sale has moved; the application has not.
      deals: [deal({ offer_id: 2, stage: "approved" })],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Applied for", { exact: false }))
      .toBeVisible();
    const text = body();
    expect(text).toContain("Applied for");
    expect(text).toContain("The Living Example");
    expect(text).toContain("Decision");
    expect(text).toContain("Offer Growing Yourself Up");
    // And the decision area no longer offers decisions.
    expect(text).toContain("Decision recorded.");
  });

  it("says nothing of the kind on an ordinary approval", async () => {
    await page.viewport(1280, 1200);
    const { element } = build({
      applications: [
        application({
          status: "approved",
          reviewed_at: "2026-09-02T00:00:00.000Z",
        }),
      ],
      deals: [deal({ stage: "approved" })],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Decision recorded.", { exact: false }))
      .toBeVisible();
    // One programme is in play and the heading already names it.
    expect(body()).not.toContain("Applied for");
  });
});
