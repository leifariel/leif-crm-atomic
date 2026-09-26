import { describe, expect, it } from "vitest";

import {
  assessCheckoutFacts,
  reconstructAgreedTerms,
  type CheckoutFacts,
} from "./postSaleCheckoutRules.ts";

// The mirror the public page and real Stripe actually run on.
//
// The src module (deals/postSaleCheckout.ts) is the logic of record and has
// its own suite; this one exists because "kept in sync by hand" has to be
// asserted somewhere. Both files answer the same cases here and in
// deals/postSaleCheckout.test.ts, deliberately with the same inputs, so a
// change to one that is not made to the other fails on the side that was
// forgotten. The parity of the two RESULT sets is asserted in
// contracts/deals/postWonPaymentSetup.test.ts.

const facts = (over: Partial<CheckoutFacts> = {}): CheckoutFacts => ({
  stage: "won",
  agreedTotal: 4000,
  agreedInstallmentCount: 1,
  agreedInstallmentAmount: 4000,
  collectedCents: 0,
  hasCurrentPlan: false,
  ownerConfirmedSetup: false,
  pricingMode: "standard",
  scholarshipPrice: 4000,
  agreedTotalSource: "owner_confirmed",
  ...over,
});

describe("what Stripe can charge exactly", () => {
  it("a single payment is the total", () => {
    expect(reconstructAgreedTerms(4000, 1, 4000)).toEqual({
      total: 4000,
      installments: 1,
      installmentAmount: 4000,
    });
  });

  it("treats a missing installment count as a single payment", () => {
    // Lara Spagnola's Opportunity has a total and no count.
    expect(reconstructAgreedTerms(1400, null, null)).toEqual({
      total: 1400,
      installments: 1,
      installmentAmount: 1400,
    });
  });

  it("accepts equal installments that reconstruct the total to the cent", () => {
    expect(reconstructAgreedTerms(4000, 4, 1000)).toEqual({
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
    });
    // Sam Milz's real structure.
    expect(reconstructAgreedTerms(700, 4, 175)).not.toBeNull();
    // Gigi George's.
    expect(reconstructAgreedTerms(3000, 4, 750)).not.toBeNull();
  });

  it("refuses $4,000 in 3 rather than charging $3,999.99", () => {
    // The canonical case. A cent short of the agreement reads
    // "$0.01 remaining" forever, because paidInFull compares against the
    // agreed total and not against what the plan happens to add up to.
    expect(reconstructAgreedTerms(4000, 3, 1333.33)).toBeNull();
  });

  it("refuses stored terms that do not multiply out", () => {
    // Daniel Alexander: $3,998 in 6 x $583 is $3,498. Recomputing would
    // invent $666.33 and charge a number nobody agreed to.
    expect(reconstructAgreedTerms(3998, 6, 583)).toBeNull();
  });

  it("refuses a single payment whose stored amount contradicts the total", () => {
    expect(reconstructAgreedTerms(4000, 1, 3700)).toBeNull();
  });

  it("refuses a plan with no stored installment amount", () => {
    expect(reconstructAgreedTerms(4000, 4, null)).toBeNull();
  });

  it("refuses nothing, zero and negatives", () => {
    expect(reconstructAgreedTerms(null, 1, null)).toBeNull();
    expect(reconstructAgreedTerms(0, 1, 0)).toBeNull();
    expect(reconstructAgreedTerms(-4000, 1, -4000)).toBeNull();
  });
});

describe("whether a sold client may still be sent to pay", () => {
  it("Becky's exact state is payable, for exactly her terms", () => {
    const result = assessCheckoutFacts(facts());
    expect(result).toEqual({
      status: "payable",
      terms: { total: 4000, installments: 1, installmentAmount: 4000 },
      collected: 0,
    });
  });

  it("a deal that is not sold yet is still the catalog's business", () => {
    expect(assessCheckoutFacts(facts({ stage: "call_booked" }))).toEqual({
      status: "catalog",
    });
  });

  it("refuses when the money is already in", () => {
    const result = assessCheckoutFacts(facts({ collectedCents: 400000 }));
    expect(result).toMatchObject({ status: "blocked", reason: "paid-in-full" });
  });

  it("treats a half-cent short of the total as paid", () => {
    expect(
      assessCheckoutFacts(facts({ collectedCents: 399999.6 })),
    ).toMatchObject({ reason: "paid-in-full" });
  });

  it("refuses a second checkout when a live plan already carries it", () => {
    // Nothing collected yet, and still no second checkout: a plan charging
    // its first installment tomorrow is an arrangement.
    const result = assessCheckoutFacts(facts({ hasCurrentPlan: true }));
    expect(result).toMatchObject({ status: "blocked", reason: "plan-exists" });
  });

  it("refuses when Leif has recorded an arrangement elsewhere", () => {
    expect(
      assessCheckoutFacts(facts({ ownerConfirmedSetup: true })),
    ).toMatchObject({ reason: "setup-confirmed-elsewhere" });
  });

  it("refuses when nobody recorded what was agreed", () => {
    expect(
      assessCheckoutFacts(
        facts({
          agreedTotal: null,
          agreedInstallmentCount: null,
          agreedInstallmentAmount: null,
        }),
      ),
    ).toMatchObject({ reason: "terms-unknown" });
  });

  it("refuses an agreement Stripe cannot charge exactly", () => {
    expect(
      assessCheckoutFacts(
        facts({
          agreedTotal: 4000,
          agreedInstallmentCount: 3,
          agreedInstallmentAmount: 1333.33,
        }),
      ),
    ).toMatchObject({ reason: "not-representable" });
  });

  it("puts money ahead of the shape of the agreement", () => {
    // Paid in full AND unrepresentable: the money is the conclusive fact.
    expect(
      assessCheckoutFacts(
        facts({
          collectedCents: 400000,
          agreedInstallmentCount: 3,
          agreedInstallmentAmount: 1333.33,
        }),
      ),
    ).toMatchObject({ reason: "paid-in-full" });
  });
});

describe("scholarship pricing against a different agreed total", () => {
  const scholarship = (over: Partial<CheckoutFacts> = {}) =>
    facts({
      pricingMode: "scholarship",
      scholarshipPrice: 3000,
      agreedTotal: 2800,
      agreedInstallmentCount: 1,
      agreedInstallmentAmount: 2800,
      ...over,
    });

  it("refuses until somebody has actually stated which number governs", () => {
    // Derived from Stripe is a machine inference, not an assertion.
    expect(
      assessCheckoutFacts(scholarship({ agreedTotalSource: "stripe_derived" })),
    ).toMatchObject({ status: "blocked", reason: "scholarship-unconfirmed" });
    // An imported total with no provenance at all.
    expect(
      assessCheckoutFacts(scholarship({ agreedTotalSource: null })),
    ).toMatchObject({ reason: "scholarship-unconfirmed" });
    // And an Offer-snapshot fallback, which the column also permits.
    expect(
      assessCheckoutFacts(scholarship({ agreedTotalSource: "offer_snapshot" })),
    ).toMatchObject({ reason: "scholarship-unconfirmed" });
  });

  it("charges the owner-confirmed total once she has stated it", () => {
    const result = assessCheckoutFacts(
      scholarship({ agreedTotalSource: "owner_confirmed" }),
    );
    expect(result.status).toBe("payable");
    if (result.status === "payable") {
      // Her number, not the scholarship price. Neither was substituted.
      expect(result.terms.total).toBe(2800);
    }
  });

  it("does not care about provenance when the numbers agree", () => {
    // Mel, Sam and Gigi: scholarship pricing, total equal to it, imported
    // with no provenance. Never blocked.
    expect(
      assessCheckoutFacts(
        scholarship({
          agreedTotal: 3000,
          agreedInstallmentAmount: 3000,
          agreedTotalSource: null,
        }),
      ).status,
    ).toBe("payable");
  });

  it("does not apply to standard pricing at all", () => {
    // Ten Won Opportunities carry a total that differs from their list
    // price and every one of them is correct.
    expect(
      assessCheckoutFacts(
        facts({
          pricingMode: "standard",
          scholarshipPrice: 4000,
          agreedTotal: 3700,
          agreedInstallmentAmount: 3700,
          agreedTotalSource: null,
        }),
      ).status,
    ).toBe("payable");
  });
});
