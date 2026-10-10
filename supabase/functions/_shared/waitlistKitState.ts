import type { KitClient, KitSubscriber } from "./kit.ts";

// Whether Kit will actually deliver to this person, and the one place that
// question is answered.
//
// THE RULE: an invitation may only reach somebody Kit currently holds as
// active, or somebody Kit does not hold at all and will accept as a new
// subscriber. Every other state is a person who has told Kit, in one way or
// another, to stop — and a waitlist invitation is not a reason to overrule
// that.
//
// Kit v4's POST /subscribers is an upsert that updates an existing
// subscriber's fields; it does NOT change their state, and it is not a
// consent check. So the state is READ — GET /v4/subscribers with the exact
// address and status=all — and acted on. Nothing here reactivates anybody,
// and nothing deletes and re-adds anybody to get around a state.
//
// Unknown words fail closed. If Kit adds a sixth state tomorrow, nobody is
// emailed because of a default this file picked for them.

export const SAFE_STATE = "active";

export type KitStateVerdict =
  | { safe: true; subscriberId: string; state: string; created: boolean }
  | {
      safe: false;
      reason: string;
      state: string | null;
      subscriberId: string | null;
      failureClass?: string;
      detail?: string;
    };

/** The CRM's own word for an unsafe Kit state, e.g. kit-cancelled. */
export const reasonForState = (state: string): string =>
  "kit-" +
  (state
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, "-") || "unknown");

/**
 * Ask Kit about one person, and decide.
 *
 * `allowCreate` separates the two moments this is used at. The preflight
 * only LOOKS: somebody Kit has never heard of is safe to invite, and
 * creating them hours before anybody confirms the batch would be a side
 * effect nobody asked for. The worker, about to tag, may create — through
 * the existing canonical upsert — and only proceeds if what comes back is
 * genuinely sendable.
 */
export const resolveKitState = async (
  kit: KitClient,
  email: string,
  { allowCreate }: { allowCreate: boolean },
): Promise<KitStateVerdict> => {
  const found = await kit.findSubscriber(email);
  if (!found.ok) {
    return {
      safe: false,
      reason: "kit-unreachable",
      failureClass: found.failureClass,
      detail: found.reason,
      state: null,
      subscriberId: null,
    };
  }

  const existing: KitSubscriber | null = found.value;
  if (existing) {
    if (existing.state.trim().toLowerCase() === SAFE_STATE) {
      return {
        safe: true,
        subscriberId: existing.subscriberId,
        state: existing.state,
        created: false,
      };
    }
    // Cancelled, complained, bounced, inactive — or anything new. Left
    // exactly as Kit has them.
    return {
      safe: false,
      reason: reasonForState(existing.state),
      state: existing.state,
      subscriberId: existing.subscriberId,
    };
  }

  // Kit has never heard of them.
  if (!allowCreate) {
    return { safe: true, subscriberId: "", state: "missing", created: false };
  }

  const created = await kit.upsertSubscriber(email);
  if (!created.ok) {
    return {
      safe: false,
      reason: "kit-unreachable",
      failureClass: created.failureClass,
      detail: created.reason,
      state: null,
      subscriberId: null,
    };
  }

  // Confirm what was actually created rather than assuming it. A subscriber
  // that comes back in a state Kit will not send to is a failure, not a
  // success with a caveat.
  const confirmed = await kit.findSubscriber(email);
  if (!confirmed.ok || !confirmed.value) {
    return {
      safe: false,
      reason: "kit-unconfirmed",
      state: null,
      subscriberId: created.value.subscriberId,
    };
  }
  if (confirmed.value.state.trim().toLowerCase() !== SAFE_STATE) {
    return {
      safe: false,
      reason: reasonForState(confirmed.value.state),
      state: confirmed.value.state,
      subscriberId: confirmed.value.subscriberId,
    };
  }
  return {
    safe: true,
    subscriberId: confirmed.value.subscriberId,
    state: confirmed.value.state,
    created: true,
  };
};
