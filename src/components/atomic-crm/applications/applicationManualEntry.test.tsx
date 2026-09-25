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
import type { Application, Cohort, Offer } from "../types";

// An Application Leif entered herself.
//
// Somebody asks in a DM, or on a call, or by replying to a newsletter.
// There was no way to record that: the only Applications the CRM could
// hold were ones the public form produced or the import brought in, and
// borrowing either of those names would have made the record lie about
// where it came from. `manual` is the third origin, and these pin what it
// has to do — start as her review work, create no sales process it has no
// business inventing, and stay correctable without a database.

const livingExample: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  max_active_clients: 12,
  is_active: true,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const growingYourselfUp: Offer = {
  ...livingExample,
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
};

// A second group programme exists purely so "the cohort list is scoped to
// the offer" can fail. With one group offer every cohort is the right
// cohort and the assertion proves nothing.
const otherGroupProgramme: Offer = {
  ...livingExample,
  id: 3,
  name: "Other Group Programme",
  type: "group",
};

const cohort = (over: Partial<Cohort> & Pick<Cohort, "id">): Cohort =>
  ({
    offer_id: 2,
    name: "January 2027 Cohort",
    status: "applications_open",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as Cohort;

const january = cohort({ id: 10 });
const elsewhere = cohort({
  id: 20,
  offer_id: 3,
  name: "Other Programme Cohort",
});

const ada = buildContact({
  id: 1,
  first_name: "Ada",
  last_name: "Lovelace",
  email_jsonb: [{ email: "ada@example.com", type: "Work" }],
});

const buildTestCrm = (
  initialEntries: string[],
  applications: Application[] = [],
  deals: Record<string, unknown>[] = [],
) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [ada],
      offers: [livingExample, growingYourselfUp, otherGroupProgramme],
      cohorts: [january, elsewhere],
      applications,
      deals,
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

  const element = (
    <MemoryRouter initialEntries={initialEntries}>
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

  return { element, dataProvider };
};

const listAll = async (
  dataProvider: ReturnType<typeof createDataProvider>,
  resource: string,
) =>
  dataProvider.getList(resource, {
    filter: {},
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });

const pickPerson = async (
  screen: Awaited<ReturnType<typeof render>>,
  name: string,
) => {
  await screen.getByText("Search by name or email…").click();
  await screen.getByPlaceholder("Search...").fill(name.split(" ")[0]);
  // Scoped to the suggestion list: the same person may already be named
  // on a row behind the dialog, and an unscoped match hits both.
  await page.getByRole("option", { name, exact: false }).first().click();
};

const pickChoice = async (
  screen: Awaited<ReturnType<typeof render>>,
  field: string,
  option: string,
) => {
  await screen.getByRole("combobox", { name: field }).click();
  await screen.getByRole("option", { name: option }).click();
};

// An imported-shaped record: no Opportunity behind it. This is the shape
// that used to render the review page blank, and the reason Show must not
// require a Deal even now that manual Applications always get one.
const opportunitylessApplication: Application = {
  id: 500,
  contact_id: 1,
  opportunity_id: null,
  offer_id: 1,
  intended_cohort_id: null,
  status: "pending",
  submitted_at: "2026-09-24T09:00:00.000Z",
  reviewed_at: null,
  raw_answers: {},
  source: "manual",
  created_at: "2026-09-24T09:00:00.000Z",
  updated_at: "2026-09-24T09:00:00.000Z",
} as Application;

// The same person, already waiting on her behind a live Opportunity.
const pendingApplicationOnLiveSale: Application = {
  ...opportunitylessApplication,
  id: 501,
  opportunity_id: 900,
} as Application;

describe("creating an Application by hand", () => {
  it("offers the action from the Applications page", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm(["/applications"]);
    const screen = await render(element);

    await expect
      .element(screen.getByRole("button", { name: "New Application" }))
      .toBeVisible();
  });

  it("records one Application for the 1:1 programme, and nothing else", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/applications"]);
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "The Living Example");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => (await listAll(dataProvider, "applications")).total)
      .toBe(1);

    const [saved] = (await listAll(dataProvider, "applications")).data;
    expect(saved.source).toBe("manual");
    expect(saved.status).toBe("pending");
    expect(saved.reviewed_at).toBeNull();
    expect(String(saved.contact_id)).toBe("1");
    expect(String(saved.offer_id)).toBe("1");
    // The rolling programme has no cohort, and one is never invented.
    expect(saved.intended_cohort_id ?? null).toBeNull();
    // It carries no questionnaire, because nobody filled one in.
    expect(saved.raw_answers).toEqual({});
  });

  it("establishes the canonical Application Received Opportunity with it", async () => {
    // A current-funnel Application is not a standalone record. The
    // pipeline's first stage IS Application Received, and every review
    // outcome writes to the Application AND its Opportunity together — so
    // an Application without one looks like review work and cannot be
    // worked. Creating it alone is what this replaced.
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/applications"]);
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "The Living Example");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => (await listAll(dataProvider, "applications")).total)
      .toBe(1);

    // Exactly one, not one per click and not one per programme.
    const deals = await listAll(dataProvider, "deals");
    expect(deals.total).toBe(1);

    const [opportunity] = deals.data;
    expect(opportunity.stage).toBe("application_received");
    expect(opportunity.outcome ?? null).toBeNull();
    expect(String(opportunity.contact_id)).toBe("1");
    expect(String(opportunity.offer_id)).toBe("1");
    expect(opportunity.cohort_id ?? null).toBeNull();
    // Never 'application_form' — no public form produced this, and saying
    // it did is the exact lie source='manual' exists to avoid.
    expect(opportunity.entry_path).not.toBe("application_form");

    const [saved] = (await listAll(dataProvider, "applications")).data;
    expect(String(saved.opportunity_id)).toBe(String(opportunity.id));
  });

  it("invents no sales call, payment or enrollment along the way", async () => {
    // The Opportunity exists because the review workflow needs one. That
    // is the whole claim: nobody has met, paid, or started.
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/applications"]);
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "The Living Example");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => (await listAll(dataProvider, "applications")).total)
      .toBe(1);

    expect((await listAll(dataProvider, "sales_calls")).total).toBe(0);
    expect((await listAll(dataProvider, "enrollments")).total).toBe(0);
    expect(
      (await listAll(dataProvider, "deal_payment_schedule_items")).total,
    ).toBe(0);
  });

  it("reuses the live Opportunity rather than opening a second sale beside it", async () => {
    // One active sales attempt per person per programme — the same rule,
    // via the same canonical predicate, the public form uses.
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(
      ["/applications"],
      [],
      [
        {
          id: 900,
          contact_id: 1,
          offer_id: 1,
          cohort_id: null,
          stage: "interested",
          outcome: null,
          archived_at: null,
          name: "Ada Lovelace",
        },
      ],
    );
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "The Living Example");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => (await listAll(dataProvider, "applications")).total)
      .toBe(1);

    expect((await listAll(dataProvider, "deals")).total).toBe(1);
    const [saved] = (await listAll(dataProvider, "applications")).data;
    expect(String(saved.opportunity_id)).toBe("900");
    // A sale already further along does not visually regress to
    // Application Received.
    const { data: deal } = await dataProvider.getOne("deals", { id: 900 });
    expect(deal.stage).toBe("interested");
  });

  it("refuses a second application for a sale already waiting on her", async () => {
    // Two pending Applications against one live sale would be two claims
    // on the same decision. Surfaced, never silently duplicated or merged.
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(
      ["/applications"],
      [pendingApplicationOnLiveSale],
      [
        {
          id: 900,
          contact_id: 1,
          offer_id: 1,
          cohort_id: null,
          stage: "application_received",
          outcome: null,
          archived_at: null,
          name: "Ada Lovelace",
        },
      ],
    );
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "The Living Example");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .element(screen.getByText(/already has an application waiting for you/i))
      .toBeInTheDocument();

    expect((await listAll(dataProvider, "applications")).total).toBe(1);
    expect((await listAll(dataProvider, "deals")).total).toBe(1);
  });

  it("puts it straight into that programme's Needs Review", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm(["/applications"]);
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "The Living Example");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect.element(screen.getByText("Ada Lovelace")).toBeInTheDocument();

    const section = [...screen.container.querySelectorAll("section")].find(
      (el) =>
        [...el.querySelectorAll("h2")].some(
          (h) => h.textContent === "The Living Example",
        ),
    );
    expect(section?.textContent).toContain("Needs Review");
    expect(section?.textContent).toContain("Ada Lovelace");
  });

  it("will not file a cohort programme application without saying which run", async () => {
    // "Growing Yourself Up, some cohort" is not a fact the page can act
    // on — there would be no section it truthfully belongs in.
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/applications"]);
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "Growing Yourself Up");

    await expect
      .element(screen.getByRole("combobox", { name: "Cohort" }))
      .toBeVisible();

    await screen.getByRole("button", { name: /^save$/i }).click();
    await expect
      .element(screen.getByText(/required/i).first())
      .toBeInTheDocument();

    expect((await listAll(dataProvider, "applications")).total).toBe(0);
  });

  it("never offers a cohort belonging to a different programme", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm(["/applications"]);
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "Growing Yourself Up");
    await screen.getByRole("combobox", { name: "Cohort" }).click();

    await expect
      .element(screen.getByRole("option", { name: "January 2027 Cohort" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("option", { name: "Other Programme Cohort" }))
      .not.toBeInTheDocument();
  });

  it("saves a cohort programme application against the run that was chosen", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/applications"]);
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "Growing Yourself Up");
    await pickChoice(screen, "Cohort", "January 2027 Cohort");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => (await listAll(dataProvider, "applications")).total)
      .toBe(1);

    const [saved] = (await listAll(dataProvider, "applications")).data;
    expect(String(saved.offer_id)).toBe("2");
    expect(String(saved.intended_cohort_id)).toBe("10");
    expect(saved.source).toBe("manual");
  });

  it("drops the cohort when the programme changes to the rolling 1:1", async () => {
    // Hiding the field is not enough: the value it held is still in the
    // form, and saving it would file a Living Example application against
    // a Growing Yourself Up cohort — a record that contradicts itself,
    // and one no section on the page could truthfully hold.
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/applications"]);
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "Growing Yourself Up");
    await pickChoice(screen, "Cohort", "January 2027 Cohort");
    await pickChoice(screen, "Offer", "The Living Example");

    await expect
      .element(screen.getByRole("combobox", { name: "Cohort" }))
      .not.toBeInTheDocument();

    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => (await listAll(dataProvider, "applications")).total)
      .toBe(1);

    const [saved] = (await listAll(dataProvider, "applications")).data;
    expect(String(saved.offer_id)).toBe("1");
    expect(saved.intended_cohort_id ?? null).toBeNull();
  });

  it("creates nothing when the dialog is closed instead of saved", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/applications"]);
    const screen = await render(element);

    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "The Living Example");
    await page.getByRole("button", { name: "Close" }).click();

    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    expect((await listAll(dataProvider, "applications")).total).toBe(0);
    expect((await listAll(dataProvider, "contacts")).total).toBe(1);
  });
});

describe("opening and correcting an Application", () => {
  it("opens the record even though no Opportunity sits behind it", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm(
      ["/applications/500/show"],
      [opportunitylessApplication],
    );
    const screen = await render(element);

    await expect.element(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(screen.container.textContent).toContain("The Living Example");
    // And it says why no decision can be recorded, instead of showing
    // buttons that would have nothing to write to.
    expect(screen.container.textContent).toContain(
      "No sales opportunity is linked to this application",
    );
    expect(screen.container.textContent).not.toContain("Related Sales");
  });

  it("offers a way to correct it", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm(
      ["/applications/500/show"],
      [opportunitylessApplication],
    );
    const screen = await render(element);

    await screen.getByRole("button", { name: "Correct application" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
  });

  it("moves a misfiled application to the programme it was really for", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(
      ["/applications/500/show"],
      [opportunitylessApplication],
    );
    const screen = await render(element);

    await screen.getByRole("button", { name: "Correct application" }).click();
    await pickChoice(screen, "Offer", "Growing Yourself Up");
    await pickChoice(screen, "Cohort", "January 2027 Cohort");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("applications", { id: 500 });
        return String(data.offer_id);
      })
      .toBe("2");

    const { data } = await dataProvider.getOne("applications", { id: 500 });
    expect(String(data.intended_cohort_id)).toBe("10");
  });

  it("drops the cohort when a correction moves it to the rolling 1:1", async () => {
    await page.viewport(1280, 900);
    const cohortApplication: Application = {
      ...opportunitylessApplication,
      id: 502,
      offer_id: 2,
      intended_cohort_id: 10,
    } as Application;
    const { element, dataProvider } = buildTestCrm(
      ["/applications/502/show"],
      [cohortApplication],
    );
    const screen = await render(element);

    await screen.getByRole("button", { name: "Correct application" }).click();
    await pickChoice(screen, "Offer", "The Living Example");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("applications", { id: 502 });
        return String(data.offer_id);
      })
      .toBe("1");

    const { data } = await dataProvider.getOne("applications", { id: 502 });
    expect(data.intended_cohort_id ?? null).toBeNull();
  });

  it("cannot rewrite where the record came from, or what was decided about it", async () => {
    // Provenance is a fact about the past. A status is a decision, and a
    // decision without the moment it was made is exactly the shape the
    // imported rows already have — the reason Reviewed has to mean
    // reviewed_at. None of the three is typeable here.
    await page.viewport(1280, 900);
    const imported: Application = {
      ...opportunitylessApplication,
      id: 501,
      source: "historical_import",
      status: "approved",
      reviewed_at: null,
    } as Application;
    const { element, dataProvider } = buildTestCrm(
      ["/applications/501/show"],
      [imported],
    );
    const screen = await render(element);

    await screen.getByRole("button", { name: "Correct application" }).click();
    const dialog = screen.getByRole("dialog").element() as HTMLElement;

    expect(dialog.textContent).not.toContain("Source");
    expect(dialog.textContent).not.toContain("Status");
    expect(dialog.textContent).not.toContain("Reviewed");
    // And no way to move it onto somebody else, either.
    expect(dialog.textContent).not.toContain("Search by name or email…");

    await pickChoice(screen, "Offer", "Growing Yourself Up");
    await pickChoice(screen, "Cohort", "January 2027 Cohort");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("applications", { id: 501 });
        return String(data.offer_id);
      })
      .toBe("2");

    const { data } = await dataProvider.getOne("applications", { id: 501 });
    expect(data.source).toBe("historical_import");
    expect(data.status).toBe("approved");
    expect(data.reviewed_at).toBeNull();
    expect(String(data.contact_id)).toBe("1");
  });
});

// The reason the Opportunity has to exist: reviewApplication.ts writes the
// decision onto the Application AND its Opportunity together. These drive
// the REAL review controls on the REAL page — no second "manual
// application review" path — so if a manual Application were ever again
// created without one, they fail here rather than in Leif's hands.
describe("reviewing a manual Application through the normal controls", () => {
  const createOne = async (offer = "The Living Example") => {
    const { element, dataProvider } = buildTestCrm(["/applications"]);
    const screen = await render(element);
    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", offer);
    await screen.getByRole("button", { name: /^save$/i }).click();
    await expect
      .poll(async () => (await listAll(dataProvider, "applications")).total)
      .toBe(1);
    const [application] = (await listAll(dataProvider, "applications")).data;
    return { screen, dataProvider, application };
  };

  const openIt = async (
    screen: Awaited<ReturnType<typeof render>>,
    applicationId: unknown,
  ) => {
    await screen.getByText("Ada Lovelace").first().click();
    await expect
      .element(screen.getByRole("button", { name: "Approve" }))
      .toBeVisible();
    return applicationId;
  };

  it("offers the same review controls a public-form Application gets", async () => {
    await page.viewport(1280, 900);
    const { screen, application } = await createOne();
    await openIt(screen, application.id);

    for (const label of [
      "Approve",
      "Needs Higher Care",
      "Not Fit",
      "Do Not Engage",
    ]) {
      await expect
        .element(screen.getByRole("button", { name: label }))
        .toBeVisible();
    }
  });

  it("approving advances the Application and its Opportunity together", async () => {
    await page.viewport(1280, 900);
    const { screen, dataProvider, application } = await createOne();
    await openIt(screen, application.id);

    await screen.getByRole("button", { name: "Approve" }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("applications", {
          id: application.id,
        });
        return data.status;
      })
      .toBe("approved");

    const { data: reviewed } = await dataProvider.getOne("applications", {
      id: application.id,
    });
    // Reviewed means reviewed_at, and this is a review made IN the CRM.
    expect(reviewed.reviewed_at).toBeTruthy();

    const { data: opportunity } = await dataProvider.getOne("deals", {
      id: reviewed.opportunity_id,
    });
    // Exactly what an approved public-form Application does to its own
    // Opportunity: qualified for a sales call, outcome still undecided.
    expect(opportunity.stage).toBe("approved");
    expect(opportunity.outcome ?? null).toBeNull();
  });

  it("moves out of Needs Review into Reviewed, in the same programme", async () => {
    // Seeded at the state the approval above provably produces (status
    // approved + a real reviewed_at), because a second mount over the same
    // data cannot be driven from a MemoryRouter. What the approval does to
    // the records is asserted in the test above; this asserts where the
    // page then files them.
    await page.viewport(1280, 900);
    const reviewedHere: Application = {
      ...opportunitylessApplication,
      id: 600,
      opportunity_id: 900,
      status: "approved",
      reviewed_at: "2026-09-24T11:00:00.000Z",
    } as Application;
    const { element } = buildTestCrm(
      ["/applications"],
      [reviewedHere],
      [
        {
          id: 900,
          contact_id: 1,
          offer_id: 1,
          cohort_id: null,
          stage: "approved",
          outcome: null,
          archived_at: null,
          name: "Ada Lovelace",
        },
      ],
    );
    const screen = await render(element);

    await expect
      .element(screen.getByText("The Living Example"))
      .toBeInTheDocument();

    const section = [...screen.container.querySelectorAll("section")].find(
      (el) =>
        [...el.querySelectorAll("h2")].some(
          (h) => h.textContent === "The Living Example",
        ),
    )!;
    // Needs Review is always open and Reviewed is collapsed, so her being
    // out of sight in her own programme's section IS the move.
    expect(section.textContent).not.toContain("Needs Review");
    expect(section.textContent).toContain("Reviewed");
    expect(section.textContent).not.toContain("Ada Lovelace");

    [...section.querySelectorAll("button")]
      .find((b) => /Reviewed/.test(b.textContent ?? ""))!
      .click();
    await expect.element(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("records Not Fit on both records, the canonical way", async () => {
    await page.viewport(1280, 900);
    const { screen, dataProvider, application } = await createOne();
    await openIt(screen, application.id);

    await screen.getByRole("button", { name: "Not Fit" }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("applications", {
          id: application.id,
        });
        return data.status;
      })
      .toBe("not_fit");

    const { data: reviewed } = await dataProvider.getOne("applications", {
      id: application.id,
    });
    const { data: opportunity } = await dataProvider.getOne("deals", {
      id: reviewed.opportunity_id,
    });
    // An outcome ends the sales attempt — the same write the public-form
    // path makes, which is only reachable because the Opportunity exists.
    expect(opportunity.outcome).toBe("not_fit");
  });

  it("records Needs Higher Care on both records", async () => {
    await page.viewport(1280, 900);
    const { screen, dataProvider, application } = await createOne();
    await openIt(screen, application.id);

    await screen.getByRole("button", { name: "Needs Higher Care" }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("applications", {
          id: application.id,
        });
        return data.status;
      })
      .toBe("needs_higher_care");

    const { data: reviewed } = await dataProvider.getOne("applications", {
      id: application.id,
    });
    const { data: opportunity } = await dataProvider.getOne("deals", {
      id: reviewed.opportunity_id,
    });
    expect(opportunity.outcome).toBe("needs_higher_care");
  });
});

// Attaching a new pending Application to a sale already past the point a
// review speaks to.
//
// Approving an Application WRITES stage = 'approved' onto its Opportunity.
// From interested or application_received that is forward motion, and at
// approved it changes nothing — but on a sale at call_booked or decision
// it would drag the person BACKWARD through the pipeline on the strength
// of a review. The stage is where the sale actually got to, so the
// application is refused at creation rather than set up to regress it
// later.
describe("reusing a live Opportunity only where a review still speaks to it", () => {
  const opportunity = (stage: string, over: Record<string, unknown> = {}) => ({
    id: 900,
    contact_id: 1,
    offer_id: 1,
    cohort_id: null,
    stage,
    outcome: null,
    archived_at: null,
    name: "Ada Lovelace",
    ...over,
  });

  const attempt = async (deal: Record<string, unknown>) => {
    const { element, dataProvider } = buildTestCrm(
      ["/applications"],
      [],
      [deal],
    );
    const screen = await render(element);
    await screen.getByRole("button", { name: "New Application" }).click();
    await pickPerson(screen, "Ada Lovelace");
    await pickChoice(screen, "Offer", "The Living Example");
    await screen.getByRole("button", { name: /^save$/i }).click();
    return { screen, dataProvider };
  };

  it.each([
    ["interested", "the sale has not reached a review yet"],
    ["application_received", "the sale is exactly where a review belongs"],
    ["approved", "approving again changes nothing"],
  ])("reuses a sale at %s — %s", async (stage) => {
    await page.viewport(1280, 900);
    const { dataProvider } = await attempt(opportunity(stage));

    await expect
      .poll(async () => (await listAll(dataProvider, "applications")).total)
      .toBe(1);

    // Reused, not duplicated, and not regressed at creation either.
    expect((await listAll(dataProvider, "deals")).total).toBe(1);
    const [saved] = (await listAll(dataProvider, "applications")).data;
    expect(String(saved.opportunity_id)).toBe("900");
    const { data: deal } = await dataProvider.getOne("deals", { id: 900 });
    expect(deal.stage).toBe(stage);
  });

  it.each([
    ["call_booked", "Call Booked"],
    ["decision", "Decision"],
    // Legacy storage, fourteen rows renamed from 'committed'.
    // deal_is_active() still calls it active, and it is far past a review,
    // so the rule has to fail closed on a stage it does not recognise.
    ["onboarding", "Onboarding"],
  ])("refuses a sale at %s, and changes nothing", async (stage, label) => {
    await page.viewport(1280, 900);
    const { screen, dataProvider } = await attempt(opportunity(stage));

    await expect
      .element(screen.getByText(/already has an active/i))
      .toBeInTheDocument();
    // Named, so she can tell WHY without opening anything. Read from the
    // dialog itself: it renders in a portal, outside the page container.
    const dialog = screen.getByRole("dialog").element() as HTMLElement;
    expect(dialog.textContent).toContain(label);
    expect(dialog.textContent).toContain("The Living Example");

    // No Application, no second Opportunity, and the live one untouched.
    expect((await listAll(dataProvider, "applications")).total).toBe(0);
    expect((await listAll(dataProvider, "deals")).total).toBe(1);
    const { data: deal } = await dataProvider.getOne("deals", { id: 900 });
    expect(deal.stage).toBe(stage);
    expect(deal.outcome ?? null).toBeNull();
  });

  it("offers a way into the sale it refused for", async () => {
    await page.viewport(1280, 900);
    const { screen } = await attempt(opportunity("call_booked"));

    await expect
      .element(screen.getByRole("link", { name: "Open the opportunity" }))
      .toBeVisible();
  });

  it.each([
    ["won", { stage: "won" }],
    ["a recorded outcome", { stage: "decision", outcome: "not_fit" }],
    [
      "archived",
      { stage: "call_booked", archived_at: "2026-01-01T00:00:00.000Z" },
    ],
  ])(
    "opens a NEW cycle when the prior sale is concluded — %s",
    async (_label, over) => {
      // A terminal attempt is never silently reactivated, and it never
      // blocks a genuinely new one either: the new cycle is a new
      // Opportunity beside the old one.
      await page.viewport(1280, 900);
      const { dataProvider } = await attempt(opportunity("call_booked", over));

      await expect
        .poll(async () => (await listAll(dataProvider, "applications")).total)
        .toBe(1);

      const deals = await listAll(dataProvider, "deals");
      expect(deals.total).toBe(2);
      const created = deals.data.find((d) => String(d.id) !== "900")!;
      expect(created.stage).toBe("application_received");
      const [saved] = (await listAll(dataProvider, "applications")).data;
      expect(String(saved.opportunity_id)).toBe(String(created.id));
    },
  );
});
