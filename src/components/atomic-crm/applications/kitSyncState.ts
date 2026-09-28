import type { KitSyncFailureClass, KitSyncOperation } from "../types";

export type { KitSyncOperation };

// What the Application page is allowed to say about Kit.
//
// Kit is downstream of everything the CRM knows: the application, the
// decision and the Opportunity are true whatever Kit does. So this never
// speaks about the application — only about whether the two tags it owes have
// actually reached Leif's list, and what it costs if they have not.
//
// Quiet when healthy, loud only when somebody has to do something. A person
// who applied and never reached Kit is invisible operational work, and ending
// that is the whole reason this card exists.

export type KitSyncState =
  // No Kit work exists for this application, and none ever will. An imported
  // record, a programme with no tags, a submission from before the
  // integration, somebody the CRM refused at the door: all of them mean Kit
  // was never going to hear about this, so the page says nothing at all
  // rather than inventing a problem.
  | { kind: "not-managed" }
  // Everything owed has been applied.
  | { kind: "done"; tags: string[] }
  // Queued, and not yet old enough to be worth mentioning.
  | { kind: "working"; tags: string[] }
  // Somebody has to look.
  | {
      kind: "needs-attention";
      tags: string[];
      failureClass: KitSyncFailureClass | null;
      detail: string | null;
      isRetryable: boolean;
    };

// The worker runs every five minutes. Half an hour is six missed passes —
// long enough that a slow minute at Kit never raises an alarm, short enough
// that a genuinely stuck applicant is found the same morning.
export const STALE_AFTER_MS = 30 * 60 * 1000;

const outstanding = (operation: KitSyncOperation) =>
  operation.status === "pending" || operation.status === "processing";

export const kitSyncState = (
  operations: KitSyncOperation[],
  now: Date = new Date(),
): KitSyncState => {
  if (operations.length === 0) return { kind: "not-managed" };

  const tags = operations
    .filter((operation) => operation.status === "succeeded")
    .map((operation) => operation.kit_tag_name);

  const failed = operations.filter(
    (operation) => operation.status === "failed",
  );
  const stuck = operations.filter(
    (operation) =>
      outstanding(operation) &&
      now.getTime() - new Date(operation.created_at).getTime() > STALE_AFTER_MS,
  );

  if (failed.length > 0 || stuck.length > 0) {
    const worst = failed[0] ?? null;
    return {
      kind: "needs-attention",
      tags,
      failureClass: worst?.failure_class ?? null,
      detail: worst?.failure_reason ?? null,
      // Only a failed operation can be re-queued; one that is merely late is
      // already on its way and pressing anything would be theatre.
      isRetryable: failed.length > 0,
    };
  }

  if (operations.some(outstanding)) return { kind: "working", tags };
  return { kind: "done", tags };
};

// What went wrong, in Leif's terms. No status codes, no payloads, no
// mention of keys or configuration internals — those belong in the optional
// detail line, not in the sentence he reads first.
export const kitFailureSentence = (
  failureClass: KitSyncFailureClass | null,
): string => {
  switch (failureClass) {
    case "auth":
      return "The CRM could not sign in to Kit.";
    case "rejected":
      return "Kit would not accept this.";
    case "rate_limited":
      return "Kit asked the CRM to slow down.";
    case "provider_unavailable":
      return "Kit was unavailable.";
    case "network":
      return "Kit could not be reached.";
    case "not_configured":
      return "Kit is not connected to this CRM yet.";
    default:
      return "Something went wrong on the way to Kit.";
  }
};
