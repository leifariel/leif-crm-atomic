import type { DataProvider, Identifier } from "ra-core";

import { acceptSaleMirror } from "../deals/acceptSaleMirror";
import { applyDoNotEngageToContact } from "../deals/dneOutcome";
import type {
  Deal,
  Enrollment,
  SalesCall,
  SalesCallCorrectedFacts,
  Task,
} from "../types";
import { callInstant } from "./salesCallSelection";
import type { ImpressionsMode } from "./correctCompletedSalesCall";

// The FakeRest mirror of correct_completed_sales_call().
//
// Same decision table, same refusals, same return shape, so the caller
// cannot tell them apart. FakeRest has no transactions, so only the step
// ORDER is mirrored here -- the atomicity guarantee and the "refuse BEFORE
// mutating" guarantee come from the real function and are proven against a
// real Postgres, never against this. Same dual-implementation pattern as
// completeAttendedSalesCallMirror.ts.

export type CorrectOutcomeInput = {
  salesCallId: Identifier;
  attendance?: string | null;
  ownerDecision?: string | null;
  prospectDecision?: string | null;
  followUpDate?: string | null;
  impressions?: string | null;
  impressionsMode: ImpressionsMode;
};

/** Matches the function's E' \t\r\n' set, not JS's wider .trim(). */
const trimImpression = (value: string): string =>
  value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");

const facts = (
  call: Pick<SalesCall, "attendance" | "impressions">,
  deal: Pick<
    Deal,
    | "owner_decision"
    | "prospect_decision"
    | "follow_up_date"
    | "stage"
    | "outcome"
  >,
): SalesCallCorrectedFacts => ({
  attendance: call.attendance ?? null,
  owner_decision: deal.owner_decision ?? null,
  prospect_decision: deal.prospect_decision ?? null,
  follow_up_date: deal.follow_up_date ?? null,
  impressions: call.impressions ?? null,
  stage: deal.stage ?? null,
  outcome: deal.outcome ?? null,
});

const refuse = (category: string, reason: string, blockers: string[]) => ({
  status: "ambiguous-downstream-state",
  category,
  reason,
  blockers,
});

export const correctCompletedSalesCallMirror = async (
  dataProvider: DataProvider,
  input: CorrectOutcomeInput,
): Promise<Record<string, unknown>> => {
  const mode = input.impressionsMode;
  if (mode !== "unchanged" && mode !== "set" && mode !== "clear") {
    return {
      status: "validation-error",
      message: "Impressions mode must be unchanged, set or clear.",
    };
  }
  if (mode === "set" && !trimImpression(input.impressions ?? "")) {
    return {
      status: "validation-error",
      message: "Setting an impression needs some text.",
    };
  }
  if (mode !== "set" && input.impressions != null) {
    return {
      status: "validation-error",
      message: `Impressions mode "${mode}" does not take any text.`,
    };
  }
  if (
    input.attendance != null &&
    input.attendance !== "attended" &&
    input.attendance !== "no_show"
  ) {
    return {
      status: "validation-error",
      message: "Attendance must be attended or no_show.",
    };
  }

  const { data: call } = await dataProvider
    .getOne<SalesCall>("sales_calls", { id: input.salesCallId })
    .catch(() => ({ data: null as SalesCall | null }));
  if (!call) return { status: "not-found" };

  if (call.status !== "completed" || call.attendance == null) {
    return {
      status: "not-completed",
      reason: "This call has no recorded result to correct.",
    };
  }
  if (call.opportunity_id == null) return { status: "no-opportunity" };

  const lifecycleRequested =
    input.attendance != null ||
    input.ownerDecision != null ||
    input.prospectDecision != null ||
    input.followUpDate != null;

  // Only an ATTENDED call ever wrote lifecycle facts: a cancellation and a
  // no-show both leave the Opportunity untouched on purpose. So only a
  // newer attended episode can supersede this one.
  const { data: siblings } = await dataProvider.getList<SalesCall>(
    "sales_calls",
    {
      filter: { opportunity_id: call.opportunity_id },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    },
  );
  const mine = callInstant(call) ?? "";
  const newer = siblings.find(
    (other) =>
      String(other.id) !== String(call.id) &&
      other.attendance === "attended" &&
      ((callInstant(other) ?? "") > mine ||
        ((callInstant(other) ?? "") === mine &&
          Number(other.id) > Number(call.id))),
  );
  if (newer && lifecycleRequested) {
    return {
      status: "superseded-call-episode",
      category: "newer_attended_episode",
      superseded_by_sales_call_id: newer.id,
      reason:
        "A later call on this Opportunity holds its current result. This one's impressions can still be corrected.",
    };
  }

  const { data: deal } = await dataProvider.getOne<Deal>("deals", {
    id: call.opportunity_id,
  });

  if (deal.archived_at != null && lifecycleRequested) {
    return refuse(
      "archived_opportunity",
      "This Opportunity is archived. Un-archive it first if its result really needs changing.",
      ["archived"],
    );
  }

  const attendance = input.attendance ?? call.attendance;
  if (call.attendance === "attended" && attendance === "no_show") {
    return refuse(
      "attendance_retraction",
      "Recording this call as a no-show would have to undo the decision it already produced on the Opportunity. Change the Opportunity's own outcome instead.",
      ["recorded_attendance"],
    );
  }

  const owner = input.ownerDecision ?? deal.owner_decision ?? null;
  if (owner == null) {
    return {
      status: "validation-error",
      message: "An owner-fit decision is required for an attended call.",
    };
  }
  if (
    owner !== "would_work_with" &&
    owner !== "workshops_only" &&
    owner !== "do_not_engage"
  ) {
    return {
      status: "validation-error",
      message: `"${owner}" is not an owner decision.`,
    };
  }

  let prospect: string | null = null;
  if (owner === "would_work_with") {
    prospect = input.prospectDecision ?? deal.prospect_decision ?? null;
    if (prospect == null) {
      return {
        status: "validation-error",
        message: "A prospect decision is required when Would Work With.",
      };
    }
    if (prospect !== "yes" && prospect !== "thinking" && prospect !== "no") {
      // "ghosted" is a legal stored value, produced by the pipeline-exit
      // authority and never by a call outcome.
      return {
        status: "invalid-transition",
        category: "not_a_call_outcome",
        reason: `"${prospect}" is not something a sales call records. Use Remove from pipeline.`,
      };
    }
  }

  let targetStage = deal.stage;
  let targetOutcome: Deal["outcome"] | null = null;
  let targetFollowUp: string | null = null;

  if (owner === "would_work_with" && prospect === "thinking") {
    targetStage = "decision";
    targetFollowUp = input.followUpDate ?? deal.follow_up_date ?? null;
    if (!targetFollowUp) {
      return {
        status: "missing-decision-date",
        reason: "A Decision needs the date the follow-up is owed.",
      };
    }
  } else if (owner === "would_work_with" && prospect === "yes") {
    targetStage = "won";
  } else if (owner === "would_work_with" && prospect === "no") {
    targetOutcome = "lost";
  } else if (owner === "do_not_engage") {
    targetOutcome = "lost";
  } else {
    targetOutcome = "workshops_only";
  }

  const { data: enrollments } = await dataProvider.getList<Enrollment>(
    "enrollments",
    {
      filter: { opportunity_id: deal.id },
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    },
  );

  // Keyed on the target DECISION rather than the derived stage: the "no"
  // branch leaves stage alone, so a Won deal corrected to "they said no"
  // would otherwise slip past a stage comparison while writing outcome
  // 'lost' -- a sale both won and lost.
  if (
    deal.stage === "won" &&
    !(owner === "would_work_with" && prospect === "yes")
  ) {
    const blockers: string[] = [];
    if (enrollments.length) blockers.push("enrollment");
    if (deal.offer_page_token) blockers.push("offer_page_link");
    if (deal.payment_setup_confirmed_at) blockers.push("payment_setup");
    blockers.push("won_sale");
    return refuse(
      "won_opportunity",
      "This sale is already Won, and what follows a Won sale cannot be safely undone from here.",
      blockers,
    );
  }

  if (
    targetOutcome != null &&
    enrollments.some((enrollment) => enrollment.status !== "withdrawn")
  ) {
    return refuse(
      "existing_enrollment",
      "This Opportunity has a live Enrollment. Ending the sale here would leave a client enrolled in something nobody bought.",
      ["enrollment"],
    );
  }

  if (deal.owner_decision === "do_not_engage" && owner !== "do_not_engage") {
    return refuse(
      "contact_sales_eligibility",
      "This Contact carries a standing do-not-engage decision. Lifting it is a decision about the person, not about this call.",
      ["contact_do_not_engage"],
    );
  }

  const impressions =
    mode === "set"
      ? trimImpression(input.impressions ?? "") || null
      : mode === "clear"
        ? null
        : (call.impressions ?? null);
  const impressionsChanging =
    mode !== "unchanged" && impressions !== (call.impressions ?? null);

  const same = <T>(a: T | null | undefined, b: T | null | undefined) =>
    (a ?? null) === (b ?? null);
  if (
    same(attendance, call.attendance) &&
    same(owner, deal.owner_decision) &&
    same(prospect, deal.prospect_decision) &&
    same(targetFollowUp, deal.follow_up_date) &&
    same(targetOutcome, deal.outcome) &&
    same(targetStage, deal.stage) &&
    !impressionsChanging
  ) {
    return {
      status: "no-change",
      sales_call_id: call.id,
      opportunity_id: deal.id,
    };
  }

  const before = facts(call, deal);
  const now = new Date().toISOString();

  await dataProvider.update<SalesCall>("sales_calls", {
    id: call.id,
    data: {
      attendance: attendance as SalesCall["attendance"],
      attendance_recorded_at:
        attendance !== call.attendance ? now : call.attendance_recorded_at,
      impressions,
    },
    previousData: call,
  });

  const update: Partial<Deal> =
    owner === "do_not_engage"
      ? {
          owner_decision: "do_not_engage",
          prospect_decision: null,
          follow_up_date: null,
          outcome: "lost",
        }
      : owner === "workshops_only"
        ? {
            owner_decision: "workshops_only",
            prospect_decision: null,
            follow_up_date: null,
            outcome: "workshops_only",
          }
        : prospect === "yes"
          ? // Deliberately NOT stage: "won" here. The real function clears
            // the outcome and then calls accept_sale(); this clears it and
            // then calls acceptSaleMirror(), which is the one place a sale
            // is accepted on this side too. A second hand-written Won is
            // exactly what Becky Schmauch's half-persisted sale cost, and
            // contracts/deals/wonIsWritableByItsOwnWriter.test.ts is the
            // inventory that catches one being added -- it caught this.
            {
              owner_decision: "would_work_with",
              follow_up_date: null,
              outcome: null,
            }
          : prospect === "no"
            ? {
                owner_decision: "would_work_with",
                prospect_decision: "no",
                follow_up_date: null,
                outcome: "lost",
              }
            : {
                owner_decision: "would_work_with",
                prospect_decision: "thinking",
                follow_up_date: targetFollowUp,
                outcome: null,
                stage: "decision",
              };

  await dataProvider.update("deals", {
    id: deal.id,
    data: update,
    previousData: deal,
  });

  if (owner === "do_not_engage") {
    await applyDoNotEngageToContact(dataProvider, deal.contact_id);
  }

  if (prospect === "yes") {
    const sale = await acceptSaleMirror(dataProvider, deal.id);
    if (sale.status === "conflicting-outcome") {
      // The one primitive refuses rather than overwriting a recorded end.
      // The real function raises here, which aborts the transaction; this
      // side has none, so it reports the refusal in its own words.
      return {
        status: "ambiguous-downstream-state",
        category: "accept_sale_refused",
        reason: String(sale.reason ?? ""),
        blockers: ["recorded_outcome"],
      };
    }
  }

  const { data: afterDeal } = await dataProvider.getOne<Deal>("deals", {
    id: deal.id,
  });
  await reconcileFollowUpTaskMirror(dataProvider, deal.id, afterDeal);

  const { data: freshCall } = await dataProvider.getOne<SalesCall>(
    "sales_calls",
    { id: call.id },
  );
  const { data: freshDeal } = await dataProvider.getOne<Deal>("deals", {
    id: deal.id,
  });
  const after = facts(freshCall, freshDeal);

  await dataProvider.create("sales_call_events", {
    data: {
      sales_call_id: call.id,
      kind: "outcome_corrected",
      occurred_at: now,
      attendance: freshCall.attendance,
      correction: { before, after },
    },
  });

  return {
    status: "corrected",
    sales_call_id: call.id,
    opportunity_id: deal.id,
    contact_id: deal.contact_id,
    attendance: freshCall.attendance,
    stage: freshDeal.stage,
    outcome: freshDeal.outcome ?? null,
    owner_decision: freshDeal.owner_decision ?? null,
    prospect_decision: freshDeal.prospect_decision ?? null,
    follow_up_date: freshDeal.follow_up_date ?? null,
    impressions: freshCall.impressions ?? null,
    enrollments: enrollments.length,
    before,
  };
};

/**
 * The FakeRest stand-in for the on_deal_decision_follow_up_task trigger.
 *
 * Production reconciles this from the database, which is why every path
 * that moves an Opportunity gets it; FakeRest has no triggers, so the one
 * path that needs it calls it directly. Same rule: exactly one pending
 * follow_up Task while an active Opportunity sits at Decision with a date,
 * and none once that stops being true.
 */
const reconcileFollowUpTaskMirror = async (
  dataProvider: DataProvider,
  opportunityId: Identifier,
  deal: Deal,
): Promise<void> => {
  const wanted =
    deal.archived_at == null &&
    deal.outcome == null &&
    deal.stage === "decision" &&
    !!deal.follow_up_date;

  const { data: tasks } = await dataProvider.getList<Task>("tasks", {
    filter: { contact_id: deal.contact_id, type: "follow_up" },
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });
  const open = tasks.filter(
    (task) =>
      !task.done_date &&
      (task.opportunity_id == null ||
        String(task.opportunity_id) === String(opportunityId)),
  );

  if (!wanted) {
    for (const task of open) {
      await dataProvider.update("tasks", {
        id: task.id,
        data: { status: "cancelled", done_date: new Date().toISOString() },
        previousData: task,
      });
    }
    return;
  }

  const existing = open[0];
  if (existing) {
    await dataProvider.update("tasks", {
      id: existing.id,
      data: {
        opportunity_id: opportunityId,
        due_date: `${deal.follow_up_date}T12:00:00.000Z`,
      },
      previousData: existing,
    });
    return;
  }

  await dataProvider.create("tasks", {
    data: {
      contact_id: deal.contact_id,
      opportunity_id: opportunityId,
      type: "follow_up",
      text: "Follow up",
      due_date: `${deal.follow_up_date}T12:00:00.000Z`,
      status: "pending",
    },
  });
};
