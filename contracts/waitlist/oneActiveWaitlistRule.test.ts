import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ONE RULE FOR "STILL WAITING", IN ONE PLACE.
//
// THE BUG THIS EXISTS FOR. Every programme and cohort waitlist surface reads
// through `useWaitlistEntries`, and that hook filtered on
// ACTIVE_WAITLIST_STATUSES — a set meaning {waiting, invited} whose real job
// is mirroring the database's partial unique index for duplicate prevention.
// So after the first real invitation batches the programme pages counted
// 62 and 53 people as waiting when 38 and 23 were.
//
// The danger now is the opposite one: somebody "fixes" a count by filtering
// in the component instead of the read model, and the header starts
// disagreeing with the rows under it. This file holds the boundary where it
// is, so the header, the list, the search and the selection cannot drift
// apart.

const read = (path: string) => readFileSync(path, "utf8");
const WAITLIST = "src/components/atomic-crm/waitlist";

/**
 * The surfaces that show or count an operational waitlist. Every one of them
 * must get its people from the shared hook and do no status filtering of its
 * own.
 */
const SURFACES = [
  "src/components/atomic-crm/programs/IndividualProgramPage.tsx",
  "src/components/atomic-crm/programs/IndividualProgramCard.tsx",
  "src/components/atomic-crm/programs/GroupProgramPage.tsx",
  "src/components/atomic-crm/cohorts/CohortShow.tsx",
  "src/components/atomic-crm/cohorts/useCohortCapacity.ts",
  "src/components/atomic-crm/dashboard/LivingExampleCapacityCard.tsx",
];

/**
 * Files allowed to ask "does this person still hold a place?" — the
 * duplicate-prevention and history question, which is NOT the operational
 * one. Each was audited on 2026-10-11; the note says why it keeps
 * {waiting, invited}.
 */
const PLACE_HELD_CALLERS: Record<string, string> = {
  [`${WAITLIST}/waitlistConstants.ts`]: "defines it",
  [`${WAITLIST}/waitlistEntryValidation.ts`]:
    "duplicate prevention — an invited person still holds their place",
  [`${WAITLIST}/waitlistSync.ts`]:
    "a won deal converts the place, and an invited place converts too",
  [`${WAITLIST}/ContactWaitlists.tsx`]: "Contact-side lifetime history",
  [`${WAITLIST}/ContactSalesAction.tsx`]:
    "Contact-side: an invited person already has something in flight",
  "src/components/atomic-crm/providers/fakerest/dataProvider.ts":
    "mirrors the DB partial unique index",
};

describe("the operational waitlist has exactly one definition", () => {
  it("useWaitlistEntries is the only place that decides who is still waiting", () => {
    const hook = read(`${WAITLIST}/useWaitlistEntries.ts`);
    expect(hook).toContain("isStillWaiting");
    expect(
      hook,
      "the hook must not reach for the place-held set any more",
    ).not.toContain("ACTIVE_WAITLIST_STATUSES");
  });

  it("isStillWaiting means waiting, and nothing else", () => {
    const constants = read(`${WAITLIST}/waitlistConstants.ts`);
    expect(constants).toMatch(
      /export const isStillWaiting[\s\S]{0,200}status === "waiting"/,
    );
  });

  it("every waitlist surface reads through the shared hook", () => {
    for (const path of SURFACES) {
      expect(read(path), `${path} should use the shared read model`).toContain(
        "useWaitlistEntries",
      );
    }
  });

  it("no surface filters waitlist status for itself", () => {
    for (const path of SURFACES) {
      const source = read(path);
      for (const status of ["waiting", "invited", "converted", "removed"]) {
        expect(
          source,
          `${path} must not re-decide status — that belongs in useWaitlistEntries`,
        ).not.toContain(`"${status}"`);
      }
    }
  });

  it("only the audited place-held callers use ACTIVE_WAITLIST_STATUSES", () => {
    // Anything new referencing it is a surface that may be answering the
    // operational question with the duplicate-prevention set — the exact
    // mistake this slice repaired.
    const allowed = Object.keys(PLACE_HELD_CALLERS).sort();
    expect(allowed.length).toBeGreaterThan(5);
    for (const path of allowed) {
      expect(read(path), `${path} is listed but no longer uses it`).toContain(
        "ACTIVE_WAITLIST_STATUSES",
      );
    }
  });

  it("the Contacts filter and its demo mirror both mean currently waiting", () => {
    // contacts_summary.is_on_waitlist was the last surface answering the
    // operational question with the place-held set. Migration
    // 20261011200000 corrected the view; this holds the declarative schema
    // and the fakerest mirror to the same meaning, so a demo-mode answer
    // and a production answer cannot diverge.
    const view = read("supabase/schemas/03_views.sql");
    expect(view).toContain("bool_or(w.status = 'waiting') as is_on_waitlist");
    expect(
      view,
      "the view must not go back to counting invited people as waiting",
    ).not.toContain("bool_or(w.status in ('waiting', 'invited'))");

    const mirror = read(
      "src/components/atomic-crm/providers/fakerest/contactRelationshipFields.ts",
    );
    expect(mirror).toContain(
      "is_on_waitlist: contactWaitlistEntries.some(isStillWaiting)",
    );
    expect(mirror).not.toContain("ACTIVE_WAITLIST_STATUSES");
  });

  it("the place-held set still mirrors the database index", () => {
    const constants = read(`${WAITLIST}/waitlistConstants.ts`);
    expect(constants).toMatch(
      /ACTIVE_WAITLIST_STATUSES[\s\S]{0,120}new Set\(\["waiting", "invited"\]\)/,
    );
  });
});
