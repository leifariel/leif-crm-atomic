import type {
  Deal,
  DealPaymentScheduleItem,
  DealStripePlanObject,
} from "../types";

// The one place that decides what is true about a person's money.
//
// There were three. A panel computed the agreed total from the Deal with a
// fallback to the Offer's current list price; a card computed it by summing
// the ledger, so a part-paid client's "agreed total" was whatever they had
// paid so far; and a formatter announced "First payment of $X received"
// from the installment structure alone, with no row behind it at all.
//
// They disagreed on live clients. Jules Litman-Cleper read "settled, $0.00
// outstanding" and "5 of 6 · $666 remaining" on the same screen. Sam Milz,
// who has paid nothing, was told his first $175 had been received.
//
// So: one module, and every surface calls it. The rules below are the
// whole of the business logic, and nothing downstream may re-derive them.
//
//   AGREED comes from the Deal and only the Deal. The Offer's list price
//   is a fact about the product, not about this person — LE has sold at
//   $3,700 and at $4,000, and every historical Opportunity carries today's
//   price from the import. Terms we do not know are UNKNOWN, never
//   substituted.
//
//   COLLECTED is actual money. A subscription, a schedule, a SetupIntent,
//   a saved card, a scholarship and an installment plan are not money.
//
//   REMAINING is agreed minus collected. Not ledger minus paid: the ledger
//   is a record of events, not the agreement.
//
//   INSTALLMENTS SATISFIED is collected DIVIDED BY the agreed installment
//   amount, floored. Not the number of transactions — Jess Beauchamp paid
//   four installments with three payments — and never rounded up, because
//   $600 toward a $1,000 installment is no installments.
//
//   PAID IN FULL needs known terms. "Every row happens to be paid" is not
//   proof; that is what called Jules settled.

export type PaymentState =
  | "paid_in_full"
  | "active_plan"
  | "scheduled_plan"
  // Deposits slice: a plan EXISTS and is not collecting. Stripe says
  // past_due / unpaid (a charge failed) or incomplete (the customer has to
  // authenticate). Before this, a Deal whose card had failed read
  // "active_plan" on the strength of money collected months earlier --
  // hasCurrentPlan asked only whether a plan existed, never whether it was
  // working. Harmless while every plan was set up by hand in the Stripe
  // dashboard; not harmless once a deposit's whole premise is that the
  // client leaves and the balance is charged off-session.
  | "payment_failed"
  // Deposits slice: the deposit is in, a balance is still owed, and nothing
  // is scheduled to collect it yet. The ordinary state of a Living Example
  // client between paying and Leif stating their start week.
  //
  // It used to read "active_plan", on the strength of money having been
  // collected -- which is exactly the claim that must not be made, because
  // there is no plan. paymentSetupComplete was already correctly false; this
  // makes the NAME true as well, so no surface can report a complete
  // financial arrangement from a deposit alone.
  | "deposit_paid"
  | "setup_pending"
  | "needs_review"
  | "unknown";

/**
 * What Stripe says about the plan that is supposed to be collecting.
 *
 * Read from the status the reconciler ALREADY stores on
 * deal_stripe_plan_objects -- no new financial column. "unknown" means
 * there is no current plan to have a health, which is not the same as
 * healthy.
 */
export type PlanHealth = "healthy" | "past_due" | "action_required" | "unknown";

/** Stripe's own vocabulary for a subscription that is not collecting. */
const FAILING_STATUSES = new Set(["past_due", "unpaid"]);
const AUTHENTICATION_STATUSES = new Set(["incomplete", "incomplete_expired"]);

export type PaymentReviewCode =
  | "terms_unknown"
  | "evidence_incomplete"
  | "collected_exceeds_agreed"
  | "duplicate_economic_payment"
  | "identity_unresolved"
  | "owner_flagged"
  // A start-month change that could not be applied because the remaining
  // balance had already begun collecting. Raised by
  // flag_balance_schedule_frozen() and closed only by a person.
  | "balance_schedule_frozen";

export type PaymentTruth = {
  // --- what was agreed -------------------------------------------------
  agreedTotal: number | null;
  agreedInstallmentCount: number | null;
  agreedInstallmentAmount: number | null;
  termsKnown: boolean;

  // --- what actually happened -----------------------------------------
  collected: number;
  // Obligations still ahead: scheduled rows no payment has discharged.
  futureScheduled: number;
  // Null when terms are unknown, because "remaining" would be a guess.
  remaining: number | null;

  // --- progress --------------------------------------------------------
  installmentsSatisfied: number | null;
  installmentProgressKnown: boolean;

  // --- the arrangement -------------------------------------------------
  hasCurrentPlan: boolean;
  // Leif has stated an arrangement exists OUTSIDE this CRM — a plan she made
  // in the Stripe dashboard, a transfer schedule, an invoice, anything. A
  // derived subfact rather than a state of its own, because it answers a
  // different question from "is there a live plan here": both make setup
  // complete, and neither is money. Surfaces exist to tell them apart —
  // saying "Scheduled payment plan" for this one describes an arrangement
  // the CRM has never seen.
  setupConfirmedElsewhere: boolean;
  planReplaced: boolean;
  stripeLinked: boolean;

  // --- the deposit -----------------------------------------------------
  /** What was agreed as payable up front. Null when no deposit was agreed. */
  depositAgreed: number | null;
  /** Satisfied by money, in cents, never by a Checkout having been opened. */
  depositPaid: boolean;

  // --- is the plan actually working ------------------------------------
  planHealth: PlanHealth;

  // --- verdicts --------------------------------------------------------
  paidInFull: boolean;
  paymentSetupComplete: boolean;
  state: PaymentState;
  reviewCode: PaymentReviewCode | null;
  reviewReason: string | null;
};

// Money compares in cents. Floating point on decimal currency is how a
// $700.00 payment against a $700 agreement fails to be paid in full.
export const CENTS = (value: number): number => Math.round(value * 100);
// Half a cent, so arithmetic noise never decides a verdict.
export const TOLERANCE = 0.5;

const number = (value: unknown): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const assessPaymentTruth = ({
  deal,
  scheduleItems,
  planObjects,
}: {
  deal: Pick<
    Deal,
    | "id"
    | "stage"
    | "selected_payment_total"
    | "selected_installment_count"
    | "selected_installment_amount"
    | "selected_deposit_amount"
    | "stripe_subscription_id"
    | "stripe_subscription_schedule_id"
    | "payment_review_reason"
  > &
    Partial<Pick<Deal, "payment_review_code" | "payment_setup_confirmed_at">>;
  scheduleItems: DealPaymentScheduleItem[];
  planObjects: DealStripePlanObject[];
}): PaymentTruth => {
  // --- agreed ----------------------------------------------------------
  const agreedTotal = number(deal.selected_payment_total);
  const agreedInstallmentCount = number(deal.selected_installment_count);
  const agreedInstallmentAmount = number(deal.selected_installment_amount);
  const termsKnown = agreedTotal != null && CENTS(agreedTotal) > 0;

  // --- money -----------------------------------------------------------
  const paid = scheduleItems.filter((item) => item.status === "paid");
  const collectedCents = paid.reduce(
    (sum, item) => sum + CENTS(Number(item.amount ?? 0)),
    0,
  );
  const collected = collectedCents / 100;

  // A scheduled obligation a payment has already discharged is history,
  // not a future commitment.
  const futureScheduledCents = scheduleItems
    .filter(
      (item) =>
        item.status === "scheduled" &&
        item.satisfied_by_payment_intent_id == null,
    )
    .reduce((sum, item) => sum + CENTS(Number(item.amount ?? 0)), 0);
  const futureScheduled = futureScheduledCents / 100;

  const remaining = termsKnown
    ? Math.max(CENTS(agreedTotal!) - collectedCents, 0) / 100
    : null;

  // --- progress --------------------------------------------------------
  const installmentAmountCents =
    agreedInstallmentAmount != null ? CENTS(agreedInstallmentAmount) : 0;
  const installmentProgressKnown =
    installmentAmountCents > 0 && (agreedInstallmentCount ?? 0) > 0;
  const installmentsSatisfied = installmentProgressKnown
    ? Math.min(
        agreedInstallmentCount!,
        // Floored, never rounded: a part-paid installment is not paid.
        Math.floor((collectedCents + TOLERANCE) / installmentAmountCents),
      )
    : null;

  // --- the deposit -----------------------------------------------------
  const depositAgreed = number(deal.selected_deposit_amount);
  const depositCents = depositAgreed == null ? 0 : CENTS(depositAgreed);
  // Money, in cents, and nothing else. A Checkout that was opened proves
  // nothing; a deposit is paid when a receipt says so. A client who paid
  // the whole total up front has also satisfied it, which is true.
  const depositPaid =
    depositCents > 0 && collectedCents + TOLERANCE >= depositCents;

  // --- arrangement -----------------------------------------------------
  const hasCurrentPlan =
    planObjects.some((object) => object.is_current) ||
    Boolean(
      deal.stripe_subscription_id || deal.stripe_subscription_schedule_id,
    );
  // Health, from the status Stripe owns and the reconciler already writes.
  const currentPlans = planObjects.filter((object) => object.is_current);
  const planHealth: PlanHealth = !currentPlans.length
    ? "unknown"
    : currentPlans.some((object) =>
          AUTHENTICATION_STATUSES.has(String(object.status ?? "")),
        )
      ? "action_required"
      : currentPlans.some((object) =>
            FAILING_STATUSES.has(String(object.status ?? "")),
          )
        ? "past_due"
        : "healthy";

  const planReplaced =
    planObjects.filter((object) => object.object_type === "subscription")
      .length > 1;
  const stripeLinked =
    hasCurrentPlan ||
    planObjects.length > 0 ||
    paid.some(
      (item) =>
        item.source === "stripe" || item.stripe_payment_intent_id != null,
    );

  // --- verdicts --------------------------------------------------------
  const paidInFull =
    termsKnown && collectedCents + TOLERANCE >= CENTS(agreedTotal!);

  // Setup is about whether an arrangement EXISTS, never about how much has
  // been collected under it. A six-month plan with five payments to come is
  // set up. A single historical payment with no live plan is not.
  const ownerConfirmedSetup = deal.payment_setup_confirmed_at != null;
  const paymentSetupComplete =
    paidInFull || hasCurrentPlan || ownerConfirmedSetup;

  const storedReason = deal.payment_review_reason ?? null;
  const storedCode = (deal.payment_review_code ??
    null) as PaymentReviewCode | null;

  // A sold Opportunity whose terms nobody recorded cannot be described.
  // Saying "setup pending" there would be a claim; saying the list price
  // would be a different person's number.
  const termsMissingOnSale =
    deal.stage === "won" && !termsKnown && storedReason == null;

  const reviewCode: PaymentReviewCode | null = termsMissingOnSale
    ? "terms_unknown"
    : storedCode;
  const reviewReason = termsMissingOnSale
    ? "No agreed total is recorded for this Opportunity."
    : storedReason;

  // A plan that is not collecting is the most important thing true about
  // this Deal, short of the money being fully in. It must outrank
  // "active_plan": money collected in the past is exactly what used to
  // hide a card that had since failed.
  const base: PaymentState = paidInFull
    ? "paid_in_full"
    : planHealth === "past_due" || planHealth === "action_required"
      ? "payment_failed"
      : depositPaid && !hasCurrentPlan && !ownerConfirmedSetup
        ? "deposit_paid"
        : collectedCents > 0
          ? "active_plan"
          : hasCurrentPlan || ownerConfirmedSetup
            ? "scheduled_plan"
            : deal.stage === "won"
              ? "setup_pending"
              : "unknown";

  // A review outranks everything except money that fully reconciles
  // against known terms — the one conclusion an open question cannot
  // undo.
  const state: PaymentState =
    (reviewCode != null || reviewReason != null) && !paidInFull
      ? "needs_review"
      : base;

  return {
    agreedTotal,
    agreedInstallmentCount,
    agreedInstallmentAmount,
    termsKnown,
    collected,
    futureScheduled,
    remaining,
    installmentsSatisfied,
    installmentProgressKnown,
    hasCurrentPlan,
    setupConfirmedElsewhere: ownerConfirmedSetup,
    planReplaced,
    stripeLinked,
    depositAgreed,
    depositPaid,
    planHealth,
    paidInFull,
    paymentSetupComplete,
    state,
    reviewCode,
    reviewReason,
  };
};
