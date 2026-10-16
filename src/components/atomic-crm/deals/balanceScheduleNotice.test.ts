import { describe, expect, it } from "vitest";

import { balanceScheduleNotice } from "./scheduleBalance";

// WHAT LEIF HEARS WHEN THE SCHEDULE DOES NOT FOLLOW THE DATE.
//
// Saving a start week commits the date and then asks for the balance
// schedule, and those are two systems that cannot share a transaction. The
// date is the fact and is reported on its own; this is the second sentence,
// and it exists because the first version of this flow discarded the
// scheduling answer entirely -- `void scheduleBalanceForOpportunity(...)`.
//
// Two rules, both load-bearing:
//
//   every notice says the start week IS saved, because it is, and the only
//   reason to mention the schedule is that she might assume it followed
//
//   silence is for outcomes she cannot act on, never for outcomes that
//   merely did not succeed

describe("the outcomes Leif is told about", () => {
  it("say the start week is saved first, every time", () => {
    for (const status of [
      "balance-already-started",
      "balance-start-requires-review",
      "no-payment-method",
      "deferred",
      "stripe-not-configured",
    ]) {
      const notice = balanceScheduleNotice(status);
      expect(notice, status).not.toBeNull();
      expect(notice, status).toContain("The start week is saved.");
    }
  });

  it("send a refused re-anchor to the Opportunity, where the durable review lives", () => {
    const notice = balanceScheduleNotice("balance-already-started")!;
    expect(notice).toContain("already begun collecting");
    expect(notice).toContain("was not moved");
    expect(notice).toContain("flagged for review on the Opportunity");
  });

  it("send a past start month to the payment task, which is where that one lives", () => {
    const notice = balanceScheduleNotice("balance-start-requires-review")!;
    expect(notice).toContain("already passed");
    expect(notice).toContain("payment task");
  });

  it("promise a retry for a provider failure, and a task if it keeps failing", () => {
    // Both halves are true: deals_awaiting_balance_schedule() is swept
    // hourly, and premise C raises a check_payment while it is unscheduled.
    const notice = balanceScheduleNotice("deferred")!;
    expect(notice).toContain("retried automatically");
    expect(notice).toContain("payment task will appear");
  });

  it("never claim a card exists when there is none", () => {
    expect(balanceScheduleNotice("no-payment-method")).toContain(
      "no saved card",
    );
  });
});

describe("the outcomes that are not worth a word", () => {
  it("stay silent when the schedule is right", () => {
    for (const status of ["created", "updated", "unchanged"]) {
      expect(balanceScheduleNotice(status), status).toBeNull();
    }
  });

  it("stay silent when there was never a balance to schedule", () => {
    // These are the ordinary life of a Deal, not news: no deposit on this
    // agreement, the deposit has not arrived, the deposit covered the
    // total, the start week is not stated yet. Warning on any of them would
    // train Leif to dismiss the warnings that matter.
    for (const status of [
      "no-deposit-plan",
      "deposit-not-paid",
      "nothing-to-schedule",
      "start-date-unknown",
      "not-won",
      "not-found",
      "terms-unknown",
      "enrollment-missing",
      "invalid-opportunity",
    ]) {
      expect(balanceScheduleNotice(status), status).toBeNull();
    }
  });
});
