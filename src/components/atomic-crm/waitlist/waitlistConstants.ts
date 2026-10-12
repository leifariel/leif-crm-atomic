import type { WaitlistEntryStatus } from "../types";

export const waitlistEntryStatuses: {
  value: WaitlistEntryStatus;
  label: string;
}[] = [
  { value: "waiting", label: "Waiting" },
  { value: "invited", label: "Invited" },
  { value: "converted", label: "Converted" },
  { value: "removed", label: "Removed" },
];

export const waitlistEntryStatusLabels: Record<WaitlistEntryStatus, string> = {
  waiting: "Waiting",
  invited: "Invited",
  converted: "Converted",
  removed: "Removed",
};

export const waitlistEntryStatusBadgeVariant: Record<
  WaitlistEntryStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  waiting: "outline",
  invited: "default",
  converted: "secondary",
  removed: "secondary",
};

// A PLACE THAT IS STILL HELD — the DB's partial unique index predicate,
// mirrored exactly (status IN ('waiting','invited')). It answers one
// question and one only: **may this person be given another place for this
// programme?** No, while they hold one of these two.
//
// It is NOT "is this person still waiting to be invited" — somebody who has
// been invited still holds their place but is no longer waiting. Those two
// questions were answered by this one constant until 2026-10-11, and the
// comment here claimed as much, which is how every programme page counted
// 55 already-invited people as though they were still waiting. Use
// `isStillWaiting` for the operational question.
export const ACTIVE_WAITLIST_STATUSES: ReadonlySet<WaitlistEntryStatus> =
  new Set(["waiting", "invited"]);

/**
 * THE OPERATIONAL WAITLIST: people still waiting for Leif to invite them.
 *
 * One rule, one place. The programme page's count, its list, its search and
 * its selection all come from the same read (`useWaitlistEntries`), so a
 * header that disagrees with the rows beneath it is not possible.
 *
 * Being invited, converting or being removed all take somebody OUT of this
 * answer without taking anything out of the table: the entry, its
 * `joined_at`, its `invited_at` and its batch stay exactly where they are.
 * Active waitlist is a question about now, not a record of who was ever on
 * it — see HANDOFF §4b.
 */
export const isStillWaiting = (entry: { status: WaitlistEntryStatus }) =>
  entry.status === "waiting";
