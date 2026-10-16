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

    // AD. Leif states a workable month. The refusal stops being true and
    // the plan becomes ready -- but the Task does NOT close here, and this
    // assertion used to say it did.
    //
    // It was asserting the stranding hole. A Deal with a collected deposit,
    // a balance outstanding, a known future start month and NO SCHEDULE has
    // something outstanding by definition: that is the state the whole
    // convergence rule exists to forbid (see R-E .. R-H below). What
    // changes here is the Task's reason, from "the month has passed" to
    // "the balance is not scheduled yet".
    ok(
      "a workable month",
      await db()
        .from("enrollments")
        .update({ start_date: firstOfMonth(2), start_date_source: "owner" })
        .eq("opportunity_id", dealId),
    );
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    expect((await plan(dealId)).status).toBe("ready");
    const stillOpen = await openCheckPayments(dealId);
    expect(stillOpen, "still unscheduled, so still actionable").toHaveLength(1);
    const { data: moved } = await db()
      .from("tasks")
      .select("text")
      .eq("id", stillOpen[0].id)
      .single();
    expect(moved!.text).toContain("not scheduled yet");

    // AND NOW it closes -- when the schedule actually exists, which is the
    // only thing that ever answered the question.
    ok(
      "the schedule lands",
      await db()
        .from("deals")
        .update({ stripe_subscription_schedule_id: `sub_sched_${dealId}` })
        .eq("id", dealId),
    );
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    expect(await openCheckPayments(dealId)).toHaveLength(0);
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

// =====================================================================
// R-A .. R-J  THE CONVERGENCE BOUNDARY
// =====================================================================
// A separate lettering from A-AF above, because this is a separate
// question. Everything above asks whether the money is right. This asks
// what happens when the CRM and Stripe cannot agree, which they cannot do
// transactionally: enrollments.start_date commits first and the Stripe
// schedule is a consequence of it.
//
// THE INVARIANT. A Deal with a collected deposit, a balance outstanding and
// a usable future start month converges to EITHER
//
//   1. the correct current Stripe balance schedule, OR
//   2. a durable, actionable state that says why it has not got one.
//
// Never a third, silent state. And the two artefacts that carry (2) have
// deliberately different lifecycles:
//
//   check_payment Task            a CONDITION -- auto-closes when a
//                                 schedule exists (R-E, R-F, R-G, R-H)
//   payment_review_code =         a DECISION Leif owns after money has
//   'balance_schedule_frozen'     already moved -- never auto-closes
//                                 (R-A, R-B, R-C, R-D)

const review = async (dealId: number) => {
  const { data } = await db()
    .from("deals")
    .select(
      "payment_review_code, payment_review_reason, stripe_subscription_schedule_id",
    )
    .eq("id", dealId)
    .single();
  return data as {
    payment_review_code: string | null;
    payment_review_reason: string | null;
    stripe_subscription_schedule_id: string | null;
  };
};

const awaitingSchedule = async (): Promise<number[]> => {
  const { data, error } = await db().rpc("deals_awaiting_balance_schedule");
  ok("deals_awaiting_balance_schedule", { error });
  return ((data ?? []) as unknown[]).map(Number);
};

/** A deposit-paying LE client with a future start month and a schedule. */
const seedScheduled = async (n: number, lastName: string) => {
  const { dealId } = await seed(n, lastName, {
    total: 4000,
    installments: 4,
    installmentAmount: 1000,
    deposit: 500,
    startDate: firstOfMonth(3),
  });
  await payCents(dealId, 50000, 1, `pi_dep_${n}`);
  ok(
    `schedule id ${n}`,
    await db()
      .from("deals")
      .update({ stripe_subscription_schedule_id: `sub_sched_${n}` })
      .eq("id", dealId),
  );
  return dealId;
};

test.describe("after money has moved, the refusal is a decision Leif owns", () => {
  test("R-A. a start-month change after the first balance payment changes nothing in Stripe, and raises exactly one durable review", async () => {
    const dealId = await seedScheduled(300, "Charged");
    // The first balance instalment has succeeded.
    await payCents(dealId, 87500, 2, "pi_bal_300");

    const before = await review(dealId);
    expect(before.payment_review_code, "nothing is flagged yet").toBeNull();

    // Leif moves the start week. The date is saved either way; this is the
    // scheduling consequence, which must refuse.
    ok(
      "the start month moves",
      await db()
        .from("enrollments")
        .update({ start_date: firstOfMonth(6), start_date_source: "owner" })
        .eq("opportunity_id", dealId),
    );

    const decision = await plan(dealId);
    expect(decision.status, "re-anchoring is refused").toBe(
      "balance-already-started",
    );

    const raised = await rpc("flag_balance_schedule_frozen", {
      p_opportunity_id: dealId,
    });
    expect(raised.status).toBe("raised");

    const after = await review(dealId);
    expect(after.payment_review_code).toBe("balance_schedule_frozen");
    // It says what happened, what was NOT done, and what has been collected.
    expect(after.payment_review_reason).toContain("was NOT moved");
    expect(after.payment_review_reason).toContain("Nothing was charged");
    expect(after.payment_review_reason).toContain("$875.00");
    // AND STRIPE IS UNTOUCHED: the same schedule id, never rewritten.
    expect(
      after.stripe_subscription_schedule_id,
      "no schedule was rewritten or replaced",
    ).toBe("sub_sched_300");

    // The start date itself is still the truth Leif stated.
    const { data: enrollment } = await db()
      .from("enrollments")
      .select("start_date")
      .eq("opportunity_id", dealId)
      .single();
    expect(enrollment!.start_date).toBe(firstOfMonth(6));
  });

  test("R-B. asking again does not make a second artefact", async () => {
    const dealId = await seedScheduled(301, "Twice");
    await payCents(dealId, 87500, 2, "pi_bal_301");

    const first = await rpc("flag_balance_schedule_frozen", {
      p_opportunity_id: dealId,
    });
    expect(first.status).toBe("raised");
    const afterFirst = await review(dealId);

    for (const attempt of [2, 3]) {
      const again = await rpc("flag_balance_schedule_frozen", {
        p_opportunity_id: dealId,
      });
      expect(again.status, `attempt ${attempt}`).toBe("already-raised");
    }

    // Dedupe is structural -- one column on one Deal -- so there is nowhere
    // for a duplicate to live, and the sentence is not rewritten either.
    const afterRepeats = await review(dealId);
    expect(afterRepeats.payment_review_reason).toBe(
      afterFirst.payment_review_reason,
    );
  });

  test("R-B2. it never overwrites a different review somebody else raised", async () => {
    const dealId = await seedScheduled(302, "Occupied");
    await payCents(dealId, 87500, 2, "pi_bal_302");
    ok(
      "an owner's own flag",
      await db()
        .from("deals")
        .update({
          payment_review_reason: "Leif flagged this to look at.",
          payment_review_code: "owner_flagged",
        })
        .eq("id", dealId),
    );

    const result = await rpc("flag_balance_schedule_frozen", {
      p_opportunity_id: dealId,
    });
    expect(result.status).toBe("another-review-stands");
    const still = await review(dealId);
    expect(still.payment_review_code).toBe("owner_flagged");
    expect(still.payment_review_reason).toBe("Leif flagged this to look at.");
  });

  test("R-C. payment-health reconciliation cannot close it, however healthy the plan becomes", async () => {
    const dealId = await seedScheduled(303, "Recovered");
    await payCents(dealId, 87500, 2, "pi_bal_303");
    await rpc("flag_balance_schedule_frozen", { p_opportunity_id: dealId });

    // The card fails, a Task is raised, the card recovers, the Task closes.
    ok(
      "a failing plan",
      await db().from("deal_stripe_plan_objects").insert({
        deal_id: dealId,
        stripe_object_id: `sub_303`,
        object_type: "subscription",
        status: "past_due",
        is_current: true,
        link_source: "webhook",
      }),
    );
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    expect((await openCheckPayments(dealId)).length).toBe(1);

    ok(
      "recovery",
      await db()
        .from("deal_stripe_plan_objects")
        .update({ status: "active" })
        .eq("deal_id", dealId),
    );
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: null });
    expect(
      (await openCheckPayments(dealId)).length,
      "the condition closed itself",
    ).toBe(0);

    // The decision did not. Recovery of a card answers nothing about
    // whether a charged schedule should be re-anchored.
    const survived = await review(dealId);
    expect(survived.payment_review_code).toBe("balance_schedule_frozen");
    expect(survived.payment_review_reason).toContain("was NOT moved");
  });

  test("R-D. a person closes it, exactly the way they close any payment review", async () => {
    const dealId = await seedScheduled(304, "Resolved");
    await payCents(dealId, 87500, 2, "pi_bal_304");
    await rpc("flag_balance_schedule_frozen", { p_opportunity_id: dealId });
    // Assert it is actually there before closing it. Without this, a build
    // that never raised the review at all would pass this test by
    // accident -- which is exactly what sensitivity break 1 showed.
    expect((await review(dealId)).payment_review_code).toBe(
      "balance_schedule_frozen",
    );

    // What PaymentPanel's "Mark reviewed" writes. BOTH columns: clearing
    // only the sentence would leave the code standing and the warning up.
    ok(
      "mark reviewed",
      await db()
        .from("deals")
        .update({ payment_review_reason: null, payment_review_code: null })
        .eq("id", dealId),
    );
    const cleared = await review(dealId);
    expect(cleared.payment_review_code).toBeNull();
    expect(cleared.payment_review_reason).toBeNull();

    // And nothing brings it back on its own: it was an event, not a
    // condition, so no reconciler re-raises it.
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: dealId });
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: null });
    expect((await review(dealId)).payment_review_code).toBeNull();
  });
});

test.describe("before money has moved, an unscheduled balance is never silent", () => {
  test("R-E. a saved start month whose Stripe call failed keeps the date and becomes actionable", async () => {
    // The exact shape of a transient provider failure: start_date committed,
    // deposit collected, balance owed, and no schedule to show for it.
    const { dealId } = await seed(310, "Transient", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
      startDate: firstOfMonth(3),
    });
    await payCents(dealId, 50000, 1, "pi_dep_310");

    // THE DATE IS STILL THE FACT.
    const { data: enrollment } = await db()
      .from("enrollments")
      .select("start_date")
      .eq("opportunity_id", dealId)
      .single();
    expect(enrollment!.start_date, "the date Leif stated survived").toBe(
      firstOfMonth(3),
    );

    // AND IT IS NOT STRANDED: both halves of the convergence rule name it.
    expect(await awaitingSchedule()).toContain(dealId);
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: null });
    const open = await openCheckPayments(dealId);
    expect(open.length, "exactly one actionable Task").toBe(1);

    const { data: task } = await db()
      .from("tasks")
      .select("text")
      .eq("id", open[0].id)
      .single();
    expect(task!.text).toContain("not scheduled yet");
  });

  test("R-F. the later retry succeeds, there is one schedule, and the Task closes itself", async () => {
    const { dealId } = await seed(311, "Retried", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
      startDate: firstOfMonth(3),
    });
    await payCents(dealId, 50000, 1, "pi_dep_311");
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: null });
    expect((await openCheckPayments(dealId)).length).toBe(1);

    // The decision is unchanged and still ready, so the retry asks for the
    // same anchor and the same cents -- which is why one schedule, not two.
    const decision = await plan(dealId);
    expect(decision.status).toBe("ready");
    expect(decision.balance_start_date).toBe(firstOfMonth(3));

    // What ensureBalanceSchedule() writes when it finally succeeds.
    ok(
      "the schedule lands",
      await db()
        .from("deals")
        .update({ stripe_subscription_schedule_id: "sub_sched_311" })
        .eq("id", dealId),
    );

    expect(
      await awaitingSchedule(),
      "nothing left to retry for this Deal",
    ).not.toContain(dealId);
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: null });
    expect(
      (await openCheckPayments(dealId)).length,
      "the transient issue reconciled itself",
    ).toBe(0);
  });

  test("R-G. a start month that has already gone gets no schedule and a durable review", async () => {
    const { dealId } = await seed(312, "PastDue", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
      startDate: firstOfMonth(0),
    });
    await payCents(dealId, 50000, 1, "pi_dep_312");

    const decision = await plan(dealId);
    expect(decision.status).toBe("balance-start-requires-review");
    expect(decision.phases, "no plan was produced to execute").toBeUndefined();
    // Not a retry candidate: a sweep must never resolve this by charging a
    // backdated month.
    expect(await awaitingSchedule()).not.toContain(dealId);

    const open = await openCheckPayments(dealId);
    expect(open.length).toBe(1);
    const { data: task } = await db()
      .from("tasks")
      .select("text")
      .eq("id", open[0].id)
      .single();
    expect(task!.text).toContain("already passed");
  });

  test("R-H. the silent third state does not exist", async () => {
    // Every Deal that has paid a deposit, owes a balance and has a usable
    // future start month is in state 1 or state 2. Never neither.
    const { dealId } = await seed(313, "NeverSilent", {
      total: 3996,
      installments: 6,
      installmentAmount: 666,
      deposit: 500,
      startDate: firstOfMonth(2),
    });
    await payCents(dealId, 50000, 1, "pi_dep_313");

    const classify = async () => {
      const row = await review(dealId);
      await rpc("reconcile_payment_health_tasks", { p_opportunity_id: null });
      return {
        scheduled: row.stripe_subscription_schedule_id != null,
        actionable:
          (await openCheckPayments(dealId)).length > 0 ||
          row.payment_review_code != null,
      };
    };

    // Unscheduled: actionable.
    let state = await classify();
    expect(state.scheduled).toBe(false);
    expect(state.actionable, "unscheduled and unflagged is forbidden").toBe(
      true,
    );

    // Scheduled: no longer actionable, because there is nothing to act on.
    ok(
      "the schedule lands",
      await db()
        .from("deals")
        .update({ stripe_subscription_schedule_id: "sub_sched_313" })
        .eq("id", dealId),
    );
    state = await classify();
    expect(state.scheduled).toBe(true);
    expect(state.actionable).toBe(false);
  });

  test("R-J. a Living Example client with no start week yet is waiting, not stranded", async () => {
    const { dealId } = await seed(314, "NoStartWeek", {
      total: 4000,
      installments: 4,
      installmentAmount: 1000,
      deposit: 500,
      startDate: null,
    });
    await payCents(dealId, 50000, 1, "pi_dep_314");

    expect((await plan(dealId)).status).toBe("start-date-unknown");
    // Nothing to retry and nothing to chase: the start week is Leif's to
    // state and StartWeekCard already asks for it. Raising a payment Task
    // here would be the CRM inventing a problem out of its own ignorance.
    expect(await awaitingSchedule()).not.toContain(dealId);
    await rpc("reconcile_payment_health_tasks", { p_opportunity_id: null });
    expect((await openCheckPayments(dealId)).length).toBe(0);
    expect((await review(dealId)).payment_review_code).toBeNull();
  });
});

test.describe("R-I. Growing Yourself Up converges without anyone opening a screen", () => {
  test("a cohort start date at Won is enough, on its own, to make the balance schedulable", async () => {
    const client = db();
    const start = firstOfMonth(4);
    const { data: cohort, error: cohortError } = await client
      .from("cohorts")
      .insert({
        offer_id: GYU,
        name: `Deposit convergence ${Date.now()}`,
        status: "active",
        program_start_at: start,
      })
      .select("id")
      .single();
    ok("the cohort", { error: cohortError });

    const contactId = BASE + 320;
    ok(
      "contact",
      await client.from("contacts").insert({
        id: contactId,
        first_name: "Deposit",
        last_name: "Cohort",
        email_jsonb: [{ email: "deposit320@pay.test", type: "Work" }],
      }),
    );

    // The deposit webhook's own sequence: the sale is Won, and
    // handle_deal_won() snapshots the cohort start onto the Enrollment.
    // NOTHING here touches a Start Week screen.
    const { data: deal, error } = await client
      .from("deals")
      .insert({
        contact_id: contactId,
        offer_id: GYU,
        cohort_id: cohort!.id,
        stage: "won",
        amount: 1400,
        entry_path: "other",
        description: "",
        selected_payment_total: 1400,
        selected_payment_total_source: "owner_confirmed",
        selected_installment_count: 2,
        selected_installment_amount: 700,
        selected_deposit_amount: 400,
      })
      .select("id")
      .single();
    ok("the GYU deal", { error });
    const dealId = deal!.id as number;

    const { data: enrollment } = await client
      .from("enrollments")
      .select("start_date, start_date_source")
      .eq("opportunity_id", dealId)
      .single();
    expect(
      enrollment!.start_date,
      "the cohort gave the Enrollment its start date at Won",
    ).toBe(start);

    await payCents(dealId, 40000, 1, "pi_dep_320");

    // The anchor exists the moment the deposit lands, so the webhook's own
    // ensureBalanceSchedule() call has everything it needs.
    const decision = await plan(dealId);
    expect(decision.status, "schedulable with no further human action").toBe(
      "ready",
    );
    expect(decision.balance_start_date).toBe(start);
    expect(decision.phases).toEqual([{ iterations: 2, amount_cents: 50000 }]);

    // And if that one attempt had failed, the hourly sweep retries exactly
    // this Deal -- which is what makes it independent of a UI save rather
    // than merely usually independent of one.
    expect(await awaitingSchedule()).toContain(dealId);

    ok(
      "cleanup",
      await client
        .from("cohorts")
        .update({ status: "completed" })
        .eq("id", cohort!.id),
    );
  });
});
