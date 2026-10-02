import type {
  Application,
  KitSyncFailureClass,
  KitSyncOperation,
  KitTagMapping,
} from "../types";

export type { KitSyncOperation };

// THE one answer the Application page has to give about Kit:
//
//   is Kit handling this application, or is it mine to do by hand?
//
// One derivation, used by every surface — the Application's own status strip
// and the Dashboard's aggregate worklist both ask this and nothing else, so
// they cannot disagree about whether somebody has been emailed. When the
// Application Form Builder resumes, its review lightbox reuses this too.
//
// Everything comes from DURABLE CRM EVIDENCE: the application's own source,
// status and age, the configured tag mappings, and the kit_sync_operations
// rows the database wrote. Kit is never asked anything at render time.
//
// Three concerns stay separate, because collapsing them is how a status stops
// meaning anything:
//
//   AUTOMATIC   the integration is handling this application's lifecycle
//   MANUAL      it predates the integration, so its tags are Leif's to add
//   NOT KIT     Do Not Engage, an unconfigured programme, or finished history

export type KitStatusKind =
  // Automatic, and everything the CURRENT state requires has landed.
  | "tagged"
  // Automatic, on its way.
  | "syncing"
  // Automatic, and somebody has to look: a refusal, or work waiting far too
  // long. The only state that gets a card and an action.
  | "attention"
  // Pre-boundary and live. Its tags are Leif's to add, and some are missing.
  | "manual-action"
  // Pre-boundary and live, and every tag its CURRENT state needs has been
  // confirmed by Kit through the CRM. Deliberately NOT "Tagged": that would
  // claim the automatic integration is following this person's lifecycle,
  // and it is not — a later decision becomes manual work again.
  | "manual-done"
  // Manual work the owner has already asked for, still on its way to Kit.
  // The rows exist and the worker will carry them out, so nobody needs to act
  // — the same distinction the automatic side draws with "Syncing…". Without
  // it a confirmed request kept reading as "action needed", which invites the
  // same tag being asked for twice.
  | "manual-syncing"
  // Live, after the boundary, but its programme has no Kit tags configured.
  // Said out loud rather than guessed at or silently ignored.
  | "not-configured"
  // Do Not Engage. The CRM refused them; Kit is deliberately never involved.
  | "not-used"
  // An imported historical record: no Kit work, and no work for anyone.
  | "historical";

// One tag the application's CURRENT state calls for, and whether Kit has
// confirmed it. This is what the Dashboard's rows are made of.
export type KitRequiredTag = {
  event: "applicant" | "cohort" | "approved" | "needs_higher_care" | "not_fit";
  kitTagId: number;
  kitTagName: string;
  done: boolean;
};

export type KitStatus = {
  kind: KitStatusKind;
  label: string;
  // Tag names that actually landed. Diagnostic, not primary.
  tags: string[];
  // Only meaningful in manual mode; empty otherwise.
  required: KitRequiredTag[];
  failureClass: KitSyncFailureClass | null;
  detail: string | null;
  isRetryable: boolean;
};

export const KIT_STATUS_LABELS: Record<KitStatusKind, string> = {
  tagged: "Kit: Tagged ✓",
  syncing: "Kit: Syncing…",
  attention: "Kit: Needs attention",
  "manual-action": "Kit: Manual — action needed",
  "manual-done": "Kit: Manual — up to date ✓",
  "manual-syncing": "Kit: Syncing…",
  "not-configured": "Kit: Automation not configured",
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
const KIT_DECISIONS = ["approved", "needs_higher_care", "not_fit"] as const;

const TERMINAL_SOURCES = ["public_form", "manual"];

const outstanding = (operation: KitSyncOperation) =>
  operation.status === "pending" || operation.status === "processing";

type StatusInput = {
  application: Pick<
    Application,
    | "id"
    | "contact_id"
    | "status"
    | "source"
    | "created_at"
    | "offer_id"
    | "crm_adopted_at"
  > & { intended_cohort_id?: number | string | null };
  // Every operation that could speak about this application: its own automatic
  // rows, plus this person's manual rows.
  operations: KitSyncOperation[];
  mappings?: KitTagMapping[];
  cohortTag?: { kitTagId: number; kitTagName: string } | null;
  // When the integration became live. Null means "not known here", and the
  // caller then gets the pre-boundary reading, which is the safe one: it says
  // the work is Leif's rather than claiming Kit has it.
  notBefore?: string | null;
  now?: Date;
};

// What the application's CURRENT state calls for. A pending application owes
// its programme tag (and its round's, if that round has one); one Leif has
// decided owes the outcome tag as well.
export const requiredKitTags = ({
  application,
  mappings = [],
  cohortTag = null,
  operations,
}: Pick<
  StatusInput,
  "application" | "mappings" | "cohortTag" | "operations"
>): KitRequiredTag[] => {
  const confirmed = new Set(
    operations
      .filter((operation) => operation.status === "succeeded")
      .map((operation) => Number(operation.kit_tag_id)),
  );
  const mappedTag = (event: string) =>
    mappings.find(
      (mapping) =>
        String(mapping.offer_id) === String(application.offer_id) &&
        mapping.event === event,
    );

  const wanted: Array<{
    event: KitRequiredTag["event"];
    id: number;
    name: string;
  }> = [];
  const applicant = mappedTag("applicant");
  if (applicant) {
    wanted.push({
      event: "applicant",
      id: Number(applicant.kit_tag_id),
      name: applicant.kit_tag_name,
    });
  }
  if (cohortTag) {
    wanted.push({
      event: "cohort",
      id: cohortTag.kitTagId,
      name: cohortTag.kitTagName,
    });
  }
  if ((KIT_DECISIONS as readonly string[]).includes(application.status)) {
    const decision = mappedTag(application.status);
    if (decision) {
      wanted.push({
        event: application.status as KitRequiredTag["event"],
        id: Number(decision.kit_tag_id),
        name: decision.kit_tag_name,
      });
    }
  }

  return wanted.map((tag) => ({
    event: tag.event,
    kitTagId: tag.id,
    kitTagName: tag.name,
    done: confirmed.has(tag.id),
  }));
};

export const kitStatus = ({
  application,
  operations,
  mappings = [],
  cohortTag = null,
  notBefore = null,
  now = new Date(),
}: StatusInput): KitStatus => {
  const automatic = operations.filter(
    (operation) => operation.origin !== "manual_owner",
  );
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
    required: [],
    failureClass: null,
    detail: null,
    isRetryable: false,
    ...over,
  });

  // A refusal outranks everything, including Do Not Engage. In the ordinary
  // refusal case there is no failed row so nothing untrue is implied; a row
  // that failed BEFORE the refusal must not be buried, because a buried row is
  // exactly the invisible work this integration exists to end.
  if (failed.length > 0 || stuck.length > 0) {
    const worst = failed[0] ?? null;
    return say("attention", {
      failureClass: worst?.failure_class ?? null,
      detail: worst?.failure_reason ?? null,
      isRetryable: failed.length > 0,
    });
  }

  if (application.status === "do_not_engage") return say("not-used");

  // An imported record and a live applicant can both have no operations and
  // mean opposite things, and history must never read as outstanding work.
  //
  // Source alone used to decide it, which was right until an imported record
  // could be current work. Provenance still cannot make something operational
  // — 99 old questionnaires stay silent here forever — but an imported
  // Application the owner deliberately brought into the CRM is exactly as
  // current as a live one, and owes the same tags. It reaches manual mode
  // below rather than automatic: its receipt was never Kit-managed, so no
  // automatic operation exists and none is invented.
  const operational =
    TERMINAL_SOURCES.includes(application.source) ||
    application.crm_adopted_at != null;
  if (!operational) return say("historical");

  // Automatic: the application is Kit-managed exactly when the integration
  // created work for it.
  if (automatic.length > 0) {
    const required = requiredKitTags({
      application,
      mappings,
      cohortTag,
      operations: automatic,
    });
    const covered =
      required.length > 0 &&
      required.every((tag) =>
        automatic.some(
          (operation) =>
            Number(operation.kit_tag_id) === tag.kitTagId &&
            operation.status === "succeeded",
        ),
      );
    if (covered) return say("tagged");
    if (automatic.some(outstanding)) return say("syncing");
    // Operations exist, none failed, none in flight, and something the current
    // state needs is missing — so nothing is coming.
    return say("manual-action", {
      required: requiredKitTags({
        application,
        mappings,
        cohortTag,
        operations,
      }),
    });
  }

  // No automatic work. Either this application predates the integration, or
  // its programme is not configured.
  const preBoundary =
    notBefore == null ||
    new Date(application.created_at).getTime() < new Date(notBefore).getTime();

  const required = requiredKitTags({
    application,
    mappings,
    cohortTag,
    operations,
  });

  // Nothing is configured for this programme, so nothing can be required —
  // said out loud either way, because a silent page would let an application
  // look handled when no tag exists for it at all.
  if (required.length === 0) return say("not-configured");
  // Only a live application that predates the integration is Leif's to tag by
  // hand. One created after it with a configured programme but no operation is
  // a real anomaly, and reads the same way: somebody has to act.
  void preBoundary;

  if (required.every((tag) => tag.done))
    return say("manual-done", { required });

  // Everything still missing has already been asked for, so this is on its
  // way rather than owed. A partially-asked state stays "action needed",
  // because something in it genuinely still is.
  const queued = operations.filter(
    (operation) =>
      operation.origin === "manual_owner" && outstanding(operation),
  );
  const missing = required.filter((tag) => !tag.done);
  const allQueued =
    queued.length > 0 &&
    missing.every((tag) =>
      queued.some((operation) => Number(operation.kit_tag_id) === tag.kitTagId),
    );
  if (allQueued) return say("manual-syncing", { required });

  return say("manual-action", { required });
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
