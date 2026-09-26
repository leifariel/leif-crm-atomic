import type { DataProvider, Identifier } from "ra-core";

import type {
  Cohort,
  Contact,
  Deal,
  DealPaymentScheduleItem,
  DealStripePlanObject,
  OfferPaymentOption,
} from "../types";
import {
  assessPostSaleCheckout,
  type ExactInstallments,
  type PostSaleCheckoutAssessment,
} from "./postSaleCheckout";

// Payment domain foundation slice: the public Offer Page's own read-side
// context — only the handful of fields a prospect is allowed to see
// (their own name, the frozen offer/price, which payment option(s) they
// may choose among), never internal ids, sales notes, or anyone else's
// data. Mirrors public-application/publicOfferContext.ts's own shape and
// its own header comment: this is the FakeRest-testable "logic of record"
// a production Edge Function mirrors by hand (RLS blocks an anon client
// from reading "deals"/"contacts"/etc. directly — every table's RLS is
// `to authenticated` only, same as every other public-facing surface in
// this app).
export type OfferPagePaymentOption = {
  id: Identifier;
  name: string;
  total: number;
  installments: number;
  installmentAmount: number;
};

export type PublicOfferPageContext =
  | { kind: "not-found" }
  | {
      kind: "found";
      contactName: string;
      offerName: string;
      cohortName: string | null;
      frozenPrice: number;
      // Scholarship Pricing + Capacity slice: lets the Offer Page clearly
      // identify scholarship pricing to the prospect — offerName itself
      // never encodes pricing mode (see offers.scholarship_price's own
      // schema comment: pricing_mode carries that identity, not the Offer
      // name).
      isScholarship: boolean;
      // Exactly one entry when Leif has already authorized a specific
      // option for this Deal (selected_payment_option_id set); every
      // publicly-offered option of this Deal's Offer otherwise — see
      // offer_payment_options.is_public's own schema comment for why a
      // prospect only ever sees a subset by default.
      paymentOptions: OfferPagePaymentOption[];
      // What is true about this person's payment, said exactly.
      //
      // This replaced `alreadyWon: deal.stage === 'won'`, which collapsed
      // four different situations into one and then announced the wrong
      // one: a client who had just been sold to and had paid nothing was
      // told "Payment received ✓". Sam Milz was told his first $175 had
      // arrived by the same class of mistake. Each state now says only
      // what it knows.
      payment: OfferPagePaymentState;
    };

export type OfferPagePaymentStatus =
  // Sold, terms known, nothing arranged: the one state that offers to pay.
  | "payable"
  | "paid-in-full"
  // A live plan is carrying it. Some money may have arrived, or none yet.
  | "plan-exists"
  // Leif arranged it outside this CRM. Says nothing about money.
  | "setup-elsewhere"
  // Sold, but nothing payable can be offered here (terms unrecorded, or an
  // agreement Stripe cannot charge exactly). The prospect is told to
  // expect contact, never shown the machinery.
  | "unavailable"
  // Not sold yet — the prospect is still choosing.
  | "choosing";

export type OfferPagePaymentState = {
  status: OfferPagePaymentStatus;
  // Their own money, so it is theirs to see. Null remaining means the
  // agreement is not known well enough to subtract from.
  collected: number;
  remaining: number | null;
};

export const getOfferPageContext = async (
  dataProvider: DataProvider,
  token: string,
): Promise<PublicOfferPageContext> => {
  const { data: deals } = await dataProvider.getList<Deal>("deals", {
    filter: { offer_page_token: token },
    pagination: { page: 1, perPage: 1 },
    sort: { field: "id", order: "ASC" },
  });
  const deal = deals[0];
  if (!deal || deal.offer_price_snapshot == null) return { kind: "not-found" };

  const contact = await dataProvider
    .getOne<Contact>("contacts", { id: deal.contact_id! })
    .then(({ data }) => data)
    .catch(() => null);
  if (!contact) return { kind: "not-found" };

  const cohort =
    deal.cohort_id != null
      ? await dataProvider
          .getOne<Cohort>("cohorts", { id: deal.cohort_id })
          .then(({ data }) => data)
          .catch(() => null)
      : null;

  const assessment = assessPostSaleCheckout({
    deal,
    scheduleItems: await listScheduleItems(dataProvider, deal.id),
    planObjects: await listPlanObjects(dataProvider, deal.id),
  });

  // A sold client is not shopping. The terms Leif recorded ARE the offer,
  // so the catalog is not consulted at all — offering Becky 4 × $1,000
  // against her agreed single payment of $4,000 would invite her to
  // execute something nobody agreed to.
  const paymentOptions =
    assessment.status === "catalog"
      ? await resolvePaymentOptions(dataProvider, deal)
      : assessment.status === "payable"
        ? [agreedTermsAsOption(assessment.terms)]
        : [];

  return {
    kind: "found",
    contactName:
      `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim(),
    offerName: deal.offer_name_snapshot ?? "",
    cohortName: cohort?.name ?? null,
    frozenPrice: deal.offer_price_snapshot,
    isScholarship: deal.pricing_mode === "scholarship",
    paymentOptions,
    payment: {
      status: describeStatus(assessment),
      collected: assessment.truth.collected,
      remaining: assessment.truth.remaining,
    },
  };
};

// The id the page sends back when it asks to pay agreed terms. Not an
// `offer_payment_options` row — no catalog row need exist, and the server
// re-resolves the amount from the Deal regardless of what arrives.
export const AGREED_TERMS_OPTION_ID = "agreed-terms";

const agreedTermsAsOption = (
  terms: ExactInstallments,
): OfferPagePaymentOption => ({
  id: AGREED_TERMS_OPTION_ID,
  name: terms.installments === 1 ? "Payment" : "Payment plan",
  total: terms.total,
  installments: terms.installments,
  installmentAmount: terms.installmentAmount,
});

const describeStatus = (
  assessment: PostSaleCheckoutAssessment,
): OfferPagePaymentStatus => {
  if (assessment.status === "catalog") return "choosing";
  if (assessment.status === "payable") return "payable";
  switch (assessment.reason) {
    case "paid-in-full":
      return "paid-in-full";
    case "plan-exists":
      return "plan-exists";
    case "setup-confirmed-elsewhere":
      return "setup-elsewhere";
    // "terms-unknown" and "not-representable" are both the CRM's own
    // problem to solve, never something to explain to the buyer.
    default:
      return "unavailable";
  }
};

const listScheduleItems = (dataProvider: DataProvider, dealId: Identifier) =>
  dataProvider
    .getList<DealPaymentScheduleItem>("deal_payment_schedule_items", {
      filter: { deal_id: dealId },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "sequence", order: "ASC" },
    })
    .then(({ data }) => data)
    .catch(() => []);

const listPlanObjects = (dataProvider: DataProvider, dealId: Identifier) =>
  dataProvider
    .getList<DealStripePlanObject>("deal_stripe_plan_objects", {
      filter: { deal_id: dealId },
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    })
    .then(({ data }) => data)
    .catch(() => []);

const resolvePaymentOptions = async (
  dataProvider: DataProvider,
  deal: Deal,
): Promise<OfferPagePaymentOption[]> => {
  // Leif already authorized exactly one option for this Deal (public or
  // not) — the frozen snapshot IS the option, no further choice offered.
  if (deal.selected_payment_option_id != null) {
    return deal.selected_payment_total != null &&
      deal.selected_installment_count != null &&
      deal.selected_installment_amount != null
      ? [
          {
            id: deal.selected_payment_option_id,
            name: await resolveOptionName(
              dataProvider,
              deal.selected_payment_option_id,
            ),
            total: deal.selected_payment_total,
            installments: deal.selected_installment_count,
            installmentAmount: deal.selected_installment_amount,
          },
        ]
      : [];
  }

  const { data: options } = await dataProvider.getList<OfferPaymentOption>(
    "offer_payment_options",
    {
      filter: {
        offer_id: deal.offer_id,
        is_public: true,
        pricing_mode: deal.pricing_mode ?? "standard",
      },
      pagination: { page: 1, perPage: 20 },
      sort: { field: "id", order: "ASC" },
    },
  );
  return options.map((option) => ({
    id: option.id,
    name: option.name,
    total: option.total,
    installments: option.installments,
    installmentAmount: option.installment_amount,
  }));
};

const resolveOptionName = async (
  dataProvider: DataProvider,
  optionId: Identifier,
): Promise<string> =>
  dataProvider
    .getOne<OfferPaymentOption>("offer_payment_options", { id: optionId })
    .then(({ data }) => data.name)
    .catch(() => "");
