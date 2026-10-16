// The Deno mirror of src/components/atomic-crm/deals/depositAllocation.ts.
//
// Edge Functions cannot import from src/, so this is the same
// dual-implementation convention as every other integration here --
// and contracts/deals/oneDepositAllocation.test.ts proves this file, the TS
// module and the SQL function allocate_balance_cents() all agree on every
// decided plan, rather than trusting that they do.
//
// INTEGER CENTS ONLY. floor = balance div n, remainder = balance mod n; the
// first "remainder" instalments carry one extra cent, earliest first.

export type BalancePhase = { iterations: number; amountCents: number };

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
