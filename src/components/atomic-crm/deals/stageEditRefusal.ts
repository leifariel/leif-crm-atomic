// A raw stage edit may not contradict the recorded call result.
//
// THE CASE THAT PRODUCED THIS (Porsche Brown, Opportunity 217,
// 2026-10-29). Her call was completed as "they said yes", which won the
// sale and created an Enrollment. Twenty-three seconds later the
// Opportunity's stage was changed by hand to Decision, to fix the result.
// The stage moved; nothing else did. She was left at
//
//   stage = decision · prospect_decision = yes · follow_up_date = null
//   · no Decision follow-up Task · her Enrollment withdrawn
//
// — a sale at Decision whose own record says the prospect already said
// yes. No path in the CRM could produce that on purpose. The right tool was
// Edit call result (correct_completed_sales_call), which changes the
// decision AND the stage AND the follow-up together, and audits it.
//
// So a stage edit that would leave "they said yes" on a sale that is not
// Won is refused, with a message that names the right tool. It is not
// silently converted into a call correction: a stage field must not
// quietly become a second way to rewrite what happened on a call.
//
// The authority is the database trigger guard_deal_stage_against_call_result
// (migration 20261112130000). This is its mirror for FakeRest, and the
// translator from its refusal to words Leif can act on.

/** The token the database puts in its refusal, so the app can recognise it. */
export const CALL_RESULT_OWNS_STAGE = "call_result_owns_stage";

export type CallResultStageFields = {
  stage?: string | null;
  prospect_decision?: string | null;
  outcome?: string | null;
  archived_at?: string | null;
};

/**
 * "They said yes", on a sale that is still open and not Won.
 *
 * Won is where yes lands (accept_sale writes both together). An ended
 * (outcome set) or archived sale is not on the board and is not making a
 * claim about where the sale is.
 */
export const contradictsCallResult = (deal: CallResultStageFields): boolean =>
  deal.prospect_decision === "yes" &&
  deal.outcome == null &&
  deal.archived_at == null &&
  deal.stage !== "won";

/**
 * Would this write leave the Opportunity contradicting its call result?
 *
 * A row that ALREADY contradicts it (Porsche, today) may still have unrelated
 * fields edited — refusing her amount or description would only make the
 * record harder to repair. What is refused is entering the contradiction, or
 * moving the stage while in it.
 */
export const stageEditContradictsCallResult = (
  previous: CallResultStageFields,
  next: CallResultStageFields,
): boolean =>
  contradictsCallResult(next) &&
  !(
    contradictsCallResult(previous) &&
    next.stage === previous.stage &&
    next.prospect_decision === previous.prospect_decision
  );

export const CALL_RESULT_OWNS_STAGE_MESSAGE =
  "This sale's call result says they said yes, so its stage can't be changed here. To change what happened on the call, open the Opportunity and use Edit call result.";

/** The FakeRest mirror of the database refusal. */
export const assertStageAgreesWithCallResult = (
  previous: CallResultStageFields,
  next: CallResultStageFields,
): void => {
  if (stageEditContradictsCallResult(previous, next)) {
    throw new Error(
      `${CALL_RESULT_OWNS_STAGE}: ${CALL_RESULT_OWNS_STAGE_MESSAGE}`,
    );
  }
};

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? "");
};

/**
 * What to tell Leif when a stage write was refused.
 *
 * The call-result refusal gets its own sentence pointing at Edit call
 * result; anything else is reported as the save failing, never as success.
 */
export const describeStageEditRefusal = (
  error: unknown,
): { key: string; message: string; callResult: boolean } => {
  const text = messageOf(error);
  if (text.includes(CALL_RESULT_OWNS_STAGE)) {
    return {
      key: "resources.deals.stage_refused.call_result",
      message: CALL_RESULT_OWNS_STAGE_MESSAGE,
      callResult: true,
    };
  }
  return {
    key: "resources.deals.stage_refused.generic",
    message: text
      ? `The change was not saved: ${text}`
      : "The change was not saved.",
    callResult: false,
  };
};
