// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// THE STRIPE PARAMETERS A DEPOSIT DEPENDS ON.
//
// There is no Stripe account in any test environment here, so the three
// facts that decide whether a deposit can work at all are asserted against
// the source that sends them. Each one is load-bearing and each one is
// silent when wrong:
//
//   L  the deposit is a one-off `payment`, never a subscription
//   M  setup_future_usage: "off_session" -- WITHOUT IT the card is not
//      reusable and the balance can never be charged. Nothing fails at
//      deposit time; the failure arrives months later as a schedule that
//      cannot collect.
//   N  a Session that was created but not paid advances nothing
//
// Behaviour that a database CAN answer lives in
// e2e/depositsAndTheBalance.spec.ts.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relative: string) =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const CHECKOUT = read("supabase/functions/stripe_checkout/index.ts");
const WEBHOOK = read("supabase/functions/stripe_webhook/index.ts");
const SCHEDULE = read("supabase/functions/stripe_webhook/balanceSchedule.ts");

describe("L. a deposit is a one-off payment", () => {
  it("mode is subscription only when there is no deposit", () => {
    // `!isDeposit &&` is the whole guarantee: a deposit on a 4-pay option
    // must still be ONE charge, not the first of four.
    expect(CHECKOUT).toContain(
      "const isSubscription = !isDeposit && option.installments > 1;",
    );
    expect(CHECKOUT).toContain(
      'mode: isSubscription ? "subscription" : "payment"',
    );
  });

  it("the amount charged is the deposit, resolved server-side", () => {
    expect(CHECKOUT).toContain("const unitAmount = isDeposit");
    expect(CHECKOUT).toContain("? depositCents");
    // From the Deal's or the option's own figure -- never from the request.
    expect(CHECKOUT).toContain("option.deposit_amount == null");
    expect(CHECKOUT).toContain("Math.round(option.deposit_amount * 100)");
    // The browser sends an option id and a token, and nothing else that
    // decides money.
    expect(CHECKOUT).not.toMatch(/body\.(amount|total|deposit)/);
  });

  it("and it refuses a deposit larger than the total before reaching Stripe", () => {
    const from = CHECKOUT.indexOf("const isDeposit = depositCents > 0;");
    const reachesStripe = CHECKOUT.indexOf("const stripe = getStripe();");
    const guard = CHECKOUT.indexOf(
      "if (isDeposit && depositCents > Math.round(option.total * 100))",
    );
    expect(from).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(from);
    expect(guard).toBeLessThan(reachesStripe);
  });
});

describe("M. the card is kept for the balance", () => {
  it("setup_future_usage is off_session, and only for a deposit", () => {
    expect(CHECKOUT).toContain('setup_future_usage: "off_session" as const');
    // Guarded by isDeposit: a one-off full payment has no later charge to
    // make, and saving a card nobody will use is not ours to do.
    const from = CHECKOUT.indexOf("setup_future_usage");
    const window = CHECKOUT.slice(from - 400, from);
    expect(window).toContain("...(isDeposit");
  });

  it("and the schedule refuses to exist without one", () => {
    // A Schedule with no usable payment method is a schedule that cannot
    // collect. Better to report it than to create it.
    expect(SCHEDULE).toContain('return { status: "no-payment-method" }');
    expect(SCHEDULE).toContain("resolveDefaultPaymentMethod");
    expect(SCHEDULE).toContain("default_payment_method: paymentMethodId");
  });
});

describe("N. a Session is not a payment", () => {
  it("creating one records only the session id", () => {
    const from = CHECKOUT.indexOf("stripe_checkout_session_id");
    expect(from).toBeGreaterThan(-1);
    const update = CHECKOUT.slice(from - 300, from + 200);
    // Nothing about Won, the deposit snapshot, or money.
    expect(update).not.toContain("stage");
    expect(update).not.toContain("selected_deposit_amount");
  });

  it("and the webhook refuses an unpaid Session outright", () => {
    expect(WEBHOOK).toContain('if (session.payment_status === "unpaid")');
    const from = WEBHOOK.indexOf('if (session.payment_status === "unpaid")');
    const body = WEBHOOK.slice(from, from + 400);
    expect(body).toContain('status: "not-paid"');
    // The refusal comes before anything is written.
    expect(from).toBeLessThan(
      WEBHOOK.indexOf("recordDealPaymentSucceeded(deal"),
    );
  });

  it("the deposit snapshot is frozen from the Session's own metadata, not the amount", () => {
    // $500 is a deposit on The Living Example and could be an instalment on
    // something else, so the amount can never identify the charge.
    expect(CHECKOUT).toContain(
      'charge_kind: isDeposit ? "deposit" : "programme_payment"',
    );
    expect(WEBHOOK).toContain('session.metadata?.charge_kind === "deposit"');
    expect(WEBHOOK).toContain("session.metadata?.deposit_cents");
    expect(WEBHOOK).toContain("selected_deposit_amount: depositCents / 100");
  });
});

describe("the balance schedule is one mechanism, idempotent, and finite", () => {
  it("pay-in-full and instalments both use a Subscription Schedule", () => {
    // No second architecture for one iteration.
    expect(SCHEDULE).toContain("stripe.subscriptionSchedules.create");
    expect(SCHEDULE).not.toContain("invoiceItems.create");
    expect(SCHEDULE).not.toContain("paymentIntents.create");
  });

  it("it ends itself", () => {
    expect(SCHEDULE).toContain('end_behavior: "cancel"');
  });

  it("it reads the stored id AND live Stripe state before creating anything", () => {
    expect(SCHEDULE).toContain("deal?.stripe_subscription_schedule_id");
    expect(SCHEDULE).toContain("stripe.subscriptionSchedules.retrieve");
    expect(SCHEDULE).toContain('existing.status !== "not_started"');
    // Already anchored where it should be -> no-op, not a rewrite.
    expect(SCHEDULE).toContain("firstPhaseStart === startDate");
    expect(SCHEDULE).toContain('return { status: "unchanged"');
  });

  it("and carries a Stripe idempotency key derived from the Deal and the anchor", () => {
    // Two concurrent runs for the same Opportunity and the same first-of-
    // month are the SAME request as far as Stripe is concerned.
    expect(SCHEDULE).toContain(
      "idempotencyKey: `balance-schedule:${opportunityId}:${anchor}`",
    );
  });

  it("it computes no money of its own", () => {
    // Every cent comes from plan_balance_schedule(). A second division here
    // is how two authorities start disagreeing.
    expect(SCHEDULE).toContain(
      'supabaseAdmin.rpc(\n    "plan_balance_schedule"',
    );
    expect(SCHEDULE).not.toMatch(/\/\s*installments/);
    expect(SCHEDULE).not.toContain("allocateBalance");
  });
});

describe("a failed off-session charge is no longer a no-op", () => {
  it("the webhook handles both failure events", () => {
    expect(WEBHOOK).toContain('event.type === "invoice.payment_failed"');
    expect(WEBHOOK).toContain(
      'event.type === "invoice.payment_action_required"',
    );
  });

  it("and it re-reads Stripe rather than trusting the event", () => {
    const from = WEBHOOK.indexOf('event.type === "invoice.payment_failed"');
    const body = WEBHOOK.slice(from, from + 2000);
    expect(body).toContain("reconcileStripe(stripe, { contactId })");
    expect(body).toContain("reconcilePaymentHealth");
    // No payment truth is invented from an event payload.
    expect(body).not.toContain('status: "paid"');
  });

  it("the health reconciler is called wherever money has just moved", () => {
    // The deposit success path, the hourly sweep, and the balance endpoint.
    const calls = WEBHOOK.match(/reconcilePaymentHealth\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});
