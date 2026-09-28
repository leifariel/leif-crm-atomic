import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Jenna Smith's Opportunity already says The Living Example. Her checklist says
// Growing Yourself Up. Those are two different facts about one client, and the
// repair for the second must not pretend to be a change of the first.
//
// These are contract tests over the files that now have to agree: one body owns
// the reconciliation rules, the transfer still refuses a client it cannot help,
// and the repair never invents either a programme or a date.

const read = (path: string) => readFileSync(path, "utf8");

// Comments in these files necessarily quote the thing being banned, so the
// structural rules below match against code only.
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)(--|\/\/).*$/, ""))
    .join("\n");

const MIGRATION = read(
  "supabase/migrations/20260926020000_onboarding_can_be_reconciled_to_its_programme.sql",
);
const TRACKING_GUARD = read(
  "supabase/migrations/20260926030000_onboarding_outside_tracking_is_not_a_repair.sql",
);
const RECONCILE = read(
  "src/components/atomic-crm/enrollments/reconcileClientOnboarding.ts",
);
const ACTION = read(
  "src/components/atomic-crm/enrollments/RepairOnboardingAction.tsx",
);
const GRANTS = read("supabase/schemas/06_grants.sql");
const FUNCTIONS = read("supabase/schemas/02_functions.sql");

// The body of one SQL function, from its CREATE to its dollar-quote close.
const sqlFunction = (source: string, name: string) => {
  const start = source.indexOf(`function public.${name}(`);
  if (start < 0) throw new Error(`function not found: ${name}`);
  const end = source.indexOf("\n$fn$;", start);
  if (end < 0) throw new Error(`unterminated function: ${name}`);
  return source.slice(start, end);
};

describe("the reconciliation rules are written once", () => {
  test("there is a shared projection, and both authorities call it", () => {
    expect(code(MIGRATION)).toMatch(
      /create or replace function public\.apply_enrollment_onboarding_projection/,
    );
    const transfer = code(
      sqlFunction(MIGRATION, "transfer_enrolled_opportunity_offer"),
    );
    const reconcile = code(
      sqlFunction(MIGRATION, "reconcile_enrollment_to_current_offer"),
    );
    expect(transfer).toMatch(/apply_enrollment_onboarding_projection\(/);
    expect(reconcile).toMatch(/apply_enrollment_onboarding_projection\(/);
  });

  test("neither authority keeps its own copy of the item loops", () => {
    for (const name of [
      "transfer_enrolled_opportunity_offer",
      "reconcile_enrollment_to_current_offer",
    ]) {
      const body = code(sqlFunction(MIGRATION, name));
      // The retire / re-point / add WRITES belong to the shared body only.
      // Reading templates is a different thing and reconcile does it for its
      // own reason: deciding whether a named source programme can account for
      // the requirements it is about to retire.
      expect(body).not.toMatch(/set status = 'retired'/);
      expect(body).not.toMatch(/insert into enrollment_onboarding_items/);
      expect(body).not.toMatch(/update enrollment_onboarding_items/);
      expect(body).not.toMatch(/insert into tasks/);
      expect(body).not.toMatch(/update tasks/);
    }
    // And the shared body is the one that has them.
    const shared = code(
      sqlFunction(MIGRATION, "apply_enrollment_onboarding_projection"),
    );
    expect(shared).toMatch(/set status = 'retired'/);
    expect(shared).toMatch(/insert into enrollment_onboarding_items/);
  });

  test("the front end previews with the same describePlan the transfer uses", () => {
    expect(code(ACTION)).toMatch(/describePlan/);
    expect(code(ACTION)).not.toMatch(/const describePlan/);
  });
});

describe("transfer stays what it is", () => {
  test("it still answers already-on-offer rather than repairing", () => {
    const transfer = code(
      sqlFunction(MIGRATION, "transfer_enrolled_opportunity_offer"),
    );
    expect(transfer).toMatch(/'status', 'already-on-offer'/);
    expect(transfer).toMatch(/update deals/);
  });

  test("reconcile never writes the Opportunity's offer", () => {
    const reconcile = code(
      sqlFunction(MIGRATION, "reconcile_enrollment_to_current_offer"),
    );
    expect(reconcile).not.toMatch(/update deals\b/);
    expect(code(RECONCILE)).not.toMatch(/update\("deals"/);
  });
});

describe("neither the programme nor the date is invented", () => {
  test("a stale checklist with nothing naming its source is refused", () => {
    const reconcile = code(
      sqlFunction(MIGRATION, "reconcile_enrollment_to_current_offer"),
    );
    expect(reconcile).toMatch(/'status', 'needs-source-offer'/);
    expect(reconcile).toMatch(/'status', 'source-offer-mismatch'/);
    expect(reconcile).toMatch(/'status', 'source-offer-not-applicable'/);
    expect(code(RECONCILE)).toMatch(/needs-source-offer/);
    expect(code(RECONCILE)).toMatch(/source-offer-mismatch/);
  });

  test("the proposal is only a proposal, and the dialog makes Leif state it", () => {
    expect(code(RECONCILE)).toMatch(/export const proposePreviousOffer/);
    // Exactly one accounting candidate, or nothing.
    expect(code(RECONCILE)).toMatch(/accounting\.length === 1/);
    // The dialog asks, with a real control and a disabled action until answered.
    expect(code(ACTION)).toMatch(/<select/);
    expect(code(ACTION)).toMatch(/needsSource && !selected/);
  });

  test("a reconstructed event leaves occurred_at null", () => {
    const reconcile = code(
      sqlFunction(MIGRATION, "reconcile_enrollment_to_current_offer"),
    );
    expect(reconcile).toMatch(/'reconstructed'/);
    expect(reconcile).toMatch(/null, 'reconstructed'/);
    expect(code(RECONCILE)).toMatch(/occurred_at: null/);
    expect(code(RECONCILE)).toMatch(/source: "reconstructed"/);
    // And the column is allowed to say it does not know, for that case only.
    expect(code(MIGRATION)).toMatch(
      /occurred_at is not null or source = 'reconstructed'/,
    );
  });

  test("a real transfer still records when it happened", () => {
    const transfer = code(
      sqlFunction(MIGRATION, "transfer_enrolled_opportunity_offer"),
    );
    expect(transfer).not.toMatch(/'reconstructed'/);
    expect(transfer).toMatch(/'app', p_note/);
  });
});

describe("history that belongs to the old programme stays there", () => {
  test("neither authority rewrites an Application or a sales call", () => {
    for (const name of [
      "transfer_enrolled_opportunity_offer",
      "reconcile_enrollment_to_current_offer",
      "apply_enrollment_onboarding_projection",
    ]) {
      const body = code(sqlFunction(MIGRATION, name));
      expect(body).not.toMatch(/update applications/);
      expect(body).not.toMatch(/update sales_calls/);
      expect(body).not.toMatch(/delete from enrollment_onboarding_items/);
    }
    expect(code(RECONCILE)).not.toMatch(/"applications"/);
    expect(code(RECONCILE)).not.toMatch(/"sales_calls"/);
    expect(code(RECONCILE)).not.toMatch(/\.delete/);
  });
});

describe("staleness is one question, asked the same way twice", () => {
  test("the SQL and the front end both compare live keys to active templates", () => {
    const matches = code(
      MIGRATION.slice(
        MIGRATION.indexOf(
          "function public.enrollment_onboarding_matches_offer(",
        ),
        MIGRATION.indexOf(
          "\n$fn$;",
          MIGRATION.indexOf(
            "function public.enrollment_onboarding_matches_offer(",
          ),
        ),
      ),
    );
    expect(matches).toMatch(/status <> 'retired'/);
    expect(matches).toMatch(/t\.is_active/);

    const ts = code(RECONCILE);
    expect(ts).toMatch(/export const onboardingMatchesOffer/);
    expect(ts).toMatch(/item\.status !== "retired"/);
    expect(ts).toMatch(/liveKeys\.size !== templateKeys\.size/);
  });

  test("the action does not offer a repair to a client who needs none", () => {
    // Through the eligibility layer, which asks about tracking first — the
    // narrow match predicate alone would call a legacy client stale.
    expect(code(ACTION)).toMatch(/onboardingRepairState\(\{/);
    expect(code(ACTION)).toMatch(/!== "stale"/);
    expect(code(ACTION)).toMatch(/TERMINAL\.includes\(enrollment\.status\)/);
  });
});

describe("privileges stay narrow", () => {
  test("the shared projection is reachable by nobody but the owner", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code(MIGRATION)).toMatch(
        new RegExp(
          `revoke all on function public\\.apply_enrollment_onboarding_projection\\(bigint, bigint, bigint\\) from ${role}`,
        ),
      );
      expect(code(GRANTS)).toMatch(
        new RegExp(
          `revoke all on function public\\.apply_enrollment_onboarding_projection\\(bigint, bigint, bigint\\) from ${role}`,
        ),
      );
    }
    expect(code(MIGRATION)).not.toMatch(
      /grant execute on function public\.apply_enrollment_onboarding_projection/,
    );
  });

  test("the repair itself is the owner's to call, and never anon's", () => {
    expect(code(MIGRATION)).toMatch(
      /grant execute on function public\.reconcile_enrollment_to_current_offer\(bigint, bigint, text\) to authenticated/,
    );
    expect(code(MIGRATION)).toMatch(
      /revoke all on function public\.reconcile_enrollment_to_current_offer\(bigint, bigint, text\) from anon/,
    );
    expect(code(GRANTS)).toMatch(
      /grant execute on function public\.reconcile_enrollment_to_current_offer\(bigint, bigint, text\) to authenticated/,
    );
  });

  test("both new authorities are definers with a pinned search_path", () => {
    for (const name of [
      "apply_enrollment_onboarding_projection",
      "reconcile_enrollment_to_current_offer",
      "enrollment_onboarding_matches_offer",
    ]) {
      const start = MIGRATION.indexOf(`function public.${name}(`);
      const head = MIGRATION.slice(start, start + 600);
      expect(head).toMatch(/security definer/);
      expect(head).toMatch(/set search_path to 'public'/);
    }
  });
});

describe("the declarative schema says the same thing", () => {
  test("it declares all three, and the projection's own revokes", () => {
    for (const name of [
      "apply_enrollment_onboarding_projection",
      "enrollment_onboarding_matches_offer",
      "reconcile_enrollment_to_current_offer",
    ]) {
      expect(FUNCTIONS).toMatch(
        new RegExp(`FUNCTION "?public"?\\."?${name}"?`),
      );
    }
  });
});

describe("migration ordering", () => {
  test("it extends the chain and leaves the reserved slot alone", () => {
    const mine =
      "20260926020000_onboarding_can_be_reconciled_to_its_programme.sql";
    const names = readdirSync("supabase/migrations")
      .filter((file) => file.endsWith(".sql"))
      .sort();
    expect(names).toContain(mine);
    // After the transfer it repairs around, and before the slot the parked
    // Application Form Builder work already carries — so both can deploy in
    // their own order without either being renumbered. Nothing here asserts
    // that uncommitted file exists.
    expect(names.filter((file) => file < mine)).toContain(
      "20260926010000_a_client_can_change_programme.sql",
    );
    expect(mine < "20260926090000").toBe(true);
  });
});

describe("onboarding outside tracking is never a repair candidate", () => {
  test("the authority refuses it, before it asks about alignment", () => {
    const fn = code(
      sqlFunction(TRACKING_GUARD, "reconcile_enrollment_to_current_offer"),
    );
    expect(fn).toMatch(
      /onboarding_tracking is distinct from 'tracked'[\s\S]*?'status', 'onboarding-not-tracked'/,
    );
    // Checked BEFORE the alignment question, so a legacy client is never
    // described as aligned — their checklist genuinely does not match.
    const guardAt = fn.indexOf(
      "onboarding_tracking is distinct from 'tracked'",
    );
    const alignedAt = fn.indexOf("enrollment_onboarding_matches_offer(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(alignedAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(alignedAt);
  });

  test("the refusal returns before anything can be written", () => {
    const fn = code(
      sqlFunction(TRACKING_GUARD, "reconcile_enrollment_to_current_offer"),
    );
    const guardAt = fn.indexOf(
      "onboarding_tracking is distinct from 'tracked'",
    );
    const head = fn.slice(0, guardAt);
    // Nothing above the guard writes: the projection call and the event insert
    // both come later.
    expect(head).not.toMatch(/apply_enrollment_onboarding_projection/);
    expect(head).not.toMatch(/insert into deal_offer_events/);
  });

  test("the match predicate keeps its narrow meaning", () => {
    // Deliberately NOT taught about tracking: it answers "do these keys equal
    // that template's?", so nothing downstream can read "untracked" as
    // "aligned tracked onboarding".
    const matches = code(
      TRACKING_GUARD.slice(
        TRACKING_GUARD.indexOf(
          "function public.enrollment_onboarding_matches_offer(",
        ),
      ),
    );
    expect(matches).not.toMatch(/onboarding_tracking/);
    const ts = code(RECONCILE);
    const predicate = ts.slice(
      ts.indexOf("export const onboardingMatchesOffer"),
      ts.indexOf("export const onboardingRepairState"),
    );
    expect(predicate).not.toMatch(/tracking/);
    // Eligibility is its own layer, and it is what the card asks.
    expect(ts).toMatch(/export const onboardingRepairState/);
    expect(ts).toMatch(/if \(tracking !== "tracked"\) return "not-tracked";/);
    expect(code(ACTION)).toMatch(/onboardingRepairState\(/);
    expect(code(ACTION)).not.toMatch(/onboardingMatchesOffer\(/);
  });

  test("the mirror refuses in the same order as the function", () => {
    const ts = code(RECONCILE);
    const trackingAt = ts.indexOf(
      'enrollment.onboarding_tracking !== "tracked"',
    );
    const alignedAt = ts.indexOf(
      "if (onboardingMatchesOffer(items, templates))",
    );
    expect(trackingAt).toBeGreaterThan(-1);
    expect(alignedAt).toBeGreaterThan(-1);
    expect(trackingAt).toBeLessThan(alignedAt);
  });
});
