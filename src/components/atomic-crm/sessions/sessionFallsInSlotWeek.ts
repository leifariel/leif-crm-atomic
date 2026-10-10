// Did this session happen during that week?
//
// THE BUG THIS EXISTS FOR. The question was asked in six places, and all
// six asked it the same wrong way:
//
//   new Date(session.scheduled_at) >= new Date(slot.window_start)
//
// `window_start` is a DATE — "2026-10-04" — because it comes from a Google
// Calendar all-day event, the thing that decides which weeks are open for
// 1:1s. `new Date("2026-10-04")` is midnight UTC, which is 6pm the previous
// day in Denver. So the window the CRM actually tested was
//
//   Denver Oct 3 18:00  →  Denver Oct 7 18:00
//
// for a week whose real days are Oct 4 through Oct 7. A session on the last
// afternoon or evening of a week fell outside it, and the CRM concluded
// nobody had booked — then told Leif four of her clients had skipped a week
// they had all attended.
//
// The sibling module cadenceWeekLabel.ts warns about this exact mistake in
// its own header, for its own reason, and got it right. The comparison did
// not.
//
// THE RULE, said once: a week is a set of CALENDAR DAYS in the CRM's own
// timezone, and a session belongs to it when the day it happened on is one
// of them. No instant arithmetic, no offsets, nothing that moves when the
// clocks do — the same calendar-date reasoning `sales_calls.scheduled_on`
// has used all along (`(scheduled_at at time zone 'America/Denver')::date`).

// Mirrored at supabase/functions/_shared/sessionFallsInSlotWeek.ts,
// because Edge Functions cannot import from src/.
// contracts/sessions/oneWeekAuthority.test.ts runs one table of vectors
// through BOTH copies, so neither can drift from the other or from the
// rule — including the DST week, where an offset-based answer changes and
// a calendar-day answer does not.

import type { ClientSession, EnrollmentExpectedSession } from "../types";

const CRM_TIME_ZONE = "America/Denver";

const DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: CRM_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The calendar day an instant fell on, where the CRM lives: "2026-10-07".
 *
 * en-CA formats as YYYY-MM-DD, which sorts correctly as a string — so
 * every comparison below is a plain date comparison and stays one.
 */
export const crmCalendarDate = (
  instant: string | number | Date | null | undefined,
): string | null => {
  if (instant == null || instant === "") return null;
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  return DAY.format(date);
};

/**
 * Has the CRM's own calendar day reached `boundary` (a date like
 * "2026-10-08")?
 *
 * The other half of the same rule: "is this week over yet?" and "has this
 * week started?" are calendar-day questions too, and asking them of an
 * instant is how a week came to close six hours early in Denver. Answers
 * false for an instant it cannot read, rather than guessing.
 */
export const crmDayAtOrAfter = (
  instant: string | number | Date | null | undefined,
  boundary: string | null | undefined,
): boolean => {
  const day = crmCalendarDate(instant);
  return day != null && boundary != null && day >= boundary;
};

export type SlotWindow = Pick<
  EnrollmentExpectedSession,
  "window_start" | "window_end"
>;

/**
 * Is this calendar day one of the week's days?
 *
 * `window_end` is EXCLUSIVE — Google Calendar's own all-day semantics — so
 * a window of Oct 4 to Oct 8 covers Oct 4, 5, 6 and 7.
 */
export const dayFallsInSlotWeek = (
  day: string | null,
  slot: SlotWindow,
): boolean => {
  if (!day || !slot.window_start || !slot.window_end) return false;
  return day >= slot.window_start && day < slot.window_end;
};

/**
 * Does this session count as the week's session?
 *
 * A cancelled session is not one, and neither is a no-show: both mean the
 * hour did not happen. Everything else is presumed attended, because a
 * booked Acuity session IS the evidence — Leif never marks anything
 * complete.
 */
export const sessionFallsInSlotWeek = (
  session: Pick<ClientSession, "scheduled_at" | "status" | "no_show_at">,
  slot: SlotWindow,
): boolean => {
  if (session.status === "cancelled" || session.no_show_at) return false;
  return dayFallsInSlotWeek(crmCalendarDate(session.scheduled_at), slot);
};

/** The same question with the attendance rules left out. */
export const sessionScheduledInSlotWeek = (
  session: Pick<ClientSession, "scheduled_at">,
  slot: SlotWindow,
): boolean => dayFallsInSlotWeek(crmCalendarDate(session.scheduled_at), slot);
