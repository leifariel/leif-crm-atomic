// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Same tiny in-memory fake as acuitySalesCallHandlers.test.ts's own
// (duplicated per this directory's documented convention — a small
// adapter test, not a shared abstraction), extended with `.in()` since
// findActiveEnrollmentForClientSession uses it.
type Row = Record<string, unknown>;

function createFakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([name, rows]) => [
      name,
      rows.map((r) => ({ ...r })),
    ]),
  );
  let nextId = 1000;

  const matches = (
    row: Row,
    eqFilters: [string, unknown][],
    inFilters: [string, unknown[]][],
  ) =>
    eqFilters.every(([field, value]) => row[field] === value) &&
    inFilters.every(([field, values]) => values.includes(row[field]));

  const from = (table: string) => {
    tables[table] ??= [];
    const eqFilters: [string, unknown][] = [];
    const inFilters: [string, unknown[]][] = [];

    const builder = {
      eq(field: string, value: unknown) {
        eqFilters.push([field, value]);
        return builder;
      },
      in(field: string, values: unknown[]) {
        inFilters.push([field, values]);
        return builder;
      },
      limit(_n: number) {
        return Promise.resolve({
          data: tables[table].filter((r) => matches(r, eqFilters, inFilters)),
          error: null,
        });
      },
      maybeSingle() {
        const found = tables[table].find((r) =>
          matches(r, eqFilters, inFilters),
        );
        return Promise.resolve({ data: found ?? null, error: null });
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
      // Chainable, because a write may carry more than one filter: the
      // link reconciler guards its update with .is("enrollment_id", null)
      // so it can only ever fill a blank, and a fake that ignored the
      // second filter would let that guard rot.
      update(patch: Row) {
        const writeFilters: [string, unknown][] = [];
        const apply = () => {
          tables[table] = tables[table].map((r) =>
            writeFilters.every(([f, v]) => (r[f] ?? null) === v)
              ? { ...r, ...patch }
              : r,
          );
          return { data: null, error: null };
        };
        const chain = {
          eq(field: string, value: unknown) {
            writeFilters.push([field, value]);
            return chain;
          },
          is(field: string, value: unknown) {
            writeFilters.push([field, value]);
            return chain;
          },
          then(resolve: (v: unknown) => void) {
            resolve(apply());
          },
        };
        return chain;
      },
      then(resolve: (v: unknown) => void) {
        resolve({
          data: tables[table].filter((r) => matches(r, eqFilters, inFilters)),
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

import {
  handleClientSessionRescheduled,
  handleClientSessionScheduled,
  tryHandleClientSessionCanceled,
} from "./acuityClientSessionHandlers";
import type { AcuityAppointmentDetails } from "./acuityApi";
import { reconcileClientSessionEnrollments } from "../_shared/reconcileClientSessionEnrollments.ts";

const CLIENT_SESSION_TYPE_ID = "90522599";
const buildAppointment = (
  overrides: Partial<AcuityAppointmentDetails> = {},
): AcuityAppointmentDetails => ({
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  datetime: "2026-09-10T18:00:00.000Z",
  appointmentTypeID: Number(CLIENT_SESSION_TYPE_ID),
  ...overrides,
});

const seedWith = (overrides: Partial<Record<string, Row[]>> = {}) =>
  createFakeDb({
    offers: [
      {
        id: 1,
        name: "The Living Example",
        client_session_acuity_appointment_type_id: CLIENT_SESSION_TYPE_ID,
      },
    ],
    contacts: [],
    deals: [],
    enrollments: [],
    client_sessions: [],
    client_session_events: [],
    ...overrides,
  });

async function json(response: Response) {
  return response.json();
}

describe("acuityClientSessionHandlers", () => {
  beforeEach(() => {
    fakeDb.current = seedWith();
  });
  afterAll(() => {
    vi.resetAllMocks();
  });

  describe("handleClientSessionScheduled", () => {
    // The fake assigns 1000 to the first row it inserts, which is the
    // session itself — so the link authority's answer can be seeded for it.
    const NEW_SESSION_ID = 1000;

    it("writes the session, then takes the link authority's answer", async () => {
      // Provenance is no longer decided here. The handler inserts the row
      // and asks the one authority, so ingestion and the historical
      // backfill cannot disagree. What the authority DECIDES is proved
      // against real Postgres; what this proves is the wiring.
      fakeDb.current = seedWith({
        contacts: [
          {
            id: 1,
            first_name: "Ada",
            last_name: "Lovelace",
            email_jsonb: [{ email: "ada@example.com", type: "Other" }],
          },
        ],
        deals: [{ id: 10, contact_id: 1, offer_id: 1 }],
        enrollments: [{ id: 100, opportunity_id: 10, status: "active" }],
        client_session_enrollment_candidates: [
          {
            session_id: NEW_SESSION_ID,
            classification: "deterministic",
            proposed_enrollment_id: 100,
          },
        ],
      });
      const response = await handleClientSessionScheduled(
        buildAppointment(),
        "acuity-1",
      );
      const body = await json(response);
      expect(body).toEqual({ status: "booked", matchReason: "matched" });

      const created = fakeDb.current!.tables.client_sessions[0];
      expect(created.enrollment_id).toBe(100);
      expect(created.offer_id).toBe(1);
      expect(fakeDb.current!.tables.client_session_events).toHaveLength(1);
    });

    it("never rewrites provenance that already exists", async () => {
      // The reconciler guards its write with .is("enrollment_id", null), so
      // it can only ever FILL a blank. Even if the authority proposed a
      // different Enrollment for a session that already names one, the row
      // does not move.
      fakeDb.current = seedWith({
        contacts: [
          {
            id: 1,
            first_name: "Ada",
            last_name: "Lovelace",
            email_jsonb: [{ email: "ada@example.com", type: "Other" }],
          },
        ],
        deals: [{ id: 10, contact_id: 1, offer_id: 1 }],
        enrollments: [{ id: 100, opportunity_id: 10, status: "active" }],
        client_sessions: [
          {
            id: 900,
            contact_id: 1,
            offer_id: 1,
            enrollment_id: 100,
            status: "booked",
            scheduled_at: "2026-10-06T18:00:00.000Z",
          },
        ],
        client_session_enrollment_candidates: [
          {
            session_id: 900,
            classification: "deterministic",
            proposed_enrollment_id: 101,
          },
        ],
      });

      await reconcileClientSessionEnrollments(900);

      const row = fakeDb.current!.tables.client_sessions.find(
        (r) => r.id === 900,
      )!;
      expect(row.enrollment_id).toBe(100);
    });

    it("leaves the link blank rather than guessing when the authority is unsure", async () => {
      fakeDb.current = seedWith({
        contacts: [
          {
            id: 1,
            first_name: "Ada",
            last_name: "Lovelace",
            email_jsonb: [{ email: "ada@example.com", type: "Other" }],
          },
        ],
        deals: [{ id: 10, contact_id: 1, offer_id: 1 }],
        enrollments: [
          { id: 100, opportunity_id: 10, status: "active" },
          { id: 101, opportunity_id: 10, status: "active" },
        ],
        client_session_enrollment_candidates: [
          {
            session_id: NEW_SESSION_ID,
            classification: "ambiguous",
            proposed_enrollment_id: null,
          },
        ],
      });
      const response = await handleClientSessionScheduled(
        buildAppointment(),
        "acuity-1",
      );
      expect(await json(response)).toEqual({
        status: "booked",
        matchReason: "ambiguous",
      });
      // The session is kept, unlinked. Nothing is invented and nothing is
      // thrown away — the nightly sweep will revisit it.
      expect(
        fakeDb.current!.tables.client_sessions[0].enrollment_id,
      ).toBeNull();
    });

    it("preserves an unresolved session (enrollment_id null) when zero legitimate Enrollments exist", async () => {
      const response = await handleClientSessionScheduled(
        buildAppointment(),
        "acuity-2",
      );
      const body = await json(response);
      expect(body).toEqual({ status: "booked", matchReason: "none" });
      expect(fakeDb.current!.tables.client_sessions[0].enrollment_id).toBe(
        null,
      );
    });

    it("a duplicate webhook delivery for the same Acuity appointment id is a safe no-op", async () => {
      await handleClientSessionScheduled(buildAppointment(), "acuity-3");
      const response = await handleClientSessionScheduled(
        buildAppointment(),
        "acuity-3",
      );
      const body = await json(response);
      expect(body).toEqual({ status: "already-booked" });
      expect(fakeDb.current!.tables.client_sessions).toHaveLength(1);
    });

    it("returns unknown-appointment-type for an appointment type with no client-session mapping", async () => {
      fakeDb.current = seedWith({ offers: [] });
      const response = await handleClientSessionScheduled(
        buildAppointment(),
        "acuity-4",
      );
      const body = await json(response);
      expect(body).toEqual({ status: "unknown-appointment-type" });
    });
  });

  describe("handleClientSessionRescheduled", () => {
    it("updates the same durable session row", async () => {
      await handleClientSessionScheduled(buildAppointment(), "acuity-5");
      const response = await handleClientSessionRescheduled(
        buildAppointment({ datetime: "2026-09-17T18:00:00.000Z" }),
        "acuity-5",
      );
      const body = await json(response);
      expect(body).toEqual({ status: "rescheduled" });
      expect(fakeDb.current!.tables.client_sessions).toHaveLength(1);
      expect(fakeDb.current!.tables.client_sessions[0].scheduled_at).toBe(
        "2026-09-17T18:00:00.000Z",
      );
    });
  });

  describe("tryHandleClientSessionCanceled", () => {
    it("cancels the matching session and returns a Response", async () => {
      await handleClientSessionScheduled(buildAppointment(), "acuity-6");
      const response = await tryHandleClientSessionCanceled("acuity-6");
      expect(response).not.toBeNull();
      const body = await json(response!);
      expect(body).toEqual({ status: "cancelled" });
      expect(fakeDb.current!.tables.client_sessions[0].status).toBe(
        "cancelled",
      );
    });

    it("returns null (never a Response) for an appointment id no client_sessions row matches — lets index.ts fall through to sales-call handling", async () => {
      const response = await tryHandleClientSessionCanceled("unknown-id");
      expect(response).toBeNull();
    });
  });
});
