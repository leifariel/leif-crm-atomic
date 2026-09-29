import { describe, expect, it } from "vitest";

import {
  KIT_STATUS_LABELS,
  kitFailureSentence,
  kitStatus,
  STALE_AFTER_MS,
} from "./kitStatus";
import type {
  Application,
  ApplicationStatus,
  KitSyncOperation,
} from "../types";

// The one question the Application has to answer at a glance: is Kit handling
// this, or is the decision email Leif's to send? Every branch of that answer
// is pinned here, because the expensive mistake is the silent one — reviewing
// somebody while assuming an email will go out that never will.

const NOW = new Date("2026-09-29T12:00:00.000Z");
const minutesAgo = (n: number) =>
  new Date(NOW.getTime() - n * 60 * 1000).toISOString();

const app = (over: Partial<Application> = {}) =>
  ({
    id: 9,
    contact_id: 3,
    status: "pending",
    source: "public_form",
    ...over,
  }) as Application;

const op = (over: Partial<KitSyncOperation> = {}) =>
  ({
    id: 1,
    application_id: 9,
    contact_id: 3,
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

const done = (over: Partial<KitSyncOperation> = {}) =>
  op({
    status: "succeeded",
    succeeded_at: minutesAgo(1),
    kit_subscriber_id: "42",
    ...over,
  });

const failed = (over: Partial<KitSyncOperation> = {}) =>
  op({
    status: "failed",
    failed_at: minutesAgo(1),
    failure_class: "provider_unavailable",
    failure_reason: "Kit responded 503",
    ...over,
  });

const DECISION = {
  kind: "decision" as const,
  kit_tag_id: 21784073,
  kit_tag_name: "MiniDD_Approved",
};

describe("Kit is handling it", () => {
  it("says Tagged once the programme tag has landed on a pending application", () => {
    const status = kitStatus({
      application: app(),
      operations: [done()],
      now: NOW,
    });
    expect(status.kind).toBe("tagged");
    expect(status.label).toBe("Kit: Tagged ✓");
    expect(status.isRetryable).toBe(false);
  });

  it("says Tagged on a decided application only once BOTH tags have landed", () => {
    const status = kitStatus({
      application: app({ status: "approved" }),
      operations: [done(), done({ id: 2, ...DECISION })],
      now: NOW,
    });
    expect(status.kind).toBe("tagged");
    expect(status.tags).toEqual(["MiniDD_Applicant", "MiniDD_Approved"]);
  });

  it.each(["approved", "needs_higher_care", "not_fit"] as const)(
    "requires the decision tag for %s, and says Syncing until it lands",
    (status) => {
      const result = kitStatus({
        application: app({ status }),
        operations: [done(), op({ id: 2, ...DECISION })],
        now: NOW,
      });
      expect(result.kind).toBe("syncing");
      expect(result.label).toBe("Kit: Syncing…");
    },
  );

  it("does not call a decided application Tagged on the applicant tag alone", () => {
    // The whole point: an approved applicant whose outcome tag never reached
    // Kit has not had their email sent, and must not read as finished.
    const status = kitStatus({
      application: app({ status: "approved" }),
      operations: [done()],
      now: NOW,
    });
    expect(status.kind).not.toBe("tagged");
  });

  it("says Syncing for work only just queued", () => {
    expect(
      kitStatus({ application: app(), operations: [op()], now: NOW }).kind,
    ).toBe("syncing");
  });

  it("stays Syncing while a claimed operation is being processed", () => {
    expect(
      kitStatus({
        application: app(),
        operations: [op({ status: "processing", attempts: 1 })],
        now: NOW,
      }).kind,
    ).toBe("syncing");
  });
});

describe("somebody has to look", () => {
  it("says Needs attention for a refusal, and offers a retry", () => {
    const status = kitStatus({
      application: app({ status: "approved" }),
      operations: [done(), failed({ id: 2, ...DECISION })],
      now: NOW,
    });
    expect(status.kind).toBe("attention");
    expect(status.label).toBe("Kit: Needs attention");
    expect(status.isRetryable).toBe(true);
    expect(status.failureClass).toBe("provider_unavailable");
    expect(status.detail).toBe("Kit responded 503");
    // What did land is still reported, so a half-done sync stays legible.
    expect(status.tags).toEqual(["MiniDD_Applicant"]);
  });

  it("raises work that has waited far too long, with nothing to re-queue", () => {
    const status = kitStatus({
      application: app(),
      operations: [
        op({
          created_at: new Date(
            NOW.getTime() - STALE_AFTER_MS - 1000,
          ).toISOString(),
        }),
      ],
      now: NOW,
    });
    expect(status.kind).toBe("attention");
    expect(status.isRetryable).toBe(false);
  });

  it("does not raise work that is merely a few minutes old", () => {
    expect(
      kitStatus({
        application: app(),
        operations: [
          op({
            created_at: new Date(
              NOW.getTime() - STALE_AFTER_MS + 1000,
            ).toISOString(),
          }),
        ],
        now: NOW,
      }).kind,
    ).toBe("syncing");
  });

  it("does not let a Do Not Engage decision bury a row that already failed", () => {
    // Ordinary Do Not Engage has no failed row, so nothing untrue is implied.
    // This one does, and a buried row is the invisible work the integration
    // exists to end.
    const status = kitStatus({
      application: app({ status: "do_not_engage" }),
      operations: [failed()],
      now: NOW,
    });
    expect(status.kind).toBe("attention");
  });
});

describe("Kit is NOT handling it — the state that has to be visible", () => {
  it("tells Leif to email a live public-form applicant manually", () => {
    const status = kitStatus({
      application: app({ source: "public_form" }),
      operations: [],
      now: NOW,
    });
    expect(status.kind).toBe("manual");
    expect(status.label).toBe("Kit: Not synced — email manually");
  });

  it("says the same for one Leif entered by hand", () => {
    expect(
      kitStatus({
        application: app({ source: "manual" }),
        operations: [],
        now: NOW,
      }).kind,
    ).toBe("manual");
  });

  it("says it for a decided one too, because that email is the one at stake", () => {
    expect(
      kitStatus({
        application: app({ status: "approved", source: "public_form" }),
        operations: [],
        now: NOW,
      }).kind,
    ).toBe("manual");
  });

  it("says it when operations exist but nothing is coming for the current state", () => {
    // Succeeded applicant tag, decided application, no decision operation and
    // nothing in flight: whatever produced that, the outcome email is manual.
    const status = kitStatus({
      application: app({ status: "not_fit" }),
      operations: [done()],
      now: NOW,
    });
    expect(status.kind).toBe("manual");
  });
});

describe("an imported record is history, not outstanding work", () => {
  it("is never presented as current unsynced work", () => {
    const status = kitStatus({
      application: app({ source: "historical_import" }),
      operations: [],
      now: NOW,
    });
    expect(status.kind).toBe("historical");
    expect(status.label).toBe("");
    expect(status.kind).not.toBe("manual");
  });

  it.each(["pending", "approved", "denied", "waitlist"] as const)(
    "stays historical whatever status the import preserved (%s)",
    (status: ApplicationStatus) => {
      expect(
        kitStatus({
          application: app({ source: "historical_import", status }),
          operations: [],
          now: NOW,
        }).kind,
      ).toBe("historical");
    },
  );
});

describe("Do Not Engage", () => {
  it("says Kit is not used, and implies no missing work", () => {
    const status = kitStatus({
      application: app({ status: "do_not_engage" }),
      operations: [],
      now: NOW,
    });
    expect(status.kind).toBe("not-used");
    expect(status.label).toBe("Kit: Not used");
    expect(status.isRetryable).toBe(false);
    expect(status.failureClass).toBeNull();
  });
});

describe("the copy itself", () => {
  it("is exactly the five lines Leif asked for", () => {
    expect(KIT_STATUS_LABELS).toEqual({
      tagged: "Kit: Tagged ✓",
      syncing: "Kit: Syncing…",
      attention: "Kit: Needs attention",
      manual: "Kit: Not synced — email manually",
      "not-used": "Kit: Not used",
      historical: "",
    });
  });

  it("never names a tag, a table or a status code in a label", () => {
    for (const label of Object.values(KIT_STATUS_LABELS)) {
      expect(label).not.toMatch(/MiniDD|GYU|kit_sync|\b[45]\d\d\b/);
    }
  });

  it("says what went wrong in Leif's terms, never the provider's", () => {
    for (const cls of [
      "auth",
      "rejected",
      "rate_limited",
      "provider_unavailable",
      "network",
      "not_configured",
      "unknown",
      null,
    ] as const) {
      const sentence = kitFailureSentence(cls);
      expect(sentence).not.toMatch(/\b[45]\d\d\b/);
      expect(sentence.toLowerCase()).not.toMatch(
        /http|json|payload|api|token|secret|endpoint/,
      );
      expect(sentence.endsWith(".")).toBe(true);
    }
  });
});
