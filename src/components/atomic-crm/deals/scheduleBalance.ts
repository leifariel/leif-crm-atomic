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
// calling it at all: the hourly reconcile-stripe job sweeps
// deals_awaiting_balance_schedule() and retries exactly this, and
// ensureBalanceSchedule() reads the stored schedule id and the live Stripe
// object before creating anything.
//
// THE DATE IS STILL THE FACT. This never changes the start-week verdict --
// that was decided by the row the database wrote. But it is no longer
// discarded either: an outcome Leif can do something about is said out
// loud, and every outcome at all converges to a schedule or to a durable
// artefact (a check_payment Task for a condition, a payment review for the
// decision she owns), so nothing is lost when she closes the page.

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

/**
 * What Leif needs to hear about an outcome, or null when there is nothing
 * to say.
 *
 * Every message states the start week IS saved first, because it is, and
 * because the only reason to mention the schedule at all is that she might
 * otherwise assume it followed. The silent statuses are the ones where
 * either the schedule is right (created / updated / unchanged) or the
 * agreement never had a balance to schedule.
 */
export const balanceScheduleNotice = (status: string): string | null => {
  switch (status) {
    case "balance-already-started":
      return "The start week is saved. The remaining balance has already begun collecting, so the payment schedule was not moved — it is flagged for review on the Opportunity.";
    case "balance-start-requires-review":
      return "The start week is saved. The 1st of that month has already passed, so the remaining balance was not scheduled — there is a payment task to look at.";
    case "no-payment-method":
      return "The start week is saved. There is no saved card for this client, so the remaining balance could not be scheduled.";
    case "deferred":
    case "stripe-not-configured":
      return "The start week is saved. The payment schedule could not be reached just now — it will be retried automatically, and a payment task will appear if it keeps failing.";
    default:
      return null;
  }
};
