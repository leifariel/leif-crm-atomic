import { describe, expect, it } from "vitest";

import type { SalesCall } from "../types";
import { isPassedUnresolvedCall, passedUnresolvedCallFor } from "./callPassed";

// "Call passed" is the CRM noticing that nobody has told it what happened.
// It is not a no-show, it is not a stage, and computing it changes nothing.
//
// Sales Call Workflow Part 1, rules A/C/D/Q.

const NOW = new Date("2026-09-18T12:00:00.000Z").getTime();

const call = (overrides: Partial<SalesCall> = {}): SalesCall => ({
  id: 1,
  opportunity_id: 10,
  contact_id: 1,
  status: "booked",
  original_scheduled_at: "2026-09-17T15:00:00.000Z",
  scheduled_at: "2026-09-17T15:00:00.000Z",
  reschedule_count: 0,
  source: "manual",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("a passed call is a question, not an outcome", () => {
  it("C. a booked call whose time has passed with no outcome has passed", () => {
    expect(isPassedUnresolvedCall(call(), NOW)).toBe(true);
  });

  it("a future booking has not passed", () => {
    expect(
      isPassedUnresolvedCall(
        call({
          scheduled_at: "2026-09-19T15:00:00.000Z",
          original_scheduled_at: "2026-09-19T15:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("a completed call has not 'passed', however old it is", () => {
    // The whole badge exists to say "nobody has written this up". Once
    // somebody has, the premise is gone.
    expect(
      isPassedUnresolvedCall(
        call({
          status: "completed",
          attendance: "attended",
          attendance_recorded_at: "2026-09-17T16:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("a cancelled call has not 'passed' either", () => {
    expect(
      isPassedUnresolvedCall(
        call({ status: "cancelled", cancelled_at: "2026-09-16T10:00:00.000Z" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("T. a recorded no-show is an outcome, so it is not an unanswered question", () => {
    // Belt and braces: the schema moves a call off `booked` when attendance
    // lands, so this shape should be unreachable. If it ever occurs, an
    // outcome recorded must still read as an outcome.
    expect(
      isPassedUnresolvedCall(
        call({ attendance: "no_show", attendance_recorded_at: "x" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("a date-only historical call sorts at the end of its day, and can pass", () => {
    // callInstant() places a day-only call at 23:59 of its own day rather
    // than midnight, so "the 17th" does not jump ahead of 09:00 on the 17th.
    expect(
      isPassedUnresolvedCall(
        call({
          schedule_precision: "date_only",
          scheduled_at: null,
          original_scheduled_at: null,
          scheduled_on: "2026-09-17",
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("a call with no knowable time never 'passes'", () => {
    expect(
      isPassedUnresolvedCall(
        call({
          schedule_precision: "date_only",
          scheduled_at: null,
          original_scheduled_at: null,
          scheduled_on: undefined,
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("D/Q. computing it mutates nothing at all", () => {
    // The rule the badge exists to respect: the clock is not a lifecycle
    // authority. Reading it must not touch the row, the stage or attendance.
    const row = call();
    const before = JSON.stringify(row);

    expect(isPassedUnresolvedCall(row, NOW)).toBe(true);
    expect(passedUnresolvedCallFor(10, [row], NOW)).toBe(row);

    expect(JSON.stringify(row)).toBe(before);
    expect(row.attendance).toBeUndefined();
    expect(row.status).toBe("booked");
  });
});

describe("the Opportunity-level question", () => {
  it("finds the passed booked call for the right Opportunity", () => {
    const mine = call({ id: 1, opportunity_id: 10 });
    const theirs = call({ id: 2, opportunity_id: 11 });

    expect(passedUnresolvedCallFor(10, [mine, theirs], NOW)).toBe(mine);
    expect(passedUnresolvedCallFor(11, [mine, theirs], NOW)).toBe(theirs);
  });

  it("a rebooking after a passed call answers the question", () => {
    // The concluded call is history; the live booking is in the future, so
    // nothing is owed. This is the same "latest call wins" model the board
    // and the drawer share.
    const concluded = call({
      id: 1,
      status: "completed",
      attendance: "no_show",
    });
    const rebooked = call({
      id: 2,
      scheduled_at: "2026-09-25T15:00:00.000Z",
      original_scheduled_at: "2026-09-25T15:00:00.000Z",
    });

    expect(passedUnresolvedCallFor(10, [concluded, rebooked], NOW)).toBeNull();
  });

  it("no calls at all is not a passed call", () => {
    expect(passedUnresolvedCallFor(10, [], NOW)).toBeNull();
    expect(passedUnresolvedCallFor(10, undefined, NOW)).toBeNull();
  });
});
