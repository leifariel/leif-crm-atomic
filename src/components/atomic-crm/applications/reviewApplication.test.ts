import { describe, expect, it } from "vitest";

import { createDataProvider } from "../providers/fakerest/dataProvider";
import { createCrmDb, buildContact } from "@/test/StoryWrapper";
import type { Application, Cohort, Deal, Offer, Task } from "../types";
import { reviewApplication } from "./reviewApplication";

const CONTACT_ID = 1;
const OFFER_ID = 1;
const COHORT_ID = 1;
const DEAL_ID = 1;
const APPLICATION_ID = 1;
const TASK_ID = 1;

const buildFixtures = () => {
  const contact = buildContact({ id: CONTACT_ID });

  const offer: Offer = {
    id: OFFER_ID,
    name: "Growing Yourself Up",
    type: "group",
    duration: "8 weeks",
    current_price: 1400,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  const cohort: Cohort = {
    id: COHORT_ID,
    offer_id: OFFER_ID,
    name: "Test Cohort",
    status: "applications_open",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  const deal: Deal = {
    id: DEAL_ID,
    name: "Test Applicant — Growing Yourself Up",
    contact_id: CONTACT_ID,
    offer_id: OFFER_ID,
    cohort_id: COHORT_ID,
    stage: "application_received",
    outcome: null,
    owner_decision: null,
    amount: 1400,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    sales_id: 0,
    index: 0,
    stage_entered_at: "2026-01-01T00:00:00.000Z",
  };

  const application: Application = {
    id: APPLICATION_ID,
    contact_id: CONTACT_ID,
    opportunity_id: DEAL_ID,
    source: "public_form",
    status: "pending",
    submitted_at: "2026-01-01T00:00:00.000Z",
    reviewed_at: null,
    raw_answers: { why_this_cohort: "Curious." },
    summary: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  const task: Task = {
    id: TASK_ID,
    contact_id: CONTACT_ID,
    type: "review_application",
    text: "Review Test Applicant's application",
    due_date: "2026-01-01T00:00:00.000Z",
    done_date: null,
    status: "pending",
    sales_id: 0,
  };

  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [contact],
      offers: [offer],
      offer_payment_options: [],
      cohorts: [cohort],
      deals: [deal],
      applications: [application],
      enrollments: [],
      tasks: [task],
    }),
    silent: true,
    latency: 0,
  });

  return { dataProvider, deal, application };
};

// Found by the adversarial gate before Leif began approving applicants.
//
// A decision is four separate writes with no transaction: the Application, the
// Opportunity, the Contact on Do Not Engage, and the review Task. Nothing
// holds them together, so anything that interrupts the sequence — a dropped
// connection, a refused request, a closed tab — leaves the Application
// carrying a decision its Opportunity has never heard of.
//
// That is not a theoretical race. It needs only one failure in the middle.
describe("an application decision is all of it or none of it", () => {
  it("records the decision through one authority, not four separate writes", async () => {
    const { dataProvider, application } = buildFixtures();

    // Count what the decision actually does to the outside world.
    const writes: string[] = [];
    let authorityCalls = 0;
    const watched = {
      ...dataProvider,
      reviewApplication: (async (input: {
        applicationId: unknown;
        outcome: string;
      }) => {
        authorityCalls += 1;
        return await (
          dataProvider as unknown as {
            reviewApplication: (i: unknown) => Promise<{ status: string }>;
          }
        ).reviewApplication(input);
      }) as never,
      update: (async (resource: string, params: unknown) => {
        writes.push(`update:${resource}`);
        return await (
          dataProvider as unknown as {
            update: (r: string, p: unknown) => Promise<unknown>;
          }
        ).update(resource, params);
      }) as typeof dataProvider.update,
    } as typeof dataProvider;

    const result = await reviewApplication({
      dataProvider: watched,
      application,
      outcome: "approved",
    });

    expect(result).toEqual({ applied: true });
    // ONE call carries the whole decision. The caller never writes to
    // applications, deals, contacts or tasks itself — if it did, a failure
    // between two of those writes would leave the Application carrying a
    // decision its Opportunity had never heard of, which is exactly the
    // defect this replaced.
    expect(authorityCalls).toBe(1);
    expect(writes).toEqual([]);
  });

  it("refuses a decision there is no opportunity to record against", async () => {
    const { dataProvider, application } = buildFixtures();
    const { data: current } = await dataProvider.getOne<Application>(
      "applications",
      { id: application.id },
    );
    await dataProvider.update("applications", {
      id: application.id,
      data: { opportunity_id: null },
      previousData: current,
    });

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "approved",
    });

    expect(result).toEqual({ applied: false, reason: "no-opportunity" });
    const { data: after } = await dataProvider.getOne<Application>(
      "applications",
      { id: application.id },
    );
    expect(after.status).toBe("pending");
    expect(after.reviewed_at ?? null).toBeNull();
  });
});

describe("reviewApplication", () => {
  it("Approve: Application approved, Opportunity stage Approved with a cleared outcome, review task completes, no Enrollment created", async () => {
    const { dataProvider, application } = buildFixtures();

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "approved",
    });
    expect(result).toEqual({ applied: true });

    const { data: updatedApplication } = await dataProvider.getOne<Application>(
      "applications",
      { id: APPLICATION_ID },
    );
    expect(updatedApplication.status).toBe("approved");
    expect(updatedApplication.reviewed_at).not.toBeNull();

    const { data: updatedDeal } = await dataProvider.getOne<Deal>("deals", {
      id: DEAL_ID,
    });
    expect(updatedDeal.stage).toBe("approved");
    expect(updatedDeal.outcome).toBeNull();

    const { data: updatedTask } = await dataProvider.getOne<Task>("tasks", {
      id: TASK_ID,
    });
    expect(updatedTask.done_date).not.toBeNull();
    expect(updatedTask.status).toBe("completed");

    const { total: enrollmentCount } = await dataProvider.getList(
      "enrollments",
      {
        filter: { opportunity_id: DEAL_ID },
        pagination: { page: 1, perPage: 10 },
        sort: { field: "id", order: "ASC" },
      },
    );
    expect(enrollmentCount).toBe(0);
  });

  it("does not create a duplicate Opportunity on Approve", async () => {
    const { dataProvider, application } = buildFixtures();

    await reviewApplication({
      dataProvider,
      application,
      outcome: "approved",
    });

    const { total: dealCount } = await dataProvider.getList("deals", {
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(dealCount).toBe(1);
  });

  it("Needs Higher Care: Application records the outcome, Opportunity exits the active pipeline, Contact is not DNE, review task completes", async () => {
    const { dataProvider, application } = buildFixtures();

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "needs_higher_care",
    });
    expect(result).toEqual({ applied: true });

    const { data: updatedApplication } = await dataProvider.getOne<Application>(
      "applications",
      { id: APPLICATION_ID },
    );
    expect(updatedApplication.status).toBe("needs_higher_care");

    const { data: updatedDeal } = await dataProvider.getOne<Deal>("deals", {
      id: DEAL_ID,
    });
    expect(updatedDeal.outcome).toBe("needs_higher_care");
    // Stage is deliberately left untouched — outcome alone signals "exited".
    expect(updatedDeal.stage).toBe("application_received");

    const { data: contact } = await dataProvider.getOne("contacts", {
      id: CONTACT_ID,
    });
    expect(contact.sales_eligibility).toBe("normal");

    const { data: updatedTask } = await dataProvider.getOne<Task>("tasks", {
      id: TASK_ID,
    });
    expect(updatedTask.status).toBe("completed");
  });

  it("Not Fit: correct Application outcome, Opportunity exits, Contact remains non-DNE, review task completes", async () => {
    const { dataProvider, application } = buildFixtures();

    await reviewApplication({
      dataProvider,
      application,
      outcome: "not_fit",
    });

    const { data: updatedApplication } = await dataProvider.getOne<Application>(
      "applications",
      { id: APPLICATION_ID },
    );
    expect(updatedApplication.status).toBe("not_fit");

    const { data: updatedDeal } = await dataProvider.getOne<Deal>("deals", {
      id: DEAL_ID,
    });
    expect(updatedDeal.outcome).toBe("not_fit");

    const { data: contact } = await dataProvider.getOne("contacts", {
      id: CONTACT_ID,
    });
    expect(contact.sales_eligibility).toBe("normal");

    const { data: updatedTask } = await dataProvider.getOne<Task>("tasks", {
      id: TASK_ID,
    });
    expect(updatedTask.status).toBe("completed");
  });

  it("Do Not Engage: Contact Sales Eligibility becomes Do Not Engage, Opportunity exits, review task completes", async () => {
    const { dataProvider, application } = buildFixtures();

    const result = await reviewApplication({
      dataProvider,
      application,
      outcome: "do_not_engage",
    });
    expect(result).toEqual({ applied: true });

    const { data: updatedApplication } = await dataProvider.getOne<Application>(
      "applications",
      { id: APPLICATION_ID },
    );
    expect(updatedApplication.status).toBe("do_not_engage");

    const { data: updatedDeal } = await dataProvider.getOne<Deal>("deals", {
      id: DEAL_ID,
    });
    expect(updatedDeal.outcome).toBe("lost");
    expect(updatedDeal.owner_decision).toBe("do_not_engage");

    const { data: contact } = await dataProvider.getOne("contacts", {
      id: CONTACT_ID,
    });
    expect(contact.sales_eligibility).toBe("do_not_engage");

    const { data: updatedTask } = await dataProvider.getOne<Task>("tasks", {
      id: TASK_ID,
    });
    expect(updatedTask.status).toBe("completed");
  });

  it("is idempotent: a second review call against an already-reviewed Application is a no-op", async () => {
    const { dataProvider, application } = buildFixtures();

    const first = await reviewApplication({
      dataProvider,
      application,
      outcome: "approved",
    });
    expect(first).toEqual({ applied: true });

    // Simulate a stale UI still holding the pre-review Application record
    // (e.g. a second browser tab) attempting a different outcome.
    const second = await reviewApplication({
      dataProvider,
      application,
      outcome: "not_fit",
    });
    expect(second).toEqual({ applied: false, reason: "already-reviewed" });

    const { data: updatedApplication } = await dataProvider.getOne<Application>(
      "applications",
      { id: APPLICATION_ID },
    );
    // The first (Approved) decision stands; the stale second call never
    // overwrote it.
    expect(updatedApplication.status).toBe("approved");

    const { data: updatedDeal } = await dataProvider.getOne<Deal>("deals", {
      id: DEAL_ID,
    });
    expect(updatedDeal.stage).toBe("approved");
  });
});
