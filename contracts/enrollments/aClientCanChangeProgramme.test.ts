import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Jenna Smith's Opportunity said The Living Example and her onboarding said
// Growing Yourself Up, three minutes apart. Both writes were correct: the sale
// seeded GYU's checklist while she was still GYU, and then the offer was
// changed through the ordinary edit form, which reconciles nothing downstream
// because there was no such thing as changing programmes.
//
// These are contract tests over the files that now have to agree: the offer of
// an enrolled client is not a field, there is exactly one authority that can
// move it, and it moves everything together.

const read = (path: string) => readFileSync(path, "utf8");

// Comments in these files necessarily quote the thing being banned, so the
// structural rules below match against code only.
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");

const MIGRATION = read(
  "supabase/migrations/20260926010000_a_client_can_change_programme.sql",
);
const TRANSFER = read(
  "src/components/atomic-crm/enrollments/transferClientOffer.ts",
);
const ACTION = read(
  "src/components/atomic-crm/enrollments/MoveClientProgrammeAction.tsx",
);
const INPUTS = read("src/components/atomic-crm/deals/DealInputs.tsx");
const ASSESS = read(
  "src/components/atomic-crm/enrollments/assessOnboarding.ts",
);
const BOOKED = read(
  "src/components/atomic-crm/sales-calls/salesCallBookedProgramme.ts",
);

describe("the offer of an enrolled client is not a field", () => {
  test("the database refuses an ordinary client-role offer edit", () => {
    expect(MIGRATION).toMatch(
      /new\.offer_id is distinct from old\.offer_id[\s\S]{0,200}current_user in \('anon', 'authenticated'\)[\s\S]{0,200}exists \(select 1 from enrollments/,
    );
    expect(MIGRATION).toMatch(
      /transfer_enrolled_opportunity_offer\(\) rather than editing the offer/,
    );
  });

  test("the boundary is an Enrollment existing, not the stage", () => {
    // Won without a client has nothing downstream to go stale, so an ordinary
    // edit stays correct there — and the transfer refuses it, saying so.
    expect(MIGRATION).toMatch(
      /exists \(select 1 from enrollments where opportunity_id = new\.id\)/,
    );
    expect(MIGRATION).toMatch(/'status', 'no-enrollment'/);
    expect(code(INPUTS)).toMatch(/hasClient/);
    expect(code(INPUTS)).toMatch(/filter: \{ opportunity_id: record\?\.id \}/);
  });

  test("the edit form stops offering what the database refuses", () => {
    // Offering it would only produce an error the owner cannot act on.
    const stripped = code(INPUTS);
    const start = stripped.indexOf("hasClient ? (");
    const readOnlyBranch = stripped.slice(
      start,
      stripped.indexOf(") : (", start),
    );
    // The enrolled branch shows the programme and offers no way to change it.
    expect(readOnlyBranch).toMatch(/offer_name_snapshot|selectedOffer/);
    expect(readOnlyBranch).not.toMatch(/ReferenceInput/);
    expect(readOnlyBranch).not.toMatch(/source="offer_id"/);
    // The other branch is the pre-Enrollment case, which stays editable.
    expect(stripped.slice(stripped.indexOf(") : (", start))).toMatch(
      /source="offer_id"/,
    );
  });
});

describe("one authority moves a client, and it moves everything", () => {
  test("the primitive exists and is the only granted route", () => {
    expect(MIGRATION).toMatch(
      /create or replace function public\.transfer_enrolled_opportunity_offer/,
    );
    expect(MIGRATION).toMatch(
      /grant execute on function public\.transfer_enrolled_opportunity_offer\(bigint, bigint, text\) to authenticated/,
    );
    expect(MIGRATION).toMatch(
      /revoke all on function public\.transfer_enrolled_opportunity_offer\(bigint, bigint, text\) from anon/,
    );
  });

  test("it decides by stable key, never by label", () => {
    // curriculum_access exists in both programmes and means a different
    // resource in each, which is exactly why the label cannot be the identity.
    expect(MIGRATION).toMatch(/t\.key = i\.requirement_key/);
    expect(code(TRANSFER)).toMatch(/requirement_key/);
    expect(code(TRANSFER)).toMatch(/targetKeys/);
  });

  test("nothing is deleted: obsolete work is retired", () => {
    expect(MIGRATION).toMatch(/status = 'retired'/);
    expect(MIGRATION).toMatch(/retired_at = now\(\)/);
    expect(MIGRATION).not.toMatch(/delete from enrollment_onboarding_items/);
    expect(code(TRANSFER)).not.toMatch(/dataProvider\.delete/);
  });

  test("a retired requirement is neither progress nor work", () => {
    // Filtered once, at the single reader every surface already goes through.
    expect(code(ASSESS)).toMatch(/status !== "retired"/);
    expect(MIGRATION).toMatch(/and status <> 'retired'/);
    expect(MIGRATION).toMatch(/i\.status <> 'retired'::text/);
  });

  test("a cancelled Task is not a finished one", () => {
    // The two projections point at each other: retiring cancels the Task, and
    // closing a Task marks the requirement done. Together they turned "we are
    // not doing this" into "somebody did this".
    expect(MIGRATION).toMatch(
      /create or replace function public\.sync_onboarding_item_from_task/,
    );
    expect(MIGRATION).toMatch(/new\.status = 'completed'/);
    expect(MIGRATION).toMatch(/status not in \('done', 'retired'\)/);
    // And cancelling records when it closed, which the constraint demands.
    expect(MIGRATION).toMatch(/done_date = coalesce\(done_date, now\(\)\)/);
  });

  test("the history that did not exist is written, once", () => {
    expect(MIGRATION).toMatch(
      /create table if not exists public\.deal_offer_events/,
    );
    expect(MIGRATION).toMatch(/insert into deal_offer_events/);
    // Readable by the app, written only by the function that runs as owner.
    expect(MIGRATION).toMatch(
      /revoke insert, update, delete on public\.deal_offer_events from authenticated/,
    );
    // A replay writes no second event, because it returns before writing.
    expect(MIGRATION).toMatch(/'status', 'already-on-offer'/);
  });

  test("historical facts are left alone", () => {
    // The Application stays on the programme she applied to, and the guard
    // that used to forbid that now accepts a transfer as the explanation.
    expect(MIGRATION).toMatch(
      /create or replace function public\.enforce_application_opportunity_agreement/,
    );
    expect(MIGRATION).toMatch(/from deal_offer_events ev/);
    expect(MIGRATION).not.toMatch(/update applications\s+set offer_id/);
    expect(code(TRANSFER)).not.toMatch(/"applications"/);
    expect(code(TRANSFER)).not.toMatch(/"sales_calls"/);
  });
});

describe("the preview promises exactly what the transfer does", () => {
  test("it is computed from the same keys, not written twice", () => {
    // The preview lives in the same module as the transfer it previews, on
    // the same stable keys, so the dialog cannot grow a second opinion about
    // what is about to happen.
    expect(code(TRANSFER)).toMatch(/export const describePlan/);
    expect(code(TRANSFER)).toMatch(/requirement_key/);
    expect(code(ACTION)).toMatch(/describePlan/);
    expect(code(ACTION)).not.toMatch(/export const describePlan/);
    expect(code(ACTION)).toMatch(
      /retire .* and cancel their pending tasks|retire \$\{/,
    );
  });

  test("it asks before it acts", () => {
    expect(code(ACTION)).toMatch(/Yes — move to/);
    expect(code(ACTION)).toMatch(/Cancel/);
  });

  test("it never picks a round for a group programme", () => {
    expect(code(ACTION)).toMatch(/offer\.type === "individual"/);
    expect(MIGRATION).toMatch(/'status', 'needs-cohort'/);
  });
});

describe("booked for is derived, not stored", () => {
  test("from the Acuity appointment type, through the Offer", () => {
    expect(code(BOOKED)).toMatch(/acuity_appointment_type_id/);
    // No new column anywhere for this.
    expect(MIGRATION).not.toMatch(/booked_offer_id|original_offer_id/);
  });

  test("and only said when it differs from what was sold", () => {
    expect(code(BOOKED)).toMatch(/sold\.name === bookedFor/);
  });
});

describe("migration ordering", () => {
  test("it sorts after the chain it extends, and before the reserved slot", () => {
    const mine = "20260926010000_a_client_can_change_programme.sql";
    const names = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(names).toContain(mine);
    expect(names.filter((f) => f < mine)).toContain(
      "20260925120000_a_sale_is_accepted_not_paid_for.sql",
    );
    // Deliberately early in the day. The Application Form Builder work that
    // is parked locally carries a 2026092609xxxx migration, so this repair
    // can deploy first without either one being renumbered. That file is not
    // committed, so nothing here asserts it exists — only that this slice
    // leaves room for it.
    expect(mine < "20260926090000").toBe(true);
  });
});
