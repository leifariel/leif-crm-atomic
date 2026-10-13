/**
 * THE ONE PLACE THE APPLICATION OUTREACH CALENDAR LIVES.
 *
 * An Application Outreach attempt is an episode of asking somebody to apply
 * (see `application_outreach_attempts`, HANDOFF §8s). This module owns WHEN
 * the next thing happens and WHAT it is. No component, worker, Edge Function
 * or SQL expression may hold a day offset of its own —
 * `contracts/outreach/oneOutreachScheduleAuthority.test.ts` enforces that.
 *
 * WHY THE CALENDAR IS HERE AND NOT IN THE DATABASE. The database owns the
 * durable facts it can actually protect: WHICH schedule governs a row
 * (`schedule_key`, a checked value), that the governing schedule never
 * changes after insert (the guard), and that an active attempt always has a
 * future (`active_has_a_future_check`). The arithmetic belongs where the
 * execution will live — a Gmail worker reading `step` and `started_at` — so
 * there is exactly one calendar, not a SQL copy and a TypeScript copy
 * drifting apart.
 *
 * WHY THE OFFSETS ARE ABSOLUTE. Every stop is measured from `started_at`,
 * the Day-0 delivery. Chaining ("seven days after reminder 1 actually went")
 * lets a retry, a queue delay or an outage push the whole remaining calendar
 * back, and two people invited the same day drift apart. The calendar is
 * anchored once.
 */

/** Every schedule version that has ever governed an attempt. */
export const APPLICATION_OUTREACH_SCHEDULE_KEYS = [
  "application_outreach_v1",
] as const;

export type ApplicationOutreachScheduleKey =
  (typeof APPLICATION_OUTREACH_SCHEDULE_KEYS)[number];

/**
 * What a NEW attempt is governed by. Changing the calendar means adding a new
 * key below and pointing this at it — never editing a version in place, or
 * every historical attempt would silently be reinterpreted.
 */
export const CURRENT_APPLICATION_OUTREACH_SCHEDULE_KEY: ApplicationOutreachScheduleKey =
  "application_outreach_v1";

export type OutreachActionKind =
  | "reminder_1"
  | "reminder_2"
  | "final_reminder"
  | "close_no_response";

/**
 * Whether a stop sends something or only changes the CRM's own mind. Day 31
 * is `lifecycle`: nobody is emailed, the episode closes and the Opportunity
 * leaves Interested for Nurture.
 */
export type OutreachActionDelivery = "email" | "lifecycle";

type ScheduleStop = {
  /** The completed `step` this stop follows. */
  readonly afterStep: number;
  readonly action: OutreachActionKind;
  /** Days after `started_at`. Absolute, never chained. */
  readonly dayOffset: number;
  readonly delivery: OutreachActionDelivery;
};

type ScheduleDefinition = {
  readonly key: ApplicationOutreachScheduleKey;
  /**
   * Day 0 is the initial invitation. It is never returned as a next action:
   * by the time an attempt row exists its Day-0 delivery has already
   * happened, which is exactly what `step = 0` records. For a historical
   * waitlist invitation that delivery came through the existing invitation
   * path, and it is never resent.
   */
  readonly initialInvitationDayOffset: 0;
  readonly stops: readonly ScheduleStop[];
};

/**
 * Gmail owns the whole sequence, including Day 0 for anybody invited from
 * here on. Day 0 -> 3 -> 10 -> 24 are emails; Day 31 closes the episode.
 */
const APPLICATION_OUTREACH_V1: ScheduleDefinition = {
  key: "application_outreach_v1",
  initialInvitationDayOffset: 0,
  stops: [
    { afterStep: 0, action: "reminder_1", dayOffset: 3, delivery: "email" },
    { afterStep: 1, action: "reminder_2", dayOffset: 10, delivery: "email" },
    {
      afterStep: 2,
      action: "final_reminder",
      dayOffset: 24,
      delivery: "email",
    },
    {
      afterStep: 3,
      action: "close_no_response",
      dayOffset: 31,
      delivery: "lifecycle",
    },
  ],
};

const SCHEDULES: Record<ApplicationOutreachScheduleKey, ScheduleDefinition> = {
  application_outreach_v1: APPLICATION_OUTREACH_V1,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The attempt fields the calendar needs, named as the database names them. */
export type OutreachAttemptPosition = {
  schedule_key: string;
  started_at: string | Date;
  step: number;
  status: string;
};

export type OutreachRefusalReason =
  | "unknown_schedule"
  | "invalid_started_at"
  | "negative_step"
  | "step_beyond_schedule";

export type NextOutreachAction =
  | {
      kind: "action";
      action: OutreachActionKind;
      delivery: OutreachActionDelivery;
      dueAt: Date;
      dayOffset: number;
    }
  /** Nothing is ever owed by a concluded episode. */
  | { kind: "none"; reason: "attempt_is_closed" }
  /**
   * The row cannot be interpreted, so no action is produced. A refusal is
   * deliberately NOT the same value as "nothing to do": a caller has to
   * handle it, and can never mistake an uninterpretable row for a quiet one.
   */
  | { kind: "refused"; reason: OutreachRefusalReason };

const scheduleFor = (key: string): ScheduleDefinition | undefined =>
  SCHEDULES[key as ApplicationOutreachScheduleKey];

const startOf = (startedAt: string | Date): Date | null => {
  const at = startedAt instanceof Date ? startedAt : new Date(startedAt);
  return Number.isNaN(at.getTime()) ? null : at;
};

const dueAtFor = (startedAt: Date, dayOffset: number) =>
  new Date(startedAt.getTime() + dayOffset * MS_PER_DAY);

/**
 * The next action owed by an attempt, and when it falls due. Exactly one, or
 * none — there is deliberately no function here that returns a list of
 * actions to perform, because a list is how a late cutover turns into four
 * emails at once.
 */
export const nextApplicationOutreachAction = (
  attempt: OutreachAttemptPosition,
): NextOutreachAction => {
  const schedule = scheduleFor(attempt.schedule_key);
  if (!schedule) return { kind: "refused", reason: "unknown_schedule" };

  const startedAt = startOf(attempt.started_at);
  if (!startedAt) return { kind: "refused", reason: "invalid_started_at" };

  if (attempt.status === "closed") {
    return { kind: "none", reason: "attempt_is_closed" };
  }

  if (!Number.isInteger(attempt.step) || attempt.step < 0) {
    return { kind: "refused", reason: "negative_step" };
  }

  const stop = schedule.stops.find((s) => s.afterStep === attempt.step);
  if (!stop) return { kind: "refused", reason: "step_beyond_schedule" };

  return {
    kind: "action",
    action: stop.action,
    delivery: stop.delivery,
    dueAt: dueAtFor(startedAt, stop.dayOffset),
    dayOffset: stop.dayOffset,
  };
};

export type OutreachMilestone = {
  action: OutreachActionKind;
  delivery: OutreachActionDelivery;
  dayOffset: number;
  dueAt: Date;
  /**
   * Completed because `step` says it was delivered. The step is the ONLY
   * evidence of delivery: a date passing proves nothing happened.
   */
  completed: boolean;
  /** Due in the past and not completed. Diagnostic — never a send list. */
  overdue: boolean;
};

export type OutreachSchedulePosition =
  | {
      kind: "position";
      scheduleKey: ApplicationOutreachScheduleKey;
      /** The last stop known to have been delivered. */
      completedStep: number;
      milestones: OutreachMilestone[];
      /**
       * Every nominal milestone already past that was never delivered. A
       * person invited before Gmail existed can have several. Listing them
       * is how the cutover is understood; acting on all of them is the thing
       * that must never happen.
       */
      overdue: OutreachMilestone[];
      /** The single action owed now. Still one, however far behind. */
      next: NextOutreachAction;
    }
  | { kind: "refused"; reason: OutreachRefusalReason };

/**
 * Where an attempt stands against its own calendar, including how far behind
 * it is. Used to understand a historical attempt at cutover; it decides
 * nothing and marks nothing delivered.
 */
export const applicationOutreachSchedulePosition = (
  attempt: OutreachAttemptPosition,
  now: Date = new Date(),
): OutreachSchedulePosition => {
  const schedule = scheduleFor(attempt.schedule_key);
  if (!schedule) return { kind: "refused", reason: "unknown_schedule" };

  const startedAt = startOf(attempt.started_at);
  if (!startedAt) return { kind: "refused", reason: "invalid_started_at" };

  if (!Number.isInteger(attempt.step) || attempt.step < 0) {
    return { kind: "refused", reason: "negative_step" };
  }

  const milestones = schedule.stops.map((stop) => {
    const dueAt = dueAtFor(startedAt, stop.dayOffset);
    // Delivered only if the attempt has advanced PAST the step this stop
    // follows. Nothing here infers delivery from the clock.
    const completed = attempt.step > stop.afterStep;
    return {
      action: stop.action,
      delivery: stop.delivery,
      dayOffset: stop.dayOffset,
      dueAt,
      completed,
      overdue: !completed && dueAt.getTime() <= now.getTime(),
    };
  });

  return {
    kind: "position",
    scheduleKey: schedule.key,
    completedStep: attempt.step,
    milestones,
    overdue: milestones.filter((m) => m.overdue),
    next: nextApplicationOutreachAction(attempt),
  };
};

/** The declared calendar, for display and for tests. Read-only. */
export const applicationOutreachScheduleDefinition = (
  key: string,
): ScheduleDefinition | undefined => scheduleFor(key);
