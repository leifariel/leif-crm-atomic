import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// CORRECTING A RECORDED RESULT, AGAINST REAL POSTGRES.
//
// Sales Call Workflow Part 2. Every rule worth proving here needs a real
// transaction, a real trigger, or a real privilege check:
//
//   A  Decision -> Decision date change edits the SAME episode, retargets
//      the one follow-up Task, and duplicates nothing
//   B  the identical correction again is a genuine no-change, with no
//      second audit row
//   C  the owner's fit decision is correctable
//   D  the prospect's decision is correctable
//   E/F/G  impressions replace / clear / stay, as three distinct answers
//   H  becoming a Decision requires the date the follow-up is owed
//   I  Decision -> Lost closes the stale Decision Task and clears the date
//   J  coming back to Decision leaves exactly one follow-up Task
//   K  the correction is recorded, with before and after
//   L  stage history is NOT appended when the stage did not change
//   M  stage history IS appended when it did
//   N  two completed episodes: correcting the later one leaves the earlier
//      one completely alone
//   O  an older episode may not rewrite current Opportunity truth
//   P  another Offer's Opportunity for the same Contact is untouched
//   Q  a Won sale with an Enrollment is refused BEFORE anything is written
//   R  money and a Stripe plan are named as the blockers they are
//   S  a refused correction leaves no partial state
//   X  the completion command still refuses conflicting re-completion
//
// The security half (T/U/V/W) lives in securityPosture.spec.ts, with the
// rest of the privilege posture.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 962000;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

type Correction = {
  attendance?: string | null;
  ownerDecision?: string | null;
  prospectDecision?: string | null;
  followUpDate?: string | null;
  impressions?: string | null;
  impressionsMode?: "unchanged" | "set" | "clear";
};

const correct = async (callId: number, args: Correction = {}) => {
  const { data, error } = await db().rpc("correct_completed_sales_call", {
    p_sales_call_id: callId,
    p_attendance: args.attendance ?? null,
    p_owner_decision: args.ownerDecision ?? null,
    p_prospect_decision: args.prospectDecision ?? null,
    p_follow_up_date: args.followUpDate ?? null,
    p_impressions: args.impressions ?? null,
    p_impressions_mode: args.impressionsMode ?? "unchanged",
  });
  ok("the correction call itself", { error });
  return data as Record<string, unknown>;
};

/**
 * A Contact, an Opportunity, and a call already recorded as attended.
 *
 * Seeded directly rather than through the completion command so each test
 * states exactly the shape it is about -- including the shapes the
 * completion command cannot produce, like a Won sale whose call is being
 * second-guessed.
 */
const seed = async (
  n: number,
  lastName: string,
  {
    offerId = LE,
    deal: dealFields = {},
    call: callFields = {},
    at = "2026-10-14T15:00:00.000Z",
  }: {
    offerId?: number;
    deal?: Record<string, unknown>;
    call?: Record<string, unknown>;
    at?: string;
  } = {},
) => {
  const client = db();
  const contactId = BASE + n;

  ok(
    `contact ${n}`,
    await client.from("contacts").insert({
      id: contactId,
      first_name: "Correct",
      last_name: lastName,
      email_jsonb: [{ email: `correct${n}@sales.test`, type: "Work" }],
    }),
  );

  const { data: deal, error: dealError } = await client
    .from("deals")
    .insert({
      contact_id: contactId,
      offer_id: offerId,
      cohort_id: null,
      stage: "decision",
      amount: 4000,
      entry_path: "other",
      description: "",
      owner_decision: "would_work_with",
      prospect_decision: "thinking",
      follow_up_date: "2026-10-20",
      ...dealFields,
    })
    .select("id")
    .single();
  ok(`deal ${n}`, { error: dealError });

  const { data: call, error: callError } = await client
    .from("sales_calls")
    .insert({
      opportunity_id: deal!.id,
      contact_id: contactId,
      status: "completed",
      attendance: "attended",
      attendance_recorded_at: at,
      original_scheduled_at: at,
      scheduled_at: at,
      scheduled_on: at.slice(0, 10),
      schedule_precision: "exact",
      source: "manual",
      ...callFields,
    })
    .select("id")
    .single();
  ok(`call ${n}`, { error: callError });

  return { contactId, dealId: deal!.id as number, callId: call!.id as number };
};

const addCall = async (
  contactId: number,
  dealId: number,
  at: string,
  fields: Record<string, unknown> = {},
) => {
  const { data, error } = await db()
    .from("sales_calls")
    .insert({
      opportunity_id: dealId,
      contact_id: contactId,
      status: "completed",
      attendance: "attended",
      attendance_recorded_at: at,
      original_scheduled_at: at,
      scheduled_at: at,
      scheduled_on: at.slice(0, 10),
      schedule_precision: "exact",
      source: "manual",
      ...fields,
    })
    .select("id")
    .single();
  ok("extra call", { error });
  return data!.id as number;
};

const callRow = async (callId: number) => {
  const { data } = await db()
    .from("sales_calls")
    .select("status, attendance, attendance_recorded_at, impressions")
    .eq("id", callId)
    .single();
  return data!;
};

const dealRow = async (dealId: number) => {
  const { data } = await db()
    .from("deals")
    .select("stage, outcome, owner_decision, prospect_decision, follow_up_date")
    .eq("id", dealId)
    .single();
  return data!;
};

const followUpTasks = async (dealId: number) => {
  const { data } = await db()
    .from("tasks")
    .select("id, status, done_date, due_date, opportunity_id")
    .eq("opportunity_id", dealId)
    .eq("type", "follow_up");
  return data ?? [];
};

const openFollowUpTasks = async (dealId: number) =>
  (await followUpTasks(dealId)).filter((task) => task.done_date == null);

const correctionEvents = async (callId: number) => {
  const { data } = await db()
    .from("sales_call_events")
    .select("id, kind, attendance, correction")
    .eq("sales_call_id", callId)
    .eq("kind", "outcome_corrected")
    .order("id");
  return data ?? [];
};

test.describe("one episode, one result, corrected in place", () => {
  test("A. a new Decision date edits the same call and retargets one Task", async () => {
    const { dealId, callId } = await seed(1, "DateChange");

    // The trigger made the Task when the Opportunity was seeded at Decision.
    expect(await openFollowUpTasks(dealId)).toHaveLength(1);

    const result = await correct(callId, { followUpDate: "2026-11-02" });
    expect(result.status).toBe("corrected");
    expect(result.sales_call_id).toBe(callId);
    expect(result.opportunity_id).toBe(dealId);

    expect((await dealRow(dealId)).follow_up_date).toBe("2026-11-02");

    // One Task, retargeted -- never a second one beside it.
    const open = await openFollowUpTasks(dealId);
    expect(open).toHaveLength(1);
    expect(String(open[0].due_date)).toContain("2026-11-02");

    // The call episode itself is still one row.
    const { data: calls } = await db()
      .from("sales_calls")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(calls).toHaveLength(1);
  });

  test("B. the identical correction again changes nothing and records nothing", async () => {
    const { dealId, callId } = await seed(2, "Idempotent");

    await correct(callId, { followUpDate: "2026-11-02" });
    const again = await correct(callId, { followUpDate: "2026-11-02" });

    expect(again.status).toBe("no-change");
    expect(await openFollowUpTasks(dealId)).toHaveLength(1);
    // One correction happened, so exactly one correction is recorded.
    expect(await correctionEvents(callId)).toHaveLength(1);
  });

  test("C. the owner's fit decision is correctable", async () => {
    const { dealId, callId } = await seed(3, "OwnerFit");

    const result = await correct(callId, { ownerDecision: "workshops_only" });
    expect(result.status).toBe("corrected");

    const deal = await dealRow(dealId);
    expect(deal.owner_decision).toBe("workshops_only");
    expect(deal.outcome).toBe("workshops_only");
    // Only Would Work With has a prospect decision; it is derived, never
    // left behind.
    expect(deal.prospect_decision).toBeNull();
    expect(deal.follow_up_date).toBeNull();
  });

  test("D. the prospect's decision is correctable", async () => {
    const { dealId, callId } = await seed(4, "TheirCall");

    const result = await correct(callId, { prospectDecision: "no" });
    expect(result.status).toBe("corrected");

    const deal = await dealRow(dealId);
    expect(deal.prospect_decision).toBe("no");
    expect(deal.outcome).toBe("lost");
  });

  test("E/F/G. impressions replace, clear and stay as three separate answers", async () => {
    const { callId } = await seed(5, "ThreeAnswers", {
      call: { impressions: "First read." },
    });

    // E. replace
    expect(
      (
        await correct(callId, {
          impressions: "Second read.",
          impressionsMode: "set",
        })
      ).status,
    ).toBe("corrected");
    expect((await callRow(callId)).impressions).toBe("Second read.");

    // G. unchanged really is unchanged, and is not a write
    expect(
      (await correct(callId, { impressionsMode: "unchanged" })).status,
    ).toBe("no-change");
    expect((await callRow(callId)).impressions).toBe("Second read.");

    // F. clear
    expect((await correct(callId, { impressionsMode: "clear" })).status).toBe(
      "corrected",
    );
    expect((await callRow(callId)).impressions).toBeNull();

    // And the empty string is not a fourth meaning: a contradictory pair is
    // refused rather than guessed at.
    const contradiction = await correct(callId, {
      impressions: "something",
      impressionsMode: "clear",
    });
    expect(contradiction.status).toBe("validation-error");
    const blank = await correct(callId, {
      impressions: "   ",
      impressionsMode: "set",
    });
    expect(blank.status).toBe("validation-error");
  });

  test("H. becoming a Decision needs the date the follow-up is owed", async () => {
    const { dealId, callId } = await seed(6, "NoDate", {
      deal: {
        stage: "call_booked",
        prospect_decision: "no",
        follow_up_date: null,
        outcome: "lost",
      },
    });

    const refused = await correct(callId, { prospectDecision: "thinking" });
    expect(refused.status).toBe("missing-decision-date");

    // Nothing moved on the way to being refused.
    const deal = await dealRow(dealId);
    expect(deal.outcome).toBe("lost");
    expect(deal.prospect_decision).toBe("no");
    expect(await correctionEvents(callId)).toHaveLength(0);
  });
});

test.describe("leaving Decision, and coming back to it", () => {
  test("I/L. Decision -> Lost closes the stale Task, clears the date, and adds no stage row", async () => {
    const { dealId, callId } = await seed(7, "WentCold");

    const { data: stageBefore } = await db()
      .from("deal_stage_events")
      .select("id")
      .eq("opportunity_id", dealId);

    expect(await openFollowUpTasks(dealId)).toHaveLength(1);

    const result = await correct(callId, { prospectDecision: "no" });
    expect(result.status).toBe("corrected");

    const deal = await dealRow(dealId);
    expect(deal.outcome).toBe("lost");
    // The commitment is gone, so it must not still read as live Decision
    // truth anywhere.
    expect(deal.follow_up_date).toBeNull();

    // The Task is closed, cancelled rather than completed -- nobody did it.
    expect(await openFollowUpTasks(dealId)).toHaveLength(0);
    const all = await followUpTasks(dealId);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("cancelled");

    // L. stage did not change, so no stage transition is invented.
    const { data: stageAfter } = await db()
      .from("deal_stage_events")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(stageAfter).toHaveLength((stageBefore ?? []).length);

    // The outcome, though, IS history -- read from the correction event,
    // because deal_outcome_events is SELECT-able by NO api role (neither
    // authenticated nor service_role; checked against this database). The
    // row itself is written by on_deal_outcome_changed, whose attachment
    // migration 20261015120000 asserts.
    const events = await correctionEvents(callId);
    expect(events).toHaveLength(1);
    const correction = events[0].correction as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(correction.before.outcome).toBeNull();
    expect(correction.after.outcome).toBe("lost");
  });

  test("J/M. back to Decision leaves exactly one Task, and records the stage move", async () => {
    const { dealId, callId } = await seed(8, "CameBack", {
      deal: {
        stage: "call_booked",
        prospect_decision: "no",
        follow_up_date: null,
        outcome: "lost",
      },
    });

    const result = await correct(callId, {
      prospectDecision: "thinking",
      followUpDate: "2026-11-20",
    });
    expect(result.status).toBe("corrected");

    const deal = await dealRow(dealId);
    expect(deal.stage).toBe("decision");
    expect(deal.outcome).toBeNull();
    expect(deal.follow_up_date).toBe("2026-11-20");

    const open = await openFollowUpTasks(dealId);
    expect(open).toHaveLength(1);
    expect(String(open[0].due_date)).toContain("2026-11-20");

    // M. the stage genuinely moved, so the history says so.
    const { data: stages } = await db()
      .from("deal_stage_events")
      .select("stage")
      .eq("opportunity_id", dealId)
      .order("id");
    expect(stages!.map((row) => row.stage)).toEqual([
      "call_booked",
      "decision",
    ]);

    // And the outcome coming back off is history too, not an erasure. Same
    // reason as above for reading it here: nothing with an API key can
    // SELECT deal_outcome_events.
    const events = await correctionEvents(callId);
    expect(events).toHaveLength(1);
    const correction = events[0].correction as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(correction.before).toMatchObject({
      outcome: "lost",
      stage: "call_booked",
    });
    expect(correction.after).toMatchObject({
      outcome: null,
      stage: "decision",
      follow_up_date: "2026-11-20",
    });
  });

  test("K. the correction is recorded, with what was there and what is there now", async () => {
    const { callId } = await seed(9, "Audited", {
      call: { impressions: "Warm." },
    });

    await correct(callId, {
      prospectDecision: "no",
      impressions: "Warmer than the answer suggests.",
      impressionsMode: "set",
    });

    const events = await correctionEvents(callId);
    expect(events).toHaveLength(1);
    const correction = events[0].correction as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(correction.before).toMatchObject({
      prospect_decision: "thinking",
      follow_up_date: "2026-10-20",
      impressions: "Warm.",
      outcome: null,
    });
    expect(correction.after).toMatchObject({
      prospect_decision: "no",
      follow_up_date: null,
      impressions: "Warmer than the answer suggests.",
      outcome: "lost",
    });

    // The original fact is not erased by the correction of it. This call was
    // seeded without an attendance_recorded row, so what matters is that the
    // correction did not rewrite history in place: it appended.
    const { data: all } = await db()
      .from("sales_call_events")
      .select("kind")
      .eq("sales_call_id", callId);
    expect(all!.filter((row) => row.kind === "outcome_corrected")).toHaveLength(
      1,
    );
  });
});

test.describe("an Opportunity may have several episodes, and they stay separate", () => {
  test("N. correcting the later episode leaves the earlier one alone", async () => {
    const {
      contactId,
      dealId,
      callId: older,
    } = await seed(10, "Rebooked", {
      at: "2026-09-01T15:00:00.000Z",
      call: { impressions: "September read." },
    });
    const newer = await addCall(contactId, dealId, "2026-10-10T15:00:00.000Z", {
      impressions: "October read.",
    });

    const result = await correct(newer, {
      prospectDecision: "no",
      impressions: "October read, corrected.",
      impressionsMode: "set",
    });
    expect(result.status).toBe("corrected");

    // The older episode is untouched in every respect.
    const old = await callRow(older);
    expect(old.impressions).toBe("September read.");
    expect(old.attendance).toBe("attended");
    expect(old.status).toBe("completed");
    expect(await correctionEvents(older)).toHaveLength(0);

    // Still two calls, never collapsed into one.
    const { data: calls } = await db()
      .from("sales_calls")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(calls).toHaveLength(2);
  });

  test("O. an older episode may not rewrite current Opportunity truth", async () => {
    const {
      contactId,
      dealId,
      callId: older,
    } = await seed(11, "Superseded", {
      at: "2026-09-01T15:00:00.000Z",
      call: { impressions: "September read." },
    });
    const newer = await addCall(contactId, dealId, "2026-10-10T15:00:00.000Z");

    const refused = await correct(older, { prospectDecision: "no" });
    expect(refused.status).toBe("superseded-call-episode");
    expect(refused.superseded_by_sales_call_id).toBe(newer);

    // Nothing moved.
    const deal = await dealRow(dealId);
    expect(deal.prospect_decision).toBe("thinking");
    expect(deal.outcome).toBeNull();
    expect(await correctionEvents(older)).toHaveLength(0);

    // But what Leif made of that older conversation is still his to fix:
    // impressions live on the call row and nothing derives from them.
    const allowed = await correct(older, {
      impressions: "September read, corrected.",
      impressionsMode: "set",
    });
    expect(allowed.status).toBe("corrected");
    expect((await callRow(older)).impressions).toBe(
      "September read, corrected.",
    );
    // And it still did not touch the Opportunity.
    expect((await dealRow(dealId)).prospect_decision).toBe("thinking");
  });

  test("P. another Offer's Opportunity for the same Contact is untouched", async () => {
    const { contactId, dealId, callId } = await seed(12, "TwoProgrammes");

    const { data: other, error } = await db()
      .from("deals")
      .insert({
        contact_id: contactId,
        offer_id: GYU,
        cohort_id: null,
        stage: "approved",
        amount: 2000,
        entry_path: "other",
        description: "",
      })
      .select("id")
      .single();
    ok("the other-offer Opportunity", { error });

    expect((await correct(callId, { prospectDecision: "no" })).status).toBe(
      "corrected",
    );

    const theirs = await dealRow(other!.id as number);
    expect(theirs.stage).toBe("approved");
    expect(theirs.outcome).toBeNull();
    expect(theirs.owner_decision).toBeNull();

    // And the correction's own Opportunity did move.
    expect((await dealRow(dealId)).outcome).toBe("lost");
  });
});

test.describe("correcting forward is creating, not reversing", () => {
  test("they actually said yes: one Enrollment, through the one primitive", async () => {
    const { dealId, callId } = await seed(22, "ActuallyYes");

    const result = await correct(callId, { prospectDecision: "yes" });
    expect(result.status).toBe("corrected");

    const deal = await dealRow(dealId);
    expect(deal.stage).toBe("won");
    expect(deal.prospect_decision).toBe("yes");
    expect(deal.outcome).toBeNull();
    expect(deal.follow_up_date).toBeNull();

    // accept_sale() -> handle_deal_won() made it, exactly once. Nothing
    // here duplicates that work: a correction forward delegates to the
    // same primitive the completion uses.
    const { data: enrollments } = await db()
      .from("enrollments")
      .select("id, status")
      .eq("opportunity_id", dealId);
    expect(enrollments).toHaveLength(1);
    expect(enrollments![0].status).toBe("onboarding");
    expect(result.enrollments).toBe(1);

    // The Decision follow-up Task was the premise of a decision now made.
    expect(await openFollowUpTasks(dealId)).toHaveLength(0);

    // And replaying it is a no-change rather than a second Enrollment.
    expect((await correct(callId, { prospectDecision: "yes" })).status).toBe(
      "no-change",
    );
    const { data: still } = await db()
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(still).toHaveLength(1);
  });
});
test.describe("what cannot be safely undone is refused, before anything is written", () => {
  test("Q/S. a Won sale with an Enrollment is refused and leaves no partial state", async () => {
    const { dealId, callId } = await seed(13, "AlreadyWon", {
      deal: {
        stage: "won",
        prospect_decision: "yes",
        follow_up_date: null,
      },
      call: { impressions: "Delighted." },
    });

    // handle_deal_won() made the Enrollment, which is exactly the thing
    // nothing here can un-make.
    const { data: enrollments } = await db()
      .from("enrollments")
      .select("id, status")
      .eq("opportunity_id", dealId);
    expect(enrollments).toHaveLength(1);

    const refused = await correct(callId, { prospectDecision: "no" });
    expect(refused.status).toBe("ambiguous-downstream-state");
    expect(refused.category).toBe("won_opportunity");
    expect(refused.blockers).toContain("enrollment");
    expect(refused.blockers).toContain("won_sale");

    // S. no partial state: not the deal, not the call, not the Enrollment,
    // and not the audit trail.
    const deal = await dealRow(dealId);
    expect(deal.stage).toBe("won");
    expect(deal.prospect_decision).toBe("yes");
    expect(deal.outcome).toBeNull();
    expect((await callRow(callId)).impressions).toBe("Delighted.");
    const { data: stillEnrolled } = await db()
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(stillEnrolled).toHaveLength(1);
    expect(await correctionEvents(callId)).toHaveLength(0);

    // Retracting the attendance on a Won call is the same ambiguity by
    // another route.
    const retract = await correct(callId, { attendance: "no_show" });
    expect(retract.status).toBe("ambiguous-downstream-state");
    expect(retract.category).toBe("attendance_retraction");

    // What IS still correctable on a Won sale: what Leif made of the call.
    expect(
      (
        await correct(callId, {
          impressions: "Delighted, and nervous about the money.",
          impressionsMode: "set",
        })
      ).status,
    ).toBe("corrected");
    expect((await dealRow(dealId)).stage).toBe("won");
  });

  test("R. money and a Stripe plan are named as the blockers they are", async () => {
    const { dealId, callId } = await seed(14, "AlreadyPaid", {
      deal: {
        stage: "won",
        prospect_decision: "yes",
        follow_up_date: null,
        payment_setup_confirmed_at: "2026-10-15T00:00:00.000Z",
        payment_setup_source: "owner_confirmed",
      },
    });

    ok(
      "a collected payment",
      await db().from("deal_payment_schedule_items").insert({
        deal_id: dealId,
        amount: 500,
        sequence: 1,
        status: "paid",
        paid_on: "2026-10-15",
        source: "owner_stated",
      }),
    );
    ok(
      "a Stripe plan",
      await db()
        .from("deal_stripe_plan_objects")
        .insert({
          deal_id: dealId,
          stripe_object_id: `sub_correct_${dealId}`,
          object_type: "subscription",
          is_current: true,
          link_source: "owner_confirmed",
        }),
    );

    const refused = await correct(callId, { ownerDecision: "workshops_only" });
    expect(refused.status).toBe("ambiguous-downstream-state");
    expect(refused.category).toBe("won_opportunity");
    expect(refused.blockers).toContain("payment");
    expect(refused.blockers).toContain("stripe_plan");
    expect(refused.blockers).toContain("payment_setup");

    // The money is still there and so is the sale.
    const { data: items } = await db()
      .from("deal_payment_schedule_items")
      .select("status")
      .eq("deal_id", dealId);
    expect(items).toEqual([{ status: "paid" }]);
    expect((await dealRow(dealId)).stage).toBe("won");
  });

  test("a standing do-not-engage decision is not lifted by editing a call", async () => {
    const { dealId, callId } = await seed(15, "DoNotEngage", {
      deal: {
        stage: "call_booked",
        owner_decision: "do_not_engage",
        prospect_decision: null,
        follow_up_date: null,
        outcome: "lost",
      },
    });

    const refused = await correct(callId, {
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-11-30",
    });
    expect(refused.status).toBe("ambiguous-downstream-state");
    expect(refused.category).toBe("contact_sales_eligibility");

    const deal = await dealRow(dealId);
    expect(deal.owner_decision).toBe("do_not_engage");
    expect(deal.outcome).toBe("lost");
  });

  test("an archived Opportunity is not quietly brought back to life", async () => {
    const { dealId, callId } = await seed(16, "Archived", {
      deal: { archived_at: "2026-10-01T00:00:00.000Z" },
    });

    const refused = await correct(callId, { prospectDecision: "no" });
    expect(refused.status).toBe("ambiguous-downstream-state");
    expect(refused.category).toBe("archived_opportunity");
    expect((await dealRow(dealId)).prospect_decision).toBe("thinking");

    // Impressions are still fine: they say nothing about the pipeline.
    expect(
      (
        await correct(callId, {
          impressions: "Worth remembering.",
          impressionsMode: "set",
        })
      ).status,
    ).toBe("corrected");
  });

  test("a result a sales call never records is refused by name", async () => {
    const { callId } = await seed(17, "Ghosted");

    const refused = await correct(callId, { prospectDecision: "ghosted" });
    expect(refused.status).toBe("invalid-transition");
    expect(String(refused.reason)).toContain("Remove from pipeline");
  });

  test("a call with no recorded result is completed, not corrected", async () => {
    const { callId } = await seed(18, "StillBooked", {
      call: {
        status: "booked",
        attendance: null,
        attendance_recorded_at: null,
      },
      deal: {
        stage: "call_booked",
        owner_decision: null,
        prospect_decision: null,
        follow_up_date: null,
      },
    });

    expect((await correct(callId, { prospectDecision: "no" })).status).toBe(
      "not-completed",
    );
  });
});

test.describe("correcting a no-show that actually happened", () => {
  test("the Opportunity gains the decision it never had, and the tag goes", async () => {
    const { contactId, dealId, callId } = await seed(19, "ActuallyCame", {
      call: { attendance: "no_show" },
      deal: {
        stage: "call_booked",
        owner_decision: null,
        prospect_decision: null,
        follow_up_date: null,
      },
    });

    // record_sales_call_no_show() attaches a durable No-show tag, which is a
    // SUMMARY of history and becomes false once no no-show remains.
    const { data: tag, error: tagError } = await db()
      .from("tags")
      .insert({ name: "No-show", color: "#fde2e4" })
      .select("id")
      .single();
    ok("the No-show tag", { error: tagError });
    ok(
      "tagging the contact",
      await db()
        .from("contacts")
        .update({ tags: [tag!.id] })
        .eq("id", contactId),
    );

    // An attended call needs a decision; there is none on the Opportunity.
    expect((await correct(callId, { attendance: "attended" })).status).toBe(
      "validation-error",
    );

    const result = await correct(callId, {
      attendance: "attended",
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-11-05",
    });
    expect(result.status).toBe("corrected");

    const call = await callRow(callId);
    expect(call.attendance).toBe("attended");
    expect(call.status).toBe("completed");

    const deal = await dealRow(dealId);
    expect(deal.stage).toBe("decision");
    expect(deal.follow_up_date).toBe("2026-11-05");
    expect(await openFollowUpTasks(dealId)).toHaveLength(1);

    const { data: contact } = await db()
      .from("contacts")
      .select("tags")
      .eq("id", contactId)
      .single();
    expect(contact!.tags ?? []).not.toContain(tag!.id);

    // And it does not go back: retracting a recorded attendance has no safe
    // undo, whichever direction it came from.
    expect((await correct(callId, { attendance: "no_show" })).status).toBe(
      "ambiguous-downstream-state",
    );
  });

  test("a no-show on a Contact who no-showed elsewhere keeps the tag", async () => {
    const { contactId, dealId, callId } = await seed(20, "TwiceAbsent", {
      call: { attendance: "no_show" },
      deal: {
        stage: "call_booked",
        owner_decision: null,
        prospect_decision: null,
        follow_up_date: null,
      },
    });
    // A second, different call this Contact also did not attend.
    await addCall(contactId, dealId, "2026-09-01T15:00:00.000Z", {
      attendance: "no_show",
    });

    const { data: tag, error: tagError } = await db()
      .from("tags")
      .insert({ name: "No-show", color: "#fde2e4" })
      .select("id")
      .single();
    ok("the No-show tag", { error: tagError });
    ok(
      "tagging the contact",
      await db()
        .from("contacts")
        .update({ tags: [tag!.id] })
        .eq("id", contactId),
    );

    expect(
      (
        await correct(callId, {
          attendance: "attended",
          ownerDecision: "would_work_with",
          prospectDecision: "thinking",
          followUpDate: "2026-11-05",
        })
      ).status,
    ).toBe("corrected");

    const { data: contact } = await db()
      .from("contacts")
      .select("tags")
      .eq("id", contactId)
      .single();
    // Still true: they did not turn up for the other one.
    expect(contact!.tags ?? []).toContain(tag!.id);
  });
});

test.describe("completion and correction stay two different commands", () => {
  test("X. the completion command still refuses a conflicting re-completion", async () => {
    const { callId } = await seed(21, "StillRefuses");

    const { data, error } = await db().rpc("complete_attended_sales_call", {
      p_sales_call_id: callId,
      p_owner_decision: "do_not_engage",
      p_prospect_decision: null,
      p_follow_up_date: null,
      p_impressions: null,
    });
    ok("the completion call itself", { error });
    expect((data as Record<string, unknown>).status).toBe(
      "conflicting-outcome",
    );
  });
});
