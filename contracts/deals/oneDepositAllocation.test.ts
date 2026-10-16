// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  allocateBalanceCents,
  groupIntoPhases,
} from "../../src/components/atomic-crm/deals/depositAllocation";
import {
  allocateBalanceCents as mirrorAllocate,
  groupIntoPhases as mirrorGroup,
} from "../../supabase/functions/_shared/depositAllocation";

// ONE WAY TO SPLIT A BALANCE, IN THREE LANGUAGES.
//
// A deposit leaves a balance that may not divide evenly, and three places
// have to agree on the cents to the cent:
//
//   deals/depositAllocation.ts            the owner's form and the prospect's
//                                         payment page
//   _shared/depositAllocation.ts          the Edge Functions, which cannot
//                                         import from src/
//   allocate_balance_cents()              Postgres, the authority that
//                                         plan_balance_schedule() uses
//
// The first two are compared here, exhaustively. The third is compared
// against this one in e2e/depositsAndTheBalance.spec.ts, because only a real
// database can answer for it.
//
// If they ever disagree, the page promises a number the card is not charged.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SQL = readFileSync(
  path.join(
    REPO_ROOT,
    "supabase/migrations/20261017120000_a_deposit_is_credited_not_charged_twice.sql",
  ),
  "utf8",
);

describe("the TypeScript module and its Deno mirror never disagree", () => {
  it("allocate the same cents for every balance and count worth trying", () => {
    for (let balance = 0; balance <= 4000; balance += 3) {
      for (const installments of [1, 2, 3, 4, 6, 12]) {
        expect(
          mirrorAllocate(balance, installments),
          `balance ${balance} over ${installments}`,
        ).toEqual(allocateBalanceCents(balance, installments));
      }
    }
  });

  it("group the same phases", () => {
    for (const parts of [
      [58267, 58267, 58267, 58267, 58266, 58266],
      [87500, 87500, 87500, 87500],
      [350000],
      [25000, 25000, 25000, 25000],
      [],
      [5, 4, 5],
    ]) {
      expect(mirrorGroup(parts)).toEqual(groupIntoPhases(parts));
    }
  });

  it("and both produce the decided plans", () => {
    // $3,996 − $500 over six, and $4,000 − $500 over four.
    for (const allocate of [allocateBalanceCents, mirrorAllocate]) {
      expect(allocate(349600, 6)).toEqual([
        58267, 58267, 58267, 58267, 58266, 58266,
      ]);
      expect(allocate(350000, 4)).toEqual([87500, 87500, 87500, 87500]);
      expect(allocate(100000, 2)).toEqual([50000, 50000]);
      expect(allocate(100000, 4)).toEqual([25000, 25000, 25000, 25000]);
    }
  });
});

describe("the SQL authority states the same algorithm", () => {
  // Not a substitute for running it -- the e2e does that. This catches the
  // version that silently stops being the same algorithm, which a passing
  // behavioural test on one example would not.
  it("divides, takes the remainder, and gives the earliest payments the extra cent", () => {
    const from = SQL.indexOf(
      "create or replace function public.allocate_balance_cents(",
    );
    expect(from).toBeGreaterThan(-1);
    const body = SQL.slice(from, SQL.indexOf("$fn$;", from));

    expect(body).toContain("p_balance_cents / p_installments");
    expect(body).toContain("p_balance_cents % p_installments");
    // `i <= remainder` is what makes it the EARLIEST payments rather than
    // the latest. Reversing it would still sum correctly and would be a
    // different schedule.
    expect(body).toMatch(/i <= \(p_balance_cents % p_installments\)/);
    expect(body).toContain("order by i");
    // Integer division, so no floating point can enter: bigint / int in
    // Postgres truncates.
    expect(body).toContain("bigint");
  });

  it("and the migration asserts the Financial Need plan at creation time", () => {
    // A migration that cannot replay is caught on deploy; an arithmetic
    // regression inside one is not, unless it asserts.
    expect(SQL).toContain(
      "array[58267, 58267, 58267, 58267, 58266, 58266]::bigint[]",
    );
    expect(SQL).toContain("349600");
  });
});

describe("the agreed total is never distorted to make the maths tidy", () => {
  it("the Financial Need option keeps $3,996, and the balance absorbs the remainder", () => {
    // Leif's ruling: four Won Deals already carry $3,996 and it is not to be
    // rewritten as $4,000. So the uneven cents live in the BALANCE split,
    // which is this module's whole reason to exist.
    const parts = allocateBalanceCents(399600 - 50000, 6);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(349600);
    expect(new Set(parts).size).toBe(2);
    expect(Math.max(...parts) - Math.min(...parts)).toBe(1);
  });

  it("an option's own installment_amount stays the PRE-deposit figure", () => {
    // 6 × $666 = $3,996 still adds up, which is why
    // set_offer_payment_option() did NOT need its add-up rule relaxed. The
    // migration says so, and this is what notices if somebody relaxes it
    // anyway and lets a catalogue option stop adding up for unrelated
    // reasons.
    expect(SQL).toContain("instalments-do-not-add-up");
    const from = SQL.indexOf(
      "create or replace function public.set_offer_payment_option(",
    );
    const body = SQL.slice(from, SQL.indexOf("$fn$;", from));
    expect(body).toMatch(
      /round\(p_installment_amount \* p_installments, 2\) <> round\(p_total, 2\)/,
    );
  });
});
