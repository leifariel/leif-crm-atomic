import type { Cohort } from "../types";
import { getDenverDateString } from "../dashboard/artOracle/selectDailyArtwork";

// Is this round still taking people?
//
// ONE definition, because there were already two and they disagreed.
// publicOfferContext.ts asked the full question — the status AND the
// open/close window — while classifyApplication.ts asked only about the
// status. The public form's answer is the honest one: a round whose
// applications closed yesterday is not open, whatever its status column has
// not yet been changed to say.
//
// Extracted here rather than copied because dealActivity.ts already recorded
// what copying a predicate costs: the same rule was written out by hand about
// nine times in three subtly different shapes, all of which happened to agree
// on that day's data.
//
// classifyApplication.ts is deliberately left alone. Its clause decides
// whether an IMPORTED record is still review work, which is a question about
// Leif's attention rather than about selling a place, and narrowing it would
// quietly send old questionnaires back to history. That difference is
// intentional and is stated there.
//
// The date is America/Denver, the same clock applications_awaiting_review and
// the review SLA use. A date in a different timezone would open and close
// rounds at the wrong hour of Leif's day.
export const isCohortAcceptingApplications = (
  cohort: Pick<
    Cohort,
    "status" | "applications_open_at" | "applications_close_at"
  >,
  today: string = getDenverDateString(),
): boolean =>
  cohort.status === "applications_open" &&
  (!cohort.applications_open_at || today >= cohort.applications_open_at) &&
  (!cohort.applications_close_at || today <= cohort.applications_close_at);

/**
 * Every round of this programme a person could still be sold into, soonest
 * deadline first.
 *
 * Ordering matters only for readability — nothing here picks one. Choosing a
 * round is somebody's decision in this CRM and always has been: the public
 * form takes it from the URL, adoption takes it from the Application's own
 * `intended_cohort_id`, a waitlist batch and a Deal edit take it from Leif.
 * No code anywhere infers a round, and this does not start.
 */
export const acceptingCohortsOf = (
  offerId: Cohort["offer_id"],
  cohorts: Cohort[] | undefined,
  today: string = getDenverDateString(),
): Cohort[] =>
  (cohorts ?? [])
    .filter(
      (cohort) =>
        String(cohort.offer_id) === String(offerId) &&
        isCohortAcceptingApplications(cohort, today),
    )
    .sort((a, b) => {
      const left = a.applications_close_at ?? "9999-12-31";
      const right = b.applications_close_at ?? "9999-12-31";
      if (left !== right) return left < right ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
