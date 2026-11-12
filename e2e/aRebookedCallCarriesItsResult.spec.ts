import { execFileSync } from "node:child_process";

import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// A REBOOKED CALL CARRIES ITS OWN RESULT, AGAINST REAL POSTGRES.
//
// Celia's shape (contact 335): she booked Nov 3 (call 330, Acuity
// 1773916549), cancelled, and rebooked for Oct 30 (call 1330, Acuity
// 1774520411). The Oct 30 call happened. Its result was recorded on 330,
// because 1330 had not arrived from Acuity yet.
//
//   H  cancel/rebook with different upstream ids stays two distinct episodes
//   I  the replacement becomes the authoritative completed episode
//   J  the original keeps its schedule, original schedule and Acuity id
//   K  the result is reconciled exactly once; a repeat writes nothing
//   L  no third episode is created
//   M  no duplicate attendance or result anywhere
//
// plus: the Opportunity is untouched, its correction authority now targets
// the replacement, every refusal writes nothing, and no API role can call
// the function at all.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const DB_CONTAINER = "supabase_db_atomic-crm-e2e";
const LE = 1;
const BASE = 995000;
const NOV3 = "2026-11-03T18:00:00.000Z";
const OCT30 = "2026-10-30T18:00:00.000Z";
const RECORDED = "2026-10-30T18:28:06.000Z";
const IMPRESSIONS = "Uncertain about marriage. Would be a good fit.";

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const psql = (sql: string) =>
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      DB_CONTAINER,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-t",
      "-A",
      "-U",
      "postgres",
      "-d",
      "postgres",
    ],
    { encoding: "utf8", input: sql },
  ).trim();

const reconcile = (original: number, replacement: number) =>
  JSON.parse(
    psql(
      `select public.reconcile_rebooked_sales_call_result(${original}, ${replacement});`,
    ),
  ) as Record<string, unknown>;

const must = <T>(
  step: string,
  r: { data: T; error: { message: string } | null },
) => {
  if (r.error) throw new Error(`${step}: ${r.error.message}`);
  return r.data;
};

const seed = async (
  n: number,
  {
    replacement: replacementFields = {},
    original: originalFields = {},
    replacementFirst = false,
  }: {
    replacement?: Record<string, unknown>;
    original?: Record<string, unknown>;
    replacementFirst?: boolean;
  } = {},
) => {
  const client = db();
  const contactId = BASE + n;
  must(
    "contact",
    await client.from("contacts").insert({
      id: contactId,
      first_name: "Rebook",
      last_name: `Celia${n}`,
      email_jsonb: [{ email: `rebook${n}@calls.test`, type: "Work" }],
    }),
  );
  const deal = must(
    "deal",
    await client
      .from("deals")
      .insert({
        contact_id: contactId,
        offer_id: LE,
        cohort_id: null,
        stage: "decision",
        amount: 4000,
        entry_path: "other",
        description: "",
        owner_decision: "would_work_with",
        prospect_decision: "thinking",
        follow_up_date: "2026-11-03",
      })
      .select("id")
      .single(),
  ) as { id: number };

  const insertOriginal = async () =>
    (
      must(
        "original",
        await client
          .from("sales_calls")
          .insert({
            opportunity_id: deal.id,
            contact_id: contactId,
            status: "completed",
            attendance: "attended",
            attendance_recorded_at: RECORDED,
            impressions: IMPRESSIONS,
            original_scheduled_at: NOV3,
            scheduled_at: NOV3,
            schedule_precision: "exact",
            source: "acuity",
            acuity_appointment_id: `${n}773916549`,
            ...originalFields,
          })
          .select("id")
          .single(),
      ) as { id: number }
    ).id;
  const insertReplacement = async () =>
    (
      must(
        "replacement",
        await client
          .from("sales_calls")
          .insert({
            opportunity_id: deal.id,
            contact_id: contactId,
            status: "booked",
            original_scheduled_at: OCT30,
            scheduled_at: OCT30,
            schedule_precision: "exact",
            source: "acuity",
            acuity_appointment_id: `${n}774520411`,
            ...replacementFields,
          })
          .select("id")
          .single(),
      ) as { id: number }
    ).id;

  let originalId: number;
  let replacementId: number;
  if (replacementFirst) {
    replacementId = await insertReplacement();
    originalId = await insertOriginal();
  } else {
    originalId = await insertOriginal();
    // created_at is now() on both; a gap keeps "booked later" unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 20));
    replacementId = await insertReplacement();
  }

  must(
    "the original attendance event",
    await client.from("sales_call_events").insert({
      sales_call_id: originalId,
      kind: "attendance_recorded",
      occurred_at: RECORDED,
      attendance: "attended",
    }),
  );
  must(
    "a task about the replacement booking",
    await client.from("tasks").insert({
      contact_id: contactId,
      sales_call_id: replacementId,
      type: "sales_call",
      text: `Sales call with Rebook Celia${n}`,
      due_date: OCT30,
      status: "pending",
    }),
  );

  return { contactId, dealId: deal.id, originalId, replacementId };
};

const callsOf = async (dealId: number) =>
  must(
    "calls",
    await db()
      .from("sales_calls")
      .select(
        "id, status, attendance, attendance_recorded_at, impressions, scheduled_at, original_scheduled_at, acuity_appointment_id, cancelled_at",
      )
      .eq("opportunity_id", dealId)
      .order("id"),
  ) as Array<Record<string, unknown>>;

const eventsOf = async (callIds: number[]) =>
  must(
    "events",
    await db()
      .from("sales_call_events")
      .select("sales_call_id, kind, attendance, correction")
      .in("sales_call_id", callIds)
      .order("id"),
  ) as Array<Record<string, unknown>>;

const dealOf = async (dealId: number) =>
  must(
    "deal",
    await db()
      .from("deals")
      .select(
        "stage, outcome, owner_decision, prospect_decision, follow_up_date",
      )
      .eq("id", dealId)
      .single(),
  );

const sameInstant = (a: unknown, b: string) =>
  expect(new Date(String(a)).toISOString()).toBe(new Date(b).toISOString());

test.describe("a rebooked call carries its own result", () => {
  test("H-M: the result moves to the call that happened, once, and provenance stays put", async () => {
    const s = await seed(1);
    const dealBefore = await dealOf(s.dealId);
    const { count: stageEventsBefore } = await db()
      .from("deal_stage_events")
      .select("id", { count: "exact", head: true })
      .eq("opportunity_id", s.dealId);

    const result = reconcile(s.originalId, s.replacementId);
    expect(result.status, JSON.stringify(result)).toBe("reconciled");
    expect(result.replacement_tasks_completed).toBe(1);

    const calls = await callsOf(s.dealId);
    // L: still exactly two episodes. H: still two distinct upstream ids.
    expect(calls).toHaveLength(2);
    const original = calls.find((c) => c.id === s.originalId)!;
    const replacement = calls.find((c) => c.id === s.replacementId)!;
    expect(original.acuity_appointment_id).not.toBe(
      replacement.acuity_appointment_id,
    );

    // I: the replacement is the completed, attended episode, carrying the
    // result as it was recorded (not re-stamped now).
    expect(replacement.status).toBe("completed");
    expect(replacement.attendance).toBe("attended");
    expect(replacement.impressions).toBe(IMPRESSIONS);
    sameInstant(replacement.attendance_recorded_at, RECORDED);
    sameInstant(replacement.scheduled_at, OCT30);
    expect(replacement.acuity_appointment_id).toBe("1774520411");

    // J: the original keeps every provenance field, and no longer claims the
    // call happened.
    sameInstant(original.scheduled_at, NOV3);
    sameInstant(original.original_scheduled_at, NOV3);
    expect(original.acuity_appointment_id).toBe("1773916549");
    expect(original.status).toBe("cancelled");
    expect(original.cancelled_at).not.toBeNull();
    expect(original.attendance).toBeNull();
    expect(original.impressions).toBeNull();

    // M: exactly one episode carries a result.
    expect(calls.filter((c) => c.attendance != null)).toHaveLength(1);

    // History: the original attendance event untouched; one cancellation;
    // one reconciliation on EACH episode, each naming the other.
    const events = await eventsOf([s.originalId, s.replacementId]);
    expect(
      events.filter(
        (e) =>
          e.sales_call_id === s.originalId && e.kind === "attendance_recorded",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (e) =>
          e.kind === "attendance_recorded" &&
          e.sales_call_id === s.replacementId,
      ),
    ).toHaveLength(0);
    expect(
      events.filter(
        (e) => e.sales_call_id === s.originalId && e.kind === "cancelled",
      ),
    ).toHaveLength(1);
    const reconciled = events.filter((e) => e.kind === "result_reconciled");
    expect(reconciled).toHaveLength(2);
    for (const e of reconciled) {
      const c = e.correction as Record<string, unknown>;
      expect(c.from_sales_call_id).toBe(s.originalId);
      expect(c.to_sales_call_id).toBe(s.replacementId);
      expect((c.moved as Record<string, unknown>).impressions).toBe(
        IMPRESSIONS,
      );
    }

    // The Opportunity is untouched: same facts, no stage history appended.
    expect(await dealOf(s.dealId)).toEqual(dealBefore);
    const { count: stageEventsAfter } = await db()
      .from("deal_stage_events")
      .select("id", { count: "exact", head: true })
      .eq("opportunity_id", s.dealId);
    expect(stageEventsAfter).toBe(stageEventsBefore);

    // The replacement's own Task is done, not left open.
    const { count: openTasks } = await db()
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("sales_call_id", s.replacementId)
      .is("done_date", null);
    expect(openTasks).toBe(0);

    // K: a repeat is an answer, not a second write.
    const again = reconcile(s.originalId, s.replacementId);
    expect(again.status).toBe("already-reconciled");
    expect(await eventsOf([s.originalId, s.replacementId])).toEqual(events);
    expect(await callsOf(s.dealId)).toEqual(calls);
  });

  test("afterwards the correction authority targets the call that happened", async () => {
    const s = await seed(2);
    reconcile(s.originalId, s.replacementId);
    const client = db();

    // The original has no result left to correct.
    const onOriginal = must(
      "correct the original",
      await client.rpc("correct_completed_sales_call", {
        p_sales_call_id: s.originalId,
        p_follow_up_date: "2026-11-20",
      }),
    ) as Record<string, unknown>;
    expect(onOriginal.status).toBe("not-completed");

    // The replacement is the latest attended episode, so it may move the
    // Opportunity's current truth.
    const onReplacement = must(
      "correct the replacement",
      await client.rpc("correct_completed_sales_call", {
        p_sales_call_id: s.replacementId,
        p_follow_up_date: "2026-11-20",
      }),
    ) as Record<string, unknown>;
    expect(onReplacement.status, JSON.stringify(onReplacement)).toBe(
      "corrected",
    );
    expect((await dealOf(s.dealId))?.follow_up_date).toBe("2026-11-20");
  });

  test("refuses, writing nothing, every shape where the answer would be a guess", async () => {
    // A replacement that already has a result would become a second one.
    const hasResult = await seed(3, {
      replacement: {
        status: "completed",
        attendance: "attended",
        attendance_recorded_at: RECORDED,
      },
    });
    const before3 = await callsOf(hasResult.dealId);
    expect(
      reconcile(hasResult.originalId, hasResult.replacementId),
    ).toMatchObject({
      status: "refused",
      category: "replacement_not_open",
    });
    expect(await callsOf(hasResult.dealId)).toEqual(before3);

    // Booked BEFORE the original: it did not replace it.
    const backwards = await seed(4, { replacementFirst: true });
    expect(
      reconcile(backwards.originalId, backwards.replacementId),
    ).toMatchObject({
      status: "refused",
      category: "not_a_rebooking",
    });

    // Nothing recorded on the original: nothing to move.
    const nothing = await seed(5, {
      original: {
        attendance: null,
        attendance_recorded_at: null,
        impressions: null,
      },
    });
    expect(reconcile(nothing.originalId, nothing.replacementId)).toMatchObject({
      status: "refused",
      category: "nothing_to_move",
    });

    // A third call on the Opportunity also has a result: which one happened
    // is not certain.
    const ambiguous = await seed(6);
    must(
      "a third attended call",
      await db().from("sales_calls").insert({
        opportunity_id: ambiguous.dealId,
        contact_id: ambiguous.contactId,
        status: "completed",
        attendance: "attended",
        attendance_recorded_at: "2026-09-01T18:00:00.000Z",
        original_scheduled_at: "2026-09-01T18:00:00.000Z",
        scheduled_at: "2026-09-01T18:00:00.000Z",
        schedule_precision: "exact",
        source: "manual",
      }),
    );
    expect(
      reconcile(ambiguous.originalId, ambiguous.replacementId),
    ).toMatchObject({
      status: "refused",
      category: "ambiguous_episode",
    });

    // The same row twice, and a pair on two Opportunities.
    expect(reconcile(ambiguous.originalId, ambiguous.originalId).status).toBe(
      "validation-error",
    );
    expect(
      reconcile(hasResult.originalId, ambiguous.replacementId),
    ).toMatchObject({
      status: "refused",
      category: "different_opportunity",
    });

    // None of the refusals wrote an event.
    const events = await eventsOf([
      backwards.originalId,
      backwards.replacementId,
      nothing.originalId,
      nothing.replacementId,
      ambiguous.originalId,
      ambiguous.replacementId,
    ]);
    expect(events.filter((e) => e.kind !== "attendance_recorded")).toEqual([]);
  });

  test("no API role can call it — it is a repair authority, not a button", async () => {
    const s = await seed(7);
    const { error } = await db().rpc("reconcile_rebooked_sales_call_result", {
      p_original_sales_call_id: s.originalId,
      p_replacement_sales_call_id: s.replacementId,
    });
    expect(error).not.toBeNull();
    const privileges = psql(`
      select string_agg(r || '=' || has_function_privilege(r,
        'public.reconcile_rebooked_sales_call_result(bigint, bigint)', 'EXECUTE')::text, ',' order by r)
        from unnest(array['anon','authenticated','service_role']) r;`);
    expect(privileges).toBe(
      "anon=false,authenticated=false,service_role=false",
    );
    expect(
      (await callsOf(s.dealId)).find((c) => c.id === s.originalId)!.status,
    ).toBe("completed");
  });
});
