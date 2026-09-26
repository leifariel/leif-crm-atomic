import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Won is a sales fact. Payment is a different one.
//
// 2026-09-04 built the Offer Page and the Checkout function when Won was
// reachable only through a successful Stripe payment, so both read
// `stage === 'won'` as "already paid": the page announced "Payment received
// ✓" and the server returned `already-won`. 20260918180000 overturned that
// model on 2026-09-17 — "a model that treated Won as a payment fact. It is
// not." — and nobody revisited either guard. For eight days the CRM could
// sell to somebody and then had no way to take their money, which is where
// Becky Schmauch sat: Won, $4,000 agreed, $0 collected, refused by both.
//
// The same shape as the sale repair itself: two commits holding opposite
// beliefs about Won, thirteen days apart. So these are contract tests over
// the files that have to agree.

const read = (path: string) => readFileSync(path, "utf8");

// The rules below are about what the CODE does. Every one of these files
// explains the defect it came from in its own comments, and those comments
// necessarily quote the thing being banned — so comments are stripped
// before matching, or the explanation itself would fail the assertion.
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");

const PAGE_CONTEXT = read(
  "src/components/atomic-crm/deals/publicOfferPageContext.ts",
);
const OFFER_PAGE = read("src/components/atomic-crm/deals/OfferPage.tsx");
const TERMS = read(
  "src/components/atomic-crm/deals/resolveAuthorizedCheckoutTerms.ts",
);
const RULES_SRC = read("src/components/atomic-crm/deals/postSaleCheckout.ts");
const RULES_EDGE = read("supabase/functions/_shared/postSaleCheckoutRules.ts");
const EDGE_DB = read("supabase/functions/_shared/postSaleCheckout.ts");
const CHECKOUT_FN = read("supabase/functions/stripe_checkout/index.ts");
const OFFER_PAGE_FN = read("supabase/functions/offer_page/index.ts");
const WEBHOOK = read("supabase/functions/stripe_webhook/index.ts");
const PANEL = read("src/components/atomic-crm/deals/PaymentPanel.tsx");
const PRESENTATION = read(
  "src/components/atomic-crm/deals/paymentPresentation.ts",
);

describe("nothing decides payment by reading the stage", () => {
  // Every surface that answers "may this person pay / have they paid".
  const eligibilitySurfaces: [string, string][] = [
    ["the public page context", PAGE_CONTEXT],
    ["the public page itself", OFFER_PAGE],
    ["the checkout-terms resolver", TERMS],
    ["the checkout Edge Function", CHECKOUT_FN],
    ["the offer_page Edge Function", OFFER_PAGE_FN],
  ];

  test("no eligibility surface still carries the already-won refusal", () => {
    for (const [what, source] of eligibilitySurfaces) {
      expect(
        code(source),
        `${what} still refuses on "already-won"`,
      ).not.toMatch(/status: ?"already-won"|alreadyWon/);
    }
  });

  test("the only place a stage is compared is where the SALE is the question", () => {
    // `stage !== "won"` appears exactly once per implementation of the
    // rules, and it means "not sold yet, so the catalog applies" — never
    // "already paid". Nothing else may consult it.
    for (const [what, source] of eligibilitySurfaces) {
      const stageReads =
        code(source).match(/\.stage\s*[!=]==?\s*["']won["']/g) ?? [];
      expect(stageReads, `${what} reads deal.stage to decide payment`).toEqual(
        [],
      );
    }
    expect(RULES_SRC).toMatch(/deal\.stage !== "won"/);
    expect(RULES_EDGE).toMatch(/facts\.stage !== "won"/);
  });

  test("both implementations decide from money, plans and Leif's own statement", () => {
    for (const source of [RULES_SRC, RULES_EDGE]) {
      expect(source).toMatch(/paid-in-full/);
      expect(source).toMatch(/plan-exists/);
      expect(source).toMatch(/setup-confirmed-elsewhere/);
      expect(source).toMatch(/terms-unknown/);
      expect(source).toMatch(/not-representable/);
    }
  });

  test("the panel and the page ask the same assessment the server does", () => {
    expect(PANEL).toMatch(/status\.checkout/);
    expect(PAGE_CONTEXT).toMatch(/assessPostSaleCheckout/);
    expect(TERMS).toMatch(/assessPostSaleCheckout/);
    expect(CHECKOUT_FN).toMatch(/assessCheckoutForDeal/);
    expect(OFFER_PAGE_FN).toMatch(/assessCheckoutForDeal/);
    // One shared mirror for both Edge Functions, not two copies.
    expect(EDGE_DB).toMatch(/postSaleCheckoutRules\.ts/);
  });
});

describe("setup complete is not payment received", () => {
  test("the page states each situation separately", () => {
    // "Payment received ✓" was shown to anybody Won. It now belongs to one
    // state only, and the other three say what is actually true.
    expect(OFFER_PAGE).toMatch(/Payment received ✓/);
    expect(OFFER_PAGE).toMatch(/Payment plan set up ✓/);
    expect(OFFER_PAGE).toMatch(/Payment arranged ✓/);
    expect(OFFER_PAGE).toMatch(/Nothing to pay here yet/);
  });

  test("a live plan reports what has actually been collected", () => {
    expect(OFFER_PAGE).toMatch(/has been received so far/);
    expect(OFFER_PAGE).toMatch(/still to come/);
  });

  test("the four statuses are distinct values, not one flag", () => {
    for (const status of [
      '"payable"',
      '"paid-in-full"',
      '"plan-exists"',
      '"setup-elsewhere"',
      '"unavailable"',
      '"choosing"',
    ]) {
      expect(PAGE_CONTEXT).toContain(status);
    }
  });
});

describe("what the owner is asked to do", () => {
  test("the next step is sending the link, not creating a plan", () => {
    // Nothing canonical is created before the client goes through Checkout,
    // so "Create payment plan" named an action that could not exist.
    expect(PRESENTATION).not.toMatch(/Create payment plan/);
    expect(PRESENTATION).toMatch(/Send payment link/);
  });

  test("the link is the Offer Page token that already exists", () => {
    expect(PANEL).toMatch(/offerPageToken/);
    expect(PANEL).toMatch(/#\/offer\//);
    // No second token system.
    expect(PANEL).not.toMatch(/randomUUID|crypto\./);
  });

  test("the outside-Stripe arrangement writes the canonical pair, and says it is not payment", () => {
    expect(PANEL).toMatch(/payment_setup_confirmed_at/);
    expect(PANEL).toMatch(/payment_setup_source: "owner_confirmed"/);
    expect(PANEL).toMatch(/does not mark anything paid/);
    // It must not touch anything else about the sale.
    const action = PANEL.slice(
      PANEL.indexOf("const confirmSetupElsewhere"),
      PANEL.indexOf("const confirmScholarshipTotal"),
    );
    expect(action).not.toMatch(/stage/);
    expect(action).not.toMatch(/selected_payment_total/);
    expect(action).not.toMatch(/enrollment/i);
    expect(action).not.toMatch(/deal_payment_schedule_items/);
  });
});

describe("real money is reconstructed before it is charged", () => {
  test("the server rebuilds the charge and demands it match to the cent", () => {
    // $4,000 in 3 is $3,999.99. The last check before Stripe is asked for
    // anything, in the function that talks to Stripe.
    expect(CHECKOUT_FN).toMatch(/reconstructedCents/);
    expect(CHECKOUT_FN).toMatch(/not-representable/);
    const reconstruct = CHECKOUT_FN.indexOf("reconstructedCents");
    const sessionCreate = CHECKOUT_FN.indexOf(
      "stripe.checkout.sessions.create",
    );
    expect(reconstruct).toBeGreaterThan(-1);
    expect(sessionCreate).toBeGreaterThan(reconstruct);
  });

  test("an agreed-terms checkout stamps no catalog option into Stripe", () => {
    // The webhook freezes selected_payment_option_id from that metadata, and
    // agreed terms have no catalog row — a sentinel there would put a
    // nonexistent option id on the Deal.
    expect(CHECKOUT_FN).toMatch(/catalogOptionId/);
    expect(CHECKOUT_FN).not.toMatch(/payment_option_id: String\(option\.id\)/);
  });
});

describe("a payment after Won is still recorded", () => {
  test("the webhook records payment truth regardless of the stage transition", () => {
    // recordDealPaymentSucceeded legitimately no-ops for an already-Won
    // Deal. Before this slice the handler then returned, so a payment from
    // somebody sold to first left the ledger empty until the nightly sweep
    // happened to run — the same Won=Paid assumption one layer up.
    const handler = WEBHOOK.slice(
      WEBHOOK.indexOf("const handleCheckoutSessionCompleted"),
      WEBHOOK.indexOf("Deno.serve"),
    );
    const sale = handler.indexOf("recordDealPaymentSucceeded(deal");
    const money = handler.indexOf("reconcileStripe(stripe");
    expect(sale).toBeGreaterThan(-1);
    expect(money).toBeGreaterThan(sale);
    // And it must not be able to fail the delivery whose sale already
    // landed — Stripe would retry the whole thing.
    expect(handler.slice(money - 200, money + 400)).toMatch(/try|catch/);
  });
});

// The two implementations, asked the same questions.
//
// The page runs the Edge mirror and the tests run the src module, so
// "mirrored by hand" is only as good as somebody checking. This imports
// both and compares verdicts — the pure rules file exists precisely so it
// can be imported outside Deno.
describe("the src logic of record and the Edge mirror agree", () => {
  type Case = {
    what: string;
    stage: string;
    total: number | null;
    count: number | null;
    amount: number | null;
    collectedCents?: number;
    hasCurrentPlan?: boolean;
    ownerConfirmedSetup?: boolean;
    pricingMode?: string;
    scholarshipPrice?: number;
    source?: string | null;
  };

  const cases: Case[] = [
    { what: "Becky", stage: "won", total: 4000, count: 1, amount: 4000 },
    {
      what: "not sold",
      stage: "decision",
      total: 4000,
      count: 1,
      amount: 4000,
    },
    {
      what: "paid",
      stage: "won",
      total: 4000,
      count: 1,
      amount: 4000,
      collectedCents: 400000,
    },
    {
      what: "live plan",
      stage: "won",
      total: 4000,
      count: 4,
      amount: 1000,
      hasCurrentPlan: true,
    },
    {
      what: "arranged elsewhere",
      stage: "won",
      total: 4000,
      count: 1,
      amount: 4000,
      ownerConfirmedSetup: true,
    },
    { what: "no terms", stage: "won", total: null, count: null, amount: null },
    { what: "4000 / 3", stage: "won", total: 4000, count: 3, amount: 1333.33 },
    { what: "4 x 1000", stage: "won", total: 4000, count: 4, amount: 1000 },
    { what: "Sam Milz", stage: "won", total: 700, count: 4, amount: 175 },
    {
      what: "Daniel's 6 x 583",
      stage: "won",
      total: 3998,
      count: 6,
      amount: 583,
    },
    { what: "no count", stage: "won", total: 1400, count: null, amount: null },
    {
      what: "scholarship, total differs, owner stated it",
      stage: "won",
      total: 2800,
      count: 1,
      amount: 2800,
      pricingMode: "scholarship",
      scholarshipPrice: 3000,
      source: "owner_confirmed",
    },
    {
      what: "scholarship, total differs, derived not stated",
      stage: "won",
      total: 2800,
      count: 1,
      amount: 2800,
      pricingMode: "scholarship",
      scholarshipPrice: 3000,
      source: "stripe_derived",
    },
    {
      what: "scholarship, total IS the scholarship price",
      stage: "won",
      total: 3000,
      count: 1,
      amount: 3000,
      pricingMode: "scholarship",
      scholarshipPrice: 3000,
      source: null,
    },
  ];

  test("every case gets the same verdict from both", async () => {
    const { assessPostSaleCheckout } = await import(
      "../../src/components/atomic-crm/deals/postSaleCheckout"
    );
    const { assessCheckoutFacts } = await import(
      "../../supabase/functions/_shared/postSaleCheckoutRules"
    );

    for (const c of cases) {
      const srcResult = assessPostSaleCheckout({
        deal: {
          id: 1,
          stage: c.stage,
          pricing_mode: c.pricingMode ?? "standard",
          offer_price_snapshot: c.scholarshipPrice ?? 4000,
          selected_payment_total: c.total,
          selected_payment_total_source: c.source ?? null,
          selected_installment_count: c.count,
          selected_installment_amount: c.amount,
          stripe_subscription_id: c.hasCurrentPlan ? "sub_1" : null,
          stripe_subscription_schedule_id: null,
          payment_setup_confirmed_at: c.ownerConfirmedSetup
            ? "2026-09-26T00:00:00.000Z"
            : null,
          payment_review_reason: null,
        } as never,
        scheduleItems: c.collectedCents
          ? ([
              {
                id: 1,
                deal_id: 1,
                sequence: 1,
                amount: c.collectedCents / 100,
                status: "paid",
                source: "stripe",
                stripe_payment_intent_id: "pi_1",
              },
            ] as never)
          : [],
        planObjects: [],
      });

      const edgeResult = assessCheckoutFacts({
        stage: c.stage,
        agreedTotal: c.total,
        agreedInstallmentCount: c.count,
        agreedInstallmentAmount: c.amount,
        pricingMode: c.pricingMode ?? "standard",
        scholarshipPrice: c.scholarshipPrice ?? 4000,
        agreedTotalSource: c.source ?? null,
        collectedCents: c.collectedCents ?? 0,
        hasCurrentPlan: c.hasCurrentPlan ?? false,
        ownerConfirmedSetup: c.ownerConfirmedSetup ?? false,
      });

      expect(edgeResult.status, `${c.what}: status`).toBe(srcResult.status);
      if (srcResult.status === "payable" && edgeResult.status === "payable") {
        expect(edgeResult.terms, `${c.what}: terms`).toEqual(srcResult.terms);
      }
      if (srcResult.status === "blocked" && edgeResult.status === "blocked") {
        expect(edgeResult.reason, `${c.what}: reason`).toBe(srcResult.reason);
      }
    }
  });
});

describe("a failure leaves the CRM claiming nothing", () => {
  test("the checkout function writes only the session id it just created", () => {
    // If Stripe throws, nothing above has been recorded — so the CRM cannot
    // end up reporting setup complete for a session that never existed.
    const writes =
      code(CHECKOUT_FN).match(/\.from\("deals"\)\s*\.update\(\{[^}]*\}/g) ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/stripe_checkout_session_id/);
    // And emphatically not these.
    for (const field of [
      "stage",
      "payment_setup_confirmed_at",
      "selected_payment_total",
      "selected_installment_count",
    ]) {
      expect(writes[0], `checkout must not write ${field}`).not.toContain(
        field,
      );
    }
  });

  test("only the owner action writes the setup-confirmed pair", () => {
    // One writer, and it is the one that asks first.
    for (const [what, source] of [
      ["the checkout function", CHECKOUT_FN],
      ["the offer_page function", OFFER_PAGE_FN],
      ["the webhook", WEBHOOK],
      ["the public page", OFFER_PAGE],
      ["the page context", PAGE_CONTEXT],
    ] as [string, string][]) {
      // A type declaration reads the column; only an update WRITES it.
      const updates =
        code(source)
          .match(/\.update\(\{[\s\S]*?\}\)/g)
          ?.join("\n") ?? "";
      expect(
        updates,
        `${what} must not write payment_setup_confirmed_at`,
      ).not.toMatch(/payment_setup_confirmed_at/);
    }
    expect(code(PANEL)).toMatch(/payment_setup_confirmed_at:\s/);
  });
});

// Who is allowed to say that a scholarship-conflicting total is the one.
//
// The first implementation withheld the payment link with local React state.
// That authorized nothing: the Offer Page token stays executable by anyone
// holding it, and the server had no idea a warning had been shown. The
// authority is now a canonical fact both server paths read.
describe("the scholarship-conflict authority is server-verifiable", () => {
  test("both implementations refuse an unconfirmed conflict", () => {
    for (const source of [RULES_SRC, RULES_EDGE]) {
      expect(source).toMatch(/scholarship-unconfirmed/);
      expect(source).toMatch(/owner_confirmed/);
    }
  });

  test("the rule is the provenance of the total, not a UI flag", () => {
    // deals.selected_payment_total_source = 'owner_confirmed' is written by
    // exactly one app path: Leif typing the total into the payment panel.
    expect(code(RULES_SRC)).toMatch(
      /selected_payment_total_source !== "owner_confirmed"/,
    );
    expect(code(RULES_EDGE)).toMatch(/agreedTotalSource !== "owner_confirmed"/);
    // Both Edge Functions read that column, so neither can be more
    // permissive than the other.
    expect(EDGE_DB).toMatch(/selected_payment_total_source/);
  });

  test("confirming writes that fact rather than hiding the warning", () => {
    const action = PANEL.slice(
      PANEL.indexOf("const confirmScholarshipTotal"),
      PANEL.indexOf("const sync = async"),
    );
    expect(action).toMatch(/selected_payment_total_source: "owner_confirmed"/);
    // No local "acknowledged" state anywhere — a refresh must re-block an
    // unconfirmed conflict, and must NOT re-ask once it is confirmed.
    expect(code(PANEL)).not.toMatch(/conflictAcknowledged/);
    expect(code(PANEL)).toMatch(/blockReason === "scholarship-unconfirmed"/);
  });

  test("the buyer is never told the CRM is arguing with itself", () => {
    // scholarship-unconfirmed maps to the same opaque public state as any
    // other CRM-side problem.
    const describe_ = PAGE_CONTEXT.slice(
      PAGE_CONTEXT.indexOf("const describeStatus"),
      PAGE_CONTEXT.length,
    );
    expect(describe_).not.toMatch(/scholarship-unconfirmed/);
    // The page still says "Scholarship pricing" where that is the prospect's
    // own good news. What it must never surface is the CRM disagreeing with
    // itself about which number to charge.
    expect(code(OFFER_PAGE)).not.toMatch(/unconfirmed|agreed total|substitut/i);
  });
});

// The installment leg, as far as source can carry it.
//
// A subscription and its schedule only exist once a payment succeeds, and
// Stripe has no API to pay a Checkout Session — so the adoption path's
// runtime proof needs a second human checkout. What IS assertable is that the
// inputs it reads are attached and read: a real Stripe TEST Session created
// by this function was verified to be mode=subscription with one $1,000/month
// line item reconstructing $4,000 exactly (2026-09-26), and the metadata the
// adoption step keys on is stamped and consumed here.
describe("Architecture B adoption is reachable from what the webhook receives", () => {
  test("the checkout stamps the installment count onto the subscription", () => {
    const checkout = code(CHECKOUT_FN);
    expect(checkout).toMatch(/subscription_data/);
    expect(checkout).toMatch(
      /total_installments: String\(option\.installments\)/,
    );
    // And the Opportunity identity travels on both the Session and the
    // subscription, so a payment can never be attributed by guesswork.
    expect(checkout).toMatch(/client_reference_id: String\(deal\.id\)/);
    expect(
      checkout.match(/deal_id: String\(deal\.id\)/g)?.length,
    ).toBeGreaterThan(1);
  });

  test("the webhook reads that count and configures the schedule", () => {
    const hook = code(WEBHOOK);
    expect(hook).toMatch(/subscription\.metadata\?\.total_installments/);
    expect(hook).toMatch(/ensureInstallmentScheduleConfigured\(/);
    // Only for a plan: a one-time payment must never reach it.
    expect(hook).toMatch(/if \(totalInstallments\)/);
    expect(hook).toMatch(/if \(totalInstallments <= 1\) return;/);
  });

  test("the schedule step re-reads live Stripe before changing anything", () => {
    // A redelivery must not create a second schedule or append a second
    // future phase — the recoverable-state-machine rule this function's own
    // header sets out.
    const hook = code(WEBHOOK);
    expect(hook).toMatch(/subscriptionSchedules\.retrieve\(scheduleId\)/);
    expect(hook).toMatch(/schedule\.phases\.length > 1/);
  });
});
