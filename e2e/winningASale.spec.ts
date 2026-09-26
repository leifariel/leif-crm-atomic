import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// Completing a sale, asked of a real database by doing it.
//
// This exists because the workflow silently stopped working in production.
// Migration 20260920120000 revoked EXECUTE on seed_enrollment_onboarding()
// from every client role; handle_deal_won() — the AFTER trigger that
// creates the Enrollment — was SECURITY INVOKER and calls it, so the
// transition failed with
//
//   42501 permission denied for function seed_enrollment_onboarding
//
// WHO that blocks matters, and is easy to get wrong. An ordinary signed-in
// user still cannot set Won by editing a Deal — handle_deal_saved() refuses
// it — but the REASON has changed since this was written, and the reason is
// the whole point.
//
// This file used to say "Won must only ever be reached by a real payment".
// 20260918180000 overturned that: "a model that treated Won as a payment
// fact. It is not. Won means the sale was accepted." The guard that encoded
// the old model was never retired, and for a week that made recording a
// sale from the CRM impossible — Becky Schmauch's call went in attended
// while her Opportunity stayed at Call Booked with no Enrollment.
//
// So what is refused now is a HAND-EDITED stage, not a role. The canonical
// sale actions (complete_attended_sales_call, record_prospect_accepted) are
// SECURITY DEFINER and run as the owner, which a client cannot become; the
// Stripe webhook still reaches it as `service_role`. Both halves are still
// asserted below: the webhook path must work, and the business refusal
// for an ordinary user must survive both fixes.
//
// It runs as the REAL roles against real Postgres, because that is the only
// place a privilege boundary exists. A FakeRest test cannot fail this way,
// which is precisely how the regression reached MAIN.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";

// How the Stripe webhook writes: the service role key, over PostgREST.
const asWebhook = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

// A client carrying a real signed-in user's JWT — `authenticated`.
const asSignedInUser = async (email: string, password: string) => {
  const client = createClient(
    SUPABASE_URL,
    process.env.VITE_SB_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error } = await client.auth.signInWithPassword({ email, password });
  expect(error).toBeNull();
  return client;
};

type Sale = { id: number | string };

const seedOpportunity = async (salesId: number | string, label: string) => {
  const admin = asWebhook();
  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .insert({ first_name: "Won", last_name: label, sales_id: salesId })
    .select("id")
    .single();
  expect(contactError).toBeNull();

  const { data: deal, error: dealError } = await admin
    .from("deals")
    .insert({
      name: `Won ${label}`,
      contact_id: contact!.id,
      offer_id: 1,
      stage: "interested",
      amount: 4000,
      sales_id: salesId,
      index: 0,
    })
    .select("id")
    .single();
  expect(dealError).toBeNull();
  return { admin, contactId: contact!.id, dealId: deal!.id };
};

const newSale = async (
  createSales: (args: {
    first_name: string;
    last_name: string;
    email: string;
    password: string;
  }) => Promise<Sale>,
  label: string,
) => {
  const email = `won-${label}-${Date.now()}@example.com`;
  const password = "Password123!";
  const sale = await createSales({
    first_name: "Won",
    last_name: label,
    email,
    password,
  });
  return { sale, email, password };
};

test.describe("completing a sale", () => {
  test("the payment path creates the Enrollment and seeds onboarding", async ({
    createSales,
  }) => {
    // The exact write the Stripe webhook makes. This is the one that was
    // failing in production: a client pays, and nothing is created.
    const { sale } = await newSale(createSales, "paid");
    const { admin, dealId } = await seedOpportunity(sale.id, "paid");

    const { error } = await admin
      .from("deals")
      .update({ stage: "won" })
      .eq("id", dealId);
    expect(error).toBeNull();

    const { data: enrollments } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(enrollments).toHaveLength(1);

    // And onboarding was actually seeded — the call that was denied.
    const { data: items } = await admin
      .from("enrollment_onboarding_items")
      .select("id")
      .eq("enrollment_id", enrollments![0]!.id);
    expect(items!.length).toBeGreaterThan(0);
  });

  test("a retried payment webhook does not duplicate the Enrollment or the checklist", async ({
    createSales,
  }) => {
    const { sale } = await newSale(createSales, "retry");
    const { admin, dealId } = await seedOpportunity(sale.id, "retry");

    await admin.from("deals").update({ stage: "won" }).eq("id", dealId);
    const { data: first } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    const { data: firstItems } = await admin
      .from("enrollment_onboarding_items")
      .select("id")
      .eq("enrollment_id", first![0]!.id);

    // Stripe retries. The guard against a second Enrollment has to survive
    // the elevation.
    const { error } = await admin
      .from("deals")
      .update({ stage: "won", description: "webhook retried" })
      .eq("id", dealId);
    expect(error).toBeNull();

    const { data: after } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(after).toHaveLength(1);
    expect(after![0]!.id).toBe(first![0]!.id);

    const { data: afterItems } = await admin
      .from("enrollment_onboarding_items")
      .select("id")
      .eq("enrollment_id", first![0]!.id);
    expect(afterItems!.length).toBe(firstItems!.length);
  });

  test("an ordinary signed-in user still cannot fabricate a Won sale", async ({
    createSales,
  }) => {
    // Not a side effect to be tolerated — a rule to be preserved. Won turns
    // into an Enrollment, an onboarding checklist and possibly a claimed
    // scholarship slot, so a CRM user typing into a stage field must not be
    // able to conjure all of that. Neither the privilege fix nor the sale
    // repair may weaken this.
    const { sale, email, password } = await newSale(createSales, "direct");
    const { admin, dealId } = await seedOpportunity(sale.id, "direct");
    const user = await asSignedInUser(email, password);

    const { error } = await user
      .from("deals")
      .update({ stage: "won" })
      .eq("id", dealId);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(
      /cannot be set to Won by editing its stage/i,
    );

    const { data: enrollments } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(enrollments).toHaveLength(0);
  });

  test("the privileged seeding function stays unreachable by a client", async ({
    createSales,
  }) => {
    // The whole reason the trigger was elevated rather than the callee
    // opened. A signed-in client must still not be able to seed a
    // checklist onto somebody's Enrollment directly.
    const { sale, email, password } = await newSale(createSales, "locked");
    const { admin, dealId } = await seedOpportunity(sale.id, "locked");
    await admin.from("deals").update({ stage: "won" }).eq("id", dealId);

    const { data: enrollment } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId)
      .single();

    const user = await asSignedInUser(email, password);
    const { error } = await user.rpc("seed_enrollment_onboarding", {
      p_enrollment_id: enrollment!.id,
    });
    expect(error).not.toBeNull();
    expect(`${error?.message} ${error?.code}`).toMatch(
      /permission denied|42501|not find the function|PGRST202/i,
    );
  });

  test("an unrelated Opportunity update creates nothing", async ({
    createSales,
  }) => {
    const { sale, email, password } = await newSale(createSales, "unrelated");
    const { admin, dealId } = await seedOpportunity(sale.id, "unrelated");
    const user = await asSignedInUser(email, password);

    const { error } = await user
      .from("deals")
      .update({ description: "just a note" })
      .eq("id", dealId);
    expect(error).toBeNull();

    const { data: enrollments } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(enrollments).toHaveLength(0);
  });
});

// Finishing a sale that half-landed, as the signed-in user who has to do it.
//
// Becky Schmauch's Opportunity read "Sales Call · Completed / Attended" with
// no decision and no Enrollment, because her attendance and her Won write
// were two separate requests and only the first survived. The repair made
// the RPC convergent; this asserts it where Enrollments actually exist, as
// `authenticated` rather than as the owner, so a future change to the
// function cannot quietly take the recovery away again.
test.describe("finishing a sale whose decision never landed", () => {
  const seedAttendedCallWithNoDecision = async (
    salesId: number | string,
    label: string,
  ) => {
    const { admin, contactId, dealId } = await seedOpportunity(salesId, label);
    await admin.from("deals").update({ stage: "call_booked" }).eq("id", dealId);

    const attendedAt = new Date(Date.now() - 86_400_000).toISOString();
    const { data: call, error } = await admin
      .from("sales_calls")
      .insert({
        opportunity_id: dealId,
        contact_id: contactId,
        scheduled_at: attendedAt,
        original_scheduled_at: attendedAt,
        status: "completed",
        source: "manual",
        attendance: "attended",
        attendance_recorded_at: attendedAt,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return { admin, dealId, callId: call!.id };
  };

  // The ordinary case, for contrast: a booked call nobody has resolved yet.
  const seedUnresolvedCall = async (
    salesId: number | string,
    label: string,
  ) => {
    const { admin, contactId, dealId } = await seedOpportunity(salesId, label);
    await admin.from("deals").update({ stage: "call_booked" }).eq("id", dealId);

    const bookedFor = new Date(Date.now() - 3_600_000).toISOString();
    const { data: call, error } = await admin
      .from("sales_calls")
      .insert({
        opportunity_id: dealId,
        contact_id: contactId,
        scheduled_at: bookedFor,
        original_scheduled_at: bookedFor,
        status: "booked",
        source: "manual",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return { admin, dealId, callId: call!.id };
  };

  test("the ordinary path still works: a fresh attended call plus Yes wins the sale", async ({
    createSales,
  }) => {
    // The repair must not be reachable only through the recovery. This is
    // the normal workflow, on a call that was never resolved.
    const { sale, email, password } = await newSale(createSales, "fresh");
    const { admin, dealId, callId } = await seedUnresolvedCall(
      sale.id,
      "fresh",
    );
    const user = await asSignedInUser(email, password);

    const { data: result, error } = await user.rpc(
      "complete_attended_sales_call",
      {
        p_sales_call_id: callId,
        p_owner_decision: "would_work_with",
        p_prospect_decision: "yes",
        p_follow_up_date: null,
      },
    );
    expect(error).toBeNull();
    expect(result.status).toBe("completed");
    expect(result.stage).toBe("won");

    // The attendance it did not have is now recorded, once.
    const { data: call } = await admin
      .from("sales_calls")
      .select("attendance, status")
      .eq("id", callId)
      .single();
    expect(call!.attendance).toBe("attended");
    expect(call!.status).toBe("completed");
    const { data: events } = await admin
      .from("sales_call_events")
      .select("id")
      .eq("sales_call_id", callId)
      .eq("kind", "attendance_recorded");
    expect(events).toHaveLength(1);

    const { data: enrollments } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(enrollments).toHaveLength(1);
  });

  test("a signed-in user can converge it into Won, with exactly one Enrollment", async ({
    createSales,
  }) => {
    const { sale, email, password } = await newSale(createSales, "converge");
    const { admin, dealId, callId } = await seedAttendedCallWithNoDecision(
      sale.id,
      "converge",
    );
    const user = await asSignedInUser(email, password);

    const { data: result, error } = await user.rpc(
      "complete_attended_sales_call",
      {
        p_sales_call_id: callId,
        p_owner_decision: "would_work_with",
        p_prospect_decision: "yes",
        p_follow_up_date: null,
      },
    );
    expect(error).toBeNull();
    // Not "already-completed" — that refusal is what stranded her.
    expect(result.status).toBe("converged");
    expect(result.stage).toBe("won");

    const { data: enrollments } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(enrollments).toHaveLength(1);

    const { data: items } = await admin
      .from("enrollment_onboarding_items")
      .select("id")
      .eq("enrollment_id", enrollments![0]!.id);
    expect(items!.length).toBeGreaterThan(0);

    // And no second attendance in her history.
    const { data: events } = await admin
      .from("sales_call_events")
      .select("id")
      .eq("sales_call_id", callId)
      .eq("kind", "attendance_recorded");
    expect(events).toHaveLength(1);
  });

  test("a second click changes nothing", async ({ createSales }) => {
    const { sale, email, password } = await newSale(createSales, "twice");
    const { admin, dealId, callId } = await seedAttendedCallWithNoDecision(
      sale.id,
      "twice",
    );
    const user = await asSignedInUser(email, password);

    const args = {
      p_sales_call_id: callId,
      p_owner_decision: "would_work_with",
      p_prospect_decision: "yes",
      p_follow_up_date: null,
    };
    await user.rpc("complete_attended_sales_call", args);
    const { data: second } = await user.rpc(
      "complete_attended_sales_call",
      args,
    );
    expect(second.status).toBe("converged");

    const { data: enrollments } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(enrollments).toHaveLength(1);
  });

  test("a decision that disagrees with the record is refused, not applied", async ({
    createSales,
  }) => {
    const { sale, email, password } = await newSale(createSales, "conflict");
    const { admin, dealId, callId } = await seedAttendedCallWithNoDecision(
      sale.id,
      "conflict",
    );
    const user = await asSignedInUser(email, password);

    await user.rpc("complete_attended_sales_call", {
      p_sales_call_id: callId,
      p_owner_decision: "would_work_with",
      p_prospect_decision: "yes",
      p_follow_up_date: null,
    });

    // Somebody now says the same call ended as No.
    const { data: result } = await user.rpc("complete_attended_sales_call", {
      p_sales_call_id: callId,
      p_owner_decision: "would_work_with",
      p_prospect_decision: "no",
      p_follow_up_date: null,
    });
    expect(result.status).toBe("conflicting-outcome");
    // It says what it found, so the UI can be specific.
    expect(result.reason).toMatch(/already recorded/i);

    const { data: deal } = await admin
      .from("deals")
      .select("stage, prospect_decision, outcome")
      .eq("id", dealId)
      .single();
    expect(deal!.stage).toBe("won");
    expect(deal!.prospect_decision).toBe("yes");
    expect(deal!.outcome).toBeNull();
  });

  test("a no-show is never reopened as attended", async ({ createSales }) => {
    const { sale, email, password } = await newSale(createSales, "noshow");
    const { admin, dealId, callId } = await seedAttendedCallWithNoDecision(
      sale.id,
      "noshow",
    );
    await admin
      .from("sales_calls")
      .update({ attendance: "no_show" })
      .eq("id", callId);
    const user = await asSignedInUser(email, password);

    const { data: result } = await user.rpc("complete_attended_sales_call", {
      p_sales_call_id: callId,
      p_owner_decision: "would_work_with",
      p_prospect_decision: "yes",
      p_follow_up_date: null,
    });
    expect(result.status).toBe("already-completed");

    const { data: call } = await admin
      .from("sales_calls")
      .select("attendance")
      .eq("id", callId)
      .single();
    expect(call!.attendance).toBe("no_show");

    const { data: enrollments } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(enrollments).toHaveLength(0);
  });
});
