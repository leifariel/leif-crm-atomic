import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Leif set Todd Jacobsen's start week. The CRM said "Client updated". The
// week was not there.
//
// It was never the database. EditBase defaults to mutationMode="undoable":
// ra-core patches its own cache, calls onSuccess with the OPTIMISTIC record
// and QUEUES the real dataProvider.update for whichever notification comes
// next. Notification pops that queued write with takeMutation() and then
// runs it only `if (undoable)`. ClientEditModal's onSuccess raised a plain
// notify("Client updated"), so the write was taken off the queue by a toast
// that did not know it was holding one, and discarded. Not delayed. Gone.
//
// Two separate failures, and these contracts hold both shut:
//
//   1. the write has to actually happen
//   2. "Client updated" is a claim about the database, and only the record
//      that came back may authorise it
//
// This is also a trap and not a one-off: the same construction is a few
// characters away in every edit form in the app, and TaskEdit survives only
// because its notify happens to pass undoable: true. So the last test here
// sweeps all of them.

const read = (path: string) => readFileSync(path, "utf8");

const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");

const MODAL = read("src/components/atomic-crm/enrollments/ClientEditModal.tsx");
const CHECK = read(
  "src/components/atomic-crm/enrollments/savedWhatWasStated.ts",
);

describe("the write actually happens", () => {
  test("the client editor asks the database first", () => {
    expect(code(MODAL)).toMatch(/mutationMode="pessimistic"/);
  });

  test("and why, so nobody tidies it back to the default", () => {
    expect(MODAL).toMatch(/Todd Jacobsen/);
    expect(MODAL).toMatch(/takeMutation/);
    expect(MODAL).toMatch(/undoable/);
  });
});

describe('"Client updated" is earned, not assumed', () => {
  test("the toast is decided by the record that came back", () => {
    const body = code(MODAL);
    expect(body).toMatch(/assessEnrollmentSave\(\{/);
    expect(body).toMatch(/stated: stated\.current \?\? \{\}/);
    expect(body).toMatch(/saved,/);
    // And the success branch is the one the verdict chooses, not the one
    // the absence of an error chooses.
    expect(body).toMatch(/if \(verdict\.kind === "saved"\)/);
  });

  test("a save that did not happen keeps the modal open and does not claim success", () => {
    const body = code(MODAL);
    const success = body.slice(body.indexOf('verdict.kind === "saved"'));
    // The close + refresh live only inside the success branch.
    const closing = success.indexOf("onOpenChange(false)");
    const returning = success.indexOf("return;");
    expect(closing).toBeGreaterThan(-1);
    expect(returning).toBeGreaterThan(closing);
    // The other branch raises a warning that does not time out.
    expect(body).toMatch(/type: "warning", autoHideDuration: 0/);
  });

  test("comparing a date never cries wolf over its shape", () => {
    const body = code(CHECK);
    expect(body).toMatch(/export const dateOnly/);
    // Both sides go through it; a raw !== on the stored value would report
    // every save as a failure the first time a provider returned a
    // timestamp, which would be worse than the bug it replaced.
    expect(body).toMatch(
      /\? \(\(record\.status \?\? null\) as string \| null\)/,
    );
    expect(body).toMatch(/: dateOnly\(record\[field\]\)/);
  });

  test("a field Leif did not state is not checked", () => {
    expect(code(CHECK)).toMatch(
      /FIELDS\.filter\(\(field\) => field in stated\)/,
    );
  });
});

// Every edit form in the app, checked for the construction that lost Todd's
// start week: an undoable mutation plus a custom onSuccess whose notify is
// not itself undoable.
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory()
      ? walk(path)
      : path.endsWith(".tsx") && !path.includes(".test.")
        ? [path]
        : [];
  });

// Each call to `name(...)` with its arguments, by counting parentheses.
// A non-greedy regex is not enough here: it stops at the first nested
// closing brace, which cut EditSheet's call off before the very option
// being checked for.
const callsTo = (name: string, body: string): string[] => {
  const calls: string[] = [];
  const needle = `${name}(`;
  let from = body.indexOf(needle);
  while (from !== -1) {
    let depth = 0;
    let index = from + needle.length - 1;
    for (; index < body.length; index += 1) {
      if (body[index] === "(") depth += 1;
      else if (body[index] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(body.slice(from, index + 1));
    from = body.indexOf(needle, index + 1);
  }
  return calls;
};

describe("the other way to lose a queued write", () => {
  // Variant 1 is a plain notify() over a queued mutation: the toast pops it
  // and discards it. Variant 2 is raising NO notification, which leaves the
  // mutation in the queue, never sent. The sweep below catches variant 1 by
  // reading every notify; variant 2 is a PATH through an onSuccess and no
  // static rule can see it honestly, so the one place it was found is
  // pinned here by name.
  test("reopening a Task asks the database rather than queueing", () => {
    const body = code(read("src/components/atomic-crm/tasks/Task.tsx"));
    expect(body).toMatch(
      /mutationMode: completing \? "undoable" : "pessimistic"/,
    );
  });

  test("and why, so it is not flattened back for consistency", () => {
    const source = read("src/components/atomic-crm/tasks/Task.tsx");
    expect(source).toMatch(/UndoableMutationsContextProvider/);
    // Wrapped across lines by the formatter, so the assertion reads the
    // words rather than the line.
    expect(source.replace(/\s*\/\/\s*/g, " ")).toMatch(/was never sent/);
    // The regression that proves both halves lives next to the component.
    expect(() =>
      read("src/components/atomic-crm/tasks/reopeningATaskIsSent.test.tsx"),
    ).not.toThrow();
  });
});

describe("no other form is built the way this one was", () => {
  test("an undoable edit never raises a toast that is not undoable", () => {
    const offenders: string[] = [];

    for (const path of walk("src/components/atomic-crm")) {
      const body = code(read(path));
      const isEditForm = /<EditBase|<Edit[\s>]/.test(body);
      if (!isEditForm) continue;

      // A form that asks the database first cannot queue anything, so the
      // hazard does not exist for it.
      const pessimistic =
        /mutationMode="pessimistic"/.test(body) ||
        /mutationMode = "pessimistic"/.test(body);
      if (pessimistic) continue;

      // Does it hand EditBase its own onSuccess that notifies?
      const hasCustomSuccess = /onSuccess[:=]/.test(body);
      const notifies = /notify\(/.test(body);
      if (!hasCustomSuccess || !notifies) continue;

      // Then every notify it raises must declare itself undoable — either
      // literally, or conditionally on the mode it was given.
      const notifyCalls = callsTo("notify", body);
      const allDeclare =
        notifyCalls.length > 0 &&
        notifyCalls.every((call) => /undoable:/.test(call));
      if (!allDeclare) offenders.push(path);
    }

    // Before the repair this list was exactly [ClientEditModal.tsx].
    expect(offenders).toEqual([]);
  });
});
