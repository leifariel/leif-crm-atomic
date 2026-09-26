import type {
  Deal,
  DealPaymentScheduleItem,
  DealStripePlanObject,
} from "../types";
import { assessPaymentTruth, CENTS, type PaymentTruth } from "./paymentTruth";

// Whether this person may still be sent to pay, and for exactly what.
//
// Becky Schmauch's sale is why this module exists. She was Won, her agreed
// total was recorded, nothing had been collected — and both the public
// Offer Page and the Checkout function refused her, because each asked
// `stage === 'won'` and read it as "already paid". Those guards were
// written on 2026-09-04, when Won was reachable ONLY through a successful
// Stripe payment. 20260918180000 overturned that model thirteen days
// later: "a model that treated Won as a payment fact. It is not." Nobody
// revisited the two guards, so the CRM could sell to somebody and then
// had no way to take their money.
//
// Won still matters here, but for what it actually means: THE SALE IS
// AGREED. So the catalog stops being a menu — an already-sold client is
// not shopping, and the terms Leif recorded outrank every public option.
// Whether payment may still be TAKEN is a different question, and it is
// answered by paymentTruth.ts, which already knew: paidInFull, a live
// plan, or an arrangement confirmed outside Stripe.
//
// Mirrored by hand in supabase/functions/_shared/postSaleCheckout.ts,
// because Edge Functions cannot import from src/. Same dual-implementation
// convention as every other integration here; that mirror is the one the
// public page and real Stripe run on, and this is the FakeRest-testable
// logic of record.

export type PostSaleCheckoutBlock =
  // No agreed total, so there is no amount to charge. Never the list
  // price: LE has sold at $3,700 and $9,000, and a substituted number is
  // a different person's agreement.
  | "terms-unknown"
  // The money is already in.
  | "paid-in-full"
  // A live Stripe plan is already carrying it — a second Checkout would
  // charge them twice.
  | "plan-exists"
  // Leif has stated an arrangement exists outside this CRM.
  | "setup-confirmed-elsewhere"
  // The agreement is real but Stripe cannot reproduce it to the cent.
  // $4,000 in 3 is the canonical case: 3 × $1,333.33 is $3,999.99, and a
  // plan that charges a cent less than the agreement would read
  // "$0.01 remaining" forever.
  | "not-representable"
  // Scholarship pricing says one number, the agreed total says another, and
  // nobody has stated which governs. The authority is a canonical fact
  // (owner_confirmed provenance), never a click — see below.
  | "scholarship-unconfirmed";

export type ExactInstallments = {
  total: number;
  installments: number;
  installmentAmount: number;
};

export type PostSaleCheckoutAssessment =
  // Not sold yet: the prospect is choosing, so the catalog rules apply
  // exactly as before this module existed.
  | { status: "catalog"; truth: PaymentTruth }
  | { status: "payable"; terms: ExactInstallments; truth: PaymentTruth }
  | {
      status: "blocked";
      reason: PostSaleCheckoutBlock;
      truth: PaymentTruth;
      // Present when the agreement itself is known but unrepresentable,
      // so the owner-facing surface can say what it could not build.
      agreed: { total: number; installments: number | null } | null;
    };

// Can Stripe charge exactly this agreement, with today's machinery?
//
// The STORED installment amount is the agreement — never a fresh
// division. Daniel Alexander's Opportunity says $3,998 in 6 × $583, which
// multiplies to $3,498; recomputing would silently invent $666.33 and
// charge a number nobody agreed to. So this multiplies what is written
// down and demands it equal the total to the cent.
export const reconstructAgreedTerms = (
  total: number | null | undefined,
  installments: number | null | undefined,
  installmentAmount: number | null | undefined,
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
    // A one-time charge of the total. A stored per-installment amount that
    // disagrees with the total is a contradiction, not a rounding
    // question.
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

export type PostSaleCheckoutInput = {
  deal: Parameters<typeof assessPaymentTruth>[0]["deal"] &
    Pick<
      Deal,
      | "stage"
      | "pricing_mode"
      | "offer_price_snapshot"
      | "selected_payment_total_source"
    >;
  scheduleItems: DealPaymentScheduleItem[];
  planObjects: DealStripePlanObject[];
};

export const assessPostSaleCheckout = ({
  deal,
  scheduleItems,
  planObjects,
}: PostSaleCheckoutInput): PostSaleCheckoutAssessment => {
  const truth = assessPaymentTruth({ deal, scheduleItems, planObjects });

  // `won` here is the SALE being agreed, not a payment claim — the
  // distinction this whole module exists to restore.
  if (deal.stage !== "won") return { status: "catalog", truth };

  const agreed =
    truth.agreedTotal != null
      ? { total: truth.agreedTotal, installments: truth.agreedInstallmentCount }
      : null;

  // Ordered so the most conclusive fact wins. Money outranks an
  // arrangement, and an arrangement outranks the shape of the agreement.
  if (truth.paidInFull) {
    return { status: "blocked", reason: "paid-in-full", truth, agreed };
  }
  if (truth.hasCurrentPlan) {
    return { status: "blocked", reason: "plan-exists", truth, agreed };
  }
  if (truth.paymentSetupComplete) {
    // Only owner-confirmed setup is left once the two above are excluded.
    return {
      status: "blocked",
      reason: "setup-confirmed-elsewhere",
      truth,
      agreed,
    };
  }
  if (!truth.termsKnown) {
    return { status: "blocked", reason: "terms-unknown", truth, agreed: null };
  }

  // Scholarship and the agreed total are two independent owner facts, and
  // when they disagree the machine does not choose. What authorizes the
  // charge is that Leif STATED the total: selected_payment_total_source =
  // owner_confirmed, written by exactly one app path (her typing it into the
  // payment panel). A derived total (stripe_derived) or an imported one
  // (null) is not an assertion, so it waits for her.
  //
  // Enforced here rather than by hiding the link, because the Offer Page
  // token remains executable by anyone who has it: the page and the
  // Checkout function both ask this function, and the Edge mirror applies
  // the identical rule.
  if (
    scholarshipTermsConflict(deal) != null &&
    deal.selected_payment_total_source !== "owner_confirmed"
  ) {
    return {
      status: "blocked",
      reason: "scholarship-unconfirmed",
      truth,
      agreed,
    };
  }

  const terms = reconstructAgreedTerms(
    truth.agreedTotal,
    truth.agreedInstallmentCount,
    truth.agreedInstallmentAmount,
  );
  if (!terms) {
    return { status: "blocked", reason: "not-representable", truth, agreed };
  }
  return { status: "payable", terms, truth };
};

// Why an owner-facing surface could not offer the payment link.
export const describeCheckoutBlock = (
  reason: PostSaleCheckoutBlock,
  agreed: { total: number; installments: number | null } | null,
): string => {
  switch (reason) {
    case "paid-in-full":
      return "This is paid in full.";
    case "plan-exists":
      return "A payment plan already exists — sending another link would charge them twice.";
    case "setup-confirmed-elsewhere":
      return "Payment setup is already recorded as handled outside this CRM.";
    case "terms-unknown":
      return "Record the agreed total first — there is no amount to charge.";
    case "scholarship-unconfirmed":
      return "This is on scholarship pricing, and the agreed total is a different number. Confirm the total to authorize it.";
    case "not-representable":
    default:
      return agreed?.installments && agreed.installments > 1
        ? `${agreed.installments} equal monthly installments cannot add up to ${agreed.total} exactly, so no plan is created. Handle this arrangement outside the CRM and record it here.`
        : "These terms cannot be charged exactly as written. Handle this arrangement outside the CRM and record it here.";
  }
};

// Scholarship stays an explicit owner fact and so does the agreed total;
// neither is ever derived from the other. When they disagree materially
// the surface ASKS rather than substituting — ten Won Opportunities
// already carry an agreed total that differs from their list price, and
// every one of them is correct.
export const scholarshipTermsConflict = (
  deal: Pick<
    Deal,
    "pricing_mode" | "offer_price_snapshot" | "selected_payment_total"
  >,
): { total: number; scholarshipPrice: number } | null => {
  if (deal.pricing_mode !== "scholarship") return null;
  const total = deal.selected_payment_total;
  const price = deal.offer_price_snapshot;
  if (total == null || price == null) return null;
  return CENTS(Number(total)) === CENTS(Number(price))
    ? null
    : { total: Number(total), scholarshipPrice: Number(price) };
};
