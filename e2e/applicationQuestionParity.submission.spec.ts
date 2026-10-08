import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { coreApplicationQuestions } from "../src/components/atomic-crm/public-application/coreApplicationQuestions";

// SYSTEM proof of the public application WRITE path, after Growing Yourself Up
// adopted The Living Example's questions.
//
// NO resetDb, DELIBERATELY. This spec uses the base Playwright test rather than
// ./fixtures, because a submitted Application is permanent by design:
// materialize_native_application_responses() writes application_responses in
// the same transaction, and that table refuses DELETE even by cascade. A
// resetDb between these tests would throw "application_responses is an
// immutable submission record" — measured, twice. So the rows this spec creates
// are left in place, it creates its own owner instead of borrowing the
// fixture's, and playwright.config.ts runs this project LAST so nothing after
// it inherits an uncleanable database.
//
// What is proved: real built app -> real provider -> real Postgres -> submit
// LE -> submit GYU -> independent SQL read-back -> fresh browser read-back of
// a historical application.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const DB_CONTAINER = "supabase_db_atomic-crm-e2e";
const PASSWORD = "password";
const BASE = 997000;
const COHORT = BASE + 1;
const HISTORICAL = BASE + 50;

const LE = coreApplicationQuestions("le");
const GYU = coreApplicationQuestions("gyu");

const admin = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const psql = (sql: string) =>
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      DB_CONTAINER,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-t",
      "-A",
      "-F",
      "~",
      "-U",
      "postgres",
      "-d",
      "postgres",
    ],
    { encoding: "utf8", input: sql },
  ).trim();

/** This spec's own owner, since it cannot use the fixture that resets the DB. */
const createOwner = async () => {
  const email = `owner.submission.${Date.now()}@example.com`;
  const client = admin();
  const { data, error } = await client.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create owner: ${error.message}`);
  const updated = await client
    .from("sales")
    .update({ first_name: "Leif", last_name: "Owner", administrator: true })
    .eq("user_id", data.user!.id)
    .select("id")
    .single();
  if (updated.error) {
    throw new Error(`could not finish owner: ${updated.error.message}`);
  }
  return email;
};

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible({
    timeout: 20000,
  });
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Fill and submit one public application form. */
const submit = async (page: Page, route: string, who: string) => {
  await page.goto(route);
  // These pages resolve their Offer through an Edge Function before rendering,
  // which is slower than the default action timeout.
  await expect(page.getByLabel(/^First Name/)).toBeVisible({ timeout: 20000 });

  await page.getByLabel(/^First Name/).fill(who);
  await page.getByLabel(/^Last Name/).fill("Probe");
  await page
    .getByLabel(/^Email/)
    .fill(`${who.toLowerCase()}.submission.probe@example.com`);

  const questions = route.includes("living-example") ? LE : GYU;
  for (const [index, question] of questions.entries()) {
    await page
      .getByLabel(
        new RegExp(`^${escapeRegExp(String(question.label).slice(0, 30))}`),
      )
      .fill(`${who} answer ${index + 1}`);
  }

  await page.getByRole("button", { name: /submit|apply|send/i }).click();
};

/** The recorded questions and answers of one application, in order. */
const recorded = (applicationId: string) =>
  psql(`
select r.position || '~' || coalesce(r.question_key, '-') || '~' || r.question_text || '~' || coalesce(r.answer_text, '')
  from public.application_responses r
 where r.application_id = ${applicationId}
 order by r.position;
`)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("~"));

const applicationFor = (emailFragment: string) =>
  psql(`
select a.id || '~' || o.name || '~' || coalesce(a.intended_cohort_id::text, '-')
  from public.applications a
  join public.offers o on o.id = a.offer_id
  join public.contacts c on c.id = a.contact_id
 where c.email_jsonb::text like '%${emailFragment}%';
`).split("~");

test.describe.configure({ mode: "serial" });

test.describe("the public application write path", () => {
  test.beforeAll(() => {
    psql(`
begin;
delete from public.cohorts where id = ${COHORT};
insert into public.cohorts (id, offer_id, name, status, applications_open_at, applications_close_at)
  select ${COHORT}, id, 'Growing Yourself Up — Submission Round', 'applications_open',
         '2026-01-01', '2027-12-31'
    from public.offers where name = 'Growing Yourself Up' and type = 'group';
commit;
`);
  });

  test("a real Living Example submission lands on the Living Example offer", async ({
    page,
  }) => {
    await submit(page, "/#/apply/living-example", "Lee");

    // The row is the authority, not the thank-you screen.
    await expect
      .poll(() => applicationFor("lee.submission.probe")[1] ?? "", {
        timeout: 20000,
      })
      .toBe("The Living Example");

    const [id, offer, cohort] = applicationFor("lee.submission.probe");
    expect(offer).toBe("The Living Example");
    expect(cohort, "an individual offer carries no cohort").toBe("-");

    const rows = recorded(id);
    expect(rows, "one recorded question per asked question").toHaveLength(
      LE.length,
    );
    for (const [index, question] of LE.entries()) {
      expect(rows[index][1], `key ${index + 1}`).toBe(question.key);
      // The words recorded are the words asked.
      expect(rows[index][2], `wording ${index + 1}`).toBe(
        String(question.label),
      );
      expect(rows[index][3], `answer ${index + 1}`).toBe(
        `Lee answer ${index + 1}`,
      );
    }
  });

  test("a real Growing Yourself Up submission lands on GYU and its cohort", async ({
    page,
  }) => {
    await submit(page, `/#/apply/growing-yourself-up/${COHORT}`, "Gail");

    await expect
      .poll(() => applicationFor("gail.submission.probe")[1] ?? "", {
        timeout: 20000,
      })
      .toBe("Growing Yourself Up");

    const [id, offer, cohort] = applicationFor("gail.submission.probe");
    // PROGRAMME IDENTITY: same questions, still its own offer and cohort.
    expect(offer).toBe("Growing Yourself Up");
    expect(cohort, "the cohort from the route").toBe(String(COHORT));

    const rows = recorded(id);
    expect(rows).toHaveLength(GYU.length);
    for (const [index, question] of GYU.entries()) {
      // gyu_-prefixed, never le_: an answer reports its own programme.
      expect(rows[index][1], `key ${index + 1}`).toBe(question.key);
      expect(rows[index][1].startsWith("gyu_")).toBe(true);
      expect(rows[index][2], `wording ${index + 1}`).toBe(
        String(question.label),
      );
      expect(rows[index][3]).toBe(`Gail answer ${index + 1}`);
    }

    // Both submissions asked the SAME words while landing on different offers.
    const le = recorded(applicationFor("lee.submission.probe")[0]);
    expect(rows.map((r) => r[2])).toEqual(le.map((r) => r[2]));
  });

  test("an old Growing Yourself Up application keeps the questions it was actually asked", async ({
    page,
  }) => {
    // A historical submission, materialised through the REAL trigger against
    // the demoted version — the old form briefly current again, exactly as it
    // was on the day that applicant submitted.
    psql(`
begin;
update public.application_form_versions set is_current = false where form_key = 'gyu_application_core';
update public.application_form_versions set is_current = true  where form_key = 'gyu_application';

insert into public.contacts (id, first_name, last_name, email_jsonb, phone_jsonb, tags, sales_eligibility, first_seen, last_seen)
values (${HISTORICAL}, 'Olga', 'Historic',
        jsonb_build_array(jsonb_build_object('email','olga.submission.probe@example.com','type','Work')),
        '[]'::jsonb, '{}', 'normal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

insert into public.applications (id, contact_id, offer_id, intended_cohort_id, source, status, submitted_at, raw_answers)
select ${HISTORICAL}, ${HISTORICAL}, o.id, ${COHORT}, 'public_form', 'pending', '2026-03-01T00:00:00Z',
       jsonb_build_object(
         'gyu_biggest_challenge', 'Old answer one',
         'gyu_why_now', 'Old answer two',
         'gyu_hoped_outcome', 'Old answer three',
         'gyu_commitment_scale', 'Old answer four')
  from public.offers o where o.name = 'Growing Yourself Up' and o.type = 'group';

update public.application_form_versions set is_current = false where form_key = 'gyu_application';
update public.application_form_versions set is_current = true  where form_key = 'gyu_application_core';
commit;
`);

    // It recorded the FOUR questions it was asked, in its own wording.
    const rows = recorded(String(HISTORICAL));
    expect(rows, "four questions, not five").toHaveLength(4);
    expect(rows.map((r) => r[1])).toEqual([
      "gyu_biggest_challenge",
      "gyu_why_now",
      "gyu_hoped_outcome",
      "gyu_commitment_scale",
    ]);
    expect(rows[0][2]).toContain("biggest challenge");
    expect(rows[3][2]).toContain("On a scale from 1–10");
    expect(rows.map((r) => r[3])).toEqual([
      "Old answer one",
      "Old answer two",
      "Old answer three",
      "Old answer four",
    ]);

    // And the review page shows exactly that, in a fresh browser context.
    const email = await createOwner();
    await signIn(page, email);
    await page.goto(`/#/applications/${HISTORICAL}/show`);
    await expect(page.getByText("Old answer one")).toBeVisible({
      timeout: 20000,
    });

    const body = await page.evaluate(() =>
      document.body.innerText.replace(/\s+/g, " "),
    );
    // Each answer rendered exactly once — no duplicates.
    for (const answer of [
      "Old answer one",
      "Old answer two",
      "Old answer three",
      "Old answer four",
    ]) {
      expect(body.split(answer).length - 1, answer).toBe(1);
    }
    // Its own old wording is what is shown.
    expect(body).toContain("biggest challenge");
    // And NOT the new questions, which this applicant never saw.
    for (const neverAsked of [
      "What have you already tried to change or shift this?",
      "How are you hoping I will support you?",
    ]) {
      expect(body, neverAsked).not.toContain(neverAsked);
    }
  });
});
