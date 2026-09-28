import type { DataProvider, Identifier } from "ra-core";

import type { Enrollment } from "../types";

// The week a client begins, stated at the moment the sale is accepted.
//
// A Start Week is Leif's decision and nothing infers one — not the first
// Acuity booking, not the first attended session, not the payment date, not
// the Won date, not the onboarding date (20260921130000, which found 19 of 22
// Living Example start dates back-filled from a booked session and had to
// stop trusting all of them). Somebody can commit today and deliberately
// begin in six weeks.
//
// So it is asked where the decision actually happens, rather than waiting to
// be discovered in an edit screen weeks later — by which time the programme's
// openings have been answering with a client whose place nobody could
// position.
//
// This runs AFTER the sale is recorded, never as part of it. Won is a sales
// fact; the Enrollment is created by the database when the Opportunity
// becomes Won, and the Start Week is a separate statement about that
// Enrollment. If this write fails the sale still stands, and the client's own
// page says the start week is not set — which is the truth either way.
export type SetStartWeekResult =
  | { status: "set"; enrollmentId: Identifier }
  // Deliberately left for later. Nothing is written: no start date, no
  // source, no placeholder. "Not decided yet" is exactly what an Enrollment
  // with no start_date already says, and inventing a second field to say it
  // again would be a second source of truth for the same fact.
  | { status: "left-unset" }
  // The database creates the Enrollment when the Opportunity turns Won; if
  // it is not there yet there is nothing to state this about.
  | { status: "no-enrollment" };

export const setStartWeekOnAcceptance = async (
  dataProvider: DataProvider,
  {
    opportunityId,
    startWeek,
  }: { opportunityId: Identifier; startWeek: string | null },
): Promise<SetStartWeekResult> => {
  if (!startWeek) return { status: "left-unset" };

  const { data: enrollments } = await dataProvider.getList<Enrollment>(
    "enrollments",
    {
      filter: { opportunity_id: opportunityId },
      pagination: { page: 1, perPage: 5 },
      sort: { field: "id", order: "ASC" },
    },
  );
  const enrollment = enrollments[0];
  if (!enrollment) return { status: "no-enrollment" };

  // The same canonical statement the client edit modal makes: a date Leif
  // put there is owner-stated, which is the only provenance the capacity
  // ledger is allowed to plan around.
  await dataProvider.update("enrollments", {
    id: enrollment.id,
    data: { start_date: startWeek, start_date_source: "owner" },
    previousData: enrollment,
  });

  return { status: "set", enrollmentId: enrollment.id };
};
