import type { DataProvider, Identifier } from "ra-core";

import type {
  OpportunityOwnerDecision,
  OpportunityProspectDecision,
  SalesCallAttendance,
  SalesCallCorrectedFacts,
} from "../types";

/**
 * Correcting the recorded result of ONE completed sales-call episode.
 *
 * Deliberately NOT a looser completion. complete_attended_sales_call()
 * stays the first-resolution command and keeps refusing a materially
 * different re-completion with "conflicting-outcome", because a stale tab,
 * a double-click or a replayed webhook must never be able to rewrite a
 * recorded answer. A correction is a human saying "that is wrong", and it
 * says so in its own audit event.
 *
 * This is a thin domain wrapper over correct_completed_sales_call(): every
 * rule -- which episode may correct the Opportunity's current truth, what
 * is reconcilable, what is refused -- lives in the database, where it is
 * one transaction. See
 * supabase/migrations/20261016120000_a_recorded_result_can_be_corrected.sql.
 */

/**
 * Impressions are the one field with three legitimate answers, so they get
 * three words rather than a blank string with three meanings.
 *
 *   unchanged  leave what is there exactly as it is
 *   set        replace it with this text
 *   clear      deliberately empty it
 */
export type ImpressionsMode = "unchanged" | "set" | "clear";

export type CorrectSalesCallInput = {
  dataProvider: DataProvider;
  salesCallId: Identifier;
  /** Only "attended" is correctable to; see the "ambiguous" result below. */
  attendance?: SalesCallAttendance | null;
  ownerDecision?: OpportunityOwnerDecision | null;
  prospectDecision?: OpportunityProspectDecision | null;
  followUpDate?: string | null;
  impressions?: string | null;
  impressionsMode?: ImpressionsMode;
};

export type CorrectSalesCallResult =
  | { status: "corrected"; before: SalesCallCorrectedFacts }
  /** Nothing in the request differed from what is already recorded. */
  | { status: "no-change" }
  | { status: "not-found" }
  /** Booked, cancelled, or a historical row with no attendance recorded. */
  | { status: "not-completed"; reason: string }
  | { status: "no-opportunity" }
  /** The target result is not something a sales call records. */
  | { status: "invalid-transition"; reason: string }
  /** Becoming a Decision needs the date the follow-up is owed. */
  | { status: "missing-decision-date"; reason: string }
  /**
   * A later attended call on the same Opportunity holds its current
   * result. This episode's impressions can still be corrected.
   */
  | {
      status: "superseded-call-episode";
      reason: string;
      supersededBySalesCallId: Identifier | null;
    }
  /**
   * The correction would imply reversing something this transaction has no
   * safe way to reverse -- a Won sale, an Enrollment, money, a Stripe plan,
   * an issued Offer Page link, a standing do-not-engage decision, an
   * archived Opportunity, or a recorded attendance. Refused BEFORE anything
   * is written. Atomic handles certainty; Leif handles ambiguity.
   */
  | {
      status: "ambiguous-downstream-state";
      category: string;
      reason: string;
      blockers: string[];
    }
  | { status: "validation-error"; message: string };

type CorrectingProvider = DataProvider & {
  correctCompletedSalesCall?: (input: {
    salesCallId: Identifier;
    attendance?: string | null;
    ownerDecision?: string | null;
    prospectDecision?: string | null;
    followUpDate?: string | null;
    impressions?: string | null;
    impressionsMode: ImpressionsMode;
  }) => Promise<Record<string, unknown>>;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];

export const correctCompletedSalesCall = async (
  input: CorrectSalesCallInput,
): Promise<CorrectSalesCallResult> => {
  const rpc = (input.dataProvider as CorrectingProvider)
    .correctCompletedSalesCall;
  if (!rpc) {
    // Both providers implement it (the FakeRest mirror lives in
    // correctCompletedSalesCallMirror.ts), so this is a wiring mistake
    // rather than a runtime condition.
    return {
      status: "validation-error",
      message: "This data provider cannot correct a sales call.",
    };
  }

  const mode = input.impressionsMode ?? "unchanged";
  const result = await rpc({
    salesCallId: input.salesCallId,
    attendance: input.attendance ?? null,
    ownerDecision: input.ownerDecision ?? null,
    prospectDecision: input.prospectDecision ?? null,
    followUpDate: input.followUpDate ?? null,
    // The text only ever travels with "set"; the database refuses a
    // contradictory pair rather than guessing which half was meant.
    impressions: mode === "set" ? (input.impressions ?? null) : null,
    impressionsMode: mode,
  });

  const status = String(result.status ?? "");
  switch (status) {
    case "corrected":
      return {
        status: "corrected",
        before: result.before as SalesCallCorrectedFacts,
      };
    case "no-change":
    case "not-found":
    case "no-opportunity":
      return { status } as CorrectSalesCallResult;
    case "not-completed":
    case "invalid-transition":
    case "missing-decision-date":
      return {
        status,
        reason: String(result.reason ?? ""),
      } as CorrectSalesCallResult;
    case "superseded-call-episode":
      return {
        status,
        reason: String(result.reason ?? ""),
        supersededBySalesCallId:
          (result.superseded_by_sales_call_id as Identifier | undefined) ??
          null,
      };
    case "ambiguous-downstream-state":
      return {
        status,
        category: String(result.category ?? "unknown"),
        reason: String(result.reason ?? ""),
        blockers: asStringArray(result.blockers),
      };
    case "validation-error":
      return { status, message: String(result.message ?? "") };
    default:
      return {
        status: "validation-error",
        message: `Unrecognised correction result "${status}".`,
      };
  }
};
