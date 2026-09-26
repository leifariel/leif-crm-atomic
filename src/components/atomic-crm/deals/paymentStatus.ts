import type { DataProvider, Identifier } from "ra-core";

import type {
  Deal,
  DealPaymentScheduleItem,
  DealStripePlanObject,
} from "../types";
import { describeReview, presentPayment } from "./paymentPresentation";
import { assessPaymentTruth, type PaymentTruth } from "./paymentTruth";
import {
  assessPostSaleCheckout,
  scholarshipTermsConflict,
  type PostSaleCheckoutAssessment,
} from "./postSaleCheckout";

// A thin adapter over paymentTruth.ts. It fetches and shapes; it decides
// nothing.
//
// This file used to be one of three implementations of payment truth, and
// the one that fell back to the Offer's current list price for an agreed
// total. All of that now lives in assessPaymentTruth, so the panel, the
// card, the board and the dashboard cannot answer the same question
// differently.

export type { PaymentState } from "./paymentTruth";

export type PaymentStatus = {
  state: PaymentTruth["state"];
  headline: string;
  detail: string[];
  outstanding: string | null;
  stripeLinked: boolean;
  reviewReason: string | null;
  // The underlying numbers, so no caller ever recomputes them.
  truth: PaymentTruth;
  // Whether this person can still be sent to pay, and for exactly what —
  // the same assessment the public page and Stripe checkout run on, so the
  // panel can never offer a link the server would refuse.
  checkout: PostSaleCheckoutAssessment;
  // The existing personalized Offer Page token. Null before a sale issued
  // one; never a second token system.
  offerPageToken: string | null;
  // Set only when pricing_mode is scholarship AND the owner-confirmed total
  // differs from the scholarship price. Asks; never substitutes.
  scholarshipConflict: { total: number; scholarshipPrice: number } | null;
};

export const toPaymentStatus = (
  truth: PaymentTruth,
  options: {
    nextChargeOn?: string | null;
    checkout?: PostSaleCheckoutAssessment;
    offerPageToken?: string | null;
    scholarshipConflict?: { total: number; scholarshipPrice: number } | null;
  } = {},
): PaymentStatus => {
  const presentation = presentPayment(truth, options);
  return {
    state: truth.state,
    headline: presentation.headline,
    detail: presentation.detail,
    outstanding: presentation.outstanding,
    stripeLinked: truth.stripeLinked,
    reviewReason: describeReview(truth),
    truth,
    checkout: options.checkout ?? { status: "catalog", truth },
    offerPageToken: options.offerPageToken ?? null,
    scholarshipConflict: options.scholarshipConflict ?? null,
  };
};

export const derivePaymentStatus = (
  deal: Deal,
  items: DealPaymentScheduleItem[],
  planObjects: DealStripePlanObject[],
): PaymentStatus => {
  const input = {
    deal,
    scheduleItems: items ?? [],
    planObjects: planObjects ?? [],
  };
  return toPaymentStatus(assessPaymentTruth(input), {
    checkout: assessPostSaleCheckout(input),
    offerPageToken: deal.offer_page_token ?? null,
    scholarshipConflict: scholarshipTermsConflict(deal),
  });
};

export const assessPaymentStatus = async (
  dataProvider: DataProvider,
  opportunityId: Identifier,
): Promise<PaymentStatus> => {
  const { data: deal } = await dataProvider
    .getOne<Deal>("deals", { id: opportunityId })
    .catch(() => ({ data: null as Deal | null }));

  if (!deal) {
    // Not "no payment" — no Opportunity at all. The difference matters.
    return toPaymentStatus(
      assessPaymentTruth({
        deal: {
          id: opportunityId,
          stage: "",
          selected_payment_total: null,
          selected_installment_count: null,
          selected_installment_amount: null,
          stripe_subscription_id: null,
          stripe_subscription_schedule_id: null,
          payment_review_reason: null,
        } as unknown as Deal,
        scheduleItems: [],
        planObjects: [],
      }),
    );
  }

  const { data: items } = await dataProvider
    .getList<DealPaymentScheduleItem>("deal_payment_schedule_items", {
      filter: { deal_id: opportunityId },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "sequence", order: "ASC" },
    })
    .catch(() => ({ data: [] as DealPaymentScheduleItem[] }));

  const { data: planRows } = await dataProvider
    .getList<DealStripePlanObject>("deal_stripe_plan_objects", {
      filter: { deal_id: opportunityId },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    })
    .catch(() => ({ data: [] as DealStripePlanObject[] }));

  return derivePaymentStatus(deal, items ?? [], planRows ?? []);
};
