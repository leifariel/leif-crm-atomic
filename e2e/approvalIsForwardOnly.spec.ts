import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// AN APPROVAL NEVER MOVES A SALE BACKWARD, AGAINST REAL POSTGRES.
//
// review_application() wrote stage = 'approved' on every approval, so a sale
// already at Call Booked or Decision was dragged back to Approved by its own
// application being reviewed. Celia (Opportunity 267) left the Call Booked
// column that way. These run the real function, the real stage triggers and
// the real deal_stage_events history:
//
//   A  interested           -> approved   advances
//   B  application_received -> approved   advances
//   C  approved             -> approved   no-op, no new stage event
//   D  call_booked + review stays call_booked
//   E  decision + review    stays decision
//   F  won cannot be demoted to approved (legacy onboarding cannot be
//      written at all — guard_persisted_onboarding_stage — so its
//      preservation is pinned by the contract test instead)
//   G  no stage event, and no stage_entered_at stamp, when stage is preserved
//
// And the parts of the review the repair must not have changed: the
// Application is still approved, the Review task still closes, outcome is
// still re-cleared, and the recommendation still moves the programme.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 981000;
const AT = "2026-11-01T15:00:00.000Z";

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

const seed = async (
  n: number,
  stage: string,
  { offerId = LE, deal = {} }: { offerId?: number; deal?: object } = {},
) => {
  const client = db();
  const contactId = BASE + n;
  ok(
    `contact ${n}`,
    await client.from("contacts").insert({
      id: contactId,
      first_name: "Forward",
      last_name: `Only${n}`,
      email_jsonb: [{ email: `forward${n}@review.test`, type: "Work" }],
    }),
  );

  const { data: created, error: dealError } = await client
    .from("deals")
    .insert({
      contact_id: contactId,
      offer_id: offerId,
      cohort_id: null,
      stage,
      amount: 4000,
      entry_path: "other",
      description: "",
      ...deal,
    })
    .select("id, stage_entered_at")
    .single();
  ok(`deal ${n}`, { error: dealError });

  const { data: app, error: appError } = await client
    .from("applications")
    .insert({
      contact_id: contactId,
      offer_id: offerId,
      intended_cohort_id: null,
      opportunity_id: created!.id,
      status: "pending",
      source: "public_form",
      submitted_at: AT,
      raw_answers: {},
    })
    .select("id")
    .single();
  ok(`application ${n}`, { error: appError });

  ok(
    `review task ${n}`,
    await client.from("tasks").insert({
      contact_id: contactId,
      type: "review_application",
      text: `Review Forward Only${n}`,
      due_date: AT,
      status: "pending",
    }),
  );

  return {
    contactId,
    dealId: created!.id as number,
    applicationId: app!.id as number,
    enteredAt: created!.stage_entered_at as string,
  };
};

const review = async (applicationId: number, outcome = "approved") => {
  const { data, error } = await db().rpc("review_application", {
    p_application_id: applicationId,
    p_outcome: outcome,
    p_cohort_id: null,
  });
  ok("review_application", { error });
  return data as Record<string, unknown>;
};

const dealOf = async (dealId: number) => {
  const { data } = await db()
    .from("deals")
    .select("stage, outcome, offer_id, stage_entered_at")
    .eq("id", dealId)
    .single();
  return data!;
};

const stageEvents = async (dealId: number) => {
  const { data } = await db()
    .from("deal_stage_events")
    .select("stage")
    .eq("opportunity_id", dealId)
    .order("id");
  return (data ?? []).map((row) => row.stage as string);
};

const applicationStatus = async (applicationId: number) => {
  const { data } = await db()
    .from("applications")
    .select("status")
    .eq("id", applicationId)
    .single();
  return data!.status as string;
};

const openReviewTasks = async (contactId: number) => {
  const { count } = await db()
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
    .eq("type", "review_application")
    .is("done_date", null);
  return count ?? 0;
};

test.describe("An approval never moves a sale backward", () => {
  test("A: interested advances to approved", async () => {
    const s = await seed(1, "interested");
    const result = await review(s.applicationId);
    expect(result.status).toBe("reviewed");
    expect(result.opportunity_stage).toBe("approved");
    expect((await dealOf(s.dealId)).stage).toBe("approved");
    expect(await stageEvents(s.dealId)).toEqual(["interested", "approved"]);
    expect(await applicationStatus(s.applicationId)).toBe("approved");
    expect(await openReviewTasks(s.contactId)).toBe(0);
  });

  test("B: application_received advances to approved", async () => {
    const s = await seed(2, "application_received");
    await review(s.applicationId);
    expect((await dealOf(s.dealId)).stage).toBe("approved");
    expect(await stageEvents(s.dealId)).toEqual([
      "application_received",
      "approved",
    ]);
  });

  test("C: approved stays approved, with no second Approved event", async () => {
    const s = await seed(3, "approved");
    await review(s.applicationId);
    const deal = await dealOf(s.dealId);
    expect(deal.stage).toBe("approved");
    expect(deal.stage_entered_at).toBe(s.enteredAt);
    expect(await stageEvents(s.dealId)).toEqual(["approved"]);
  });

  test("D: call_booked keeps its stage, and the application is still approved", async () => {
    const s = await seed(4, "call_booked");
    const result = await review(s.applicationId);
    expect(result.status).toBe("reviewed");
    expect(result.application_status).toBe("approved");
    expect(result.opportunity_stage).toBe("call_booked");
    expect((await dealOf(s.dealId)).stage).toBe("call_booked");
    expect(await applicationStatus(s.applicationId)).toBe("approved");
    expect(await openReviewTasks(s.contactId)).toBe(0);
  });

  test("E: decision keeps its stage", async () => {
    const s = await seed(5, "decision", {
      deal: {
        owner_decision: "would_work_with",
        prospect_decision: "thinking",
        follow_up_date: "2026-11-20",
      },
    });
    await review(s.applicationId);
    expect((await dealOf(s.dealId)).stage).toBe("decision");
  });

  test("E (bespoke): an accepted bespoke reply keeps a later stage too", async () => {
    const s = await seed(6, "call_booked");
    await review(s.applicationId, "bespoke_accepted");
    expect((await dealOf(s.dealId)).stage).toBe("call_booked");
    expect(await applicationStatus(s.applicationId)).toBe("bespoke_accepted");
  });

  test("E (recommendation): the programme moves, the stage does not go back", async () => {
    // The recommendation moves the SAME Opportunity to the other programme.
    // Only one other programme may be active for it to be unambiguous, which
    // is the clean room's own catalogue (LE + GYU) — and GYU has rounds, so
    // recommend from GYU into LE, which has none. Offers are not cleared
    // between specs, so any programme an earlier spec left active is set
    // aside for this test and restored after it, exactly as
    // applicationDecisionExpansion.spec.ts does.
    const client = db();
    const { data: others } = await client
      .from("offers")
      .select("id")
      .eq("is_active", true)
      .not("id", "in", `(${LE},${GYU})`);
    const setAside = (others ?? []).map((o) => o.id as number);
    if (setAside.length > 0) {
      ok(
        "set other programmes aside",
        await client
          .from("offers")
          .update({ is_active: false })
          .in("id", setAside),
      );
    }
    try {
      const s = await seed(7, "call_booked", { offerId: GYU });
      const result = await review(s.applicationId, "offered_other_programme");
      expect(result.status, JSON.stringify(result)).toBe("reviewed");
      const deal = await dealOf(s.dealId);
      expect(deal.offer_id).toBe(LE);
      expect(deal.stage).toBe("call_booked");
    } finally {
      if (setAside.length > 0) {
        ok(
          "restore other programmes",
          await client
            .from("offers")
            .update({ is_active: true })
            .in("id", setAside),
        );
      }
    }
  });

  test("F: a Won sale is not demoted to approved", async () => {
    const s = await seed(8, "won", {
      deal: { owner_decision: "would_work_with", prospect_decision: "yes" },
    });
    const result = await review(s.applicationId);
    expect(result.status).toBe("reviewed");
    expect((await dealOf(s.dealId)).stage).toBe("won");
    expect(await stageEvents(s.dealId)).toEqual(["won"]);
  });

  test("G: a preserved stage writes no stage event and no stage_entered_at", async () => {
    const s = await seed(9, "call_booked");
    const before = await stageEvents(s.dealId);
    await review(s.applicationId);
    const deal = await dealOf(s.dealId);
    expect(deal.stage_entered_at).toBe(s.enteredAt);
    expect(await stageEvents(s.dealId)).toEqual(before);
    expect(before).toEqual(["call_booked"]);
  });

  test("an approval still re-clears a prior review's outcome", async () => {
    const s = await seed(10, "call_booked", { deal: { outcome: "not_fit" } });
    await review(s.applicationId);
    const deal = await dealOf(s.dealId);
    expect(deal.outcome).toBeNull();
    expect(deal.stage).toBe("call_booked");
  });
});
