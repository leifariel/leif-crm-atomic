import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// LIVE FUNCTION AUTHORITY MUST BE DECLARED.
//
// `supabase/schemas/02_functions.sql` is the documented source of truth for
// what the database contains (AGENTS.md, "Database Management"). A function
// live in production and absent from it is a lie in that source: the next
// person to edit a neighbouring definition cannot see that the authority
// exists.
//
// It is NOT, in this repository's current configuration, the input `supabase
// db diff` generates migrations from. The CLI's own help (2.121.0) says it
// compares "a shadow built from supabase/migrations with a live database" and
// that "declarative files under supabase/schemas are not part of this
// baseline". An earlier version of this comment claimed a stale file could
// make a diff propose DROPping live authority; that was checked and is not
// true here. The reason for this test is documentation integrity, which is
// reason enough.
//
// Ten functions were in exactly that position until 2026-10-14, including
// `invite_from_preflight` (the owner's invitation command) and
// `waitlist_invitation_candidates` (the eligibility authority
// `invite_from_preflight` re-asks at consume time).
//
// WHY A STATIC TEST. The clean room is built by replaying MIGRATIONS, so it
// gets every one of these functions and every behavioural test passes. The
// absence is invisible to the database and visible only in this file.
//
// This pins SIGNATURES, not bodies. A body changes legitimately whenever a
// migration changes it, and body-to-production parity is checked by reading
// production directly at acceptance time. What must never happen again is a
// live function going UNDECLARED.

const FUNCTIONS = readFileSync("supabase/schemas/02_functions.sql", "utf8");

/**
 * The ten functions mirrored from production on 2026-10-14, pinned by the
 * EXACT signature `pg_get_functiondef` emits — `DEFAULT` expressions
 * included, because an overload resolved differently is a different
 * function. These were copied verbatim from production, so exact matching is
 * both safe and the strongest check available.
 */
const MIRRORED_SIGNATURES = [
  "apply_waitlist_invitation_result()",
  "invite_from_preflight(p_preflight_id bigint, p_label text DEFAULT NULL::text)",
  "invite_oldest_waiting(p_offer_id bigint, p_cohort_id bigint DEFAULT NULL::bigint, p_limit integer DEFAULT NULL::integer, p_entry_ids bigint[] DEFAULT NULL::bigint[], p_label text DEFAULT NULL::text)",
  "offer_accepting_cohorts(p_offer_id bigint)",
  "rebuild_all_expected_sessions()",
  "rebuild_enrollment_expected_sessions(p_enrollment_id bigint)",
  "rebuild_expected_sessions_on_start_change()",
  "waitlist_invitation_candidates(p_offer_id bigint, p_cohort_id bigint DEFAULT NULL::bigint)",
  "waitlist_invitation_overlap(p_offer_a bigint, p_limit_a integer, p_offer_b bigint, p_limit_b integer)",
  "waitlist_preflight_overlap(p_preflight_a bigint, p_preflight_b bigint)",
  // Load-bearing for §8u, and the reason this audit happened at all: this one
  // was REPORTED as missing and was not. It is declared in uppercase, which a
  // case-sensitive grep for `function public.deal_is_active` missed. Pinned
  // so the question never has to be answered by eye again.
  "deal_is_active(p_archived_at timestamp with time zone, p_stage text, p_outcome text)",
] as const;

/**
 * This file mixes two declaration styles: 40 in `pg_get_functiondef` form and
 * 24 hand-written in lowercase, the latter spelling `timestamptz` and
 * `default null` where the former writes `timestamp with time zone` and
 * `DEFAULT NULL::timestamp with time zone`. Both are valid SQL and both have
 * shipped across many slices, so these are pinned by NAME plus the parameter
 * names their declaration must contain. That catches a function going
 * undeclared, or its parameters changing shape, without this test taking a
 * side on formatting.
 */
const NAMED_DECLARATIONS: ReadonlyArray<readonly [string, readonly string[]]> =
  [
    ["converge_delivered_invitation", ["p_invitation_id", "p_next_action_at"]],
    ["guard_outreach_attempt_mutation", []],
  ];

describe("every live function is declared in the desired state", () => {
  test.each(MIRRORED_SIGNATURES)(
    "02_functions.sql declares %s",
    (signature) => {
      expect(FUNCTIONS).toContain(`FUNCTION public.${signature}`);
    },
  );

  test.each(NAMED_DECLARATIONS)(
    "02_functions.sql declares %s with its own parameters",
    (name, params) => {
      const re = new RegExp(
        `create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(([^)]*)\\)`,
        "i",
      );
      const match = FUNCTIONS.match(re);
      expect(match, `${name} is not declared at all`).not.toBeNull();
      for (const param of params) {
        expect(match![1], `${name} lost ${param}`).toContain(param);
      }
    },
  );
});

describe("the declaration order a SQL body depends on", () => {
  // A LANGUAGE sql body is parsed and validated when the function is created,
  // so a SQL function that calls another must be declared after it. plpgsql
  // bodies are not checked at creation, which is exactly why this one pair is
  // the trap: it would fail when the declarative files are applied in order,
  // not when they are written.
  test("waitlist_invitation_candidates comes before waitlist_invitation_overlap", () => {
    const candidates = FUNCTIONS.indexOf(
      "FUNCTION public.waitlist_invitation_candidates(",
    );
    const overlap = FUNCTIONS.indexOf(
      "FUNCTION public.waitlist_invitation_overlap(",
    );

    expect(candidates).toBeGreaterThan(-1);
    expect(overlap).toBeGreaterThan(-1);
    expect(candidates).toBeLessThan(overlap);
  });

  test("waitlist_invitation_overlap really is the SQL function that calls it", () => {
    // If this stops being true the ordering rule above is no longer load
    // bearing, and the comment explaining it would be a lie.
    const from = FUNCTIONS.indexOf(
      "FUNCTION public.waitlist_invitation_overlap(",
    );
    const body = FUNCTIONS.slice(from, from + 2000);

    expect(body).toMatch(/LANGUAGE sql/);
    expect(body).toContain("waitlist_invitation_candidates(");
  });
});
