import { execFileSync } from "node:child_process";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { coreApplicationQuestions } from "../src/components/atomic-crm/public-application/coreApplicationQuestions";

// Growing Yourself Up asks The Living Example's questions, proved on the real
// built forms.
//
// Read-only: this spec submits nothing, so it is safe in the ordinary
// projects. The write path — a real submission landing on the right offer and
// cohort, and an old application keeping the questions it was actually asked —
// is proved in applicationQuestionParity.submission.spec.ts, which cannot use
// resetDb at all (see playwright.config.ts).
//
// Why Leif asked for this: his GYU form asked four bare questions while LE
// asked five, each with a little description underneath, and the GYU
// applications came back short and low on information.

const DB_CONTAINER = "supabase_db_atomic-crm-e2e";
const COHORT = 996001;

const LE = coreApplicationQuestions("le");

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
      "-U",
      "postgres",
      "-d",
      "postgres",
    ],
    { encoding: "utf8", input: sql },
  ).trim();

// `cohorts` is reference data and is not emptied by resetDb, so this spec owns
// and clears its own.
const seedCohort = () =>
  psql(`
begin;
delete from public.cohorts where id = ${COHORT};
insert into public.cohorts (id, offer_id, name, status, applications_open_at, applications_close_at)
  select ${COHORT}, id, 'Growing Yourself Up — Parity Read', 'applications_open',
         '2026-01-01', '2027-12-31'
    from public.offers where name = 'Growing Yourself Up' and type = 'group';
commit;
`);

const clearCohort = () =>
  psql(`delete from public.cohorts where id = ${COHORT};`);

/**
 * Each question as the applicant meets it: its label, and the description
 * printed under it.
 *
 * helperText renders as a SIBLING <p> rather than inside the <label> — on
 * purpose, so the bold question and the muted helper keep their weights — so
 * the pair has to be read from the wrapper the two share.
 */
const questionsOf = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("label")].map((label) => {
      const text = (s: Element | null | undefined) =>
        (s?.textContent ?? "").replace(/\s+/g, " ").trim();
      return {
        label: text(label),
        // The wrapper holds the label and its description together.
        block: text(label.parentElement?.parentElement ?? label.parentElement),
      };
    }),
  );

test.describe("the two public application forms ask the same questions", () => {
  test.beforeEach(seedCohort);
  test.afterEach(clearCohort);

  test("same wording, same descriptions, same order, on both forms", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "chromium",
      "copy comparison needs one browser, not two",
    );

    const read = async (route: string) => {
      await page.goto(route);
      // These pages resolve their Offer through an Edge Function before they
      // render anything, which is slower than the default action timeout.
      await expect(page.getByLabel(/^First Name/)).toBeVisible({
        timeout: 20000,
      });
      return questionsOf(page);
    };

    const le = await read("/#/apply/living-example");
    const gyu = await read(`/#/apply/growing-yourself-up/${COHORT}`);

    for (const [index, question] of LE.entries()) {
      const label = String(question.label);
      const helper = question.helperText!;
      // Asked, AND described — the descriptions are the whole reason The
      // Living Example's answers came back richer.
      const asks = (questions: { label: string; block: string }[]) =>
        questions.some(
          (q) => q.label.includes(label) && q.block.includes(helper),
        );
      expect(
        asks(le),
        `LE asks question ${index + 1} with its description`,
      ).toBe(true);
      expect(
        asks(gyu),
        `GYU asks question ${index + 1} with its description`,
      ).toBe(true);
    }

    // Same order on both.
    const positions = (questions: { label: string }[]) =>
      LE.map((q) =>
        questions.findIndex((x) => x.label.includes(String(q.label))),
      );
    for (const labels of [le, gyu]) {
      const found = positions(labels);
      expect(found.every((p) => p >= 0)).toBe(true);
      for (let i = 1; i < found.length; i += 1) {
        expect(found[i]).toBeGreaterThan(found[i - 1]);
      }
    }

    // Requiredness: every substantive question is marked required on both.
    for (const questions of [le, gyu]) {
      for (const question of LE) {
        const found = questions.find((q) =>
          q.label.includes(String(question.label)),
        )!;
        expect(found.label, `required marker on "${question.key}"`).toContain(
          "*",
        );
      }
    }

    // The retired Growing Yourself Up questions are no longer asked.
    for (const retired of [
      "biggest challenge",
      "Why are you ready for support and change",
      "helps you create in your life and relationships",
    ]) {
      expect(
        gyu.some((q) => q.label.includes(retired)),
        `retired: ${retired}`,
      ).toBe(false);
    }

    // And GYU keeps its own programme identity around those shared questions.
    const body = await page.evaluate(() =>
      document.body.innerText.replace(/\s+/g, " "),
    );
    expect(body).toContain("Growing Yourself Up");
  });
});
