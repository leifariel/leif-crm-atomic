import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A WAITLIST PLACE IS SPENT WHEN THE SALE REALLY STARTS — IN BOTH ENGINES.
//
// §4b Phase 2A0. `handle_deal_waitlist_sync()` converted a waiting/invited
// place whenever ANY active same-offer Opportunity was written, whatever
// stage it was at. Phase 2 creates an Interested Opportunity the moment an
// invitation is delivered, so that rule would have flipped all 54 people
// resting at `invited` straight to `converted` as a side effect of a
// backfill.
//
// There are now TWO rules and they must not be merged back together:
//
//   AUTOMATIC  — a Deal write converts only from application_received on.
//   EXPLICIT   — an operator action (Convert to Opportunity) or a real
//                application converts regardless of the Deal's stage,
//                because the business event itself spent the place.
//
// The SQL trigger is the automatic rule; the SQL RPCs do their own UPDATE
// for the explicit one. This file holds the TypeScript side to the same
// split, so demo mode and production cannot answer differently.

const read = (path: string) => readFileSync(path, "utf8");
const SYNC = "src/components/atomic-crm/waitlist/waitlistSync.ts";
const MIGRATION =
  "supabase/migrations/20261012100000_a_place_is_spent_when_the_sale_starts.sql";
const DECLARATIVE = "supabase/schemas/02_functions.sql";

/** The stages named inside a `stage in (...)` / Set([...]) list. */
const stagesIn = (source: string, after: string): string[] => {
  const start = source.indexOf(after);
  if (start < 0) throw new Error(`anchor not found: ${after}`);
  const open = source.indexOf("(", start + after.length - 1);
  const close = source.indexOf(")", open);
  return [...source.slice(open, close).matchAll(/'([a-z_]+)'|"([a-z_]+)"/g)]
    .map((m) => (m[1] ?? m[2])!)
    .sort();
};

describe("the automatic rule is the same in SQL and in TypeScript", () => {
  it("the migration converts only from application_received onward", () => {
    const stages = stagesIn(read(MIGRATION), "new.stage in");
    expect(stages).toEqual([
      "application_received",
      "approved",
      "call_booked",
      "decision",
      "onboarding",
      "won",
    ]);
    expect(stages, "interested must never convert automatically").not.toContain(
      "interested",
    );
  });

  it("the declarative schema says exactly the same", () => {
    expect(stagesIn(read(DECLARATIVE), "new.stage in")).toEqual(
      stagesIn(read(MIGRATION), "new.stage in"),
    );
  });

  it("the TypeScript mirror says exactly the same", () => {
    expect(stagesIn(read(SYNC), "SPENDS_A_WAITLIST_PLACE")).toEqual(
      stagesIn(read(MIGRATION), "new.stage in"),
    );
  });

  it("the automatic path checks the stage and the explicit path does not", () => {
    const sync = read(SYNC);
    // The gate lives on the automatic entry point only.
    expect(sync).toMatch(
      /syncWaitlistForActiveDeal[\s\S]{0,400}theSaleHasReallyStarted/,
    );
    expect(sync).toMatch(
      /theSaleHasReallyStarted[\s\S]{0,200}SPENDS_A_WAITLIST_PLACE\.has\(deal\.stage\)/,
    );
    // And the explicit one is reachable without it.
    expect(sync).toContain("export const convertCompatibleWaitlistEntries");
  });
});

describe("each caller uses the rule that matches what happened", () => {
  const callers: Array<[string, string, string]> = [
    [
      "the deals lifecycle hooks",
      "src/components/atomic-crm/providers/fakerest/dataProvider.ts",
      "syncWaitlistForActiveDeal",
    ],
    [
      "Convert to Opportunity",
      "src/components/atomic-crm/waitlist/waitlistActions.ts",
      "convertCompatibleWaitlistEntries",
    ],
    [
      "a public application",
      "src/components/atomic-crm/public-application/submitApplication.ts",
      "convertCompatibleWaitlistEntries",
    ],
    [
      "a manual application",
      "src/components/atomic-crm/applications/createManualApplication.ts",
      "convertCompatibleWaitlistEntries",
    ],
  ];

  it.each(callers)("%s uses %s -> %s", (_label, path, expected) => {
    const source = read(path);
    expect(source).toContain(expected);
    const wrong =
      expected === "syncWaitlistForActiveDeal"
        ? "convertCompatibleWaitlistEntries"
        : "syncWaitlistForActiveDeal";
    expect(source, `${path} should not also use ${wrong}`).not.toContain(wrong);
  });

  it("Convert to Opportunity converts on BOTH its branches", () => {
    // It creates its Opportunity at Interested, which the automatic rule
    // deliberately ignores — so the explicit call has to be on the
    // new-deal branch as well as the reuse branch, or pressing the button
    // would silently leave the person on the waitlist.
    const source = read(
      "src/components/atomic-crm/waitlist/waitlistActions.ts",
    );
    const calls = source.match(/convertCompatibleWaitlistEntries\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('stage: "interested"');
  });
});
