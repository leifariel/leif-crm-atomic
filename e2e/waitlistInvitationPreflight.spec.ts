import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// The snapshot Leif confirms, and what may be done with it.
//
// "Oldest 25" has to mean the oldest 25 who can actually be sent something,
// and whether Kit will deliver to somebody is a fact only Kit holds. The
// preflight service asks it and writes down the answer; these tests are
// about what that written answer is allowed to cause.
//
// The Kit lookups themselves are proved in
// supabase/functions/kit_sync/kitSyncProcessor.test.ts, against a stubbed
// Kit, because creating a genuinely cancelled subscriber in Leif's real
// account to watch the gate work would contaminate it with a person who
// does not exist. What is proved HERE is the database half: a snapshot is
// inert, it is the named list that gets invited, somebody who changed since
// is reported rather than replaced, and a snapshot is spent once.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 968000;
const LE_TAG = 881001;
const GYU_TAG = 881002;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

const seed = async (
  people: Array<{ n: number; name: string; day: string; offer?: number }>,
) => {
  const client = db();
  for (const person of people) {
    const id = BASE + person.n;
    ok(
      `contact ${person.name}`,
      await client.from("contacts").insert({
        id,
        first_name: person.name.split(" ")[0],
        last_name: person.name.split(" ").slice(1).join(" ") || "Waiting",
        email_jsonb: [{ email: `p${person.n}@preflight.test`, type: "Work" }],
        sales_eligibility: "normal",
      }),
    );
    ok(
      `place ${person.name}`,
      await client.from("waitlist_entries").insert({
        id,
        contact_id: id,
        offer_id: person.offer ?? LE,
        cohort_id: null,
        status: "waiting",
        source: "manual",
        joined_at: `${person.day}T09:00:00.000Z`,
      }),
    );
  }
};

const mapTag = async (offerId: number, tagId: number, name: string) =>
  ok(
    `mapping ${name}`,
    await db().from("kit_tag_mappings").upsert(
      {
        offer_id: offerId,
        event: "waitlist_invited",
        kit_tag_id: tagId,
        kit_tag_name: name,
      },
      { onConflict: "offer_id,event" },
    ),
  );

/**
 * A snapshot exactly as the preflight service writes one.
 *
 * `kitState` is what Kit said about each person — the service calls Kit and
 * records this; here it is stated, so a cancelled subscriber can be
 * represented without one existing anywhere.
 */
const writeSnapshot = async (
  offerId: number,
  requested: number,
  people: Array<{ n: number; kitState: string | null; day: string }>,
) => {
  const client = db();
  const { data: preflight, error } = await client
    .from("waitlist_invitation_preflights")
    .insert({ offer_id: offerId, cohort_id: null, requested, resolved: 0 })
    .select("id")
    .single();
  ok("the snapshot", { error });

  let rank = 0;
  const rows = people.map((person) => {
    const safe = person.kitState === null || person.kitState === "active";
    const finalRank = safe && rank < requested ? ++rank : null;
    return {
      preflight_id: preflight!.id,
      waitlist_entry_id: BASE + person.n,
      contact_id: BASE + person.n,
      contact_name: `Person ${person.n}`,
      email: `p${person.n}@preflight.test`,
      joined_at: `${person.day}T09:00:00.000Z`,
      db_eligible: true,
      db_exclusion_reason: null,
      kit_subscriber_id: person.kitState == null ? null : `sub-${person.n}`,
      kit_state: person.kitState,
      kit_checked_at: new Date().toISOString(),
      final_eligible: safe && finalRank != null,
      exclusion_reason: safe
        ? finalRank == null
          ? "beyond-the-number-asked-for"
          : null
        : `kit-${person.kitState}`,
      final_rank: finalRank,
    };
  });
  ok(
    "its candidates",
    await client.from("waitlist_invitation_preflight_candidates").insert(rows),
  );
  await client
    .from("waitlist_invitation_preflights")
    .update({ resolved: rank })
    .eq("id", preflight!.id);
  return preflight!.id as number;
};

const outbox = async () => {
  const { data } = await db()
    .from("kit_sync_operations")
    .select("id, contact_id, status, kit_tag_name")
    .eq("origin", "waitlist_invitation")
    .order("id");
  return data ?? [];
};

const cleanup = async () => {
  const client = db();
  await client.from("kit_sync_operations").delete().gte("contact_id", BASE);
  await client.from("waitlist_invitations").delete().gte("contact_id", BASE);
  await client
    .from("waitlist_invitation_preflight_candidates")
    .delete()
    .gte("contact_id", BASE);
  await client
    .from("waitlist_invitation_preflights")
    .delete()
    .gte("id", 1)
    .in("offer_id", [LE, GYU]);
  await client
    .from("waitlist_invitation_batches")
    .delete()
    .like("label", "%probe%");
  await client.from("waitlist_entries").delete().gte("id", BASE);
  await client.from("contacts").delete().gte("id", BASE);
  await client
    .from("kit_tag_mappings")
    .delete()
    .in("kit_tag_id", [LE_TAG, GYU_TAG]);
};

test.describe("a preflight is a snapshot, not an invitation", () => {
  test.afterEach(cleanup);

  test("writing one tags nobody and moves nobody", async () => {
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await seed([
      { n: 1, name: "First Waiting", day: "2026-01-01" },
      { n: 2, name: "Second Waiting", day: "2026-01-02" },
    ]);

    await writeSnapshot(LE, 2, [
      { n: 1, kitState: "active", day: "2026-01-01" },
      { n: 2, kitState: "active", day: "2026-01-02" },
    ]);

    expect(await outbox()).toHaveLength(0);
    const { data: entries } = await db()
      .from("waitlist_entries")
      .select("status")
      .gte("id", BASE);
    expect(entries!.every((row) => row.status === "waiting")).toBe(true);
  });

  test("somebody Kit will not deliver to does not use up a place", async () => {
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await seed([
      { n: 1, name: "Cancelled Person", day: "2026-01-01" },
      { n: 2, name: "Bounced Person", day: "2026-01-02" },
      { n: 3, name: "Active One", day: "2026-01-03" },
      { n: 4, name: "Active Two", day: "2026-01-04" },
    ]);

    // Two asked for. The two oldest are unreachable in Kit, so the two
    // after them are the batch — and the first two are recorded with the
    // exact Kit state that excluded them.
    const preflightId = await writeSnapshot(LE, 2, [
      { n: 1, kitState: "cancelled", day: "2026-01-01" },
      { n: 2, kitState: "bounced", day: "2026-01-02" },
      { n: 3, kitState: "active", day: "2026-01-03" },
      { n: 4, kitState: "active", day: "2026-01-04" },
    ]);

    const { data: rows } = await db()
      .from("waitlist_invitation_preflight_candidates")
      .select(
        "contact_id, final_eligible, final_rank, kit_state, exclusion_reason",
      )
      .eq("preflight_id", preflightId)
      .order("joined_at");
    expect(rows!.map((row) => row.final_rank)).toEqual([null, null, 1, 2]);
    expect(rows![0]!.exclusion_reason).toBe("kit-cancelled");
    expect(rows![1]!.exclusion_reason).toBe("kit-bounced");

    const { data: result } = await db().rpc("invite_from_preflight", {
      p_preflight_id: preflightId,
      p_label: "probe preflight",
    });
    expect(result.queued).toBe(2);
    expect(
      (result.invited as { contact_id: number }[]).map((p) => p.contact_id),
    ).toEqual([BASE + 3, BASE + 4]);
    // And the unreachable two were never queued.
    expect((await outbox()).map((row) => row.contact_id)).toEqual([
      BASE + 3,
      BASE + 4,
    ]);
  });

  test("somebody who changed since is reported, never replaced", async () => {
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await seed([
      { n: 1, name: "Will Apply", day: "2026-01-01" },
      { n: 2, name: "Stays Fine", day: "2026-01-02" },
      { n: 3, name: "Never Shown", day: "2026-01-03" },
    ]);
    const preflightId = await writeSnapshot(LE, 2, [
      { n: 1, kitState: "active", day: "2026-01-01" },
      { n: 2, kitState: "active", day: "2026-01-02" },
      { n: 3, kitState: "active", day: "2026-01-03" },
    ]);

    // Between the preview and the click, the first person applies.
    ok(
      "an application arrives",
      await db()
        .from("applications")
        .insert({
          id: BASE + 1,
          contact_id: BASE + 1,
          offer_id: LE,
          status: "pending",
          source: "public_form",
          submitted_at: new Date().toISOString(),
          raw_answers: {},
        }),
    );

    const { data: result } = await db().rpc("invite_from_preflight", {
      p_preflight_id: preflightId,
      p_label: "probe changed",
    });

    expect(result.queued).toBe(1);
    expect((result.skipped as { reason: string }[])[0]?.reason).toBe(
      "changed-since-preflight",
    );
    // THE THIRD PERSON IS NOT SUBSTITUTED IN. Leif confirmed two named
    // people; she did not agree to whoever was next.
    const invited = (result.invited as { contact_id: number }[]).map(
      (p) => p.contact_id,
    );
    expect(invited).toEqual([BASE + 2]);
    expect(invited).not.toContain(BASE + 3);

    await db()
      .from("applications")
      .delete()
      .eq("id", BASE + 1);
  });

  test("a snapshot is spent once", async () => {
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await seed([{ n: 1, name: "Only Person", day: "2026-01-01" }]);
    const preflightId = await writeSnapshot(LE, 1, [
      { n: 1, kitState: "active", day: "2026-01-01" },
    ]);

    const { data: first } = await db().rpc("invite_from_preflight", {
      p_preflight_id: preflightId,
      p_label: "probe once",
    });
    expect(first.queued).toBe(1);

    const { data: again } = await db().rpc("invite_from_preflight", {
      p_preflight_id: preflightId,
      p_label: "probe twice",
    });
    expect(again.status).toBe("preflight-already-used");
    expect(await outbox()).toHaveLength(1);
  });

  test("the browser cannot create a batch that skipped Kit", async () => {
    // invite_oldest_waiting answers the database half and knows nothing
    // about consent, so the browser may no longer call it at all. The only
    // route from the CRM goes through a snapshot the preflight wrote.
    const asOwner = createClient(
      SUPABASE_URL,
      process.env.VITE_SB_PUBLISHABLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error } = await asOwner.rpc("invite_oldest_waiting", {
      p_offer_id: LE,
      p_cohort_id: null,
      p_limit: 1,
      p_entry_ids: null,
      p_label: "probe direct",
    });
    expect(error).not.toBeNull();
  });

  test("the same person in both final sets is surfaced", async () => {
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await mapTag(GYU, GYU_TAG, "GYU_Waitlist_Invited");
    await seed([
      { n: 1, name: "Both Lists", day: "2026-01-01", offer: LE },
      { n: 2, name: "Only Gyu", day: "2026-01-02", offer: GYU },
    ]);
    ok(
      "a place on the other list",
      await db()
        .from("waitlist_entries")
        .insert({
          id: BASE + 90,
          contact_id: BASE + 1,
          offer_id: GYU,
          cohort_id: null,
          status: "waiting",
          source: "manual",
          joined_at: "2026-01-05T09:00:00.000Z",
        }),
    );

    const leId = await writeSnapshot(LE, 5, [
      { n: 1, kitState: "active", day: "2026-01-01" },
    ]);
    const gyuId = await writeSnapshot(GYU, 5, [
      { n: 1, kitState: "active", day: "2026-01-05" },
      { n: 2, kitState: "active", day: "2026-01-02" },
    ]);

    const { data: overlap } = await db().rpc("waitlist_preflight_overlap", {
      p_preflight_a: leId,
      p_preflight_b: gyuId,
    });
    expect(overlap).toHaveLength(1);
    expect(overlap![0]!.contact_id_a).toBe(BASE + 1);
  });
});
