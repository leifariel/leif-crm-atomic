import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// A WAITLIST PLACE CONVERTS WHEN THE SALE REALLY STARTS, NOT WHEN AN
// OPPORTUNITY APPEARS.
//
// WHY THIS CHANGES NOW. §4b Phase 2 will create an Interested Opportunity the
// moment an invitation is delivered. `handle_deal_waitlist_sync()` converted a
// waitlist entry for ANY active Opportunity whatever its stage, so that one
// change would have flipped all 54 people currently resting at `invited`
// straight to `converted` — as a silent side effect of a backfill.
//
// Leif's ruling: `invited` means invited and not yet progressed; `converted`
// begins at same-offer Application Received or later. So the trigger now asks
// what stage the sale is at.
//
// It must hold for BOTH ways a sale reaches that point: an Opportunity created
// directly at application_received (the public form), and an Interested
// Opportunity that later advances. The trigger is AFTER INSERT OR UPDATE, so
// both are the same question asked twice.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 977000;
// Seeded by this spec rather than borrowed: production's cohort ids do not
// exist in a clean room, and the ids other specs happen to leave behind are
// not ours to depend on.
const OWN_COHORT = BASE + 1;
const OTHER_COHORT = BASE + 2;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

/**
 * Two rounds of the same programme, so "its own cohort" is a real contrast.
 *
 * Upserted, not inserted: resetDb deliberately leaves `cohorts` alone — it is
 * reference data, not per-test state — so these survive into the second
 * browser project and inserting them twice is a duplicate key.
 */
const seedCohorts = async () => {
  const client = db();
  for (const [id, name] of [
    [OWN_COHORT, "The round they are waiting on"],
    [OTHER_COHORT, "A different round"],
  ] as const) {
    ok(
      `cohort ${id}`,
      await client
        .from("cohorts")
        .upsert({ id, offer_id: GYU, name, status: "draft" }),
    );
  }
};

/** One person, one waitlist place. Seeded per test — resetDb is auto. */
const seedPerson = async (
  n: number,
  {
    offer = LE,
    cohort = null,
    status = "invited",
  }: { offer?: number; cohort?: number | null; status?: string } = {},
) => {
  const client = db();
  const contactId = BASE + n;
  ok(
    `contact ${n}`,
    await client.from("contacts").insert({
      id: contactId,
      first_name: "Waitlist",
      last_name: `Case${n}`,
      email_jsonb: [{ email: `case${n}@convert.test`, type: "Work" }],
    }),
  );
  ok(
    `entry ${n}`,
    await client.from("waitlist_entries").insert({
      id: contactId,
      contact_id: contactId,
      offer_id: offer,
      cohort_id: cohort,
      status,
      joined_at: "2026-02-01T09:00:00.000Z",
      invited_at: status === "invited" ? "2026-03-01T09:00:00.000Z" : null,
    }),
  );
  return contactId;
};

const makeDeal = async (
  contactId: number,
  stage: string,
  {
    offer = LE,
    cohort = null as number | null,
    outcome = null as string | null,
  } = {},
) => {
  const { data, error } = await db()
    .from("deals")
    .insert({
      contact_id: contactId,
      offer_id: offer,
      cohort_id: cohort,
      stage,
      outcome,
      amount: 4000,
      entry_path: "other",
      description: "",
    })
    .select("id")
    .single();
  ok(`deal at ${stage}`, { error });
  return data!.id as number;
};

const entry = async (contactId: number) => {
  const { data, error } = await db()
    .from("waitlist_entries")
    .select("status, converted_at, converted_opportunity_id")
    .eq("contact_id", contactId)
    .single();
  ok("reading the entry", { error });
  return data!;
};

test.describe("a waitlist place converts at Application Received, not before", () => {
  test("A. an Interested Opportunity leaves an invited person invited", async () => {
    const contactId = await seedPerson(1, { status: "invited" });

    await makeDeal(contactId, "interested");

    const row = await entry(contactId);
    expect(row.status).toBe("invited");
    expect(row.converted_at).toBeNull();
    expect(row.converted_opportunity_id).toBeNull();
  });

  test("B. an Interested Opportunity leaves a waiting person waiting", async () => {
    const contactId = await seedPerson(2, { status: "waiting" });

    await makeDeal(contactId, "interested");

    const row = await entry(contactId);
    expect(row.status).toBe("waiting");
    expect(row.converted_at).toBeNull();
  });

  test("C. advancing Interested to Application Received converts it", async () => {
    const contactId = await seedPerson(3, { status: "invited" });
    const dealId = await makeDeal(contactId, "interested");
    expect((await entry(contactId)).status).toBe("invited");

    ok(
      "advancing the stage",
      await db()
        .from("deals")
        .update({ stage: "application_received" })
        .eq("id", dealId),
    );

    const row = await entry(contactId);
    expect(row.status).toBe("converted");
    expect(row.converted_opportunity_id).toBe(dealId);
    expect(row.converted_at).not.toBeNull();
  });

  test("D. an Opportunity created straight at Application Received converts it", async () => {
    // The real shimes06 path: the public form creates the Opportunity at
    // application_received, and the waitlist place is spent by it.
    const contactId = await seedPerson(4, { status: "invited" });

    const dealId = await makeDeal(contactId, "application_received");

    const row = await entry(contactId);
    expect(row.status).toBe("converted");
    expect(row.converted_opportunity_id).toBe(dealId);
  });

  test("E. advancing further does not re-convert or churn the timestamp", async () => {
    const contactId = await seedPerson(5, { status: "invited" });
    const dealId = await makeDeal(contactId, "application_received");
    const first = await entry(contactId);

    for (const stage of ["approved", "call_booked", "decision"]) {
      ok(
        `advancing to ${stage}`,
        await db().from("deals").update({ stage }).eq("id", dealId),
      );
    }

    const after = await entry(contactId);
    expect(after.status).toBe("converted");
    expect(after.converted_at).toBe(first.converted_at);
    expect(after.converted_opportunity_id).toBe(dealId);
  });

  test("F. an Opportunity for the other offer never converts this one", async () => {
    const contactId = await seedPerson(6, { offer: LE, status: "invited" });

    await makeDeal(contactId, "application_received", { offer: GYU });

    expect((await entry(contactId)).status).toBe("invited");
  });

  test("G. a cohort-specific place converts only for its own cohort", async () => {
    await seedCohorts();
    const contactId = await seedPerson(7, {
      offer: GYU,
      cohort: OWN_COHORT,
      status: "invited",
    });

    // A different round of the same programme is not the one they are waiting on.
    await makeDeal(contactId, "application_received", {
      offer: GYU,
      cohort: OTHER_COHORT,
    });
    expect((await entry(contactId)).status).toBe("invited");

    const right = await makeDeal(contactId, "application_received", {
      offer: GYU,
      cohort: OWN_COHORT,
    });
    const row = await entry(contactId);
    expect(row.status).toBe("converted");
    expect(row.converted_opportunity_id).toBe(right);
  });

  test("H. removed and already-converted places are never touched", async () => {
    const removed = await seedPerson(8, { status: "removed" });
    const converted = await seedPerson(9, { status: "converted" });

    await makeDeal(removed, "application_received");
    await makeDeal(converted, "application_received");

    expect((await entry(removed)).status).toBe("removed");
    const row = await entry(converted);
    expect(row.status).toBe("converted");
    // It was converted before this deal existed, and stays attributed to
    // whatever converted it — nothing, in this fixture.
    expect(row.converted_opportunity_id).toBeNull();
  });

  test("I. a concluded Opportunity converts nothing, at any stage", async () => {
    const nurtured = await seedPerson(10, { status: "invited" });
    const lost = await seedPerson(11, { status: "invited" });

    await makeDeal(nurtured, "application_received", { outcome: "nurture" });
    await makeDeal(lost, "application_received", { outcome: "lost" });

    expect((await entry(nurtured)).status).toBe("invited");
    expect((await entry(lost)).status).toBe("invited");
  });

  test("a won sale still converts the place", async () => {
    // Won carries no outcome, so it was always converting and must keep doing
    // so: somebody who bought is certainly not still waiting.
    const contactId = await seedPerson(12, { status: "invited" });

    const dealId = await makeDeal(contactId, "won");

    const row = await entry(contactId);
    expect(row.status).toBe("converted");
    expect(row.converted_opportunity_id).toBe(dealId);
  });
});
