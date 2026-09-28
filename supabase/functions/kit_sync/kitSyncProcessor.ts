// The worker body: claim outstanding Kit operations, do them, record what
// happened. Written against injected dependencies rather than module-level
// singletons so the whole thing is exercisable without a Deno runtime, a
// Supabase project, or a single real call to Kit.
//
// Three properties this file exists to hold:
//
//   Nobody blocks anybody. Each operation is done inside its own try, so one
//   person's failure never stops the queue — the next row is attempted
//   regardless.
//
//   Nothing calls itself done without evidence. A success writes the
//   subscriber id Kit actually returned; the database refuses the row
//   otherwise (kit_sync_operations_success_evidence_check).
//
//   Nothing stores a credential or a provider payload. A failure keeps a class
//   and a short, key-redacted reason, which is what a retry decision needs and
//   the limit of what is worth keeping.

import type { KitClient } from "../_shared/kit.ts";

export type KitSyncOperation = {
  id: number;
  application_id: number;
  contact_id: number;
  kind: "applicant" | "decision";
  email: string;
  kit_tag_id: number;
  kit_tag_name: string;
  // Already incremented by the claim, so this is the attempt being made now.
  attempts: number;
};

// A bad minute at Kit must not need a human. Three of the failure classes
// mean "the next pass is the fix" — too fast, Kit is down, Kit could not be
// reached — so an operation that hits one goes back on the queue instead of
// waiting for somebody to notice. The other three mean the opposite: a wrong
// key, a refusal Kit will repeat identically, or something nobody has a name
// for. Those stop and ask.
const TRANSIENT: ReadonlySet<string> = new Set([
  "rate_limited",
  "provider_unavailable",
  "network",
]);

// Five attempts at five minutes apart is a little over twenty minutes of Kit
// being unreachable before an applicant becomes Leif's problem — comfortably
// longer than an outage worth waiting out, comfortably shorter than a morning.
export const MAX_TRANSIENT_ATTEMPTS = 5;

export const shouldRequeue = (failureClass: string, attempts: number) =>
  TRANSIENT.has(failureClass) && attempts < MAX_TRANSIENT_ATTEMPTS;

// The narrow slice of a Supabase client this needs. Keeping it this small is
// what lets a test hand over an object literal instead of a mock framework.
export type KitSyncDb = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  markSucceeded: (id: number, subscriberId: string) => Promise<void>;
  // `requeue` decides whether the row goes back to pending for the next pass
  // or stops as failed and asks for Leif. The database is told which; it does
  // not work it out.
  markFailed: (
    id: number,
    failureClass: string,
    reason: string,
    requeue: boolean,
  ) => Promise<void>;
};

export type KitSyncSummary = {
  claimed: number;
  succeeded: number;
  failed: number;
  // Transient failures put back for the next pass. Counted separately because
  // "three retrying" and "three stuck" are different mornings.
  requeued: number;
};

export const processKitSyncOperations = async ({
  db,
  kit,
  limit = 25,
}: {
  db: KitSyncDb;
  kit: KitClient;
  limit?: number;
}): Promise<KitSyncSummary> => {
  const { data, error } = await db.rpc("claim_kit_sync_operations", {
    p_limit: limit,
  });
  if (error) throw new Error(`Could not claim Kit work: ${error.message}`);

  const operations = (data ?? []) as KitSyncOperation[];
  const summary: KitSyncSummary = {
    claimed: operations.length,
    succeeded: 0,
    failed: 0,
    requeued: 0,
  };

  const recordFailure = async (
    operation: KitSyncOperation,
    failureClass: string,
    reason: string,
  ) => {
    const requeue = shouldRequeue(failureClass, operation.attempts);
    await db.markFailed(operation.id, failureClass, reason, requeue);
    if (requeue) summary.requeued += 1;
    else summary.failed += 1;
  };

  for (const operation of operations) {
    try {
      // Subscriber first, always. It is what gives the tag call somebody to
      // attach to, and it is the only thing that returns the id the success
      // row has to carry.
      const subscriber = await kit.upsertSubscriber(operation.email);
      if (!subscriber.ok) {
        await recordFailure(
          operation,
          subscriber.failureClass,
          subscriber.reason,
        );
        continue;
      }

      const tagged = await kit.addTag(operation.kit_tag_id, operation.email);
      if (!tagged.ok) {
        await recordFailure(operation, tagged.failureClass, tagged.reason);
        continue;
      }

      // The durable person-to-Kit link, through the CRM's own external
      // identity authority rather than a second one. Best effort on purpose:
      // the tag is applied either way, and failing the operation over its
      // bookkeeping would ask Leif to retry work that already succeeded.
      try {
        await db.rpc("record_external_identity", {
          p_provider: "kit",
          p_provider_account_id: null,
          p_external_user_id: subscriber.value.subscriberId,
          p_display_identifier: operation.email,
          p_metadata: {},
          p_email: operation.email,
        });
      } catch {
        // Recorded nowhere on purpose: the tag landed, which is the work.
      }

      await db.markSucceeded(operation.id, subscriber.value.subscriberId);
      summary.succeeded += 1;
    } catch (error) {
      // An unexpected throw is still this one person's problem, not the
      // queue's. Recorded as 'unknown', which stops and asks rather than
      // retrying something nobody has a name for.
      try {
        await recordFailure(
          operation,
          "unknown",
          (error instanceof Error ? error.message : "Unexpected error").slice(
            0,
            200,
          ),
        );
      } catch {
        // If even recording the failure fails, the row stays 'processing' and
        // the ten-minute reclaim in claim_kit_sync_operations picks it up.
        summary.failed += 1;
      }
    }
  }

  return summary;
};
