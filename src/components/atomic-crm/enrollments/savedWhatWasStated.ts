import type { Enrollment } from "../types";

// Whether a save actually saved what Leif said.
//
// Leif set Todd Jacobsen's start week, the CRM said "Client updated", and
// the week was not there afterwards. The missing week is one bug; the
// sentence is a worse one. A success message is a claim about the database,
// and the only thing that entitles the CRM to make it is the record that
// came back.
//
// So the toast is no longer fired by "the request did not throw". It is
// fired by reading the saved record and finding Leif's statement in it.
// This module is the comparison, kept pure and apart from the modal so it
// can be tested on its own and reused by the next form that needs it.
//
// The danger of a check like this is the opposite failure: crying wolf on
// every save because a date round-tripped through a different shape. Hence
// `dateOnly` — both sides are normalised to the day, so "2026-11-09",
// "2026-11-09T00:00:00Z" and a Date for that midnight all agree, and only a
// genuinely different day is reported.

// The day a value names, whatever shape it arrives in, or null. Anything
// unparseable is null rather than a thrown error: an unreadable value is
// exactly the case where the CRM must not claim success.
export const dateOnly = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    const fromStamp = new Date(value);
    return Number.isNaN(fromStamp.getTime())
      ? null
      : fromStamp.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1]!;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
};

// The fields of a client record this check covers: the three operational
// facts the edit modal lets Leif state. `status` compares as itself; the
// two dates compare by day.
const FIELDS = ["start_date", "end_date", "status"] as const;
export type CheckedField = (typeof FIELDS)[number];

const readable = (value: string | null) => value ?? "empty";

const comparable = (field: CheckedField, record: Partial<Enrollment>) =>
  field === "status"
    ? ((record.status ?? null) as string | null)
    : dateOnly(record[field]);

export type SaveMismatch = {
  field: CheckedField;
  stated: string | null;
  saved: string | null;
};

export type SaveVerdict =
  | { kind: "saved" }
  // The write was accepted and the record still does not say what Leif
  // said. Not an error — nothing failed — which is precisely why it needs
  // its own outcome rather than being folded into either success or
  // failure.
  | { kind: "not-saved"; mismatches: SaveMismatch[] };

// `stated` is what the form submitted (after the modal's transform, so it
// is the shape actually sent). `saved` is the record the dataProvider
// returned — the server's own copy, not the form's hope.
//
// A field the owner did not state is not checked. Clearing a field IS a
// statement: stating null and getting null back is a save, and stating null
// and getting a date back is not.
export const assessEnrollmentSave = ({
  stated,
  saved,
}: {
  stated: Partial<Enrollment>;
  saved: Partial<Enrollment> | null | undefined;
}): SaveVerdict => {
  // No record came back at all. The provider may legitimately not return
  // one, and in that case there is nothing to verify — so this stays a
  // success rather than inventing a failure the CRM cannot see.
  if (saved == null) return { kind: "saved" };

  const mismatches = FIELDS.filter((field) => field in stated)
    .map((field) => ({
      field,
      stated: comparable(field, stated),
      saved: comparable(field, saved),
    }))
    .filter((check) => check.stated !== check.saved);

  return mismatches.length === 0
    ? { kind: "saved" }
    : { kind: "not-saved", mismatches };
};

// What Leif reads. Says what is true, names the field in his words, and
// does not pretend to know why — because the CRM does not know why.
const LABELS: Record<CheckedField, string> = {
  start_date: "start week",
  end_date: "finish date",
  status: "status",
};

export const saveOutcomeMessage = (verdict: SaveVerdict): string => {
  if (verdict.kind === "saved") return "Client updated";
  const named = verdict.mismatches
    .map((mismatch) => {
      const label = LABELS[mismatch.field];
      return mismatch.stated == null
        ? `${label} is still ${readable(mismatch.saved)}`
        : `${label} saved as ${readable(mismatch.saved)}, not ${mismatch.stated}`;
    })
    .join("; ");
  return `Not saved — ${named}. Try again, and tell Natasha if it keeps happening.`;
};
