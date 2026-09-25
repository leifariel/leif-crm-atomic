import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// "A sale already past the point a review speaks to" is decided twice: in
// TypeScript for FakeRest and the demo, and in SQL for production. Two
// copies of a stage ordering is exactly the shape dealActivity.ts warns
// about — nine hand-written copies of the active-Opportunity rule that
// happened to agree on that day's data.
//
// So this pins the two together. They may not drift, and neither may quietly
// grow a stage the other does not have.

const TS = readFileSync(
  "src/components/atomic-crm/applications/createManualApplication.ts",
  "utf8",
);
const SQL = readFileSync(
  "supabase/migrations/20260924140000_a_manual_application_gets_its_opportunity.sql",
  "utf8",
);
const CANONICAL = readFileSync(
  "src/components/atomic-crm/deals/dealActivity.ts",
  "utf8",
);

/** The stage names in ACTIVE_SALES_STAGES, in order. */
const canonicalStages = (): string[] => {
  const block = CANONICAL.match(
    /export const ACTIVE_SALES_STAGES = \[([\s\S]*?)\] as const;/,
  );
  if (!block) throw new Error("ACTIVE_SALES_STAGES not found");
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
};

/** The stage names the SQL function orders, in order. */
const sqlStages = (): string[] => {
  const block = SQL.match(/array\[((?:\s*'[a-z_]+',?)+)\]/);
  if (!block) throw new Error("the SQL stage array was not found");
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

describe("the reuse rule is one rule, in two runtimes", () => {
  test("the SQL array is ACTIVE_SALES_STAGES, in the same order", () => {
    expect(sqlStages()).toEqual(canonicalStages());
  });

  test("both cut at 'approved' — the last stage an approval does not move backwards", () => {
    const stages = canonicalStages();
    // TypeScript names the boundary and derives the position from the
    // canonical array rather than restating one.
    expect(TS).toMatch(
      /const LAST_REVIEWABLE_STAGE: ActiveSalesStage = "approved";/,
    );
    expect(TS).toMatch(/ACTIVE_SALES_STAGES\.indexOf\(LAST_REVIEWABLE_STAGE\)/);

    // SQL has no array to import, so it carries the position as a literal
    // bound. array_position is 1-based, so the bound is the 1-based index
    // of 'approved'.
    const bound = stages.indexOf("approved") + 1;
    expect(SQL).toContain(`NOT BETWEEN 1 AND ${bound}`);
  });

  test("TypeScript keeps no second stage list of its own", () => {
    // A local array of stage literals is how a second copy starts.
    expect(TS).not.toMatch(/\[\s*"interested"\s*,/);
    expect(TS).not.toMatch(/"call_booked"/);
  });

  test("a stage neither list knows is refused, not assumed safe", () => {
    // Both sides fail closed: indexOf -1 in TypeScript, array_position
    // NULL coalesced to 0 in SQL. Legacy 'onboarding' is the live case —
    // deal_is_active() still calls it active.
    expect(TS).toMatch(/position !== -1/);
    expect(SQL).toMatch(/coalesce\(\s*\n?\s*array_position\(/);
    expect(SQL).toContain("0) NOT BETWEEN");
  });
});
