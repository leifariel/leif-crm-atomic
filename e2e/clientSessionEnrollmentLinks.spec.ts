import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// WHICH ENROLLMENT OWNS THIS SESSION?
//
// `client_sessions.enrollment_id` is nullable provenance, and it was decided
// once — when the Acuity appointment arrived — from "this contact has exactly
// one ACTIVE Enrollment for this offer". 62 of 255 production sessions ended
// up null, 26 of them created before their Enrollment existed, so that lookup
// could not possibly have succeeded. Three real clients were then told they
// had skipped a week they had attended.
//
// The view client_session_enrollment_candidates is the one answer. It runs
// against real Postgres as real SQL, so it is proved here rather than against
// a stand-in: a view's tiering, its DATE comparisons in the CRM's own
// timezone, and its refusal to guess are all properties of the database.
//
// The rule, and what each case below pins:
//   deterministic  — exactly one Enrollment can truthfully own it
//   no-candidate   — none can; the column stays null, with a reason
//   ambiguous      — several could; the column stays null, for Leif

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 991000;

const admin = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

type Candidate = {
  session_id: number;
  classification: string;
  proposed_enrollment_id: number | null;
  candidate_count: number;
  tier: string;
  reason: string;
};

const candidateFor = async (sessionId: number) => {
  const { data } = await admin()
    .from("client_session_enrollment_candidates")
    .select(
      "session_id, classification, proposed_enrollment_id, candidate_count, tier, reason",
    )
    .eq("session_id", sessionId)
    .maybeSingle();
  return data as Candidate | null;
};

const cleanup = async () => {
  const client = admin();
  await client.from("client_sessions").delete().gte("id", BASE);
  await client.from("enrollment_expected_sessions").delete().gte("id", BASE);
  await client.from("expected_session_windows").delete().gte("id", BASE);
  await client.from("enrollments").delete().gte("id", BASE);
  await client.from("deals").delete().gte("id", BASE);
  await client.from("contacts").delete().gte("id", BASE);
};

/** A client of a programme, with an Enrollment that ran over a known span. */
const seedClient = async (
  n: number,
  {
    offerId = LE,
    startDate = "2026-08-01",
    endDate = null as string | null,
    status = "active",
    contactId = BASE + n,
  } = {},
) => {
  const client = admin();
  await client
    .from("contacts")
    .insert({ id: BASE + n, first_name: `Link${n}`, last_name: "Probe" })
    .select()
    // The contact may be shared between two Enrollments in the ambiguity
    // case, so a duplicate insert is expected and ignored there.
    .then(() => undefined);
  await client.from("deals").insert({
    id: BASE + n,
    name: `Link${n} Probe`,
    contact_id: contactId,
    offer_id: offerId,
    stage: "call_booked",
    index: 0,
    entry_path: "other",
    description: "",
  });
  await client.from("enrollments").insert({
    id: BASE + n,
    opportunity_id: BASE + n,
    status,
    start_date: startDate,
    end_date: endDate,
    start_date_source: "owner",
  });
  return { contactId, enrollmentId: BASE + n };
};

/** One expected week for that Enrollment, as Google Calendar states it. */
const seedWeek = async (
  n: number,
  enrollmentId: number,
  offerId: number,
  windowStart: string,
  windowEnd: string,
) => {
  const client = admin();
  await client.from("expected_session_windows").insert({
    id: BASE + n,
    offer_id: offerId,
    external_calendar_id: "year-tracking",
    external_event_id: `link-probe-${n}`,
    raw_title: "1:1s",
    window_start: windowStart,
    window_end: windowEnd,
    synced_at: new Date().toISOString(),
  });
  // The schedule is derived on activation, so whatever was assigned is
  // replaced with the week this test means to pin.
  await client
    .from("enrollment_expected_sessions")
    .delete()
    .eq("enrollment_id", enrollmentId);
  await client.from("enrollment_expected_sessions").insert({
    id: BASE + n,
    enrollment_id: enrollmentId,
    ordinal: 1,
    source_window_id: BASE + n,
    raw_title: "1:1s",
    window_start: windowStart,
    window_end: windowEnd,
  });
};

/** An Acuity booking that never got its enrollment link. */
const seedUnlinkedSession = async (
  n: number,
  contactId: number,
  offerId: number,
  scheduledAt: string,
) => {
  await admin()
    .from("client_sessions")
    .insert({
      id: BASE + n,
      contact_id: contactId,
      offer_id: offerId,
      enrollment_id: null,
      status: "booked",
      scheduled_at: scheduledAt,
      source: "acuity",
      acuity_appointment_id: `link-probe-${n}`,
      acuity_appointment_type_id: "90522599",
    });
  return BASE + n;
};

test.describe("the one authority on which Enrollment owns a session", () => {
  test.afterEach(cleanup);

  test("an unlinked session inside exactly one expected week is deterministic", async () => {
    const { contactId, enrollmentId } = await seedClient(1);
    await seedWeek(1, enrollmentId, LE, "2026-10-04", "2026-10-08");
    // Denver Wed 7 Oct 14:00 — the final day, which is already the 8th in
    // UTC. A DATE compared as a UTC instant loses exactly this session.
    const sessionId = await seedUnlinkedSession(
      1,
      contactId,
      LE,
      "2026-10-07T20:00:00.000Z",
    );

    const candidate = await candidateFor(sessionId);
    expect(candidate).not.toBeNull();
    expect(candidate!.classification).toBe("deterministic");
    expect(candidate!.proposed_enrollment_id).toBe(enrollmentId);
    expect(candidate!.candidate_count).toBe(1);
    // The strongest tier: its day is one of that Enrollment's expected days.
    expect(candidate!.tier).toBe("expected-week");
  });

  test("a session for the other programme is never a candidate", async () => {
    const { contactId, enrollmentId } = await seedClient(2);
    await seedWeek(2, enrollmentId, LE, "2026-10-04", "2026-10-08");
    // Right person, right week, wrong programme.
    const sessionId = await seedUnlinkedSession(
      2,
      contactId,
      GYU,
      "2026-10-06T18:00:00.000Z",
    );

    const candidate = await candidateFor(sessionId);
    // Either no row at all, or one that refuses to propose anything.
    expect(candidate?.classification ?? "no-candidate").not.toBe(
      "deterministic",
    );
    expect(candidate?.proposed_enrollment_id ?? null).toBeNull();
  });

  test("with no Enrollment of that programme it stays null, and says why", async () => {
    const client = admin();
    await client
      .from("contacts")
      .insert({ id: BASE + 3, first_name: "Link3", last_name: "Probe" });
    const sessionId = await seedUnlinkedSession(
      3,
      BASE + 3,
      LE,
      "2026-10-06T18:00:00.000Z",
    );

    const candidate = await candidateFor(sessionId);
    expect(candidate!.classification).toBe("no-candidate");
    expect(candidate!.candidate_count).toBe(0);
    expect(candidate!.proposed_enrollment_id).toBeNull();
    expect(candidate!.reason).toContain("no Enrollment");
  });

  test("an Enrollment that has since ended can still own its own session", async () => {
    // Deliberately NOT status=active. A session that happened while an
    // Enrollment was running belongs to it even after it finished, which is
    // exactly what the matcher keyed on "one ACTIVE enrollment" got wrong.
    const { contactId, enrollmentId } = await seedClient(4, {
      status: "completed",
      startDate: "2026-01-01",
      endDate: "2026-06-30",
    });
    // No expected week covers it, so tier 2 has to answer.
    const sessionId = await seedUnlinkedSession(
      4,
      contactId,
      LE,
      "2026-03-04T19:00:00.000Z",
    );

    const candidate = await candidateFor(sessionId);
    expect(candidate!.classification).toBe("deterministic");
    expect(candidate!.proposed_enrollment_id).toBe(enrollmentId);
    expect(candidate!.tier).toBe("enrollment-span");
  });

  test("a day outside every Enrollment's span stays null", async () => {
    const { contactId } = await seedClient(5, {
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      status: "completed",
    });
    // Long after that Enrollment ended, and inside no expected week.
    const sessionId = await seedUnlinkedSession(
      5,
      contactId,
      LE,
      "2026-12-02T19:00:00.000Z",
    );

    const candidate = await candidateFor(sessionId);
    expect(candidate!.classification).toBe("no-candidate");
    expect(candidate!.proposed_enrollment_id).toBeNull();
  });

  test("two Enrollments could own it, so the authority refuses to choose", async () => {
    // A returning client: one person, one programme, two Enrollments whose
    // expected weeks overlap. Nothing can say which week the hour belongs
    // to, so it must be spent on neither.
    const first = await seedClient(6);
    await seedWeek(6, first.enrollmentId, LE, "2026-10-04", "2026-10-08");
    const second = await seedClient(7, { contactId: first.contactId });
    await seedWeek(7, second.enrollmentId, LE, "2026-10-05", "2026-10-12");

    const sessionId = await seedUnlinkedSession(
      8,
      first.contactId,
      LE,
      "2026-10-06T18:00:00.000Z",
    );

    const candidate = await candidateFor(sessionId);
    expect(candidate!.classification).toBe("ambiguous");
    expect(candidate!.candidate_count).toBe(2);
    expect(candidate!.proposed_enrollment_id).toBeNull();
    expect(candidate!.reason).toContain("Leif decides");
  });

  test("a session that already names its Enrollment is not listed at all", async () => {
    const { contactId, enrollmentId } = await seedClient(9);
    await seedWeek(9, enrollmentId, LE, "2026-10-04", "2026-10-08");
    await admin()
      .from("client_sessions")
      .insert({
        id: BASE + 9,
        contact_id: contactId,
        offer_id: LE,
        enrollment_id: enrollmentId,
        status: "booked",
        scheduled_at: "2026-10-06T18:00:00.000Z",
        source: "acuity",
        acuity_appointment_id: "link-probe-9",
      });

    // The view exists to fill blanks. Provenance that is already recorded is
    // never offered up for reinterpretation.
    expect(await candidateFor(BASE + 9)).toBeNull();
  });

  test("the browser cannot read this view at all", async () => {
    const asOwner = createClient(
      SUPABASE_URL,
      process.env.VITE_SB_PUBLISHABLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    // Deciding provenance is the CRM's own server-side work, and a new view
    // holds no privileges until one is granted. anon and authenticated were
    // never given any.
    const { error } = await asOwner
      .from("client_session_enrollment_candidates")
      .select("session_id")
      .limit(1);
    expect(error).not.toBeNull();
  });
});
