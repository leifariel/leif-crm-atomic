import { describe, expect, it } from "vitest";

import { createDataProvider } from "../providers/fakerest/dataProvider";
import { createCrmDb, buildContact } from "@/test/StoryWrapper";
import type { Application, Deal, Offer } from "../types";
import { reviewApplication } from "./reviewApplication";

// The FakeRest half of "an approval never moves a sale backward". The real
// function is proven in e2e/approvalIsForwardOnly.spec.ts; this proves the
// mirror makes the same decision, so the demo and every FakeRest test see
// the shape production produces.

const STAMP = "2026-01-01T00:00:00.000Z";

const build = (stage: Deal["stage"]) => {
  const offer: Offer = {
    id: 1,
    name: "The Living Example",
    type: "individual",
    duration: "6 months",
    current_price: 4000,
    is_active: true,
    created_at: STAMP,
    updated_at: STAMP,
  };
  const deal: Deal = {
    id: 1,
    name: "Forward Only",
    contact_id: 1,
    offer_id: 1,
    cohort_id: null,
    stage,
    outcome: null,
    owner_decision: null,
    amount: 4000,
    created_at: STAMP,
    updated_at: STAMP,
    sales_id: 0,
    index: 0,
    stage_entered_at: STAMP,
  };
  const application: Application = {
    id: 1,
    contact_id: 1,
    opportunity_id: 1,
    source: "public_form",
    status: "pending",
    submitted_at: STAMP,
    reviewed_at: null,
    raw_answers: {},
    summary: null,
    created_at: STAMP,
    updated_at: STAMP,
  };
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [buildContact({ id: 1 })],
      offers: [offer],
      offer_payment_options: [],
      cohorts: [],
      deals: [deal],
      applications: [application],
      enrollments: [],
      tasks: [],
    }),
    silent: true,
    latency: 0,
  });
  return { dataProvider, application };
};

const approve = async (stage: Deal["stage"]) => {
  const { dataProvider, application } = build(stage);
  const result = await reviewApplication({
    dataProvider,
    application,
    outcome: "approved",
  });
  const { data: deal } = await dataProvider.getOne<Deal>("deals", { id: 1 });
  const { data: app } = await dataProvider.getOne<Application>("applications", {
    id: 1,
  });
  const { data: events } = await dataProvider.getList("deal_stage_events", {
    filter: { opportunity_id: 1 },
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });
  return { result, deal, app, events };
};

describe("an approval never moves a sale backward (mirror)", () => {
  it.each(["interested", "application_received"] as const)(
    "%s advances to approved",
    async (stage) => {
      const { result, deal, app } = await approve(stage);
      expect(result).toEqual({ applied: true });
      expect(deal.stage).toBe("approved");
      expect(app.status).toBe("approved");
    },
  );

  it.each(["approved", "call_booked", "decision", "won"] as const)(
    "%s keeps its stage, with no stage change recorded",
    async (stage) => {
      const { result, deal, app, events } = await approve(stage);
      expect(result).toEqual({ applied: true });
      expect(deal.stage).toBe(stage);
      expect(deal.stage_entered_at).toBe(STAMP);
      expect(app.status).toBe("approved");
      expect(events.filter((e) => e.stage === "approved")).toHaveLength(
        stage === "approved" ? events.length : 0,
      );
    },
  );
});
