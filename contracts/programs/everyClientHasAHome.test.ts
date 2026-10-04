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
  "src/components/atomic-crm/programs/NeedsStartWeekSection.tsx",
);
const CAPACITY = read(
  "src/components/atomic-crm/capacity/individualCapacity.ts",
);
const OPENINGS = read(
  "src/components/atomic-crm/programs/UpcomingOpeningsSection.tsx",
);

describe("the three client phases, three client sections", () => {
  test("the page renders a section per non-released phase", () => {
    const body = code(PAGE);
    expect(body).toMatch(/capacity\.occupied\.map/);
    expect(body).toMatch(/capacity\.committed\.map/);
    expect(body).toMatch(
      /<NeedsStartWeekSection clients=\{capacity\.unscheduled\}/,
    );
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

  test("the unscheduled section sits with the client sections, not under the forecast", () => {
    const body = code(PAGE);
    const needs = body.indexOf("NeedsStartWeekSection clients");
    const current = body.indexOf("capacity.occupied.map");
    const openings = body.indexOf("<UpcomingOpeningsSection");
    expect(needs).toBeGreaterThan(current);
    expect(needs).toBeLessThan(openings);
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

  test("the name links to the client's own record", () => {
    expect(code(SECTION)).toMatch(
      /to=\{`\/enrollments\/\$\{client\.enrollmentId\}\/show`\}/,
    );
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
