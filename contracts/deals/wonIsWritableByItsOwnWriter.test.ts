import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Becky Schmauch's sale, and why one click left half of it behind.
//
// 2026-09-14 made Stripe the sole authority for Won: handle_deal_saved()
// raised if any role but service_role set stage = 'won'.
// 2026-09-18 overturned the model that guard encodes, in as many words —
// "a model that treated Won as a payment fact. It is not." — and changed
// the sales-call path to write Won. Nobody retired the guard.
//
// Since then, recording an attended sale from the CRM has been impossible.
// The attendance write landed (its own request, its own transaction), the
// Won write was refused, and the UI showed a generic "server connection
// error". Production bears it out: of 32 Opportunities that ever reached
// Won, 28 are historical imports and the other four all carry the
// timestamp of that migration — a direct database connection, where
// auth.role() is null and the guard lets the write through. Not one sale
// has been won through the CRM's own UI since the guard landed.
//
// The unit tests stayed green because they run on FakeRest, which has no
// triggers. So these are CONTRACT tests: they read the sources that have
// to agree.

const GUARD = readFileSync(
  "supabase/migrations/20260925120000_a_sale_is_accepted_not_paid_for.sql",
  "utf8",
);
const OUTCOME = readFileSync(
  "src/components/atomic-crm/sales-calls/completeSalesCallOutcome.ts",
  "utf8",
);

describe("who is allowed to say a sale was won", () => {
  test("the database still refuses a hand-edited stage", () => {
    // The guard's real concern survives: handle_deal_won() creates an
    // Enrollment, seeds a checklist and can claim a scholarship slot.
    expect(GUARD).toMatch(/cannot be set to Won by editing its stage/);
  });

  test("but it asks how you got here, not which role you are", () => {
    // "Which role" made Stripe the only possible author of a fact that is
    // not about payment at all.
    expect(GUARD).toMatch(/app\.sale_authority/);
    expect(GUARD).not.toMatch(/auth\.role\(\)\s*<>\s*'service_role'/);
  });

  test("the primitive is reachable by no client role at all", () => {
    // Only the wrappers are granted. accept_sale and
    // ensure_sale_enrollment are reached by being the owner, not by a
    // grant — a client cannot call them directly and has no need to.
    for (const fn of [
      "accept_sale\\(bigint\\)",
      "ensure_sale_enrollment\\(bigint\\)",
    ]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(GUARD).toMatch(
          new RegExp(`revoke all on function public\\.${fn} from ${role}`),
        );
      }
    }
    // And the wrappers Leif actually uses are granted to her role only.
    expect(GUARD).toMatch(
      /grant execute on function public\.complete_attended_sales_call\(bigint, text, text, date\) to authenticated/,
    );
    expect(GUARD).toMatch(
      /grant execute on function public\.record_prospect_accepted\(bigint\) to authenticated/,
    );
    expect(GUARD).toMatch(
      /revoke all on function public\.record_prospect_accepted\(bigint\) from anon/,
    );
  });

  test("the whole repair is one migration, not a history of attempts", () => {
    // Three local migrations told the story of getting here, including one
    // whose authority mechanism this file's own proof broke. None was ever
    // committed or deployed, so they were squashed into the final design
    // rather than kept as permanent history.
    const all = readdirSync("supabase/migrations").filter((f) =>
      /^2026092[5-9]/.test(f),
    );
    expect(
      all.filter((f) =>
        /won_is_agreed|every_way_a_sale|authority_you_cannot/.test(f),
      ),
    ).toEqual([]);
  });

  test("an attended outcome lands in one transaction", () => {
    // Becky's click was six separate requests. Fixing only the guard would
    // have fixed her case and left the shape that produced it.
    expect(GUARD).toMatch(
      /create or replace function public\.complete_attended_sales_call/,
    );
    expect(OUTCOME).toMatch(/completeAttendedSalesCall/);
  });
});

// Every module that can set an Opportunity to Won from the browser.
//
// This is an inventory, not a ban: some of these are legitimate. It exists
// so a NEW direct writer cannot be added without someone reading this
// comment, and so the two that are still unconverted cannot be forgotten.
const AUTHORISED: Record<string, string> = {
  // Routes through complete_attended_sales_call() in production; the
  // sequential code below that is the FakeRest mirror.
  "sales-calls/completeSalesCallOutcome.ts": "routed through the transaction",
  // Routes through record_prospect_accepted() -> accept_sale(); the code
  // below that is the FakeRest fallback.
  "deals/recordSalesDecision.ts": "routed through accept_sale()",
  "deals/acceptSaleMirror.ts": "the FakeRest mirror of accept_sale()",
  "sales-calls/completeAttendedSalesCallMirror.ts":
    "the FakeRest mirror itself",
  // Read-side: a filter on stage, not a write.
  "deals/useOnboardingPipeline.ts": "reads Won deals, writes nothing",
  "deals/paymentTruth.fixtures.ts": "test fixtures",
  // The FakeRest stand-in for the Stripe webhook, which is service_role in
  // production and has always been allowed to set Won.
  "deals/recordDealPaymentSucceeded.ts": "mirrors the Stripe webhook",
};

// Empty, and meant to stay that way. It held recordSalesDecision.ts and
// recordOpportunityDecision.ts — the same defect on two more buttons —
// until both were routed through accept_sale(). If anything appears here
// again, a canonical sale path has gone back to writing Won by hand.
const KNOWN_UNCONVERTED: string[] = [];

const clientWonWriters = (): string[] => {
  const roots = [
    "src/components/atomic-crm/sales-calls",
    "src/components/atomic-crm/deals",
  ];
  const found: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      if (!/\.tsx?$/.test(name) || /\.test\./.test(name)) continue;
      const source = readFileSync(`${root}/${name}`, "utf8");
      if (
        /stage:\s*["']won["']/.test(source) ||
        /stage:\s*"won"/.test(source)
      ) {
        found.push(`${root.split("/").pop()}/${name}`);
      }
    }
  }
  return found.sort();
};

describe("the inventory of browser-side Won writers", () => {
  test("holds nothing that is neither authorised nor already known", () => {
    const unexpected = clientWonWriters().filter(
      (path) => !(path in AUTHORISED) && !KNOWN_UNCONVERTED.includes(path),
    );
    expect(
      unexpected,
      unexpected.length === 0
        ? ""
        : `New direct writers of stage='won' from the browser. Each one can ` +
            `half-persist the action it belongs to, exactly as Becky's did:\n  ` +
            unexpected.join("\n  "),
    ).toEqual([]);
  });

  test("nothing is left unconverted", () => {
    expect(KNOWN_UNCONVERTED).toEqual([]);
  });

  test("every sale-accepting path goes through the one primitive", () => {
    // One place a sale is accepted, with thin wrappers where the
    // surrounding facts genuinely differ.
    expect(GUARD).toMatch(/create or replace function public\.accept_sale/);
    expect(GUARD).toMatch(/public\.accept_sale\(v_deal\.id\)/);
    expect(GUARD).toMatch(/return public\.accept_sale\(p_opportunity_id\)/);
  });
});

describe("what the board and the editor treat as a writable stage", () => {
  const ACTIVITY = readFileSync(
    "src/components/atomic-crm/deals/dealActivity.ts",
    "utf8",
  );
  const INPUTS = readFileSync(
    "src/components/atomic-crm/deals/DealInputs.tsx",
    "utf8",
  );
  const BOARD = readFileSync(
    "src/components/atomic-crm/deals/DealListContent.tsx",
    "utf8",
  );

  test("one canonical rule decides it, and it excludes legacy onboarding", () => {
    expect(ACTIVITY).toMatch(/isWritableStage/);
    expect(ACTIVITY).toMatch(/LEGACY_PERSISTED_ONBOARDING_STAGE/);
  });

  test("the Opportunity editor asks that rule rather than deciding itself", () => {
    // Leif saw "Onboarding" in the stage selector and chose it, because it
    // is where the board shows people after a sale. The database refuses
    // the value outright. Offering it at all was the defect.
    expect(INPUTS).toMatch(/isWritableStage/);
  });

  test("a refused drop says why instead of snapping back in silence", () => {
    expect(BOARD).toMatch(/synthetic-column/);
    expect(BOARD).toMatch(/notify\(/);
  });
});

// The half-landed sale has to be REACHABLE, not merely recoverable.
//
// The repair above made complete_attended_sales_call() convergent, and then
// Becky's Opportunity still could not be finished: the page asked whether
// ATTENDANCE had been recorded, so her completed/attended/no-decision call
// fell into a display-only branch with no action at all, and the two
// statuses the convergence returns were missing from the client's own result
// type — a converged save would have shown a connection error while
// succeeding. A working backend nobody can press is not a fixed defect.
describe("reaching the convergence from the Opportunity", () => {
  const SECTION = readFileSync(
    "src/components/atomic-crm/sales-calls/DealSalesCallSection.tsx",
    "utf8",
  );
  const DIALOG = readFileSync(
    "src/components/atomic-crm/sales-calls/CompleteSalesCallDialog.tsx",
    "utf8",
  );

  test("the page asks whether a DECISION is owed, not whether attendance is", () => {
    expect(SECTION).toMatch(/salesCallDecisionOwed/);
    expect(SECTION).toMatch(/record_outcome_action/);
  });

  test("it reuses the one outcome dialog rather than a second implementation", () => {
    // Two implementations of "what was decided" is how the FakeRest mirror
    // and the RPC drifted apart in the first place.
    expect(SECTION).toMatch(/<CompleteSalesCallDialog[\s\S]*?decisionOnly/);
    expect(DIALOG).toMatch(
      /complete_attended_sales_call|completeSalesCallOutcome|onComplete/,
    );
  });

  test("both convergence statuses reach the client", () => {
    // Neither was in the result union when the repair shipped, so each one
    // fell through to the generic error branch.
    expect(OUTCOME).toMatch(/status:\s*"converged"/);
    expect(OUTCOME).toMatch(/status:\s*"conflicting-outcome"/);
    expect(DIALOG).toMatch(/"converged"/);
    expect(DIALOG).toMatch(/"conflicting-outcome"/);
  });

  test("a converged sale still gets everything Won implies", () => {
    // The Offer Page token, the Task closes: skipped entirely if the
    // after-step only recognises "completed".
    expect(OUTCOME).toMatch(
      /status === "completed" \|\| status === "converged"/,
    );
  });

  test("the recovery cannot rewrite a recorded attendance", () => {
    // Offering No-show inside a recovery would let finishing a decision
    // overturn an observation. The dialog states the attendance instead.
    expect(DIALOG).toMatch(/recorded as Attended/);
  });
});
