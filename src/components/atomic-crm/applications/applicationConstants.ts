import type { ApplicationStatus } from "../types";

// 'denied' and 'waitlist' (Phase 4H, historical-import-only — see the
// ApplicationStatus comment in types.ts) are listed here so admin filter/
// display surfaces can show them; they are never offered as a live review
// outcome (see reviewApplication.ts's separately-typed
// ApplicationReviewOutcome).
export const applicationStatuses: {
  value: ApplicationStatus;
  label: string;
}[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "needs_higher_care", label: "Needs Higher Care" },
  { value: "not_fit", label: "Not Fit" },
  { value: "do_not_engage", label: "Do Not Engage" },
  { value: "offered_other_programme", label: "Offered another programme" },
  { value: "bespoke_accepted", label: "Bespoke Accepted" },
  { value: "bespoke_denied", label: "Bespoke Denied" },
  { value: "denied", label: "Denied (historical)" },
  { value: "waitlist", label: "Waitlisted (historical)" },
];

// The badge names the DECISION, not the destination. Which programme was
// recommended is a second fact, and ApplicationShow prints it beside the
// programme they applied for — a badge reading "Offered Growing Yourself Up"
// on an application whose own heading says The Living Example is the exact
// confusion Leif asked to make impossible.
export const applicationStatusLabels: Record<ApplicationStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  needs_higher_care: "Needs Higher Care",
  not_fit: "Not Fit",
  do_not_engage: "Do Not Engage",
  offered_other_programme: "Offered another programme",
  bespoke_accepted: "Bespoke Accepted",
  bespoke_denied: "Bespoke Denied",
  denied: "Denied (historical)",
  waitlist: "Waitlisted (historical)",
};

// Do Not Engage reads visibly more serious than an ordinary rejection
// (Native Applications slice, §7) — everything else stays calm/neutral.
// 'denied' reads the same as the other ordinary-rejection values since it
// IS one, just without a specific modern reason. 'waitlist' reads like
// 'pending' (outline) — it's an open/undecided historical disposition, not
// a rejection.
//
// 'bespoke_accepted' reads like 'approved' because it IS an acceptance.
// 'offered_other_programme' reads neutral rather than positive or negative:
// it is neither — Leif wants to work with them, in the other programme.
export const applicationStatusBadgeVariant: Record<
  ApplicationStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  approved: "default",
  needs_higher_care: "secondary",
  not_fit: "secondary",
  do_not_engage: "destructive",
  offered_other_programme: "secondary",
  bespoke_accepted: "default",
  bespoke_denied: "secondary",
  denied: "secondary",
  waitlist: "outline",
};

// Any review outcome other than "approved" means this person isn't moving
// toward a purchase for this Opportunity anymore — used by the Cohort
// capacity hooks' defensive "hasRejectedApplication" fallback (the
// Opportunity's own outcome field is the primary signal; this only matters
// if something updated Application status without going through
// reviewApplication.ts). 'denied' joins this set (it IS a rejection);
// 'waitlist' deliberately does NOT (no decision was made).
//
// 'bespoke_denied' joins it, because a bespoke denial is a denial —
// only the reply differs.
//
// 'offered_other_programme' deliberately does NOT. The set's question is
// whether this person has stopped moving toward a purchase on THIS
// Opportunity, and a recommendation moves the Opportunity itself rather than
// ending it: they are still in play, on the same Opportunity, for the
// recommended programme. 'bespoke_accepted' is an acceptance and is out for
// the same reason 'approved' is.
export const NON_APPROVED_TERMINAL_APPLICATION_STATUSES: ReadonlySet<ApplicationStatus> =
  new Set([
    "needs_higher_care",
    "not_fit",
    "do_not_engage",
    "denied",
    "bespoke_denied",
  ]);
