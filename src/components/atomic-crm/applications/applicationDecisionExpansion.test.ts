import { describe, expect, it } from "vitest";

import { createDataProvider } from "../providers/fakerest/dataProvider";
import { createCrmDb, buildContact } from "@/test/StoryWrapper";
import type {
  Application,
  Cohort,
  Deal,
  DealOfferEvent,
  Enrollment,
  Offer,
} from "../types";
import { reviewApplication } from "./reviewApplication";
import { NON_APPROVED_TERMINAL_APPLICATION_STATUSES } from "./applicationConstants";

// Two decisions Leif could not record, and the shapes they must not take.
//
// OFFERING THE OTHER PROGRAMME is not a rejection. She is willing to work with
// this person, in the other programme. So the Application keeps saying what
// they applied for — offer_id, intended_cohort_id, questions, answers,
// submitted_at — and the SALES path moves. The same Opportunity moves: a
// second one for one person's one decision is the duplicate this CRM refuses
// everywhere else.
//
// BESPOKE ACCEPTANCE / REJECTION are processed and decided; only the reply is
// written by hand. So both leave the review queue, both carry the same
// operational meaning as their automatic counterparts, and neither may reach a
// tag an email automation hangs off.
//
// These run the mirror, which is what a FakeRest surface and the demo execute.
// The authority is review_application() in Postgres, proved against real
// Postgres and the real roles in e2e/applicationDecisionExpansion.spec.ts,
// because the lock and the one transaction cannot exist in a browser.

const LE = 1;
const GYU = 2;
const LEGACY = 3;

const offer = (
  id: number,
  name: string,
  type: "individual" | "group",
  isActive = true,
): Offer => ({
  id,
  name,
  type,
  duration: type === "group" ? "8 weeks" : "6 months",
  current_price: 1400,
  is_active: isActive,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const COHORT: Cohort = {
  id: 10,
  offer_id: GYU,
  name: "Fall 2026",
  status: "applications_open",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const buildWorld = ({
  appliedTo,
  cohortId = null,
  pricingMode,
  enrolled = false,
  offers = [
    offer(LE, "The Living Example", "individual"),
    offer(GYU, "Growing Yourself Up", "group"),
    // Retired, and therefore never a destination. This row is the reason the
    // resolver asks about is_active rather than counting the catalog.
    offer(LEGACY, "1:1 Coaching (Legacy)", "individual", false),
  ],
}: {
  appliedTo: number;
  cohortId?: number | null;
  pricingMode?: "standard" | "scholarship";
  enrolled?: boolean;
  offers?: Offer[];
}) => {
  const contact = buildContact({ id: 1 });
  const deal: Deal = {
    id: 1,
    name: "Applicant",
    contact_id: 1,
    offer_id: appliedTo,
    cohort_id: cohortId,
    stage: "application_received",
    outcome: null,
    owner_decision: null,
    amount: 1400,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    sales_id: 0,
    index: 0,
    stage_entered_at: "2026-01-01T00:00:00.000Z",
    ...(pricingMode ? { pricing_mode: pricingMode } : {}),
  };
  const application: Application = {
    id: 1,
    contact_id: 1,
    opportunity_id: 1,
    offer_id: appliedTo,
    intended_cohort_id: cohortId,
    source: "public_form",
    status: "pending",
    submitted_at: "2026-02-02T00:00:00.000Z",
    reviewed_at: null,
    raw_answers: { le_main_pattern: "The same argument, over and over." },
    summary: null,
    created_at: "2026-02-02T00:00:00.000Z",
    updated_at: "2026-02-02T00:00:00.000Z",
  };
  const enrollments: Enrollment[] = enrolled
    ? ([
        {
          id: 1,
          opportunity_id: 1,
          contact_id: 1,
          offer_id: appliedTo,
          status: "onboarding",
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-01T00:00:00.000Z",
        },
      ] as unknown as Enrollment[])
    : [];

  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [contact],
      offers,
      offer_payment_options: [],
      cohorts: [COHORT],
      deals: [deal],
      applications: [application],
      enrollments,
      tasks: [],
      deal_offer_events: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return { dataProvider, application };
};

const readBack = async (
  dataProvider: ReturnType<typeof buildWorld>["dataProvider"],
) => {
  const { data: app } = await dataProvider.getOne<Application>("applications", {
    id: 1,
  });
  const { data: deal } = await dataProvider.getOne<Deal>("deals", { id: 1 });
  const { data: deals } = await dataProvider.getList<Deal>("deals", {
    filter: {},
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });
  const { data: events } = await dataProvider.getList<DealOfferEvent>(
    "deal_offer_events",
    {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    },
  );
  return { app, deal, deals, events };
};

describe("offering the other programme moves the sale, never the application", () => {
  it("The Living Example -> offer Growing Yourself Up", async () => {
    const { dataProvider, application } = buildWorld({ appliedTo: LE });

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "offered_other_programme",
    });
    expect(result.applied).toBe(true);

    const { app, deal, deals, events } = await readBack(dataProvider);

    // The application still records the programme they applied for, and every
    // other thing they sent is untouched.
    expect(app.offer_id).toBe(LE);
    expect(app.submitted_at).toBe("2026-02-02T00:00:00.000Z");
    expect(app.raw_answers).toEqual({
      le_main_pattern: "The same argument, over and over.",
    });
    // The recommendation is its own fact, with its own moment.
    expect(app.status).toBe("offered_other_programme");
    expect(app.recommended_offer_id).toBe(GYU);
    expect(app.reviewed_at).not.toBeNull();

    // The sales destination is Growing Yourself Up, on the SAME Opportunity,
    // behaving like that programme's approved path.
    expect(deal.offer_id).toBe(GYU);
    expect(deal.stage).toBe("approved");
    expect(deal.outcome).toBeNull();
    expect(deals).toHaveLength(1);

    // And the programme change is recorded where the Application/Opportunity
    // agreement guard looks for it.
    expect(events).toHaveLength(1);
    expect(events[0].from_offer_id).toBe(LE);
    expect(events[0].to_offer_id).toBe(GYU);
    expect(events[0].enrollment_id).toBeNull();
  });

  it("Growing Yourself Up -> offer The Living Example, keeping the cohort on the application and leaving it off the sale", async () => {
    const { dataProvider, application } = buildWorld({
      appliedTo: GYU,
      cohortId: COHORT.id as number,
    });

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "offered_other_programme",
    });
    expect(result.applied).toBe(true);

    const { app, deal, deals, events } = await readBack(dataProvider);

    // Their original round is part of what they applied for.
    expect(app.offer_id).toBe(GYU);
    expect(app.intended_cohort_id).toBe(COHORT.id);
    expect(app.recommended_offer_id).toBe(LE);

    // A round belongs to the programme that has rounds. The Living Example has
    // none, so the sale leaves it behind rather than carrying a cohort that
    // belongs to another programme.
    expect(deal.offer_id).toBe(LE);
    expect(deal.cohort_id).toBeNull();
    expect(deal.stage).toBe("approved");
    expect(deals).toHaveLength(1);

    expect(events).toHaveLength(1);
    expect(events[0].from_offer_id).toBe(GYU);
    expect(events[0].to_offer_id).toBe(LE);
  });

  it("refuses rather than guessing when there is more than one other programme", async () => {
    const { dataProvider, application } = buildWorld({
      appliedTo: LE,
      offers: [
        offer(LE, "The Living Example", "individual"),
        offer(GYU, "Growing Yourself Up", "group"),
        offer(4, "A Third Programme", "group"),
      ],
    });

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "offered_other_programme",
    });
    expect(result).toEqual({
      applied: false,
      reason: "recommendation-ambiguous",
    });

    // A refusal means nothing happened.
    const { app, deal, events } = await readBack(dataProvider);
    expect(app.status).toBe("pending");
    expect(app.reviewed_at).toBeNull();
    expect(deal.offer_id).toBe(LE);
    expect(events).toHaveLength(0);
  });

  it("refuses an enrolled client, because moving one carries a checklist", async () => {
    const { dataProvider, application } = buildWorld({
      appliedTo: LE,
      enrolled: true,
    });

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "offered_other_programme",
    });
    expect(result).toEqual({ applied: false, reason: "already-enrolled" });

    const { app, deal } = await readBack(dataProvider);
    expect(app.status).toBe("pending");
    expect(deal.offer_id).toBe(LE);
  });

  it("refuses while a scholarship place is held", async () => {
    const { dataProvider, application } = buildWorld({
      appliedTo: LE,
      pricingMode: "scholarship",
    });

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "offered_other_programme",
    });
    expect(result).toEqual({ applied: false, reason: "scholarship-held" });

    const { app, deal } = await readBack(dataProvider);
    expect(app.status).toBe("pending");
    expect(deal.offer_id).toBe(LE);
  });
});

describe("a bespoke decision is processed, decided, and answered by hand", () => {
  it("bespoke acceptance leaves the approved path exactly as available", async () => {
    const { dataProvider, application } = buildWorld({ appliedTo: LE });

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "bespoke_accepted",
    });
    expect(result.applied).toBe(true);

    const { app, deal, events } = await readBack(dataProvider);
    expect(app.status).toBe("bespoke_accepted");
    expect(app.reviewed_at).not.toBeNull();
    // Nothing was recommended, so nothing claims to have been.
    expect(app.recommended_offer_id ?? null).toBeNull();
    // The same shape 'approved' writes.
    expect(deal.stage).toBe("approved");
    expect(deal.outcome).toBeNull();
    expect(deal.offer_id).toBe(LE);
    // No programme moved, so there is no programme history to record.
    expect(events).toHaveLength(0);
  });

  it("bespoke rejection is a rejection, and does not move the stage backward", async () => {
    const { dataProvider, application } = buildWorld({ appliedTo: GYU });

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "bespoke_rejected",
    });
    expect(result.applied).toBe(true);

    const { app, deal } = await readBack(dataProvider);
    expect(app.status).toBe("bespoke_rejected");
    expect(app.reviewed_at).not.toBeNull();
    expect(deal.outcome).toBe("not_fit");
    // A decision about a person is not a demotion of their pipeline position.
    expect(deal.stage).toBe("application_received");
  });

  it("counts a bespoke rejection as a rejection, and the other two new decisions as still in play", () => {
    // The cohort capacity hooks' defensive fallback asks one question: has
    // this person stopped moving toward a purchase on THIS Opportunity?
    expect(
      NON_APPROVED_TERMINAL_APPLICATION_STATUSES.has("bespoke_rejected"),
    ).toBe(true);
    expect(
      NON_APPROVED_TERMINAL_APPLICATION_STATUSES.has("bespoke_accepted"),
    ).toBe(false);
    // A recommendation moves the Opportunity rather than ending it, so they
    // are still in play — on the same Opportunity, for the other programme.
    expect(
      NON_APPROVED_TERMINAL_APPLICATION_STATUSES.has("offered_other_programme"),
    ).toBe(false);
  });
});

describe("the decisions that already existed are untouched", () => {
  it("approve still moves the pipeline forward and clears any earlier outcome", async () => {
    const { dataProvider, application } = buildWorld({ appliedTo: LE });
    await reviewApplication({ dataProvider, application, outcome: "approved" });
    const { app, deal, events } = await readBack(dataProvider);
    expect(app.status).toBe("approved");
    expect(app.recommended_offer_id ?? null).toBeNull();
    expect(deal.stage).toBe("approved");
    expect(deal.outcome).toBeNull();
    expect(deal.offer_id).toBe(LE);
    expect(events).toHaveLength(0);
  });

  it("not fit and needs higher care still record an outcome and leave the stage alone", async () => {
    for (const outcome of ["not_fit", "needs_higher_care"] as const) {
      const { dataProvider, application } = buildWorld({ appliedTo: LE });
      await reviewApplication({ dataProvider, application, outcome });
      const { app, deal } = await readBack(dataProvider);
      expect(app.status).toBe(outcome);
      expect(deal.outcome).toBe(outcome);
      expect(deal.stage).toBe("application_received");
      expect(deal.offer_id).toBe(LE);
    }
  });

  it("do not engage is still lost plus the owner decision", async () => {
    const { dataProvider, application } = buildWorld({ appliedTo: LE });
    await reviewApplication({
      dataProvider,
      application,
      outcome: "do_not_engage",
    });
    const { app, deal } = await readBack(dataProvider);
    expect(app.status).toBe("do_not_engage");
    expect(deal.outcome).toBe("lost");
    expect(deal.owner_decision).toBe("do_not_engage");
  });
});
