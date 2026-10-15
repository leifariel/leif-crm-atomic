// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import grants from "../security/protectedFunctionGrants.json";

// COMPLETION AND CORRECTION ARE TWO COMMANDS, AND THEY HAVE TO STAY TWO.
//
// Sales Call Workflow Part 2. The distinction is the whole safety property:
//
//   complete_attended_sales_call()  the FIRST authoritative resolution of a
//                                   call episode. Refuses a materially
//                                   different re-completion, so a stale
//                                   tab, a double-click or a replayed
//                                   webhook can never rewrite a recorded
//                                   answer.
//   correct_completed_sales_call()  a human changing an already-recorded
//                                   resolution, explicitly, with its own
//                                   audit event.
//
// The tempting "fix" for a conflicting-outcome complaint is to let the
// completion command edit instead of refuse. That would delete the
// distinction, and with it the audit trail's ability to say whether a
// result was recorded or revised. This file is the thing that notices.
//
// It also pins the two vocabularies that live in two languages at once and
// have no compiler between them: the event KINDS and the result STATUSES.
// The TypeScript caller maps an unrecognised status onto a generic
// validation error, so a status added in SQL and forgotten in TypeScript
// does not fail loudly -- it shows Leif the wrong sentence.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relative: string) =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const FUNCTIONS = read("supabase/schemas/02_functions.sql");
const TABLES = read("supabase/schemas/01_tables.sql");
const TRIGGERS = read("supabase/schemas/04_triggers.sql");
const GRANT_SQL = read("supabase/schemas/06_grants.sql");
const DOMAIN = read(
  "src/components/atomic-crm/sales-calls/correctCompletedSalesCall.ts",
);
const TYPES = read("src/components/atomic-crm/types.ts");

describe("the completion command still refuses rather than edits", () => {
  it("complete_attended_sales_call still answers a differing decision with conflicting-outcome", () => {
    const from = FUNCTIONS.indexOf('"complete_attended_sales_call"');
    expect(from, "the completion command is not declared").toBeGreaterThan(-1);
    const body = FUNCTIONS.slice(from, FUNCTIONS.indexOf("$$;", from));

    expect(body).toContain("conflicting-outcome");
    // The two comparisons that produce it. Losing either one is how the
    // refusal quietly becomes an edit.
    expect(body).toMatch(
      /v_deal\.owner_decision is distinct from p_owner_decision/,
    );
    expect(body).toMatch(
      /v_deal\.prospect_decision is distinct from p_prospect_decision/,
    );
  });

  it("a blank impression on a completion still means unchanged, never erase", () => {
    const from = FUNCTIONS.indexOf('"complete_attended_sales_call"');
    const body = FUNCTIONS.slice(from, FUNCTIONS.indexOf("$$;", from));

    // Part 1's rule: a converging replay may ADD an impression and may
    // never remove one. Deliberate clearing is the correction command's job,
    // which is why that one has a mode rather than a sentinel.
    expect(body).toContain("if v_impressions is not null then");
    expect(body).not.toContain("p_impressions_mode");
  });

  it("the correction command is a separate function with its own tri-state", () => {
    expect(FUNCTIONS).toContain(
      "create or replace function public.correct_completed_sales_call(",
    );
    const from = FUNCTIONS.indexOf(
      "create or replace function public.correct_completed_sales_call(",
    );
    const signature = FUNCTIONS.slice(from, FUNCTIONS.indexOf(")", from));

    for (const parameter of [
      "p_sales_call_id",
      "p_attendance",
      "p_owner_decision",
      "p_prospect_decision",
      "p_follow_up_date",
      "p_impressions",
      "p_impressions_mode",
    ]) {
      expect(signature, `the correction lost ${parameter}`).toContain(
        parameter,
      );
    }
  });
});

describe("the Decision follow-up Task has exactly one authority", () => {
  it("the reconciler is declared and attached to deals", () => {
    expect(FUNCTIONS).toContain(
      "create or replace function public.reconcile_decision_follow_up_task(",
    );
    expect(FUNCTIONS).toContain(
      "create or replace function public.sync_decision_follow_up_task()",
    );
    expect(TRIGGERS).toContain("on_deal_decision_follow_up_task");
    // A trigger that fires on the wrong columns is a reconciler that does
    // not run: all four are the ones that can change whether an active
    // Opportunity sits at Decision with a date.
    const from = TRIGGERS.indexOf(
      "create trigger on_deal_decision_follow_up_task",
    );
    const declaration = TRIGGERS.slice(from, from + 300);
    for (const column of [
      "stage",
      "outcome",
      "follow_up_date",
      "archived_at",
    ]) {
      expect(declaration, `the trigger ignores ${column}`).toContain(column);
    }
  });

  it("the reconciler is reachable by no client role", () => {
    expect(grants.internalOnly).toContain(
      "reconcile_decision_follow_up_task(p_opportunity_id bigint)",
    );
    expect(GRANT_SQL).toContain(
      "revoke all on function public.reconcile_decision_follow_up_task(bigint) from public, anon, authenticated, service_role;",
    );
  });

  it("the correction command holds the completion command's own posture", () => {
    for (const statement of [
      "revoke all on function public.correct_completed_sales_call(bigint, text, text, text, date, text, text) from public;",
      "revoke all on function public.correct_completed_sales_call(bigint, text, text, text, date, text, text) from anon;",
      "grant execute on function public.correct_completed_sales_call(bigint, text, text, text, date, text, text) to authenticated;",
      "grant execute on function public.correct_completed_sales_call(bigint, text, text, text, date, text, text) to service_role;",
    ]) {
      expect(GRANT_SQL, `missing: ${statement}`).toContain(statement);
    }
  });
});

describe("the two vocabularies that live in two languages", () => {
  const sqlList = (source: string, marker: string): string[] => {
    const from = source.indexOf(marker);
    expect(from, `could not find ${marker}`).toBeGreaterThan(-1);
    const open = source.indexOf("(", from + marker.length - 1);
    const text = source.slice(open, source.indexOf(")", open));
    return [...text.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
  };

  it("sales_call_events kinds agree between the CHECK constraint and TypeScript", () => {
    const sql = sqlList(
      TABLES,
      "constraint sales_call_events_kind_check check (kind in",
    );

    const from = TYPES.indexOf("export type SalesCallEventKind =");
    // Comments inside the union mention other kinds by name, so they are
    // stripped before the members are read -- otherwise the explanation of
    // outcome_corrected counts attendance_recorded a second time.
    const union = TYPES.slice(from, TYPES.indexOf(";", from)).replace(
      /\/\/[^\n]*/g,
      "",
    );
    const ts = [
      ...new Set([...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])),
    ].sort();

    expect(ts).toEqual(sql);
    // And the new kind really is in there, so an emptied match cannot pass.
    expect(sql).toContain("outcome_corrected");
  });

  it("the correction's result statuses agree between SQL and the TypeScript that maps them", () => {
    const from = FUNCTIONS.indexOf(
      "create or replace function public.correct_completed_sales_call(",
    );
    const body = FUNCTIONS.slice(from, FUNCTIONS.indexOf("$fn$;", from));
    const sql = [
      ...new Set(
        [...body.matchAll(/'status',\s*'([a-z-]+)'/g)].map((m) => m[1]),
      ),
    ].sort();

    // Every status the function can return is a case the caller handles. An
    // unhandled one falls through to "Unrecognised correction result",
    // which is a wrong sentence rather than a failure.
    const handled = new Set(
      [...DOMAIN.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]),
    );
    const unhandled = sql.filter((status) => !handled.has(status));
    expect(
      unhandled,
      "statuses SQL returns and TypeScript does not map",
    ).toEqual([]);

    // The contract in §19 of the slice, so a status cannot quietly vanish.
    for (const status of [
      "corrected",
      "no-change",
      "not-found",
      "not-completed",
      "no-opportunity",
      "invalid-transition",
      "missing-decision-date",
      "ambiguous-downstream-state",
      "superseded-call-episode",
      "validation-error",
    ]) {
      expect(sql, `the correction can no longer answer ${status}`).toContain(
        status,
      );
    }
  });

  it("every ambiguity refusal names a category, so Leif is never told only that it failed", () => {
    const from = FUNCTIONS.indexOf(
      "create or replace function public.correct_completed_sales_call(",
    );
    const body = FUNCTIONS.slice(from, FUNCTIONS.indexOf("$fn$;", from));

    // A fixed window after each refusal rather than a lazy match up to the
    // next ")": the reasons contain both parentheses and apostrophes.
    const refusals = body
      .split("'ambiguous-downstream-state'")
      .slice(1)
      .map((chunk) => chunk.slice(0, 700));
    expect(refusals.length).toBeGreaterThan(0);
    for (const refusal of refusals) {
      expect(refusal, "an ambiguity refusal with no category").toContain(
        "'category'",
      );
      expect(refusal, "an ambiguity refusal with no reason").toContain(
        "'reason'",
      );
    }
  });
});
