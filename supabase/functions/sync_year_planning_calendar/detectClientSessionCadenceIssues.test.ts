// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Same tiny in-memory fake as acuityClientSessionHandlers.test.ts's own.
type Row = Record<string, unknown>;

function createFakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([name, rows]) => [
      name,
      rows.map((r) => ({ ...r })),
    ]),
  );
  let nextId = 1000;

  // A column the row never set and a column explicitly null are the same
  // absence, which is what `.is(col, null)` asks about.
  const matches = (row: Row, eqFilters: [string, unknown][]) =>
    eqFilters.every(([field, value]) => (row[field] ?? null) === value);

  const from = (table: string) => {
    tables[table] ??= [];
    const eqFilters: [string, unknown][] = [];

    const builder = {
      eq(field: string, value: unknown) {
        eqFilters.push([field, value]);
        return builder;
      },
      // `.is(col, null)` is how a retired slot is skipped — the detection
      // pass must not re-raise a week that left the canonical schedule.
      // A fake that cannot express it would let that regression back in.
      is(field: string, value: unknown) {
        eqFilters.push([field, value]);
        return builder;
      },
      maybeSingle() {
        const found = tables[table].find((r) => matches(r, eqFilters));
        return Promise.resolve({ data: found ?? null, error: null });
      },
      limit(n: number) {
        return Promise.resolve({
          data: tables[table].filter((r) => matches(r, eqFilters)).slice(0, n),
          error: null,
        });
      },
      select(_cols?: string) {
        return builder;
      },
      insert(row: Row) {
        const created = { id: nextId++, ...row };
        tables[table].push(created);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: created, error: null }),
          }),
        };
      },
      update(patch: Row) {
        return {
          eq(field: string, value: unknown) {
            tables[table] = tables[table].map((r) =>
              r[field] === value ? { ...r, ...patch } : r,
            );
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
      then(resolve: (v: unknown) => void) {
        resolve({
          data: tables[table].filter((r) => matches(r, eqFilters)),
          error: null,
        });
      },
    };
    return builder;
  };

  return { from, tables };
}

const fakeDb = vi.hoisted(() => ({
  current: null as ReturnType<typeof createFakeDb> | null,
}));

vi.mock("../_shared/supabaseAdmin.ts", () => ({
  supabaseAdmin: {
    from: (table: string) => fakeDb.current!.from(table),
  },
}));

import { detectClientSessionCadenceIssues } from "./detectClientSessionCadenceIssues";

const NOW = new Date("2026-09-25T00:00:00.000Z");

const seedWith = (overrides: Partial<Record<string, Row[]>> = {}) =>
  createFakeDb({
    offers: [{ id: 1, client_session_acuity_appointment_type_id: "90522599" }],
    enrollments: [
      {
        id: 100,
        opportunity_id: 10,
        start_date: "2026-08-01",
        status: "active",
      },
    ],
    deals: [{ id: 10, offer_id: 1, contact_id: 1 }],
    contacts: [{ id: 1, first_name: "Ada", last_name: "Lovelace" }],
    sales: [{ id: 1, administrator: true }],
    enrollment_expected_sessions: [],
    client_sessions: [],
    client_session_cadence_issues: [],
    tasks: [],
    ...overrides,
  });

describe("detectClientSessionCadenceIssues", () => {
  beforeEach(() => {
    fakeDb.current = seedWith();
  });
  afterAll(() => {
    vi.resetAllMocks();
  });

  it("creates an issue and a resolve_client_session_cadence Task for a closed slot with no fulfilling session", async () => {
    fakeDb.current = seedWith({
      enrollment_expected_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          ordinal: 1,
          window_start: "2026-09-13",
          window_end: "2026-09-17",
        },
      ],
    });

    const result = await detectClientSessionCadenceIssues(NOW);
    expect(result.issuesCreated).toBe(1);
    expect(result.tasksCreated).toBe(1);

    const issue = fakeDb.current!.tables.client_session_cadence_issues[0];
    expect(issue.enrollment_id).toBe(100);
    expect(issue.enrollment_expected_session_id).toBe(1);
    expect(issue.classification).toBeUndefined();

    const task = fakeDb.current!.tables.tasks[0];
    expect(task.type).toBe("resolve_client_session_cadence");
    // The Dashboard's Needs Attention bucket filters by sales_id — a
    // Task created with none would never appear there.
    expect(task.sales_id).toBe(1);
    expect(task.cadence_issue_id).toBe(issue.id);
    expect(task.text).toContain("Ada Lovelace");
  });

  it("a session inside the assigned slot fulfills it — no issue created", async () => {
    fakeDb.current = seedWith({
      enrollment_expected_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          ordinal: 1,
          window_start: "2026-09-13",
          window_end: "2026-09-17",
        },
      ],
      client_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          status: "booked",
          scheduled_at: "2026-09-15T18:00:00.000Z",
          no_show_at: null,
        },
      ],
    });

    const result = await detectClientSessionCadenceIssues(NOW);
    expect(result.issuesCreated).toBe(0);
    expect(fakeDb.current!.tables.client_session_cadence_issues).toHaveLength(
      0,
    );
  });

  it("a slot that has not closed yet is never flagged", async () => {
    fakeDb.current = seedWith({
      enrollment_expected_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          ordinal: 1,
          window_start: "2026-09-27",
          window_end: "2026-10-01",
        },
      ],
    });

    const result = await detectClientSessionCadenceIssues(NOW);
    expect(result.issuesCreated).toBe(0);
  });

  it("re-running never creates a second issue or a second pending Task for the same slot", async () => {
    fakeDb.current = seedWith({
      enrollment_expected_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          ordinal: 1,
          window_start: "2026-09-13",
          window_end: "2026-09-17",
        },
      ],
    });

    await detectClientSessionCadenceIssues(NOW);
    const second = await detectClientSessionCadenceIssues(NOW);
    expect(second.issuesCreated).toBe(0);
    expect(second.tasksCreated).toBe(0);
    expect(fakeDb.current!.tables.client_session_cadence_issues).toHaveLength(
      1,
    );
    expect(fakeDb.current!.tables.tasks).toHaveLength(1);
  });

  it("never creates an issue for an Offer with no client-session tracking configured", async () => {
    fakeDb.current = seedWith({
      offers: [{ id: 1, client_session_acuity_appointment_type_id: null }],
      enrollment_expected_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          ordinal: 1,
          window_start: "2026-09-13",
          window_end: "2026-09-17",
        },
      ],
    });

    const result = await detectClientSessionCadenceIssues(NOW);
    expect(result.issuesCreated).toBe(0);
  });

  it("reopens an issue that was auto-resolved (classification null) but has lost fulfillment again, never creating a duplicate", async () => {
    fakeDb.current = seedWith({
      enrollment_expected_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          ordinal: 1,
          window_start: "2026-09-13",
          window_end: "2026-09-17",
        },
      ],
      client_session_cadence_issues: [
        {
          id: 1,
          enrollment_id: 100,
          enrollment_expected_session_id: 1,
          classification: null,
          resolved_at: "2026-09-18T00:00:00.000Z",
        },
      ],
      tasks: [
        {
          id: 1,
          contact_id: 1,
          type: "resolve_client_session_cadence",
          cadence_issue_id: 1,
          done_date: "2026-09-18T00:00:00.000Z",
          status: "completed",
        },
      ],
    });

    const result = await detectClientSessionCadenceIssues(NOW);
    expect(result.issuesCreated).toBe(0);
    expect(fakeDb.current!.tables.client_session_cadence_issues).toHaveLength(
      1,
    );
    const issue = fakeDb.current!.tables.client_session_cadence_issues[0];
    expect(issue.resolved_at).toBeNull();

    const task = fakeDb.current!.tables.tasks[0];
    expect(task.done_date).toBeNull();
    expect(task.status).toBe("pending");
  });

  it("never touches an issue already resolved with a real human classification", async () => {
    fakeDb.current = seedWith({
      enrollment_expected_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          ordinal: 1,
          window_start: "2026-09-13",
          window_end: "2026-09-17",
        },
      ],
      client_session_cadence_issues: [
        {
          id: 1,
          enrollment_id: 100,
          enrollment_expected_session_id: 1,
          classification: "known_skip",
          resolved_at: "2026-09-18T00:00:00.000Z",
        },
      ],
    });

    const result = await detectClientSessionCadenceIssues(NOW);
    expect(result.issuesCreated).toBe(0);
    const issue = fakeDb.current!.tables.client_session_cadence_issues[0];
    expect(issue.classification).toBe("known_skip");
    expect(issue.resolved_at).toBe("2026-09-18T00:00:00.000Z");
  });
});

describe("a week that left the canonical schedule", () => {
  it("is never raised again, however long it stays in the record", async () => {
    // Leif removed the mistakenly-added 30 Aug – 2 Sep week from Year
    // Tracking; the rebuild retired the derived slot but kept it, because
    // a cadence issue points at it. This pass used to scan retired slots
    // too, so the week Leif had just deleted came straight back as a
    // Needs Attention item he could not answer.
    fakeDb.current = seedWith({
      enrollment_expected_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          ordinal: 1,
          window_start: "2026-08-30",
          window_end: "2026-09-03",
          retired_at: "2026-09-22T00:00:00.000Z",
        },
      ],
    });

    const result = await detectClientSessionCadenceIssues(NOW);
    expect(result.issuesCreated).toBe(0);
    expect(result.tasksCreated).toBe(0);
    expect(fakeDb.current!.tables.client_session_cadence_issues).toHaveLength(
      0,
    );
  });
});

// THE PRODUCTION FAILURE, reproduced.
//
// Leif's Dashboard told her four real clients had skipped the week of
// Oct 4–7. All four had sat with her that week. The weeks come from a
// Google Calendar all-day event — Oct 4 through Oct 7, stored as
// window_start 2026-10-04 and window_end 2026-10-08 (exclusive) — and
// the fulfilment check built UTC midnights out of those Denver dates:
//
//   scheduled_at >= "2026-10-04T00:00:00.000Z"
//   scheduled_at <  "2026-10-08T00:00:00.000Z"
//
// which is Denver Oct 3 18:00 → Oct 7 18:00. Every session booked on the
// last afternoon or evening of a week fell outside the window the CRM was
// testing, and the CRM concluded nobody had booked.
//
// A week is a set of calendar days. These are the days.
describe("the week of Oct 4–7, in the CRM's own timezone", () => {
  const OCT_WEEK = {
    id: 1,
    enrollment_id: 100,
    ordinal: 1,
    window_start: "2026-10-04",
    window_end: "2026-10-08",
  };
  const AFTER_THE_WEEK = new Date("2026-10-10T12:00:00.000Z");

  const withSessionAt = (scheduledAt: string) =>
    seedWith({
      enrollment_expected_sessions: [OCT_WEEK],
      client_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          status: "booked",
          scheduled_at: scheduledAt,
          no_show_at: null,
        },
      ],
    });

  it("counts a session on the last evening of the week — the exact production failure", async () => {
    // Wednesday 7 October, 6pm in Denver. In UTC that is already the 8th,
    // and the old comparison lost it.
    fakeDb.current = withSessionAt("2026-10-08T00:00:00.000Z");

    const result = await detectClientSessionCadenceIssues(AFTER_THE_WEEK);

    expect(result.issuesCreated).toBe(0);
    expect(result.tasksCreated).toBe(0);
    expect(fakeDb.current!.tables.tasks).toHaveLength(0);
  });

  it("counts a session late on the last night of the week", async () => {
    // 7 October, 11pm Denver — 8 October 05:00 UTC.
    fakeDb.current = withSessionAt("2026-10-08T05:00:00.000Z");

    const result = await detectClientSessionCadenceIssues(AFTER_THE_WEEK);

    expect(result.issuesCreated).toBe(0);
  });

  it("counts a session first thing on the first day of the week", async () => {
    // 4 October, 00:30 Denver — 06:30 UTC the same day.
    fakeDb.current = withSessionAt("2026-10-04T06:30:00.000Z");

    const result = await detectClientSessionCadenceIssues(AFTER_THE_WEEK);

    expect(result.issuesCreated).toBe(0);
  });

  it("does NOT count the evening before the week started", async () => {
    // 3 October, 8pm Denver — 4 October 02:00 UTC. The old comparison
    // counted this as inside the week, which is the same bug pointing the
    // other way: a session in a week Leif had not opened yet silently
    // answered for one she had.
    fakeDb.current = withSessionAt("2026-10-04T02:00:00.000Z");

    const result = await detectClientSessionCadenceIssues(AFTER_THE_WEEK);

    expect(result.issuesCreated).toBe(1);
    expect(fakeDb.current!.tables.tasks[0]!.text).toContain("Oct 4–7");
  });

  it("still raises the week when nobody booked anything", async () => {
    fakeDb.current = seedWith({
      enrollment_expected_sessions: [OCT_WEEK],
    });

    const result = await detectClientSessionCadenceIssues(AFTER_THE_WEEK);

    expect(result.issuesCreated).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(fakeDb.current!.tables.tasks[0]!.text).toContain(
      "No session booked for week of Oct 4–7",
    );
  });
});

// AND IT CONVERGES.
//
// Creating the right task once is not enough. A booking that arrives after
// the task did — a late Acuity sync, a session booked after the week
// closed — must close the question, and so must a task that was wrong to
// begin with. Leif must never be left tidying up a state the system can
// prove is stale.
describe("a question that answers itself", () => {
  const WEEK = {
    id: 1,
    enrollment_id: 100,
    ordinal: 1,
    window_start: "2026-09-13",
    window_end: "2026-09-17",
  };

  it("closes the open task when the booking turns up later", async () => {
    fakeDb.current = seedWith({ enrollment_expected_sessions: [WEEK] });

    const first = await detectClientSessionCadenceIssues(NOW);
    expect(first.tasksCreated).toBe(1);
    const taskId = fakeDb.current!.tables.tasks[0]!.id;

    // The sync catches up and the session appears.
    fakeDb.current!.tables.client_sessions.push({
      id: 1,
      enrollment_id: 100,
      status: "booked",
      scheduled_at: "2026-09-15T18:00:00.000Z",
      no_show_at: null,
    });

    const second = await detectClientSessionCadenceIssues(NOW);

    expect(second.issuesResolved).toBe(1);
    expect(second.issuesCreated).toBe(0);
    expect(second.tasksCreated).toBe(0);
    // The issue is resolved, and the Task is DONE rather than deleted —
    // having been asked is part of the history.
    const issue = fakeDb.current!.tables.client_session_cadence_issues[0]!;
    expect(issue.resolved_at).not.toBeNull();
    expect(issue.classification ?? null).toBeNull();
    const task = fakeDb.current!.tables.tasks.find((t) => t.id === taskId)!;
    expect(task.done_date).not.toBeNull();
    // The pair tasks_completion_agreement_check enforces, and the only
    // completed status tasks_status_check allows. Asserted literally
    // because a plausible-looking "done" is rejected by Postgres and the
    // Task would silently stay open on the Dashboard.
    expect(task.status).toBe("completed");
    // One task, start to finish. Never a second.
    expect(fakeDb.current!.tables.tasks).toHaveLength(1);
    // And the history SAYS so, in the vocabulary the kind check allows:
    // created, then resolved. Asserted because an invented kind is
    // rejected by Postgres and the trail would silently be lost.
    expect(
      fakeDb.current!.tables.client_session_cadence_issue_events.map(
        (event) => event.kind,
      ),
    ).toEqual(["created", "resolved"]);
  });

  it("never overwrites an answer Leif already gave", async () => {
    // She classified the week herself — a known skip, say. A session
    // appearing later does not get to overrule that.
    fakeDb.current = seedWith({
      enrollment_expected_sessions: [WEEK],
      client_session_cadence_issues: [
        {
          id: 7,
          enrollment_id: 100,
          enrollment_expected_session_id: 1,
          resolved_at: "2026-09-18T00:00:00.000Z",
          classification: "known_skip",
        },
      ],
      client_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          status: "booked",
          scheduled_at: "2026-09-15T18:00:00.000Z",
          no_show_at: null,
        },
      ],
    });

    const result = await detectClientSessionCadenceIssues(NOW);

    expect(result.issuesResolved).toBe(0);
    const issue = fakeDb.current!.tables.client_session_cadence_issues[0]!;
    expect(issue.classification).toBe("known_skip");
    expect(issue.resolved_at).toBe("2026-09-18T00:00:00.000Z");
  });

  it("is convergent when run twice over", async () => {
    fakeDb.current = seedWith({
      enrollment_expected_sessions: [WEEK],
      client_sessions: [
        {
          id: 1,
          enrollment_id: 100,
          status: "booked",
          scheduled_at: "2026-09-15T18:00:00.000Z",
          no_show_at: null,
        },
      ],
    });

    await detectClientSessionCadenceIssues(NOW);
    const again = await detectClientSessionCadenceIssues(NOW);

    expect(again.issuesCreated).toBe(0);
    expect(again.issuesResolved).toBe(0);
    expect(fakeDb.current!.tables.tasks).toHaveLength(0);
  });
});
