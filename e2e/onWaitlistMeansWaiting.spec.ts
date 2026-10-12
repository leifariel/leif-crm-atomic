import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// "ON WAITLIST" MEANS STILL WAITING TO BE INVITED.
//
// THE BUG THIS EXISTS FOR. `contacts_summary.is_on_waitlist` read
// {waiting, invited} — the place-held set that mirrors the partial unique
// index, which answers "may this person be given another place?" rather than
// "is this person still waiting?". After the first real invitation batches on
// 2026-10-11 the Contacts "Waitlist" filter returned 115 people in production
// where 61 were genuinely waiting: the 54 just invited were still being
// offered as people awaiting an invitation.
//
// The programme-page half is repaired in the read model (useWaitlistEntries +
// isStillWaiting). This is the DATABASE half, against the real view, because
// a derived column is only true if Postgres says so.
// Migration: 20261011200000_on_waitlist_means_still_waiting.sql.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 974000;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ok = (step: string, { error }: { error: { message?: string } | null }) =>
  expect(error?.message ?? null, step).toBeNull();

/**
 * One Contact, and the waitlist episodes they hold, oldest first.
 *
 * WHAT THE DATABASE TAUGHT US WRITING THIS. The first version gave case 5 an
 * invited AND a waiting entry for the SAME offer, and Postgres refused it:
 * `waitlist_entries_active_unique_idx` is the partial unique index over
 * status IN ('waiting','invited'), so one person cannot hold two live places
 * for one programme. That is the place-held rule working — an invited person
 * still occupies their place — and it means "invited before, waiting now" is
 * reachable only ACROSS programmes, or once the old episode has converted or
 * been removed. Case 5 is therefore a real cross-offer person: invited to The
 * Living Example, waiting for Growing Yourself Up, which HANDOFF §4b calls two
 * separate journeys.
 */
const CASES: Array<{
  n: number;
  label: string;
  episodes: Array<{ status: string; offer?: number }>;
  onWaitlist: boolean;
}> = [
  {
    n: 1,
    label: "only waiting",
    episodes: [{ status: "waiting" }],
    onWaitlist: true,
  },
  {
    n: 2,
    label: "only invited",
    episodes: [{ status: "invited" }],
    onWaitlist: false,
  },
  {
    n: 3,
    label: "only converted",
    episodes: [{ status: "converted" }],
    onWaitlist: false,
  },
  {
    n: 4,
    label: "only removed",
    episodes: [{ status: "removed" }],
    onWaitlist: false,
  },
  {
    n: 5,
    label: "invited to one programme, waiting for another",
    episodes: [{ status: "invited" }, { status: "waiting", offer: GYU }],
    onWaitlist: true,
  },
  {
    n: 6,
    label: "converted and removed, nothing live",
    episodes: [{ status: "converted" }, { status: "removed" }],
    onWaitlist: false,
  },
];

/**
 * Seeded inside each test, never in beforeAll: the `resetDb` fixture is auto
 * and wipes the database before every test, so anything seeded once would be
 * gone by the time the first assertion ran.
 */
const seed = async () => {
  const client = db();
  let entryId = BASE;
  for (const scenario of CASES) {
    const contactId = BASE + scenario.n;
    ok(
      `contact ${scenario.n}`,
      await client.from("contacts").insert({
        id: contactId,
        first_name: "Case",
        last_name: String(scenario.n),
        email_jsonb: [
          { email: `case${scenario.n}@waitlist.test`, type: "Work" },
        ],
      }),
    );
    for (const [index, episode] of scenario.episodes.entries()) {
      entryId += 1;
      ok(
        `entry ${entryId}`,
        await client.from("waitlist_entries").insert({
          id: entryId,
          contact_id: contactId,
          offer_id: episode.offer ?? LE,
          cohort_id: null,
          status: episode.status,
          joined_at: `2026-0${index + 1}-01T09:00:00.000Z`,
          invited_at:
            episode.status === "invited" ? "2026-03-01T09:00:00.000Z" : null,
        }),
      );
    }
  }
};

test.describe("contacts_summary.is_on_waitlist means currently waiting", () => {
  for (const scenario of CASES) {
    test(`a Contact with ${scenario.label} reads ${scenario.onWaitlist}`, async () => {
      await seed();

      const { data, error } = await db()
        .from("contacts_summary")
        .select("id, is_on_waitlist")
        .eq("id", BASE + scenario.n)
        .single();
      ok("reading the view", { error });

      expect(data!.is_on_waitlist).toBe(scenario.onWaitlist);
    });
  }

  test("every historical episode is still on record", async () => {
    await seed();

    // The filter changed; the history did not. This is what the Contact's own
    // waitlist section reads, and it must still see all of it.
    const { data, error } = await db()
      .from("waitlist_entries")
      .select("contact_id, status, invited_at")
      .gte("contact_id", BASE)
      .lt("contact_id", BASE + 1000)
      .order("id", { ascending: true });
    ok("reading the entries", { error });

    expect(data!.map((row) => row.status)).toEqual(
      CASES.flatMap((c) => c.episodes.map((e) => e.status)),
    );
    // Including the fact that somebody was once invited.
    expect(data!.filter((row) => row.invited_at != null)).toHaveLength(2);
  });

  test("the filter itself returns only the people currently waiting", async () => {
    await seed();

    // Exactly what the Contacts list does with the "Waitlist" chip.
    const { data, error } = await db()
      .from("contacts_summary")
      .select("id")
      .eq("is_on_waitlist", true)
      .gte("id", BASE)
      .lt("id", BASE + 1000)
      .order("id", { ascending: true });
    ok("filtering", { error });

    expect(data!.map((row) => row.id)).toEqual([BASE + 1, BASE + 5]);
  });
});
