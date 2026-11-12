import { describe, expect, it } from "vitest";

import {
  callInstant,
  describeSalesCallState,
  latestCallEndedWithoutRebooking,
  selectSalesCalls,
  selectSalesCallsByOpportunity,
  type SalesCallForSelection,
} from "./salesCallSelection";

// Two implementations used to answer overlapping questions with different
// rules, so the drawer and the Kanban column could describe the same
// relationship differently. This is the one model both read.

const call = (
  id: number,
  overrides: Partial<SalesCallForSelection> = {},
): SalesCallForSelection => ({
  id,
  opportunity_id: 1,
  status: "booked",
  attendance: null,
  scheduled_at: "2026-09-20T15:00:00.000Z",
  scheduled_on: "2026-09-20",
  ...overrides,
});

describe("which call is the current one", () => {
  it("prefers a live booking over anything already concluded", () => {
    // Arrange — Mihaela's shape: the no-show was RECORDED after the later
    // booking, so the higher id belongs to the earlier call. Taking the
    // highest id announced "No-show" as the current state of a
    // relationship whose next event was a booked call.
    const later = call(1, {
      status: "booked",
      scheduled_at: "2026-09-18T15:00:00.000Z",
    });
    const earlierRecordedLater = call(9, {
      status: "completed",
      attendance: "no_show",
      scheduled_at: "2026-07-28T15:00:00.000Z",
      scheduled_on: "2026-07-28",
    });

    // Act
    const view = selectSalesCalls([earlierRecordedLater, later]);

    // Assert
    expect(view.current?.id).toBe(1);
    expect(view.booked?.id).toBe(1);
    expect(view.mostRecentConcluded?.id).toBe(9);
    expect(view.history.map((c) => c.id)).toEqual([9]);
  });

  it("falls back to the most recent call when nothing is booked", () => {
    // Arrange
    const old = call(1, {
      status: "completed",
      scheduled_at: "2026-07-01T15:00:00.000Z",
      scheduled_on: "2026-07-01",
    });
    const recent = call(2, {
      status: "cancelled",
      scheduled_at: "2026-09-01T15:00:00.000Z",
      scheduled_on: "2026-09-01",
    });

    // Act
    const view = selectSalesCalls([old, recent]);

    // Assert
    expect(view.booked).toBeNull();
    expect(view.current?.id).toBe(2);
  });

  it("answers emptily rather than throwing when there are no calls", () => {
    // Arrange / Act
    const view = selectSalesCalls(undefined);

    // Assert
    expect(view.current).toBeNull();
    expect(view.booked).toBeNull();
    expect(view.all).toEqual([]);
  });

  it("sorts a day-only booking at the end of its day", () => {
    // Assert — never midnight, which is the invented placeholder the
    // schedule-precision model exists to avoid.
    expect(
      callInstant({ id: 1, status: "booked", scheduled_on: "2026-09-20" }),
    ).toBe("2026-09-20T23:59:00.000Z");
    expect(callInstant({ id: 1, status: "booked" })).toBeNull();
  });

  it("groups by Opportunity and ignores calls attached to none", () => {
    // Arrange
    const calls = [
      call(1, { opportunity_id: 10 }),
      call(2, { opportunity_id: 11 }),
      call(3, { opportunity_id: null }),
    ];

    // Act
    const views = selectSalesCallsByOpportunity(calls);

    // Assert
    expect([...views.keys()].sort()).toEqual(["10", "11"]);
  });
});

describe("whether the latest call left a question open", () => {
  const concluded = (
    overrides: Partial<SalesCallForSelection>,
  ): SalesCallForSelection => call(1, { status: "completed", ...overrides });

  it("says yes after a cancellation with nothing booked since", () => {
    // Arrange / Act
    const view = selectSalesCalls([concluded({ status: "cancelled" })]);

    // Assert
    expect(latestCallEndedWithoutRebooking(view)).toBe(true);
  });

  it("says yes after a no-show with nothing booked since", () => {
    // Arrange / Act
    const view = selectSalesCalls([concluded({ attendance: "no_show" })]);

    // Assert
    expect(latestCallEndedWithoutRebooking(view)).toBe(true);
  });

  it("says no once a genuine rebooking exists", () => {
    // Arrange — the premise stops being true on its own; nothing has to
    // be cleaned up.
    const view = selectSalesCalls([
      concluded({ attendance: "no_show" }),
      call(2, { status: "booked", scheduled_at: "2026-10-01T15:00:00.000Z" }),
    ]);

    // Assert
    expect(latestCallEndedWithoutRebooking(view)).toBe(false);
  });

  it("says no when the call simply happened", () => {
    // Arrange / Act
    const view = selectSalesCalls([concluded({ attendance: "attended" })]);

    // Assert
    expect(latestCallEndedWithoutRebooking(view)).toBe(false);
  });
});

describe("what the drawer calls the current state", () => {
  it("reads the call's own columns, not the Opportunity's stage", () => {
    // Arrange / Act / Assert
    expect(
      describeSalesCallState({ status: "cancelled", attendance: null }),
    ).toBe("Cancelled");
    expect(
      describeSalesCallState({ status: "completed", attendance: "no_show" }),
    ).toBe("No-show");
    expect(
      describeSalesCallState({ status: "completed", attendance: "attended" }),
    ).toBe("Call happened");
    expect(describeSalesCallState({ status: "booked", attendance: null })).toBe(
      "Booked",
    );
    expect(
      describeSalesCallState({ status: "completed", attendance: null }),
    ).toBe("Outcome not recorded");
  });

  it("calls a cancelled call cancelled even if attendance was recorded", () => {
    // Arrange — the meeting was called off, so nobody failed to attend it.
    // Act / Assert
    expect(
      describeSalesCallState({ status: "cancelled", attendance: "no_show" }),
    ).toBe("Cancelled");
  });
});

describe("a cancellation that a rebooking replaced is history, not the present", () => {
  // Celia (contact 335): booked Nov 3 (call 330), cancelled, rebooked for
  // Oct 30 (call 1330), and the Oct 30 call is the one that happened. Two
  // upstream appointments, two episodes. The cancelled Nov 3 booking is
  // LATER in the calendar than the call that happened, so "most recent
  // first" alone would put the cancellation on top.
  const original = call(330, {
    status: "cancelled",
    scheduled_at: "2026-11-03T18:00:00.000Z",
    scheduled_on: "2026-11-03",
    created_at: "2026-09-20T15:17:04.000Z",
  });
  const rebooked = call(1330, {
    status: "completed",
    attendance: "attended",
    scheduled_at: "2026-10-30T18:00:00.000Z",
    scheduled_on: "2026-10-30",
    created_at: "2026-10-30T19:17:03.000Z",
  });

  it("the call that happened is current, and the old booking stays in history", () => {
    const view = selectSalesCalls([original, rebooked]);
    expect(view.current?.id).toBe(1330);
    expect(view.mostRecentConcluded?.id).toBe(1330);
    expect(view.history.map((c) => c.id)).toEqual([330]);
    expect(view.all.map((c) => c.id)).toEqual([330, 1330]);
  });

  it("does not claim the sale needs a next step because of the replaced booking", () => {
    expect(
      latestCallEndedWithoutRebooking(selectSalesCalls([original, rebooked])),
    ).toBe(false);
  });

  it("a follow-up booked AFTER the call, then cancelled, is still the present", () => {
    const happened = call(10, {
      status: "completed",
      attendance: "attended",
      scheduled_at: "2026-10-01T18:00:00.000Z",
      created_at: "2026-09-25T00:00:00.000Z",
    });
    const fellThrough = call(11, {
      status: "cancelled",
      scheduled_at: "2026-10-08T18:00:00.000Z",
      created_at: "2026-10-02T00:00:00.000Z",
    });
    const view = selectSalesCalls([happened, fellThrough]);
    expect(view.current?.id).toBe(11);
    expect(latestCallEndedWithoutRebooking(view)).toBe(true);
  });

  it("without created_at, booking order falls back to the row id", () => {
    const view = selectSalesCalls([
      { ...original, created_at: undefined },
      { ...rebooked, created_at: undefined },
    ]);
    expect(view.current?.id).toBe(1330);
  });
});
