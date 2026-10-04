import { useGetList, useGetOne, type Identifier } from "ra-core";

import {
  computeExpectedEnd,
  crossWeekReschedules,
  type ExpectedEnd,
} from "../capacity/sessionWeeks";
import { useSessionWeeks } from "../capacity/useSessionWeeks";
import type { ClientSessionCadenceIssue, Deal, Enrollment } from "../types";

// The projected final session week, for one Enrollment, from the one
// authority that already computes it.
//
// The Programme page's client rows say "expected final session week Apr 11,
// 2027". That number comes from computeExpectedEnd() in capacity/, fed by
// the Year Tracking calendar, and it is NOT start + 12 calendar weeks: Leif
// has off weeks, and the twelfth ELIGIBLE `1:1s` week is a different date
// from the twelfth week of the year. Between 2 July and 13 September 2026
// his calendar has no eligible week at all.
//
// So this hook does not calculate anything. It gathers the same three
// inputs the capacity model gathers — the offer's live session weeks, the
// start week, and one extension per cross-week reschedule — and calls the
// same function. A second engine here is exactly the failure this codebase
// has already had three times: a page that keeps its own copy of a domain
// rule and drifts from the page beside it.
//
// `startDate` is passed in rather than read from the record, so the editor
// can show what the week the owner is CURRENTLY choosing would mean,
// before anything is saved.
export const useProjectedFinalWeek = (
  enrollmentId: Identifier | null,
  startDate: string | null,
): { isPending: boolean; end: ExpectedEnd | null } => {
  const { data: enrollment, isPending: enrollmentPending } =
    useGetOne<Enrollment>(
      "enrollments",
      { id: enrollmentId! },
      { enabled: enrollmentId != null },
    );

  const { data: deal, isPending: dealPending } = useGetOne<Deal>(
    "deals",
    { id: enrollment?.opportunity_id as Identifier },
    { enabled: enrollment?.opportunity_id != null },
  );

  const { weeks, isPending: weeksPending } = useSessionWeeks(
    deal?.offer_id ?? undefined,
  );

  // One extension per cross-week reschedule, exactly as individualCapacity
  // does it: a session that moved into a LATER week keeps its entitlement,
  // so the container needs one more eligible week.
  const { data: issues, isPending: issuesPending } =
    useGetList<ClientSessionCadenceIssue>(
      "client_session_cadence_issues",
      {
        filter: { enrollment_id: enrollmentId },
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "id", order: "ASC" },
      },
      { enabled: enrollmentId != null },
    );

  const isPending =
    enrollmentId != null &&
    (enrollmentPending ||
      (enrollment?.opportunity_id != null && dealPending) ||
      weeksPending ||
      issuesPending);

  if (isPending) return { isPending: true, end: null };

  const extensions = crossWeekReschedules(
    (issues ?? []).map((issue) => issue.classification ?? null),
  );

  return {
    isPending: false,
    end: computeExpectedEnd(weeks, startDate, extensions),
  };
};
