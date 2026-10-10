import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// Inviting the oldest people waiting.
//
// Leif invites twenty-five or thirty people off a waitlist at once. The
// questions that decide whether that is safe are all database questions —
// who is eligible, who was passed over and why, what happens when Kit says
// no, what happens when the same batch is run twice — so they are asked
// here, of real Postgres, through the same functions the UI calls.
//
// The one rule everything else serves: a person stops being Waiting when
// KIT has confirmed their tag, and at no other moment.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 970000;
const LE_TAG = 880001;
const GYU_TAG = 880002;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

type Person = {
  n: number;
  name: string;
  day: string;
  offer?: number;
  /** Something that should keep them out of a batch. */
  blocked?: "dne" | "no-email" | "applied" | "client";
};

const seedPeople = async (people: Person[]) => {
  const client = db();
  for (const person of people) {
    const id = BASE + person.n;
    ok(
      `contact ${person.name}`,
      await client.from("contacts").insert({
        id,
        first_name: person.name.split(" ")[0],
        last_name: person.name.split(" ").slice(1).join(" ") || "Waiting",
        email_jsonb:
          person.blocked === "no-email"
            ? []
            : [{ email: `w${person.n}@invite.test`, type: "Work" }],
        sales_eligibility:
          person.blocked === "dne" ? "do_not_engage" : "normal",
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
    if (person.blocked === "applied") {
      ok(
        `application ${person.name}`,
        await client.from("applications").insert({
          id,
          contact_id: id,
          offer_id: person.offer ?? LE,
          status: "pending",
          source: "public_form",
          submitted_at: "2026-05-01T09:00:00.000Z",
          raw_answers: {},
        }),
      );
    }
  }
};

/** A Won client for the same programme, through the canonical path. */
const makeClient = async (n: number, salesId: number | string) => {
  const client = db();
  const id = BASE + n;
  ok(
    "client deal",
    await client.from("deals").insert({
      id,
      name: `Client ${n}`,
      contact_id: id,
      offer_id: LE,
      stage: "call_booked",
      sales_id: salesId,
      index: 0,
      entry_path: "other",
      description: "",
    }),
  );
  await client.rpc("record_prospect_accepted", { p_opportunity_id: id });
};

const mapTag = async (offerId: number, tagId: number, name: string) => {
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
};

const invite = async (args: Record<string, unknown>) => {
  const { data, error } = await db().rpc("invite_oldest_waiting", args);
  expect(error).toBeNull();
  return data as Record<string, unknown>;
};

const candidates = async (offerId: number) => {
  const { data } = await db().rpc("waitlist_invitation_candidates", {
    p_offer_id: offerId,
    p_cohort_id: null,
  });
  return (data ?? []) as Record<string, unknown>[];
};

const outbox = async () => {
  const { data } = await db()
    .from("kit_sync_operations")
    .select(
      "id, contact_id, waitlist_invitation_id, kind, origin, email, kit_tag_id, kit_tag_name, status",
    )
    .eq("origin", "waitlist_invitation")
    .order("id");
  return data ?? [];
};

const entryStatus = async (n: number) => {
  const { data } = await db()
    .from("waitlist_entries")
    .select("status, invited_at")
    .eq("id", BASE + n)
    .single();
  return data!;
};

/** What the Kit worker does when Kit answers — the only way a tag lands. */
const kitSays = async (
  operationId: number,
  answer: "yes" | "no",
  subscriberId = "sub-probe",
) => {
  const client = db();
  if (answer === "yes") {
    ok(
      "kit success",
      await client
        .from("kit_sync_operations")
        .update({
          status: "succeeded",
          succeeded_at: new Date().toISOString(),
          kit_subscriber_id: subscriberId,
        })
        .eq("id", operationId),
    );
  } else {
    ok(
      "kit failure",
      await client
        .from("kit_sync_operations")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          failure_class: "rejected",
          failure_reason: "Kit refused this address",
        })
        .eq("id", operationId),
    );
  }
};

const cleanup = async () => {
  const client = db();
  await client.from("kit_sync_operations").delete().gte("contact_id", BASE);
  await client.from("waitlist_invitations").delete().gte("contact_id", BASE);
  await client
    .from("waitlist_invitation_batches")
    .delete()
    .gte("id", 1)
    .like("label", "%probe%");
  await client.from("waitlist_entries").delete().gte("id", BASE);
  await client.from("enrollments").delete().gte("opportunity_id", BASE);
  await client.from("deals").delete().gte("id", BASE);
  await client.from("applications").delete().gte("id", BASE);
  await client.from("contacts").delete().gte("id", BASE);
  await client
    .from("kit_tag_mappings")
    .delete()
    .in("kit_tag_id", [LE_TAG, GYU_TAG]);
};

test.describe("inviting the oldest people waiting", () => {
  test.afterEach(cleanup);

  test("takes the oldest ELIGIBLE, and nobody ineligible uses up a place", async ({
    createSales,
  }) => {
    const sale = await createSales({
      first_name: "Invite",
      last_name: "Owner",
      email: `invite-oldest-${Date.now()}@example.com`,
      password: "password",
    });
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await seedPeople([
      { n: 1, name: "First Waiting", day: "2026-01-01" },
      { n: 2, name: "Dne Person", day: "2026-01-02", blocked: "dne" },
      { n: 3, name: "Nomail Person", day: "2026-01-03", blocked: "no-email" },
      { n: 4, name: "Applied Person", day: "2026-01-04", blocked: "applied" },
      { n: 5, name: "Client Person", day: "2026-01-05", blocked: "client" },
      { n: 6, name: "Second Waiting", day: "2026-01-06" },
      { n: 7, name: "Third Waiting", day: "2026-01-07" },
    ]);
    await makeClient(5, sale.id);

    const result = await invite({
      p_offer_id: LE,
      p_cohort_id: null,
      p_limit: 2,
      p_entry_ids: null,
      p_label: "probe oldest",
    });

    expect(result.status).toBe("queued");
    expect(result.queued).toBe(2);
    // THE TWO OLDEST ELIGIBLE — the four ineligible people between them did
    // not consume a place.
    const invited = (result.invited as { name: string }[]).map((p) => p.name);
    expect(invited).toEqual(["First Waiting", "Second Waiting"]);

    // And every exclusion is named rather than silently dropped.
    const skipped = Object.fromEntries(
      (result.skipped as { name: string; reason: string }[]).map((p) => [
        p.name,
        p.reason,
      ]),
    );
    expect(skipped["Dne Person"]).toBe("do-not-engage");
    expect(skipped["Nomail Person"]).toBe("no-email");
    expect(skipped["Applied Person"]).toBe("already-applied");
    // A person who became a client is not in the list at ALL: winning the
    // sale converted their waitlist place (handle_deal_waitlist_sync), so
    // they stopped being somebody who is waiting. The 'already-a-client'
    // rule in the candidate function is the belt to that braces — it
    // catches a historical row whose place was never converted.
    expect(skipped["Client Person"]).toBeUndefined();
    expect(invited).not.toContain("Client Person");

    // Queued, with the programme's own tag — never a tag string from code.
    const rows = await outbox();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kit_tag_id === LE_TAG)).toBe(true);
    expect(rows.every((row) => row.kind === "waitlist_invited")).toBe(true);
    expect(rows.every((row) => row.status === "pending")).toBe(true);

    // AND NOBODY HAS STOPPED WAITING. Kit has not been asked yet.
    expect((await entryStatus(1)).status).toBe("waiting");
    expect((await entryStatus(6)).status).toBe("waiting");
  });

  test("a programme with no tag for an invitation cannot send one", async () => {
    await seedPeople([{ n: 1, name: "Unmapped Waiting", day: "2026-01-01" }]);

    const result = await invite({
      p_offer_id: LE,
      p_cohort_id: null,
      p_limit: 1,
      p_entry_ids: null,
      p_label: "probe unmapped",
    });

    expect(result.status).toBe("not-configured");
    expect(await outbox()).toHaveLength(0);
    expect((await entryStatus(1)).status).toBe("waiting");
  });

  test("waiting ends when Kit confirms, and not when it refuses", async () => {
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await seedPeople([
      { n: 1, name: "Kit Accepts", day: "2026-01-01" },
      { n: 2, name: "Kit Refuses", day: "2026-01-02" },
    ]);
    await invite({
      p_offer_id: LE,
      p_cohort_id: null,
      p_limit: 2,
      p_entry_ids: null,
      p_label: "probe delivery",
    });

    const rows = await outbox();
    const accepted = rows.find((row) => row.contact_id === BASE + 1)!;
    const refused = rows.find((row) => row.contact_id === BASE + 2)!;

    await kitSays(accepted.id as number, "yes", "sub-accepted");
    await kitSays(refused.id as number, "no");

    // Confirmed: invited, with the moment it happened.
    const first = await entryStatus(1);
    expect(first.status).toBe("invited");
    expect(first.invited_at).not.toBeNull();
    // Refused: STILL WAITING. Nobody loses their place because Kit said no.
    expect((await entryStatus(2)).status).toBe("waiting");

    const { data: invitations } = await db()
      .from("waitlist_invitations")
      .select("contact_id, status, delivery_method, failure_reason")
      .gte("contact_id", BASE)
      .order("contact_id");
    expect(invitations![0]).toMatchObject({
      status: "sent",
      delivery_method: "kit_tag",
    });
    expect(invitations![1]!.status).toBe("failed");
    expect(invitations![1]!.failure_reason).toContain("refused");
  });

  test("running the same batch twice invites nobody twice", async () => {
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await seedPeople([
      { n: 1, name: "Only Person", day: "2026-01-01" },
      { n: 2, name: "Next Person", day: "2026-01-02" },
    ]);

    const first = await invite({
      p_offer_id: LE,
      p_cohort_id: null,
      p_limit: 1,
      p_entry_ids: null,
      p_label: "probe once",
    });
    expect(first.queued).toBe(1);

    // Still in flight — Kit has not answered. Asking again must not queue
    // the same person a second time.
    const again = await invite({
      p_offer_id: LE,
      p_cohort_id: null,
      p_limit: 1,
      p_entry_ids: null,
      p_label: "probe twice",
    });
    const inFlight = (again.skipped as { name: string; reason: string }[]).find(
      (p) => p.name === "Only Person",
    );
    expect(inFlight?.reason).toBe("invitation-in-flight");
    // It moved on to the next person rather than stopping.
    expect((again.invited as { name: string }[])[0]?.name).toBe("Next Person");

    const rows = await outbox();
    expect(rows.filter((row) => row.contact_id === BASE + 1)).toHaveLength(1);
  });

  test("a hand-picked selection is re-checked by the server", async () => {
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await seedPeople([
      { n: 1, name: "Fine Person", day: "2026-01-01" },
      { n: 2, name: "Dne Person", day: "2026-01-02", blocked: "dne" },
    ]);

    // The browser asks for both. The server invites one and says why not
    // the other — a selection is an instruction about WHO, never a
    // permission to skip the rules.
    const result = await invite({
      p_offer_id: LE,
      p_cohort_id: null,
      p_limit: null,
      p_entry_ids: [BASE + 1, BASE + 2],
      p_label: "probe selected",
    });
    expect(result.queued).toBe(1);
    expect((result.invited as { name: string }[])[0]?.name).toBe("Fine Person");
    expect((result.skipped as { reason: string }[])[0]?.reason).toBe(
      "do-not-engage",
    );
  });

  test("each programme uses its own tag, and never the other's", async () => {
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await mapTag(GYU, GYU_TAG, "GYU_Waitlist_Invited");
    await seedPeople([
      { n: 1, name: "Le Waiting", day: "2026-01-01", offer: LE },
      { n: 2, name: "Gyu Waiting", day: "2026-01-02", offer: GYU },
    ]);

    await invite({
      p_offer_id: LE,
      p_cohort_id: null,
      p_limit: 10,
      p_entry_ids: null,
      p_label: "probe le",
    });
    await invite({
      p_offer_id: GYU,
      p_cohort_id: null,
      p_limit: 10,
      p_entry_ids: null,
      p_label: "probe gyu",
    });

    const rows = await outbox();
    const byContact = Object.fromEntries(
      rows.map((row) => [row.contact_id, row.kit_tag_name]),
    );
    expect(byContact[BASE + 1]).toBe("LE_Waitlist_Invited");
    expect(byContact[BASE + 2]).toBe("GYU_Waitlist_Invited");
    // And neither of them got an Applicant tag: that one means an
    // application was actually submitted.
    expect(
      rows.some((row) => String(row.kit_tag_name).includes("Applicant")),
    ).toBe(false);
  });

  test("a refused address is not asked again, and the history is kept", async () => {
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await seedPeople([{ n: 1, name: "Refused Person", day: "2026-01-01" }]);

    await invite({
      p_offer_id: LE,
      p_cohort_id: null,
      p_limit: 1,
      p_entry_ids: null,
      p_label: "probe refused",
    });
    const [row] = await outbox();
    await kitSays(row!.id as number, "no");

    // Kit said no in a way it will repeat. The next batch passes them over
    // and says so, rather than making the same call again.
    const judged = await candidates(LE);
    const person = judged.find((c) => c.contact_id === BASE + 1)!;
    expect(person.eligible).toBe(false);
    expect(person.exclusion_reason).toBe("kit-refused-this-address-before");

    // The place itself is untouched — no history is deleted by a failure.
    expect((await entryStatus(1)).status).toBe("waiting");
    const { count } = await db()
      .from("waitlist_invitations")
      .select("id", { count: "exact", head: true })
      .gte("contact_id", BASE);
    expect(count).toBe(1);
  });

  test("the same person on both waitlists is surfaced, never quietly sent both", async () => {
    // Leif invites off both waitlists in one sitting. Somebody waiting for
    // both programmes would get two invitations to apply to two different
    // things on the same morning, and that is her decision rather than a
    // batch's.
    await mapTag(LE, LE_TAG, "LE_Waitlist_Invited");
    await mapTag(GYU, GYU_TAG, "GYU_Waitlist_Invited");
    await seedPeople([
      { n: 1, name: "Both Lists", day: "2026-01-01", offer: LE },
      { n: 2, name: "Only Le", day: "2026-01-02", offer: LE },
      { n: 3, name: "Only Gyu", day: "2026-01-03", offer: GYU },
    ]);
    // The same person, waiting for the other programme too.
    ok(
      "a place on the other waitlist",
      await db()
        .from("waitlist_entries")
        .insert({
          id: BASE + 98,
          contact_id: BASE + 1,
          offer_id: GYU,
          cohort_id: null,
          status: "waiting",
          source: "manual",
          joined_at: "2026-01-04T09:00:00.000Z",
        }),
    );

    const { data: overlap } = await db().rpc("waitlist_invitation_overlap", {
      p_offer_a: LE,
      p_limit_a: 25,
      p_offer_b: GYU,
      p_limit_b: 30,
    });
    const found = (overlap ?? []).filter(
      (row: { contact_id_a: number }) => row.contact_id_a >= BASE,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("Both Lists");
    // The ones on one list only are not flagged.
    expect(found.some((row: { name: string }) => row.name === "Only Le")).toBe(
      false,
    );
  });

  test("one person waiting twice for the same programme is invited once", async () => {
    // The real shape: a general place for the programme AND a place for one
    // of its rounds. The database allows exactly that — its uniqueness is
    // per (person, programme, round) — so one person can legitimately be
    // two rows, and tagging them twice would be the CRM's mistake.
    await mapTag(GYU, GYU_TAG, "GYU_Waitlist_Invited");
    const { data: round } = await db()
      .from("cohorts")
      .select("id")
      .eq("offer_id", GYU)
      .limit(1)
      .single();
    expect(round, "the clean room has a round to wait for").not.toBeNull();

    await seedPeople([
      { n: 1, name: "Twice Waiting", day: "2026-01-01", offer: GYU },
    ]);
    ok(
      "a place for one of its rounds",
      await db()
        .from("waitlist_entries")
        .insert({
          id: BASE + 99,
          contact_id: BASE + 1,
          offer_id: GYU,
          cohort_id: round!.id,
          status: "waiting",
          source: "manual",
          joined_at: "2026-02-01T09:00:00.000Z",
        }),
    );

    const result = await invite({
      p_offer_id: GYU,
      p_cohort_id: null,
      p_limit: 10,
      p_entry_ids: null,
      p_label: "probe duplicate",
    });

    expect(result.queued).toBe(1);
    expect(await outbox()).toHaveLength(1);
    // The OLDEST of their two places is the one that carries it.
    expect(
      (result.invited as { waitlist_entry_id: number }[])[0]?.waitlist_entry_id,
    ).toBe(BASE + 1);
  });
});
