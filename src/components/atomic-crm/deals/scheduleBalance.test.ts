import { beforeEach, describe, expect, it, vi } from "vitest";

// A BALANCE THAT CANNOT BE SCHEDULED FROM THE BROWSER IS DEFERRED, NEVER
// THROWN.
//
// ClientEditModal asks for the balance schedule the moment a start week is
// saved, and deliberately does not await it. So this function must resolve
// on every path: a rejection has nowhere to go, and escaped as an unhandled
// one — six in the unit suite, `supabaseUrl is required.` — while the
// "it will be retried automatically" notice Leif should have seen was never
// shown. "deferred" is the honest answer: deals_awaiting_balance_schedule()
// is swept hourly, and reconcile_payment_health_tasks() raises a
// check_payment Task for the same Deals.

const invoke = vi.fn();
const getSupabaseClient = vi.fn(() => ({ functions: { invoke } }));
vi.mock("../providers/supabase/supabase", () => ({
  getSupabaseClient: () => getSupabaseClient(),
}));

const { scheduleBalanceForOpportunity, balanceScheduleNotice } = await import(
  "./scheduleBalance"
);

describe("scheduleBalanceForOpportunity resolves on every path", () => {
  beforeEach(() => {
    invoke.mockReset();
    getSupabaseClient.mockReset();
    getSupabaseClient.mockImplementation(() => ({ functions: { invoke } }));
  });

  it("a client that cannot be built is deferred, not thrown", async () => {
    getSupabaseClient.mockImplementation(() => {
      throw new Error("supabaseUrl is required.");
    });
    await expect(scheduleBalanceForOpportunity(42)).resolves.toEqual({
      status: "deferred",
    });
  });

  it("an invoke that rejects is deferred, not thrown", async () => {
    invoke.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(scheduleBalanceForOpportunity(42)).resolves.toEqual({
      status: "deferred",
    });
  });

  it("an invoke that reports an error is deferred", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("500") });
    await expect(scheduleBalanceForOpportunity(42)).resolves.toEqual({
      status: "deferred",
    });
  });

  it("a real answer is passed through unchanged", async () => {
    invoke.mockResolvedValue({
      data: { status: "created", detail: { iterations: 6 } },
      error: null,
    });
    await expect(scheduleBalanceForOpportunity(42)).resolves.toEqual({
      status: "created",
      detail: { iterations: 6 },
    });
    expect(invoke).toHaveBeenCalledWith(
      "stripe_webhook?action=schedule-balance&dealId=42",
      { method: "POST", body: {} },
    );
  });

  it("an id that is not one never reaches the network", async () => {
    await expect(scheduleBalanceForOpportunity("abc")).resolves.toEqual({
      status: "invalid-opportunity",
    });
    expect(getSupabaseClient).not.toHaveBeenCalled();
  });

  it("deferred is said out loud, with the retry that makes it true", () => {
    expect(balanceScheduleNotice("deferred")).toMatch(
      /retried automatically.*payment task/,
    );
  });
});
