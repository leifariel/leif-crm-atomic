import { render } from "vitest-browser-react";

import { StoryWrapper } from "@/test/StoryWrapper";
import { PaymentPanel } from "./PaymentPanel";
import type { Deal, DealPaymentScheduleItem } from "../types";

// The panel is where payment truth actually reaches Leif, so the states
// that used to be wrong are checked as rendered output, not as return
// values: a fully paid client must not be asked to create a payment plan,
// and an uncertain one must not be told anything at all confidently.

const deal = (overrides: Partial<Deal> = {}): Deal =>
  ({
    id: 1,
    name: "Opportunity",
    contact_id: 10,
    offer_id: 1,
    stage: "won",
    amount: 4000,
    offer_price_snapshot: 4000,
    sales_id: 1,
    index: 0,
    stage_entered_at: "2026-05-01T00:00:00Z",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  }) as Deal;

const paidItem = (
  overrides: Partial<DealPaymentScheduleItem> = {},
): DealPaymentScheduleItem =>
  ({
    id: 1,
    deal_id: 1,
    amount: 4000,
    sequence: 1,
    status: "paid",
    source: "stripe",
    stripe_payment_intent_id: "pi_1",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  }) as DealPaymentScheduleItem;

const show = (
  deals: Deal[],
  deal_payment_schedule_items: DealPaymentScheduleItem[],
) =>
  render(
    <StoryWrapper data={{ deals, deal_payment_schedule_items }}>
      <PaymentPanel opportunityId={1} contactId={10} />
    </StoryWrapper>,
  );

describe("PaymentPanel", () => {
  it("shows a one-time payment as paid in full, not as setup pending", async () => {
    // Arrange — Emily Loeb: $3,700 in a single payment, no subscription.
    const screen = await show(
      [deal({ selected_payment_total: 3700 })],
      [paidItem({ amount: 3700, paid_on: "2026-07-16" })],
    );

    // Assert
    await expect.element(screen.getByText("Paid in full")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Send payment link");
  });

  it("shows how far through a plan somebody is when no live subscription exists", async () => {
    // Arrange — Jules Litman-Cleper: 4 of 6 collected, schedule completed.
    const items = [1, 2, 3, 4].map((n) =>
      paidItem({
        id: n,
        sequence: n,
        amount: 666,
        stripe_payment_intent_id: `pi_${n}`,
      }),
    );
    const screen = await show(
      [
        deal({
          selected_payment_total: 3996,
          selected_installment_count: 6,
          selected_installment_amount: 666,
        }),
      ],
      items,
    );

    // Assert
    await expect.element(screen.getByText("Active payment plan")).toBeVisible();
    expect(screen.container.textContent).toContain("4 of 6 installments paid");
    expect(screen.container.textContent).toContain("$1,332.00 remaining");
  });

  it("states uncertainty and offers a way to close it, instead of asserting a state", async () => {
    // Arrange — Mia Cosme: money scattered across Customer objects the CRM
    // is not linked to. Her agreed total IS recorded, so the question is
    // the scattered payments and reading it is what closes it.
    const screen = await show(
      [
        deal({
          selected_payment_total: 4000,
          payment_review_reason:
            "Payments sit across four different Stripe Customer objects.",
        }),
      ],
      [paidItem({ amount: 925 })],
    );

    // Assert
    await expect
      .element(screen.getByText("Payment status needs review"))
      .toBeVisible();
    expect(screen.container.textContent).toContain(
      "four different Stripe Customer objects",
    );
    await expect
      .element(screen.getByRole("button", { name: "Mark reviewed" }))
      .toBeVisible();
  });

  it("will not let a raised question be closed while the total is still missing", async () => {
    // Arrange — the same question, but nothing records what she agreed to
    // pay. Acknowledging it would clear the stored reason and immediately
    // raise the derived "no agreed total" one in its place: the same loop,
    // one step slower. So the missing fact is asked for first.
    const screen = await show(
      [
        deal({
          payment_review_reason:
            "Payments sit across four different Stripe Customer objects.",
        }),
      ],
      [paidItem({ amount: 925 })],
    );

    await expect
      .element(screen.getByRole("button", { name: "Record agreed terms" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Mark reviewed" }))
      .not.toBeInTheDocument();
  });

  // It used to say "Create payment plan", which named an action the CRM
  // could not perform: nothing canonical is created until the client goes
  // through Checkout. What Leif does next is send them their own page.
  it("asks for a payment link only when there is genuinely nothing and no doubt", async () => {
    // Arrange — Emma Wijns.
    const screen = await show([deal({ selected_payment_total: 4000 })], []);

    // Assert
    await expect
      .element(screen.getByText("Payment setup pending"))
      .toBeVisible();
    expect(screen.container.textContent).toContain("Send payment link");
  });
});

// The two actions that did not exist.
//
// "Next: Create payment plan" had nothing behind it, and
// payment_setup_confirmed_at had waited for a writer since the migration
// that added it. Becky Schmauch was Won with $4,000 recorded and no way to
// take it.
describe("PaymentPanel — post-sale payment setup", () => {
  const sold = (overrides: Partial<Deal> = {}) =>
    deal({
      selected_payment_total: 4000,
      selected_installment_count: 1,
      selected_installment_amount: 4000,
      selected_payment_total_source: "owner_confirmed",
      offer_page_token: "becky-token",
      ...overrides,
    } as Partial<Deal>);

  it("offers the existing Offer Page link, not a new plan to create", async () => {
    const screen = await show([sold()], []);

    await expect
      .element(screen.getByText("Payment setup pending"))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open payment page" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Copy payment link" }))
      .toBeVisible();
    // The link is the token that already exists, never a second one.
    expect(
      screen
        .getByRole("link", { name: "Open payment page" })
        .element()
        .getAttribute("href"),
    ).toContain("/#/offer/becky-token");
  });

  it("offers nothing to send when the terms are not recorded", async () => {
    const screen = await show(
      [deal({ offer_page_token: "t" } as Partial<Deal>)],
      [],
    );

    await expect
      .element(screen.getByText(/No agreed total is recorded/i))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open payment page" }))
      .not.toBeInTheDocument();
  });

  it("offers nothing to send once the money is in", async () => {
    const screen = await show([sold()], [paidItem({ amount: 4000 })]);

    await expect.element(screen.getByText("Paid in full")).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open payment page" }))
      .not.toBeInTheDocument();
    // Nor is she asked to confirm an arrangement that plainly exists.
    await expect
      .element(
        screen.getByRole("button", { name: "Payment setup handled elsewhere" }),
      )
      .not.toBeInTheDocument();
  });

  it("says why, rather than offering a link the server would refuse", async () => {
    const screen = await show(
      [
        sold({
          selected_installment_count: 3,
          selected_installment_amount: 1333.33,
        } as Partial<Deal>),
      ],
      [],
    );

    await expect
      .element(screen.getByText(/cannot add up to 4000 exactly/i))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open payment page" }))
      .not.toBeInTheDocument();
    // And the escape hatch IS offered, because that is the answer here.
    await expect
      .element(
        screen.getByRole("button", { name: "Payment setup handled elsewhere" }),
      )
      .toBeVisible();
  });

  it("records an arrangement made elsewhere, and marks nothing paid", async () => {
    const screen = await show([sold()], []);

    await screen
      .getByRole("button", { name: "Payment setup handled elsewhere" })
      .click();
    // The helper text has to be unmistakable about what this is not.
    await expect
      .element(screen.getByText(/does not mark anything paid/i))
      .toBeVisible();
    // And it asks before writing.
    await screen
      .getByRole("button", { name: "Yes — setup exists elsewhere" })
      .click();

    // Named for what it is. It used to say "Scheduled payment plan", which
    // described a schedule the CRM has never seen and implied installments
    // that may not exist — the arrangement could be a transfer, an invoice,
    // or a plan Leif built by hand in Stripe.
    await expect
      .element(screen.getByText("Payment setup handled elsewhere"))
      .toBeVisible();
    expect(screen.container.textContent).not.toContain(
      "Scheduled payment plan",
    );
    // Setup exists; no money is claimed.
    expect(screen.container.textContent).toContain("$0.00 recorded here");
    expect(screen.container.textContent).not.toContain("Paid in full");
    await expect
      .element(screen.getByRole("link", { name: "Open payment page" }))
      .not.toBeInTheDocument();
  });

  // Scholarship pricing says $3,000, the agreed total says $2,800, and the
  // total was DERIVED from Stripe rather than stated by Leif. The server
  // refuses it until she says which number governs — so confirming has to
  // write something, not merely hide a warning: the Offer Page token stays
  // executable either way.
  it("withholds the link until the conflicting total is actually confirmed", async () => {
    const screen = await show(
      [
        sold({
          pricing_mode: "scholarship",
          offer_price_snapshot: 3000,
          selected_payment_total: 2800,
          selected_installment_amount: 2800,
          selected_payment_total_source: "stripe_derived",
        } as Partial<Deal>),
      ],
      [],
    );

    await expect
      .element(screen.getByText(/never substitutes the scholarship price/i))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open payment page" }))
      .not.toBeInTheDocument();

    await screen.getByRole("button", { name: /Yes — charge/ }).click();

    // The link appears because the SERVER's own rule is now satisfied.
    await expect
      .element(screen.getByRole("link", { name: "Open payment page" }))
      .toBeVisible();
    // And the button is gone, because there is nothing left to confirm.
    await expect
      .element(screen.getByRole("button", { name: /Yes — charge/ }))
      .not.toBeInTheDocument();
  });

  it("a conflicting total Leif already stated needs no second confirmation", async () => {
    const screen = await show(
      [
        sold({
          pricing_mode: "scholarship",
          offer_price_snapshot: 3000,
          selected_payment_total: 2800,
          selected_installment_amount: 2800,
          selected_payment_total_source: "owner_confirmed",
        } as Partial<Deal>),
      ],
      [],
    );

    // The warning stays as context — it is a real disagreement — but she
    // has already answered it, so the link is offered.
    await expect
      .element(screen.getByText(/never substitutes the scholarship price/i))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open payment page" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /Yes — charge/ }))
      .not.toBeInTheDocument();
  });
});

// Two arrangements, one derived state, and they must not borrow each other's
// words. `payment_setup_confirmed_at` makes setup complete without the CRM
// ever having seen a plan.
describe("PaymentPanel — an arrangement the CRM can see, and one it cannot", () => {
  const sold = (overrides: Partial<Deal> = {}) =>
    deal({
      selected_payment_total: 4000,
      selected_installment_count: 4,
      selected_installment_amount: 1000,
      selected_payment_total_source: "owner_confirmed",
      offer_page_token: "tok",
      ...overrides,
    } as Partial<Deal>);

  it("calls a live Stripe plan a plan", async () => {
    const screen = await show(
      [sold({ stripe_subscription_id: "sub_live" } as Partial<Deal>)],
      [],
    );

    await expect
      .element(screen.getByText("Scheduled payment plan"))
      .toBeVisible();
    expect(screen.container.textContent).toContain("4 × $1,000.00 scheduled");
  });

  it("does not call an outside arrangement a plan", async () => {
    const screen = await show(
      [
        sold({
          payment_setup_confirmed_at: "2026-09-26T00:00:00.000Z",
          payment_setup_source: "owner_confirmed",
        } as Partial<Deal>),
      ],
      [],
    );

    await expect
      .element(screen.getByText("Payment setup handled elsewhere"))
      .toBeVisible();
    expect(screen.container.textContent).toContain("Arranged outside the CRM");
    // No invented schedule, and no claim of money.
    expect(screen.container.textContent).not.toContain("scheduled");
    expect(screen.container.textContent).not.toContain("Paid in full");
  });

  it("prefers the plan it can see when both are true", async () => {
    // Leif recorded an outside arrangement and a real plan later appeared.
    const screen = await show(
      [
        sold({
          stripe_subscription_id: "sub_live",
          payment_setup_confirmed_at: "2026-09-26T00:00:00.000Z",
          payment_setup_source: "owner_confirmed",
        } as Partial<Deal>),
      ],
      [],
    );

    await expect
      .element(screen.getByText("Scheduled payment plan"))
      .toBeVisible();
  });
});
