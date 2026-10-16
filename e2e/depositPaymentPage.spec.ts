import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// WHAT THE PROSPECT AND THE OWNER ACTUALLY SEE, AGAINST BUILT CSS.
//
// The database half is proven in e2e/depositsAndTheBalance.spec.ts. What only
// a real browser can prove is that the terms are stated truthfully BEFORE
// anybody is sent to Stripe:
//
//   · the programme total
//   · what is due today
//   · that today's money is CREDITED, not extra
//   · the remaining balance and its exact instalments
//   · and NO invented calendar date, because The Living Example's start week
//     may not exist yet
//
// Plus the owner's side: the deposit field, its versioning, and the two
// payment states a deposit makes possible.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "deposit-page-password-1";
const LE = 1;
const GYU = 2;
const BASE = 993000;

const admin = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

/** An option with a deposit, and a prospect holding its Offer Page link. */
const seedProspect = async (
  n: number,
  {
    offerId,
    name,
    total,
    installments,
    installmentAmount,
    deposit,
  }: {
    offerId: number;
    name: string;
    total: number;
    installments: number;
    installmentAmount: number;
    deposit: number;
  },
) => {
  const client = admin();
  const contactId = BASE + n;

  const { data: option, error: optionError } = await client.rpc(
    "set_offer_payment_option",
    {
      p_offer_id: offerId,
      p_name: name,
      p_total: total,
      p_installments: installments,
      p_installment_amount: installmentAmount,
      p_is_public: true,
      p_pricing_mode: "standard",
      p_option_id: null,
      p_deposit_amount: deposit,
    },
  );
  ok("the option", { error: optionError });

  ok(
    "contact",
    await client.from("contacts").insert({
      id: contactId,
      first_name: "Prospect",
      last_name: `Pays${n}`,
      email_jsonb: [{ email: `prospect${n}@pay.test`, type: "Work" }],
    }),
  );

  const token = `tok-deposit-${n}-${Date.now()}`;
  const { data: deal, error } = await client
    .from("deals")
    .insert({
      contact_id: contactId,
      offer_id: offerId,
      stage: "decision",
      amount: total,
      entry_path: "other",
      description: "",
      offer_page_token: token,
      selected_payment_option_id: (option as { option_id: number }).option_id,
      selected_payment_total: total,
      selected_installment_count: installments,
      selected_installment_amount: installmentAmount,
      selected_deposit_amount: deposit,
    })
    .select("id")
    .single();
  ok("deal", { error });

  return { token, dealId: deal!.id as number, contactId };
};

const openOfferPage = async (page: Page, token: string) => {
  await page.goto(`/#/offer/${encodeURIComponent(token)}`);
  // The Pay button is the page having rendered its options, which is what
  // every assertion below is about. Waiting on a label instead raced the
  // first load.
  await expect(page.getByRole("button", { name: "Pay" }).first()).toBeVisible();
};

const signIn = async (page: Page) => {
  const email = `deposit-${Date.now()}@example.com`;
  const { error } = await admin().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

test.describe("the prospect's payment page tells the truth before Stripe", () => {
  test("The Living Example 4-pay: $500 today, credited, then 4 × $875", async ({
    page,
  }) => {
    const { token } = await seedProspect(1, {
      offerId: LE,
      name: "Monthly",
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
    });

    await openOfferPage(page, token);

    await expect(page.getByText(/Programme total \$4,000/)).toBeVisible();
    await expect(page.getByText(/\$500 USD due today/)).toBeVisible();
    await expect(
      page.getByText("credited toward the programme total"),
    ).toBeVisible();
    await expect(page.getByText(/Remaining \$3,500 USD/)).toBeVisible();
    await expect(page.getByText(/4 × \$875/)).toBeVisible();
    // AND NO CALENDAR DATE: the start week is Leif's to set.
    await expect(
      page.getByText("beginning on the 1st of your programme start month"),
    ).toBeVisible();
    await expect(page.getByText(/\b20\d\d-\d\d-\d\d\b/)).toHaveCount(0);
  });

  test("Financial Need: $3,996 total, and the uneven cents shown as they are", async ({
    page,
  }) => {
    const { token } = await seedProspect(2, {
      offerId: LE,
      name: "Financial Need",
      total: 3996,
      installments: 6,
      installmentAmount: 666,
      deposit: 500,
    });

    await openOfferPage(page, token);

    // The agreed total is not rounded to $4,000.
    await expect(page.getByText(/Programme total \$3,996/)).toBeVisible();
    await expect(page.getByText(/\$500 USD due today/)).toBeVisible();
    // The cents are shown, not hidden: the formatter used to round every
    // amount to whole dollars, which would have promised $583.
    await expect(page.getByText(/Remaining \$3,496 USD/)).toBeVisible();
    await expect(
      page.getByText(/4 × \$582\.67 USD then 2 × \$582\.66 USD/),
    ).toBeVisible();
  });

  test("Growing Yourself Up 2-pay: $400 today, then 2 × $500", async ({
    page,
  }) => {
    const { token } = await seedProspect(3, {
      offerId: GYU,
      name: "Monthly",
      total: 1400,
      installments: 2,
      installmentAmount: 700,
      deposit: 400,
    });

    await openOfferPage(page, token);

    await expect(page.getByText(/Programme total \$1,400/)).toBeVisible();
    await expect(page.getByText(/\$400 USD due today/)).toBeVisible();
    await expect(page.getByText(/Remaining \$1,000 USD/)).toBeVisible();
    await expect(page.getByText(/2 × \$500/)).toBeVisible();
  });

  test("an option with no deposit reads exactly as it always did", async ({
    page,
  }) => {
    const { token } = await seedProspect(4, {
      offerId: GYU,
      name: "Pay in Full",
      total: 1400,
      installments: 1,
      installmentAmount: 1400,
      deposit: 0,
    });

    await openOfferPage(page, token);

    await expect(page.getByText("$1,400 USD once")).toBeVisible();
    await expect(page.getByText(/due today/)).toHaveCount(0);
    await expect(page.getByText(/credited toward/)).toHaveCount(0);
  });
});

test.describe("the owner configures the deposit on the option version", () => {
  test("the field is there, and it previews what will actually be charged", async ({
    page,
  }) => {
    await signIn(page);
    await page.evaluate(() => {
      window.location.hash = "#/offers/1";
    });

    // The programme's own edit screen owns the payment options.
    await expect(page.getByText(/Payment options/).first()).toBeVisible();
    await page.getByRole("button", { name: /Add payment option/ }).click();

    await page.locator("#payment-option-name").fill("Browser check");
    await page.locator("#payment-option-total").fill("3996");
    await page.locator("#payment-option-installments").fill("6");
    await page.locator("#payment-option-amount").fill("666");
    await page.locator("#payment-option-deposit").fill("500");

    // Derived from the two numbers above by the one allocation module, so
    // the owner sees the same cents the prospect will.
    await expect(
      page.getByText(/4 × \$582\.67 then 2 × \$582\.66/),
    ).toBeVisible();
    await expect(
      page.getByText(/from the 1st of the programme start month/),
    ).toBeVisible();
  });

  test("a deposit larger than the total is refused in words", async ({
    page,
  }) => {
    await signIn(page);
    await page.evaluate(() => {
      window.location.hash = "#/offers/1";
    });
    await expect(page.getByText(/Payment options/).first()).toBeVisible();
    await page.getByRole("button", { name: /Add payment option/ }).click();

    await page.locator("#payment-option-name").fill("Too much");
    await page.locator("#payment-option-total").fill("1000");
    await page.locator("#payment-option-installments").fill("1");
    await page.locator("#payment-option-amount").fill("1000");
    await page.locator("#payment-option-deposit").fill("1500");

    await expect(
      page.getByText("A deposit cannot be more than the option's own total."),
    ).toBeVisible();
  });
});

test.describe("the two states a deposit makes possible", () => {
  const seedWonWithDeposit = async (
    n: number,
    surname: string,
    planStatus: string | null,
  ) => {
    const client = admin();
    const contactId = BASE + n;
    ok(
      "contact",
      await client.from("contacts").insert({
        id: contactId,
        first_name: "Deposit",
        last_name: surname,
        email_jsonb: [{ email: `state${n}@pay.test`, type: "Work" }],
      }),
    );
    const { data: deal, error } = await client
      .from("deals")
      .insert({
        contact_id: contactId,
        offer_id: LE,
        stage: "won",
        amount: 4000,
        entry_path: "other",
        description: "",
        selected_payment_total: 4000,
        selected_payment_total_source: "owner_confirmed",
        selected_installment_count: 4,
        selected_installment_amount: 1000,
        selected_deposit_amount: 500,
      })
      .select("id")
      .single();
    ok("deal", { error });
    const dealId = deal!.id as number;

    ok(
      "the deposit receipt",
      await client.from("deal_payment_schedule_items").insert({
        deal_id: dealId,
        amount: 500,
        sequence: 1,
        status: "paid",
        paid_on: new Date().toISOString().slice(0, 10),
        source: "stripe",
        stripe_payment_intent_id: `pi_state_${dealId}`,
      }),
    );
    if (planStatus) {
      ok(
        "a plan object",
        await client.from("deal_stripe_plan_objects").insert({
          deal_id: dealId,
          stripe_object_id: `sub_state_${dealId}`,
          object_type: "subscription",
          status: planStatus,
          is_current: true,
          link_source: "webhook",
        }),
      );
    }
    return dealId;
  };

  test("deposit paid with nothing scheduled is NOT reported as an active plan", async ({
    page,
  }) => {
    const dealId = await seedWonWithDeposit(10, "Waiting", null);

    await signIn(page);
    await page.evaluate((id) => {
      window.location.hash = `#/deals/${id}/show`;
    }, dealId);

    await expect(page.getByText("Deposit paid")).toBeVisible();
    await expect(page.getByText(/balance is not scheduled yet/)).toBeVisible();
    await expect(page.getByText(/\$3,500(\.00)? remaining/)).toBeVisible();
    // The claim that must not be made.
    await expect(page.getByText("Active payment plan")).toHaveCount(0);
  });

  test("a failed scheduled charge is visible and actionable", async ({
    page,
  }) => {
    const dealId = await seedWonWithDeposit(11, "Failed", "past_due");

    await signIn(page);
    await page.evaluate((id) => {
      window.location.hash = `#/deals/${id}/show`;
    }, dealId);

    await expect(
      page.getByText("A scheduled payment did not go through"),
    ).toBeVisible();
    await expect(page.getByText(/retrying the card/)).toBeVisible();
    await expect(page.getByText("Active payment plan")).toHaveCount(0);
  });

  test("and one that needs the client to authenticate says that instead", async ({
    page,
  }) => {
    const dealId = await seedWonWithDeposit(12, "NeedsAuth", "incomplete");

    await signIn(page);
    await page.evaluate((id) => {
      window.location.hash = `#/deals/${id}/show`;
    }, dealId);

    await expect(
      page.getByText("Payment needs the client to authenticate"),
    ).toBeVisible();
  });
});
