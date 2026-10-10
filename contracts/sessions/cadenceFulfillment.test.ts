import { describe, expect, it } from "vitest";

import * as app from "@/components/atomic-crm/sessions/cadenceFulfillment";
import * as edge from "../../supabase/functions/_shared/cadenceFulfillment";

// "WAS THIS EXPECTED WEEK FULFILLED?" — ONE ANSWER, TWO COPIES.
//
// The rule is asked in the browser and in the calendar sync, and Edge
// Functions cannot import from src/, so it exists twice. The vectors live
// HERE, once, and run through BOTH copies: a vector that disagrees between
// them fails, and so does one either copy gets wrong.
//
// THE PRODUCTION SHAPE these exist for. Three real clients — Ava Frotton,
// Denise Cormier, Gina McNamara — each had a qualifying Acuity session
// inside the week of 4–7 October with `client_sessions.enrollment_id` null,
// and were told they had skipped it. A fourth, Jess Beauchamp, genuinely had
// no session that week. Both answers have to come out of the same rule, or
// the repair is just a way of suppressing every missed-session question.

const LE = 1;
const GYU = 2;
const CLIENT = 100;
const ENROLLMENT = 500;
const OTHER_ENROLLMENT = 501;

const WEEK = {
  id: 7,
  enrollment_id: ENROLLMENT,
  window_start: "2026-10-04",
  window_end: "2026-10-08",
};
const OWNER = { enrollment_id: ENROLLMENT, contact_id: CLIENT, offer_id: LE };

/** A qualifying hour, mid-week, unless a vector says otherwise. */
const session = (over: Partial<app.FulfillingSession> = {}) => ({
  id: 1,
  contact_id: CLIENT,
  offer_id: LE,
  enrollment_id: ENROLLMENT as number | null,
  status: "booked",
  no_show_at: null as string | null,
  // Tue 6 Oct, 12:00 Denver.
  scheduled_at: "2026-10-06T18:00:00.000Z",
  ...over,
});

type Vector = {
  readonly why: string;
  readonly sessions: ReturnType<typeof session>[];
  readonly candidateWindows?: (typeof WEEK)[];
  readonly status: "fulfilled" | "missed" | "ambiguous";
  readonly basis?: "linked" | "unlinked";
};

const VECTORS: readonly Vector[] = [
  {
    why: "1. a linked qualifying session fulfills it",
    sessions: [session()],
    status: "fulfilled",
    basis: "linked",
  },
  {
    why: "2. an UNLINKED session, same contact and same programme, fulfills it",
    sessions: [session({ enrollment_id: null })],
    candidateWindows: [WEEK],
    status: "fulfilled",
    basis: "unlinked",
  },
  {
    why: "3. an unlinked session for the OTHER programme never fulfills it",
    sessions: [session({ enrollment_id: null, offer_id: GYU })],
    candidateWindows: [WEEK],
    status: "missed",
  },
  {
    why: "3b. an unlinked session belonging to somebody else never fulfills it",
    sessions: [session({ enrollment_id: null, contact_id: 999 })],
    candidateWindows: [WEEK],
    status: "missed",
  },
  {
    why: "3c. a session explicitly linked to a DIFFERENT enrollment is not up for reinterpretation",
    sessions: [session({ enrollment_id: OTHER_ENROLLMENT })],
    candidateWindows: [WEEK],
    status: "missed",
  },
  {
    why: "4. a cancelled session does not fulfill it, linked",
    sessions: [session({ status: "cancelled" })],
    status: "missed",
  },
  {
    why: "4b. a cancelled session does not fulfill it, unlinked either",
    sessions: [session({ enrollment_id: null, status: "cancelled" })],
    candidateWindows: [WEEK],
    status: "missed",
  },
  {
    why: "5. a no-show does not fulfill it, linked",
    sessions: [session({ no_show_at: "2026-10-06T19:00:00.000Z" })],
    status: "missed",
  },
  {
    why: "5b. a no-show does not fulfill it, unlinked either",
    sessions: [
      session({ enrollment_id: null, no_show_at: "2026-10-06T19:00:00.000Z" }),
    ],
    candidateWindows: [WEEK],
    status: "missed",
  },
  {
    why: "6. THE PRODUCTION BOUNDARY — 6pm Denver on the week's last day, unlinked, fulfills it",
    sessions: [
      // Denver Wed 7 Oct 18:00, which is already 8 Oct in UTC.
      session({
        enrollment_id: null,
        scheduled_at: "2026-10-08T00:00:00.000Z",
      }),
    ],
    candidateWindows: [WEEK],
    status: "fulfilled",
    basis: "unlinked",
  },
  {
    why: "6b. the evening BEFORE the week started does not fulfill it",
    sessions: [
      // Denver Sat 3 Oct 20:00.
      session({
        enrollment_id: null,
        scheduled_at: "2026-10-04T02:00:00.000Z",
      }),
    ],
    candidateWindows: [WEEK],
    status: "missed",
  },
  {
    why: "7. no qualifying session at all is MISSED — Jess Beauchamp's real case",
    sessions: [],
    status: "missed",
  },
  {
    why: "10. two expected weeks could each own the same unlinked hour, so it is spent on neither",
    sessions: [session({ enrollment_id: null })],
    candidateWindows: [
      WEEK,
      // A returning client's second Enrollment, overlapping. Nothing in the
      // schema forbids it, so the rule must not guess.
      {
        id: 9,
        enrollment_id: OTHER_ENROLLMENT,
        window_start: "2026-10-05",
        window_end: "2026-10-12",
      },
    ],
    status: "ambiguous",
  },
  {
    why: "10b. a second, uncontested session still answers the question",
    sessions: [
      session({ id: 1, enrollment_id: null }),
      session({
        id: 2,
        enrollment_id: null,
        scheduled_at: "2026-10-04T18:00:00.000Z",
      }),
    ],
    candidateWindows: [
      WEEK,
      {
        id: 9,
        enrollment_id: OTHER_ENROLLMENT,
        window_start: "2026-10-05",
        window_end: "2026-10-12",
      },
    ],
    status: "fulfilled",
    basis: "unlinked",
  },
  {
    why: "a linked session wins even while an unlinked one is contested",
    sessions: [
      session({ id: 1, enrollment_id: null }),
      session({ id: 2, enrollment_id: ENROLLMENT }),
    ],
    candidateWindows: [
      WEEK,
      {
        id: 9,
        enrollment_id: OTHER_ENROLLMENT,
        window_start: "2026-10-05",
        window_end: "2026-10-12",
      },
    ],
    status: "fulfilled",
    basis: "linked",
  },
];

describe("the one cadence-fulfillment authority", () => {
  it.each(VECTORS)("$why", ({ sessions, candidateWindows, status, basis }) => {
    const input = {
      slot: WEEK,
      owner: OWNER,
      sessions,
      candidateWindows: candidateWindows ?? [],
    };

    const fromApp = app.resolveSlotFulfillment(input);
    const fromEdge = edge.resolveSlotFulfillment(input);

    expect(fromApp.status).toBe(status);
    // THE SAME ANSWER, from the copy the calendar sync runs.
    expect(fromEdge.status).toBe(status);
    expect(fromEdge).toEqual(fromApp);

    if (basis && fromApp.status === "fulfilled") {
      expect(fromApp.basis).toBe(basis);
    }
  });
});

// 16. THE FOUR PRODUCTION CASES, in their real shape.
//
// This is the regression that proves the repair did not simply suppress
// every missed-session task: the same rule, over the same kind of data,
// must clear three of them and keep the fourth.
describe("the four production cases", () => {
  const client = (contactId: number, enrollmentId: number) => ({
    enrollment_id: enrollmentId,
    contact_id: contactId,
    offer_id: LE,
  });

  const unlinkedAt = (contactId: number, scheduled_at: string) =>
    session({ contact_id: contactId, enrollment_id: null, scheduled_at });

  it.each([
    // Mon 5 Oct 11:00 MT.
    {
      who: "Ava Frotton",
      contact: 100,
      enrollment: 67,
      at: "2026-10-05T17:00:00.000Z",
    },
    // Wed 7 Oct 14:00 MT — the week's final day.
    {
      who: "Denise Cormier",
      contact: 106,
      enrollment: 66,
      at: "2026-10-07T20:00:00.000Z",
    },
    // Sun 4 Oct 11:00 MT — the week's first day.
    {
      who: "Gina McNamara",
      contact: 45,
      enrollment: 40,
      at: "2026-10-04T17:00:00.000Z",
    },
  ])(
    "$who had her session, and the unlinked row proves it",
    ({ contact, enrollment, at }) => {
      const owner = client(contact, enrollment);
      const slot = { ...WEEK, enrollment_id: enrollment };
      const outcome = app.resolveSlotFulfillment({
        slot,
        owner,
        sessions: [unlinkedAt(contact, at)],
        candidateWindows: [slot],
      });
      expect(outcome.status).toBe("fulfilled");
      if (outcome.status !== "fulfilled") return;
      expect(outcome.basis).toBe("unlinked");
    },
  );

  it("Jess Beauchamp had no session, and still has not", () => {
    const owner = client(174, 59);
    const slot = { ...WEEK, enrollment_id: 59 };
    const outcome = app.resolveSlotFulfillment({
      slot,
      owner,
      // Her nearest booking is 12 October — the week after.
      sessions: [unlinkedAt(174, "2026-10-12T18:00:00.000Z")],
      candidateWindows: [slot],
    });
    expect(outcome.status).toBe("missed");
  });
});
