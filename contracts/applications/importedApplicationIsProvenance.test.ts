import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// `historical_import` is PROVENANCE. It says how a record arrived. It has
// never said when it belongs to, and reading it as a lifecycle is what left a
// live January 2027 applicant on a page that could not record a decision
// about her.
//
// Two things must stay true however this slice is edited later:
//
//   provenance is never rewritten — adopting somebody must not turn their
//   answers into something Leif is claimed to have typed;
//
//   adoption touches no provider — no subscriber, no tag, no automation, no
//   email. Kit stays manual for imported people, and that is structural here
//   rather than remembered.

const read = (file: string) => readFileSync(file, "utf8");

const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)(--|\/\/).*$/, ""))
    .join("\n");

const MIGRATION = read(
  "supabase/migrations/20260930120000_an_imported_application_can_be_current_work.sql",
);
const KIT_MIGRATION = read(
  "supabase/migrations/20260928200000_an_application_reaches_kit.sql",
);
const ACTION = read(
  "src/components/atomic-crm/applications/adoptApplication.ts",
);
const ELIGIBILITY = read(
  "src/components/atomic-crm/applications/applicationAdoption.ts",
);
const STATUS = read("src/components/atomic-crm/applications/kitStatus.ts");
const QUEUE = read("src/components/atomic-crm/dashboard/useKitWorkQueue.ts");
const MANIFEST = JSON.parse(read("supabase/migrations/replay-manifest.json"));

// The AUTHORITY only — never the proof block below it, which deliberately
// mutates its own fixtures (a source rewritten to 'public_form', a status set
// to 'waitlist') to prove each of those is refused. Scanning the whole file
// would read those fixtures as the function doing the thing it forbids.
const AUTHORITY = (() => {
  const body = code(MIGRATION);
  const start = body.indexOf(
    "create or replace function public.adopt_imported_application",
  );
  const end = body.indexOf("$function$;", start);
  expect(start, "the authority should exist").toBeGreaterThan(-1);
  expect(end, "the authority should be dollar-quoted").toBeGreaterThan(start);
  return body.slice(start, end);
})();

describe("adoption never rewrites provenance", () => {
  test("the authority never assigns applications.source", () => {
    // Every write it makes, listed. `source` is not among them and must not
    // become so: rewriting it to 'manual' would claim Leif typed answers the
    // applicant wrote herself.
    const writes = AUTHORITY.match(/UPDATE applications[\s\S]*?WHERE/gi);
    expect(writes, "the authority should update applications").toBeTruthy();
    for (const write of writes ?? []) {
      expect(write).not.toMatch(/\bsource\s*=/i);
      expect(write).not.toMatch(/\braw_answers\s*=/i);
      expect(write).not.toMatch(/\bsubmitted_at\s*=/i);
      expect(write).not.toMatch(/\bintended_cohort_id\s*=/i);
    }
  });

  test("the authority never assigns a status or a review time", () => {
    const body = AUTHORITY;
    // A decision is Leif's to make afterwards, through the ordinary review
    // path. Adoption must never record one, nor invent when one happened.
    expect(body).not.toMatch(/UPDATE applications[\s\S]{0,400}?\bstatus\s*=/i);
    expect(body).not.toMatch(
      /UPDATE applications[\s\S]{0,400}?\breviewed_at\s*=/i,
    );
  });

  test("only a proven status mapping is adoptable", () => {
    expect(ELIGIBILITY).toMatch(/ADOPTABLE_STATUSES = \["pending"\]/);
    // Old vocabulary is refused, never translated into a modern outcome.
    expect(AUTHORITY).toMatch(/'status-unsupported'/);
  });
});

describe("adoption reaches no provider", () => {
  test("the authority creates no Kit work", () => {
    const body = AUTHORITY;
    expect(body).not.toMatch(/insert\s+into\s+kit_sync_operations/i);
    expect(body).not.toMatch(/enqueue_kit_/i);
    expect(body).not.toMatch(/request_kit_manual_tag/i);
  });

  test("the browser action calls nothing that could reach Kit", () => {
    const body = code(ACTION);
    expect(body).not.toMatch(/kit/i);
  });

  test("the Kit receipt trigger cannot fire on an update", () => {
    // Adoption only ever UPDATEs an application. This is why that is safe,
    // and it is asserted against the Kit migration's own text so a later
    // change to the trigger has to argue with this test.
    expect(KIT_MIGRATION).toMatch(
      /create trigger on_application_kit_receipt\s+after insert on public\.applications/,
    );
  });

  test("the Kit decision trigger cannot fire without a status change", () => {
    expect(KIT_MIGRATION).toMatch(
      /create trigger on_application_kit_decision[\s\S]*?after update of status on public\.applications[\s\S]*?when \(old\.status is distinct from new\.status\)/,
    );
  });
});

describe("an adopted import is manual Kit work, never automatic", () => {
  test("kitStatus treats adoption as operational, not as a source", () => {
    // Provenance alone still cannot make something operational — otherwise 99
    // old questionnaires would appear in a Kit queue.
    expect(STATUS).toMatch(/crm_adopted_at != null/);
    expect(STATUS).toMatch(/TERMINAL_SOURCES\.includes\(application\.source\)/);
  });

  test("the Dashboard queue uses the same rule", () => {
    expect(QUEUE).toMatch(/crm_adopted_at != null/);
  });

  test("automatic mode still requires an automatic operation", () => {
    // An adopted import has none — its receipt was never Kit-managed — so it
    // can never read as Kit-handled without one.
    expect(STATUS).toMatch(/if \(automatic\.length > 0\)/);
  });
});

describe("the authority is safe to replay", () => {
  test("it is deterministic, and rebuilds from empty", () => {
    const listed = (MANIFEST.main_only ?? MANIFEST.mainOnly ?? []).map(
      (entry: unknown) =>
        typeof entry === "string"
          ? entry
          : (entry as { version: string }).version,
    );
    expect(listed).not.toContain("20260930120000");
  });

  test("it takes an advisory lock and re-reads under it", () => {
    const body = AUTHORITY;
    expect(body).toMatch(/pg_advisory_xact_lock/);
    // Two clicks must not both read "no Opportunity" and both create one.
    const lockAt = body.indexOf("pg_advisory_xact_lock");
    expect(body.slice(lockAt)).toMatch(
      /SELECT \* INTO v_app FROM applications/,
    );
  });

  test("it refuses rather than opening a second live opportunity", () => {
    const body = AUTHORITY;
    expect(body).toMatch(/'other-active-sale'/);
    expect(body).toMatch(/'later-stage'/);
    expect(body).toMatch(/'ambiguous-opportunity'/);
    expect(body).toMatch(/deal_is_active/);
  });
});
