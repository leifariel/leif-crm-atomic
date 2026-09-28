import { describe, expect, it } from "vitest";

import { createDataProvider } from "../providers/fakerest/dataProvider";
import { buildContact, createCrmDb } from "@/test/StoryWrapper";
import { setStartWeekOnAcceptance } from "./setStartWeekOnAcceptance";
import type { Deal, Enrollment, Offer } from "../types";

// Accepting the sale is the moment Leif knows whether the client is starting
// now or in six weeks. Asking then is the difference between a Start Week
// that exists and one that gets discovered missing a month later.
//
// What this must never do is fill it in for him.

const LE: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Offer;

const build = ({ withEnrollment = true }: { withEnrollment?: boolean } = {}) =>
  createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 3, first_name: "Nadia", last_name: "Okoro" }),
      ],
      offers: [LE],
      deals: [
        {
          id: 5,
          contact_id: 3,
          offer_id: 1,
          name: "Nadia Okoro",
          stage: "won",
          offer_name_snapshot: "The Living Example",
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z",
        } as unknown as Deal,
      ],
      enrollments: withEnrollment
        ? [
            {
              id: 7,
              opportunity_id: 5,
              status: "onboarding",
              onboarding_tracking: "tracked",
              start_date: null,
              start_date_source: null,
              end_date: null,
              created_at: "2026-08-01T00:00:00.000Z",
              updated_at: "2026-08-01T00:00:00.000Z",
            } as unknown as Enrollment,
          ]
        : [],
      enrollment_onboarding_items: [],
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

const enrollmentOf = async (dp: ReturnType<typeof createDataProvider>) => {
  const { data } = await dp.getOne<Enrollment>("enrollments", { id: 7 });
  return data;
};

describe("stating the start week as the sale is accepted", () => {
  it("records it as Leif's own, which is the only provenance capacity plans around", async () => {
    const dp = build();
    const result = await setStartWeekOnAcceptance(dp, {
      opportunityId: 5,
      startWeek: "2026-11-02",
    });
    expect(result.status).toBe("set");

    const enrollment = await enrollmentOf(dp);
    expect(enrollment.start_date).toBe("2026-11-02");
    expect(enrollment.start_date_source).toBe("owner");
  });

  it("writes nothing at all when he says he will set it later", async () => {
    const dp = build();
    const result = await setStartWeekOnAcceptance(dp, {
      opportunityId: 5,
      startWeek: null,
    });
    expect(result.status).toBe("left-unset");

    const enrollment = await enrollmentOf(dp);
    // No date, no source, and no second field invented to say "later" —
    // an Enrollment with no start_date already says exactly that.
    expect(enrollment.start_date ?? null).toBeNull();
    expect(enrollment.start_date_source ?? null).toBeNull();
  });

  it("never infers one from anything, however tempting", async () => {
    const dp = build();
    await setStartWeekOnAcceptance(dp, { opportunityId: 5, startWeek: null });
    const enrollment = await enrollmentOf(dp);
    // The Won date, the created date and today are all right there, and
    // none of them became a Start Week.
    expect(enrollment.start_date ?? null).toBeNull();
  });

  it("says so when the Enrollment is not there yet", async () => {
    const dp = build({ withEnrollment: false });
    const result = await setStartWeekOnAcceptance(dp, {
      opportunityId: 5,
      startWeek: "2026-11-02",
    });
    expect(result.status).toBe("no-enrollment");
  });

  it("is safe to repeat — the same statement, not a second one", async () => {
    const dp = build();
    await setStartWeekOnAcceptance(dp, {
      opportunityId: 5,
      startWeek: "2026-11-02",
    });
    await setStartWeekOnAcceptance(dp, {
      opportunityId: 5,
      startWeek: "2026-11-02",
    });
    const enrollment = await enrollmentOf(dp);
    expect(enrollment.start_date).toBe("2026-11-02");
    expect(enrollment.start_date_source).toBe("owner");

    const { total } = await dp.getList<Enrollment>("enrollments", {
      filter: { opportunity_id: 5 },
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(total).toBe(1);
  });

  it("lets a later statement change it, still as his own", async () => {
    const dp = build();
    await setStartWeekOnAcceptance(dp, {
      opportunityId: 5,
      startWeek: "2026-11-02",
    });
    await setStartWeekOnAcceptance(dp, {
      opportunityId: 5,
      startWeek: "2026-11-30",
    });
    const enrollment = await enrollmentOf(dp);
    expect(enrollment.start_date).toBe("2026-11-30");
    expect(enrollment.start_date_source).toBe("owner");
  });
});
