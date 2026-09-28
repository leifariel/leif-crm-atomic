import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// A Start Week is Leif's decision. Migration 20260921130000 found 19 of 22
// Living Example start dates back-filled from a booked session and had to
// stop trusting all of them, because "a client commits to the programme and
// then chooses when to begin". These hold the code to that.

const read = (path: string) => readFileSync(path, "utf8");

const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)(--|\/\/).*$/, ""))
    .join("\n");

const ACCEPTANCE = read(
  "src/components/atomic-crm/deals/setStartWeekOnAcceptance.ts",
);
const DECISION = read(
  "src/components/atomic-crm/deals/OpportunityDecisionActions.tsx",
);
const MODAL = read("src/components/atomic-crm/enrollments/ClientEditModal.tsx");
const ROUTE = read("src/components/atomic-crm/enrollments/ClientEdit.tsx");
const CARD = read("src/components/atomic-crm/enrollments/StartWeekCard.tsx");
const CAPACITY = read(
  "src/components/atomic-crm/capacity/individualCapacity.ts",
);
const SLOT = read("src/components/atomic-crm/capacity/slotHolder.ts");
const FUNCTIONS = read("supabase/schemas/02_functions.sql");

describe("nothing infers a Start Week", () => {
  test("the acceptance writer only ever writes what it was handed", () => {
    const body = code(ACCEPTANCE);
    expect(body).toMatch(/if \(!startWeek\) return \{ status: "left-unset" \}/);
    expect(body).toMatch(/start_date: startWeek, start_date_source: "owner"/);
    // None of the tempting sources.
    for (const forbidden of [
      "new Date(",
      "scheduled_at",
      "client_sessions",
      "won_at",
      "sales_call",
      "payment",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  test("Set later writes nothing, and invents no second field to say it", () => {
    expect(code(ACCEPTANCE)).toMatch(/"left-unset"/);
    // The only columns this module touches.
    const writes = code(ACCEPTANCE).match(/data: \{[^}]*\}/g) ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/start_date/);
    expect(writes[0]).toMatch(/start_date_source/);
    expect(writes[0]).not.toMatch(/start_week_deferred|set_later|unresolved/);
  });

  test("the database leaves an individual programme's start week unset", () => {
    // handle_deal_saved copies a Cohort's published start for a group round
    // and nothing for an individual offer, where the Start Week is Leif's.
    const start = FUNCTIONS.indexOf('FUNCTION "public"."handle_deal_saved"()');
    const fn = FUNCTIONS.slice(start, FUNCTIONS.indexOf("\n$;", start));
    expect(fn).toMatch(
      /case when v_cohort\.program_start_at is not null then 'owner' end/,
    );
  });

  test("the sale is recorded before the start week, never as one write", () => {
    const body = code(DECISION);
    const recorded = body.indexOf("recordYes(");
    const stated = body.indexOf("setStartWeekOnAcceptance(");
    expect(recorded).toBeGreaterThan(-1);
    expect(stated).toBeGreaterThan(recorded);
  });

  test("only an individual programme is asked", () => {
    expect(code(DECISION)).toMatch(/useIndividualOffer\(deal\)/);
    expect(code(DECISION)).toMatch(
      /individualOffer \? setStartWeekOpen\(true\) : yes\(null\)/,
    );
  });
});

describe("one edit implementation, two entry points", () => {
  test("the route is a thin wrapper around the modal", () => {
    expect(code(ROUTE)).toMatch(/ClientEditModal/);
    expect(code(ROUTE)).toMatch(/navigate\(-1\)/);
    expect(ROUTE.split("\n").length).toBeLessThan(30);
    // No second copy of the form.
    expect(code(ROUTE)).not.toMatch(/DateInput|SelectInput|EditBase/);
    expect(code(MODAL)).toMatch(/EditBase/);
  });

  test("saving is the owner's statement, and clearing it says nothing else", () => {
    expect(code(MODAL)).toMatch(
      /start_date_source: data\.start_date \? \("owner" as const\) : null/,
    );
  });

  test("the client page opens it over itself", () => {
    const show = code(
      read("src/components/atomic-crm/enrollments/ClientShow.tsx"),
    );
    expect(show).toMatch(/ClientEditModal/);
    expect(show).not.toMatch(/EditButton/);
  });
});

describe("what an unset Start Week costs is said, not hidden", () => {
  test("capacity answers it as its own list", () => {
    expect(code(CAPACITY)).toMatch(/missingStartWeek: SlotHolder\[\]/);
    expect(code(CAPACITY)).toMatch(
      /missingStartWeek: everyone\.filter\(\(holder\) => holder\.startDate == null\)/,
    );
    // And it is not folded into the "this date needs confirming" list.
    expect(code(CAPACITY)).toMatch(
      /unconfirmedStartWeek: everyone\.filter\(\s*\(holder\) => holder\.startDate != null && !holder\.startWeekConfirmed,\s*\)/,
    );
  });

  test("they keep holding a slot, because not knowing frees nothing", () => {
    // classifyEnrollment/slotOccupancy treat a null start as occupied; this
    // contract exists so a later "tidy-up" cannot quietly exclude them.
    const occupancy = code(
      read("src/components/atomic-crm/capacity/slotOccupancy.ts"),
    );
    expect(occupancy).toMatch(/classifyEnrollment/);
    expect(read("src/components/atomic-crm/capacity/slotOccupancy.ts")).toMatch(
      /An Enrollment with no start_date at all counts as occupied/,
    );
  });

  test("the card says what it costs and offers the fix", () => {
    expect(CARD).toMatch(/Start week not set/);
    expect(CARD).toMatch(/can only be a minimum/);
    expect(code(CARD)).toMatch(/ClientEditModal/);
    // Operator language in the two sentences Leif reads: what is true, and
    // what it costs. Not a word about how any of it is stored.
    const sentences = [
      "openings count this client as taking a place from now on, and can only be a minimum until you set the week they start",
      "This date came from their first booked session, not from you",
    ];
    for (const sentence of sentences) {
      expect(CARD).toContain(sentence);
      for (const forbidden of ["start_date_source", "enrollment", "column"]) {
        expect(sentence).not.toContain(forbidden);
      }
    }
  });
});

describe("an end date is a decision, never arithmetic", () => {
  test("a recorded end outranks the projection, and nothing writes one", () => {
    expect(CAPACITY).toMatch(
      /A recorded end date is somebody's decision and outranks the/,
    );
    // The projected end is computed at read time and never stored.
    expect(code(CAPACITY)).toMatch(/computeExpectedEnd\(/);
    expect(code(CAPACITY)).not.toMatch(/end_date:.*computeExpectedEnd/);
    expect(code(ACCEPTANCE)).not.toMatch(/end_date/);
    expect(code(MODAL)).not.toMatch(/end_date:/);
  });

  test("ending a client still refuses to invent the day they stopped", () => {
    const ending = read(
      "src/components/atomic-crm/enrollments/endEnrollment.ts",
    );
    expect(ending).toMatch(/It does not set an end_date/);
  });

  test("a holder with no start week has no computed end either", () => {
    expect(SLOT.replace(/\/\//g, " ").replace(/\s+/g, " ")).toMatch(
      /Null when there is no Start Date to count from/,
    );
  });
});
