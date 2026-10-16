import type Stripe from "npm:stripe@18.5.0";

import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

// THE REMAINING BALANCE, SCHEDULED FOR THE FIRST OF THE PROGRAMME START MONTH.
//
// One mechanism for both shapes. Pay-in-full is a Subscription Schedule with
// ONE iteration; an instalment plan is the same Schedule with N. A future
// PaymentIntent or a draft invoice would have been a second object type with
// its own creation, its own idempotency and its own failure path, and
// deal_stripe_plan_objects has no row for it — while a Schedule is already
// modelled, already reconciled, already ends itself with
// end_behavior: 'cancel', and production already holds six rows of
// schedule / not_started / is_current.
//
// WHAT DECIDES AND WHAT EXECUTES. plan_balance_schedule() in Postgres decides:
// the exact cents, the anchor, and whether it is safe at all. It refuses
// rather than repairs — a start month that has already gone raises a review
// Task instead of backdating a charge. This function only executes a decision
// it is handed, and it never computes money of its own.
//
// UNEVEN PLANS ARE PHASES. A Schedule charges one price per phase, so
// $3,496 over six is 4 × $582.67 then 2 × $582.66 — two phases, exact to the
// cent. It is never collapsed into one inexact recurring price.

export type BalanceScheduleResult =
  | { status: "created"; scheduleId: string; phases: number }
  | { status: "updated"; scheduleId: string; phases: number }
  | { status: "unchanged"; scheduleId: string }
  | { status: "no-payment-method" }
  | { status: "stripe-not-configured" }
  // Everything plan_balance_schedule() can answer that is not "ready".
  | { status: string; detail: Record<string, unknown> };

type PlanPhase = { iterations: number; amount_cents: number };

type PlanDecision = {
  status: string;
  opportunity_id?: number;
  contact_id?: number;
  balance_cents?: number;
  installments?: number;
  balance_start_date?: string;
  phases?: PlanPhase[];
  existing_schedule_id?: string | null;
};

/** Midnight UTC on the anchor day, which is what Stripe takes. */
const anchorToUnix = (isoDate: string): number =>
  Math.floor(new Date(`${isoDate}T00:00:00Z`).getTime() / 1000);

/**
 * The card the deposit saved.
 *
 * A Schedule with no default payment method falls back to the Customer's,
 * and if there is none the first invoice simply fails. So this refuses
 * rather than creating a schedule that cannot collect — the deposit's whole
 * purpose was to leave a usable card behind.
 */
const resolveDefaultPaymentMethod = async (
  stripe: Stripe,
  customerId: string,
): Promise<string | null> => {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return null;
  const invoiceDefault = customer.invoice_settings?.default_payment_method;
  if (invoiceDefault) {
    return typeof invoiceDefault === "string"
      ? invoiceDefault
      : invoiceDefault.id;
  }
  // Saved by the deposit's setup_future_usage: off_session.
  const methods = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 1,
  });
  return methods.data[0]?.id ?? null;
};

/** One Stripe Price per distinct instalment amount, reused across runs. */
const priceForAmount = async (
  stripe: Stripe,
  {
    amountCents,
    currency,
    productName,
  }: { amountCents: number; currency: string; productName: string },
): Promise<string> => {
  const price = await stripe.prices.create({
    currency,
    unit_amount: amountCents,
    recurring: { interval: "month" },
    product_data: { name: productName },
  });
  return price.id;
};

/**
 * Create or re-anchor the balance schedule for one Opportunity.
 *
 * Idempotent in the way this codebase already trusts: the CRM-side id
 * (deals.stripe_subscription_schedule_id) plus a LIVE read of the Stripe
 * object, exactly as ensureInstallmentScheduleConfigured() does. A repeated
 * webhook, a repeated start-week save, a concurrent reconciler run and a
 * retried delivery all converge on one schedule.
 */
export const ensureBalanceSchedule = async (
  stripe: Stripe | null,
  opportunityId: number,
  { currency = "usd" }: { currency?: string } = {},
): Promise<BalanceScheduleResult> => {
  const { data: decisionData, error } = await supabaseAdmin.rpc(
    "plan_balance_schedule",
    { p_opportunity_id: opportunityId },
  );
  if (error) throw new Error(error.message);
  const decision = (decisionData ?? {}) as PlanDecision;

  // Not ready is not a failure. "start-date-unknown" is the ordinary state
  // of a Living Example client between the deposit and Leif stating the
  // start week, and "balance-start-requires-review" has already raised its
  // own Task.
  if (decision.status !== "ready") {
    return {
      status: decision.status,
      detail: decision as unknown as Record<string, unknown>,
    };
  }
  if (!stripe) return { status: "stripe-not-configured" };

  const phases = decision.phases ?? [];
  const anchor = decision.balance_start_date!;
  const startDate = anchorToUnix(anchor);

  const { data: contactRow } = await supabaseAdmin
    .from("contacts")
    .select("stripe_customer_id")
    .eq("id", decision.contact_id!)
    .maybeSingle();
  const customerId = (
    contactRow as { stripe_customer_id: string | null } | null
  )?.stripe_customer_id;
  if (!customerId) return { status: "no-payment-method" };

  const paymentMethodId = await resolveDefaultPaymentMethod(stripe, customerId);
  if (!paymentMethodId) return { status: "no-payment-method" };

  const { data: dealRow } = await supabaseAdmin
    .from("deals")
    .select("stripe_subscription_schedule_id, offer_name_snapshot")
    .eq("id", opportunityId)
    .maybeSingle();
  const deal = dealRow as {
    stripe_subscription_schedule_id: string | null;
    offer_name_snapshot: string | null;
  } | null;
  const productName = `${deal?.offer_name_snapshot ?? "Programme"} — balance`;

  const buildPhases = async () => {
    const built = [];
    for (const phase of phases) {
      const priceId = await priceForAmount(stripe, {
        amountCents: phase.amount_cents,
        currency,
        productName,
      });
      built.push({
        items: [{ price: priceId, quantity: 1 }],
        iterations: phase.iterations,
        proration_behavior: "none" as const,
      });
    }
    return built;
  };

  const existingId = deal?.stripe_subscription_schedule_id ?? null;

  if (existingId) {
    const existing = await stripe.subscriptionSchedules.retrieve(existingId);

    // Already charging, or finished. This is the refusal
    // plan_balance_schedule() also makes from the CRM side; asserting it
    // against LIVE Stripe state too is what makes a concurrent run safe.
    if (existing.status !== "not_started") {
      return {
        status: "balance-already-started",
        detail: { scheduleId: existingId, stripeStatus: existing.status },
      };
    }

    // Already anchored where it should be: a repeated save is a no-op, not
    // a second schedule and not a pointless rewrite.
    const firstPhaseStart = existing.phases[0]?.start_date;
    if (firstPhaseStart === startDate) {
      return { status: "unchanged", scheduleId: existingId };
    }

    await stripe.subscriptionSchedules.update(existingId, {
      end_behavior: "cancel",
      start_date: startDate,
      default_settings: { default_payment_method: paymentMethodId },
      phases: await buildPhases(),
    });
    return {
      status: "updated",
      scheduleId: existingId,
      phases: phases.length,
    };
  }

  const created = await stripe.subscriptionSchedules.create(
    {
      customer: customerId,
      start_date: startDate,
      end_behavior: "cancel",
      default_settings: { default_payment_method: paymentMethodId },
      phases: await buildPhases(),
    },
    {
      // The second guard against a duplicate: two concurrent runs for the
      // same Opportunity and the same anchor are the SAME request as far as
      // Stripe is concerned, so the second returns the first one's object
      // rather than making another.
      idempotencyKey: `balance-schedule:${opportunityId}:${anchor}`,
    },
  );

  await supabaseAdmin
    .from("deals")
    .update({ stripe_subscription_schedule_id: created.id })
    .eq("id", opportunityId);

  return { status: "created", scheduleId: created.id, phases: phases.length };
};
