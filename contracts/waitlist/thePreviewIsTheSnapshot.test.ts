import { describe, expect, it } from "vitest";

import type { KitClient } from "../../supabase/functions/_shared/kit.ts";
import {
  runWaitlistPreflight,
  type PreflightCandidate,
} from "../../supabase/functions/kit_sync/waitlistPreflight.ts";
import {
  invitableIn,
  passedOverIn,
  readPreflightRow,
} from "@/components/atomic-crm/waitlist/waitlistInvitationActions";

// THE PREVIEW LEIF SEES IS THE SNAPSHOT THAT WAS WRITTEN.
//
// THE BUG THIS EXISTS FOR. Leif asked to invite 25 people to The Living
// Example and 30 to Growing Yourself Up. Both preflights ran, both snapshots
// were written correctly — 25 and 30 people ranked and invitable, read back
// independently from production afterwards — and both dialogs said
//
//   "Invite 0 people to apply to The Living Example"   28 skipped
//   "Invite 0 people to apply to Growing Yourself Up"  32 skipped
//
// with every person listed as skipped for no stated reason.
//
// The Edge Function returned its rows in camelCase. The browser's read model
// reads the snapshot's column names. So `raw.final_eligible === true` was
// false for everybody — not because they were ineligible, but because the
// field was not there — and `raw.exclusion_reason ?? null` was null, which
// is why the reasons were blank. The skipped COUNTS are the proof it was the
// reading and not the snapshot: 28 and 32 are the full candidate lists,
// where a correct read would have shown the 3 and the 2 who were merely
// past the number asked for.
//
// WHY NOTHING CAUGHT IT. Nothing exercised the seam. The mirror returns the
// snapshot's columns, so every demo-mode test passed. The real-Postgres spec
// writes its snapshot rows itself and reads them back from the database, so
// it passed. No test imported the real walker at all, and the one thing
// never exercised was the Edge Function's RESPONSE being read by the client
// that reads it. That is what this file does: the real function's output,
// through the real reader, into the real selection the dialog displays.

const person = (
  n: number,
  over: Partial<PreflightCandidate> = {},
): PreflightCandidate => ({
  waitlist_entry_id: n,
  contact_id: n,
  contact_name: `Person ${n}`,
  email: `p${n}@waitlist.test`,
  joined_at: `2026-01-01T09:${String(n % 60).padStart(2, "0")}:00.000Z`,
  eligible: true,
  exclusion_reason: null,
  ...over,
});

/**
 * What the database ends up holding.
 *
 * The column names are spelled out here deliberately rather than reusing the
 * function's own mapping: the snapshot's columns are what
 * `invite_from_preflight()` reads, so this file states them independently.
 * If the function's mapping drifts from them, that is the bug, and a test
 * built out of the mapping could not see it.
 */
const fakeDb = (candidates: PreflightCandidate[]) => {
  const stored: Record<string, unknown>[] = [];
  return {
    stored,
    db: {
      candidates: async () => candidates,
      saveSnapshot: async (input: {
        rows: Array<Record<string, unknown> & { waitlistEntryId: number }>;
      }) => {
        for (const row of input.rows) {
          stored.push({
            waitlist_entry_id: row.waitlistEntryId,
            contact_id: row.contactId,
            contact_name: row.name,
            email: row.email,
            joined_at: row.joinedAt,
            db_eligible: row.dbEligible,
            db_exclusion_reason: row.dbExclusionReason,
            kit_subscriber_id: row.kitSubscriberId,
            kit_state: row.kitState,
            kit_checked_at: row.kitCheckedAt,
            final_eligible: row.finalEligible,
            exclusion_reason: row.exclusionReason,
            final_rank: row.finalRank,
          });
        }
        return { preflightId: 77, expiresAt: null };
      },
    },
  };
};

/** Kit, answering about people it holds — and never asked to create one. */
const fakeKit = (states: Record<string, string>) => {
  const created: string[] = [];
  return {
    created,
    kit: {
      findSubscriber: async (email: string) => ({
        ok: true as const,
        value: states[email]
          ? { subscriberId: `sub-${email}`, state: states[email]! }
          : null,
      }),
      upsertSubscriber: async (email: string) => {
        created.push(email);
        throw new Error("the preflight must never create a Kit subscriber");
      },
    } as unknown as KitClient,
  };
};

/** The three numbers the dialog puts in front of Leif. */
const asTheDialogReadsIt = (result: { rows: Record<string, unknown>[] }) => {
  const rows = result.rows.map(readPreflightRow);
  return { rows, invitable: invitableIn(rows), skipped: passedOverIn(rows) };
};

describe("the number in the dialog is the number in the snapshot", () => {
  it("offers 25 of 40 when a quarter of the list is unsendable", async () => {
    // Every fourth person cancelled in Kit. They must not consume one of the
    // 25 places — the walk simply continues past them.
    const candidates = Array.from({ length: 40 }, (_, i) => person(i + 1));
    const states: Record<string, string> = {};
    for (const candidate of candidates) {
      states[candidate.email!] =
        candidate.waitlist_entry_id % 4 === 0 ? "cancelled" : "active";
    }
    const { db, stored } = fakeDb(candidates);
    const { kit, created } = fakeKit(states);

    const result = await runWaitlistPreflight({
      db,
      kit,
      offerId: 1,
      cohortId: null,
      requested: 25,
    });

    expect(result.resolved).toBe(25);
    expect(result.shortBy).toBe(0);

    const seen = asTheDialogReadsIt(result);
    // THE ASSERTION THE PRODUCTION FAILURE BROKE.
    expect(seen.invitable).toHaveLength(25);
    // And it is the same 25 the database holds, which is the set
    // invite_from_preflight() will act on.
    expect(stored.filter((row) => row.final_eligible === true)).toHaveLength(
      25,
    );
    expect(seen.invitable).toHaveLength(
      stored.filter((row) => row.final_eligible === true).length,
    );

    // Nobody Kit refuses is in the batch, and nobody was created.
    expect(seen.invitable.every((row) => row.kitState === "active")).toBe(true);
    expect(created).toEqual([]);

    // It had to look past 25 people to find 25 sendable ones.
    expect(stored.length).toBeGreaterThan(25);
  });

  it("offers 30 when the list is longer than 30 and all of it is sendable", async () => {
    const candidates = Array.from({ length: 48 }, (_, i) => person(i + 1));
    const states = Object.fromEntries(
      candidates.map((candidate) => [candidate.email!, "active"]),
    );
    const { db, stored } = fakeDb(candidates);
    const { kit } = fakeKit(states);

    const result = await runWaitlistPreflight({
      db,
      kit,
      offerId: 2,
      cohortId: null,
      requested: 30,
    });

    expect(result.resolved).toBe(30);
    const seen = asTheDialogReadsIt(result);
    expect(seen.invitable).toHaveLength(30);
    expect(stored.filter((row) => row.final_eligible === true)).toHaveLength(
      30,
    );

    // The ranks Leif's list is ordered by survived the crossing.
    expect(seen.invitable.map((row) => row.finalRank)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    // And it stopped once it had enough rather than walking all 48.
    expect(stored.length).toBeLessThan(48);
  });

  it("an active Kit subscriber and somebody Kit has never heard of are both invitable", async () => {
    const candidates = [person(1), person(2), person(3)];
    const { db } = fakeDb(candidates);
    // Person 2 is not in Kit at all. Never cancelled, never complained —
    // safe to invite, and created only when the batch is actually sent.
    const { kit, created } = fakeKit({
      "p1@waitlist.test": "active",
      "p3@waitlist.test": "active",
    });

    const result = await runWaitlistPreflight({
      db,
      kit,
      offerId: 1,
      cohortId: null,
      requested: 3,
    });

    const seen = asTheDialogReadsIt(result);
    expect(seen.invitable).toHaveLength(3);
    expect(seen.invitable.map((row) => row.kitState).sort()).toEqual([
      "active",
      "active",
      "missing",
    ]);
    expect(created).toEqual([]);
  });

  it("walks the whole list and says how far short it fell", async () => {
    const candidates = Array.from({ length: 12 }, (_, i) => person(i + 1));
    const { db, stored } = fakeDb(candidates);
    const { kit } = fakeKit({
      ...Object.fromEntries(
        candidates.map((candidate) => [candidate.email!, "active"]),
      ),
      "p3@waitlist.test": "bounced",
      "p7@waitlist.test": "complained",
    });

    const result = await runWaitlistPreflight({
      db,
      kit,
      offerId: 1,
      cohortId: null,
      requested: 30,
    });

    expect(result.resolved).toBe(10);
    expect(result.shortBy).toBe(20);
    expect(stored).toHaveLength(12);

    const seen = asTheDialogReadsIt(result);
    expect(seen.invitable).toHaveLength(10);
    expect(seen.skipped).toHaveLength(2);
  });

  it("every person the dialog lists as skipped has a name and a reason", async () => {
    // One of each kind of refusal: the database's, and Kit's.
    const candidates = [
      person(1),
      person(2, { eligible: false, exclusion_reason: "do-not-engage" }),
      person(3, { eligible: false, exclusion_reason: "already-applied" }),
      person(4),
      person(5),
    ];
    const { db } = fakeDb(candidates);
    const { kit } = fakeKit({
      "p1@waitlist.test": "active",
      "p4@waitlist.test": "cancelled",
      "p5@waitlist.test": "active",
    });

    const result = await runWaitlistPreflight({
      db,
      kit,
      offerId: 1,
      cohortId: null,
      requested: 2,
    });

    const seen = asTheDialogReadsIt(result);
    expect(seen.skipped.length).toBeGreaterThan(0);
    for (const row of seen.skipped) {
      // Blank reasons are exactly what Leif was shown, so both halves of
      // every skipped line are asserted.
      expect(row.name.trim()).not.toBe("");
      expect(row.exclusionReason ?? "").not.toBe("");
    }
    expect(seen.skipped.map((row) => row.exclusionReason).sort()).toEqual([
      "already-applied",
      "do-not-engage",
      "kit-cancelled",
    ]);
  });

  it("somebody merely past the number asked for is not reported as skipped", async () => {
    const candidates = Array.from({ length: 8 }, (_, i) => person(i + 1));
    const { db } = fakeDb(candidates);
    const { kit } = fakeKit(
      Object.fromEntries(
        candidates.map((candidate) => [candidate.email!, "active"]),
      ),
    );

    const result = await runWaitlistPreflight({
      db,
      kit,
      offerId: 1,
      cohortId: null,
      requested: 2,
      concurrency: 4,
    });

    const seen = asTheDialogReadsIt(result);
    expect(seen.invitable).toHaveLength(2);
    // The window overshot by two. They are recorded, and they are not
    // "skipped" — they are next time's candidates.
    expect(seen.rows).toHaveLength(4);
    expect(seen.skipped).toEqual([]);
  });

  it("asks Kit about nobody the database already ruled out", async () => {
    const candidates = [
      person(1, { eligible: false, exclusion_reason: "no-email", email: null }),
      person(2),
    ];
    const { db } = fakeDb(candidates);
    const asked: string[] = [];
    const kit = {
      findSubscriber: async (email: string) => {
        asked.push(email);
        return {
          ok: true as const,
          value: { subscriberId: "s", state: "active" },
        };
      },
      upsertSubscriber: async () => {
        throw new Error("never");
      },
    } as unknown as KitClient;

    const result = await runWaitlistPreflight({
      db,
      kit,
      offerId: 1,
      cohortId: null,
      requested: 5,
    });

    expect(asked).toEqual(["p2@waitlist.test"]);
    const seen = asTheDialogReadsIt(result);
    expect(seen.skipped.map((row) => row.exclusionReason)).toEqual([
      "no-email",
    ]);
  });
});

// The regression above is only worth having if it fails on the shape that
// actually shipped. This states that shape and proves it produces Leif's
// three symptoms, so the test cannot later be weakened into a tautology.
describe("the shape that shipped produced exactly what Leif saw", () => {
  const asItWasSent = (row: Record<string, unknown>) => ({
    waitlistEntryId: row.waitlist_entry_id,
    contactId: row.contact_id,
    name: row.contact_name,
    email: row.email,
    joinedAt: row.joined_at,
    dbEligible: row.db_eligible,
    dbExclusionReason: row.db_exclusion_reason,
    kitSubscriberId: row.kit_subscriber_id,
    kitState: row.kit_state,
    kitCheckedAt: row.kit_checked_at,
    finalEligible: row.final_eligible,
    exclusionReason: row.exclusion_reason,
    finalRank: row.final_rank,
  });

  it("25 invitable people are read as 0 invitable and 28 blank skips", async () => {
    const candidates = Array.from({ length: 40 }, (_, i) => person(i + 1));
    const { db, stored } = fakeDb(candidates);
    const { kit } = fakeKit(
      Object.fromEntries(
        candidates.map((candidate) => [candidate.email!, "active"]),
      ),
    );

    const result = await runWaitlistPreflight({
      db,
      kit,
      offerId: 1,
      cohortId: null,
      requested: 25,
    });

    // The snapshot is right, which is what production showed.
    expect(stored.filter((row) => row.final_eligible === true)).toHaveLength(
      25,
    );
    // 28, because the walk overshot to the end of its window of four.
    expect(stored).toHaveLength(28);

    const broken = result.rows
      .map((row) => asItWasSent(row as Record<string, unknown>))
      .map((row) => readPreflightRow(row as Record<string, unknown>));

    expect(invitableIn(broken)).toHaveLength(0);
    expect(passedOverIn(broken)).toHaveLength(28);
    expect(
      passedOverIn(broken).every(
        (row) => row.name === "" && row.exclusionReason === null,
      ),
    ).toBe(true);
  });
});
