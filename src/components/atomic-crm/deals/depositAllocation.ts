import { CENTS } from "./paymentTruth";

/**
 * The deposit, the balance, and exactly how the balance divides.
 *
 * ALL OF IT IN INTEGER CENTS. Floating point on decimal currency is how a
 * $700.00 payment against a $700 agreement fails to be paid in full
 * (paymentTruth.ts's own note), and it is how six payments of $583.33 add
 * up to $3,499.98 instead of $3,500.
 *
 * WHY UNEVEN PLANS ARE NOW LEGAL. Until deposits, every plan in this CRM
 * had to satisfy `installment_amount × installments = total` exactly:
 * stripe_checkout rebuilds the charge and refuses `not-representable`
 * otherwise, and set_offer_payment_option() refuses to store such an
 * option at all. That rule existed to stop $4,000-in-3 charging $3,999.99
 * and reading "$0.01 remaining" forever, and it was right.
 *
 * A deposit breaks the arithmetic without breaking the agreement. The
 * Living Example's Financial Need option is $3,996 over six; take $500 off
 * and $3,496 does not divide by six at all. The old rule would have forced
 * a choice between distorting the agreed total and refusing the plan.
 * Neither is acceptable, so the plan is allowed to be uneven and the
 * UNEVENNESS IS MADE EXACT: the remainder is distributed one cent at a
 * time, earliest payments first, and the parts are proven to sum to the
 * balance to the cent.
 *
 * Leif's ruling, 2026-10-16: "Do not distort agreed_total merely to keep
 * every monthly charge identical."
 */

/** Consecutive installments charging the same amount — one Stripe phase. */
export type BalancePhase = {
  iterations: number;
  amountCents: number;
};

export type BalanceAllocation = {
  agreedTotalCents: number;
  depositCents: number;
  balanceCents: number;
  installments: number;
  /** Every installment's exact cents, in the order they will be charged. */
  perInstallmentCents: number[];
  /**
   * The same thing grouped for Stripe: a Subscription Schedule charges one
   * price per phase, so an uneven plan is two phases rather than one
   * inexact recurring price. Empty when the deposit covers the whole total.
   */
  phases: BalancePhase[];
};

export type AllocationRefusal =
  /** A deposit larger than the thing it is a deposit on. */
  | "deposit-exceeds-total"
  | "deposit-negative"
  | "total-not-positive"
  | "installments-invalid";

export type BalanceAllocationResult =
  | { status: "allocated"; allocation: BalanceAllocation }
  | { status: "refused"; reason: AllocationRefusal };

/**
 * Divide a balance into `installments` parts that sum to it EXACTLY.
 *
 * floor = balance div n, remainder = balance mod n. The first `remainder`
 * installments carry one extra cent. Earliest-first rather than
 * latest-first so the odd cents arrive sooner, which is the conservative
 * direction for the person owed the money — and it is deterministic, which
 * matters more: the same agreement must always produce the same schedule,
 * on the server, in the browser, and in a test.
 */
export const allocateBalanceCents = (
  balanceCents: number,
  installments: number,
): number[] => {
  const floor = Math.floor(balanceCents / installments);
  const remainder = balanceCents % installments;
  return Array.from({ length: installments }, (_, index) =>
    index < remainder ? floor + 1 : floor,
  );
};

/** Consecutive equal amounts collapsed into phases, order preserved. */
export const groupIntoPhases = (
  perInstallmentCents: readonly number[],
): BalancePhase[] => {
  const phases: BalancePhase[] = [];
  for (const amountCents of perInstallmentCents) {
    const last = phases.at(-1);
    if (last && last.amountCents === amountCents) last.iterations += 1;
    else phases.push({ iterations: 1, amountCents });
  }
  return phases;
};

/**
 * The whole arrangement, from the two numbers that are actually agreed.
 *
 * Takes CENTS, because every caller that has decimals should convert at
 * its own edge with CENTS() rather than passing floats through here.
 */
export const allocateBalanceFromCents = ({
  agreedTotalCents,
  depositCents,
  installments,
}: {
  agreedTotalCents: number;
  depositCents: number;
  installments: number;
}): BalanceAllocationResult => {
  if (!Number.isInteger(agreedTotalCents) || agreedTotalCents <= 0) {
    return { status: "refused", reason: "total-not-positive" };
  }
  if (!Number.isInteger(depositCents) || depositCents < 0) {
    return { status: "refused", reason: "deposit-negative" };
  }
  if (depositCents > agreedTotalCents) {
    return { status: "refused", reason: "deposit-exceeds-total" };
  }
  if (!Number.isInteger(installments) || installments < 1) {
    return { status: "refused", reason: "installments-invalid" };
  }

  const balanceCents = agreedTotalCents - depositCents;

  // A deposit that covers the whole agreement leaves nothing to schedule.
  // Not an error: it is the honest answer for a "deposit" set equal to the
  // total, and the caller must not then build a schedule for $0.
  if (balanceCents === 0) {
    return {
      status: "allocated",
      allocation: {
        agreedTotalCents,
        depositCents,
        balanceCents: 0,
        installments,
        perInstallmentCents: [],
        phases: [],
      },
    };
  }

  const perInstallmentCents = allocateBalanceCents(balanceCents, installments);

  // The property this module exists for, asserted rather than assumed. A
  // schedule that does not add up is worse than no schedule: it charges a
  // number nobody agreed to and leaves a balance nobody can clear.
  const sum = perInstallmentCents.reduce((total, part) => total + part, 0);
  if (sum !== balanceCents) {
    throw new Error(
      `balance allocation does not add up: ${sum} vs ${balanceCents}`,
    );
  }

  return {
    status: "allocated",
    allocation: {
      agreedTotalCents,
      depositCents,
      balanceCents,
      installments,
      perInstallmentCents,
      phases: groupIntoPhases(perInstallmentCents),
    },
  };
};

/**
 * The same, from the decimal money the catalogue and the Deal snapshot
 * actually store (`numeric(10,2)` arrives as a JS number).
 */
export const allocateBalance = ({
  agreedTotal,
  deposit,
  installments,
}: {
  agreedTotal: number | null | undefined;
  deposit: number | null | undefined;
  installments: number | null | undefined;
}): BalanceAllocationResult => {
  if (agreedTotal == null || !Number.isFinite(agreedTotal)) {
    return { status: "refused", reason: "total-not-positive" };
  }
  if (installments == null || !Number.isFinite(installments)) {
    return { status: "refused", reason: "installments-invalid" };
  }
  return allocateBalanceFromCents({
    agreedTotalCents: CENTS(agreedTotal),
    // A null deposit is no deposit, which is every option that existed
    // before this slice. It must keep behaving exactly as it did.
    depositCents: deposit == null ? 0 : CENTS(deposit),
    installments: Math.trunc(installments),
  });
};

/** `582.67` from `58267`, for display and for a numeric(10,2) write. */
export const centsToAmount = (cents: number): number => Math.round(cents) / 100;

/**
 * "4 × $582.67 then 2 × $582.66", or "4 × $875.00".
 *
 * One formatter, so the Offer Page, the owner's payment panel and the
 * schedule rows cannot describe the same plan differently.
 */
export const describePhases = (
  phases: readonly BalancePhase[],
  format: (amount: number) => string,
): string =>
  phases
    .map(
      (phase) =>
        `${phase.iterations} × ${format(centsToAmount(phase.amountCents))}`,
    )
    .join(" then ");
