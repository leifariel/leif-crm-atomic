import { getSupabaseClient } from "../providers/supabase/supabase";

// "Leif has stated the start week — schedule what is left."
//
// The balance's anchor is the first calendar day of the client's programme
// start month, derived from enrollments.start_date. That date is Leif's to
// state, so this is called the moment she states it: the schedule exists
// straight away rather than up to an hour later when the sweep next runs.
//
// THE BROWSER DECIDES NOTHING. It sends an Opportunity id. Everything that
// is money — the exact cents, the anchor, whether it is safe to schedule at
// all — is decided by plan_balance_schedule() in Postgres, which no client
// role can execute, and executed by the Edge Function, which is where the
// Stripe credentials live. supabase.functions.invoke sends the signed-in
// user's own JWT and the function verifies it.
//
// IDEMPOTENT BY DESIGN, so calling it twice is harmless and so is not
// calling it at all: the hourly reconciler sweeps the same decision, and
// ensureBalanceSchedule() reads the stored schedule id and the live Stripe
// object before creating anything.

export type ScheduleBalanceResult = {
  /**
   * Repo-native vocabulary, straight from plan_balance_schedule() plus the
   * executor's own outcomes. Every one of them is a legitimate answer:
   *
   *   created / updated / unchanged      the schedule is right
   *   start-date-unknown                 Leif has not stated a start week
   *   deposit-not-paid                   nothing to schedule against yet
   *   no-deposit-plan                    this agreement has no deposit
   *   nothing-to-schedule                the deposit covered the total
   *   balance-start-requires-review      the 1st has already passed
   *   balance-already-started            a balance payment has succeeded
   *   no-payment-method                  no saved card to charge
   */
  status: string;
  detail?: Record<string, unknown>;
};

export const scheduleBalanceForOpportunity = async (
  opportunityId: number | string,
): Promise<ScheduleBalanceResult> => {
  const dealId = Number(opportunityId);
  if (!Number.isInteger(dealId) || dealId <= 0) {
    return { status: "invalid-opportunity" };
  }

  const { data, error } = await getSupabaseClient().functions.invoke<{
    status?: string;
    detail?: Record<string, unknown>;
  }>(`stripe_webhook?action=schedule-balance&dealId=${dealId}`, {
    method: "POST",
    body: {},
  });

  // A failure here must never look like a refusal, and must never block the
  // start-week save that prompted it: the date is the fact, the schedule is
  // a consequence, and the hourly sweep will try again.
  if (error || !data?.status) return { status: "deferred" };
  return { status: data.status, detail: data.detail };
};
