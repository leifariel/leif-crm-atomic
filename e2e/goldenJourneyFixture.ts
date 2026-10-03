import { createClient } from "@supabase/supabase-js";

import { expect } from "./fixtures";

// The synthetic Living Example used by the start-week Golden Journey.
//
// Everything here is made up, with ids far out of production's range, and
// it is torn down after each test. Production Todd is never read or
// written; this reproduces his SHAPE — Won, enrolled, no start week, no
// source, nothing inferred — which is the part that broke the CRM.
//
// Seeded through the real write paths: a Won deal creates its Enrollment
// via the live trigger, exactly as a real sale does. Nothing hand-builds
// an enrollments row.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";

export const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export const OFFER_ID = 1; // The Living Example, max_active_clients 12
export const CALENDAR = "golden-journey-cal";
const FIRST_ID = 980001;

// Every date is derived from the most recent Monday, so the fixture has a
// fixed SHAPE on any day it runs. A real browser against a real database
// cannot have its clock frozen without lying to the auth client, so the
// scenario moves with the calendar and the arithmetic stays identical.
export const mondayAnchor = (): string => {
  const today = new Date();
  const utc = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
  );
  // getUTCDay: 0 = Sunday. Monday of the current week, Sunday counting
  // back to the Monday before it rather than forward into a week that has
  // not started.
  const day = utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() - (day === 0 ? 6 : day - 1));
  return utc.toISOString().slice(0, 10);
};

export const week = (offset: number, from = mondayAnchor()): string => {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset * 7);
  return date.toISOString().slice(0, 10);
};

// `end` is EXCLUSIVE (sessionWeeks.ts), so a week runs Monday to Saturday.
const weekEnd = (offset: number) => {
  const date = new Date(`${week(offset)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 5);
  return date.toISOString().slice(0, 10);
};

// Eleven people who started last week, plus one who started nine weeks ago
// and is therefore the next to finish. Twelve occupied slots against a
// ceiling of twelve.
const STARTED_RECENTLY = 11;
const EARLY_FINISHER_START = -9;
const RECENT_START = -1;

// The early finisher's twelfth eligible week is week +2, so their slot
// frees at the end of it and a genuine opening exists from week +3. That
// opening is what the unscheduled client used to erase.
export const EXPECTED_FIRST_OPEN_WEEK = () => week(3);

export const PEOPLE = [
  ...Array.from({ length: STARTED_RECENTLY }, (_, i) => ({
    first: "Jur",
    last: `Recent${i + 1}`,
    start: RECENT_START as number | null,
  })),
  { first: "Early", last: "Finisher", start: EARLY_FINISHER_START },
];

// The Todd-shaped one. Won, enrolled, and nobody has said when they begin.
export const UNSCHEDULED = { first: "Unscheduled", last: "Commitment" };

export type Seeded = {
  salesId: number | string;
  enrollmentIdByName: Record<string, number>;
  unscheduledEnrollmentId: number;
};

// A second individual programme with a DIFFERENT ceiling, used to prove
// that visiting one programme page cannot leave its Offer behind for the
// next one. Three, not twelve, so a leak is unmistakable.
export const OTHER_OFFER_ID = 989001;
export const OTHER_OFFER_NAME = "The Decoy Programme";
export const OTHER_OFFER_MAX = 3;

const seedOtherOffer = async () => {
  const { error } = await db().from("offers").insert({
    id: OTHER_OFFER_ID,
    name: OTHER_OFFER_NAME,
    type: "individual",
    duration: "4 months",
    current_price: 4000,
    max_active_clients: OTHER_OFFER_MAX,
    is_active: true,
  });
  expect(error).toBeNull();
};

// The address this run signed in with, so cleanup can take its user away
// again rather than leaving one behind per test.
let seededEmail: string | null = null;

export const cleanup = async () => {
  const client = db();
  const ids = Array.from({ length: PEOPLE.length + 1 }, (_, i) => FIRST_ID + i);
  await client.from("deals").delete().in("id", ids);
  await client.from("contacts").delete().in("id", ids);
  await client
    .from("expected_session_windows")
    .delete()
    .eq("external_calendar_id", CALENDAR);
  await client.from("offers").delete().eq("id", OTHER_OFFER_ID);

  // Take the user with it. resetDb paginates now, but a spec that adds a
  // user per test and leaves it is how the pool grew past one page in the
  // first place — and that surfaced as failures in four other spec files.
  // Cleaning up after yourself is the cheaper half of that lesson.
  if (seededEmail) {
    const { data } = await client.auth.admin.listUsers({
      page: 1,
      perPage: 50,
    });
    const mine = data?.users?.find((user) => user.email === seededEmail);
    if (mine) await client.auth.admin.deleteUser(mine.id);
    seededEmail = null;
  }
};

// A long weekly `1:1s` calendar: 30 weeks behind and 70 ahead, so no
// container's end is ever "incomplete" for want of calendar and the
// openings answer is never "can't calculate" for the wrong reason.
const seedCalendar = async () => {
  const client = db();
  const rows = [];
  for (let i = -30; i <= 70; i++) {
    rows.push({
      offer_id: OFFER_ID,
      external_calendar_id: CALENDAR,
      external_event_id: `gj-w${i}`,
      raw_title: "1:1s",
      window_start: week(i),
      window_end: weekEnd(i),
    });
  }
  const { error } = await client.from("expected_session_windows").insert(rows);
  expect(error).toBeNull();
};

export const seedGoldenJourney = async (
  createSales: (args: {
    first_name: string;
    last_name: string;
    email: string;
    password: string;
  }) => Promise<{ id: number | string }>,
  credentials: { email: string; password: string },
): Promise<Seeded> => {
  await cleanup();
  seededEmail = credentials.email;
  await seedCalendar();
  await seedOtherOffer();

  const client = db();
  const sales = await createSales({
    first_name: "Golden",
    last_name: "Journey",
    ...credentials,
  });
  const salesId = sales.id;

  const everyone = [...PEOPLE, { ...UNSCHEDULED, start: null }];
  const enrollmentIdByName: Record<string, number> = {};

  for (const [index, person] of everyone.entries()) {
    const id = FIRST_ID + index;
    const contact = await client.from("contacts").insert({
      id,
      first_name: person.first,
      last_name: person.last,
      sales_id: salesId,
    });
    expect(contact.error).toBeNull();

    // Won through the real path: the live trigger makes the Enrollment.
    const deal = await client.from("deals").insert({
      id,
      name: `${person.first} ${person.last}`,
      contact_id: id,
      offer_id: OFFER_ID,
      stage: "won",
      amount: 4000,
      sales_id: salesId,
      index: 0,
    });
    expect(deal.error).toBeNull();

    const { data: enrollment, error } = await client
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", id)
      .single();
    expect(error).toBeNull();
    const enrollmentId = enrollment!.id as number;
    enrollmentIdByName[`${person.first} ${person.last}`] = enrollmentId;

    if (person.start == null) {
      // Deliberately left exactly as the trigger made it: no start week,
      // no source, and nothing inferred from the Won date.
      const stated = await client
        .from("enrollments")
        .update({ status: "onboarding" })
        .eq("id", enrollmentId);
      expect(stated.error).toBeNull();
      continue;
    }

    // The database refuses to activate an Enrollment whose required
    // onboarding items are not done ("Cannot activate enrollment N: 4 of 4
    // required onboarding items are not done"). That invariant is real and
    // the fixture respects it rather than working around it, so these
    // twelve are active the way a real client becomes active.
    const finished = await client
      .from("enrollment_onboarding_items")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("enrollment_id", enrollmentId);
    expect(finished.error).toBeNull();

    const stated = await client
      .from("enrollments")
      .update({
        status: "active",
        start_date: week(person.start),
        start_date_source: "owner",
      })
      .eq("id", enrollmentId);
    expect(stated.error).toBeNull();
  }

  return {
    salesId,
    enrollmentIdByName,
    unscheduledEnrollmentId:
      enrollmentIdByName[`${UNSCHEDULED.first} ${UNSCHEDULED.last}`]!,
  };
};

// What the database itself says about one Enrollment, read independently of
// anything the browser has in memory.
export const readEnrollment = async (id: number) => {
  const { data, error } = await db()
    .from("enrollments")
    .select("id, status, start_date, start_date_source, end_date")
    .eq("id", id)
    .single();
  expect(error).toBeNull();
  return data!;
};

// Every Enrollment in the programme, as the database holds it. Used to
// prove that a save changed exactly the one row it was supposed to.
export const snapshotEnrollments = async () => {
  const { data, error } = await db()
    .from("enrollments")
    .select(
      "id, status, start_date, start_date_source, end_date, deals!inner(offer_id)",
    )
    .eq("deals.offer_id", OFFER_ID)
    .order("id");
  expect(error).toBeNull();
  return (data ?? []).map((row) => ({
    id: row.id as number,
    status: row.status as string,
    start_date: row.start_date as string | null,
    start_date_source: row.start_date_source as string | null,
    end_date: row.end_date as string | null,
  }));
};

// Which rows differ between two snapshots, by id.
export const changedBetween = (
  before: Awaited<ReturnType<typeof snapshotEnrollments>>,
  after: Awaited<ReturnType<typeof snapshotEnrollments>>,
): number[] => {
  const key = (row: (typeof before)[number]) =>
    `${row.status}|${row.start_date}|${row.start_date_source}|${row.end_date}`;
  const beforeByKey = new Map(before.map((row) => [row.id, key(row)]));
  return after
    .filter((row) => beforeByKey.get(row.id) !== key(row))
    .map((row) => row.id);
};

// Every dated, non-terminal Enrollment in the programme, counted in SQL
// rather than taken from the page.
export const countActiveDated = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db()
    .from("enrollments")
    .select("id, status, start_date, end_date, deals!inner(offer_id)")
    .eq("deals.offer_id", OFFER_ID);
  expect(error).toBeNull();
  return (data ?? []).filter(
    (row) =>
      !["completed", "withdrawn", "ended"].includes(row.status as string) &&
      row.start_date != null &&
      (row.start_date as string) <= today &&
      (row.end_date == null || (row.end_date as string) >= today),
  ).length;
};
