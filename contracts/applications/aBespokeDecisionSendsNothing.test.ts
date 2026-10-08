import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Two decisions that reach real people, and the one thing neither may do.
//
// A BESPOKE decision exists so Leif can answer somebody personally. If it ever
// applied a tag an email automation hangs off, the person would get the
// standard letter AND her personal one — and there is no "oops" that unsends
// the first. So the separation is pinned here, against the repository's own
// text, where a later edit has to argue with a named assertion rather than
// slip past a green suite.
//
// OFFERING THE OTHER PROGRAMME must leave the Application saying what it
// always said. The Opportunity moves; the application, its round, its
// questions, its answers and its submitted_at do not.

const read = (file: string) => readFileSync(file, "utf8");

// Comments in this integration say out loud what the CRM may never CLAIM —
// "it may never say the email was sent" — so a scan for forbidden claims has
// to look at code, not prose.
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");

const MIGRATION = read(
  "supabase/migrations/20261008140000_a_decision_can_recommend_the_other_programme.sql",
);
const RISK = read(
  "src/components/atomic-crm/applications/kitAutomationRisk.ts",
);
const REVIEW = read(
  "src/components/atomic-crm/applications/reviewApplication.ts",
);
const TABLES = read("supabase/schemas/01_tables.sql");
const ELIGIBILITY = read(
  "src/components/atomic-crm/cohorts/cohortEligibility.ts",
);
const PUBLIC_CONTEXT = read(
  "src/components/atomic-crm/public-application/publicOfferContext.ts",
);
const GRANTS = read("supabase/schemas/06_grants.sql");

describe("a bespoke decision cannot send the standard email", () => {
  test("each new decision has its OWN Kit event, so no approval or rejection tag is reachable", () => {
    for (const event of [
      "offered_other_programme",
      "bespoke_accepted",
      "bespoke_rejected",
    ]) {
      expect(MIGRATION).toContain(`'${event}'`);
      expect(TABLES).toContain(`'${event}'`);
    }
    // The decision trigger passes the status straight through as the event, so
    // there is no mapping step where a bespoke decision could be translated
    // into 'approved'.
    expect(MIGRATION).toContain(
      "perform public.enqueue_kit_application_sync(new.id, 'decision', new.status)",
    );
    expect(MIGRATION).not.toMatch(
      /bespoke_accepted[^\n]*=>[^\n]*approved|'bespoke_accepted',\s*'approved'/,
    );
  });

  test("a bespoke mapping may not claim a Kit automation, by constraint and not by convention", () => {
    expect(MIGRATION).toContain("kit_tag_mappings_bespoke_is_manual_check");
    expect(MIGRATION).toContain("or followup_mode = 'manual_email'");
    expect(TABLES).toContain("kit_tag_mappings_bespoke_is_manual_check");
    // And it is SET rather than left to be remembered.
    expect(MIGRATION).toContain("enforce_bespoke_kit_separation");
    expect(MIGRATION).toContain("new.followup_mode := 'manual_email'");
    expect(MIGRATION).toContain("new.automation_name := null");
  });

  test("a bespoke decision cannot share a tag with the decisions that send", () => {
    // Forcing followup_mode says what the CRM will TELL Leif. It does not stop
    // the TAG being the one an approval automation hangs off — mapping
    // bespoke_accepted to MiniDD_Approved would send the standard letter to
    // somebody she meant to answer personally, while followup_mode sat there
    // reading "manual_email".
    //
    // Kit's topology is unreadable from here, so this refuses what the CRM CAN
    // see: a shared tag within one programme. Both directions, so the order the
    // two mappings are configured in cannot decide whether the rule holds.
    expect(MIGRATION).toContain(
      "v_sending constant text[] := array['approved', 'not_fit', 'offered_other_programme']",
    );
    expect(MIGRATION).toContain("so a bespoke decision cannot use it");
    expect(MIGRATION).toContain("so it cannot also be the % tag");
    // And the readable refusal on the only door Leif goes through.
    expect(MIGRATION).toContain("'tag-already-used-by-another-decision'");
  });

  test("the risk layer reports bespoke as answered by hand and claims nothing about Kit", () => {
    expect(RISK).toContain('"answered-by-hand"');
    expect(RISK).toContain(
      "A bespoke decision sends no automatic reply — this response is yours to write.",
    );
    // It may say what the CRM did. It may never say an email went out.
    expect(code(RISK)).not.toMatch(/email (was|has been) sent|we emailed/i);
  });

  test("Do Not Engage still has no Kit event at all", () => {
    const eventCheck = MIGRATION.slice(
      MIGRATION.indexOf("kit_tag_mappings_event_check"),
    ).slice(0, 600);
    expect(eventCheck).not.toContain("do_not_engage");
  });
});

describe("a recommendation moves the sale and never the application", () => {
  test("the Application's own facts are not in any UPDATE the decision performs", () => {
    const body = MIGRATION.slice(
      MIGRATION.indexOf("UPDATE applications"),
      MIGRATION.indexOf("-- 3. The Review Application task"),
    );
    // The only columns a decision writes on the Application.
    expect(body).toContain("SET status = p_outcome");
    expect(body).toContain("reviewed_at = v_reviewed_at");
    expect(body).toContain("recommended_offer_id = v_recommended_offer_id");
    // Never these.
    for (const column of [
      "offer_id =",
      "intended_cohort_id",
      "raw_answers",
      "submitted_at",
      "source =",
    ]) {
      expect(
        body.includes(`applications\n     SET ${column}`) ||
          new RegExp(
            `UPDATE applications[\\s\\S]{0,400}?${column.replace("(", "\\(")}`,
          ).test(
            body.replace("recommended_offer_id = v_recommended_offer_id", ""),
          ),
      ).toBe(false);
    }
  });

  test("it moves the SAME Opportunity — nothing anywhere creates a second one", () => {
    expect(MIGRATION).not.toMatch(/insert\s+into\s+deals/i);
    expect(REVIEW).not.toMatch(/dataProvider\.create\(\s*"deals"/);
  });

  test("the destination is resolved, never guessed, and refuses when it is not obvious", () => {
    expect(MIGRATION).toContain("'recommendation-ambiguous'");
    expect(MIGRATION).toContain(
      "FROM offers WHERE is_active AND id IS DISTINCT FROM v_deal.offer_id",
    );
    expect(REVIEW).toContain('"recommendation-ambiguous"');
  });

  test("every refusal is checked before the first write", () => {
    const beforeFirstWrite = MIGRATION.slice(
      0,
      MIGRATION.indexOf("UPDATE applications"),
    );
    for (const refusal of [
      "'recommendation-ambiguous'",
      "'already-enrolled'",
      "'scholarship-held'",
    ]) {
      expect(beforeFirstWrite).toContain(refusal);
    }
  });

  test("the programme change is written by the database, not by a browser", () => {
    // deal_offer_events stays closed to authenticated — forging offer history
    // is how an Application's disagreement with its Opportunity could be made
    // to look legal.
    expect(GRANTS).toContain(
      "revoke insert, update, delete on public.deal_offer_events from authenticated",
    );
    expect(MIGRATION).toContain("record_recommended_programme_change");
    expect(MIGRATION).toContain("security definer");
    // And that SECURITY DEFINER body is not callable by anybody.
    expect(MIGRATION).toContain(
      "revoke all on function public.record_recommended_programme_change() from authenticated",
    );
    expect(GRANTS).toContain(
      "revoke all on function public.record_recommended_programme_change() from authenticated",
    );
  });

  test("a recommendation and a recommended programme can only exist together", () => {
    expect(MIGRATION).toContain("applications_recommended_offer_agrees_check");
    expect(MIGRATION).toContain(
      "(status = 'offered_other_programme') = (recommended_offer_id is not null)",
    );
    expect(TABLES).toContain("applications_recommended_offer_agrees_check");
  });

  test("the two programme-change authorities stay disjoint", () => {
    // transfer_enrolled_opportunity_offer() requires an Enrollment; this
    // refuses to run alongside one. So neither can write the other's history.
    expect(MIGRATION).toContain(
      "if exists (select 1 from enrollments where opportunity_id = new.id) then",
    );
    expect(MIGRATION).toContain("'already-enrolled'");
  });
});

describe("a recommendation into a group programme needs a round", () => {
  test("none of the three cohort refusals can happen after a write", () => {
    const beforeFirstWrite = MIGRATION.slice(
      0,
      MIGRATION.indexOf("UPDATE applications"),
    );
    for (const refusal of [
      "'no-eligible-cohort'",
      "'cohort-choice-required'",
      "'cohort-invalid'",
    ]) {
      expect(beforeFirstWrite).toContain(refusal);
    }
  });

  test("the round comes from the resolver, never from the Opportunity being moved", () => {
    // The first version wrote `cohort_id = case when group then cohort_id end`,
    // which carried the LE Opportunity's own (null) round into Growing
    // Yourself Up and left a group sale with no round.
    const dealUpdate = MIGRATION.slice(
      MIGRATION.indexOf("SET offer_id = v_recommended_offer_id"),
    ).slice(0, 700);
    expect(dealUpdate).toContain("cohort_id = v_destination_cohort_id");
    expect(dealUpdate).not.toContain("THEN cohort_id ELSE");
  });

  test("nothing infers a round: it is assigned only when there is exactly one", () => {
    const branch = MIGRATION.slice(
      MIGRATION.indexOf("IF v_recommended.type = 'group' THEN"),
    ).slice(0, 2600);
    expect(branch).toContain("IF v_eligible_cohorts = 0 THEN");
    expect(branch).toContain("ELSIF v_eligible_cohorts = 1 THEN");
    expect(branch).toContain("'cohort-choice-required'");
    // A chosen round is still checked against the programme AND against still
    // being open, so a stale tab cannot place somebody in a closed round.
    expect(branch).toContain(
      "FROM public.offer_accepting_cohorts(v_recommended_offer_id) c",
    );
    expect(branch).toContain("WHERE c.id = p_cohort_id");
  });

  test("eligibility is ONE rule with one home per language", () => {
    // SQL.
    expect(MIGRATION).toContain(
      "create or replace function public.offer_accepting_cohorts(p_offer_id bigint)",
    );
    expect(MIGRATION).toContain("c.status = 'applications_open'");
    expect(MIGRATION).toContain("(now() at time zone 'America/Denver')::date");
    // TypeScript — and the public form now shares it rather than holding a
    // second copy that would eventually disagree.
    expect(ELIGIBILITY).toContain("export const isCohortAcceptingApplications");
    expect(PUBLIC_CONTEXT).toContain("isCohortAcceptingApplications(cohort)");
    expect(PUBLIC_CONTEXT).not.toContain(
      'cohort.status === "applications_open"',
    );
  });

  test("a recommendation never rewrites the round the applicant asked for", () => {
    const appUpdate = MIGRATION.slice(
      MIGRATION.indexOf("UPDATE applications"),
      MIGRATION.indexOf("-- 2. The Opportunity, aligned with it."),
    );
    expect(appUpdate).not.toContain("intended_cohort_id");
  });
});

describe("the decisions Leif already had are unchanged", () => {
  test("approve, needs higher care, not fit and do not engage keep their exact shapes", () => {
    expect(MIGRATION).toContain(
      "IF p_outcome = 'approved' THEN\n    -- \"Qualified enough for a sales call\"",
    );
    expect(MIGRATION).toContain(
      "UPDATE deals SET stage = 'approved', outcome = NULL WHERE id = v_deal.id;",
    );
    expect(MIGRATION).toContain(
      "UPDATE deals SET outcome = 'needs_higher_care' WHERE id = v_deal.id;",
    );
    expect(MIGRATION).toContain(
      "UPDATE deals SET outcome = 'not_fit' WHERE id = v_deal.id;",
    );
    expect(MIGRATION).toContain(
      "UPDATE deals SET outcome = 'lost', owner_decision = 'do_not_engage' WHERE id = v_deal.id;",
    );
    expect(MIGRATION).toContain(
      "UPDATE contacts SET sales_eligibility = 'do_not_engage' WHERE id = v_app.contact_id;",
    );
  });

  test("review_application keeps invoker rights, so it gains no privilege it did not have", () => {
    const fn = MIGRATION.slice(
      MIGRATION.indexOf(
        "create or replace function public.review_application(",
      ),
      MIGRATION.indexOf("declare\n  v_app applications%rowtype;"),
    );
    expect(fn).toContain("language plpgsql");
    expect(fn).not.toContain("security definer");
  });

  test("the review queue is not taught a new vocabulary — it still asks the same two questions", () => {
    // Everything new leaves Needs Review because it sets a status that is not
    // 'pending' and stamps reviewed_at. Nothing had to learn the new names.
    const CLASSIFY = read(
      "src/components/atomic-crm/applications/classifyApplication.ts",
    );
    expect(CLASSIFY).not.toContain("offered_other_programme");
    expect(CLASSIFY).not.toContain("bespoke_");
    const VIEWS = read("supabase/schemas/03_views.sql");
    const awaiting = VIEWS.slice(
      VIEWS.indexOf("applications_awaiting_review"),
    ).slice(0, 1200);
    expect(awaiting).toContain("a.status = 'pending'");
  });
});
