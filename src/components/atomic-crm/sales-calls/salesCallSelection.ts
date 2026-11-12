import type { SalesCall } from "../types";

// One model of "what is happening with this Opportunity's calls".
//
// Audit #1 found two implementations answering overlapping questions with
// different rules: selectCurrentSalesCall (for the drawer) ranked a booked
// call above anything concluded and otherwise took the most recent
// schedule; nextBookedCallByOpportunity (for the board) built a map of the
// EARLIEST booked call per Opportunity. Neither was wrong for its caller,
// and that is the problem — the drawer and the board could describe the
// same relationship differently, and nothing made them reconcile.
//
// This is the single model. Everything else reads from it: the drawer, the
// Call Booked ordering, the cancel/no-show condition, call history.
//
// The database already guarantees at most one booked call per Opportunity
// (a partial unique index), so "the booked call" is singular by
// construction rather than by convention.

/**
 * Structural, and deliberately forgiving about the optional fields: the
 * board loads a narrow projection of sales_calls while the drawer holds
 * whole rows, and both have to reach the same conclusions from it.
 */
export type SalesCallForSelection = Pick<SalesCall, "id" | "status"> & {
  opportunity_id?: SalesCall["opportunity_id"];
  attendance?: SalesCall["attendance"];
  scheduled_at?: SalesCall["scheduled_at"];
  scheduled_on?: SalesCall["scheduled_on"];
  created_at?: SalesCall["created_at"];
};

export type SalesCallView<T extends SalesCallForSelection> = {
  /** The booked call, if the calendar holds one. At most one can exist. */
  booked: T | null;
  /**
   * The call to show as THE current one: a live booking outranks anything
   * already concluded, because something in the calendar is more present
   * than something finished.
   */
  current: T | null;
  /** The most recent call that already concluded, booked or not. */
  mostRecentConcluded: T | null;
  /** Everything except `current`, most recent first. */
  history: T[];
  /** All of them, most recent first. */
  all: T[];
};

/**
 * Sortable instant for a call.
 *
 * A day-only booking sorts at the END of its day, so a call known only as
 * "the 14th" never jumps ahead of one actually scheduled at 09:00 on the
 * 14th. Deliberately not midnight: that is the invented placeholder the
 * whole schedule-precision model exists to avoid.
 */
export const callInstant = (call: SalesCallForSelection): string | null => {
  if (call.scheduled_at) return call.scheduled_at;
  if (call.scheduled_on) return `${call.scheduled_on}T23:59:00.000Z`;
  return null;
};

const byMostRecentFirst = (
  a: SalesCallForSelection,
  b: SalesCallForSelection,
): number => {
  const ai = callInstant(a) ?? "";
  const bi = callInstant(b) ?? "";
  if (ai !== bi) return bi.localeCompare(ai);
  // Ties resolve to the more recently recorded row rather than arbitrarily.
  return Number(b.id) - Number(a.id);
};

const isConcluded = (call: SalesCallForSelection): boolean =>
  call.status !== "booked";

/**
 * A cancellation that a later booking replaced.
 *
 * Cancel-and-rebook is two upstream appointments, so it is two episodes: the
 * old booking is cancelled, the new one is the call that happens. Usually the
 * new one is also LATER in the calendar, and "most recent first" puts it on
 * top without help. Celia's was not (contact 335): she cancelled a Nov 3
 * booking and rebooked for Oct 30, so the cancelled Nov 3 row sorted above
 * the Oct 30 call that actually happened — and the Opportunity would have
 * read "Latest Sales Call · Cancelled" over a call with a recorded result.
 *
 * Booking order is when the row was created, falling back to the row id
 * where a projection does not carry created_at. A cancelled call with a
 * later-booked, uncancelled call beside it has been replaced, and is history
 * rather than the current state. A cancellation booked AFTER everything else
 * — a follow-up that fell through — is still current, exactly as before.
 */
const bookedAfter = (
  later: SalesCallForSelection,
  earlier: SalesCallForSelection,
): boolean =>
  later.created_at && earlier.created_at
    ? later.created_at > earlier.created_at
    : Number(later.id) > Number(earlier.id);

const isReplacedCancellation = (
  call: SalesCallForSelection,
  all: readonly SalesCallForSelection[],
): boolean =>
  call.status === "cancelled" &&
  all.some((other) => other.status !== "cancelled" && bookedAfter(other, call));

/** Build the view for one Opportunity's calls. */
export const selectSalesCalls = <T extends SalesCallForSelection>(
  salesCalls: readonly T[] | undefined,
): SalesCallView<T> => {
  const all = [...(salesCalls ?? [])].sort(byMostRecentFirst);
  if (!all.length) {
    return {
      booked: null,
      current: null,
      mostRecentConcluded: null,
      history: [],
      all: [],
    };
  }

  const booked = all.find((call) => call.status === "booked") ?? null;
  // A replaced cancellation stays in `all` and `history`; it just never
  // speaks for the Opportunity's present.
  const live = all.filter((call) => !isReplacedCancellation(call, all));
  const mostRecentConcluded = live.find(isConcluded) ?? null;
  const current = booked ?? live[0] ?? all[0];

  return {
    booked,
    current,
    mostRecentConcluded,
    history: all.filter((call) => String(call.id) !== String(current.id)),
    all,
  };
};

/** The same view for many Opportunities at once, keyed by Opportunity id. */
export const selectSalesCallsByOpportunity = <T extends SalesCallForSelection>(
  salesCalls: readonly T[] | undefined,
): Map<string, SalesCallView<T>> => {
  const grouped = new Map<string, T[]>();
  for (const call of salesCalls ?? []) {
    if (call.opportunity_id == null) continue;
    const key = String(call.opportunity_id);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(call);
    else grouped.set(key, [call]);
  }

  const views = new Map<string, SalesCallView<T>>();
  for (const [key, calls] of grouped) views.set(key, selectSalesCalls(calls));
  return views;
};

/**
 * Whether the latest thing that happened on this Opportunity's calls was a
 * cancellation or a no-show, with nothing booked since.
 *
 * This is the fact half of "Leif needs to decide the next step". It reads
 * only call columns; whether the Opportunity is still active is the
 * caller's question, answered by isActiveOpportunity.
 */
export const latestCallEndedWithoutRebooking = (
  view: SalesCallView<SalesCallForSelection>,
): boolean => {
  // A live booking answers the question on its own: something IS happening.
  if (view.booked) return false;
  const last = view.mostRecentConcluded;
  if (!last) return false;
  return last.status === "cancelled" || last.attendance === "no_show";
};

// What the drawer should call the current call's state, in the words Leif
// uses. Reads the call's own columns rather than the Opportunity's stage:
// the stage can lag, and the call is the fact.
export const describeSalesCallState = (
  call: Pick<SalesCall, "status" | "attendance">,
): string => {
  if (call.status === "cancelled") return "Cancelled";
  if (call.attendance === "no_show") return "No-show";
  if (call.attendance === "attended") return "Call happened";
  if (call.status === "booked") return "Booked";
  return "Outcome not recorded";
};
