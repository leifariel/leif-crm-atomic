import { describe, expect, test } from "vitest";

import {
  computeIndividualCapacity,
  type SlotEnrollment,
} from "./individualCapacity";
import { slotPhaseOf } from "./slotOccupancy";
import { weeklyCalendar } from "./testCalendar";

// NO START WEEK = NO DATED CAPACITY CONSUMPTION.
//
// Todd Jacobsen is why this file exists. Won on The Living Example and
// onboarded on 2026-10-02, Enrollment 115, status `onboarding`, start_date
// NULL — and the programme read 13 / 12 active, over capacity, on a
// programme with twelve real clients. Worse, the openings view then lost a
// genuinely open week, because an active count above the ceiling leaves
// nothing to offer.
//
// The old rule said an Enrollment with no start_date is occupied, on the
// grounds that "hiding it would undercount a real person". That is the
// conservative floor, and it is the wrong trade: it reported a number that
// was not true of anybody, and it concealed a real opening. A commitment
// with no week is a commitment Leif still has to place — an attention
// state, not an occupancy. The compensating control already existed and is
// asserted here: missingStartWeek names them, and UpcomingOpeningsSection
// renders that list.
//
// What this must NOT do is start inferring a week. Nothing here derives a
// start from an onboarding date, a Won date, a payment or a booking.

const NOW = new Date("2026-09-21T12:00:00Z");
const MAX = 12;
const CALENDAR = weeklyCalendar("2026-09-07", 40);

let nextId = 1;
const enrollment = (
  overrides: Partial<SlotEnrollment> = {},
): SlotEnrollment => ({
  id: nextId++,
  status: "active",
  start_date: "2026-09-07",
  end_date: null,
  start_date_source: "owner",
  name: `Client ${nextId}`,
  contactId: nextId,
  ...overrides,
});

// Twelve real clients, all started, exactly at the ceiling.
const twelveActive = () =>
  Array.from({ length: 12 }, (_, index) =>
    enrollment({ start_date: "2026-09-07", name: `Active ${index + 1}` }),
  );

// Todd: onboarded, no week, nothing inferred.
const todd = () =>
  enrollment({
    status: "onboarding",
    start_date: null,
    start_date_source: null,
    name: "Todd Jacobsen",
  });

describe("an Enrollment with no start week", () => {
  test("is not occupying a slot", () => {
    expect(
      slotPhaseOf({ status: "onboarding", start_date: null, end_date: null }),
    ).toBe("unscheduled");
  });

  test("does not count toward active, on a programme already at its ceiling", () => {
    const capacity = computeIndividualCapacity(
      [...twelveActive(), todd()],
      MAX,
      CALENDAR,
      NOW,
    );
    // The defect this file was opened for: 13 / 12.
    expect(capacity.active).toBe(12);
    expect(capacity.overCapacityBy).toBe(0);
  });

  test("is named as needing a start week, so it is not merely hidden", () => {
    const capacity = computeIndividualCapacity(
      [...twelveActive(), todd()],
      MAX,
      CALENDAR,
      NOW,
    );
    expect(capacity.missingStartWeek.map((holder) => holder.name)).toEqual([
      "Todd Jacobsen",
    ]);
  });

  test("consumes no dated slot, so a real opening stays visible", () => {
    // Eleven started clients leave one place free. A twelfth commitment with
    // no week must not swallow it.
    const eleven = Array.from({ length: 11 }, (_, index) =>
      enrollment({ start_date: "2026-09-07", name: `Active ${index + 1}` }),
    );
    const withTodd = computeIndividualCapacity(
      [...eleven, todd()],
      MAX,
      CALENDAR,
      NOW,
    );
    const withoutTodd = computeIndividualCapacity(eleven, MAX, CALENDAR, NOW);
    expect(withTodd.active).toBe(11);
    // The openings answer is the same with and without him: he claims no week.
    expect(withTodd.openings).toEqual(withoutTodd.openings);
  });

  test("appears in neither the current nor the committed list", () => {
    const capacity = computeIndividualCapacity([todd()], MAX, CALENDAR, NOW);
    expect(capacity.occupied).toHaveLength(0);
    expect(capacity.committed).toHaveLength(0);
    expect(capacity.unscheduled.map((holder) => holder.name)).toEqual([
      "Todd Jacobsen",
    ]);
  });
});

describe("the phases that must not change", () => {
  test("a started container still occupies", () => {
    expect(
      slotPhaseOf({
        status: "active",
        start_date: "2026-09-07",
        end_date: null,
      }),
      // today is 2026-09-21 by the fixtures below
    ).toBe("occupied");
  });

  test("a stated future start is still a committed obligation", () => {
    const capacity = computeIndividualCapacity(
      [enrollment({ status: "onboarding", start_date: "2026-11-09" })],
      MAX,
      CALENDAR,
      NOW,
    );
    expect(capacity.active).toBe(0);
    expect(capacity.committed).toHaveLength(1);
    expect(capacity.unscheduled).toHaveLength(0);
  });

  test.each(["completed", "withdrawn", "ended"] as const)(
    "a %s container releases its slot even with no start week",
    (status) => {
      expect(slotPhaseOf({ status, start_date: null, end_date: null })).toBe(
        "released",
      );
    },
  );
});
