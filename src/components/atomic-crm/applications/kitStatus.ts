import type {
  Application,
  KitSyncFailureClass,
  KitSyncOperation,
} from "../types";

export type { KitSyncOperation };

// THE one answer the Application page has to give about Kit:
//
//   is Kit handling this application, or is it mine to email by hand?
//
// One derivation, used by every surface (AGENTS.md -> Operational UX
// conventions: one implementation, many entry points). When the Application
// Form Builder resumes, its review lightbox reuses this — it does not grow a
// second opinion.
//
// Everything here comes from DURABLE CRM EVIDENCE — the application's own
// source and status, and the kit_sync_operations rows the database wrote. Kit
// is never asked anything at render time, which is what makes the answer
// instant, offline-safe, and honest about what the CRM actually knows.
//
// Kit is downstream of all of it: the application, the decision, the
// Opportunity and the review Task are true whatever Kit did. So this speaks
// only about whether the tags Kit owes have landed, and what it costs when
// they have not.

export type KitStatusKind =
  // Everything the CURRENT CRM state requires has reached Kit.
  | "tagged"
  // On its way, and not yet old enough to be worth mentioning.
  | "syncing"
  // Somebody has to look: a refusal, or work that has been waiting far too
  // long. The only state that gets a card and an action.
  | "attention"
  // THE operationally important one. A real, live application that Kit is not
  // handling — it predates the integration, or its programme has no Kit tags,
  // or there is no usable email. Whatever the reason, the consequence is the
  // same and Leif has to know it: the decision email is his to send.
  | "manual"
  // Do Not Engage. The CRM refused them; Kit is deliberately never involved.
  | "not-used"
  // An imported historical record. Kit was never going to hear about it and
  // there is nothing for anyone to do, so the page stays silent rather than
  // dressing history up as outstanding work.
  | "historical";

export type KitStatus = {
  kind: KitStatusKind;
  // The compact line Leif reads. Deliberately short enough to sit inline.
  label: string;
  // Tag names that actually landed. Diagnostic, not primary: the retry tooling
  // and a puzzled operator both want them, and neither wants them first.
  tags: string[];
  failureClass: KitSyncFailureClass | null;
  detail: string | null;
  // Only a failed operation can be re-queued. Work that is merely late is
  // already on its way, and offering a button would be theatre.
  isRetryable: boolean;
};

export const KIT_STATUS_LABELS: Record<KitStatusKind, string> = {
  tagged: "Kit: Tagged ✓",
  syncing: "Kit: Syncing…",
  attention: "Kit: Needs attention",
  manual: "Kit: Not synced — email manually",
  "not-used": "Kit: Not used",
  historical: "",
};

// The worker runs every five minutes. Half an hour is six missed passes —
// long enough that a slow minute at Kit never raises an alarm, short enough
// that a genuinely stuck applicant is found the same morning.
export const STALE_AFTER_MS = 30 * 60 * 1000;

// Which decisions Kit has a tag for. 'do_not_engage' is absent because the
// database has no mapping for it and never will; 'denied' and 'waitlist' are
// historical-import-only values no live review can set.
const KIT_DECISIONS = ["approved", "needs_higher_care", "not_fit"];

const outstanding = (operation: KitSyncOperation) =>
  operation.status === "pending" || operation.status === "processing";

// What the application's CURRENT state requires Kit to have done. An
// application still awaiting review owes only its programme tag; one Leif has
// decided owes the outcome tag too. Nothing is "done" until this whole list
// has landed.
const requiredKinds = (application: Pick<Application, "status">) =>
  KIT_DECISIONS.includes(application.status)
    ? (["applicant", "decision"] as const)
    : (["applicant"] as const);

export const kitStatus = ({
  application,
  operations,
  now = new Date(),
}: {
  application: Pick<Application, "status" | "source">;
  operations: KitSyncOperation[];
  now?: Date;
}): KitStatus => {
  const of = (kind: string) =>
    operations.find((operation) => operation.kind === kind);

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

  const say = (
    kind: KitStatusKind,
    over: Partial<KitStatus> = {},
  ): KitStatus => ({
    kind,
    label: KIT_STATUS_LABELS[kind],
    tags,
    failureClass: null,
    detail: null,
    isRetryable: false,
    ...over,
  });

  // A refusal outranks everything, including Do Not Engage. In the ordinary
  // Do Not Engage case there is no failed row to find, so nothing is implied
  // that is not true; but a row that failed before the decision was made must
  // not be buried by it, because a buried row is exactly the invisible work
  // this whole integration exists to end.
  if (failed.length > 0 || stuck.length > 0) {
    const worst = failed[0] ?? null;
    return say("attention", {
      failureClass: worst?.failure_class ?? null,
      detail: worst?.failure_reason ?? null,
      isRetryable: failed.length > 0,
    });
  }

  if (application.status === "do_not_engage") return say("not-used");

  if (operations.length === 0) {
    // The discriminator that matters. An imported record and a live applicant
    // both have no Kit operations, and they mean opposite things: one is
    // finished history, the other is a decision email nobody has sent.
    return say(
      application.source === "historical_import" ? "historical" : "manual",
    );
  }

  const required = requiredKinds(application);
  if (required.every((kind) => of(kind)?.status === "succeeded")) {
    return say("tagged");
  }
  if (operations.some(outstanding)) return say("syncing");

  // Operations exist, none failed, none in flight, and something the current
  // state requires is still missing — so nothing is coming, and the honest
  // answer is the same one a pre-boundary application gets.
  return say("manual");
};

// What went wrong, in Leif's terms. No status codes, no payloads, no mention
// of keys or configuration internals — those belong in the optional detail
// line, not in the sentence he reads first.
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
