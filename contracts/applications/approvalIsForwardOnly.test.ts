import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  ACTIVE_SALES_STAGES,
  DEAL_STAGES,
  approvalAdvancesStage,
} from "../../src/components/atomic-crm/deals/dealActivity";

// An approval never moves a sale backward.
//
// review_application() used to write stage = 'approved' on every approval.
// On a sale that had already reached Call Booked or Decision that was a move
// BACKWARD, and it happened four times in production (Celia, Opportunity
// 267: call_booked -> approved). The rule is decided twice — in SQL for
// production and in TypeScript for FakeRest — so this pins both to the one
// canonical ordering, ACTIVE_SALES_STAGES, and to each other.

const MIGRATION = readFileSync(
  "supabase/migrations/20261112120000_an_approval_never_moves_a_sale_backward.sql",
  "utf8",
);
const DECLARED = readFileSync("supabase/schemas/02_functions.sql", "utf8");
const MIRROR = readFileSync(
  "src/components/atomic-crm/applications/reviewApplication.ts",
  "utf8",
);

const reviewBody = (sql: string): string => {
  const start = sql.indexOf(
    "create or replace function public.review_application(",
  );
  if (start < 0) throw new Error("review_application not found");
  return sql.slice(start, sql.indexOf("$$;", start));
};

describe("approval is forward only, in both runtimes", () => {
  test("the migration and the declared schema carry the same function", () => {
    expect(reviewBody(MIGRATION)).toEqual(reviewBody(DECLARED));
  });

  test("the SQL stage array is ACTIVE_SALES_STAGES, in order", () => {
    const body = reviewBody(MIGRATION);
    const block = body.match(/array\[((?:\s*'[a-z_]+',?)+)\]/);
    expect(block, "the stage array").not.toBeNull();
    const stages = [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(stages).toEqual([...ACTIVE_SALES_STAGES]);
  });

  test("the SQL bound is exactly the stages BEFORE approved, failing closed", () => {
    const body = reviewBody(MIGRATION);
    // array_position is 1-based; the stages before 'approved' are 1..index.
    const bound = ACTIVE_SALES_STAGES.indexOf("approved");
    expect(body).toContain(`0) BETWEEN 1 AND ${bound}`);
    expect(body).toMatch(/coalesce\(\s*\n?\s*array_position\(/);
  });

  test("no approval branch writes an unconditional approved stage", () => {
    const body = reviewBody(MIGRATION);
    expect(body).not.toMatch(/stage\s*=\s*'approved'\s*,/);
    expect(body).not.toMatch(/SET stage = 'approved'/);
    // All three approval branches go through the one guarded expression.
    expect(
      body.match(
        /stage = CASE WHEN v_advances_stage THEN 'approved' ELSE stage END/g,
      ),
    ).toHaveLength(3);
  });

  test("the TypeScript mirror asks the canonical predicate and keeps no stage list", () => {
    expect(MIRROR).toMatch(/approvalAdvancesStage\(currentStage\)/);
    expect(MIRROR).not.toMatch(/return \{ stage: "approved"/);
    expect(MIRROR).not.toMatch(/"call_booked"/);
  });

  test("the predicate: earlier advances, approved and later are preserved", () => {
    expect(approvalAdvancesStage("interested")).toBe(true);
    expect(approvalAdvancesStage("application_received")).toBe(true);
    expect(approvalAdvancesStage("approved")).toBe(false);
    expect(approvalAdvancesStage("call_booked")).toBe(false);
    expect(approvalAdvancesStage("decision")).toBe(false);
    expect(approvalAdvancesStage("won")).toBe(false);
    expect(approvalAdvancesStage("onboarding")).toBe(false);
    expect(approvalAdvancesStage("a_stage_nobody_has_added_yet")).toBe(false);
    // Every stored stage has an answer, and only two of them move.
    expect(DEAL_STAGES.filter(approvalAdvancesStage)).toEqual([
      "interested",
      "application_received",
    ]);
  });
});
