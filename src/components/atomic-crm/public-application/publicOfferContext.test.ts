import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDataProvider } from "../providers/fakerest/dataProvider";
import { createCrmDb } from "@/test/StoryWrapper";
import type { Cohort, Offer } from "../types";
import {
  getGroupCohortContext,
  getLivingExampleOfferContext,
} from "./publicOfferContext";

const buildDataProvider = (offers: Offer[], cohorts: Cohort[] = []) =>
  createDataProvider({
    db: createCrmDb({
      contacts: [],
      offers,
      offer_payment_options: [],
      cohorts,
      deals: [],
      applications: [],
      enrollments: [],
      tasks: [],
      waitlist_entries: [],
    } as any),
    silent: true,
    latency: 0,
  });

const individualOffer: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  max_active_clients: 5,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const groupOffer: Offer = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 1400,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("getLivingExampleOfferContext", () => {
  it("discovers the individual Offer with a capacity ceiling, never a hardcoded id", async () => {
    const dataProvider = buildDataProvider([individualOffer, groupOffer]);
    const context = await getLivingExampleOfferContext(dataProvider);
    expect(context).toEqual({
      kind: "individual",
      offerId: 1,
      offerName: "The Living Example",
      isAccepting: true,
    });
  });

  it("returns not-found when no individual offer with a capacity ceiling exists", async () => {
    const dataProvider = buildDataProvider([groupOffer]);
    const context = await getLivingExampleOfferContext(dataProvider);
    expect(context).toEqual({ kind: "not-found" });
  });
});

// THE CLOCK.
//
// "Is this cohort still taking applications" is a question about today, and
// the fixtures below answer it with fixed calendar dates. This block used to
// take `today` from whatever machine ran it, so a window that closed on
// 2026-09-30 was open all through September and shut by itself at midnight on
// 1 October — turning a green suite red with no commit in between. That is
// exactly what happened, and it is the class 23fd5cf6 and
// postponeTaskDate.test.ts already fixed elsewhere.
//
// Only the INSTANT is pinned, not the timezone: publicOfferContext asks
// getDenverDateString(), which names America/Denver explicitly, so the
// ambient zone cannot change the answer. Faking Date alone — never the whole
// timer API — leaves promises and the data provider running normally.
//
// Moving the fixture dates further into the future would have been the same
// bug with a longer fuse.
const FROZEN_NOW = new Date("2026-09-15T12:00:00Z");

describe("getGroupCohortContext", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns group-open for an open cohort within its application window", async () => {
    const cohort: Cohort = {
      id: 1,
      offer_id: 2,
      name: "September Cohort",
      status: "applications_open",
      applications_open_at: "2026-08-01",
      applications_close_at: "2026-09-30",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const dataProvider = buildDataProvider([groupOffer], [cohort]);
    const context = await getGroupCohortContext(dataProvider, "1");
    expect(context).toEqual({
      kind: "group-open",
      offerId: 2,
      offerName: "Growing Yourself Up",
      cohortId: 1,
      cohortName: "September Cohort",
      isAccepting: true,
    });
  });

  it("returns group-closed for a cohort not marked applications_open", async () => {
    const cohort: Cohort = {
      id: 1,
      offer_id: 2,
      name: "September Cohort",
      status: "applications_closed",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const dataProvider = buildDataProvider([groupOffer], [cohort]);
    const context = await getGroupCohortContext(dataProvider, "1");
    expect(context.kind).toBe("group-closed");
  });

  it("returns not-found for a nonexistent cohort id", async () => {
    const dataProvider = buildDataProvider([groupOffer], []);
    const context = await getGroupCohortContext(dataProvider, "999");
    expect(context).toEqual({ kind: "not-found" });
  });
});
