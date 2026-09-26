import { describe, expect, it } from "vitest";

import type { Deal, DealPaymentScheduleItem } from "../types";
import {
  assessPostSaleCheckout,
  describeCheckoutBlock,
  reconstructAgreedTerms,
  scholarshipTermsConflict,
} from "./postSaleCheckout";

// Becky Schmauch's state, as the logic of record sees it.
//
// Won, standard pricing, $4,000 agreed in one payment, $0 collected, no
// Stripe anything. Before this module she was refused by the Offer Page and
// by the Checkout function alike, each on the strength of `stage === 'won'`.
//
// The same cases run against the Edge-Function mirror in
// supabase/functions/_shared/postSaleCheckoutRules.test.ts. That is
// deliberate: the two implementations must agree, and the only way to know
// is to ask them both.

const becky = (over: Partial<Deal> = {}): Deal =>
  ({
    id: 192,
    stage: "won",
    pricing_mode: "standard",
    offer_price_snapshot: 4000,
    selected_payment_total: 4000,
    selected_installment_count: 1,
    selected_installment_amount: 4000,
    selected_payment_total_source: "owner_confirmed",
    stripe_subscription_id: null,
    stripe_subscription_schedule_id: null,
    payment_setup_confirmed_at: null,
    payment_review_reason: null,
    ...over,
  }) as Deal;

const paid = (amount: number): DealPaymentScheduleItem =>
  ({
    id: 1,
    deal_id: 192,
    sequence: 1,
    amount,
    status: "paid",
    source: "stripe",
    stripe_payment_intent_id: "pi_1",
  }) as DealPaymentScheduleItem;

const assess = (
  deal: Deal,
  scheduleItems: DealPaymentScheduleItem[] = [],
  planObjects: Parameters<typeof assessPostSaleCheckout>[0]["planObjects"] = [],
) => assessPostSaleCheckout({ deal, scheduleItems, planObjects });

describe("reconstructing what Stripe will charge", () => {
  it("a single payment is the total", () => {
    expect(reconstructAgreedTerms(4000, 1, 4000)).toEqual({
      total: 4000,
      installments: 1,
      installmentAmount: 4000,
    });
  });

  it("treats a missing installment count as a single payment", () => {
    expect(reconstructAgreedTerms(1400, null, null)).toEqual({
      total: 1400,
      installments: 1,
      installmentAmount: 1400,
    });
  });

  it("accepts equal installments that reconstruct the total exactly", () => {
    expect(reconstructAgreedTerms(4000, 4, 1000)).not.toBeNull();
    expect(reconstructAgreedTerms(700, 4, 175)).not.toBeNull();
    expect(reconstructAgreedTerms(3000, 4, 750)).not.toBeNull();
  });

  it("refuses $4,000 in 3 rather than charging $3,999.99", () => {
    expect(reconstructAgreedTerms(4000, 3, 1333.33)).toBeNull();
  });

  it("refuses stored terms that do not multiply out", () => {
    // Daniel Alexander: 6 x $583 is $3,498, not $3,998.
    expect(reconstructAgreedTerms(3998, 6, 583)).toBeNull();
  });

  it("refuses a single payment whose stored amount contradicts the total", () => {
    expect(reconstructAgreedTerms(4000, 1, 3700)).toBeNull();
  });

  it("refuses nothing, zero and negatives", () => {
    expect(reconstructAgreedTerms(null, 1, null)).toBeNull();
    expect(reconstructAgreedTerms(0, 1, 0)).toBeNull();
    expect(reconstructAgreedTerms(-100, 1, -100)).toBeNull();
  });
});

describe("whether a sold client may still be sent to pay", () => {
  it("Becky's exact state is payable, for exactly her terms", () => {
    const result = assess(becky());
    expect(result.status).toBe("payable");
    if (result.status === "payable") {
      expect(result.terms).toEqual({
        total: 4000,
        installments: 1,
        installmentAmount: 4000,
      });
      expect(result.truth.collected).toBe(0);
      expect(result.truth.state).toBe("setup_pending");
    }
  });

  it("leaves a deal that is not sold yet to the catalog", () => {
    expect(assess(becky({ stage: "call_booked" })).status).toBe("catalog");
  });

  it("refuses once the money is in", () => {
    const result = assess(becky(), [paid(4000)]);
    expect(result).toMatchObject({ status: "blocked", reason: "paid-in-full" });
  });

  it("refuses a second checkout when a live plan exists, even with nothing collected", () => {
    const result = assess(becky({ stripe_subscription_id: "sub_123" }));
    expect(result).toMatchObject({ status: "blocked", reason: "plan-exists" });
    // And it is emphatically not called paid.
    if (result.status === "blocked") {
      expect(result.truth.paidInFull).toBe(false);
      expect(result.truth.collected).toBe(0);
    }
  });

  it("refuses when Leif recorded an arrangement outside the CRM", () => {
    const result = assess(
      becky({
        payment_setup_confirmed_at: "2026-09-26T00:00:00.000Z",
        payment_setup_source: "owner_confirmed",
      } as Partial<Deal>),
    );
    expect(result).toMatchObject({ reason: "setup-confirmed-elsewhere" });
    if (result.status === "blocked") {
      // Setup exists; no money is claimed.
      expect(result.truth.collected).toBe(0);
      expect(result.truth.paidInFull).toBe(false);
    }
  });

  it("refuses when nobody recorded the agreed total", () => {
    const result = assess(
      becky({
        selected_payment_total: null,
        selected_installment_count: null,
        selected_installment_amount: null,
      }),
    );
    expect(result).toMatchObject({ reason: "terms-unknown" });
  });

  it("refuses an agreement Stripe cannot charge to the cent", () => {
    const result = assess(
      becky({
        selected_installment_count: 3,
        selected_installment_amount: 1333.33,
      }),
    );
    expect(result).toMatchObject({ reason: "not-representable" });
    // The owner-facing reason names the arrangement rather than blaming the
    // person, and says what to do instead.
    if (result.status === "blocked") {
      const said = describeCheckoutBlock(result.reason, result.agreed);
      expect(said).toMatch(/cannot add up to 4000 exactly/i);
      expect(said).toMatch(/outside the CRM/i);
    }
  });

  it("puts money ahead of the shape of the agreement", () => {
    const result = assess(
      becky({
        selected_installment_count: 3,
        selected_installment_amount: 1333.33,
      }),
      [paid(4000)],
    );
    expect(result).toMatchObject({ reason: "paid-in-full" });
  });
});

describe("scholarship pricing and the agreed total", () => {
  it("says nothing for standard pricing — Becky is not a scholarship case", () => {
    expect(scholarshipTermsConflict(becky())).toBeNull();
  });

  it("says nothing when the agreed total IS the scholarship price", () => {
    // Gigi George: scholarship $3,000, agreed $3,000.
    expect(
      scholarshipTermsConflict(
        becky({
          pricing_mode: "scholarship",
          offer_price_snapshot: 3000,
          selected_payment_total: 3000,
        }),
      ),
    ).toBeNull();
  });

  it("reports the disagreement without substituting either number", () => {
    const conflict = scholarshipTermsConflict(
      becky({
        pricing_mode: "scholarship",
        offer_price_snapshot: 3000,
        selected_payment_total: 4000,
      }),
    );
    expect(conflict).toEqual({ total: 4000, scholarshipPrice: 3000 });
  });

  // The authority is a canonical fact, not a click. A conflicting total is
  // payable exactly when Leif STATED it — selected_payment_total_source =
  // owner_confirmed, which only her typing it into the panel writes. The
  // server applies this, so the warning cannot be bypassed by opening the
  // Offer Page token directly.
  it("refuses a conflicting total nobody stated", () => {
    for (const source of [null, "stripe_derived", "offer_snapshot"]) {
      const result = assess(
        becky({
          pricing_mode: "scholarship",
          offer_price_snapshot: 3000,
          selected_payment_total: 2800,
          selected_installment_amount: 2800,
          selected_payment_total_source: source,
        } as Partial<Deal>),
      );
      expect(result, `source=${source}`).toMatchObject({
        status: "blocked",
        reason: "scholarship-unconfirmed",
      });
    }
  });

  it("charges her stated total once she has stated it, substituting neither number", () => {
    const result = assess(
      becky({
        pricing_mode: "scholarship",
        offer_price_snapshot: 3000,
        selected_payment_total: 2800,
        selected_installment_amount: 2800,
        selected_payment_total_source: "owner_confirmed",
      } as Partial<Deal>),
    );
    expect(result.status).toBe("payable");
    if (result.status === "payable") {
      expect(result.terms.total).toBe(2800);
    }
  });

  it("never blocks the historical three, whose totals agree with their pricing", () => {
    // Mel, Sam and Gigi: imported, no provenance, total equal to the
    // scholarship price.
    const result = assess(
      becky({
        pricing_mode: "scholarship",
        offer_price_snapshot: 3000,
        selected_payment_total: 3000,
        selected_installment_count: 4,
        selected_installment_amount: 750,
        selected_payment_total_source: null,
      } as Partial<Deal>),
    );
    expect(result.status).toBe("payable");
  });

  it("says what confirming means, in words", () => {
    const said = describeCheckoutBlock("scholarship-unconfirmed", {
      total: 2800,
      installments: 1,
    });
    expect(said).toMatch(/scholarship pricing/i);
    expect(said).toMatch(/confirm the total/i);
  });
});
