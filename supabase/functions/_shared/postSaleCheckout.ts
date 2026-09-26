import { supabaseAdmin } from "./supabaseAdmin.ts";
import {
  assessCheckoutFacts,
  CENTS,
  type CheckoutAssessment,
} from "./postSaleCheckoutRules.ts";

// The database half of the post-sale checkout decision: loads the facts the
// pure rules in postSaleCheckoutRules.ts need, for both offer_page and
// stripe_checkout. Kept separate so those rules stay importable by the
// `functions` test project — this file reaches Deno/Supabase, that one
// reaches nothing.

// Every column the decision reads. Both functions select these, so a
// missing column cannot make one of them silently more permissive.
export const CHECKOUT_FACT_COLUMNS =
  "id, stage, pricing_mode, offer_price_snapshot, selected_payment_total, selected_payment_total_source, selected_installment_count, selected_installment_amount, stripe_subscription_id, stripe_subscription_schedule_id, payment_setup_confirmed_at";

export type CheckoutFactRow = {
  id: number;
  stage: string;
  pricing_mode: string | null;
  offer_price_snapshot: number | null;
  selected_payment_total_source: string | null;
  selected_payment_total: number | null;
  selected_installment_count: number | null;
  selected_installment_amount: number | null;
  stripe_subscription_id: string | null;
  stripe_subscription_schedule_id: string | null;
  payment_setup_confirmed_at: string | null;
};

type ScheduleItemRow = { amount: number | null; status: string | null };
type PlanObjectRow = { is_current: boolean | null };

export const assessCheckoutForDeal = async (
  deal: CheckoutFactRow,
): Promise<CheckoutAssessment> => {
  // Not sold: nothing to load — the catalog path never consults money.
  if (deal.stage !== "won") return assessCheckoutFacts(catalogFacts(deal));

  const { data: items } = await supabaseAdmin
    .from("deal_payment_schedule_items")
    .select("amount, status")
    .eq("deal_id", deal.id);
  const collectedCents = ((items ?? []) as ScheduleItemRow[])
    .filter((item) => item.status === "paid")
    .reduce((sum, item) => sum + CENTS(Number(item.amount ?? 0)), 0);

  const { data: plans } = await supabaseAdmin
    .from("deal_stripe_plan_objects")
    .select("is_current")
    .eq("deal_id", deal.id)
    .eq("is_current", true)
    .limit(1);

  return assessCheckoutFacts({
    stage: deal.stage,
    agreedTotal: numberOrNull(deal.selected_payment_total),
    agreedInstallmentCount: numberOrNull(deal.selected_installment_count),
    agreedInstallmentAmount: numberOrNull(deal.selected_installment_amount),
    pricingMode: deal.pricing_mode ?? null,
    scholarshipPrice: numberOrNull(deal.offer_price_snapshot),
    agreedTotalSource: deal.selected_payment_total_source ?? null,
    collectedCents,
    // A subscription or a schedule on the Deal is as much a live plan as a
    // recorded plan object — the reconciler may simply not have run yet.
    hasCurrentPlan:
      ((plans ?? []) as PlanObjectRow[]).length > 0 ||
      Boolean(deal.stripe_subscription_id) ||
      Boolean(deal.stripe_subscription_schedule_id),
    ownerConfirmedSetup: deal.payment_setup_confirmed_at != null,
  });
};

const catalogFacts = (deal: CheckoutFactRow) => ({
  stage: deal.stage,
  agreedTotal: numberOrNull(deal.selected_payment_total),
  agreedInstallmentCount: numberOrNull(deal.selected_installment_count),
  agreedInstallmentAmount: numberOrNull(deal.selected_installment_amount),
  pricingMode: deal.pricing_mode ?? null,
  scholarshipPrice: numberOrNull(deal.offer_price_snapshot),
  agreedTotalSource: deal.selected_payment_total_source ?? null,
  collectedCents: 0,
  hasCurrentPlan: false,
  ownerConfirmedSetup: false,
});

const numberOrNull = (value: unknown): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
