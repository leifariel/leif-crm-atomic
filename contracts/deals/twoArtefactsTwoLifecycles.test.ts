// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// TWO ARTEFACTS, TWO LIFECYCLES, AND THEY MUST NOT MERGE.
//
// An unscheduled balance and a refused re-anchor are both "the schedule is
// not what it should be", and that resemblance is the trap. They are
// opposite kinds of thing:
//
//   a check_payment Task is a CONDITION. Deposit in, balance owed, start
//   month usable, no schedule. It holds until a schedule exists and then
//   stops, so the same declarative query opens and closes it, and a
//   successful retry needs no bookkeeping at all.
//
//   payment_review_code = 'balance_schedule_frozen' is an EVENT. Somebody
//   asked to move a start month after money had already moved and the CRM
//   refused. That never stops being true, nothing about the client's
//   account is wrong, and recovery of a card answers none of it. Only a
//   person can close it.
//
// Put the event in the reconciler and it closes on the next pass. Put the
// condition in the column and a successful schedule leaves a stale warning
// up forever. This file is what notices either happening.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relative: string) =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const MIGRATION = read(
  "supabase/migrations/20261016140000_a_deposit_is_credited_not_charged_twice.sql",
);
const WEBHOOK = read("supabase/functions/stripe_webhook/index.ts");
const PANEL = read("src/components/atomic-crm/deals/PaymentPanel.tsx");

/** One `create or replace function` body, comments stripped. */
const functionBody = (sql: string, name: string): string => {
  const from = sql.indexOf(`create or replace function public.${name}(`);
  expect(from, `${name} is defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$fn$;", from);
  expect(end, `${name} is terminated`).toBeGreaterThan(from);
  return sql
    .slice(from, end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
};

describe("the condition reconciler cannot touch the decision", () => {
  const body = functionBody(MIGRATION, "reconcile_payment_health_tasks");

  it("never reads or writes a payment review column", () => {
    // The whole protection for the human-owned artefact: the reconciler
    // writes `tasks` and nothing else, so no amount of recovery, retry or
    // sweeping can erase a question Leif has not answered.
    expect(body).not.toContain("payment_review");
  });

  it("writes only the tasks table", () => {
    const written = [...body.matchAll(/\b(?:insert into|update)\s+(\w+)/g)].map(
      (match) => match[1],
    );
    expect(written.length).toBeGreaterThan(0);
    expect([...new Set(written)]).toEqual(["tasks"]);
  });

  it("closes a Task by recomputing the premises rather than restating them", () => {
    // Opening and closing drifting apart is the classic failure of this
    // shape, and a third premise made it very easy: the close clause used
    // to repeat each premise inverted by hand.
    expect(body).toContain(
      "and not exists (select 1 from premises pr where pr.deal_id = t.opportunity_id)",
    );
  });

  it("carries all three premises, including the one that closes the stranding hole", () => {
    for (const premise of [
      "plan_not_collecting",
      "balance_start_requires_review",
      "balance_not_scheduled",
    ]) {
      expect(body, premise).toContain(premise);
    }
  });
});

describe("the decision is raised only by the thing that refused", () => {
  const body = functionBody(MIGRATION, "flag_balance_schedule_frozen");

  it("writes only the deal's review columns, never a task", () => {
    expect(body).toContain("payment_review_reason = v_reason");
    expect(body).toContain("payment_review_code = 'balance_schedule_frozen'");
    expect(body).not.toContain("insert into tasks");
  });

  it("refuses to stack on any review that is already standing", () => {
    expect(body).toContain("if v_deal.payment_review_reason is not null");
    expect(body).toContain("or v_deal.payment_review_code is not null");
    expect(body).toContain("another-review-stands");
    expect(body).toContain("already-raised");
  });

  it("derives its own context instead of being handed any", () => {
    // It takes one Opportunity id. A caller cannot tell it a start month or
    // an amount, so the sentence it writes cannot be wrong about the
    // database it was written from.
    expect(MIGRATION).toContain(
      "create or replace function public.flag_balance_schedule_frozen(\n  p_opportunity_id bigint\n) returns jsonb",
    );
    expect(body).toContain("from enrollments e");
    expect(body).toContain("from deal_payment_schedule_items");
  });

  it("is reachable only by the service", () => {
    expect(MIGRATION).toContain(
      "revoke all on function public.flag_balance_schedule_frozen(bigint) from public, anon, authenticated;",
    );
    expect(MIGRATION).not.toMatch(
      /grant execute on function public\.flag_balance_schedule_frozen\(bigint\) to (authenticated|anon)/,
    );
  });
});

describe("the retry list and the Task premise are the same predicate", () => {
  const sweep = functionBody(MIGRATION, "deals_awaiting_balance_schedule");

  it("both require a usable FUTURE start month and no schedule", () => {
    // If these drifted, the CRM would raise a Task for Deals it never
    // retries, or retry Deals it never tells anybody about.
    expect(sweep).toContain(
      "date_trunc('month', e.start_date)::date > current_date",
    );
    expect(sweep).toContain("d.stripe_subscription_schedule_id is null");
    const reconciler = functionBody(
      MIGRATION,
      "reconcile_payment_health_tasks",
    );
    expect(reconciler).toContain(
      "o.anchor > current_date and o.schedule_id is null",
    );
  });

  it("a past start month is never a retry candidate", () => {
    // The past-due month raises a review instead. A sweep that treated it
    // as retryable would be a sweep that backdates a charge.
    expect(sweep).not.toContain("<= current_date");
  });
});

describe("the webhook wires both lifecycles to the right trigger", () => {
  it("raises the decision only for a person's own refused request", () => {
    expect(WEBHOOK).toContain(
      'if (!isCron && scheduled.status === "balance-already-started") {',
    );
    expect(WEBHOOK).toContain('"flag_balance_schedule_frozen"');
  });

  it("sweeps pending balances AND reconciles health on every reconcile path", () => {
    // Two call sites: the fleet-wide hourly cron and the single-contact
    // sync. The cron path did neither before -- an hourly job whose whole
    // purpose is convergence was converging only the money.
    //
    // The ORDER is the assertion, not the count: the sweep has to run
    // first, so a schedule it creates closes its own Task in the same pass
    // instead of leaving a warning up for an hour. (There is a third
    // reconcilePaymentHealth(null) in the failed-charge handler, which is
    // not a reconcile path and deliberately does not sweep.)
    const sweeps = [
      ...WEBHOOK.matchAll(/await sweepPendingBalanceSchedules\(stripe\);/g),
    ];
    expect(sweeps).toHaveLength(2);
    for (const sweep of sweeps) {
      const after = WEBHOOK.slice(sweep.index!, sweep.index! + 200);
      expect(
        after,
        "the sweep is followed by a health reconciliation",
      ).toContain("await reconcilePaymentHealth(null);");
    }
  });

  it("never fails a run over one client's provider error", () => {
    const from = WEBHOOK.indexOf("const sweepPendingBalanceSchedules");
    const body = WEBHOOK.slice(from, WEBHOOK.indexOf("const fetchDeal", from));
    expect(body).toContain("try {");
    expect(body).toContain('count("error")');
  });
});

describe("a stored review can actually be closed", () => {
  it("Mark reviewed clears the code as well as the sentence", () => {
    // paymentTruth falls back to the stored code whenever a stored reason
    // exists, so clearing one column of two raises the same warning
    // forever -- the Emma Wijns failure, one column along.
    expect(PANEL).toContain(
      "data: { payment_review_reason: null, payment_review_code: null },",
    );
  });
});

describe("Growing Yourself Up never waits for a screen to be opened", () => {
  it("the deposit webhook schedules the balance itself, after the sale", () => {
    // GYU takes its start authority from the cohort at Won, so the anchor
    // exists the moment the deposit lands and nothing needs Leif. This is
    // the PRIMARY mechanism -- the hourly sweep is only the backstop -- and
    // it had no test at all until a sensitivity break went looking for one.
    const sale = WEBHOOK.indexOf(
      "const result = await recordDealPaymentSucceeded(",
    );
    const schedule = WEBHOOK.indexOf(
      "const scheduled = await ensureBalanceSchedule(stripe, deal.id);",
    );
    expect(sale, "the sale is recorded").toBeGreaterThan(-1);
    expect(schedule, "the balance is scheduled in the webhook").toBeGreaterThan(
      -1,
    );
    expect(
      schedule,
      "scheduled AFTER the sale, which creates the Enrollment",
    ).toBeGreaterThan(sale);
    expect(WEBHOOK.slice(sale, schedule)).toContain("if (isDeposit) {");
  });

  it("and a provider failure there never fails the delivery", () => {
    // Stripe retries a failed delivery, and the deposit, the sale and the
    // money have already landed by this point. The condition is declarative
    // and the sweep retries, so being late is recoverable; replaying the
    // whole delivery is not.
    const from = WEBHOOK.indexOf('let balance = "skipped";');
    expect(from).toBeGreaterThan(-1);
    const body = WEBHOOK.slice(from, from + 900);
    expect(body).toContain("try {");
    expect(body).toContain("catch (error) {");
    expect(body).toContain('balance = "deferred";');
  });
});
