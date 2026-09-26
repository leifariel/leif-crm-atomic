import type { DataProvider, Identifier } from "ra-core";

import type { PublicOfferPageContext } from "./publicOfferPageContext";
import { getOfferPageContext } from "./publicOfferPageContext";
import { recordOfferPageOpened } from "./recordOfferPageOpened";
import { resolveAuthorizedCheckoutTerms } from "./resolveAuthorizedCheckoutTerms";
import { recordDealPaymentSucceeded } from "./recordDealPaymentSucceeded";

export type CreateCheckoutResult =
  | { status: "created"; url: string }
  | { status: "not-found" }
  // Payment cannot be taken here, and why — replaced "already-won", which
  // refused every sold client on the strength of the stage alone.
  | { status: "payment-not-available" }
  | { status: "unauthorized-option" }
  | { status: "error" };

// The boundary the public Offer Page actually depends on — same dual-
// implementation convention as public-application/
// publicApplicationDataSource.ts: a FakeRest/dev implementation (reads go
// straight through the shared dataProvider) and a production one
// (supabase/publicOfferPageDataSource.ts, calling stripe_checkout — a real
// Stripe Checkout Session, since every table's RLS is `to authenticated`
// only and Stripe itself is server-side only). Each app entry picks the
// one that matches its own environment — the page component never knows
// which one it got.
//
// createCheckout's dev/demo implementation has no real Stripe to redirect
// to, so it completes the Deal directly through the same fulfillment path
// a real webhook would eventually reach — an honest demo (the click really
// does something), not a fake Stripe illusion.
export type PublicOfferPageDataSource = {
  getContext: (token: string) => Promise<PublicOfferPageContext>;
  recordOpened: (token: string) => Promise<void>;
  createCheckout: (
    token: string,
    paymentOptionId: Identifier,
  ) => Promise<CreateCheckoutResult>;
};

export const createDataProviderPublicOfferPageDataSource = (
  dataProvider: DataProvider,
): PublicOfferPageDataSource => ({
  getContext: (token) => getOfferPageContext(dataProvider, token),
  recordOpened: async (token) => {
    const deal = await findDealByToken(dataProvider, token);
    if (deal) await recordOfferPageOpened(dataProvider, deal.id);
  },
  createCheckout: async (token, paymentOptionId) => {
    const terms = await resolveAuthorizedCheckoutTerms(dataProvider, {
      token,
      paymentOptionId,
    });
    if (terms.status === "payment-not-available") {
      return { status: "payment-not-available" };
    }
    if (terms.status !== "authorized") {
      return { status: terms.status };
    }
    // The sale first, when it has not happened yet. For a client sold to
    // BEFORE paying — the ordinary case since Won became a sales fact —
    // this is already Won and correctly does nothing.
    const result = await recordDealPaymentSucceeded(
      dataProvider,
      terms.dealId,
      { paymentOptionId: terms.paymentOptionId },
    );
    if (result.status !== "won" && result.status !== "already-won") {
      return { status: "error" };
    }
    // Then the money. Production learns this from Stripe (the webhook links
    // the objects, the reconciler writes the ledger); the demo has no
    // Stripe, so it records the same first charge itself rather than
    // leaving a click that visibly does nothing. Fabricated demo money,
    // deliberately marked as such.
    await recordDemoPaymentReceived(dataProvider, terms);
    return { status: "created", url: `#/offer/${token}?checkout=success` };
  },
});

// Demo-only. The one charge a real Checkout would take right now: the whole
// total for a single payment, the first installment for a plan. Marked
// `source: "stripe"` with an obviously synthetic intent id, because the
// ledger's own constraint requires stripe-sourced money to name its intent
// — and because nothing should read this row as owner-stated truth.
const recordDemoPaymentReceived = async (
  dataProvider: DataProvider,
  terms: { dealId: Identifier; installments: number; unitAmountCents: number },
) => {
  const { data: existing } = await dataProvider.getList(
    "deal_payment_schedule_items",
    {
      filter: { deal_id: terms.dealId },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "sequence", order: "ASC" },
    },
  );
  // A second click must not invent a second payment.
  if (existing.some((item) => item.status === "paid")) return;

  await dataProvider.create("deal_payment_schedule_items", {
    data: {
      deal_id: terms.dealId,
      sequence: existing.length + 1,
      amount: terms.unitAmountCents / 100,
      status: "paid",
      paid_on: new Date().toISOString().slice(0, 10),
      source: "stripe",
      stripe_payment_intent_id: `pi_demo_${terms.dealId}_1`,
      notes: "Demo checkout — no real payment was taken.",
    },
  });

  if (terms.installments > 1) {
    // A plan now exists, which is what stops the page offering a second
    // checkout. Production gets this from the real subscription.
    await dataProvider.update("deals", {
      id: terms.dealId,
      data: { stripe_subscription_id: `sub_demo_${terms.dealId}` },
      previousData: { id: terms.dealId },
    });
  }
};

const findDealByToken = async (dataProvider: DataProvider, token: string) => {
  const { data: deals } = await dataProvider.getList("deals", {
    filter: { offer_page_token: token },
    pagination: { page: 1, perPage: 1 },
    sort: { field: "id", order: "ASC" },
  });
  return deals[0] ?? null;
};
