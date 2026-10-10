import { describe, expect, it } from "vitest";

import * as app from "@/components/atomic-crm/sessions/sessionFallsInSlotWeek";
import * as edge from "../../supabase/functions/_shared/sessionFallsInSlotWeek";

// "DID THIS SESSION HAPPEN THAT WEEK?" — ONE ANSWER, TWO COPIES.
//
// The question is asked in the browser and in the calendar sync, and Edge
// Functions cannot import from src/, so the authority exists twice. Twice
// is how it went wrong the first time: six call sites each did their own
// instant arithmetic, and a session on the last evening of a week fell
// outside it. Leif was told four clients had skipped a week they had all
// attended.
//
// So the vectors live HERE, once, and run through BOTH copies. A vector
// that disagrees between them fails, and so does a vector either copy gets
// wrong — the two cannot drift apart, and cannot drift together.
//
// Denver, because that is where the CRM lives. window_end is EXCLUSIVE,
// because that is how Google Calendar states an all-day range and the
// Year Tracking weeks come from one.

const WEEK = { window_start: "2026-10-04", window_end: "2026-10-08" };

type Vector = {
  readonly why: string;
  readonly at: string;
  readonly slot: { window_start: string | null; window_end: string | null };
  readonly inWeek: boolean;
};

const VECTORS: readonly Vector[] = [
  // THE PRODUCTION FAILURE. 6pm Denver on the last day of the week is
  // already tomorrow in UTC, which is precisely what the old comparison
  // tripped over.
  {
    why: "Wednesday 7 October, 6pm in Denver — the exact false negative",
    at: "2026-10-08T00:00:00.000Z",
    slot: WEEK,
    inWeek: true,
  },
  {
    why: "late on the last night of the week, 11pm Denver",
    at: "2026-10-08T05:00:00.000Z",
    slot: WEEK,
    inWeek: true,
  },
  {
    why: "half past midnight on the first day, Denver",
    at: "2026-10-04T06:30:00.000Z",
    slot: WEEK,
    inWeek: true,
  },
  {
    why: "the evening BEFORE the week started — 8pm Denver on the 3rd",
    at: "2026-10-04T02:00:00.000Z",
    slot: WEEK,
    inWeek: false,
  },
  {
    why: "the morning AFTER it ended — window_end is exclusive",
    at: "2026-10-08T14:00:00.000Z",
    slot: WEEK,
    inWeek: false,
  },
  // DST. Denver leaves daylight saving on 1 November 2026, so the offset
  // changes inside this window. A rule built on calendar days does not
  // care, and these two vectors are how we know it does not.
  {
    why: "half past midnight on 1 November, the day the clocks go back",
    at: "2026-11-01T06:30:00.000Z",
    slot: { window_start: "2026-11-01", window_end: "2026-11-08" },
    inWeek: true,
  },
  {
    why: "11pm Denver on 31 October — already 1 November in UTC, still out",
    at: "2026-11-01T05:00:00.000Z",
    slot: { window_start: "2026-11-01", window_end: "2026-11-08" },
    inWeek: false,
  },
  {
    why: "a week with no dates answers no, rather than guessing",
    at: "2026-10-06T18:00:00.000Z",
    slot: { window_start: null, window_end: null },
    inWeek: false,
  },
];

describe("the one authority on whether a session belongs to a week", () => {
  it.each(VECTORS)("$why", ({ at, slot, inWeek }) => {
    const session = { scheduled_at: at, status: "booked", no_show_at: null };
    expect(app.sessionFallsInSlotWeek(session, slot)).toBe(inWeek);
    // THE SAME ANSWER, from the copy the calendar sync runs.
    expect(edge.sessionFallsInSlotWeek(session, slot)).toBe(inWeek);
  });

  it("agrees with itself on the calendar day, both sides", () => {
    for (const { at } of VECTORS) {
      expect(app.crmCalendarDate(at)).toBe(edge.crmCalendarDate(at));
    }
    // And says the day a person would say.
    expect(app.crmCalendarDate("2026-10-08T00:00:00.000Z")).toBe("2026-10-07");
  });
});

describe("an hour that did not happen is not the week's session", () => {
  const AT = "2026-10-08T00:00:00.000Z";

  it.each([
    { why: "cancelled", session: { status: "cancelled", no_show_at: null } },
    {
      why: "a no-show",
      session: { status: "booked", no_show_at: "2026-10-08T01:00:00.000Z" },
    },
  ])("does not count: $why", ({ session }) => {
    const row = { scheduled_at: AT, ...session };
    expect(app.sessionFallsInSlotWeek(row, WEEK)).toBe(false);
    expect(edge.sessionFallsInSlotWeek(row, WEEK)).toBe(false);
    // But it was still BOOKED in that week, which is a different question
    // and has its own answer.
    expect(app.sessionScheduledInSlotWeek(row, WEEK)).toBe(true);
    expect(edge.sessionScheduledInSlotWeek(row, WEEK)).toBe(true);
  });
});

describe("has the CRM's own day reached this date?", () => {
  // The same rule asked of a boundary rather than a week: "is this week
  // over?" and "has this period started?". Asking it of an instant is how
  // a week came to close six hours early in Denver.
  it.each([
    {
      why: "6pm Denver on the 7th has NOT reached the 8th",
      now: "2026-10-08T00:00:00.000Z",
      boundary: "2026-10-08",
      reached: false,
    },
    {
      why: "midnight Denver on the 8th has",
      now: "2026-10-08T06:00:00.000Z",
      boundary: "2026-10-08",
      reached: true,
    },
    {
      why: "the first morning of a week has reached its own start",
      now: "2026-10-04T13:00:00.000Z",
      boundary: "2026-10-04",
      reached: true,
    },
    {
      why: "an unreadable instant answers no rather than guessing",
      now: "not a date",
      boundary: "2026-10-04",
      reached: false,
    },
  ])("$why", ({ now, boundary, reached }) => {
    expect(app.crmDayAtOrAfter(now, boundary)).toBe(reached);
    expect(edge.crmDayAtOrAfter(now, boundary)).toBe(reached);
  });
});
