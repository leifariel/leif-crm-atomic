import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Every phase a client can be in has a section on the programme page.
//
// This contract exists because of a specific failure. Giving a commitment
// with no start week its own capacity phase was correct — it consumes no
// dated slot, and counting it as occupying today made a twelve-client
// programme read 13 / 12. But the page had exactly two client sections,
// occupied and committed, so the new phase had nowhere to render. Leif went
// looking for Todd Jacobsen on the real production page and found him
// reduced to one grey sentence under the openings forecast, with no row to
// click and no way through to set the week.
//
// The arithmetic was right and the page had lost a client. So the rule is
// not "the numbers must be correct" — it is that a phase and a home arrive
// together.
//
// The home moved once since. Two client sections for "agreed and not
// started" was one heading more than the question deserved, so committed
// and unscheduled share Starting Later — and the contract moved with it
// rather than being dropped. What it now insists on is stronger, because
// the three-row preview gave the old failure a new way to happen: the
// person who needs something must come FIRST in that list, or they are
// behind "N more" and lost again.

const read = (path: string) => readFileSync(path, "utf8");

const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");

const PAGE = read(
  "src/components/atomic-crm/programs/IndividualProgramPage.tsx",
);
const SECTION = read(
  "src/components/atomic-crm/programs/StartingLaterSection.tsx",
);
const ROW = read("src/components/atomic-crm/programs/SlotPersonCard.tsx");
const CAPACITY = read(
  "src/components/atomic-crm/capacity/individualCapacity.ts",
);
const OPENINGS = read(
  "src/components/atomic-crm/programs/UpcomingOpeningsSection.tsx",
);

describe("the three client phases, and a home for each", () => {
  test("the page hands every non-released phase to a section", () => {
    const body = code(PAGE);
    expect(body).toMatch(/items=\{capacity\.occupied\}/);
    expect(body).toMatch(/committed=\{capacity\.committed\}/);
    expect(body).toMatch(/unscheduled=\{capacity\.unscheduled\}/);
  });

  test("and the one with a question comes first inside it", () => {
    // Not cosmetic. The preview shows three rows, so an unscheduled client
    // sorted after six committed ones is behind "N more" — which is the
    // Todd failure again, wearing a disclosure control.
    expect(code(SECTION)).toMatch(
      /const clients = \[\.\.\.unscheduled, \.\.\.committed\]/,
    );
  });

  test("and says what they need, with the control that answers it", () => {
    const body = code(SECTION);
    expect(body).toMatch(/needs_start_week_badge/);
    expect(body).toMatch(/set_start_week/);
    expect(body).toMatch(/starting_later_needs_week/);
  });

  test("and the capacity model still only has those three", () => {
    // If a fourth non-released phase is ever added, this fails and the
    // author has to decide where those people appear — which is the whole
    // point of the contract.
    const phases = code(
      read("src/components/atomic-crm/capacity/slotOccupancy.ts"),
    ).match(/"(occupied|committed|unscheduled|released)"/g);
    expect(new Set(phases)).toEqual(
      new Set(['"occupied"', '"committed"', '"unscheduled"', '"released"']),
    );
  });

  test("they sit with the client sections, not under the forecast", () => {
    const body = code(PAGE);
    const later = body.indexOf("<StartingLaterSection");
    const current = body.indexOf("items={capacity.occupied}");
    const openings = body.indexOf("<UpcomingOpeningsSection");
    // -1 on both sides would make the comparisons below pass without
    // proving anything, so each anchor has to be found first.
    expect(current).toBeGreaterThan(-1);
    expect(later).toBeGreaterThan(-1);
    expect(openings).toBeGreaterThan(-1);
    expect(later).toBeGreaterThan(current);
    expect(later).toBeLessThan(openings);
  });
});

describe("the row is actionable, and there is still one start-week editor", () => {
  test("it reuses ClientEditModal rather than editing a date itself", () => {
    const body = code(SECTION);
    expect(body).toMatch(/ClientEditModal/);
    // No second editor: nothing here writes start_date or its provenance.
    for (const forbidden of [
      "useUpdate",
      "dataProvider",
      "start_date_source",
      "DateInput",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  test("the row opens the client's own record, not their Contact page", () => {
    // The destination the Clients page uses, for the reason it records:
    // the generic Contact page shows no start/end dates, payment state,
    // onboarding or sessions. rowLinkTo, not to — the whole row is the
    // target, and `to` keeps its own meaning for callers that only want
    // the name linked.
    // One row component for every client phase now, which is why there is
    // one place to assert this.
    expect(code(ROW)).toMatch(
      /rowLinkTo=\{`\/enrollments\/\$\{client\.enrollmentId\}\/show`\}/,
    );
    expect(code(ROW)).not.toMatch(/\/contacts\//);
    expect(code(SECTION)).not.toMatch(/\/contacts\//);
  });

  test("and why, so it is not quietly turned back into a footnote", () => {
    expect(SECTION).toMatch(/Todd Jacobsen/);
    expect(SECTION).toMatch(/13 \/ 12/);
  });
});

describe("the openings footnote is a caveat, not a workflow", () => {
  test("it counts them and does not name them", () => {
    const body = code(OPENINGS);
    const call = body.slice(
      body.indexOf("openings_missing_start_week"),
      body.indexOf("openings_unknown_end"),
    );
    expect(call).toMatch(/smart_count: missingStartWeek\.length/);
    // Naming them here is what made this line their only representation.
    expect(call).not.toMatch(/names: names\(missingStartWeek\)/);
    // And no action lives in the forecast.
    expect(call).not.toMatch(/Button|onClick|ClientEditModal/);
  });

  test("the unscheduled list is still surfaced by the model", () => {
    // The caveat is allowed to shrink; the data behind it may not vanish.
    expect(code(CAPACITY)).toMatch(/missingStartWeek: SlotHolder\[\]/);
    expect(code(CAPACITY)).toMatch(/unscheduled: SlotHolder\[\]/);
  });
});
