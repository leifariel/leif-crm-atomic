// The Edge-Function mirror of src/components/atomic-crm/deals/
// postSaleCheckout.ts, for the two functions that decide whether a sold
// client may still be sent to pay: offer_page (what the page shows) and
// stripe_checkout (what the server will actually charge).
//
// Shared between those two deliberately. They must never disagree — a page
// offering a payment the server then refuses is this slice's own defect in
// mirror image. Edge Functions cannot import from src/, so this is the one
// hand-kept copy, not two.
//
// Deliberately PURE: no Deno APIs, no database, no imports at all. That is
// what lets the `functions` vitest project run the real mirror against the
// same cases as the src module, so "kept in sync by hand" is asserted
// rather than hoped for (postSaleCheckoutRules.test.ts).
//
// Becky Schmauch's sale is why this exists: she was Won, her agreed total
// was recorded, nothing was collected, and both the page and the Checkout
// function refused her because each asked `stage === 'won'` and read it as
// "already paid". Those guards were written on 2026-09-04, when Won was
// reachable only through a successful Stripe payment; 20260918180000
// overturned that model thirteen days later. Won still matters here, for
// what it actually means — THE SALE IS AGREED, so the catalog is no longer
// a menu — while whether payment may still be TAKEN is decided by money,
// plans and Leif's own statements.

export type CheckoutBlock =
  // No agreed total, so there is no amount to charge. Never the list
  // price: LE has sold at $3,700 and at $9,000.
  | "terms-unknown"
  | "paid-in-full"
  // A live Stripe plan already carries it; a second Checkout charges twice.
  | "plan-exists"
  | "setup-confirmed-elsewhere"
  // Real agreement, but Stripe cannot reproduce it to the cent. $4,000 in
  // 3 is the canonical case: 3 × $1,333.33 is $3,999.99, and a plan a cent
  // short of the agreement reads "$0.01 remaining" forever.
  | "not-representable"
  // Scholarship pricing says one number and the agreed total says another,
  // and nobody has stated which is right. Never resolved by substituting
  // either value — see assessCheckoutFacts.
  | "scholarship-unconfirmed";

export type ExactInstallments = {
  total: number;
  installments: number;
  installmentAmount: number;
};

export type CheckoutAssessment =
  // Not sold yet: the prospect is choosing, so the catalog rules apply
  // exactly as they did before this module existed.
  | { status: "catalog" }
  | { status: "payable"; terms: ExactInstallments; collected: number }
  | { status: "blocked"; reason: CheckoutBlock; collected: number };

export type CheckoutFacts = {
  stage: string;
  agreedTotal: number | null;
  agreedInstallmentCount: number | null;
  agreedInstallmentAmount: number | null;
  collectedCents: number;
  hasCurrentPlan: boolean;
  ownerConfirmedSetup: boolean;
  // Scholarship is an explicit owner fact; so is the agreed total. These
  // two are what decide whether they contradict each other, and whether
  // Leif has already said which one governs.
  pricingMode: string | null;
  scholarshipPrice: number | null;
  // deals.selected_payment_total_source. "owner_confirmed" is written by
  // exactly one app path — Leif typing the total into the payment panel —
  // so it IS the durable record of her having asserted it. "stripe_derived"
  // is a machine inference and null is an import: neither is an assertion.
  agreedTotalSource: string | null;
};

// Money compares in cents. Floating point on decimal currency is how a
// $700.00 payment against a $700 agreement fails to be paid in full.
export const CENTS = (value: number): number => Math.round(value * 100);
// Half a cent, so arithmetic noise never decides a verdict.
export const TOLERANCE = 0.5;

// Can Stripe charge exactly this agreement with today's machinery?
//
// The STORED installment amount IS the agreement — never a fresh division.
// Daniel Alexander's Opportunity says $3,998 in 6 × $583, which multiplies
// to $3,498; recomputing would silently invent $666.33 and charge a number
// nobody agreed to. So this multiplies what is written down and demands it
// equal the total to the cent.
export const reconstructAgreedTerms = (
  total: number | null,
  installments: number | null,
  installmentAmount: number | null,
): ExactInstallments | null => {
  if (total == null || !Number.isFinite(total) || CENTS(total) <= 0) {
    return null;
  }
  const count =
    installments == null || !Number.isFinite(installments)
      ? 1
      : Math.trunc(installments);
  if (count < 1) return null;

  if (count === 1) {
    // A stored per-installment amount that disagrees with the total is a
    // contradiction, not a rounding question.
    if (
      installmentAmount != null &&
      CENTS(installmentAmount) !== CENTS(total)
    ) {
      return null;
    }
    return { total, installments: 1, installmentAmount: total };
  }

  if (installmentAmount == null || !Number.isFinite(installmentAmount)) {
    return null;
  }
  if (CENTS(installmentAmount) * count !== CENTS(total)) return null;
  return { total, installments: count, installmentAmount };
};

export const assessCheckoutFacts = (
  facts: CheckoutFacts,
): CheckoutAssessment => {
  if (facts.stage !== "won") return { status: "catalog" };

  const collected = facts.collectedCents / 100;
  const termsKnown = facts.agreedTotal != null && CENTS(facts.agreedTotal) > 0;
  const paidInFull =
    termsKnown &&
    facts.collectedCents + TOLERANCE >= CENTS(facts.agreedTotal as number);

  // Ordered so the most conclusive fact wins: money outranks an
  // arrangement, and an arrangement outranks the shape of the agreement.
  if (paidInFull) {
    return { status: "blocked", reason: "paid-in-full", collected };
  }
  if (facts.hasCurrentPlan) {
    return { status: "blocked", reason: "plan-exists", collected };
  }
  if (facts.ownerConfirmedSetup) {
    return {
      status: "blocked",
      reason: "setup-confirmed-elsewhere",
      collected,
    };
  }
  if (!termsKnown) {
    return { status: "blocked", reason: "terms-unknown", collected };
  }

  // A scholarship Opportunity whose agreed total is not the scholarship
  // price is either a deliberate arrangement or a mistake, and the
  // difference is not something a machine may decide. The authority is a
  // canonical fact, not a click: the total must carry
  // owner_confirmed provenance. Withholding the link in the owner UI would
  // not be enough — the Offer Page token stays executable, so the rule
  // lives here, where both the page and the checkout ask.
  if (
    facts.pricingMode === "scholarship" &&
    facts.scholarshipPrice != null &&
    CENTS(facts.agreedTotal as number) !== CENTS(facts.scholarshipPrice) &&
    facts.agreedTotalSource !== "owner_confirmed"
  ) {
    return { status: "blocked", reason: "scholarship-unconfirmed", collected };
  }

  const terms = reconstructAgreedTerms(
    facts.agreedTotal,
    facts.agreedInstallmentCount,
    facts.agreedInstallmentAmount,
  );
  if (!terms) {
    return { status: "blocked", reason: "not-representable", collected };
  }
  return { status: "payable", terms, collected };
};
