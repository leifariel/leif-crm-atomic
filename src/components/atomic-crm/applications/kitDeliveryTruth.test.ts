import { describe, expect, it } from "vitest";

import { kitStatus, type KitSyncOperation } from "./kitStatus";
import type { Application, KitTagMapping } from "../types";

// Olivia Arms and Rae Lang, exactly as production holds them.
//
// Leif saw "Kit: Syncing…" on their pages and asked the only question that
// matters: did they actually get the GYU Approved tag? They did — both
// operations read `succeeded` with a succeeded_at and a kit_subscriber_id,
// which the database will not allow otherwise
// (kit_sync_operations_success_evidence_check).
//
// So this pins the reading for that exact shape. A page that says "Syncing…"
// over two succeeded operations is claiming work is in flight when none is.

const APPROVED_TAG = 7;
const APPLICANT_TAG = 3;

const mappings: KitTagMapping[] = [
  {
    id: 1,
    offer_id: 2,
    event: "applicant",
    kit_tag_id: APPLICANT_TAG,
    kit_tag_name: "GYU-Applicant",
  } as KitTagMapping,
  {
    id: 2,
    offer_id: 2,
    event: "approved",
    kit_tag_id: APPROVED_TAG,
    kit_tag_name: "GYU-Approved",
  } as KitTagMapping,
];

const succeeded = (
  id: number,
  tagId: number,
  tagName: string,
  at: string,
  origin: string,
): KitSyncOperation =>
  ({
    id,
    application_id: 211,
    contact_id: 41,
    kind: tagId === APPROVED_TAG ? "decision" : "applicant",
    email: "olivia@example.com",
    kit_tag_id: tagId,
    kit_tag_name: tagName,
    status: "succeeded",
    attempts: 1,
    succeeded_at: at,
    kit_subscriber_id: "4044509649",
    origin,
    created_at: at,
  }) as unknown as KitSyncOperation;

// Imported, reviewed here on 2026-10-04 — the Courtney Foregger shape.
const olivia = {
  id: 211,
  contact_id: 41,
  status: "approved",
  source: "historical_import",
  created_at: "2026-09-30T12:00:00.000Z",
  offer_id: 2,
  crm_adopted_at: null,
  reviewed_at: "2026-10-04T23:39:00.000Z",
  intended_cohort_id: 4,
} as unknown as Application;

describe("two tags that Kit has confirmed", () => {
  it("is never reported as still syncing", () => {
    const status = kitStatus({
      application: olivia,
      operations: [
        succeeded(
          18,
          APPLICANT_TAG,
          "GYU-Applicant",
          "2026-09-30T12:25:02.688Z",
          "manual_owner",
        ),
        succeeded(
          35,
          APPROVED_TAG,
          "GYU-Approved",
          "2026-10-04T23:40:03.646Z",
          "manual_owner",
        ),
      ],
      mappings,
      now: new Date("2026-10-05T01:00:00.000Z"),
    });

    expect(status.kind).not.toBe("syncing");
    expect(status.kind).not.toBe("manual-syncing");
    expect(status.label).not.toContain("Syncing");
    expect(status.required.every((tag) => tag.done)).toBe(true);
    expect(status.tags).toEqual(["GYU-Applicant", "GYU-Approved"]);
  });

  it("says so for an automatically-managed application too", () => {
    const status = kitStatus({
      application: olivia,
      operations: [
        succeeded(
          18,
          APPLICANT_TAG,
          "GYU-Applicant",
          "2026-09-30T12:25:02.688Z",
          "automatic",
        ),
        succeeded(
          35,
          APPROVED_TAG,
          "GYU-Approved",
          "2026-10-04T23:40:03.646Z",
          "automatic",
        ),
      ],
      mappings,
      now: new Date("2026-10-05T01:00:00.000Z"),
    });

    expect(status.kind).toBe("tagged");
    expect(status.label).not.toContain("Syncing");
  });

  it("DOES still say syncing while a required tag is genuinely outstanding", () => {
    // The honest opposite, so the test above cannot pass by weakening the
    // pending state into silence.
    const pending = {
      ...succeeded(
        36,
        APPROVED_TAG,
        "GYU-Approved",
        "2026-10-04T23:40:03.646Z",
        "manual_owner",
      ),
      status: "pending",
      succeeded_at: null,
      kit_subscriber_id: null,
    } as unknown as KitSyncOperation;

    const status = kitStatus({
      application: olivia,
      operations: [
        succeeded(
          18,
          APPLICANT_TAG,
          "GYU-Applicant",
          "2026-09-30T12:25:02.688Z",
          "manual_owner",
        ),
        pending,
      ],
      mappings,
      now: new Date("2026-10-04T23:45:00.000Z"),
    });

    expect(status.label).toContain("Syncing");
  });
});
