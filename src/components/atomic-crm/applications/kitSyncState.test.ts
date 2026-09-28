import { describe, expect, it } from "vitest";

import {
  kitFailureSentence,
  kitSyncState,
  STALE_AFTER_MS,
  type KitSyncOperation,
} from "./kitSyncState";

// What the Application page is allowed to say, and — more importantly — when
// it is allowed to say nothing.

const NOW = new Date("2026-09-29T12:00:00.000Z");
const minutesAgo = (n: number) =>
  new Date(NOW.getTime() - n * 60 * 1000).toISOString();

const op = (over: Partial<KitSyncOperation> = {}): KitSyncOperation =>
  ({
    id: 1,
    application_id: 10,
    contact_id: 100,
    kind: "applicant",
    email: "ada@example.com",
    kit_tag_id: 24082722,
    kit_tag_name: "MiniDD_Applicant",
    status: "pending",
    attempts: 0,
    last_attempt_at: null,
    succeeded_at: null,
    failed_at: null,
    failure_class: null,
    failure_reason: null,
    kit_subscriber_id: null,
    created_at: minutesAgo(1),
    updated_at: minutesAgo(1),
    ...over,
  }) as KitSyncOperation;

describe("an application Kit was never going to hear about", () => {
  it("says nothing at all, rather than inventing a problem", () => {
    // An imported record, an unmapped programme, a submission from before the
    // integration, somebody the CRM refused at the door: all of them arrive
    // here as no operations, and all of them mean silence.
    expect(kitSyncState([], NOW)).toEqual({ kind: "not-managed" });
  });
});

describe("while it is on its way", () => {
  it("is quiet for work that has only just been queued", () => {
    expect(kitSyncState([op()], NOW)).toEqual({ kind: "working", tags: [] });
  });

  it("stays quiet while a claimed operation is being processed", () => {
    expect(
      kitSyncState([op({ status: "processing", attempts: 1 })], NOW).kind,
    ).toBe("working");
  });

  it("names what already landed while the rest is still going", () => {
    const state = kitSyncState(
      [
        op({
          id: 1,
          status: "succeeded",
          succeeded_at: minutesAgo(2),
          kit_subscriber_id: "42",
        }),
        op({ id: 2, kind: "decision", kit_tag_name: "MiniDD_Approved" }),
      ],
      NOW,
    );
    expect(state).toEqual({ kind: "working", tags: ["MiniDD_Applicant"] });
  });
});

describe("when everything owed has been applied", () => {
  it("reports the tags, in the order they were owed", () => {
    const done = (over: Partial<KitSyncOperation>) =>
      op({
        status: "succeeded",
        succeeded_at: minutesAgo(2),
        kit_subscriber_id: "42",
        ...over,
      });
    expect(
      kitSyncState(
        [
          done({ id: 1 }),
          done({ id: 2, kind: "decision", kit_tag_name: "MiniDD_Approved" }),
        ],
        NOW,
      ),
    ).toEqual({
      kind: "done",
      tags: ["MiniDD_Applicant", "MiniDD_Approved"],
    });
  });
});

describe("when somebody has to look", () => {
  it("surfaces a failure with its class and Kit's own short reason", () => {
    const state = kitSyncState(
      [
        op({
          status: "failed",
          failed_at: minutesAgo(3),
          failure_class: "provider_unavailable",
          failure_reason: "Kit responded 503",
        }),
      ],
      NOW,
    );
    expect(state).toEqual({
      kind: "needs-attention",
      tags: [],
      failureClass: "provider_unavailable",
      detail: "Kit responded 503",
      isRetryable: true,
    });
  });

  it("raises work that has been waiting far too long, even without a failure", () => {
    const state = kitSyncState(
      [
        op({
          created_at: new Date(
            NOW.getTime() - STALE_AFTER_MS - 1000,
          ).toISOString(),
        }),
      ],
      NOW,
    );
    expect(state.kind).toBe("needs-attention");
    // Nothing failed, so there is nothing to re-queue: pressing a button
    // would be theatre, and the card does not offer one.
    if (state.kind !== "needs-attention") return;
    expect(state.isRetryable).toBe(false);
  });

  it("does not raise work that is merely a few minutes old", () => {
    expect(
      kitSyncState(
        [
          op({
            created_at: new Date(
              NOW.getTime() - STALE_AFTER_MS + 1000,
            ).toISOString(),
          }),
        ],
        NOW,
      ).kind,
    ).toBe("working");
  });

  it("still reports what did land, so a half-done sync is legible", () => {
    const state = kitSyncState(
      [
        op({
          id: 1,
          status: "succeeded",
          succeeded_at: minutesAgo(5),
          kit_subscriber_id: "42",
        }),
        op({
          id: 2,
          kind: "decision",
          kit_tag_name: "MiniDD_Approved",
          status: "failed",
          failed_at: minutesAgo(1),
          failure_class: "rejected",
          failure_reason: "Kit responded 422: Tag not found",
        }),
      ],
      NOW,
    );
    expect(state.kind).toBe("needs-attention");
    if (state.kind !== "needs-attention") return;
    expect(state.tags).toEqual(["MiniDD_Applicant"]);
  });
});

describe("what Leif reads first", () => {
  it("says what went wrong in his terms, never in the provider's", () => {
    const sentences = [
      kitFailureSentence("auth"),
      kitFailureSentence("rejected"),
      kitFailureSentence("rate_limited"),
      kitFailureSentence("provider_unavailable"),
      kitFailureSentence("network"),
      kitFailureSentence("not_configured"),
      kitFailureSentence("unknown"),
      kitFailureSentence(null),
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/\b[45]\d\d\b/);
      expect(sentence.toLowerCase()).not.toMatch(
        /http|json|payload|api|token|secret|endpoint/,
      );
      expect(sentence.endsWith(".")).toBe(true);
    }
    expect(kitFailureSentence("provider_unavailable")).toBe(
      "Kit was unavailable.",
    );
  });
});
