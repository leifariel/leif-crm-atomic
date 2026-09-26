import { addDays } from "date-fns/addDays";
import type { DataProvider, Identifier } from "ra-core";

import { applyDoNotEngageToContact } from "../deals/dneOutcome";
import type { Deal, SalesCall } from "../types";
import { DEFAULT_THINKING_FOLLOW_UP_DAYS } from "./salesCallConstants";

// The FakeRest mirror of complete_attended_sales_call().
//
// Production records an attended call's outcome as ONE Postgres
// transaction, because Becky Schmauch's sale is what happens when it is
// not: the attendance landed, the Won write was refused, and she was left
// with a completed call against an Opportunity still at Call Booked.
// FakeRest has no transactions, so only the step ORDER is mirrored here —
// the atomicity guarantee comes from the real function, and is proven
// against a real Postgres rather than against this.
//
// Same decision table, same return shape, so the caller cannot tell them
// apart. Everything that is NOT part of the sale — the follow-up Task, the
// Offer Page token — stays with the caller in both.
export type AttendedOutcomeInput = {
  salesCallId: Identifier;
  ownerDecision: string;
  prospectDecision?: string | null;
  followUpDate?: string | null;
};

export const completeAttendedSalesCallMirror = async (
  dataProvider: DataProvider,
  input: AttendedOutcomeInput,
): Promise<Record<string, unknown>> => {
  const { data: call } = await dataProvider
    .getOne<SalesCall>("sales_calls", { id: input.salesCallId })
    .catch(() => ({ data: null as SalesCall | null }));
  if (!call) return { status: "not-found" };
  if (call.opportunity_id == null) return { status: "no-opportunity" };
  // A no-show is a different answer to the same question, and this is not
  // the place to overturn it.
  if (call.attendance === "no_show") return { status: "already-completed" };

  if (!input.ownerDecision) {
    return {
      status: "validation-error",
      message: "An owner-fit decision is required for an attended call.",
    };
  }
  if (input.ownerDecision === "would_work_with" && !input.prospectDecision) {
    return {
      status: "validation-error",
      message: "A prospect decision is required when Would Work With.",
    };
  }

  const { data: deal } = await dataProvider.getOne<Deal>("deals", {
    id: call.opportunity_id,
  });

  // Already attended? Then the question is whether the DECISION landed.
  // Becky's had not, so resubmitting finishes it rather than being refused
  // — and a decision that already exists and disagrees fails closed.
  const converged = call.attendance === "attended";
  if (converged) {
    if (
      deal.owner_decision != null &&
      deal.owner_decision !== input.ownerDecision
    ) {
      return {
        status: "conflicting-outcome",
        reason: `This call was already recorded as "${deal.owner_decision}".`,
      };
    }
    if (
      deal.prospect_decision != null &&
      input.prospectDecision != null &&
      deal.prospect_decision !== input.prospectDecision
    ) {
      return {
        status: "conflicting-outcome",
        reason: `This call was already recorded as "${deal.prospect_decision}".`,
      };
    }
    if (deal.outcome != null) {
      return {
        status: "conflicting-outcome",
        reason: `This opportunity already ended as "${deal.outcome}".`,
      };
    }
  }

  const now = new Date().toISOString();
  if (!converged) {
    await dataProvider.update<SalesCall>("sales_calls", {
      id: call.id,
      // status leaves 'booked' the instant an outcome exists, which frees
      // sales_calls_one_booked_per_opportunity_idx for a genuine rebooking.
      data: {
        attendance: "attended",
        attendance_recorded_at: now,
        status: "completed",
      },
      previousData: call,
    });
  }

  // Written once, ever — a sale that landed halfway may already have it.
  const { data: existingEvents } = await dataProvider.getList(
    "sales_call_events",
    {
      filter: { sales_call_id: call.id, kind: "attendance_recorded" },
      pagination: { page: 1, perPage: 5 },
      sort: { field: "id", order: "ASC" },
    },
  );
  if (existingEvents.length === 0) {
    await dataProvider.create("sales_call_events", {
      data: {
        sales_call_id: call.id,
        kind: "attendance_recorded",
        occurred_at: now,
        attendance: "attended",
      },
    });
  }

  let update: Partial<Deal>;
  let followUp: string | null = null;

  if (input.ownerDecision === "do_not_engage") {
    update = { owner_decision: "do_not_engage", outcome: "lost" };
  } else if (input.ownerDecision === "workshops_only") {
    // A genuine pipeline exit, explicitly not a lost sale: the prospect
    // was never offered the programme, so it must not read as a decline.
    update = { owner_decision: "workshops_only", outcome: "workshops_only" };
  } else if (input.prospectDecision === "yes") {
    // Yes IS Won. Won means the sale was accepted — not paid, not
    // enrolled, not onboarded (20260918180000).
    update = {
      owner_decision: "would_work_with",
      prospect_decision: "yes",
      follow_up_date: null,
      stage: "won",
    };
  } else if (input.prospectDecision === "no") {
    update = {
      owner_decision: "would_work_with",
      prospect_decision: "no",
      follow_up_date: null,
      outcome: "lost",
    };
  } else {
    followUp =
      input.followUpDate ||
      addDays(new Date(), DEFAULT_THINKING_FOLLOW_UP_DAYS)
        .toISOString()
        .split("T")[0];
    update = {
      owner_decision: "would_work_with",
      prospect_decision: "thinking",
      follow_up_date: followUp,
      stage: "decision",
    };
  }

  await dataProvider.update("deals", {
    id: deal.id,
    data: update,
    previousData: deal,
  });

  if (update.owner_decision === "do_not_engage") {
    await applyDoNotEngageToContact(dataProvider, deal.contact_id);
  }

  return {
    status: converged ? "converged" : "completed",
    opportunity_id: deal.id,
    contact_id: deal.contact_id,
    stage: update.stage ?? deal.stage,
    outcome: update.outcome ?? null,
    follow_up_date: followUp,
  };
};
