import { describe, expect, it } from "vitest";

import { createDataProvider } from "./dataProvider";
import { createCrmDb, buildContact } from "@/test/StoryWrapper";
import type {
  Contact,
  Deal,
  Enrollment,
  Offer,
  WaitlistEntry,
} from "../../types";

// Empirical proof that the derived relationship fields (Contacts UX
// cleanup pass) actually reach what a real "contacts" getList call
// returns and can be filtered on — not just that
// computeContactRelationshipFields's own math is right in isolation.
// contactRelationshipFields.ts's own header explains why this can't be a
// direct `db` mutation (ra-data-fakerest deep-clones on construction).

const leOffer: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const gyuOffer: Offer = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 1400,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const buildDeal = (overrides: Partial<Deal>): Deal => ({
  pricing_mode: "standard",
  id: 1,
  name: "Test",
  contact_id: 1,
  offer_id: leOffer.id,
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
});

describe("contacts getList — derived relationship fields (FakeRest)", () => {
  it("attaches offer_ids and is_current_client and returns them from a real getList call", async () => {
    const contact = buildContact({ id: 1 });
    const deal = buildDeal({ id: 10, contact_id: 1, offer_id: gyuOffer.id });
    const enrollment: Enrollment = {
      id: 1,
      opportunity_id: 10,
      onboarding_tracking: "tracked" as const,
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    const dataProvider = createDataProvider({
      db: createCrmDb({
        contacts: [contact],
        offers: [leOffer, gyuOffer],
        offer_payment_options: [],
        cohorts: [],
        deals: [deal],
        enrollments: [enrollment],
        applications: [],
        waitlist_entries: [],
      } as any),
      silent: true,
      latency: 0,
    });

    const { data } = await dataProvider.getList<Contact>("contacts", {
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
      filter: {},
    });

    expect(data).toHaveLength(1);
    expect(data[0]!.offer_ids).toEqual([gyuOffer.id]);
    expect(data[0]!.is_current_client).toBe(true);
    expect(data[0]!.is_past_client).toBe(false);
  });

  it("supports filtering by the derived is_on_waitlist field, matching the ToggleFilterButton pattern used elsewhere", async () => {
    const onWaitlist = buildContact({ id: 1, first_name: "Waiting" });
    const notOnWaitlist = buildContact({ id: 2, first_name: "NotWaiting" });
    const entry: WaitlistEntry = {
      id: 1,
      contact_id: 1,
      offer_id: leOffer.id,
      cohort_id: null,
      status: "waiting",
      joined_at: "2026-01-01T00:00:00.000Z",
      desired_timing: null,
      notes: null,
      priority: null,
      source: null,
      invited_at: null,
      converted_at: null,
      converted_opportunity_id: null,
      removed_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    const dataProvider = createDataProvider({
      db: createCrmDb({
        contacts: [onWaitlist, notOnWaitlist],
        offers: [leOffer, gyuOffer],
        offer_payment_options: [],
        cohorts: [],
        deals: [],
        enrollments: [],
        applications: [],
        waitlist_entries: [entry],
      } as any),
      silent: true,
      latency: 0,
    });

    const { data } = await dataProvider.getList<Contact>("contacts", {
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
      filter: { is_on_waitlist: true },
    });

    expect(data).toHaveLength(1);
    expect(data[0]!.first_name).toBe("Waiting");
  });

  // "ON WAITLIST" MEANS STILL WAITING TO BE INVITED.
  //
  // THE BUG THIS EXISTS FOR. This field read {waiting, invited} — the
  // place-held set that mirrors the database's partial unique index — so
  // after the first real invitation batches the Contacts "Waitlist" filter
  // returned 115 people in production where 61 were genuinely waiting. The
  // 54 who had just been invited were still counted as waiting for an
  // invitation they had already been sent.
  //
  // Mirrors contacts_summary; migration 20261011200000 is the same change
  // against real Postgres.
  it.each([
    { label: "only waiting", statuses: ["waiting"], expected: true },
    { label: "only invited", statuses: ["invited"], expected: false },
    { label: "only converted", statuses: ["converted"], expected: false },
    { label: "only removed", statuses: ["removed"], expected: false },
    {
      label: "invited before, waiting again now",
      statuses: ["invited", "waiting"],
      expected: true,
    },
    {
      label: "converted, with nothing live",
      statuses: ["converted", "removed"],
      expected: false,
    },
  ])(
    "a Contact with $label is on the waitlist: $expected",
    async ({ statuses, expected }) => {
      const contact = buildContact({ id: 1, first_name: "Subject" });
      const entries: WaitlistEntry[] = statuses.map((status, index) => ({
        id: index + 1,
        contact_id: 1,
        offer_id: leOffer.id,
        cohort_id: null,
        status: status as WaitlistEntry["status"],
        joined_at: `2026-01-0${index + 1}T00:00:00.000Z`,
        desired_timing: null,
        notes: null,
        priority: null,
        source: null,
        invited_at: status === "invited" ? "2026-02-01T00:00:00.000Z" : null,
        converted_at: null,
        converted_opportunity_id: null,
        removed_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }));

      const dataProvider = createDataProvider({
        db: createCrmDb({
          contacts: [contact],
          offers: [leOffer, gyuOffer],
          waitlist_entries: entries,
        } as any),
        silent: true,
        latency: 0,
      });

      const { data } = await dataProvider.getList<Contact>("contacts", {
        pagination: { page: 1, perPage: 10 },
        sort: { field: "id", order: "ASC" },
        filter: { is_on_waitlist: true },
      });

      expect(data).toHaveLength(expected ? 1 : 0);

      // Whatever the filter says, every episode is still on record — the
      // history is what Contact-side surfaces read.
      const { data: kept } = await dataProvider.getList("waitlist_entries", {
        pagination: { page: 1, perPage: 10 },
        sort: { field: "id", order: "ASC" },
        filter: { contact_id: 1 },
      });
      expect(kept).toHaveLength(statuses.length);
      expect(kept.map((row) => row.status)).toEqual(statuses);
    },
  );

  it("supports filtering Offer History via the array-containment operator (offer_ids@cs), the same pattern the existing tags filter already uses", async () => {
    const leContact = buildContact({ id: 1, first_name: "LEOnly" });
    const gyuContact = buildContact({ id: 2, first_name: "GYUOnly" });
    const leDeal = buildDeal({ id: 10, contact_id: 1, offer_id: leOffer.id });
    const gyuDeal = buildDeal({ id: 11, contact_id: 2, offer_id: gyuOffer.id });

    const dataProvider = createDataProvider({
      db: createCrmDb({
        contacts: [leContact, gyuContact],
        offers: [leOffer, gyuOffer],
        offer_payment_options: [],
        cohorts: [],
        deals: [leDeal, gyuDeal],
        enrollments: [],
        applications: [],
        waitlist_entries: [],
      } as any),
      silent: true,
      latency: 0,
    });

    const { data } = await dataProvider.getList<Contact>("contacts", {
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
      filter: { "offer_ids@cs": `{${gyuOffer.id}}` },
    });

    expect(data).toHaveLength(1);
    expect(data[0]!.first_name).toBe("GYUOnly");
  });
});

describe("Applications reach their Contact without requiring a Deal", () => {
  // Gate A found 88 legitimate historical Applications from people who
  // never became a sales Opportunity. While an Application's only route to
  // a person was opportunity_id -> deals.contact_id, those people's
  // Applications were stored but unreachable. Proven here through
  // has_applied, which is derived from the Contact's Applications.
  it("marks a Contact as having applied when their only Application has no Deal at all", async () => {
    const applicantWithNoDeal = buildContact({ id: 1, first_name: "Dealless" });

    const dataProvider = createDataProvider({
      db: createCrmDb({
        contacts: [applicantWithNoDeal],
        offers: [leOffer, gyuOffer],
        offer_payment_options: [],
        cohorts: [],
        deals: [],
        enrollments: [],
        applications: [
          {
            id: 500,
            contact_id: 1,
            // No Opportunity: none existed, and none is fabricated.
            opportunity_id: null,
            onboarding_tracking: "tracked" as const,
            offer_id: gyuOffer.id,
            intended_cohort_id: null,
            status: "pending",
            source: "historical_import",
            submitted_at: "2026-08-01T10:00:00.000Z",
            reviewed_at: null,
            raw_answers: {},
            summary: null,
            created_at: "2026-08-01T10:00:00.000Z",
            updated_at: "2026-08-01T10:00:00.000Z",
          },
        ],
        waitlist_entries: [],
      } as any),
      silent: true,
      latency: 0,
    });

    const { data } = await dataProvider.getList<Contact>("contacts", {
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
      filter: {},
    });

    expect(data).toHaveLength(1);
    expect(data[0]!.has_applied).toBe(true);

    // And no Deal was conjured up to make that reachability work.
    const { data: deals } = await dataProvider.getList<Deal>("deals", {
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
      filter: {},
    });
    expect(deals).toHaveLength(0);
  });
});
