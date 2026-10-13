import { describe, expect, it } from "vitest";

import { createManualApplication } from "./createManualApplication";
import { createDataProvider } from "../providers/fakerest/dataProvider";
import { createCrmDb, buildContact } from "@/test/StoryWrapper";
import type { Application, Cohort, Deal, Offer, WaitlistEntry } from "../types";

// A MANUAL APPLICATION SPENDS THE WAITLIST PLACE, EVEN WHEN THE OPPORTUNITY
// IT REUSES IS STILL AT INTERESTED.
//
// Requirement M of §4b Phase 2A0, and the one that had structural proof only.
//
// Phase 2A0 split one rule into two. The AUTOMATIC rule — the
// on_deal_waitlist_sync trigger and its mirror behind the "deals" lifecycle
// hooks — now converts a place only from stage application_received onward,
// so that creating an Interested Opportunity when an invitation is delivered
// does not silently spend everybody's place. The EXPLICIT rule converts
// regardless of stage, because the business event itself spent the place.
//
// A manual application is the explicit kind: Leif is recording that this
// person applied. But when it REUSES an existing Opportunity it writes
// nothing to "deals", so the automatic hook never fires for that branch —
// and if that Opportunity is still at Interested, the automatic rule would
// not have converted anything even if it had. The explicit call is the only
// thing standing between "Leif recorded an application" and "they are still
// sitting on the waitlist".
//
// These go through createManualApplication, the boundary the app actually
// calls, rather than convertCompatibleWaitlistEntries directly — the point
// is the wiring, not the helper.

const CONTACT_ID = 1;
const LE = 1;
const GYU = 2;
const SEPTEMBER = 1;
const NOVEMBER = 2;

const offer = (id: number, name: string, type: Offer["type"]): Offer => ({
  id,
  name,
  type,
  duration: "4 months",
  current_price: 4000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const cohort = (id: number, name: string): Cohort => ({
  id,
  offer_id: GYU,
  name,
  status: "applications_open",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const buildEntry = (overrides: Partial<WaitlistEntry> = {}): WaitlistEntry => ({
  id: 1,
  contact_id: CONTACT_ID,
  offer_id: LE,
  cohort_id: null,
  status: "invited",
  joined_at: "2026-01-01T00:00:00.000Z",
  desired_timing: null,
  notes: null,
  priority: null,
  source: null,
  invited_at: "2026-02-01T00:00:00.000Z",
  converted_at: null,
  converted_opportunity_id: null,
  removed_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** An Opportunity already running, deliberately still at Interested. */
const buildDeal = (overrides: Partial<Deal> = {}): Deal =>
  ({
    id: 9,
    name: "Ada Lovelace — The Living Example",
    contact_id: CONTACT_ID,
    offer_id: LE,
    cohort_id: null,
    stage: "interested",
    outcome: null,
    amount: 4000,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    sales_id: 0,
    index: 0,
    stage_entered_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as Deal;

const buildProvider = (entries: WaitlistEntry[], deals: Deal[] = []) =>
  createDataProvider({
    db: createCrmDb({
      contacts: [buildContact({ id: CONTACT_ID })],
      offers: [
        offer(LE, "The Living Example", "individual"),
        offer(GYU, "Growing Yourself Up", "group"),
      ],
      cohorts: [cohort(SEPTEMBER, "September"), cohort(NOVEMBER, "November")],
      deals,
      waitlist_entries: entries,
      applications: [],
    }),
    silent: true,
    latency: 0,
  });

const readEntry = async (
  dataProvider: ReturnType<typeof buildProvider>,
  id = 1,
) =>
  (await dataProvider.getOne<WaitlistEntry>("waitlist_entries", { id })).data;

const allDeals = async (dataProvider: ReturnType<typeof buildProvider>) =>
  (
    await dataProvider.getList<Deal>("deals", {
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
      filter: {},
    })
  ).data;

describe("a manual application converts the waitlist place it belongs to", () => {
  it("M1. reuses the Interested Opportunity and still converts the invited entry", async () => {
    const existing = buildDeal();
    const dataProvider = buildProvider(
      [buildEntry({ status: "invited" })],
      [existing],
    );

    const result = await createManualApplication(dataProvider, {
      contactId: CONTACT_ID,
      offerId: LE,
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    // The same Opportunity, not a second one beside it.
    expect(result.reusedOpportunity).toBe(true);
    expect(result.opportunityId).toBe(existing.id);
    expect(await allDeals(dataProvider)).toHaveLength(1);

    // The application hangs off that Opportunity.
    const { data: applications } = await dataProvider.getList<Application>(
      "applications",
      {
        pagination: { page: 1, perPage: 10 },
        sort: { field: "id", order: "ASC" },
        filter: {},
      },
    );
    expect(applications).toHaveLength(1);
    expect(applications[0]!.id).toBe(result.applicationId);
    expect(applications[0]!.opportunity_id).toBe(existing.id);
    expect(applications[0]!.contact_id).toBe(CONTACT_ID);

    // And the place is spent, attributed to the Opportunity that was reused
    // — which is still sitting at Interested, so only the explicit call can
    // have done this.
    const entry = await readEntry(dataProvider);
    expect(entry.status).toBe("converted");
    expect(entry.converted_opportunity_id).toBe(existing.id);
    expect(entry.converted_at).not.toBeNull();
  });

  it("M2. converts a waiting entry the same way", async () => {
    const existing = buildDeal();
    const dataProvider = buildProvider(
      [buildEntry({ status: "waiting" })],
      [existing],
    );

    const result = await createManualApplication(dataProvider, {
      contactId: CONTACT_ID,
      offerId: LE,
    });

    expect(result.status).toBe("created");
    const entry = await readEntry(dataProvider);
    expect(entry.status).toBe("converted");
    expect(entry.converted_opportunity_id).toBe(existing.id);
  });

  it("M3. leaves another programme's waitlist place alone", async () => {
    // Waiting for Growing Yourself Up; the application is for The Living
    // Example. Different journeys (HANDOFF §4b).
    const existing = buildDeal();
    const dataProvider = buildProvider(
      [buildEntry({ offer_id: GYU, status: "invited" })],
      [existing],
    );

    await createManualApplication(dataProvider, {
      contactId: CONTACT_ID,
      offerId: LE,
    });

    const entry = await readEntry(dataProvider);
    expect(entry.status).toBe("invited");
    expect(entry.converted_at).toBeNull();
  });

  it("M4. leaves a place held for a different round alone", async () => {
    // A November-specific place is not satisfied by a September application.
    const existing = buildDeal({
      id: 11,
      offer_id: GYU,
      cohort_id: SEPTEMBER,
    });
    const dataProvider = buildProvider(
      [buildEntry({ offer_id: GYU, cohort_id: NOVEMBER, status: "invited" })],
      [existing],
    );

    const result = await createManualApplication(dataProvider, {
      contactId: CONTACT_ID,
      offerId: GYU,
      cohortId: SEPTEMBER,
    });

    expect(result.status).toBe("created");
    const entry = await readEntry(dataProvider);
    expect(entry.status).toBe("invited");
    expect(entry.converted_at).toBeNull();
  });

  it("M5. never rewrites a removed or already-converted place", async () => {
    const existing = buildDeal();
    const converted = buildEntry({
      id: 1,
      status: "converted",
      converted_at: "2026-03-01T00:00:00.000Z",
      converted_opportunity_id: 99,
    });
    const removed = buildEntry({
      id: 2,
      status: "removed",
      removed_at: "2026-03-01T00:00:00.000Z",
    });
    const dataProvider = buildProvider([converted, removed], [existing]);

    await createManualApplication(dataProvider, {
      contactId: CONTACT_ID,
      offerId: LE,
    });

    const first = await readEntry(dataProvider, 1);
    expect(first.status).toBe("converted");
    // Still attributed to whatever converted it, with its original moment.
    expect(first.converted_opportunity_id).toBe(99);
    expect(first.converted_at).toBe("2026-03-01T00:00:00.000Z");

    const second = await readEntry(dataProvider, 2);
    expect(second.status).toBe("removed");
    expect(second.converted_at).toBeNull();
  });
});
