import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// THREE PLACES NAME THE KIT MAPPING EVENTS. THEY MUST NAME THE SAME ONES.
//
// THE BUG THIS EXISTS FOR. `20261010120000` added `waitlist_invited` to the
// mappings table and OfferKitSection.tsx started offering it as "Invited from
// the waitlist". Two of the three lists were never extended: the declarative
// constraint, and — the one that mattered — `set_program_kit_tag`'s own
// whitelist.
//
// So the picker offered a slot the writer refused. And the writer refuses by
// returning a NAMED STATUS rather than raising, so PostgREST answered 200,
// the client saw no error, and the toast said "saved". Leif set the tag, was
// told it saved, navigated away, came back, and it said "Not set". Nothing
// had ever been written.
//
// A picker that can offer an event the writer will refuse is the whole
// defect, so the assertion is equality across all three — not "the writer
// knows at least what the table allows".

const read = (path: string) => readFileSync(path, "utf8");

/** The events a `… in ('a', 'b', …)` list names, in the order written. */
const eventsIn = (source: string, after: string): string[] => {
  const start = source.indexOf(after);
  if (start < 0) throw new Error(`anchor not found: ${after}`);
  const open = source.indexOf("(", start + after.length - 1);
  const close = source.indexOf(")", open);
  if (open < 0 || close < 0) throw new Error(`no list after: ${after}`);
  return [...source.slice(open, close).matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1]!)
    .sort();
};

// 1. The table: what a row may say at all.
const constraintEvents = eventsIn(
  read("supabase/schemas/01_tables.sql"),
  "constraint kit_tag_mappings_event_check",
);

// 2. The writer: what set_program_kit_tag() will accept.
const writerEvents = (() => {
  const functions = read("supabase/schemas/02_functions.sql");
  const fn = functions.indexOf(
    "create or replace function public.set_program_kit_tag(",
  );
  expect(fn, "set_program_kit_tag is not in 02_functions.sql").toBeGreaterThan(
    -1,
  );
  return eventsIn(functions.slice(fn), "if p_event not in");
})();

// 3. The picker: what Leif is offered.
const pickerEvents = (() => {
  const ui = read("src/components/atomic-crm/offers/OfferKitSection.tsx");
  return [...ui.matchAll(/\{\s*event:\s*"([a-z_]+)"\s*,\s*label:/g)]
    .map((m) => m[1]!)
    .sort();
})();

describe("the Kit mapping events agree everywhere", () => {
  it("the lists are not empty, so none of this passes vacuously", () => {
    expect(constraintEvents.length).toBeGreaterThan(5);
    expect(writerEvents.length).toBeGreaterThan(5);
    expect(pickerEvents.length).toBeGreaterThan(5);
  });

  it("the writer accepts exactly what the table allows", () => {
    // Narrower is the production bug: the picker offers it, the table
    // stores it, and the writer answers 'event-invalid'. Wider would let a
    // write reach a constraint violation instead of a named status.
    expect(writerEvents).toEqual(constraintEvents);
  });

  it("the picker offers exactly what the writer accepts", () => {
    expect(pickerEvents).toEqual(writerEvents);
  });

  it("waitlist_invited is one of them", () => {
    // Named, because this is the one that was missing and the one the
    // waitlist batches depend on.
    expect(constraintEvents).toContain("waitlist_invited");
    expect(writerEvents).toContain("waitlist_invited");
    expect(pickerEvents).toContain("waitlist_invited");
  });
});

// Only 'set' and 'cleared' mean a mapping was written. The picker used to
// treat every non-throwing answer as success, which is how a refusal became
// a success toast.
describe("the writer's refusals are named, not raised", () => {
  const writer = (() => {
    const functions = read("supabase/schemas/02_functions.sql");
    const fn = functions.indexOf(
      "create or replace function public.set_program_kit_tag(",
    );
    return functions.slice(fn, functions.indexOf("$$;", fn));
  })();

  it.each([
    "offer-invalid",
    "event-invalid",
    "tag-invalid",
    "tag-already-used-by-another-decision",
  ])("%s is returned rather than thrown", (status) => {
    expect(writer).toContain(`'status', '${status}'`);
    expect(writer).not.toContain(`raise exception '${status}'`);
  });

  it("the picker treats every one of them as a failure", () => {
    const ui = read("src/components/atomic-crm/offers/OfferKitSection.tsx");
    // Success is allow-listed, so a status added later is a failure by
    // default rather than a silent success.
    expect(ui).toContain(`result?.status !== "set"`);
    expect(ui).toContain(`result?.status !== "cleared"`);
    for (const status of [
      "offer-invalid",
      "event-invalid",
      "tag-invalid",
      "tag-already-used-by-another-decision",
    ]) {
      expect(ui, `${status} has no message for Leif`).toContain(status);
    }
  });
});
