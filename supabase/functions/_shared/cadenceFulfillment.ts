import {
  crmCalendarDate,
  dayFallsInSlotWeek,
  sessionFallsInSlotWeek,
} from "./sessionFallsInSlotWeek.ts";

// ra-core's Identifier, inlined: Edge Functions have no react-admin.
type Identifier = string | number;

// WAS THIS EXPECTED WEEK FULFILLED?
//
// THE QUESTION, said once: did this client have a qualifying session for
// THIS programme during THIS expected week? That is the whole of it, and
// the answer must not depend on a row happening to carry a foreign key.
//
// THE BUG THIS EXISTS FOR. The detector asked the question as
//
//   client_sessions where enrollment_id = <this enrollment>
//
// and `client_sessions.enrollment_id` is nullable: the Acuity webhook
// resolves it once, when the appointment arrives, and writes null when the
// Enrollment is not findable yet. Nothing revisited it. In production 62 of
// 255 sessions carried null, and three real clients — Ava Frotton, Denise
// Cormier, Gina McNamara — were each told they had skipped the week of
// 4–7 October while the session sat in the table, with the right person and
// the right programme on it, invisible because one column was empty.
//
// A MISSING LINK IS NOT AN ABSENT SESSION. So the authority accepts an
// unlinked session as evidence — but only where it can say truthfully that
// this week is the one it belongs to:
//
//   same contact · same offer · qualifying state · the Denver calendar day
//   inside this week · and no other expected week claiming the same hour
//
// It is NOT loosened to "same contact". A session for the other programme
// never fulfils, because "did she attend her Living Example week" is not
// answered by a Growing Yourself Up booking.
//
// AND IT NEVER GUESSES. If two expected weeks could each own the same
// unlinked session, the honest answer is that the system does not know, so
// it says `ambiguous` and leaves it for Leif — rather than silently closing
// one of her questions with an hour that may belong to the other.
//
// Mirrors src/components/atomic-crm/sessions/cadenceFulfillment.ts, because
// Edge Functions cannot import from src/.
// contracts/sessions/oneWeekAuthority.test.ts runs one table of vectors
// through BOTH copies.

/** What a session must say about itself to be judged. */
export type FulfillingSession = {
  id: Identifier;
  contact_id: Identifier;
  offer_id: Identifier;
  /** Provenance, and nullable — see the header. */
  enrollment_id: Identifier | null;
  status?: string | null;
  no_show_at?: string | null;
  scheduled_at: string;
};

/** An expected week, and which Enrollment it belongs to. */
export type ExpectedWindowRef = {
  id: Identifier;
  enrollment_id: Identifier;
  window_start: string | null;
  window_end: string | null;
};

/** Who the week under judgement belongs to. */
export type SlotOwner = {
  enrollment_id: Identifier;
  contact_id: Identifier;
  offer_id: Identifier;
};

export type FulfillmentBasis = "linked" | "unlinked";

export type SlotFulfillment =
  | {
      status: "fulfilled";
      session: FulfillingSession;
      /** "linked" states its own provenance; "unlinked" was inferred. */
      basis: FulfillmentBasis;
    }
  | {
      status: "ambiguous";
      session: FulfillingSession;
      /** The expected weeks that could each own it. */
      claimants: Identifier[];
    }
  | { status: "missed" };

/**
 * An hour that actually happened.
 *
 * Cancelled means it did not; a no-show means she was there and the client
 * was not. Everything else is presumed attended, because a booked Acuity
 * session IS the evidence — Leif never marks anything complete.
 */
export const sessionIsQualifying = (
  session: Pick<FulfillingSession, "status" | "no_show_at">,
): boolean => session.status !== "cancelled" && !session.no_show_at;

export type Provenance = "linked" | "unlinked" | "not-this-slot";

/**
 * Could this session speak for this week's Enrollment at all?
 *
 * Three ways to be rejected outright, before any date is considered:
 * another person, another programme, or an explicit link to a different
 * Enrollment. The last one matters: a session that already names its
 * Enrollment is not available to be re-interpreted.
 */
export const sessionProvenanceForSlot = (
  session: Pick<FulfillingSession, "contact_id" | "offer_id" | "enrollment_id">,
  owner: SlotOwner,
): Provenance => {
  if (String(session.contact_id) !== String(owner.contact_id)) {
    return "not-this-slot";
  }
  // Wrong programme never fulfils, however well the dates line up.
  if (String(session.offer_id) !== String(owner.offer_id)) {
    return "not-this-slot";
  }
  if (session.enrollment_id == null) return "unlinked";
  return String(session.enrollment_id) === String(owner.enrollment_id)
    ? "linked"
    : "not-this-slot";
};

/**
 * Which expected weeks could each own this hour?
 *
 * More than one means the system cannot truthfully say which week the
 * session belongs to — so it must not spend it on either.
 */
export const windowsClaimingSession = (
  session: Pick<FulfillingSession, "scheduled_at">,
  candidateWindows: readonly ExpectedWindowRef[],
): ExpectedWindowRef[] => {
  const day = crmCalendarDate(session.scheduled_at);
  return candidateWindows.filter((window) => dayFallsInSlotWeek(day, window));
};

/**
 * The one answer. `candidateWindows` is every live expected week belonging
 * to any Enrollment of this same contact and offer — the set an unlinked
 * session could be mistaken for.
 */
export const resolveSlotFulfillment = ({
  slot,
  owner,
  sessions,
  candidateWindows,
}: {
  slot: Pick<ExpectedWindowRef, "window_start" | "window_end">;
  owner: SlotOwner;
  sessions: readonly FulfillingSession[];
  candidateWindows: readonly ExpectedWindowRef[];
}): SlotFulfillment => {
  const qualifying = sessions.filter(sessionIsQualifying);

  // 1. A session that NAMES this Enrollment. Explicit provenance wins, and
  //    needs no inference about which week it belongs to.
  const linked = qualifying.find(
    (session) =>
      sessionProvenanceForSlot(session, owner) === "linked" &&
      sessionFallsInSlotWeek(session, slot),
  );
  if (linked) return { status: "fulfilled", session: linked, basis: "linked" };

  // 2. An unlinked session of the same person and the same programme,
  //    inside this week.
  const unlinked = qualifying.filter(
    (session) =>
      sessionProvenanceForSlot(session, owner) === "unlinked" &&
      sessionFallsInSlotWeek(session, slot),
  );
  if (unlinked.length === 0) return { status: "missed" };

  // Prefer one no other week wants. Only when EVERY candidate is contested
  // is the answer "I don't know" — a second, clean session still answers
  // the question.
  const uncontested = unlinked.find(
    (session) => windowsClaimingSession(session, candidateWindows).length <= 1,
  );
  if (uncontested) {
    return { status: "fulfilled", session: uncontested, basis: "unlinked" };
  }

  const session = unlinked[0]!;
  return {
    status: "ambiguous",
    session,
    claimants: windowsClaimingSession(session, candidateWindows).map(
      (window) => window.id,
    ),
  };
};
