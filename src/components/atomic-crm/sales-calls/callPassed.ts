import {
  callInstant,
  selectSalesCallsByOpportunity,
  type SalesCallForSelection,
} from "./salesCallSelection";

/**
 * "The call has been and gone and nobody has said what happened."
 *
 * DERIVED, NEVER STORED, AND IT MUTATES NOTHING. This is the whole point:
 * a scheduled call whose time has passed with no recorded outcome stays in
 * Call Booked. The clock is not a lifecycle authority — it does not move the
 * stage, it does not record attendance, and it emphatically does not mean
 * no-show. A no-show is a thing Leif observed and recorded; this is only the
 * CRM noticing that nobody has told it anything yet.
 *
 * The badge disappears on its own the moment the call is completed or
 * cancelled, because the call stops being `booked` and the premise stops
 * being true. Nothing has to clear it.
 */

/** A call that is still booked, has a knowable time, and that time has passed. */
export const isPassedUnresolvedCall = (
  call: SalesCallForSelection | null | undefined,
  now: number,
): boolean => {
  if (!call) return false;
  // Only a live booking can be "passed". A completed or cancelled call has
  // already been spoken for, whatever its time says.
  if (call.status !== "booked") return false;
  // Belt and braces: the schema moves a call off `booked` when attendance is
  // recorded, so this should be unreachable — but an outcome recorded is an
  // outcome recorded, and it must never read as unresolved.
  if (call.attendance) return false;
  const at = callInstant(call);
  if (!at) return false;
  const instant = new Date(at).getTime();
  return Number.isFinite(instant) && instant < now;
};

/**
 * The passed-and-unresolved booked call for one Opportunity, if there is one.
 *
 * Reads through the same one model the board and the drawer share
 * (`salesCallSelection.ts`), so the badge can never disagree with the column
 * about which call is the live one.
 */
export const passedUnresolvedCallFor = <T extends SalesCallForSelection>(
  opportunityId: unknown,
  salesCalls: readonly T[] | undefined,
  now: number = Date.now(),
): T | null => {
  const view = selectSalesCallsByOpportunity(salesCalls).get(
    String(opportunityId),
  );
  const booked = view?.booked ?? null;
  return isPassedUnresolvedCall(booked, now) ? booked : null;
};
