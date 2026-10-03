import { describe, expect, test } from "vitest";

import {
  assessEnrollmentSave,
  dateOnly,
  saveOutcomeMessage,
} from "./savedWhatWasStated";

// "Client updated" is a claim about the database. These are the rules that
// decide whether the CRM has earned the right to make it.

describe("reading the day a value names", () => {
  test("agrees across every shape the same day arrives in", () => {
    const day = "2026-11-09";
    expect(dateOnly(day)).toBe(day);
    expect(dateOnly("2026-11-09T00:00:00.000Z")).toBe(day);
    expect(dateOnly(new Date("2026-11-09T00:00:00.000Z"))).toBe(day);
    expect(dateOnly(Date.UTC(2026, 10, 9))).toBe(day);
  });

  test("reads nothing as nothing, and nonsense as nothing", () => {
    expect(dateOnly(null)).toBeNull();
    expect(dateOnly(undefined)).toBeNull();
    expect(dateOnly("")).toBeNull();
    expect(dateOnly("not a date")).toBeNull();
    expect(dateOnly(new Date("nope"))).toBeNull();
  });
});

describe("deciding whether a save happened", () => {
  test("the record coming back with the stated week is a save", () => {
    expect(
      assessEnrollmentSave({
        stated: { start_date: "2026-11-09" },
        saved: { start_date: "2026-11-09" },
      }),
    ).toEqual({ kind: "saved" });
  });

  test("a different shape of the same day is still a save", () => {
    // The whole repair is worthless if it cries wolf on every save.
    expect(
      assessEnrollmentSave({
        stated: { start_date: "2026-11-09" },
        saved: { start_date: "2026-11-09T00:00:00+00:00" },
      }),
    ).toEqual({ kind: "saved" });
  });

  test("the record coming back without it is not a save", () => {
    const verdict = assessEnrollmentSave({
      stated: { start_date: "2026-11-09" },
      saved: { start_date: null },
    });
    expect(verdict.kind).toBe("not-saved");
    expect(verdict).toEqual({
      kind: "not-saved",
      mismatches: [{ field: "start_date", stated: "2026-11-09", saved: null }],
    });
  });

  test("the record coming back with a DIFFERENT day is not a save either", () => {
    const verdict = assessEnrollmentSave({
      stated: { start_date: "2026-11-09" },
      saved: { start_date: "2026-11-02" },
    });
    expect(verdict.kind).toBe("not-saved");
  });

  test("clearing the week on purpose is a statement, and saving it is a save", () => {
    expect(
      assessEnrollmentSave({
        stated: { start_date: null },
        saved: { start_date: null },
      }),
    ).toEqual({ kind: "saved" });
  });

  test("clearing it and getting the old date back is not a save", () => {
    const verdict = assessEnrollmentSave({
      stated: { start_date: null },
      saved: { start_date: "2026-11-09" },
    });
    expect(verdict.kind).toBe("not-saved");
    expect(saveOutcomeMessage(verdict)).toContain(
      "start week is still 2026-11-09",
    );
  });

  test("a field Leif did not state is not checked", () => {
    // A status-only edit must not trip on a week nobody touched.
    expect(
      assessEnrollmentSave({
        stated: { status: "active" },
        saved: { status: "active", start_date: null },
      }),
    ).toEqual({ kind: "saved" });
  });

  test("status and the finish date are held to the same rule", () => {
    expect(
      assessEnrollmentSave({
        stated: { status: "completed", end_date: "2026-12-01" },
        saved: { status: "active", end_date: "2026-12-01" },
      }),
    ).toEqual({
      kind: "not-saved",
      mismatches: [{ field: "status", stated: "completed", saved: "active" }],
    });
  });

  test("no record back at all is not treated as a failure", () => {
    // A provider is allowed not to return one. Inventing a failure the CRM
    // cannot actually see would be the same sin in the other direction.
    expect(
      assessEnrollmentSave({
        stated: { start_date: "2026-11-09" },
        saved: null,
      }),
    ).toEqual({ kind: "saved" });
  });
});

describe("the record has to be the right record", () => {
  test("the right date on the wrong client is not a save", () => {
    // The one failure a value comparison reads as perfect: every field
    // matches, and it is somebody else's row.
    const verdict = assessEnrollmentSave({
      stated: { start_date: "2026-11-09" },
      saved: { id: 41, start_date: "2026-11-09" },
      intendedId: 7,
    });
    expect(verdict).toEqual({
      kind: "wrong-record",
      intended: "7",
      saved: "41",
    });
    expect(saveOutcomeMessage(verdict)).toContain(
      "an answer about a different client",
    );
  });

  test("the right client is a save, whichever way the id is typed", () => {
    // PostgREST returns a number, the route gives a string. A save must not
    // be reported as a failure over that.
    expect(
      assessEnrollmentSave({
        stated: { start_date: "2026-11-09" },
        saved: { id: 7, start_date: "2026-11-09" },
        intendedId: "7",
      }),
    ).toEqual({ kind: "saved" });
  });

  test("a record with no id is judged on its values alone", () => {
    // Nothing to check identity against is not evidence of a wrong record,
    // and inventing a failure here would be the same sin in reverse.
    expect(
      assessEnrollmentSave({
        stated: { start_date: "2026-11-09" },
        saved: { start_date: "2026-11-09" },
        intendedId: 7,
      }),
    ).toEqual({ kind: "saved" });
  });

  test("identity is checked before values, so it is never masked", () => {
    const verdict = assessEnrollmentSave({
      stated: { start_date: "2026-11-09" },
      saved: { id: 41, start_date: null },
      intendedId: 7,
    });
    expect(verdict.kind).toBe("wrong-record");
  });
});

describe("what Leif reads", () => {
  test("a save says so plainly", () => {
    expect(saveOutcomeMessage({ kind: "saved" })).toBe("Client updated");
  });

  test("a non-save names the field and the real outcome", () => {
    const message = saveOutcomeMessage({
      kind: "not-saved",
      mismatches: [{ field: "start_date", stated: "2026-11-09", saved: null }],
    });
    expect(message).toContain("Not saved");
    expect(message).toContain("start week");
    expect(message).toContain("empty");
    expect(message).toContain("2026-11-09");
    // Operator language only: nothing about columns, rows or providers.
    for (const forbidden of ["start_date", "enrollment", "column", "null"]) {
      expect(message).not.toContain(forbidden);
    }
  });
});
