// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { KitClient } from "../_shared/kit";
import {
  MAX_TRANSIENT_ATTEMPTS,
  processKitSyncOperations,
  shouldRequeue,
  type KitSyncOperation,
} from "./kitSyncProcessor";

// The worker, against a mock Kit and a mock database. No Kit call, no
// Supabase project, and no real person anywhere near it.

const operation = (over: Partial<KitSyncOperation> = {}): KitSyncOperation => ({
  id: 1,
  application_id: 10,
  contact_id: 100,
  kind: "applicant",
  email: "ada@example.com",
  kit_tag_id: 24082722,
  kit_tag_name: "MiniDD_Applicant",
  attempts: 1,
  ...over,
});

const buildDb = (claimed: KitSyncOperation[]) => {
  const succeeded: Array<[number, string]> = [];
  const failed: Array<[number, string, string, boolean]> = [];
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  return {
    succeeded,
    failed,
    rpcCalls,
    db: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push([fn, args]);
        if (fn === "claim_kit_sync_operations") {
          return { data: claimed, error: null };
        }
        if (fn === "reconcile_kit_identities") {
          return { data: 0, error: null };
        }
        return { data: null, error: null };
      },
      markSucceeded: async (id: number, subscriberId: string) => {
        succeeded.push([id, subscriberId]);
      },
      markFailed: async (
        id: number,
        cls: string,
        reason: string,
        requeue: boolean,
      ) => {
        failed.push([id, cls, reason, requeue]);
      },
    },
  };
};

const kitThat = (over: Partial<KitClient> = {}): KitClient => ({
  findSubscriber: vi.fn().mockResolvedValue({
    ok: true,
    value: { subscriberId: "42", state: "active" },
  }),
  upsertSubscriber: vi
    .fn()
    .mockResolvedValue({ ok: true, value: { subscriberId: "42" } }),
  addTag: vi
    .fn()
    .mockResolvedValue({ ok: true, value: { subscriberId: "42" } }),
  ...over,
});

describe("doing the work", () => {
  it("upserts the subscriber, applies the tag, and records the subscriber Kit returned", async () => {
    const { db, succeeded, rpcCalls } = buildDb([operation()]);
    const kit = kitThat();

    const summary = await processKitSyncOperations({ db, kit });

    expect(summary).toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      requeued: 0,
      identitiesRepaired: 0,
      identityProblems: 0,
    });
    expect(kit.upsertSubscriber).toHaveBeenCalledWith("ada@example.com");
    expect(kit.addTag).toHaveBeenCalledWith(24082722, "ada@example.com");
    expect(succeeded).toEqual([[1, "42"]]);
    // And the person-to-Kit link goes through the CRM's own identity
    // authority, not a second one invented here.
    const identity = rpcCalls.find(([fn]) => fn === "record_external_identity");
    expect(identity?.[1]).toMatchObject({
      p_provider: "kit",
      p_external_user_id: "42",
      p_email: "ada@example.com",
    });
  });

  it("applies the tag the operation carries, never one it works out itself", async () => {
    const { db } = buildDb([
      operation({ kind: "decision", kit_tag_id: 21481382 }),
    ]);
    const kit = kitThat();

    await processKitSyncOperations({ db, kit });

    expect(kit.addTag).toHaveBeenCalledWith(21481382, "ada@example.com");
  });

  it("does the subscriber first, because the tag needs somebody to attach to", async () => {
    const order: string[] = [];
    const { db } = buildDb([operation()]);
    const kit = kitThat({
      upsertSubscriber: vi.fn().mockImplementation(async () => {
        order.push("subscriber");
        return { ok: true, value: { subscriberId: "42" } };
      }),
      addTag: vi.fn().mockImplementation(async () => {
        order.push("tag");
        return { ok: true, value: { subscriberId: "42" } };
      }),
    });

    await processKitSyncOperations({ db, kit });

    expect(order).toEqual(["subscriber", "tag"]);
  });
});

describe("when Kit says no", () => {
  it("records the class and the reason, and never claims success", async () => {
    const { db, succeeded, failed } = buildDb([operation()]);
    const kit = kitThat({
      upsertSubscriber: vi.fn().mockResolvedValue({
        ok: false,
        failureClass: "provider_unavailable",
        reason: "Kit responded 503",
      }),
    });

    const summary = await processKitSyncOperations({ db, kit });

    // Transient, and only the first attempt, so it goes back on the queue
    // rather than waiting for somebody to press a button.
    expect(summary).toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 0,
      requeued: 1,
      identitiesRepaired: 0,
      identityProblems: 0,
    });
    expect(succeeded).toEqual([]);
    expect(failed).toEqual([
      [1, "provider_unavailable", "Kit responded 503", true],
    ]);
  });

  it("does not tag when the subscriber never got made", async () => {
    const { db } = buildDb([operation()]);
    const kit = kitThat({
      upsertSubscriber: vi
        .fn()
        .mockResolvedValue({ ok: false, failureClass: "auth", reason: "no" }),
    });

    await processKitSyncOperations({ db, kit });

    expect(kit.addTag).not.toHaveBeenCalled();
  });

  it("fails only the person it happened to — the queue keeps going", async () => {
    const { db, succeeded, failed } = buildDb([
      operation({ id: 1, email: "first@example.com" }),
      operation({ id: 2, email: "second@example.com" }),
      operation({ id: 3, email: "third@example.com" }),
    ]);
    const kit = kitThat({
      upsertSubscriber: vi.fn().mockImplementation(async (email: string) =>
        email === "second@example.com"
          ? {
              ok: false,
              failureClass: "rejected",
              reason: "Kit responded 422",
            }
          : { ok: true, value: { subscriberId: `id-${email}` } },
      ),
    });

    const summary = await processKitSyncOperations({ db, kit });

    expect(summary).toEqual({
      claimed: 3,
      succeeded: 2,
      failed: 1,
      requeued: 0,
      identitiesRepaired: 0,
      identityProblems: 0,
    });
    expect(succeeded.map(([id]) => id)).toEqual([1, 3]);
    expect(failed.map(([id]) => id)).toEqual([2]);
  });

  it("treats an unexpected throw as that one person's failure, still retryable", async () => {
    const { db, failed } = buildDb([operation()]);
    const kit = kitThat({
      addTag: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const summary = await processKitSyncOperations({ db, kit });

    expect(summary.failed).toBe(1);
    expect(failed[0][1]).toBe("unknown");
  });

  it("still calls the tag applied when only the identity bookkeeping failed", async () => {
    const { succeeded, db } = buildDb([operation()]);
    const failingDb = {
      ...db,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "record_external_identity") throw new Error("nope");
        return db.rpc(fn, args);
      },
    };
    const kit = kitThat();

    const summary = await processKitSyncOperations({ db: failingDb, kit });

    expect(summary.succeeded).toBe(1);
    expect(succeeded).toEqual([[1, "42"]]);
  });
});

describe("a bad minute at Kit does not need a human", () => {
  it.each([
    ["rate_limited", true],
    ["provider_unavailable", true],
    ["network", true],
    ["auth", false],
    ["rejected", false],
    ["unknown", false],
  ])("%s is put back for the next pass: %s", (failureClass, expected) => {
    expect(shouldRequeue(failureClass, 1)).toBe(expected);
  });

  it("stops asking after enough tries, so a real outage still surfaces", () => {
    expect(
      shouldRequeue("provider_unavailable", MAX_TRANSIENT_ATTEMPTS - 1),
    ).toBe(true);
    expect(shouldRequeue("provider_unavailable", MAX_TRANSIENT_ATTEMPTS)).toBe(
      false,
    );
  });

  it("marks a spent transient failure as failed, so the card appears", async () => {
    const { db, failed } = buildDb([
      operation({ attempts: MAX_TRANSIENT_ATTEMPTS }),
    ]);
    const kit = kitThat({
      upsertSubscriber: vi.fn().mockResolvedValue({
        ok: false,
        failureClass: "network",
        reason: "Could not reach Kit",
      }),
    });

    const summary = await processKitSyncOperations({ db, kit });

    expect(summary.failed).toBe(1);
    expect(summary.requeued).toBe(0);
    expect(failed[0][3]).toBe(false);
  });

  it("never retries a wrong key or a refusal Kit will only repeat", async () => {
    const { db, failed } = buildDb([operation()]);
    const kit = kitThat({
      addTag: vi.fn().mockResolvedValue({
        ok: false,
        failureClass: "auth",
        reason: "Kit responded 401",
      }),
    });

    const summary = await processKitSyncOperations({ db, kit });

    expect(summary).toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      requeued: 0,
      identitiesRepaired: 0,
      identityProblems: 0,
    });
    expect(failed[0][3]).toBe(false);
  });
});

describe("the canonical Kit identity", () => {
  it("records it through the CRM's own authority, never a second one", async () => {
    const { db, rpcCalls } = buildDb([operation()]);

    await processKitSyncOperations({ db, kit: kitThat() });

    const identity = rpcCalls.find(([fn]) => fn === "record_external_identity");
    expect(identity?.[1]).toMatchObject({
      p_provider: "kit",
      p_external_user_id: "42",
      p_email: "ada@example.com",
    });
  });

  it("counts a refused identity write instead of discarding it", async () => {
    // The defect the first real acceptance event exposed: rpc() RETURNS an
    // error rather than throwing, so the answer has to be read.
    const { db } = buildDb([operation()]);
    const watching = {
      ...db,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "record_external_identity") {
          return { data: null, error: { message: "permission denied" } };
        }
        return db.rpc(fn, args);
      },
    };

    const summary = await processKitSyncOperations({
      db: watching,
      kit: kitThat(),
    });

    expect(summary.identityProblems).toBe(1);
    // And the tag still succeeded, because Kit really did apply it.
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("repairs a missing identity from stored evidence before doing any tag work", async () => {
    const { db, rpcCalls } = buildDb([]);
    const repairing = {
      ...db,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "reconcile_kit_identities") return { data: 2, error: null };
        return db.rpc(fn, args);
      },
    };

    const summary = await processKitSyncOperations({
      db: repairing,
      kit: kitThat(),
    });

    expect(summary.identitiesRepaired).toBe(2);
    // No provider call was needed to repair anybody.
    expect(rpcCalls.every(([fn]) => fn !== "record_external_identity")).toBe(
      true,
    );
  });

  it("does not let a failed repair stop the queue", async () => {
    const { db } = buildDb([operation()]);
    const broken = {
      ...db,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "reconcile_kit_identities") {
          return { data: null, error: { message: "nope" } };
        }
        return db.rpc(fn, args);
      },
    };

    const summary = await processKitSyncOperations({
      db: broken,
      kit: kitThat(),
    });

    expect(summary.succeeded).toBe(1);
    expect(summary.identityProblems).toBeGreaterThanOrEqual(1);
  });
});

describe("claiming", () => {
  it("asks the database for its work rather than scanning the table itself", async () => {
    const { db, rpcCalls } = buildDb([]);

    const summary = await processKitSyncOperations({
      db,
      kit: kitThat(),
      limit: 5,
    });

    expect(rpcCalls[0]).toEqual(["claim_kit_sync_operations", { p_limit: 5 }]);
    expect(summary).toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
      requeued: 0,
      identitiesRepaired: 0,
      identityProblems: 0,
    });
  });

  it("calls nothing at all when there is nothing to do", async () => {
    const { db } = buildDb([]);
    const kit = kitThat();

    await processKitSyncOperations({ db, kit });

    expect(kit.upsertSubscriber).not.toHaveBeenCalled();
    expect(kit.addTag).not.toHaveBeenCalled();
  });

  it("stops rather than guessing when the claim itself fails", async () => {
    const db = {
      rpc: async () => ({ data: null, error: { message: "connection lost" } }),
      markSucceeded: async () => {},
      markFailed: async () => {},
    };

    await expect(
      processKitSyncOperations({ db, kit: kitThat() }),
    ).rejects.toThrow(/connection lost/);
  });
});

// The consent gate, which only invitations pass through.
//
// Kit v4's POST /subscribers updates an existing subscriber's fields and
// does NOT change their state, so it can neither report consent nor grant
// it. The state is read with GET /v4/subscribers, and anybody Kit holds as
// cancelled, complained, bounced or inactive is somebody who has told Kit
// to stop.
//
// The unsafe states are stubbed here rather than created in Kit: making a
// genuinely cancelled subscriber in Leif's real account to watch the gate
// work would contaminate the account with a person who does not exist. The
// ACTIVE path is the one that has to be proved against real Kit.
describe("an invitation asks Kit whether it may be sent", () => {
  const invitation = (over: Partial<KitSyncOperation> = {}) =>
    operation({
      kind: "waitlist_invited",
      origin: "waitlist_invitation",
      application_id: null,
      kit_tag_name: "LE_Waitlist_Invited",
      ...over,
    });

  const kitHolding = (state: string): KitClient =>
    kitThat({
      findSubscriber: vi.fn().mockResolvedValue({
        ok: true,
        value: { subscriberId: "sub-9", state },
      }),
    });

  for (const state of ["cancelled", "complained", "bounced", "inactive"]) {
    it(`never tags somebody Kit holds as ${state}`, async () => {
      const { db, succeeded, failed } = buildDb([invitation()]);
      const kit = kitHolding(state);

      const summary = await processKitSyncOperations({ db, kit });

      // No tag call at all, and no subscriber written: the person is left
      // exactly as Kit has them.
      expect(kit.addTag).not.toHaveBeenCalled();
      expect(kit.upsertSubscriber).not.toHaveBeenCalled();
      expect(succeeded).toHaveLength(0);
      // Failed with the exact state, and NOT requeued — nothing about
      // retrying changes somebody's mind about unsubscribing.
      expect(failed).toHaveLength(1);
      const [, failureClass, reason, requeue] = failed[0]!;
      expect(failureClass).toBe("unsafe_state");
      expect(reason).toContain(`kit-${state}`);
      expect(requeue).toBe(false);
      expect(summary.failed).toBe(1);
      expect(summary.requeued).toBe(0);
    });
  }

  it("treats a state nobody has reasoned about as unsafe", async () => {
    const { db, failed } = buildDb([invitation()]);
    const kit = kitHolding("quarantined");

    await processKitSyncOperations({ db, kit });

    expect(kit.addTag).not.toHaveBeenCalled();
    expect(failed[0]![1]).toBe("unsafe_state");
    expect(failed[0]![2]).toContain("kit-quarantined");
  });

  it("tags somebody Kit holds as active, without touching their subscription", async () => {
    const { db, succeeded } = buildDb([invitation()]);
    const kit = kitHolding("active");

    await processKitSyncOperations({ db, kit });

    expect(kit.addTag).toHaveBeenCalledWith(24082722, "ada@example.com");
    // Already a subscriber in good standing: nothing is created, and
    // nothing about their subscription is written.
    expect(kit.upsertSubscriber).not.toHaveBeenCalled();
    expect(succeeded).toEqual([[1, "sub-9"]]);
  });

  it("creates somebody Kit has never heard of, then confirms before tagging", async () => {
    const { db, succeeded } = buildDb([invitation()]);
    const findSubscriber = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: null })
      .mockResolvedValueOnce({
        ok: true,
        value: { subscriberId: "sub-new", state: "active" },
      });
    const kit = kitThat({ findSubscriber });

    await processKitSyncOperations({ db, kit });

    // The canonical creation path, not a second one.
    expect(kit.upsertSubscriber).toHaveBeenCalledWith("ada@example.com");
    // And confirmed afterwards rather than assumed.
    expect(findSubscriber).toHaveBeenCalledTimes(2);
    expect(succeeded).toEqual([[1, "sub-new"]]);
  });

  it("refuses to tag a new subscriber Kit will not send to", async () => {
    const { db, succeeded, failed } = buildDb([invitation()]);
    const kit = kitThat({
      findSubscriber: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: null })
        .mockResolvedValueOnce({
          ok: true,
          value: { subscriberId: "sub-new", state: "inactive" },
        }),
    });

    await processKitSyncOperations({ db, kit });

    expect(kit.addTag).not.toHaveBeenCalled();
    expect(succeeded).toHaveLength(0);
    expect(failed[0]![2]).toContain("kit-inactive");
  });

  it("retries when Kit itself could not be reached", async () => {
    // Not a consent answer: Kit never gave one. The next pass is the fix.
    const { db, failed } = buildDb([invitation()]);
    const kit = kitThat({
      findSubscriber: vi.fn().mockResolvedValue({
        ok: false,
        failureClass: "provider_unavailable",
        reason: "Kit responded 503",
      }),
    });

    await processKitSyncOperations({ db, kit });

    expect(kit.addTag).not.toHaveBeenCalled();
    const [, failureClass, , requeue] = failed[0]!;
    expect(failureClass).toBe("provider_unavailable");
    expect(requeue).toBe(true);
  });

  it("leaves an applicant receipt alone — it is not a marketing send", async () => {
    // A tag that records something the person just did must keep being
    // recorded, whatever their subscription state.
    const { db, succeeded } = buildDb([operation()]);
    const kit = kitHolding("cancelled");

    await processKitSyncOperations({ db, kit });

    expect(kit.findSubscriber).not.toHaveBeenCalled();
    expect(kit.addTag).toHaveBeenCalled();
    expect(succeeded).toHaveLength(1);
  });
});
