import { describe, expect, it } from "vitest";

import {
  KIT_STATUS_LABELS,
  kitFailureSentence,
  kitStatus,
  requiredKitTags,
  STALE_AFTER_MS,
} from "./kitStatus";
import { kitEventRisk, kitRiskWarning } from "./kitAutomationRisk";
import type {
  Application,
  ApplicationStatus,
  KitSyncOperation,
  KitTagMapping,
} from "../types";

// The one question the Application has to answer: is Kit handling this, or is
// it Leif's to do by hand? Every branch is pinned, because the expensive
// mistake is the silent one — reviewing somebody while assuming an email will
// go out that never will.

const NOW = new Date("2026-09-29T12:00:00.000Z");
const BOUNDARY = "2026-09-28T23:04:40.000Z";
const minutesAgo = (n: number) =>
  new Date(NOW.getTime() - n * 60 * 1000).toISOString();

const LE_TAGS = {
  applicant: { id: 24082722, name: "MiniDD_Applicant" },
  approved: { id: 21784073, name: "MiniDD_Approved" },
  needs_higher_care: { id: 24082725, name: "MiniDD_NeedsHigherCare" },
  not_fit: { id: 21784076, name: "MiniDD_Denied" },
};

const MAPPINGS: KitTagMapping[] = Object.entries(LE_TAGS).map(
  ([event, tag], index) =>
    ({
      id: index + 1,
      offer_id: 1,
      event,
      kit_tag_id: tag.id,
      kit_tag_name: tag.name,
      created_at: "2026-09-28T23:04:40.000Z",
    }) as KitTagMapping,
);

// After the boundary by default: the automatic integration's world.
const app = (over: Partial<Application> = {}) =>
  ({
    id: 9,
    contact_id: 3,
    status: "pending",
    source: "public_form",
    offer_id: 1,
    intended_cohort_id: null,
    created_at: "2026-09-29T09:00:00.000Z",
    ...over,
  }) as Application;

const preBoundary = (over: Partial<Application> = {}) =>
  app({ created_at: "2026-09-21T14:00:00.000Z", ...over });

const op = (over: Partial<KitSyncOperation> = {}) =>
  ({
    id: 1,
    application_id: 9,
    contact_id: 3,
    kind: "applicant",
    origin: "automatic_application",
    requested_by: null,
    email: "ada@example.com",
    kit_tag_id: LE_TAGS.applicant.id,
    kit_tag_name: LE_TAGS.applicant.name,
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

const manual = (over: Partial<KitSyncOperation> = {}) =>
  op({
    application_id: null,
    kind: "manual",
    origin: "manual_owner",
    requested_by: "leif@leifariel.com",
    ...over,
  });

const state = (over: Parameters<typeof kitStatus>[0]) =>
  kitStatus({ mappings: MAPPINGS, notBefore: BOUNDARY, now: NOW, ...over });

describe("automatic — Kit is handling it", () => {
  it("says Tagged once the programme tag has landed on a pending application", () => {
    const status = state({ application: app(), operations: [done()] });
    expect(status.kind).toBe("tagged");
    expect(status.label).toBe("Kit: Tagged ✓");
  });

  it("says Tagged on a decided application only once BOTH tags have landed", () => {
    const status = state({
      application: app({ status: "approved" }),
      operations: [
        done(),
        done({
          id: 2,
          kind: "decision",
          kit_tag_id: LE_TAGS.approved.id,
          kit_tag_name: LE_TAGS.approved.name,
        }),
      ],
    });
    expect(status.kind).toBe("tagged");
  });

  it("does not call a decided application Tagged on the applicant tag alone", () => {
    const status = state({
      application: app({ status: "approved" }),
      operations: [
        done(),
        op({ id: 2, kind: "decision", kit_tag_id: LE_TAGS.approved.id }),
      ],
    });
    expect(status.kind).toBe("syncing");
  });

  it("counts a cohort tag as required when the round has one", () => {
    const status = state({
      application: app({ intended_cohort_id: 4 }),
      cohortTag: { kitTagId: 991234, kitTagName: "GYU_Jan2027" },
      operations: [done()],
    });
    // The programme tag landed; the round's has not.
    expect(status.kind).not.toBe("tagged");
  });

  it("is Tagged once both the programme and the round tag have landed", () => {
    const status = state({
      application: app({ intended_cohort_id: 4 }),
      cohortTag: { kitTagId: 991234, kitTagName: "GYU_Jan2027" },
      operations: [
        done(),
        done({
          id: 2,
          kind: "cohort",
          kit_tag_id: 991234,
          kit_tag_name: "GYU_Jan2027",
        }),
      ],
    });
    expect(status.kind).toBe("tagged");
  });
});

describe("automatic — somebody has to look", () => {
  it("says Needs attention for a refusal, and offers a retry", () => {
    const status = state({
      application: app(),
      operations: [
        op({
          status: "failed",
          failed_at: minutesAgo(1),
          failure_class: "provider_unavailable",
          failure_reason: "Kit responded 503",
        }),
      ],
    });
    expect(status.kind).toBe("attention");
    expect(status.isRetryable).toBe(true);
    expect(status.detail).toBe("Kit responded 503");
  });

  it("raises work that has waited far too long, with nothing to re-queue", () => {
    const status = state({
      application: app(),
      operations: [
        op({
          created_at: new Date(
            NOW.getTime() - STALE_AFTER_MS - 1000,
          ).toISOString(),
        }),
      ],
    });
    expect(status.kind).toBe("attention");
    expect(status.isRetryable).toBe(false);
  });

  it("does not let a Do Not Engage decision bury a row that already failed", () => {
    const status = state({
      application: app({ status: "do_not_engage" }),
      operations: [
        op({
          status: "failed",
          failed_at: minutesAgo(1),
          failure_class: "auth",
        }),
      ],
    });
    expect(status.kind).toBe("attention");
  });
});

describe("manual — it predates the integration, so the tags are Leif's", () => {
  it("names what is still missing rather than only saying 'email manually'", () => {
    const status = state({ application: preBoundary(), operations: [] });
    expect(status.kind).toBe("manual-action");
    expect(status.label).toBe("Kit: Manual — action needed");
    expect(status.required).toEqual([
      {
        event: "applicant",
        kitTagId: 24082722,
        kitTagName: "MiniDD_Applicant",
        done: false,
      },
    ]);
  });

  it("is up to date once the applicant tag is provider-confirmed", () => {
    const status = state({
      application: preBoundary(),
      operations: [
        manual({
          status: "succeeded",
          succeeded_at: minutesAgo(1),
          kit_subscriber_id: "42",
        }),
      ],
    });
    expect(status.kind).toBe("manual-done");
    expect(status.label).toBe("Kit: Manual — up to date ✓");
  });

  it("never says Tagged for manual work, because the lifecycle is not being followed", () => {
    const status = state({
      application: preBoundary(),
      operations: [
        manual({
          status: "succeeded",
          succeeded_at: minutesAgo(1),
          kit_subscriber_id: "42",
        }),
      ],
    });
    expect(status.kind).not.toBe("tagged");
    expect(status.label).not.toContain("Tagged");
  });

  it("re-enters the queue when the CRM decision adds a required tag", () => {
    const status = state({
      application: preBoundary({ status: "approved" }),
      operations: [
        manual({
          status: "succeeded",
          succeeded_at: minutesAgo(1),
          kit_subscriber_id: "42",
        }),
      ],
    });
    expect(status.kind).toBe("manual-action");
    expect(status.required.map((tag) => [tag.kitTagName, tag.done])).toEqual([
      ["MiniDD_Applicant", true],
      ["MiniDD_Approved", false],
    ]);
  });

  it("is up to date again once the decision tag is confirmed too", () => {
    const status = state({
      application: preBoundary({ status: "approved" }),
      operations: [
        manual({
          status: "succeeded",
          succeeded_at: minutesAgo(1),
          kit_subscriber_id: "42",
        }),
        manual({
          id: 2,
          kit_tag_id: LE_TAGS.approved.id,
          kit_tag_name: LE_TAGS.approved.name,
          status: "succeeded",
          succeeded_at: minutesAgo(1),
          kit_subscriber_id: "42",
        }),
      ],
    });
    expect(status.kind).toBe("manual-done");
  });

  it.each(["needs_higher_care", "not_fit"] as const)(
    "requires the %s tag once that decision is recorded",
    (decision) => {
      const status = state({
        application: preBoundary({ status: decision }),
        operations: [
          manual({
            status: "succeeded",
            succeeded_at: minutesAgo(1),
            kit_subscriber_id: "42",
          }),
        ],
      });
      expect(status.kind).toBe("manual-action");
      expect(
        status.required.some((tag) => tag.event === decision && !tag.done),
      ).toBe(true);
    },
  );
});

// Asked for, and on its way. The rows exist, so nobody needs to act — the
// same thing the automatic side has always said with "Syncing…".
describe("manual — already asked for", () => {
  it("is syncing, not action needed, once every missing tag is queued", () => {
    const status = state({
      application: preBoundary({ status: "approved" as ApplicationStatus }),
      operations: [
        manual({ kit_tag_id: LE_TAGS.applicant.id, status: "pending" }),
        manual({
          id: 2,
          kit_tag_id: LE_TAGS.approved.id,
          kit_tag_name: LE_TAGS.approved.name,
          status: "pending",
        }),
      ],
    });
    expect(status.kind).toBe("manual-syncing");
    expect(status.label).toBe("Kit: Syncing…");
    expect(status.required).toHaveLength(2);
  });

  it("still needs action while only SOME of it has been asked for", () => {
    const status = state({
      application: preBoundary({ status: "approved" as ApplicationStatus }),
      operations: [
        manual({ kit_tag_id: LE_TAGS.applicant.id, status: "pending" }),
      ],
    });
    expect(status.kind).toBe("manual-action");
  });

  it("hands a failed manual request to the existing Needs attention state", () => {
    const status = state({
      application: preBoundary({ status: "approved" as ApplicationStatus }),
      operations: [
        manual({
          kit_tag_id: LE_TAGS.approved.id,
          kit_tag_name: LE_TAGS.approved.name,
          status: "failed",
          failed_at: minutesAgo(1),
          failure_class: "rejected",
        }),
      ],
    });
    expect(status.kind).toBe("attention");
    expect(status.isRetryable).toBe(true);
  });
});

describe("what the confirmation is allowed to claim", () => {
  it("says an outcome tag MAY trigger an automation, never that it is wired to one", () => {
    const sentence = kitRiskWarning(["MiniDD_Approved"]);
    expect(sentence).toBe(
      "MiniDD_Approved may trigger a Kit automation connected to that tag.",
    );
    expect(sentence).not.toMatch(/is connected|will send|sends an email/);
  });

  it("stays general for several, and silent for none", () => {
    expect(kitRiskWarning(["MiniDD_Approved", "MiniDD_Denied"])).toBe(
      "These tags may trigger Kit automations connected to them.",
    );
    expect(kitRiskWarning([])).toBeNull();
  });

  it("treats an applicant or cohort tag as quiet, and NHC as having no automation yet", () => {
    expect(kitEventRisk("applicant")).toBe("quiet");
    expect(kitEventRisk("cohort")).toBe("quiet");
    expect(kitEventRisk("needs_higher_care")).toBe("no-automation-yet");
    expect(kitEventRisk("approved")).toBe("sends-email");
    expect(kitEventRisk("not_fit")).toBe("sends-email");
  });
});

describe("Kit is not involved at all", () => {
  it("says the automation is not configured when the programme has no tags", () => {
    const status = state({
      application: preBoundary({ offer_id: 3 }),
      operations: [],
    });
    expect(status.kind).toBe("not-configured");
    expect(status.label).toBe("Kit: Automation not configured");
    // Never a guess, and never another programme's tag.
    expect(status.required).toEqual([]);
  });

  it("says Kit is not used for somebody the CRM refused", () => {
    const status = state({
      application: preBoundary({ status: "do_not_engage" }),
      operations: [],
    });
    expect(status.kind).toBe("not-used");
    expect(status.required).toEqual([]);
  });

  it.each(["pending", "approved", "denied", "waitlist"] as const)(
    "stays silent for an imported record, whatever status it preserved (%s)",
    (status: ApplicationStatus) => {
      const result = state({
        application: preBoundary({ source: "historical_import", status }),
        operations: [],
      });
      expect(result.kind).toBe("historical");
      expect(result.label).toBe("");
    },
  );
});

describe("what the current state requires", () => {
  it("is the programme tag while pending, and the outcome tag once decided", () => {
    expect(
      requiredKitTags({
        application: app(),
        mappings: MAPPINGS,
        operations: [],
      }).map((t) => t.event),
    ).toEqual(["applicant"]);
    expect(
      requiredKitTags({
        application: app({ status: "not_fit" }),
        mappings: MAPPINGS,
        operations: [],
      }).map((t) => t.event),
    ).toEqual(["applicant", "not_fit"]);
  });

  it("includes the round's tag between them when the round has one", () => {
    expect(
      requiredKitTags({
        application: app({ status: "approved" }),
        mappings: MAPPINGS,
        cohortTag: { kitTagId: 991234, kitTagName: "GYU_Jan2027" },
        operations: [],
      }).map((t) => t.event),
    ).toEqual(["applicant", "cohort", "approved"]);
  });

  it("requires nothing for a programme with no mappings", () => {
    expect(
      requiredKitTags({
        application: app({ offer_id: 99 }),
        mappings: MAPPINGS,
        operations: [],
      }),
    ).toEqual([]);
  });

  it("marks a tag done from any succeeded operation carrying that tag id", () => {
    const required = requiredKitTags({
      application: app(),
      mappings: MAPPINGS,
      operations: [
        manual({
          status: "succeeded",
          succeeded_at: minutesAgo(1),
          kit_subscriber_id: "42",
        }),
      ],
    });
    expect(required[0].done).toBe(true);
  });
});

describe("the copy itself", () => {
  it("is exactly the lines Leif asked for", () => {
    expect(KIT_STATUS_LABELS).toEqual({
      tagged: "Kit: Tagged ✓",
      syncing: "Kit: Syncing…",
      attention: "Kit: Needs attention",
      "manual-action": "Kit: Manual — action needed",
      "manual-done": "Kit: Manual — up to date ✓",
      "manual-syncing": "Kit: Syncing…",
      "not-configured": "Kit: Automation not configured",
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
