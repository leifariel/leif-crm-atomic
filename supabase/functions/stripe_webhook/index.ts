// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17.4.0";
import { corsHeaders } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import {
  discoverStripeCustomers,
  linkStripeCustomer,
} from "./stripeDiscovery.ts";
import { investigateStripe } from "./stripeInvestigate.ts";
import { reconcileStripe } from "./stripeReconcile.ts";
import { ensureBalanceSchedule } from "./balanceSchedule.ts";
import { getAuthToken, verifySupabaseJWT } from "../_shared/authentication.ts";
import { handleOwnerStripeSync, type SalesRow } from "./ownerStripeSync.ts";

// Stripe test-mode integration slice: the real Stripe webhook endpoint.
// Signature verified via Stripe's own official library (constructEventAsync
// — Deno's crypto is async-only, so the sync constructEvent can't be used
// here). Every table's RLS is `to authenticated` only, so this uses
// supabaseAdmin server-side, same shape as acuity_webhook/index.ts.
//
// RECOVERABLE STATE MACHINE, not a happy-path sequence (Leif's own
// explicit requirement): every step below re-inspects authoritative
// Stripe + CRM state and only does what that state says is still missing.
// Safe to re-enter at ANY point — a retried/duplicate/concurrent delivery
// for the same event can land at any of these five states and always
// converges to the same end state without duplicating anything:
//   1. Checkout paid, no schedule yet (installment plans only)
//   2. Schedule created (from_subscription), future phase not configured
//   3. Schedule fully configured, CRM fulfillment not done
//   4. CRM already reached Won, webhook redelivered
//   5. An existing schedule/Won state is encountered mid-retry
// None of this needs a separate persisted state-machine/events-log table
// — the real Stripe objects (a schedule's own phase count) and the Deal's
// own existing fields (stage, stripe_subscription_schedule_id) already
// ARE the observable state, checked live every time.
//
// Business rules here MIRROR (do not share code with — Deno can't import
// from src/) src/components/atomic-crm/deals/recordDealPaymentSucceeded.ts
// (the Won/Enrollment fulfillment step) and the Architecture B schedule-
// adoption lifecycle approved 2026-09 (from_subscription, preserve the
// current phase unchanged, add a future phase with the remaining
// iterations, end_behavior: cancel). Keep in sync by hand if either
// changes.
//
// Deploy: `supabase secrets set STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=...`
// (test-mode values only). Register the endpoint in the Stripe Dashboard
// (Test mode -> Developers -> Webhooks) pointing at this function's real
// URL, subscribed to checkout.session.completed.
//
// Smoke-test locally with the Stripe CLI: `stripe listen --forward-to
// http://127.0.0.1:54321/functions/v1/stripe_webhook`, then trigger a real
// test event with `stripe trigger checkout.session.completed`.

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2025-08-27.basil",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

type DealRow = {
  id: number;
  stage: string;
  outcome: string | null;
  pricing_mode: string;
  selected_payment_option_id: number | null;
  stripe_subscription_id: string | null;
  stripe_subscription_schedule_id: string | null;
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

// A plan that is not collecting must say so, and a recovery must stop
// saying it. Reads the Stripe status the reconciler has just refreshed --
// no new financial column. Never allowed to fail a delivery: Stripe would
// retry a webhook whose real work already succeeded.
const reconcilePaymentHealth = async (opportunityId: number | null) => {
  try {
    await supabaseAdmin.rpc("reconcile_payment_health_tasks", {
      p_opportunity_id: opportunityId,
    });
  } catch (error) {
    console.error(
      "stripe_webhook: payment-health reconciliation failed:",
      error,
    );
  }
};
// THE RETRY, which is what makes the convergence rule true rather than
// aspirational.
//
// enrollments.start_date and the Stripe schedule cannot share a
// transaction. The date commits first and the schedule is a consequence,
// so the consequence can fail on its own: the browser never reached the
// Edge Function, the network dropped, Stripe errored, the card was not
// saved yet. Before this, every one of those left a committed client with a
// balance owed, a known start month and no schedule -- and nothing trying
// again.
//
// deals_awaiting_balance_schedule() states exactly premise C of
// reconcile_payment_health_tasks(), so the Deals retried here and the Deals
// that raise a check_payment Task are the same set by construction. Run
// before the health reconciliation below, so a schedule created now closes
// its own Task in the same pass.
const sweepPendingBalanceSchedules = async (
  stripe: Stripe | null,
): Promise<{ attempted: number; statuses: Record<string, number> }> => {
  const statuses: Record<string, number> = {};
  const count = (key: string) => {
    statuses[key] = (statuses[key] ?? 0) + 1;
  };
  const { data, error } = await supabaseAdmin.rpc(
    "deals_awaiting_balance_schedule",
  );
  if (error) {
    console.error("stripe_webhook: could not list pending balances:", error);
    return { attempted: 0, statuses };
  }
  const ids = ((data ?? []) as unknown[])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  for (const dealId of ids) {
    try {
      const result = await ensureBalanceSchedule(stripe, dealId);
      count(result.status);
    } catch (error) {
      // One client's provider error must not stop the rest of the sweep,
      // and must not fail the run: the condition still holds, so the next
      // hour tries again and the Task stays raised meanwhile.
      console.error(
        "stripe_webhook: balance sweep failed for deal " + dealId,
        error,
      );
      count("error");
    }
  }
  return { attempted: ids.length, statuses };
};

const fetchDeal = async (dealId: number): Promise<DealRow | null> => {
  const { data } = await supabaseAdmin
    .from("deals")
    .select(
      "id, stage, outcome, pricing_mode, selected_payment_option_id, stripe_subscription_id, stripe_subscription_schedule_id",
    )
    .eq("id", dealId)
    .maybeSingle();
  return (data as DealRow | null) ?? null;
};

// Mirrors recordDealPaymentSucceeded.ts exactly: idempotent-via-refetch,
// never overrides a Deal someone already explicitly exited, freezes the
// commercial snapshot to the actually-paid option exactly here (never
// earlier — see resolveAuthorizedCheckoutTerms.ts's own header for why),
// never creates the Enrollment itself (handle_deal_won() already does,
// see that file's own header for the full rationale).
const recordDealPaymentSucceeded = async (
  deal: DealRow,
  paymentOptionId: number | null,
): Promise<
  | { status: "won" }
  | { status: "already-won" }
  | { status: "outcome-conflict"; outcome: string }
> => {
  if (deal.stage === "won") return { status: "already-won" };
  if (deal.outcome != null) {
    return { status: "outcome-conflict", outcome: deal.outcome };
  }

  const needsOptionFreeze =
    paymentOptionId != null &&
    deal.selected_payment_option_id !== paymentOptionId;

  await supabaseAdmin
    .from("deals")
    .update({
      stage: "won",
      ...(needsOptionFreeze
        ? { selected_payment_option_id: paymentOptionId }
        : {}),
    })
    .eq("id", deal.id);

  return { status: "won" };
};

// Architecture B (approved 2026-09): adopts the Checkout-created
// Subscription under a Schedule preserving its already-paid current phase
// unchanged, then adds a future phase for the remaining N-1 iterations,
// then sets end_behavior to cancel. Every step re-checks live Stripe
// state first — never blindly creates a second schedule or appends a
// second future phase.
const ensureInstallmentScheduleConfigured = async (
  deal: DealRow,
  subscriptionId: string,
  totalInstallments: number,
): Promise<void> => {
  if (totalInstallments <= 1) return; // defensive: PIF never reaches here

  let scheduleId = deal.stripe_subscription_schedule_id;

  if (!scheduleId) {
    try {
      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: subscriptionId,
      });
      scheduleId = schedule.id;
    } catch (error) {
      // Lost a genuine race to a concurrent/duplicate delivery that
      // already adopted this subscription — Stripe sets the
      // subscription's own `schedule` field once one governs it, so
      // recover the id from there instead of failing.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const existingScheduleId =
        typeof subscription.schedule === "string"
          ? subscription.schedule
          : subscription.schedule?.id;
      if (!existingScheduleId) throw error;
      scheduleId = existingScheduleId;
    }

    await supabaseAdmin
      .from("deals")
      .update({ stripe_subscription_schedule_id: scheduleId })
      .eq("id", deal.id);
  }

  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  // Already configured (a prior delivery completed this step) — the
  // observable, live-Stripe signal this whole function trusts instead of
  // a separate CRM-side "is it done" flag.
  if (schedule.phases.length > 1 || schedule.end_behavior === "cancel") {
    return;
  }

  const currentPhase = schedule.phases[0];
  if (!currentPhase) return;

  await stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: "cancel",
    phases: [
      {
        // Preserved EXACTLY unchanged — Stripe's own documented pattern
        // for "keep this phase as-is" — never re-priced, never
        // re-dated, no proration.
        items: currentPhase.items.map((item) => ({
          price: typeof item.price === "string" ? item.price : item.price.id,
          quantity: item.quantity ?? 1,
        })),
        start_date: currentPhase.start_date,
        end_date: currentPhase.end_date,
        proration_behavior: "none",
      },
      {
        items: currentPhase.items.map((item) => ({
          price: typeof item.price === "string" ? item.price : item.price.id,
          quantity: item.quantity ?? 1,
        })),
        iterations: totalInstallments - 1,
        proration_behavior: "none",
      },
    ],
  });
};

const handleCheckoutSessionCompleted = async (
  eventSessionId: string,
): Promise<Response> => {
  // Authoritative re-fetch — never trust the event payload alone (Leif's
  // own explicit requirement) — mirrors public_application/offer_page's
  // own "read current state before acting" convention.
  const session = await stripe.checkout.sessions.retrieve(eventSessionId, {
    expand: ["subscription"],
  });

  if (session.payment_status === "unpaid") {
    // Checkout not actually completed successfully — a safe no-op
    // (matches "abandoned Checkout leaves Deal committed").
    return jsonResponse({ status: "not-paid" });
  }

  const dealId = Number(session.client_reference_id);
  if (!Number.isFinite(dealId)) {
    return jsonResponse({ status: "no-deal-reference" });
  }
  const deal = await fetchDeal(dealId);
  if (!deal) return jsonResponse({ status: "deal-not-found" });

  // Scholarship Pricing + Capacity slice: the BULLETPROOF half of the
  // stale-Checkout-Session invariant ("old commercial terms must not
  // remain payable after Leif changes pricing mode") — this re-validation
  // does not depend on the best-effort proactive invalidation
  // (stripe_invalidate_checkout) ever having run or succeeded. The Session
  // was priced against whatever pricing_mode was authoritative at
  // Checkout-creation time (stripe_checkout/index.ts stamps it into
  // metadata); if Leif has since changed this Deal's pricing_mode, this
  // Session's terms are stale and must NEVER silently become Won at the
  // old amount. Logged loudly (not silently dropped) — this is a genuine,
  // rare anomaly needing Leif's manual reconciliation (refund via the
  // Stripe dashboard + fix the Deal by hand), the same restraint this
  // codebase already applies to an outcome-conflict.
  const sessionPricingMode = session.metadata?.pricing_mode ?? null;
  if (sessionPricingMode != null && sessionPricingMode !== deal.pricing_mode) {
    console.error(
      `stripe_webhook: stale pricing_mode for deal ${deal.id} — session was priced as "${sessionPricingMode}", Deal is now "${deal.pricing_mode}". Refusing to mark Won; needs manual reconciliation.`,
    );
    return jsonResponse({
      status: "stale-pricing-mode-conflict",
      sessionPricingMode,
      dealPricingMode: deal.pricing_mode,
    });
  }

  const paymentOptionId = session.metadata?.payment_option_id
    ? Number(session.metadata.payment_option_id)
    : null;

  if (session.mode === "subscription" && session.subscription) {
    const subscription =
      typeof session.subscription === "string"
        ? await stripe.subscriptions.retrieve(session.subscription)
        : session.subscription;

    if (!deal.stripe_subscription_id) {
      await supabaseAdmin
        .from("deals")
        .update({ stripe_subscription_id: subscription.id })
        .eq("id", deal.id);
    }

    const totalInstallments = subscription.metadata?.total_installments
      ? Number(subscription.metadata.total_installments)
      : null;
    if (totalInstallments) {
      await ensureInstallmentScheduleConfigured(
        deal,
        subscription.id,
        totalInstallments,
      );
    }
  }

  // WAS THIS THE DEPOSIT? The Session says so durably, stamped server-side
  // by stripe_checkout from CRM state -- never inferred from the amount,
  // because $500 is a deposit on one programme and could be an instalment
  // on another.
  const isDeposit = session.metadata?.charge_kind === "deposit";
  const depositCents = session.metadata?.deposit_cents
    ? Number(session.metadata.deposit_cents)
    : null;

  // The Deal's own copy of the agreed deposit, frozen exactly here and for
  // the same reason selected_payment_option_id is: this is the moment the
  // agreement became real, and a later catalogue edit must not be able to
  // reinterpret it. Written before the sale lands so the balance planner
  // can see it as soon as the Enrollment exists.
  if (isDeposit && depositCents != null && Number.isFinite(depositCents)) {
    await supabaseAdmin
      .from("deals")
      .update({ selected_deposit_amount: depositCents / 100 })
      .eq("id", deal.id);
  }

  // The SALE. A no-op when the client was sold to before paying, which is
  // now the ordinary order of events.
  const result = await recordDealPaymentSucceeded(deal, paymentOptionId);

  // The MONEY, which is a different fact and must not depend on that
  // transition having done anything. Before this, a payment from an
  // already-Won client left the webhook after the "already-won" no-op and
  // the ledger stayed empty until the nightly sweep happened to run — the
  // same Won=Paid assumption one layer up: stage deciding whether payment
  // truth gets recorded. Reconciliation is idempotent and reads Stripe as
  // the authority, so running it here simply makes the truth land now.
  let payments: string;
  try {
    const delta = await reconcileStripe(stripe, { contactId: deal.contact_id });
    payments = `ingested:${delta.paymentsIngested} plans:${delta.planObjectsRecorded}`;
  } catch (error) {
    // Never fail the webhook over this: Stripe would retry a delivery whose
    // sale and plan steps already succeeded. The sweep and the Sync Stripe
    // button both remain, so the money is not lost — only late.
    console.error(
      `stripe_webhook: post-payment reconciliation failed for deal ${deal.id}:`,
      error,
    );
    payments = "deferred";
  }

  await reconcilePaymentHealth(deal.id);

  // THE BALANCE, if it can be known yet.
  //
  // Growing Yourself Up is a group offer, so handle_deal_won() has just
  // snapshotted the cohort start onto the Enrollment and the anchor already
  // exists -- the schedule is created here. The Living Example has no start
  // week until Leif states one, so plan_balance_schedule() answers
  // "start-date-unknown" and nothing is created. That is the expected
  // state, not a failure, and it is never papered over with an invented
  // date.
  let balance = "skipped";
  if (isDeposit) {
    try {
      const scheduled = await ensureBalanceSchedule(stripe, deal.id);
      balance = scheduled.status;
    } catch (error) {
      // Never fail the delivery: the deposit and the sale have already
      // landed, and the hourly reconcile-stripe job now genuinely sweeps
      // this again -- see sweepPendingBalanceSchedules(). This is the path
      // Growing Yourself Up depends on: its anchor exists at Won, so a
      // failure here is the only thing between a GYU deposit and its
      // schedule, and it must not need Leif to open a Start Week screen.
      console.error(
        "stripe_webhook: balance scheduling failed for deal " + deal.id,
        error,
      );
      balance = "deferred";
    }
  }

  return jsonResponse({ status: result.status, payments, balance });
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return createErrorResponse(405, "Method Not Allowed");
  }

  // Reconciliation shares this function because the Stripe credentials
  // already live here; a second Edge Function would mean two places to
  // rotate the same secret. It is NOT a webhook — nothing Stripe signed
  // sent it — so it authenticates with the same cron secret the Acuity
  // reconciliation and the calendar sync already use, and is checked
  // BEFORE the signature path so it is never mistaken for an unsigned
  // webhook.
  //
  //   ?action=reconcile              every known Stripe customer
  //   ?action=reconcile&contactId=N  one person, for the Sync Stripe button
  const url = new URL(req.url);

  // Read-only. Writes nothing, so it is safe to point at anybody while
  // working out what Stripe actually holds for them.
  if (url.searchParams.get("action") === "investigate") {
    const cronSecret = Deno.env.get("CRON_INVOKE_SECRET");
    if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
      return createErrorResponse(401, "Invalid cron invocation secret.");
    }
    const contactId = Number(url.searchParams.get("contactId"));
    if (!Number.isInteger(contactId) || contactId <= 0) {
      return createErrorResponse(400, "Invalid contact id.");
    }
    return jsonResponse(await investigateStripe(stripe, { contactId }));
  }

  // Discovery and linking. Both need a signed-in CRM user; neither is
  // reachable by the cron sweep, because proposing and confirming a
  // financial identity is a human act by design.
  const discoveryAction = url.searchParams.get("action");
  if (discoveryAction === "discover" || discoveryAction === "link_customer") {
    if (!Deno.env.get("STRIPE_SECRET_KEY")) {
      return createErrorResponse(503, "Stripe API key is not configured.");
    }
    const contactId = Number(url.searchParams.get("contactId"));
    if (!Number.isInteger(contactId) || contactId <= 0) {
      return createErrorResponse(400, "Invalid contact id.");
    }
    try {
      const isValidJWT = await verifySupabaseJWT(getAuthToken(req));
      if (!isValidJWT)
        return createErrorResponse(401, "Invalid authentication");
    } catch (e) {
      return createErrorResponse(401, e?.toString() || "Unauthorized");
    }

    if (discoveryAction === "discover") {
      return jsonResponse(await discoverStripeCustomers(stripe, { contactId }));
    }

    const stripeCustomerId = url.searchParams.get("customerId");
    // Stripe customer ids are "cus_" plus an opaque token; anything else
    // is not a customer and is refused rather than sent to Stripe.
    if (!stripeCustomerId || !/^cus_[A-Za-z0-9]+$/.test(stripeCustomerId)) {
      return createErrorResponse(400, "Invalid Stripe customer id.");
    }
    return jsonResponse(
      await linkStripeCustomer(stripe, { contactId, stripeCustomerId }),
    );
  }

  // "Sync Stripe" for the whole account, asked for from the Dashboard.
  //
  // A separate door from the cron sweep below, with its own lock. This one
  // does not accept the cron secret and the cron branch does not accept a
  // JWT, so adding a button did not make the cron endpoint reachable from
  // a browser. The browser asks; the server decides, by reading the
  // caller's own `sales` row with the service role. See ownerStripeSync.ts.
  if (url.searchParams.get("action") === "reconcile-all") {
    if (!Deno.env.get("STRIPE_SECRET_KEY")) {
      return createErrorResponse(503, "Stripe API key is not configured.");
    }
    return await handleOwnerStripeSync(req, {
      // The caller's identity, from a cryptographically verified token.
      //
      // This verifies against Supabase's published JWKS — the same
      // verifySupabaseJWT the two branches below already use, and the
      // reason they work in production. It deliberately does NOT build a
      // publishable-key client the way the user-management function does:
      // that pattern reads SB_PUBLISHABLE_KEY, which is set in the local
      // `supabase/functions/.env` and as a GitHub secret for the FRONTEND
      // build, but is never pushed to the deployed Edge Function
      // environment. Deno.env.get returns undefined there, the client is
      // built with an empty key, auth.getUser() fails, and every caller —
      // including the owner — is refused before the administrator check is
      // ever reached. That is exactly what happened to the Dashboard's
      // first Sync Stripe.
      //
      // The user id is the `sub` claim of the verified token, so it is as
      // trustworthy as the signature. Authority still comes from the
      // `sales` row read below with the service role, never from the token.
      authenticate: async (request) => {
        const { payload } = await verifySupabaseJWT(getAuthToken(request));
        return typeof payload.sub === "string" ? { id: payload.sub } : null;
      },
      // Service role, so `administrator` is what the database says rather
      // than what the caller claims.
      loadSale: async (userId) =>
        (
          await supabaseAdmin
            .from("sales")
            .select("administrator, disabled")
            .eq("user_id", userId)
            .single()
        ).data as SalesRow | null,
      // The same canonical sweep pg_cron runs — one implementation, one
      // set of payment semantics.
      reconcile: () => reconcileStripe(stripe),
    });
  }

  if (url.searchParams.get("action") === "reconcile") {
    if (!Deno.env.get("STRIPE_SECRET_KEY")) {
      return createErrorResponse(503, "Stripe API key is not configured.");
    }

    const contactParam = url.searchParams.get("contactId");

    // Two callers, two different authorities, and the narrower one is not
    // allowed to do the wider job.
    //
    //   the whole sweep  -> pg_cron only, with the cron secret. Nobody
    //     signed in from a browser gets to walk every Stripe customer.
    //   one person       -> a signed-in CRM user, verified by their own
    //     Supabase JWT. The browser never holds a Stripe key, and the only
    //     Stripe customers this can reach are the ones already verified as
    //     that Contact's in contact_stripe_customers — so it cannot be
    //     used to enumerate anything in the Stripe account, and a customer
    //     matched only by email address is not reachable at all.
    if (contactParam == null) {
      const cronSecret = Deno.env.get("CRON_INVOKE_SECRET");
      if (!cronSecret) {
        return createErrorResponse(
          503,
          "Cron invocation secret is not configured.",
        );
      }
      if (req.headers.get("x-cron-secret") !== cronSecret) {
        return createErrorResponse(401, "Invalid cron invocation secret.");
      }
      const delta = await reconcileStripe(stripe);
      // Both halves, and in this order. The sweep is the durable retry for
      // a balance whose schedule never got made; the reconciliation then
      // opens a Task for whatever is still unscheduled and closes the ones
      // the sweep has just settled. Neither ran on this path before, so an
      // hourly job that exists to converge payment truth was converging
      // only the money.
      const balances = await sweepPendingBalanceSchedules(stripe);
      await reconcilePaymentHealth(null);
      return jsonResponse({ status: "reconciled", delta, balances });
    }

    const contactId = Number(contactParam);
    if (!Number.isInteger(contactId) || contactId <= 0) {
      return createErrorResponse(400, "Invalid contact id.");
    }

    // A cron caller may also sync one person; otherwise a real signed-in
    // user is required.
    const cronSecret = Deno.env.get("CRON_INVOKE_SECRET");
    const isCron =
      Boolean(cronSecret) && req.headers.get("x-cron-secret") === cronSecret;
    if (!isCron) {
      try {
        const isValidJWT = await verifySupabaseJWT(getAuthToken(req));
        if (!isValidJWT)
          return createErrorResponse(401, "Invalid authentication");
      } catch (e) {
        return createErrorResponse(401, e?.toString() || "Unauthorized");
      }
    }

    const delta = await reconcileStripe(stripe, { contactId });
    const balances = await sweepPendingBalanceSchedules(stripe);
    await reconcilePaymentHealth(null);
    return jsonResponse({ status: "reconciled", delta, balances });
  }

  // THE BALANCE SCHEDULE, asked for by name.
  //
  // Called by the CRM right after Leif saves a start week, so the schedule
  // exists the moment the anchor does rather than up to an hour later; and
  // by the hourly sweep above as the durable backstop. Both converge on one
  // schedule, because ensureBalanceSchedule() reads the CRM id and the live
  // Stripe object before it creates anything.
  //
  // It computes no money: plan_balance_schedule() in Postgres decides the
  // cents, the anchor and whether it is safe at all, and this executes that
  // decision. A browser cannot reach that function (it is service-role
  // only), so a signed-in user asking here cannot assert an amount.
  if (url.searchParams.get("action") === "schedule-balance") {
    const dealId = Number(url.searchParams.get("dealId"));
    if (!Number.isInteger(dealId) || dealId <= 0) {
      return createErrorResponse(400, "Invalid opportunity id.");
    }

    const cronSecret = Deno.env.get("CRON_INVOKE_SECRET");
    const isCron =
      Boolean(cronSecret) && req.headers.get("x-cron-secret") === cronSecret;
    if (!isCron) {
      try {
        const isValidJWT = await verifySupabaseJWT(getAuthToken(req));
        if (!isValidJWT)
          return createErrorResponse(401, "Invalid authentication");
      } catch (e) {
        return createErrorResponse(401, e?.toString() || "Unauthorized");
      }
    }

    const scheduled = await ensureBalanceSchedule(
      Deno.env.get("STRIPE_SECRET_KEY") ? stripe : null,
      dealId,
    );

    // THE ONE OUTCOME THAT IS A DECISION RATHER THAN A CONDITION.
    //
    // A person asked to move a start month, and the balance had already
    // begun collecting, so re-anchoring would rewrite financial history and
    // the CRM refused. Nothing about the client's account is wrong, so no
    // reconciler can own it and recovery must never erase it: it goes to
    // deals.payment_review_reason, where a human closes it by hand.
    //
    // Gated on a person having asked. The hourly sweep reaching the same
    // Deal is not a start-date change, and the deposit webhook's own
    // attempt is not one either. The column makes a duplicate impossible
    // regardless.
    if (!isCron && scheduled.status === "balance-already-started") {
      const { error } = await supabaseAdmin.rpc(
        "flag_balance_schedule_frozen",
        { p_opportunity_id: dealId },
      );
      if (error) {
        console.error(
          "stripe_webhook: could not raise the balance-schedule review for deal " +
            dealId,
          error,
        );
      }
    }

    await reconcilePaymentHealth(dealId);
    return jsonResponse(scheduled);
  }

  const signature = req.headers.get("Stripe-Signature");
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    if (!signature) throw new Error("Missing Stripe-Signature header");
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
    );
  } catch (error) {
    console.error("stripe_webhook signature verification failed:", error);
    return createErrorResponse(
      400,
      `Webhook signature verification failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      return await handleCheckoutSessionCompleted(session.id);
    }

    // A SCHEDULED CHARGE THAT DID NOT GO THROUGH.
    //
    // These were explicit no-ops, which was survivable while every plan
    // was set up by hand in the Stripe dashboard and Leif watched it
    // there. A deposit changes that: the whole premise is that the client
    // leaves and the balance is charged off-session months later, so a
    // failed card has to become visible in the CRM by itself.
    //
    // Stripe owns the truth, so this does not interpret the event payload:
    // it re-reads the customer through the existing reconciler (which
    // refreshes the plan object's own status) and then reconciles the
    // Task. Payment truth is never invented from an event.
    if (
      event.type === "invoice.payment_failed" ||
      event.type === "invoice.payment_action_required"
    ) {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === "string"
          ? invoice.customer
          : (invoice.customer?.id ?? null);
      if (!customerId) {
        return jsonResponse({ status: "no-customer", type: event.type });
      }
      const { data: link } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      const contactId = (link as { id: number } | null)?.id ?? null;
      if (contactId != null) {
        try {
          await reconcileStripe(stripe, { contactId });
        } catch (error) {
          console.error(
            "stripe_webhook: reconciliation after a failed charge:",
            error,
          );
        }
      }
      // Null scopes it to every Opportunity, which is correct when the
      // Contact could not be identified: the condition is declarative, so
      // a wider sweep reaches the same answer.
      await reconcilePaymentHealth(null);
      return jsonResponse({
        status: "payment-health-reconciled",
        type: event.type,
        contactId,
      });
    }

    // Every other event type is a safe, explicit no-op — this function
    // only subscribes to checkout.session.completed in the Stripe
    // Dashboard, but acknowledging anything else Stripe might still send
    // avoids Stripe's own retry machinery treating an unhandled type as a
    // delivery failure.
    return jsonResponse({ status: "ignored", type: event.type });
  } catch (error) {
    console.error("stripe_webhook processing error:", error);
    return createErrorResponse(
      500,
      `Failed to process webhook: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
});
