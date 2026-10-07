import React from "react";
import { render } from "vitest-browser-react";
import { CoreAdminContext } from "ra-core";
import fakeDataProvider from "ra-data-fakerest";

import { ApplicationList } from "./ApplicationList";

// Two offers (one individual, one group with two cohorts) and one
// application per cohort/offer, so a wrong-section assignment shows up as a
// visible test failure rather than needing to inspect grouping internals
// (Runtime + Visual Consistency slice, §5/§12: "application records appear
// in only the appropriate section"). UX cleanup pass, §3: Needs Review is
// the primary section (pending applications only); Reviewed Applications
// is a collapsed history section for every other status.
const offers = [
  { id: 1, name: "The Living Example", type: "individual" },
  { id: 2, name: "Growing Yourself Up", type: "group" },
];

const cohorts = [
  { id: 10, offer_id: 2, name: "September GYU Cohort" },
  { id: 11, offer_id: 2, name: "Spring GYU Cohort" },
];

const contacts = [
  { id: 100, first_name: "Rosalind", last_name: "Park" },
  { id: 101, first_name: "Priya", last_name: "Nair" },
  { id: 102, first_name: "Jordan", last_name: "Lee" },
  { id: 103, first_name: "Naomi", last_name: "Ellison" },
  { id: 104, first_name: "Historic", last_name: "Applicant" },
  { id: 105, first_name: "Dealless", last_name: "Applicant" },
];

const deals = [
  { id: 200, contact_id: 100, offer_id: 1, cohort_id: null, name: "Rosalind" },
  { id: 201, contact_id: 101, offer_id: 2, cohort_id: 10, name: "Priya" },
  { id: 202, contact_id: 102, offer_id: 2, cohort_id: 11, name: "Jordan" },
  { id: 203, contact_id: 103, offer_id: 1, cohort_id: null, name: "Naomi" },
  // Concluded on purpose: this old-funnel questionnaire belongs in
  // Historical, and "no stage, no outcome" would read as a sales process
  // still running and put it under Pre-CRM — Active Sales instead.
  {
    id: 204,
    contact_id: 104,
    offer_id: 1,
    cohort_id: null,
    name: "Historic",
    stage: "decision",
    outcome: "lost",
    archived_at: null,
  },
];

const applications = [
  // The shape that made this page unable to show ANY history: an imported
  // Application with no Opportunity at all. 88 of production's 159 look like
  // this, and grouping via the Deal drops every one of them.
  {
    id: 398,
    contact_id: 105,
    opportunity_id: null,
    offer_id: 2,
    intended_cohort_id: 11,
    source: "historical_import",
    status: "waitlist",
    submitted_at: "2024-02-02T10:00:00.000Z",
  },
  // Gate A: an imported historical record. It keeps its true source status
  // ("pending" is what the Notion source said) but must never become
  // present-day review work just because it is now reachable.
  {
    id: 399,
    contact_id: 104,
    opportunity_id: 204,
    offer_id: 1,
    intended_cohort_id: null,
    source: "historical_import",
    status: "pending",
    submitted_at: "2024-01-01T10:00:00.000Z",
  },
  {
    id: 300,
    contact_id: 100,
    opportunity_id: 200,
    source: "public_form",
    status: "pending",
    submitted_at: "2026-08-01T10:00:00.000Z",
  },
  {
    id: 301,
    contact_id: 101,
    opportunity_id: 201,
    source: "public_form",
    status: "pending",
    submitted_at: "2026-08-02T10:00:00.000Z",
  },
  {
    id: 302,
    contact_id: 102,
    opportunity_id: 202,
    source: "public_form",
    status: "pending",
    submitted_at: "2026-08-03T10:00:00.000Z",
  },
  // Already reviewed — belongs in the collapsed history section, not
  // Needs Review.
  {
    id: 303,
    contact_id: 103,
    opportunity_id: 203,
    source: "public_form",
    status: "approved",
    submitted_at: "2026-07-01T10:00:00.000Z",
    reviewed_at: "2026-07-02T10:00:00.000Z",
  },
];

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CoreAdminContext
    dataProvider={fakeDataProvider({
      applications,
      deals,
      offers,
      cohorts,
      contacts,
    })}
    i18nProvider={{
      translate: (key, options) => {
        if (key === "resources.applications.needs_review")
          return "Needs Review";
        if (key === "resources.applications.reviewed") return "Reviewed";
        if (typeof options?._ === "string") {
          return options._;
        }
        return key;
      },
      changeLocale: () => Promise.resolve(),
      getLocale: () => "en",
    }}
  >
    {children}
  </CoreAdminContext>
);

// One programme = one container, so "the section for X" is either a
// programme container or a cohort subsection inside one. Both carry a stable
// testid; scoping by tag structure is what broke when the page stopped
// rendering a loose <section> per cohort.
const programmeFor = (
  screen: { container: HTMLElement },
  name: string,
): HTMLElement | null =>
  screen.container.querySelector<HTMLElement>(
    `[data-testid="application-programme"][data-programme="${name}"]`,
  );

const subsectionFor = (
  screen: { container: HTMLElement },
  heading: string,
): HTMLElement | null =>
  screen.container.querySelector<HTMLElement>(
    `[data-testid="application-subsection"][data-subsection="${heading}"]`,
  );

/** A programme container, or the cohort subsection of that name. */
const sectionFor = (
  screen: { container: HTMLElement },
  heading: string,
): HTMLElement | null =>
  programmeFor(screen, heading) ?? subsectionFor(screen, heading);

describe("ApplicationList", () => {
  it("puts the individual (1:1) offer's pending application under Needs Review, with the simplified heading", async () => {
    const screen = await render(<ApplicationList />, { wrapper: Wrapper });
    // "Needs Review" now appears once per programme that has any, which
    // is the point of the page — so this scopes to the 1:1 section
    // rather than asserting a single global heading.
    await expect
      .element(screen.getByText("The Living Example"))
      .toBeInTheDocument();
    const le = sectionFor(screen, "The Living Example");
    expect(le?.textContent).toContain("Needs Review");
    expect(le?.textContent).toContain("Rosalind Park");
  });

  it("keeps an imported historical Application out of Needs Review without falsifying its status", async () => {
    const screen = await render(<ApplicationList />, { wrapper: Wrapper });
    // The live 1:1 applicant is present...
    await expect.element(screen.getByText("Rosalind Park")).toBeInTheDocument();
    // ...but the historical record — still truthfully status "pending" in
    // the database — is not present-day review work and must not appear,
    // in Needs Review or in the Reviewed history section.
    expect(screen.container.textContent).not.toContain("Historic Applicant");
  });

  it("groups group-offer applications under their own Cohort with the redundant Offer initials dropped", async () => {
    const screen = await render(<ApplicationList />, { wrapper: Wrapper });
    // "September/Spring GYU Cohort" -> "September/Spring Cohort".
    await expect
      .element(screen.getByText("September Cohort"))
      .toBeInTheDocument();
    await expect.element(screen.getByText("Spring Cohort")).toBeInTheDocument();
    await expect.element(screen.getByText("Priya Nair")).toBeInTheDocument();
    await expect.element(screen.getByText("Jordan Lee")).toBeInTheDocument();
  });

  it("does not show a September Cohort applicant under Spring Cohort", async () => {
    const screen = await render(<ApplicationList />, { wrapper: Wrapper });
    const { container } = screen;
    await expect.element(screen.getByText("Spring Cohort")).toBeInTheDocument();

    void container;
    // Cohort isolation, unchanged by the regrouping: each cohort is now a
    // subsection inside the one Growing Yourself Up container rather than a
    // peer section, and an applicant must still appear only in their own.
    const spring = subsectionFor(screen, "Spring Cohort");
    expect(spring, "the Spring Cohort subsection exists").not.toBeNull();
    expect(spring!.textContent).not.toContain("Priya Nair");

    const september = subsectionFor(screen, "September Cohort");
    expect(september, "the September Cohort subsection exists").not.toBeNull();
    expect(september!.textContent).not.toContain("Jordan Lee");
  });

  it("makes imported Applications browsable under Historical Applications instead of hiding the whole page", async () => {
    const screen = await render(<ApplicationList />, { wrapper: Wrapper });

    // The regression: with every Application imported, the page read
    // "No applications yet" while holding all of them.
    await expect
      .element(screen.getByText("No applications yet."))
      .not.toBeInTheDocument();

    // History starts collapsed so it never competes with real review work.
    await expect
      .element(screen.getByText("Historic Applicant"))
      .not.toBeInTheDocument();

    // Wait for something POSITIVE before reading the DOM: every
    // assertion above is an absence, and an absence is satisfied while
    // the page is still loading, so the container was empty here.
    await expect
      .element(screen.getByText("The Living Example"))
      .toBeInTheDocument();

    // Historical sits inside the programme it belongs to, so open the
    // 1:1 one specifically — proving it was filed there and not globally.
    const le = sectionFor(screen, "The Living Example")!;
    const trigger = [...le.querySelectorAll("button")].find((b) =>
      /Historical/.test(b.textContent ?? ""),
    )!;
    trigger.click();

    await expect
      .element(screen.getByText("Historic Applicant"))
      .toBeInTheDocument();
  });

  it("keeps a Deal-less historical Application visible, grouped by what it was applied FOR", async () => {
    const screen = await render(<ApplicationList />, { wrapper: Wrapper });

    await expect.element(screen.getByText("Spring Cohort")).toBeInTheDocument();

    // Opened inside the Spring Cohort section specifically. This record
    // has no Deal at all, so the only thing that could have filed it here
    // is its own intended_cohort_id — which is exactly why it used to
    // disappear when grouping walked through the Opportunity.
    const spring = sectionFor(screen, "Spring Cohort")!;
    [...spring.querySelectorAll("button")]
      .find((b) => /Historical/.test(b.textContent ?? ""))!
      .click();

    await expect
      .element(screen.getByText("Dealless Applicant"))
      .toBeInTheDocument();
  });

  it("names the programme once, as the container its cohorts live inside", async () => {
    // This used to read "appears once per cohort section", because the page
    // repeated the offer name beside every cohort title. ONE PROGRAMME = ONE
    // CONTAINER: the name belongs to the container, and the cohorts are
    // subsections within it.
    const screen = await render(<ApplicationList />, { wrapper: Wrapper });
    await expect
      .element(screen.getByText("Growing Yourself Up").first())
      .toBeInTheDocument();

    const gyu = programmeFor(screen, "Growing Yourself Up");
    expect(gyu, "exactly one Growing Yourself Up container").not.toBeNull();
    expect(
      screen.container.querySelectorAll(
        '[data-testid="application-programme"][data-programme="Growing Yourself Up"]',
      ),
    ).toHaveLength(1);

    // Both of its cohorts are inside that one container.
    for (const cohort of ["September Cohort", "Spring Cohort"]) {
      const sub = subsectionFor(screen, cohort);
      expect(sub, cohort).not.toBeNull();
      expect(gyu!.contains(sub!), `${cohort} is inside the programme`).toBe(
        true,
      );
    }
  });

  it("leaves no programme, cohort or subsection heading floating outside a container", async () => {
    // The page used to render a loose <section> per cohort-or-offer with its
    // headings directly on the page. Every heading now belongs to a
    // programme container.
    const screen = await render(<ApplicationList />, { wrapper: Wrapper });
    await expect
      .element(screen.getByText("The Living Example"))
      .toBeInTheDocument();

    const containers = [
      ...screen.container.querySelectorAll<HTMLElement>(
        '[data-testid="application-programme"]',
      ),
    ];
    expect(containers.length).toBeGreaterThan(1);

    // h1 is the page title and belongs outside; everything below it does not.
    const headings = [
      ...screen.container.querySelectorAll<HTMLElement>("h2, h3, h4"),
    ];
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) {
      expect(
        containers.some((c) => c.contains(heading)),
        `"${heading.textContent}" is inside a programme container`,
      ).toBe(true);
    }
  });

  it("puts the Copy Application Link at the level that actually has one form", async () => {
    // The Living Example has a single public form, so its link belongs to
    // the programme. Growing Yourself Up does not — each cohort has its own
    // — so there is no programme-level link to guess at, and the links live
    // on the cohort subsections.
    const screen = await render(<ApplicationList />, { wrapper: Wrapper });
    await expect
      .element(screen.getByText("The Living Example"))
      .toBeInTheDocument();

    const copyButtons = (root: HTMLElement) =>
      [...root.querySelectorAll("button")].filter((b) =>
        /copy/i.test(b.textContent ?? ""),
      );

    const le = programmeFor(screen, "The Living Example")!;
    const gyu = programmeFor(screen, "Growing Yourself Up")!;

    // LE: one link, and it is NOT inside a cohort subsection (it has none).
    const leButtons = copyButtons(le);
    expect(leButtons).toHaveLength(1);
    expect(
      leButtons[0].closest('[data-testid="application-subsection"]'),
    ).toBeNull();

    // GYU: every link sits on a cohort subsection, never at programme level.
    const gyuButtons = copyButtons(gyu);
    expect(gyuButtons.length).toBeGreaterThan(0);
    for (const button of gyuButtons) {
      const subsection = button.closest<HTMLElement>(
        '[data-testid="application-subsection"]',
      );
      expect(subsection, "a GYU link belongs to a cohort").not.toBeNull();
      // And to a real cohort, never to the cohortless catch-all.
      expect(subsection!.getAttribute("data-subsection")).not.toBe(
        "No cohort recorded",
      );
    }
  });

  it("demotes an already-reviewed application into the collapsed Reviewed Applications section, hidden from Needs Review until expanded", async () => {
    const screen = await render(<ApplicationList />, { wrapper: Wrapper });

    // Not visible yet — Reviewed Applications starts collapsed.
    await expect
      .element(screen.getByText("Naomi Ellison"))
      .not.toBeInTheDocument();

    const reviewedTrigger = screen.getByText("Reviewed");
    await expect.element(reviewedTrigger).toBeInTheDocument();
    await reviewedTrigger.click();

    await expect.element(screen.getByText("Naomi Ellison")).toBeInTheDocument();
  });
});
