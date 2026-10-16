import { createClient } from "@supabase/supabase-js";

import { allocateBalanceCents } from "../src/components/atomic-crm/deals/depositAllocation";
import { expect, test } from "./fixtures";

// A DEPOSIT, AND THE BALANCE IT LEAVES, AGAINST REAL POSTGRES.
//
// Everything here needs a real database: integer division in Postgres, the
// versioning authority's row lock, the Won trigger chain, and the refusals
// that must happen BEFORE anything is written.
//
//   A–F   the decided plans, to the cent
//   G     the parts always sum to the balance
//   H     a deposit cannot exceed its own total
//   I     a referenced option version cannot be financially mutated
//   J     an option with no deposit behaves as it always did
//   O/P   a confirmed deposit makes the sale Won exactly once
//   Q     deposit paid, no start date -> no schedule
//   R/S   one schedule, however many times it is asked for
//   T     a changed start date re-anchors the not-started schedule
//   U     after the first balance payment it refuses instead
//   V     a start month that has already gone refuses and raises a review
//   W     a known future start creates the first-of-month schedule
//   X/Y/Z pay-in-full, finite instalments, and the uneven phase structure
//   AA–AE a failing plan becomes visibly unhealthy and actionable
//   AF    production-shaped plans stay compatible
//
// The Stripe-object half (L/M/N: payment mode, setup_future_usage, abandoned
// Checkout) is proven in supabase/functions/stripe_webhook/*.test.ts and
// contracts/deals/depositCheckoutMechanics.test.ts, because this suite has
// no Stripe account to charge.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 991000;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

const rpc = async (fn: string, args: Record<string, unknown>) => {
  const { data, error } = await db().rpc(fn, args);
  ok(`${fn} itself`, { error });
  return data as Record<string, unknown>;
};

const firstOfMonth = (monthsAhead: number): string => {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, 1),
  );
  return d.toISOString().slice(0, 10);
};

/** A deposit-paying client: Won, enrolled, with the agreement frozen. */
const seed = async (
  n: number,
  lastName: string,
  {
    offerId = LE,
    total,
    installments,
    installmentAmount,
    deposit,
    startDate = null,
  }: {
    offerId?: number;
    total: number;
    installments: number;
    installmentAmount: number;
    deposit: number | null;
    startDate?: string | null;
  },
) => {
  const client = db();
  const contactId = BASE + n;

  ok(
    `contact ${n}`,
    await client.from("contacts").insert({
      id: contactId,
      first_name: "Deposit",
      last_name: lastName,
      email_jsonb: [{ email: `deposit${n}@pay.test`, type: "Work" }],
    }),
  );

  const { data: deal, error } = await client
    .from("deals")
    .insert({
      contact_id: contactId,
      offer_id: offerId,
      cohort_id: null,
      stage: "won",
      amount: total,
      entry_path: "other",
      description: "",
      selected_payment_total: total,
      selected_payment_total_source: "owner_confirmed",
      selected_installment_count: installments,
      selected_installment_amount: installmentAmount,
      selected_deposit_amount: deposit,
    })
    .select("id")
    .single();
  ok(`deal ${n}`, { error });
  const dealId = deal!.id as number;

  if (startDate) {
    ok(
      `start date ${n}`,
      await client
        .from("enrollments")
        .update({ start_date: startDate, start_date_source: "owner" })
        .eq("opportunity_id", dealId),
    );
  }
  return { contactId, dealId };
};

const payCents = async (
  dealId: number,
  cents: number,
  sequence: number,
  intent: string,
) =>
  ok(
    `payment ${intent}`,
    await db()
      .from("deal_payment_schedule_items")
      .insert({
        deal_id: dealId,
        amount: cents / 100,
        sequence,
        status: "paid",
        paid_on: new Date().toISOString().slice(0, 10),
        source: "stripe",
        stripe_payment_intent_id: intent,
      }),
  );

const plan = async (dealId: number) =>
  await rpc("plan_balance_schedule", { p_opportunity_id: dealId });

const openCheckPayments = async (dealId: number) => {
  const { data } = await db()
    .from("tasks")
    .select("id, status, done_date")
    .eq("opportunity_id", dealId)
    .eq("type", "check_payment");
  return (data ?? []).filter((task) => task.done_date == null);
};

test.describe("the decided plans, to the cent", () => {
  const cases: [string, string, number, number, number, number, number[]][] = [
    // label, surname, total, installments, stored amount, deposit, expected cents
    ["A. LE pay in full", "LePif", 4000, 1, 4000, 500, [350000]],
    ["B. LE 4-pay", "LeFour", 4000, 4, 1000, 500, [87500, 87500, 87500, 87500]],
    [
      "C. LE Financial Need 6-pay",
      "LeFn",
      3996,
      6,
      666,
      500,
      [58267, 58267, 58267, 58267, 58266, 58266],
    ],
    ["D. GYU pay in full", "GyuPif", 1400, 1, 1400, 400, [100000]],
    ["E. GYU 2-pay", "GyuTwo", 1400, 2, 700, 400, [50000, 50000]],
    [
      "F. GYU Financial Need 4-pay",
      "GyuFour",
      1400,
      4,
      350,
      400,
      [25000, 25000, 25000, 25000],
    ],
  ];

  for (const [
    label,
    surname,
    total,
    installments,
    amount,
    deposit,
    expected,
  ] of cases) {
    test(label, async () => {
      const { dealId } = await seed(
        cases.findIndex((c) => c[1] === surname) + 1,
        surname,
        {
          offerId: total > 2000 ? LE : GYU,
          total,
          installments,
          installmentAmount: amount,
          deposit,
          startDate: firstOfMonth(2),
        },
      );
      await payCents(dealId, deposit * 100, 1, `pi_dep_${dealId}`);

      const decision = await plan(dealId);
      expect(decision.status, JSON.stringify(decision)).toBe("ready");
      expect(decision.deposit_cents).toBe(deposit * 100);
      expect(decision.balance_cents).toBe((total - deposit) * 100);
      expect(decision.per_installment_cents).toEqual(expected);

      // G. and they sum to the balance exactly.
      const sum = (decision.per_installment_cents as number[]).reduce(
        (a, b) => a + b,
        0,
      );
      expect(sum).toBe(decision.balance_cents);

      // The anchor is the first of the start month, which the fixture set.
      expect(decision.balance_start_date).toBe(firstOfMonth(2));

      // And the SQL authority agrees with the TypeScript module, which is
      // the third leg of the cross-check in
      // contracts/deals/oneDepositAllocation.test.ts.
      expect(decision.per_installment_cents).toEqual(
        allocateBalanceCents((total - deposit) * 100, installments),
      );
    });
  }

  test("G. Postgres and TypeScript allocate identically across the whole range", async () => {
    for (const balance of [1, 7, 99, 100, 349600, 350000, 100001]) {
      for (const installments of [1, 2, 3, 4, 6, 12]) {
        const { data, error } = await db().rpc("allocate_balance_cents", {
          p_balance_cents: balance,
          p_installments: installments,
        });
        ok("allocate_balance_cents", { error });
        expect(
          (data as number[]).map(Number),
          `${balance} over ${installments}`,
        ).toEqual(allocateBalanceCents(balance, installments));
      }
    }
  });
});

test.describe("the catalogue authority", () => {
  test("H. a deposit cannot exceed the option's own total", async () => {
    const refused = await rpc("set_offer_payment_option", {
      p_offer_id: LE,
      p_name: "Too much",
      p_total: 1000,
      p_installments: 1,
      p_installment_amount: 1000,
      p_is_public: true,
      p_pricing_mode: "standard",
      p_option_id: null,
      p_deposit_amount: 1500,
    });
    expect(refused.status).toBe("deposit-exceeds-total");

    // And the database refuses it even if something bypassed the function.
    const { error } = await db().from("offer_payment_options").insert({
      offer_id: LE,
      name: "Smuggled",
      total: 1000,
      installments: 1,
      installment_amount: 1000,
      deposit_amount: 1500,
    });
    expect(error?.message ?? "", "the CHECK constraint").toContain(
      "offer_payment_options_deposit_amount_check",
    );
  });

  test("I. a referenced option version is replaced, never financially mutated", async () => {
    const added = await rpc("set_offer_payment_option", {
      p_offer_id: LE,
      p_name: "Versioned",
      p_total: 4000,
      p_installments: 4,
      p_installment_amount: 1000,
      p_is_public: false,
      p_pricing_mode: "standard",
      p_option_id: null,
      p_deposit_amount: 500,
    });
    const optionId = added.option_id as number;

    // Somebody agrees to it.
    const contactId = BASE + 40;
    ok(
      "contact",
      await db()
        .from("contacts")
        .insert({
          id: contactId,
          first_name: "Agreed",
          last_name: "Terms",
          email_jsonb: [{ email: "agreed@pay.test", type: "Work" }],
        }),
    );
    const { data: deal, error: dealError } = await db()
      .from("deals")
      .insert({
        contact_id: contactId,
        offer_id: LE,
        stage: "interested",
        amount: 4000,
        entry_path: "other",
        description: "",
        selected_payment_option_id: optionId,
        selected_payment_total: 4000,
        selected_installment_count: 4,
        selected_installment_amount: 1000,
        selected_deposit_amount: 500,
      })
      .select("id")
      .single();
    ok("deal", { error: dealError });

    // Leif changes the deposit.
    const replaced = await rpc("set_offer_payment_option", {
      p_offer_id: LE,
      p_name: "Versioned",
      p_total: 4000,
      p_installments: 4,
      p_installment_amount: 1000,
      p_is_public: false,
      p_pricing_mode: "standard",
      p_option_id: optionId,
      p_deposit_amount: 750,
    });
    expect(replaced.status).toBe("versioned");
    expect(replaced.replaced_option_id).toBe(optionId);
    expect(replaced.agreements_preserved).toBe(1);

    // The agreed version is untouched and retired; the Deal still points at
    // it and still carries the deposit it agreed to.
    const { data: old } = await db()
      .from("offer_payment_options")
      .select("deposit_amount, is_active")
      .eq("id", optionId)
      .single();
    expect(Number(old!.deposit_amount)).toBe(500);
    expect(old!.is_active).toBe(false);

    const { data: theirs } = await db()
      .from("deals")
      .select("selected_payment_option_id, selected_deposit_amount")
      .eq("id", deal!.id)
      .single();
    expect(theirs!.selected_payment_option_id).toBe(optionId);
    expect(Number(theirs!.selected_deposit_amount)).toBe(500);

    // The new version carries the new deposit.
    const { data: next } = await db()
      .from("offer_payment_options")
      .select("deposit_amount, replaces_option_id")
      .eq("id", replaced.option_id as number)
      .single();
    expect(Number(next!.deposit_amount)).toBe(750);
    expect(next!.replaces_option_id).toBe(optionId);
  });

  test("J. an option with no deposit behaves exactly as it always did", async () => {
    const added = await rpc("set_offer_payment_option", {
      p_offer_id: GYU,
      p_name: "No deposit",
      p_total: 1400,
      p_installments: 2,
      p_installment_amount: 700,
      p_is_public: false,
      p_pricing_mode: "standard",
      p_option_id: null,
      p_deposit_amount: null,
    });
    expect(added.status).toBe("added");
    const { data } = await db()
      .from("offer_payment_options")
      .select("deposit_amount")
      .eq("id", added.option_id as number)
      .single();
    expect(data!.deposit_amount).toBeNull();

    // And an option whose instalments do not add up is STILL refused: the
    // deposit relaxation did not touch that rule, because an option's
    // installment_amount is the PRE-deposit figure.
    const refused = await rpc("set_offer_payment_option", {
      p_offer_id: LE,
      p_name: "Does not add up",
      p_total: 4000,
      p_installments: 6,
      p_installment_amount: 666,
      p_is_public: false,
      p_pricing_mode: "standard",
      p_option_id: null,
      p_deposit_amount: 500,
    });
    expect(refused.status).toBe("instalments-do-not-add-up");
  });

  test("a Deal with no deposit is not in the deposit mechanism at all", async () => {
    const { dealId } = await seed(41, "Untouched", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: null,
      startDate: firstOfMonth(2),
    });
    expect((await plan(dealId)).status).toBe("no-deposit-plan");
  });
});

test.describe("when the balance may be scheduled, and when it may not", () => {
  test("Q. deposit paid with no start date schedules nothing", async () => {
    const { dealId } = await seed(50, "NoStart", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
    });
    await payCents(dealId, 50000, 1, `pi_dep_${dealId}`);

    const decision = await plan(dealId);
    expect(decision.status).toBe("start-date-unknown");

    // A valid, expected state -- not a problem, so no review is raised.
    expect(await openCheckPayments(dealId)).toHaveLength(0);
  });

  test("the deposit has to be in before a balance is scheduled", async () => {
    const { dealId } = await seed(51, "Unpaid", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
      startDate: firstOfMonth(2),
    });
    expect((await plan(dealId)).status).toBe("deposit-not-paid");

    // Part of it is not it.
    await payCents(dealId, 20000, 1, `pi_part_${dealId}`);
    expect((await plan(dealId)).status).toBe("deposit-not-paid");
  });

  test("W. a known future start month gives the first-of-month anchor", async () => {
    // Growing Yourself Up's cohort start is snapshotted onto the Enrollment
    // at Won, so the anchor exists immediately. A start week mid-month still
    // anchors the money on the 1st.
    const midMonth = firstOfMonth(3).replace(/-01$/, "-17");
    const { dealId } = await seed(52, "GyuCohort", {
      offerId: GYU,
      total: 1400,
      installments: 2,
      installmentAmount: 700,
      deposit: 400,
      startDate: midMonth,
    });
    await payCents(dealId, 40000, 1, `pi_dep_${dealId}`);

    const decision = await plan(dealId);
    expect(decision.status).toBe("ready");
    expect(decision.balance_start_date).toBe(firstOfMonth(3));
    expect(decision.per_installment_cents).toEqual([50000, 50000]);
  });

  test("V. a start month that has already gone refuses, and raises a review", async () => {
    const { dealId } = await seed(53, "PastDue", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
      startDate: firstOfMonth(-1),
    });
    await payCents(dealId, 50000, 1, `pi_dep_${dealId}`);

    const decision = await plan(dealId);
    expect(decision.status).toBe("balance-start-requires-review");
    expect(String(decision.reason)).toContain("already passed");

    // AC. exactly one review task, and asking again does not add another.
    expect(await openCheckPayments(dealId)).toHaveLength(1);
    await plan(dealId);
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    expect(await openCheckPayments(dealId)).toHaveLength(1);

    // AD. Leif states a workable month, and the review closes itself.
    ok(
      "a workable month",
      await db()
        .from("enrollments")
        .update({ start_date: firstOfMonth(2), start_date_source: "owner" })
        .eq("opportunity_id", dealId),
    );
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    expect(await openCheckPayments(dealId)).toHaveLength(0);
    expect((await plan(dealId)).status).toBe("ready");
  });

  test("U. after the first balance payment it refuses instead of rewriting history", async () => {
    const { dealId } = await seed(54, "Started", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
      startDate: firstOfMonth(1),
    });
    await payCents(dealId, 50000, 1, `pi_dep_${dealId}`);
    expect((await plan(dealId)).status).toBe("ready");

    // The first balance instalment lands.
    await payCents(dealId, 87500, 2, `pi_bal_${dealId}`);

    const decision = await plan(dealId);
    expect(decision.status).toBe("balance-already-started");
    expect(decision.balance_paid_cents).toBe(87500);
    expect(String(decision.reason)).toContain("financial history");
  });

  test("T/S. re-anchoring is idempotent, and the decision is stable", async () => {
    const { dealId } = await seed(55, "Reanchored", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
      startDate: firstOfMonth(2),
    });
    await payCents(dealId, 50000, 1, `pi_dep_${dealId}`);

    // S. asking repeatedly yields the same answer and changes nothing.
    const first = await plan(dealId);
    const again = await plan(dealId);
    expect(again).toEqual(first);

    // T. a changed start date moves the anchor, and nothing else.
    ok(
      "moved",
      await db()
        .from("enrollments")
        .update({ start_date: firstOfMonth(4), start_date_source: "owner" })
        .eq("opportunity_id", dealId),
    );
    const moved = await plan(dealId);
    expect(moved.status).toBe("ready");
    expect(moved.balance_start_date).toBe(firstOfMonth(4));
    expect(moved.per_installment_cents).toEqual(first.per_installment_cents);
  });

  test("a deposit that covers the whole total leaves nothing to schedule", async () => {
    const { dealId } = await seed(56, "FullDeposit", {
      offerId: GYU,
      total: 1400,
      installments: 1,
      installmentAmount: 1400,
      deposit: 1400,
      startDate: firstOfMonth(2),
    });
    await payCents(dealId, 140000, 1, `pi_dep_${dealId}`);
    expect((await plan(dealId)).status).toBe("nothing-to-schedule");
  });

  test("X/Y/Z. one iteration, finite iterations, and the uneven phases", async () => {
    // X. pay in full is one iteration, not a special case.
    const { dealId: pif } = await seed(57, "OneIteration", {
      total: 4000,
      installments: 1,
      installmentAmount: 4000,
      deposit: 500,
      startDate: firstOfMonth(2),
    });
    await payCents(pif, 50000, 1, `pi_dep_${pif}`);
    const one = await plan(pif);
    expect(one.phases).toEqual([{ iterations: 1, amount_cents: 350000 }]);

    // Y. an even plan is finite and single-phase.
    const { dealId: four } = await seed(58, "FourIterations", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
      startDate: firstOfMonth(2),
    });
    await payCents(four, 50000, 1, `pi_dep_${four}`);
    expect((await plan(four)).phases).toEqual([
      { iterations: 4, amount_cents: 87500 },
    ]);

    // Z. the uneven six-pay is TWO phases, in order, exact.
    const { dealId: six } = await seed(59, "SixUneven", {
      total: 3996,
      installments: 6,
      installmentAmount: 666,
      deposit: 500,
      startDate: firstOfMonth(2),
    });
    await payCents(six, 50000, 1, `pi_dep_${six}`);
    const uneven = await plan(six);
    expect(uneven.phases).toEqual([
      { iterations: 4, amount_cents: 58267 },
      { iterations: 2, amount_cents: 58266 },
    ]);
    const phaseSum = (
      uneven.phases as { iterations: number; amount_cents: number }[]
    ).reduce((a, p) => a + p.iterations * p.amount_cents, 0);
    expect(phaseSum).toBe(349600);
  });
});

test.describe("a plan that is not collecting says so", () => {
  const unhealthy = async (
    n: number,
    surname: string,
    status: string,
  ): Promise<number> => {
    const { dealId } = await seed(n, surname, {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
      startDate: firstOfMonth(1),
    });
    await payCents(dealId, 50000, 1, `pi_dep_${dealId}`);
    ok(
      "a plan object",
      await db()
        .from("deal_stripe_plan_objects")
        .insert({
          deal_id: dealId,
          stripe_object_id: `sub_health_${dealId}`,
          object_type: "subscription",
          status,
          is_current: true,
          link_source: "webhook",
        }),
    );
    return dealId;
  };

  test("AA/AC. a failed charge becomes unhealthy and raises exactly one review", async () => {
    const dealId = await unhealthy(60, "PastDuePlan", "past_due");

    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    expect(await openCheckPayments(dealId)).toHaveLength(1);

    // Running it again does not stack a second one.
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: null });
    expect(await openCheckPayments(dealId)).toHaveLength(1);
  });

  test("AB. requires-action is its own actionable state", async () => {
    const dealId = await unhealthy(61, "NeedsAuth", "incomplete");

    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    const open = await openCheckPayments(dealId);
    expect(open).toHaveLength(1);
    expect(open[0].status).toBe("pending");
  });

  test("AD. recovery closes the review", async () => {
    const dealId = await unhealthy(62, "Recovered", "past_due");
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    expect(await openCheckPayments(dealId)).toHaveLength(1);

    ok(
      "the plan recovers",
      await db()
        .from("deal_stripe_plan_objects")
        .update({ status: "active" })
        .eq("stripe_object_id", `sub_health_${dealId}`),
    );
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    expect(await openCheckPayments(dealId)).toHaveLength(0);
  });

  test("AE. a healthy plan object raises nothing", async () => {
    const dealId = await unhealthy(63, "Healthy", "active");
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    expect(await openCheckPayments(dealId)).toHaveLength(0);
  });
});

test.describe("AF. the shapes production actually holds stay compatible", () => {
  test("no deposit, a live subscription, and an agreed total are untouched", async () => {
    // The whole Won population: an agreed total on the Deal, no payment
    // option referenced, a Stripe plan found by reconciliation, and no
    // deposit anywhere.
    const { dealId } = await seed(70, "Historical", {
      total: 3700,
      installments: 1,
      installmentAmount: 3700,
      deposit: null,
      startDate: firstOfMonth(-6),
    });
    ok(
      "an imported plan",
      await db()
        .from("deal_stripe_plan_objects")
        .insert({
          deal_id: dealId,
          stripe_object_id: `sub_hist_${dealId}`,
          object_type: "subscription",
          status: "canceled",
          is_current: false,
          link_source: "historical_import",
        }),
    );
    await payCents(dealId, 370000, 1, `pi_hist_${dealId}`);

    // Not in the deposit mechanism, and no review raised about it.
    expect((await plan(dealId)).status).toBe("no-deposit-plan");
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    expect(await openCheckPayments(dealId)).toHaveLength(0);
  });

  test("the $3,996 Financial Need total is never rewritten", async () => {
    // Four production Deals carry it. The deposit mechanism reads it and
    // leaves it alone.
    const { dealId } = await seed(71, "ThirtyNineNinetySix", {
      total: 3996,
      installments: 6,
      installmentAmount: 666,
      deposit: 500,
      startDate: firstOfMonth(2),
    });
    await payCents(dealId, 50000, 1, `pi_dep_${dealId}`);

    const decision = await plan(dealId);
    expect(decision.agreed_total_cents).toBe(399600);

    const { data } = await db()
      .from("deals")
      .select("selected_payment_total")
      .eq("id", dealId)
      .single();
    expect(Number(data!.selected_payment_total)).toBe(3996);
  });
});
