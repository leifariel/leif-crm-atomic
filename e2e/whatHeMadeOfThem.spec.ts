import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// WHAT LEIF MADE OF THE CALL, AGAINST REAL POSTGRES.
//
// Sales Call Workflow Part 1. The impression joins the EXISTING atomic
// completion path — `complete_attended_sales_call()` — rather than getting a
// save of its own, because a second request is how you end up with a call
// whose decision landed and whose impression did not.
//
// The three facts only a real database can settle:
//
//   I  the impression lands on the call EPISODE, in the same transaction as
//      the attendance, the decisions and the follow-up date
//   J  omitting it is valid, and leaves null rather than an empty string
//   K  the 135 historical completed calls with no attendance at all stay
//      schema-valid — no NOT NULL was imposed on history
//
// Plus the rule that matters once correction exists (Part 2): a converging
// replay may ADD an impression, and may never erase one.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const BASE = 952000;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

/** A Contact, an Opportunity at Call Booked, and a booked call on it. */
const seedBookedCall = async (n: number) => {
  const client = db();
  const contactId = BASE + n;

  ok(
    `contact ${n}`,
    await client.from("contacts").insert({
      id: contactId,
      first_name: "Impression",
      last_name: `Case${n}`,
      email_jsonb: [{ email: `impression${n}@sales.test`, type: "Work" }],
    }),
  );

  const { data: deal, error: dealError } = await client
    .from("deals")
    .insert({
      contact_id: contactId,
      offer_id: LE,
      cohort_id: null,
      stage: "call_booked",
      amount: 4000,
      entry_path: "other",
      description: "",
    })
    .select("id")
    .single();
  ok(`deal ${n}`, { error: dealError });

  const at = "2026-09-17T15:00:00.000Z";
  const { data: call, error: callError } = await client
    .from("sales_calls")
    .insert({
      opportunity_id: deal!.id,
      contact_id: contactId,
      status: "booked",
      original_scheduled_at: at,
      scheduled_at: at,
      scheduled_on: "2026-09-17",
      schedule_precision: "exact",
      source: "manual",
    })
    .select("id")
    .single();
  ok(`call ${n}`, { error: callError });

  return { contactId, dealId: deal!.id as number, callId: call!.id as number };
};

const complete = async (
  callId: number,
  args: {
    ownerDecision: string;
    prospectDecision?: string | null;
    followUpDate?: string | null;
    impressions?: string | null;
  },
) => {
  const { data, error } = await db().rpc("complete_attended_sales_call", {
    p_sales_call_id: callId,
    p_owner_decision: args.ownerDecision,
    p_prospect_decision: args.prospectDecision ?? null,
    p_follow_up_date: args.followUpDate ?? null,
    p_impressions: args.impressions ?? null,
  });
  ok("the completion call itself", { error });
  return data as Record<string, unknown>;
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
    .select("stage, owner_decision, prospect_decision, follow_up_date, outcome")
    .eq("id", dealId)
    .single();
  return data!;
};

test.describe("the impression belongs to the call, and to the same transaction", () => {
  test("I. completion persists the impression on the call episode, with everything else", async () => {
    const { dealId, callId } = await seedBookedCall(1);

    const result = await complete(callId, {
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-09-25",
      impressions: "Warm, clear about the money, wants to talk to her partner.",
    });

    expect(result.status).toBe("completed");
    expect(result.impressions).toBe(
      "Warm, clear about the money, wants to talk to her partner.",
    );

    // One transaction: the call episode AND the Opportunity moved together.
    const call = await callRow(callId);
    expect(call.status).toBe("completed");
    expect(call.attendance).toBe("attended");
    expect(call.attendance_recorded_at).not.toBeNull();
    expect(call.impressions).toBe(
      "Warm, clear about the money, wants to talk to her partner.",
    );

    const deal = await dealRow(dealId);
    expect(deal.stage).toBe("decision");
    expect(deal.owner_decision).toBe("would_work_with");
    expect(deal.prospect_decision).toBe("thinking");
    expect(deal.follow_up_date).toBe("2026-09-25");
  });

  test("J. completion with no impression is valid, and leaves null not empty string", async () => {
    const { callId } = await seedBookedCall(2);

    const result = await complete(callId, {
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-09-25",
    });

    expect(result.status).toBe("completed");
    const call = await callRow(callId);
    expect(call.attendance).toBe("attended");
    expect(call.impressions).toBeNull();
  });

  test("whitespace is not an impression", async () => {
    const { callId } = await seedBookedCall(3);

    await complete(callId, {
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-09-25",
      impressions: "   \n  ",
    });

    expect((await callRow(callId)).impressions).toBeNull();
  });

  test("a converging replay may ADD an impression, and may never erase one", async () => {
    const { callId } = await seedBookedCall(4);

    // First pass: the decision lands, no impression.
    await complete(callId, {
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-09-25",
    });
    expect((await callRow(callId)).impressions).toBeNull();

    // Second pass with the same decision but an impression: convergence.
    const second = await complete(callId, {
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-09-25",
      impressions: "Remembered after the fact: she mentioned a deadline.",
    });
    expect(second.status).toBe("converged");
    expect((await callRow(callId)).impressions).toBe(
      "Remembered after the fact: she mentioned a deadline.",
    );

    // Third pass with nothing: blank means UNCHANGED, never "delete what he
    // wrote". Deliberate clearing is Part 2's correction path.
    const third = await complete(callId, {
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-09-25",
    });
    expect(third.status).toBe("converged");
    expect((await callRow(callId)).impressions).toBe(
      "Remembered after the fact: she mentioned a deadline.",
    );
  });

  test("M. replaying an identical completion creates no second outcome", async () => {
    const { dealId, callId } = await seedBookedCall(5);

    await complete(callId, {
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-09-25",
      impressions: "Steady.",
    });
    await complete(callId, {
      ownerDecision: "would_work_with",
      prospectDecision: "thinking",
      followUpDate: "2026-09-25",
      impressions: "Steady.",
    });

    // One call row, one attendance event, one Opportunity.
    const { data: calls } = await db()
      .from("sales_calls")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(calls).toHaveLength(1);

    const { data: events } = await db()
      .from("sales_call_events")
      .select("id")
      .eq("sales_call_id", callId)
      .eq("kind", "attendance_recorded");
    expect(events).toHaveLength(1);
  });
});

test.describe("history is not retrofitted", () => {
  test("K. a completed call with no attendance and no impression stays valid", async () => {
    // 176 completed calls exist in production and 135 record no attendance at
    // all, because they predate the field. Imposing NOT NULL on either column
    // would have made those rows unwritable. This proves the schema still
    // accepts the shape history is actually in.
    const { contactId, dealId } = await seedBookedCall(6);

    const { error } = await db()
      .from("sales_calls")
      .insert({
        opportunity_id: dealId,
        contact_id: contactId,
        status: "completed",
        original_scheduled_at: null,
        scheduled_at: null,
        scheduled_on: "2025-11-04",
        schedule_precision: "date_only",
        source: "manual",
        attendance: null,
        impressions: null,
      })
      .select("id")
      .single();

    expect(error?.message ?? null).toBeNull();
  });
});

test.describe("only the CRM may complete a call", () => {
  test("U. anon cannot execute the completion command", async () => {
    const anon = createClient(
      SUPABASE_URL,
      process.env.VITE_SB_PUBLISHABLE_KEY ?? process.env.ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { error } = await anon.rpc("complete_attended_sales_call", {
      p_sales_call_id: 1,
      p_owner_decision: "would_work_with",
      p_prospect_decision: "thinking",
      p_follow_up_date: null,
      p_impressions: null,
    });

    expect(error, "anon EXECUTE was not refused").not.toBeNull();
  });
});
