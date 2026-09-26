import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { Notification } from "@/components/admin/notification";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import { assessPaymentStatus } from "./paymentStatus";
import { assessPaymentTruth } from "./paymentTruth";
import { assessPostSaleCheckout } from "./postSaleCheckout";
import { getOfferPageContext } from "./publicOfferPageContext";
import { createDataProviderPublicOfferPageDataSource } from "./publicOfferPageDataSource";
import type { Deal, Enrollment, Offer, OfferPaymentOption } from "../types";

// Becky Schmauch's whole remaining journey, driven through the real page.
//
// She was sold to, her $4,000 was recorded, and the CRM had no action that
// could take her money: the Offer Page said "Payment received ✓" and the
// checkout refused her, both because `stage === 'won'` was being read as
// "already paid". These tests take her exact production state and press the
// buttons.

const TOKEN = "becky-token";

const offer: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  scholarship_price: 3000,
  max_active_clients: 12,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

// The public catalog a prospect would browse. A sold client must never be
// shown these: her agreed single payment is not a menu.
const options: OfferPaymentOption[] = [
  {
    id: 3,
    offer_id: 1,
    name: "Pay in Full",
    total: 4000,
    installments: 1,
    installment_amount: 4000,
    is_public: true,
    pricing_mode: "standard",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: 2,
    offer_id: 1,
    name: "Monthly",
    total: 4000,
    installments: 4,
    installment_amount: 1000,
    is_public: true,
    pricing_mode: "standard",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

const beckyDeal = (over: Partial<Deal> = {}): Deal =>
  ({
    id: 192,
    contact_id: 1,
    offer_id: 1,
    cohort_id: null,
    name: "Becky Schmauch",
    stage: "won",
    outcome: null,
    owner_decision: "would_work_with",
    prospect_decision: "yes",
    pricing_mode: "standard",
    offer_name_snapshot: "The Living Example",
    offer_price_snapshot: 4000,
    offer_page_token: TOKEN,
    selected_payment_option_id: null,
    selected_payment_total: 4000,
    selected_installment_count: 1,
    selected_installment_amount: 4000,
    selected_payment_total_source: "owner_confirmed",
    stripe_subscription_id: null,
    stripe_subscription_schedule_id: null,
    payment_setup_confirmed_at: null,
    amount: 4000,
    entry_path: "other",
    description: "",
    archived_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    sales_id: 0,
    index: 0,
    stage_entered_at: "2026-09-26T01:33:41.000Z",
    ...over,
  }) as Deal;

const enrollment: Enrollment = {
  id: 91,
  opportunity_id: 192,
  status: "onboarding",
  onboarding_tracking: "tracked",
  start_date: null,
  end_date: null,
  created_at: "2026-09-26T01:33:41.000Z",
  updated_at: "2026-09-26T01:33:41.000Z",
} as Enrollment;

const buildProvider = (deals: Deal[], extra: Record<string, unknown> = {}) =>
  createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 1, first_name: "Becky", last_name: "Schmauch" }),
      ],
      offers: [offer],
      offer_payment_options: options,
      deals,
      enrollments: [enrollment],
      deal_payment_schedule_items: [],
      deal_stripe_plan_objects: [],
      ...extra,
    } as never),
    silent: true,
    latency: 0,
  });

// The real route, mounted through the real app shell: CRM.tsx registers
// /offer/:token and wires the FakeRest data source itself, so this is the
// page a prospect actually gets.
const renderOfferPage = async (
  dataProvider: ReturnType<typeof createDataProvider>,
) => {
  await page.viewport(1100, 1000);
  return render(
    <MemoryRouter initialEntries={[`/offer/${TOKEN}`]}>
      <CRM
        dataProvider={dataProvider}
        authProvider={createTestAuthProvider()}
        i18nProvider={testI18nProvider}
        store={memoryStore()}
        disableTelemetry
        layout={({ children }) => (
          <>
            {children}
            <Notification />
          </>
        )}
      />
    </MemoryRouter>,
  );
};

const paidTotal = async (
  dataProvider: ReturnType<typeof createDataProvider>,
) => {
  const { data } = await dataProvider.getList("deal_payment_schedule_items", {
    filter: { deal_id: 192 },
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });
  return data
    .filter((item) => item.status === "paid")
    .reduce((sum, item) => sum + Number(item.amount), 0);
};

describe("the Offer Page of a client who has been sold to and has not paid", () => {
  it("shows her agreed terms and offers to pay them", async () => {
    const dataProvider = buildProvider([beckyDeal()]);
    const screen = await renderOfferPage(dataProvider);

    await expect.element(screen.getByText("Agreed terms")).toBeVisible();
    await expect.element(screen.getByText("$4,000 USD once")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Pay" }))
      .toBeVisible();
    // And it does NOT tell her money arrived.
    expect(screen.container.textContent).not.toContain("Payment received");
  });

  it("never offers the catalog structure she did not agree to", async () => {
    const dataProvider = buildProvider([beckyDeal()]);
    const screen = await renderOfferPage(dataProvider);

    await expect.element(screen.getByText("Agreed terms")).toBeVisible();
    // 4 x $1,000 is a real public option for her Offer. It is not hers.
    expect(screen.container.textContent).not.toContain("4 ×");
    expect(screen.container.textContent).not.toContain("Monthly");
    expect(screen.container.textContent).not.toContain("Pay in Full");
    expect(screen.getByRole("button", { name: "Pay" }).elements()).toHaveLength(
      1,
    );
  });

  it("paying records the money and leaves the sale alone", async () => {
    const dataProvider = buildProvider([beckyDeal()]);
    const screen = await renderOfferPage(dataProvider);

    await screen.getByRole("button", { name: "Pay" }).click();

    await expect.poll(() => paidTotal(dataProvider)).toBe(4000);

    const { data: deal } = await dataProvider.getOne<Deal>("deals", {
      id: 192,
    });
    // Won throughout, terms untouched, one Enrollment.
    expect(deal.stage).toBe("won");
    expect(deal.selected_payment_total).toBe(4000);
    expect(deal.selected_installment_count).toBe(1);
    expect(deal.selected_payment_total_source).toBe("owner_confirmed");
    const { data: enrollments } = await dataProvider.getList("enrollments", {
      filter: { opportunity_id: 192 },
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(enrollments).toHaveLength(1);

    // And the CRM now reads paid in full, from the money rather than from
    // the stage.
    const status = await assessPaymentStatus(dataProvider, 192);
    expect(status.truth.paidInFull).toBe(true);
    expect(status.state).toBe("paid_in_full");
  });

  it("a second attempt neither charges again nor duplicates anything", async () => {
    const dataProvider = buildProvider([beckyDeal()]);
    const screen = await renderOfferPage(dataProvider);

    await screen.getByRole("button", { name: "Pay" }).click();
    await expect.poll(() => paidTotal(dataProvider)).toBe(4000);

    // What the page would resolve on a revisit. Asked of the context rather
    // than by mounting a second copy of the page into the same document.
    const revisit = await getOfferPageContext(dataProvider, TOKEN);
    expect(revisit.kind).toBe("found");
    if (revisit.kind === "found") {
      expect(revisit.payment.status).toBe("paid-in-full");
      expect(revisit.paymentOptions).toHaveLength(0);
    }

    // And the server refuses a repeat even if something asks it directly.
    const again = await createDataProviderPublicOfferPageDataSource(
      dataProvider,
    ).createCheckout(TOKEN, "agreed-terms");
    expect(again.status).toBe("payment-not-available");
    expect(await paidTotal(dataProvider)).toBe(4000);
  });
});

describe("what the page says when payment must not be taken", () => {
  it("a live plan is not a receipt", async () => {
    const dataProvider = buildProvider([
      beckyDeal({ stripe_subscription_id: "sub_live" }),
    ]);
    const screen = await renderOfferPage(dataProvider);

    await expect
      .element(screen.getByText("Payment plan set up ✓"))
      .toBeVisible();
    // The distinction this slice exists to make: setup complete is not
    // payment received.
    expect(screen.container.textContent).not.toContain("Payment received");
    expect(screen.container.textContent).toContain("still to come");
    await expect
      .element(screen.getByRole("button", { name: "Pay" }))
      .not.toBeInTheDocument();
  });

  it("an arrangement made outside the CRM claims no money", async () => {
    const dataProvider = buildProvider([
      beckyDeal({
        payment_setup_confirmed_at: "2026-09-26T02:00:00.000Z",
        payment_setup_source: "owner_confirmed",
      } as Partial<Deal>),
    ]);
    const screen = await renderOfferPage(dataProvider);

    await expect.element(screen.getByText("Payment arranged ✓")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Payment received");
    await expect
      .element(screen.getByRole("button", { name: "Pay" }))
      .not.toBeInTheDocument();
  });

  it("terms nobody recorded are the CRM's problem, not the buyer's", async () => {
    const dataProvider = buildProvider([
      beckyDeal({
        selected_payment_total: null,
        selected_installment_count: null,
        selected_installment_amount: null,
      }),
    ]);
    const screen = await renderOfferPage(dataProvider);

    await expect
      .element(screen.getByText("Nothing to pay here yet"))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Pay" }))
      .not.toBeInTheDocument();
  });

  it("an agreement Stripe cannot charge exactly is refused, not rounded", async () => {
    const dataProvider = buildProvider([
      beckyDeal({
        selected_installment_count: 3,
        selected_installment_amount: 1333.33,
      }),
    ]);
    const screen = await renderOfferPage(dataProvider);

    await expect
      .element(screen.getByText("Nothing to pay here yet"))
      .toBeVisible();
    expect(await paidTotal(dataProvider)).toBe(0);
  });
});

describe("what Leif sees on the Opportunity", () => {
  it("offers the payment link for Becky's exact state", async () => {
    const dataProvider = buildProvider([beckyDeal()]);
    const status = await assessPaymentStatus(dataProvider, 192);
    expect(status.state).toBe("setup_pending");
    expect(status.outstanding).toBe("Send payment link");
    expect(status.checkout.status).toBe("payable");
    expect(status.offerPageToken).toBe(TOKEN);
    expect(status.scholarshipConflict).toBeNull();
  });

  it("offers nothing to send once a plan exists", async () => {
    const dataProvider = buildProvider([
      beckyDeal({ stripe_subscription_id: "sub_live" }),
    ]);
    const status = await assessPaymentStatus(dataProvider, 192);
    expect(status.checkout).toMatchObject({
      status: "blocked",
      reason: "plan-exists",
    });
    expect(status.truth.paidInFull).toBe(false);
  });

  it("asks before charging a scholarship client a different total", async () => {
    const dataProvider = buildProvider([
      beckyDeal({
        pricing_mode: "scholarship",
        offer_price_snapshot: 3000,
        selected_payment_total: 4000,
        selected_installment_amount: 4000,
      }),
    ]);
    const status = await assessPaymentStatus(dataProvider, 192);
    expect(status.scholarshipConflict).toEqual({
      total: 4000,
      scholarshipPrice: 3000,
    });
    // Neither number was substituted for the other.
    expect(status.truth.agreedTotal).toBe(4000);
    expect(status.checkout.status).toBe("payable");
  });
});

describe("when the payment attempt fails", () => {
  it("records no money and still reports setup pending", async () => {
    const dataProvider = buildProvider([beckyDeal()]);
    // A checkout that throws where Stripe would: after authorization, before
    // anything is recorded. The CRM must not end up claiming setup exists
    // for a session that never happened.
    const failing = {
      ...createDataProviderPublicOfferPageDataSource(dataProvider),
      createCheckout: async () => {
        throw new Error("Stripe is unreachable");
      },
    };

    const result = await failing.createCheckout().catch(() => "threw");
    expect(result).toBe("threw");

    expect(await paidTotal(dataProvider)).toBe(0);
    const status = await assessPaymentStatus(dataProvider, 192);
    expect(status.state).toBe("setup_pending");
    expect(status.truth.paymentSetupComplete).toBe(false);
    const { data: deal } = await dataProvider.getOne<Deal>("deals", {
      id: 192,
    });
    expect(deal.payment_setup_confirmed_at ?? null).toBeNull();
    expect(deal.stripe_subscription_id ?? null).toBeNull();
    expect(deal.stage).toBe("won");
  });

  it("an unrepresentable agreement is refused before any money moves", async () => {
    const dataProvider = buildProvider([
      beckyDeal({
        selected_installment_count: 3,
        selected_installment_amount: 1333.33,
      }),
    ]);
    const source = createDataProviderPublicOfferPageDataSource(dataProvider);

    const result = await source.createCheckout(TOKEN, "agreed-terms");
    expect(result.status).toBe("payment-not-available");
    expect(await paidTotal(dataProvider)).toBe(0);
    const status = await assessPaymentStatus(dataProvider, 192);
    expect(status.truth.paymentSetupComplete).toBe(false);
  });
});

// The scholarship authority, at the layer that decides it.
//
// The warning used to be dismissed with local React state, which authorized
// nothing: the Offer Page token stays executable and the server had no way
// to know Leif had agreed. The confirmation now writes the canonical fact
// that already means "she stated this total" —
// selected_payment_total_source = owner_confirmed — and both the page and
// stripe_checkout refuse a scholarship conflict without it.
describe("confirming a scholarship-conflicting total", () => {
  const conflicted = (source: string | null) =>
    beckyDeal({
      pricing_mode: "scholarship",
      offer_price_snapshot: 3000,
      selected_payment_total: 2800,
      selected_installment_count: 1,
      selected_installment_amount: 2800,
      selected_payment_total_source: source,
    } as Partial<Deal>);

  it("is blocked before, payable after, and the authority is a row", async () => {
    const dataProvider = buildProvider([conflicted("stripe_derived")]);

    const before = await assessPaymentStatus(dataProvider, 192);
    expect(before.checkout).toMatchObject({
      status: "blocked",
      reason: "scholarship-unconfirmed",
    });
    expect(before.scholarshipConflict).toEqual({
      total: 2800,
      scholarshipPrice: 3000,
    });

    // Exactly the write the panel's "Yes — charge $2,800" performs.
    await dataProvider.update("deals", {
      id: 192,
      data: {
        selected_payment_total: 2800,
        selected_payment_total_source: "owner_confirmed",
      },
      previousData: { id: 192 },
    });

    const after = await assessPaymentStatus(dataProvider, 192);
    expect(after.checkout.status).toBe("payable");
    // Neither number was substituted for the other.
    expect(after.truth.agreedTotal).toBe(2800);
    const { data: deal } = await dataProvider.getOne<Deal>("deals", {
      id: 192,
    });
    expect(deal.offer_price_snapshot).toBe(3000);
    expect(deal.selected_payment_total_source).toBe("owner_confirmed");
  });

  it("the public page offers nothing at all while it is unconfirmed", async () => {
    const dataProvider = buildProvider([conflicted(null)]);
    const context = await getOfferPageContext(dataProvider, TOKEN);
    expect(context.kind).toBe("found");
    if (context.kind === "found") {
      // The buyer is never shown the CRM's pricing argument with itself.
      expect(context.payment.status).toBe("unavailable");
      expect(context.paymentOptions).toHaveLength(0);
    }

    // And the token cannot be used to force it.
    const source = createDataProviderPublicOfferPageDataSource(dataProvider);
    const result = await source.createCheckout(TOKEN, "agreed-terms");
    expect(result.status).toBe("payment-not-available");
    expect(await paidTotal(dataProvider)).toBe(0);
  });
});

// The exact rows a completed Stripe TEST payment left behind.
//
// Copied verbatim out of the clean-room database after a real hosted Checkout
// was paid with Stripe's test card and the SIGNED
// checkout.session.completed was forwarded to the local stripe_webhook
// (2026-09-26, Opportunity 8, "ZZWEBHOOK Proof"): the fixture was Won BEFORE
// paying, so the sale step no-opped, and the money landed anyway. This pins
// the reading of that shape — the one thing the live proof could not leave
// behind for CI.
describe("what the CRM reads after a real signed payment", () => {
  const afterRealPayment = {
    id: 8,
    stage: "won",
    selected_payment_total: 4000,
    selected_installment_count: 1,
    selected_installment_amount: 4000,
    selected_payment_total_source: "owner_confirmed",
    stripe_subscription_id: null,
    stripe_subscription_schedule_id: null,
    payment_setup_confirmed_at: null,
    payment_review_reason: null,
    payment_review_code: null,
  } as unknown as Deal;

  const paidByStripe = [
    {
      id: 1,
      deal_id: 8,
      sequence: 1,
      amount: 4000,
      status: "paid",
      paid_on: "2026-09-26",
      source: "stripe",
      satisfied_by_payment_intent_id: null,
    },
  ] as never;

  it("reads paid in full, from the money rather than from the stage", () => {
    const truth = assessPaymentTruth({
      deal: afterRealPayment,
      scheduleItems: paidByStripe,
      planObjects: [],
    });

    expect(truth.collected).toBe(4000);
    expect(truth.remaining).toBe(0);
    expect(truth.paidInFull).toBe(true);
    expect(truth.paymentSetupComplete).toBe(true);
    expect(truth.state).toBe("paid_in_full");
    // Not because anybody said so: no plan, no owner-confirmed setup.
    expect(truth.hasCurrentPlan).toBe(false);
    expect(truth.setupConfirmedElsewhere).toBe(false);
    // And the agreement is still hers.
    expect(truth.agreedTotal).toBe(4000);
    expect(truth.reviewCode).toBeNull();
  });

  it("offers no further checkout, and the page says payment received", () => {
    const assessment = assessPostSaleCheckout({
      deal: afterRealPayment,
      scheduleItems: paidByStripe,
      planObjects: [],
    });
    expect(assessment).toMatchObject({
      status: "blocked",
      reason: "paid-in-full",
    });
  });
});
