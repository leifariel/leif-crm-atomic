import { describe, expect, test } from "vitest";

import {
  computeFutureOpenings,
  computeIndividualCapacity,
  type SlotEnrollment,
} from "./individualCapacity";
import { weeklyCalendar } from "./testCalendar";
import { weekCapacities } from "./weekCapacity";

const NOW = new Date("2026-09-21T12:00:00Z");
const MAX = 12;

// 40 weeks from Monday 2026-09-07 — enough for several full containers.
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

describe("which Enrollments consume a slot", () => {
  test("a container that has started and not finished consumes one", () => {
    const capacity = computeIndividualCapacity(
      [enrollment()],
      MAX,
      CALENDAR,
      NOW,
    );
    expect(capacity.active).toBe(1);
  });

  test.each(["completed", "withdrawn", "ended"] as const)(
    "a %s container consumes nothing",
    (status) => {
      const capacity = computeIndividualCapacity(
        [enrollment({ status }), enrollment()],
        MAX,
        CALENDAR,
        NOW,
      );
      expect(capacity.active).toBe(1);
    },
  );

  test("an agreed container that has not started yet is committed, NOT active", () => {
    // The original bug: six people who had agreed to start in October and
    // November were added to the twelve Leif was working with, and the
    // dashboard reported "18 / 12 active".
    const capacity = computeIndividualCapacity(
      [
        ...Array.from({ length: 12 }, () => enrollment()),
        ...Array.from({ length: 6 }, () =>
          enrollment({ start_date: "2026-11-09" }),
        ),
      ],
      MAX,
      CALENDAR,
      NOW,
    );
    expect(capacity.active).toBe(12);
    expect(capacity.committed).toHaveLength(6);
    expect(capacity.overCapacityBy).toBe(0);
  });

  test("a container starting TODAY is active, not committed", () => {
    const capacity = computeIndividualCapacity(
      [enrollment({ start_date: "2026-09-21" })],
      MAX,
      CALENDAR,
      NOW,
    );
    expect(capacity.active).toBe(1);
    expect(capacity.committed).toHaveLength(0);
  });

  test("a live container with no Start Date still counts, and cannot be ended", () => {
    const capacity = computeIndividualCapacity(
      [enrollment({ start_date: null, start_date_source: null })],
      MAX,
      CALENDAR,
      NOW,
    );
    expect(capacity.active).toBe(1);
    expect(capacity.unknownEnd).toHaveLength(1);
    // Not a calendar problem — a missing decision.
    expect(capacity.needsCalendar).toHaveLength(0);
  });
});

describe("over capacity", () => {
  test("never reports negative openings — it reports being over", () => {
    const capacity = computeIndividualCapacity(
      Array.from({ length: 14 }, () => enrollment()),
      MAX,
      CALENDAR,
      NOW,
    );
    expect(capacity.overCapacityBy).toBe(2);
    expect(capacity.openings).toEqual({
      status: "known",
      openings: 0,
      peakOccupancy: 14,
    });
  });

  test("openings is unknown, not zero, when the Offer has no ceiling", () => {
    const capacity = computeIndividualCapacity(
      [enrollment()],
      null,
      CALENDAR,
      NOW,
    );
    expect(capacity.openings).toBeNull();
  });
});

describe("an opening needs room AND a calendar", () => {
  test("an empty practice with a full calendar can take the whole ceiling", () => {
    const capacity = computeIndividualCapacity([], MAX, CALENDAR, NOW);
    expect(capacity.openings).toMatchObject({ status: "known", openings: 12 });
  });

  test("an empty practice with a short calendar can take NOBODY", () => {
    // The half a headroom-only calculation misses entirely. Twelve free
    // slots are worth nothing if the twelfth session week does not exist
    // to put anybody in.
    const capacity = computeIndividualCapacity(
      [],
      MAX,
      weeklyCalendar("2026-09-21", 8),
      NOW,
    );
    expect(capacity.openings).toEqual({
      status: "unknown",
      reason: "calendar_too_short",
      weeksScheduled: 8,
      weeksRequired: 12,
    });
  });

  test("a committed future start is subtracted from today's openings", () => {
    // Nine in the programme, three slots apparently free, four people
    // already booked to arrive. "3 openings" would invite overbooking.
    const capacity = computeIndividualCapacity(
      [
        ...Array.from({ length: 9 }, () => enrollment()),
        ...Array.from({ length: 4 }, () =>
          enrollment({ start_date: "2026-10-12" }),
        ),
      ],
      MAX,
      CALENDAR,
      NOW,
    );
    expect(capacity.active).toBe(9);
    expect(capacity.committed).toHaveLength(4);
    expect(capacity.openings).toMatchObject({ status: "known", openings: 0 });
  });

  test("a month reports its best WEEK, not its first day", () => {
    // Twelve containers all end in the week of 23 November.
    //
    // A client starting at the beginning of November overlaps every one of
    // them and is refused. A client starting on the 30th overlaps none,
    // and that is a week Leif could genuinely sell — so November IS an
    // opening, from the 30th.
    //
    // Evaluating a month only on its 1st reported "no opening in
    // November" and hid the sellable week inside it. Nothing about the
    // RULE changed here: safeOpeningsStartingOn still decides, and still
    // refuses the early weeks. Only the candidate dates did, from one
    // arbitrary day a month to the weeks Year Tracking actually contains.
    const capacity = computeIndividualCapacity(
      [
        ...Array.from({ length: 12 }, () =>
          enrollment({ start_date: "2026-09-07" }),
        ),
        enrollment({ start_date: "2027-01-04", name: "Arrives later" }),
      ],
      MAX,
      CALENDAR,
      NOW,
    );

    // The early weeks are still refused, one at a time.
    const weeks = weekCapacities(capacity, NOW);
    const early = weeks.find((week) => week.week.start === "2026-11-02");
    expect(early?.safeStart.answer).toMatchObject({
      status: "known",
      openings: 0,
    });

    const { months } = computeFutureOpenings(capacity, NOW);
    const november = months.find((month) => month.month === "2026-11");
    expect(november?.openings).toMatchObject({ status: "known", openings: 11 });
    // And the month says WHICH week, because a month is not a date Leif
    // can offer anybody.
    expect(november?.earliestSafeStart?.start).toBe("2026-11-30");

    const january = months.find((month) => month.month === "2027-01");
    expect(january?.openings).toMatchObject({ status: "known", openings: 11 });
  });
});

describe("a committed client gives their slot back", () => {
  test("their start AND their end are both in the ledger", () => {
    // The bug: only occupied containers were scanned for end dates, so a
    // future start was a permanent +1.
    const capacity = computeIndividualCapacity(
      [enrollment({ start_date: "2026-10-12", name: "Later" })],
      MAX,
      CALENDAR,
      NOW,
    );
    const { ledger } = computeFutureOpenings(capacity, NOW);
    expect(ledger.map((entry) => entry.kind)).toEqual(["start", "end"]);
  });

  test("a container whose end cannot be computed never frees its slot", () => {
    const capacity = computeIndividualCapacity(
      [enrollment({ start_date: "2026-10-12" })],
      MAX,
      weeklyCalendar("2026-09-07", 10),
      NOW,
    );
    const { ledger } = computeFutureOpenings(capacity, NOW);
    expect(ledger.map((entry) => entry.kind)).toEqual(["start"]);
    expect(capacity.needsCalendar).toHaveLength(1);
  });
});

describe("a client nobody has given a start week", () => {
  // Two questions that used to be one. "Year Tracking cannot reach their
  // twelfth week" and "nobody said when they begin" both left the end
  // unknown, so the page blamed the calendar for a missing decision and sent
  // Leif to sync a calendar that was already long enough.
  test("is its own answer, not a calendar problem", () => {
    const capacity = computeIndividualCapacity(
      [
        enrollment({ name: "Has a week" }),
        enrollment({
          name: "No week",
          start_date: null,
          start_date_source: null,
        }),
      ],
      MAX,
      CALENDAR,
      NOW,
    );

    expect(capacity.missingStartWeek.map((h) => h.name)).toEqual(["No week"]);
    // Still unknown-ended, because it is — but no longer described as a
    // calendar that runs out.
    expect(capacity.unknownEnd.map((h) => h.name)).toContain("No week");
    expect(capacity.needsCalendar.map((h) => h.name)).not.toContain("No week");
    // And not confused with a date Leif has not confirmed: they have no
    // date at all.
    expect(capacity.unconfirmedStartWeek.map((h) => h.name)).not.toContain(
      "No week",
    );
  });

  test("still holds a place, because not knowing cannot free capacity", () => {
    const withWeek = computeIndividualCapacity(
      [enrollment({ name: "Has a week" })],
      MAX,
      CALENDAR,
      NOW,
    );
    const withoutWeek = computeIndividualCapacity(
      [
        enrollment({ name: "Has a week" }),
        enrollment({
          name: "No week",
          start_date: null,
          start_date_source: null,
        }),
      ],
      MAX,
      CALENDAR,
      NOW,
    );

    // They count as occupying today, exactly as classifyEnrollment says.
    expect(withoutWeek.active).toBe(withWeek.active + 1);
    // And their container never ends, so any openings number is a floor.
    const holder = withoutWeek.missingStartWeek[0]!;
    expect(holder.end).toBeNull();
  });

  test("a date Leif has not confirmed stays a different question", () => {
    const capacity = computeIndividualCapacity(
      [
        enrollment({
          name: "Inferred",
          start_date: "2026-09-07",
          start_date_source: "session_derived",
        }),
      ],
      MAX,
      CALENDAR,
      NOW,
    );
    expect(capacity.unconfirmedStartWeek.map((h) => h.name)).toEqual([
      "Inferred",
    ]);
    expect(capacity.missingStartWeek).toHaveLength(0);
  });

  test("the future-openings view carries the same distinction", () => {
    const capacity = computeIndividualCapacity(
      [
        enrollment({
          name: "No week",
          start_date: null,
          start_date_source: null,
        }),
      ],
      MAX,
      CALENDAR,
      NOW,
    );
    const future = computeFutureOpenings(capacity, NOW);
    expect(future.missingStartWeek.map((h) => h.name)).toEqual(["No week"]);
  });
});
