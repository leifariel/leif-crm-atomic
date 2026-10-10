import type { KitClient } from "../_shared/kit.ts";
import { resolveKitState } from "../_shared/waitlistKitState.ts";

// "The oldest 25" means the oldest 25 who can actually be sent an email.
//
// The database knows one half of that — still waiting, reachable, not
// already applied, not a client, not Do Not Engage — and Kit knows the
// other: whether this person cancelled, complained, bounced or went
// inactive. Neither half is sufficient, and finding out about the second
// half AFTER Leif confirms "25" is how she ends up inviting 22 people
// believing she invited 25.
//
// So this walks the database's chronological list and asks Kit about each
// candidate in turn until it has as many SAFE people as were asked for.
// Somebody Kit will not deliver to does not consume one of the places —
// the walk simply continues.
//
// It writes a snapshot and nothing else. No tag, no outbox row, no change
// to anybody's waitlist place. The snapshot is what Leif confirms, what
// invite_from_preflight() then acts on, and what the production SQL reads
// back independently.

export type PreflightCandidate = {
  waitlist_entry_id: number;
  contact_id: number;
  contact_name: string;
  email: string | null;
  joined_at: string;
  eligible: boolean;
  exclusion_reason: string | null;
};

export type ResolvedCandidate = {
  waitlistEntryId: number;
  contactId: number;
  name: string;
  email: string | null;
  joinedAt: string;
  dbEligible: boolean;
  dbExclusionReason: string | null;
  kitSubscriberId: string | null;
  kitState: string | null;
  kitCheckedAt: string | null;
  finalEligible: boolean;
  exclusionReason: string | null;
  finalRank: number | null;
};

export type PreflightDb = {
  candidates: (
    offerId: number,
    cohortId: number | null,
  ) => Promise<PreflightCandidate[]>;
  saveSnapshot: (input: {
    offerId: number;
    cohortId: number | null;
    requested: number;
    resolved: number;
    createdBy: string | null;
    rows: ResolvedCandidate[];
  }) => Promise<{ preflightId: number }>;
};

/**
 * How many Kit lookups are in flight at once.
 *
 * Four is enough to resolve thirty people in a few seconds and far enough
 * below Kit's rate limit that a batch never trips it. Serial would be
 * needlessly slow; unbounded would turn one click into sixty simultaneous
 * requests against somebody else's API.
 */
export const KIT_LOOKUP_CONCURRENCY = 4;

export const runWaitlistPreflight = async ({
  db,
  kit,
  offerId,
  cohortId,
  requested,
  entryIds = null,
  createdBy = null,
  concurrency = KIT_LOOKUP_CONCURRENCY,
}: {
  db: PreflightDb;
  kit: KitClient;
  offerId: number;
  cohortId: number | null;
  requested: number;
  /**
   * A hand-picked selection. The same checks run on exactly these people
   * instead of walking the list — a selection says WHO, never which rules
   * to skip, and Leif still sees the final set before confirming.
   */
  entryIds?: number[] | null;
  createdBy?: string | null;
  concurrency?: number;
}) => {
  const all = await db.candidates(offerId, cohortId);
  const candidates =
    entryIds == null
      ? all
      : all.filter((row) =>
          entryIds.some((id) => String(id) === String(row.waitlist_entry_id)),
        );
  const rows: ResolvedCandidate[] = [];
  let safeFound = 0;

  // Everybody the database already ruled out is recorded as-is. They are
  // part of the audit trail — "four older people were passed over, and
  // here is why" — and Kit is never asked about them, because the answer
  // could not change anything.
  const askKitAbout: PreflightCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.eligible) {
      rows.push({
        waitlistEntryId: candidate.waitlist_entry_id,
        contactId: candidate.contact_id,
        name: candidate.contact_name,
        email: candidate.email,
        joinedAt: candidate.joined_at,
        dbEligible: false,
        dbExclusionReason: candidate.exclusion_reason,
        kitSubscriberId: null,
        kitState: null,
        kitCheckedAt: null,
        finalEligible: false,
        exclusionReason: candidate.exclusion_reason,
        finalRank: null,
      });
      continue;
    }
    askKitAbout.push(candidate);
  }

  // Chronological, in small windows, stopping as soon as there are enough.
  // A window may overshoot by at most `concurrency - 1` people, who are
  // recorded with their Kit state and simply not ranked — which is more
  // honest than pretending they were never considered.
  for (let at = 0; at < askKitAbout.length; at += concurrency) {
    if (safeFound >= requested) break;
    const window = askKitAbout.slice(at, at + concurrency);
    const verdicts = await Promise.all(
      window.map(async (candidate) => ({
        candidate,
        verdict: await resolveKitState(kit, candidate.email ?? "", {
          // LOOK, never create. Creating a subscriber hours before anybody
          // confirms the batch would be a side effect nobody asked for.
          allowCreate: false,
        }),
        checkedAt: new Date().toISOString(),
      })),
    );

    for (const { candidate, verdict, checkedAt } of verdicts) {
      const safe = verdict.safe;
      const rank = safe && safeFound < requested ? ++safeFound : null;
      rows.push({
        waitlistEntryId: candidate.waitlist_entry_id,
        contactId: candidate.contact_id,
        name: candidate.contact_name,
        email: candidate.email,
        joinedAt: candidate.joined_at,
        dbEligible: true,
        dbExclusionReason: null,
        kitSubscriberId: verdict.safe
          ? verdict.subscriberId || null
          : (verdict.subscriberId ?? null),
        kitState: verdict.safe ? verdict.state : (verdict.state ?? null),
        kitCheckedAt: checkedAt,
        // Safe but past the number asked for: eligible, simply not in this
        // batch. Recorded so the next preflight does not have to rediscover
        // them and so the audit shows how far down the list it reached.
        finalEligible: safe && rank != null,
        exclusionReason: safe
          ? rank == null
            ? "beyond-the-number-asked-for"
            : null
          : verdict.reason,
        finalRank: rank,
      });
    }
  }

  const { preflightId } = await db.saveSnapshot({
    offerId,
    cohortId,
    requested,
    resolved: safeFound,
    createdBy,
    rows,
  });

  return {
    preflightId,
    requested,
    resolved: safeFound,
    // Enough people, or not — said plainly rather than left to be counted.
    shortBy: Math.max(0, requested - safeFound),
    rows,
  };
};
