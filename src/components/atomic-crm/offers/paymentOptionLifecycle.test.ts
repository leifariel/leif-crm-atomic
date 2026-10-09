import { describe, expect, it } from "vitest";

import { createDataProvider } from "../providers/fakerest/dataProvider";
import { createCrmDb, buildContact } from "@/test/StoryWrapper";
import type { Deal, Offer, OfferPaymentOption } from "../types";
import { setOfferPaymentOption } from "./paymentOptionActions";

// Retiring an option stops it being OFFERED. It does not cancel an agreement.
//
// The distinction is the whole point of `is_active`, and it is easy to get
// backwards: filter the fulfilment path on "active" too and a prospect who
// chose an option last week can no longer pay for it. So the new-selection
// surfaces and the already-chosen path are tested against each other here.
//
// The transaction and the row lock live in Postgres and are proved in
// e2e/paymentOptionVersioning.spec.ts; this is the same decisions in the same
// order, where the read paths actually run.

const AT = "2026-01-01T00:00:00.000Z";

const LE: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "6 months",
  current_price: 4800,
  max_active_clients: 12,
  is_active: true,
  created_at: AT,
  updated_at: AT,
};

const option = (id: number, name: string): OfferPaymentOption =>
  ({
    id,
    offer_id: 1,
    name,
    total: 4800,
    installments: 6,
    installment_amount: 800,
    is_public: true,
    pricing_mode: "standard",
    is_active: true,
    replaces_option_id: null,
    created_at: AT,
    updated_at: AT,
  }) as OfferPaymentOption;

const deal = (over: Partial<Deal> = {}): Deal =>
  ({
    id: 1,
    name: "Prospect",
    contact_id: 1,
    offer_id: 1,
    stage: "call_booked",
    outcome: null,
    amount: 4800,
    index: 0,
    sales_id: 0,
    pricing_mode: "standard",
    created_at: AT,
    updated_at: AT,
    stage_entered_at: AT,
    offer_page_token: "probe-token",
    ...over,
  }) as unknown as Deal;

const build = (options: OfferPaymentOption[], deals: Deal[] = [deal()]) =>
  createDataProvider({
    db: createCrmDb({
      contacts: [buildContact({ id: 1 })],
      offers: [LE],
      offer_payment_options: options,
      deals,
    } as never),
    silent: true,
    latency: 0,
  });

// WHERE EACH CLAIM IS PROVED.
//
// "a retired option disappears from a NEW selection" and "an agreement that
// already chose it stays payable" are properties of the read paths against
// real rows, and they are proved in e2e/paymentOptionVersioning.spec.ts
// (CASE 4) against real Postgres — the row survives, the Deal keeps pointing
// at it, and its agreed terms are unchanged. Reproducing them here against
// FakeRest would be asserting a stand-in.
//
// What this file proves is what the MIRROR decides: add, correct, version,
// refuse. The transaction and the row lock are Postgres's and are proved
// there too.

describe("editing a payment option", () => {
  it("corrects the row when nobody chose it", async () => {
    const dataProvider = build([option(1, "Monthly")], []);

    const result = await setOfferPaymentOption(dataProvider, {
      offerId: 1,
      name: "Monthly — corrected",
      total: 5400,
      installments: 6,
      installmentAmount: 900,
      isPublic: true,
      pricingMode: "standard",
      optionId: 1,
    });
    expect(result.status).toBe("updated");

    const { data } = await dataProvider.getOne<OfferPaymentOption>(
      "offer_payment_options",
      { id: 1 },
    );
    expect(data.name).toBe("Monthly — corrected");
    expect(data.is_active).not.toBe(false);
  });

  it("versions instead, the moment somebody has chosen it", async () => {
    const dataProvider = build(
      [option(1, "Monthly")],
      [deal({ selected_payment_option_id: 1 } as Partial<Deal>)],
    );

    const result = await setOfferPaymentOption(dataProvider, {
      offerId: 1,
      name: "Monthly — next version",
      total: 5400,
      installments: 6,
      installmentAmount: 900,
      isPublic: true,
      pricingMode: "standard",
      optionId: 1,
    });
    expect(result.status).toBe("versioned");
    if (result.status !== "versioned") return;
    expect(String(result.replacedOptionId)).toBe("1");
    expect(result.agreementsPreserved).toBe(1);

    // The agreement is exactly as it was, and no longer offered.
    const { data: original } = await dataProvider.getOne<OfferPaymentOption>(
      "offer_payment_options",
      { id: 1 },
    );
    expect(original.name).toBe("Monthly");
    expect(Number(original.total)).toBe(4800);
    expect(original.is_active).toBe(false);

    const { data: replacement } = await dataProvider.getOne<OfferPaymentOption>(
      "offer_payment_options",
      { id: result.optionId },
    );
    expect(Number(replacement.total)).toBe(5400);
    expect(replacement.is_active).toBe(true);
    // The version CHAIN (replaces_option_id) is asserted against real
    // Postgres in e2e/paymentOptionVersioning.spec.ts, which is where the
    // column and its foreign key actually live.
  });

  it("refuses instalments that do not add up, as the charge path would", async () => {
    const dataProvider = build([], []);
    const result = await setOfferPaymentOption(dataProvider, {
      offerId: 1,
      name: "Three of three-thirty-three",
      total: 1000,
      installments: 3,
      installmentAmount: 333,
      isPublic: true,
      pricingMode: "standard",
    });
    expect(result.status).toBe("instalments-do-not-add-up");
  });
});
