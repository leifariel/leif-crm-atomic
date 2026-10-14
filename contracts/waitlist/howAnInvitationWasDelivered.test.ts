import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// HOW AN INVITATION WAS DELIVERED, AGREED ACROSS AUTHORITIES.
//
// `supabase/schemas/01_tables.sql` is the documented source of truth and the
// file `supabase/db diff` GENERATES MIGRATIONS FROM (AGENTS.md, "Database
// Management"). It had gone stale: migration 20261010120000 widened the live
// constraint to admit 'kit_tag' on 10 Oct, every one of the 78 real
// invitations uses that value, and this file still said only
// ('manual', 'gmail').
//
// Nothing caught it, and the reason matters for where this test has to live:
// the clean room replays MIGRATIONS, so it builds the correct constraint and
// every behavioural test passes. Only a static read of the declarative file
// can see the disagreement. A diff generated from the stale definition would
// have emitted a narrowing constraint that fails on live data.
//
// So this pins the vocabulary across the three places that must agree, and it
// is deliberately three string checks rather than a schema-diff framework.

const DELIVERY_METHODS = ["manual", "gmail", "kit_tag"] as const;

const TABLES = readFileSync("supabase/schemas/01_tables.sql", "utf8");
const WIDENING = readFileSync(
  "supabase/migrations/20261010120000_inviting_the_oldest_people_waiting.sql",
  "utf8",
);

const allowedIn = (source: string) => {
  const check = source.match(
    /constraint waitlist_invitations_delivery_method_check\s*\n?\s*check \(delivery_method in \(([^)]*)\)\)/,
  );
  expect(check, "the delivery_method CHECK").not.toBeNull();
  return [...check![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe("the declarative schema admits every delivery method production does", () => {
  test.each(DELIVERY_METHODS)("the declarative CHECK admits '%s'", (method) => {
    expect(allowedIn(TABLES)).toContain(method);
  });

  test("and admits nothing beyond them, in the same order production reports", () => {
    expect(allowedIn(TABLES)).toEqual([...DELIVERY_METHODS]);
  });

  test("the migration that widened it agrees", () => {
    // Production's constraint comes from here, so if the two files disagree
    // the declarative one is the wrong one.
    expect(allowedIn(WIDENING)).toEqual([...DELIVERY_METHODS]);
  });

  test("'kit_tag' is admitted because the Kit path actually writes it", () => {
    // The value is not decorative: the Kit worker stamps it on a real
    // delivery. A vocabulary that cannot hold what a writer writes is the
    // drift this test exists for.
    expect(WIDENING).toMatch(/delivery_method = 'kit_tag'/);
  });

  test("a sent invitation must still carry real delivery evidence", () => {
    // The guarantee the convergence command depends on (§8u): status 'sent'
    // is never true without both a sent_at and a delivery_method.
    expect(TABLES).toMatch(
      /check \(status <> 'sent' or \(sent_at is not null and delivery_method is not null\)\)/,
    );
  });
});
