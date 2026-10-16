import { describe, expect, it } from "vitest";

import {
  allocateBalance,
  allocateBalanceCents,
  allocateBalanceFromCents,
  describePhases,
  groupIntoPhases,
} from "./depositAllocation";

// THE DECIDED PLANS, TO THE CENT.
//
// Leif's rulings, 2026-10-16:
//   · the deposit is credited toward the SELECTED OPTION'S total
//   · The Living Example's Financial Need option stays $3,996 — four Won
//     Deals already carry it, and it is not to be rewritten as $4,000
//   · unequal installments are authorised; do not distort agreed_total
//     merely to keep every monthly charge identical
//
// Every number below is one of those plans. The invariant underneath all
// of them is the only one that really matters: the parts sum to the
// balance EXACTLY.

const money = (amount: number) => `$${amount.toFixed(2)}`;

const allocate = (total: number, deposit: number, installments: number) => {
  const result = allocateBalance({
    agreedTotal: total,
    deposit,
    installments,
  });
  if (result.status !== "allocated") {
    throw new Error(`expected an allocation, got ${result.reason}`);
  }
  return result.allocation;
};

describe("The Living Example", () => {
  it("A. pay in full: $500 down leaves one payment of $3,500", () => {
    const plan = allocate(4000, 500, 1);

    expect(plan.depositCents).toBe(50000);
    expect(plan.balanceCents).toBe(350000);
    expect(plan.perInstallmentCents).toEqual([350000]);
    expect(plan.phases).toEqual([{ iterations: 1, amountCents: 350000 }]);
  });

  it("B. 4-pay: $500 down leaves 4 × $875.00, evenly", () => {
    const plan = allocate(4000, 500, 4);

    expect(plan.balanceCents).toBe(350000);
    expect(plan.perInstallmentCents).toEqual([87500, 87500, 87500, 87500]);
    // Even, so ONE phase — an even plan must not acquire a second one just
    // because the uneven machinery exists.
    expect(plan.phases).toEqual([{ iterations: 4, amountCents: 87500 }]);
    expect(describePhases(plan.phases, money)).toBe("4 × $875.00");
  });

  it("C. Financial Need: $3,996 less $500 is 4 × $582.67 then 2 × $582.66", () => {
    // The plan that forced uneven installments to be legal. $3,496 does
    // not divide by six, and the agreed total is not negotiable.
    const plan = allocate(3996, 500, 6);

    expect(plan.agreedTotalCents).toBe(399600);
    expect(plan.balanceCents).toBe(349600);
    expect(plan.perInstallmentCents).toEqual([
      58267, 58267, 58267, 58267, 58266, 58266,
    ]);
    expect(plan.phases).toEqual([
      { iterations: 4, amountCents: 58267 },
      { iterations: 2, amountCents: 58266 },
    ]);
    expect(describePhases(plan.phases, money)).toBe(
      "4 × $582.67 then 2 × $582.66",
    );
  });
});

describe("Growing Yourself Up", () => {
  it("D. pay in full: $400 down leaves one payment of $1,000", () => {
    const plan = allocate(1400, 400, 1);

    expect(plan.balanceCents).toBe(100000);
    expect(plan.perInstallmentCents).toEqual([100000]);
  });

  it("E. 2-pay: 2 × $500.00", () => {
    const plan = allocate(1400, 400, 2);

    expect(plan.perInstallmentCents).toEqual([50000, 50000]);
    expect(plan.phases).toEqual([{ iterations: 2, amountCents: 50000 }]);
  });

  it("F. Financial Need 4-pay: 4 × $250.00", () => {
    const plan = allocate(1400, 400, 4);

    expect(plan.perInstallmentCents).toEqual([25000, 25000, 25000, 25000]);
    expect(plan.phases).toEqual([{ iterations: 4, amountCents: 25000 }]);
  });
});

describe("G. the parts always sum to the balance, exactly", () => {
  // The property, not three examples of it. Every total from $1 to $100 in
  // cents, against every plausible instalment count and a deposit of every
  // shape — including ones that leave an awkward remainder.
  it("holds across every total, deposit and installment count worth trying", () => {
    for (let totalCents = 1; totalCents <= 10000; totalCents += 7) {
      for (const installments of [1, 2, 3, 4, 6, 12]) {
        for (const depositCents of [
          0,
          1,
          Math.floor(totalCents / 3),
          totalCents - 1,
          totalCents,
        ]) {
          if (depositCents < 0 || depositCents > totalCents) continue;
          const result = allocateBalanceFromCents({
            agreedTotalCents: totalCents,
            depositCents,
            installments,
          });
          expect(result.status).toBe("allocated");
          if (result.status !== "allocated") continue;

          const { perInstallmentCents, balanceCents, phases } =
            result.allocation;
          const sum = perInstallmentCents.reduce((a, b) => a + b, 0);
          expect(sum).toBe(balanceCents);
          // And the phase grouping is lossless.
          const phaseSum = phases.reduce(
            (a, p) => a + p.iterations * p.amountCents,
            0,
          );
          expect(phaseSum).toBe(balanceCents);
          // Every installment is a whole number of cents.
          for (const part of perInstallmentCents) {
            expect(Number.isInteger(part)).toBe(true);
          }
          // The parts differ by at most one cent, and the bigger ones come
          // first.
          if (perInstallmentCents.length > 1) {
            const max = Math.max(...perInstallmentCents);
            const min = Math.min(...perInstallmentCents);
            expect(max - min).toBeLessThanOrEqual(1);
            const firstMin = perInstallmentCents.indexOf(min);
            const lastMax = perInstallmentCents.lastIndexOf(max);
            if (max !== min) expect(lastMax).toBeLessThan(firstMin);
          }
        }
      }
    }
  });

  it("the remainder goes to the earliest payments, one cent each", () => {
    // 100 over 3 is 33.33…; the extra cent lands on the first.
    expect(allocateBalanceCents(100, 3)).toEqual([34, 33, 33]);
    // 1000 over 7: floor 142, remainder 6 — six payments carry the cent.
    expect(allocateBalanceCents(1000, 7)).toEqual([
      143, 143, 143, 143, 143, 143, 142,
    ]);
  });
});

describe("H. a deposit cannot exceed the thing it is a deposit on", () => {
  it("refuses a deposit larger than the total", () => {
    expect(
      allocateBalance({ agreedTotal: 1400, deposit: 1500, installments: 2 }),
    ).toEqual({ status: "refused", reason: "deposit-exceeds-total" });
  });

  it("refuses a negative deposit", () => {
    expect(
      allocateBalance({ agreedTotal: 1400, deposit: -1, installments: 2 }),
    ).toEqual({ status: "refused", reason: "deposit-negative" });
  });

  it("a deposit EQUAL to the total leaves nothing to schedule", () => {
    // Legal, and the honest answer: there is no balance, so there must be
    // no schedule. A caller that builds one for $0 is the bug this guards.
    const plan = allocate(1400, 1400, 2);
    expect(plan.balanceCents).toBe(0);
    expect(plan.perInstallmentCents).toEqual([]);
    expect(plan.phases).toEqual([]);
  });

  it("refuses a total that is not positive, and an impossible count", () => {
    expect(
      allocateBalance({ agreedTotal: 0, deposit: 0, installments: 1 }).status,
    ).toBe("refused");
    expect(
      allocateBalance({ agreedTotal: 1400, deposit: 0, installments: 0 })
        .status,
    ).toBe("refused");
  });
});

describe("J. an option with no deposit behaves exactly as it always did", () => {
  it("null and zero both mean no deposit, and the plan is unchanged", () => {
    for (const deposit of [null, undefined, 0]) {
      const result = allocateBalance({
        agreedTotal: 4000,
        deposit,
        installments: 4,
      });
      expect(result.status).toBe("allocated");
      if (result.status !== "allocated") continue;
      expect(result.allocation.depositCents).toBe(0);
      expect(result.allocation.balanceCents).toBe(400000);
      expect(result.allocation.perInstallmentCents).toEqual([
        100000, 100000, 100000, 100000,
      ]);
    }
  });

  it("and the historical shapes production actually holds still divide", () => {
    // $3,700, $3,998 in 6 × $583, $9,000, $4,500 — real agreed totals.
    // With no deposit the allocation reproduces an even split where one
    // exists and stays exact where it does not.
    expect(allocate(3700, 0, 1).perInstallmentCents).toEqual([370000]);
    expect(allocate(9000, 0, 12).perInstallmentCents.length).toBe(12);
    const awkward = allocate(3998, 0, 6);
    expect(awkward.perInstallmentCents.reduce((a, b) => a + b, 0)).toBe(399800);
  });
});

describe("the phase grouping", () => {
  it("collapses only CONSECUTIVE equal amounts", () => {
    expect(groupIntoPhases([5, 5, 4, 4, 4])).toEqual([
      { iterations: 2, amountCents: 5 },
      { iterations: 3, amountCents: 4 },
    ]);
    // Deliberately not reordered into two groups: a schedule charges in
    // order, so the order is part of the truth.
    expect(groupIntoPhases([5, 4, 5])).toEqual([
      { iterations: 1, amountCents: 5 },
      { iterations: 1, amountCents: 4 },
      { iterations: 1, amountCents: 5 },
    ]);
  });

  it("an empty balance groups into no phases", () => {
    expect(groupIntoPhases([])).toEqual([]);
    expect(describePhases([], money)).toBe("");
  });
});
