import { supabaseAdmin } from "./supabaseAdmin.ts";

// PROVENANCE CONVERGES — IT DOES NOT RUN ONCE.
//
// THE BUG THIS EXISTS FOR. `findActiveEnrollmentForClientSession` ran at
// exactly one moment: when the Acuity appointment arrived. If the
// Enrollment did not exist yet — a session booked before the client was
// enrolled, which is the normal order of events — the row was written with
// `enrollment_id` null and nobody ever came back to it. 62 of 255
// production sessions ended up that way, and 26 of them were created
// before their Enrollment existed, so the one-shot lookup could not
// possibly have succeeded.
//
// This applier runs that question again, whenever the answer might have
// changed: on ingestion, after the expected-session schedule is rebuilt,
// and once over the history in migration 20261010190000.
//
// IT OWNS NO RULE OF ITS OWN. Every decision comes from the view
// `client_session_enrollment_candidates`, which is the single link
// authority — the same rows Leif's preflight reads, so an audit and a
// backfill can never disagree. This file only writes down what the view
// already decided.

export type ReconciliationResult = {
  /** Blanks filled with the one Enrollment that could truthfully own them. */
  linked: number;
  /** No Enrollment of that contact and programme can own the day. */
  noCandidate: number;
  /** Several could. Left null on purpose — Leif decides. */
  ambiguous: number;
};

type CandidateRow = {
  session_id: number;
  proposed_enrollment_id: number | null;
  classification: string;
};

/**
 * Fill every deterministic link, leave every uncertain one alone.
 *
 * Pass a `sessionId` to reconcile just-ingested row, or omit it to sweep
 * everything still unlinked. Idempotent: the view only ever lists sessions
 * whose `enrollment_id` is null, so a second pass over settled data does
 * nothing.
 */
export const reconcileClientSessionEnrollments = async (
  sessionId?: number,
): Promise<ReconciliationResult> => {
  const query = supabaseAdmin
    .from("client_session_enrollment_candidates")
    .select("session_id, proposed_enrollment_id, classification");
  const { data } = await (sessionId == null
    ? query
    : query.eq("session_id", sessionId));

  const result: ReconciliationResult = {
    linked: 0,
    noCandidate: 0,
    ambiguous: 0,
  };

  for (const row of (data ?? []) as CandidateRow[]) {
    if (
      row.classification !== "deterministic" ||
      row.proposed_enrollment_id == null
    ) {
      if (row.classification === "ambiguous") result.ambiguous++;
      else result.noCandidate++;
      continue;
    }

    // `.is("enrollment_id", null)` is the guard that matters: this can only
    // ever fill a blank. Provenance that already exists is never rewritten,
    // even if the view would have chosen differently.
    const { error } = await supabaseAdmin
      .from("client_sessions")
      .update({ enrollment_id: row.proposed_enrollment_id })
      .eq("id", row.session_id)
      .is("enrollment_id", null);
    if (!error) result.linked++;
  }

  return result;
};
