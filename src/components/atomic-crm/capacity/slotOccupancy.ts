import type { Enrollment } from "../types";
import { classifyEnrollment } from "../enrollments/classifyEnrollment";

// THE rule for whether an Enrollment is consuming one of an individual
// Offer's concurrent client slots. One definition, used by every surface
// that shows a capacity number.
//
// It had three.
//
// The Clients list already asked the right question — classifyEnrollment.ts
// reads start_date, end_date, the terminal statuses and today, and its own
// header names the case that forced it: Daniel Alexander, agreed and set up
// with a container starting 8 November, appearing under Current Clients
// seven weeks early. But the dashboard capacity card, the program page and
// this rule each kept their OWN copy of "active", and those copies looked
// only at the status column. So the Clients list said twelve current
// clients while the dashboard said "18 / 12 active · 0 openings", from the
// same rows, on the same screen.
//
// Six of those eighteen had not started. The card was not counting clients;
// it was counting agreements. Nothing was wrong with the data.
//
// So there is now one rule, and it is the one that was already right.
// classifyEnrollment is the authority; this module names what its phases
// MEAN for capacity, and everything else asks here.

export type SlotPhase = "occupied" | "committed" | "unscheduled" | "released";

// A container that is running right now occupies a slot. One that has been
// agreed but not started is COMMITTED — a real obligation Leif cannot sell
// twice, but not somebody he is working with today. Terminal or finished
// containers have released theirs.
//
// An Enrollment with no start_date at all is UNSCHEDULED: a real
// obligation that has not been placed in a week yet, consuming neither an
// active slot nor a dated one.
//
// This reverses a deliberate earlier decision, and the reversal is the
// point. The old rule counted it as occupied, reasoning that "hiding it
// would undercount a real person" — the conservative floor, so openings
// could never over-promise. Todd Jacobsen showed what that costs. Onboarded
// on 2026-10-02 with no start week, he made a twelve-client programme read
// 13 / 12 and over capacity: a number true of nobody. And because an active
// count above the ceiling leaves nothing to offer, he also erased a
// genuinely open week from the openings view. The floor was protecting a
// number at the cost of concealing the answer.
//
// So the trade is taken the other way, deliberately: openings are now an
// estimate that can be too generous rather than one that hides real
// availability, and the risk is carried in the open instead. Every
// unscheduled commitment is named — capacity.missingStartWeek, rendered by
// UpcomingOpeningsSection and by StartWeekCard on the client's own page —
// so the question "when does this person start?" is visible rather than
// silently answered with "now".
//
// What has NOT changed: nothing infers a start week. Not from an onboarding
// date, a Won date, a payment, or a booked session. A week Leif has not
// stated does not exist.
//
// classifyEnrollment is untouched and still answers its own question ("is
// this a current client?") for the Clients list. This module answers a
// different one — "is this consuming a dated slot?" — and for a commitment
// with no week the two honestly differ.
export const slotPhaseOf = (
  enrollment: Pick<Enrollment, "status" | "start_date" | "end_date">,
  today?: string,
): SlotPhase => {
  const phase = classifyEnrollment(enrollment, today);
  // Terminal first: a finished container has released its slot whether or
  // not anybody ever recorded when it began.
  if (phase !== "current" && phase !== "upcoming") return "released";
  if (enrollment.start_date == null) return "unscheduled";
  return phase === "current" ? "occupied" : "committed";
};

export const occupiesSlot = (
  enrollment: Pick<Enrollment, "status" | "start_date" | "end_date">,
  today?: string,
): boolean => slotPhaseOf(enrollment, today) === "occupied";

// A commitment Leif still has to place in a week. Named so a caller has to
// decide what to do about it rather than have it folded into a count.
export const isUnscheduled = (
  enrollment: Pick<Enrollment, "status" | "start_date" | "end_date">,
  today?: string,
): boolean => slotPhaseOf(enrollment, today) === "unscheduled";

export const isCommittedFutureStart = (
  enrollment: Pick<Enrollment, "status" | "start_date" | "end_date">,
  today?: string,
): boolean => slotPhaseOf(enrollment, today) === "committed";

export const toDateKey = (value: Date): string =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate(),
  ).padStart(2, "0")}`;
