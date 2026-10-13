import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  APPLICATION_OUTREACH_SCHEDULE_KEYS,
  CURRENT_APPLICATION_OUTREACH_SCHEDULE_KEY,
  applicationOutreachScheduleDefinition,
  applicationOutreachSchedulePosition,
  nextApplicationOutreachAction,
  type OutreachAttemptPosition,
} from "@/components/atomic-crm/outreach/applicationOutreachSchedule";

// THE CANONICAL CALENDAR, asserted against the product decision rather than
// against the implementation: Day 0 invitation, reminders at Day 3 / 10 / 24,
// and at Day 31 the episode closes and the Opportunity leaves for Nurture.
//
// Gmail owns every one of those sends. Kit delivered Day 0 for the people
// invited before Gmail existed and nothing else — there is no Kit reminder
// journey, so there is no Kit duration for this calendar to wait on.

const DAY = 24 * 60 * 60 * 1000;
const START = "2026-10-01T09:00:00.000Z";
const startedAt = new Date(START);
const dayAfterStart = (days: number) =>
  new Date(startedAt.getTime() + days * DAY);

const attempt = (over: Partial<OutreachAttemptPosition> = {}) =>
  ({
    schedule_key: "application_outreach_v1",
    started_at: START,
    step: 0,
    status: "active",
    ...over,
  }) satisfies OutreachAttemptPosition;

describe("application_outreach_v1 is the calendar Leif decided", () => {
  test("A. after the Day-0 invitation, reminder 1 falls exactly on Day 3", () => {
    const next = nextApplicationOutreachAction(attempt({ step: 0 }));

    expect(next).toMatchObject({
      kind: "action",
      action: "reminder_1",
      delivery: "email",
      dayOffset: 3,
    });
    expect(next.kind === "action" && next.dueAt).toEqual(dayAfterStart(3));
  });

  test("B. after reminder 1, reminder 2 falls exactly on Day 10", () => {
    const next = nextApplicationOutreachAction(attempt({ step: 1 }));

    expect(next).toMatchObject({ action: "reminder_2", dayOffset: 10 });
    expect(next.kind === "action" && next.dueAt).toEqual(dayAfterStart(10));
  });

  test("C. after reminder 2, the final reminder falls exactly on Day 24", () => {
    const next = nextApplicationOutreachAction(attempt({ step: 2 }));

    expect(next).toMatchObject({ action: "final_reminder", dayOffset: 24 });
    expect(next.kind === "action" && next.dueAt).toEqual(dayAfterStart(24));
  });

  test("D. after the final reminder, Day 31 closes the episode", () => {
    const next = nextApplicationOutreachAction(attempt({ step: 3 }));

    expect(next).toMatchObject({
      action: "close_no_response",
      dayOffset: 31,
    });
    expect(next.kind === "action" && next.dueAt).toEqual(dayAfterStart(31));
  });

  test("N. Day 31 is a lifecycle close, not a fifth email", () => {
    const next = nextApplicationOutreachAction(attempt({ step: 3 }));

    expect(next.kind === "action" && next.delivery).toBe("lifecycle");

    // And every send before it is an email, so the distinction is real
    // rather than a label on the last row.
    for (const step of [0, 1, 2]) {
      const send = nextApplicationOutreachAction(attempt({ step }));
      expect(send.kind === "action" && send.delivery).toBe("email");
    }
  });

  test("the calendar is frozen — changing it means a NEW version", () => {
    // If somebody edits v1's offsets in place, every historical v1 attempt
    // is silently reinterpreted. This test is what makes that a deliberate
    // act: it fails, and the correct response is to add v2.
    const v1 = applicationOutreachScheduleDefinition("application_outreach_v1");

    expect(v1?.initialInvitationDayOffset).toBe(0);
    expect(v1?.stops.map((s) => [s.action, s.dayOffset])).toEqual([
      ["reminder_1", 3],
      ["reminder_2", 10],
      ["final_reminder", 24],
      ["close_no_response", 31],
    ]);
  });
});

describe("the calendar is anchored to Day 0, never chained to actual sends", () => {
  test("E. a reminder sent late does not push the later reminders back", () => {
    // Reminder 1 was due on Day 3 and only went out on Day 8 — a retry, a
    // queue delay, an outage. Reminder 2 is still Day 10, five days after
    // the one that was late, NOT Day 15 (8 + 7).
    const next = nextApplicationOutreachAction(attempt({ step: 1 }));

    expect(next.kind === "action" && next.dueAt).toEqual(dayAfterStart(10));
    expect(next.kind === "action" && next.dueAt).not.toEqual(dayAfterStart(15));
  });

  test("E. two people invited the same moment never drift apart", () => {
    // Whatever happened in between, the same started_at gives the same
    // calendar. Nothing in the computation reads a send time.
    const onTime = nextApplicationOutreachAction(attempt({ step: 2 }));
    const troubled = nextApplicationOutreachAction(attempt({ step: 2 }));

    expect(onTime).toEqual(troubled);
    expect(onTime.kind === "action" && onTime.dueAt).toEqual(dayAfterStart(24));
  });

  test("the offsets are measured from started_at itself, not from today", () => {
    const old = nextApplicationOutreachAction(
      attempt({ started_at: "2026-01-05T13:30:00.000Z", step: 0 }),
    );

    expect(old.kind === "action" && old.dueAt).toEqual(
      new Date("2026-01-08T13:30:00.000Z"),
    );
  });
});

describe("a concluded episode owes nothing", () => {
  test("F. a closed attempt has no future action", () => {
    expect(
      nextApplicationOutreachAction(attempt({ status: "closed", step: 1 })),
    ).toEqual({ kind: "none", reason: "attempt_is_closed" });
  });

  test("F. closed at the last step is still closed, not due for Day 31", () => {
    expect(
      nextApplicationOutreachAction(attempt({ status: "closed", step: 3 })),
    ).toEqual({ kind: "none", reason: "attempt_is_closed" });
  });

  test("F. an application having been submitted leaves nothing to send", () => {
    // Application always wins: convergence closes the attempt, and from
    // that moment the calendar produces no action at all, whatever step the
    // episode had reached.
    for (const step of [0, 1, 2, 3]) {
      expect(
        nextApplicationOutreachAction(attempt({ status: "closed", step })),
      ).toEqual({ kind: "none", reason: "attempt_is_closed" });
    }
  });
});

describe("an uninterpretable attempt fails closed", () => {
  test("I. an unknown schedule produces a refusal, never an action", () => {
    const next = nextApplicationOutreachAction(
      attempt({ schedule_key: "application_outreach_v2" }),
    );

    expect(next).toEqual({ kind: "refused", reason: "unknown_schedule" });
    expect(next.kind).not.toBe("action");
  });

  test("G. an attempt is read by ITS OWN schedule, never by the current default", () => {
    // The protection against retroactive reinterpretation: the function
    // does not fall back to whatever is current when it meets a key it does
    // not know. If it did, every v1 attempt would quietly become v2 the day
    // the default moved.
    const unknown = nextApplicationOutreachAction(
      attempt({ schedule_key: "something_leif_configures_in_2027" }),
    );
    const current = nextApplicationOutreachAction(
      attempt({ schedule_key: CURRENT_APPLICATION_OUTREACH_SCHEDULE_KEY }),
    );

    expect(unknown.kind).toBe("refused");
    expect(current.kind).toBe("action");
    expect(unknown).not.toEqual(current);
  });

  test("G. today's default is v1, and a v1 attempt reads identically either way", () => {
    expect(CURRENT_APPLICATION_OUTREACH_SCHEDULE_KEY).toBe(
      "application_outreach_v1",
    );
    expect(
      nextApplicationOutreachAction(
        attempt({ schedule_key: CURRENT_APPLICATION_OUTREACH_SCHEDULE_KEY }),
      ),
    ).toEqual(
      nextApplicationOutreachAction(
        attempt({ schedule_key: "application_outreach_v1" }),
      ),
    );
  });

  test("J. a step past the end of the schedule is refused, not treated as finished", () => {
    expect(nextApplicationOutreachAction(attempt({ step: 4 }))).toEqual({
      kind: "refused",
      reason: "step_beyond_schedule",
    });
  });

  test("J. a negative or fractional step is refused", () => {
    expect(nextApplicationOutreachAction(attempt({ step: -1 }))).toEqual({
      kind: "refused",
      reason: "negative_step",
    });
    expect(nextApplicationOutreachAction(attempt({ step: 1.5 }))).toEqual({
      kind: "refused",
      reason: "negative_step",
    });
  });

  test("an unreadable started_at is refused rather than guessed", () => {
    expect(
      nextApplicationOutreachAction(attempt({ started_at: "not a date" })),
    ).toEqual({ kind: "refused", reason: "invalid_started_at" });
  });
});

describe("where a historical attempt stands, without inventing sends", () => {
  // Somebody invited on 11 Oct has passed several nominal milestones before
  // Gmail execution exists. The system has to be able to say so. It must
  // not conclude that those reminders went out.
  const sixtyDaysLater = new Date(startedAt.getTime() + 60 * DAY);

  test("M. several overdue milestones are recognised, none marked delivered", () => {
    const position = applicationOutreachSchedulePosition(
      attempt({ step: 0 }),
      sixtyDaysLater,
    );

    expect(position.kind).toBe("position");
    if (position.kind !== "position") return;

    // Day 3, 10, 24 and 31 have all passed with only Day 0 delivered.
    expect(position.overdue.map((m) => m.action)).toEqual([
      "reminder_1",
      "reminder_2",
      "final_reminder",
      "close_no_response",
    ]);
    // The step is the only evidence of delivery, and it still says 0.
    expect(position.completedStep).toBe(0);
    for (const milestone of position.milestones) {
      expect(milestone.completed).toBe(false);
    }
  });

  test("O. however far behind, exactly ONE action is owed — never four sends", () => {
    const position = applicationOutreachSchedulePosition(
      attempt({ step: 0 }),
      sixtyDaysLater,
    );
    if (position.kind !== "position") throw new Error("expected a position");

    // Four milestones missed, one action owed. This is the whole catch-up
    // principle: the module offers no way to express "send all of these".
    expect(position.overdue).toHaveLength(4);
    expect(position.next).toMatchObject({
      kind: "action",
      action: "reminder_1",
    });
    expect(Array.isArray(position.next)).toBe(false);
  });

  test("O. a completed step is never re-owed once its date has passed", () => {
    const position = applicationOutreachSchedulePosition(
      attempt({ step: 2 }),
      sixtyDaysLater,
    );
    if (position.kind !== "position") throw new Error("expected a position");

    const byAction = Object.fromEntries(
      position.milestones.map((m) => [m.action, m]),
    );
    expect(byAction.reminder_1!.completed).toBe(true);
    expect(byAction.reminder_2!.completed).toBe(true);
    expect(byAction.reminder_1!.overdue).toBe(false);
    expect(byAction.final_reminder!.completed).toBe(false);
    expect(position.next).toMatchObject({ action: "final_reminder" });
  });

  test("a schedule not yet due reports nothing overdue", () => {
    const position = applicationOutreachSchedulePosition(
      attempt({ step: 0 }),
      new Date(startedAt.getTime() + 1 * DAY),
    );
    if (position.kind !== "position") throw new Error("expected a position");

    expect(position.overdue).toEqual([]);
    expect(position.next).toMatchObject({ action: "reminder_1" });
  });

  test("a closed historical attempt owes nothing however old it is", () => {
    const position = applicationOutreachSchedulePosition(
      attempt({ step: 1, status: "closed" }),
      sixtyDaysLater,
    );
    if (position.kind !== "position") throw new Error("expected a position");

    expect(position.next).toEqual({
      kind: "none",
      reason: "attempt_is_closed",
    });
  });
});

describe("the database and the domain agree on which schedules exist", () => {
  const schemaSql = readFileSync("supabase/schemas/01_tables.sql", "utf8");
  const guardSql = readFileSync("supabase/schemas/02_functions.sql", "utf8");

  test("the CHECK's allowed keys are exactly the domain's keys", () => {
    const check = schemaSql.match(
      /application_outreach_attempts_schedule_key_check\s*\n\s*check \(schedule_key in \(([^)]*)\)\)/,
    );
    expect(
      check,
      "the schedule_key CHECK is in the declarative schema",
    ).not.toBeNull();

    const allowed = [...check![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(allowed).toEqual([...APPLICATION_OUTREACH_SCHEDULE_KEYS]);
  });

  test("H. the guard treats schedule_key as immutable provenance", () => {
    // The behavioural proof is in e2e/applicationOutreachAuthority.spec.ts
    // (P4) against real Postgres. This asserts the declarative schema the
    // clean room rebuilds from carries it too, so the two cannot drift.
    const immutable = guardSql.match(
      /new\.id is distinct from old\.id[\s\S]*?then/,
    );
    expect(immutable, "the guard's immutability clause").not.toBeNull();
    expect(immutable![0]).toContain(
      "new.schedule_key is distinct from old.schedule_key",
    );
  });

  test("the column is NOT NULL with no default, so a writer must state it", () => {
    expect(schemaSql).toMatch(/schedule_key text not null,/);
    expect(schemaSql).not.toMatch(/schedule_key text not null default/);
  });
});
