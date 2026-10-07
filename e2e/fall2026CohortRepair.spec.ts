import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// SYSTEM proof for the MAIN-only Fall 2026 cohort repair: real Postgres, the
// real migration, the real built app, a fresh browser context.
//
// The repair is MAIN-only, so no ordinary run applies it. This spec builds
// the production condition, runs the migration through psql exactly as a
// deploy would, then opens the built Applications page and reads what Leif
// would read: Fall 2026 holding the repaired records, and no "No cohort
// recorded" section left behind.
//
// The SQL-level proofs — population, idempotence, fail-loud on three broken
// premises, nothing else disturbed — live in
// scripts/historical-import/proveFall2026Repair.mjs. This file is only the
// last link: that the page agrees.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const DB_CONTAINER = "supabase_db_atomic-crm-e2e";
const MIGRATION =
  "supabase/migrations/20261007120000_fifty_one_applications_that_were_always_fall_2026.sql";
const TARGET_COUNT = 51;
const BASE = 993000;
const FALL = BASE + 1;
const JANUARY = BASE + 2;

const db = () =>
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
      "-U",
      "postgres",
      "-d",
      "postgres",
    ],
    { encoding: "utf8", input: sql },
  ).trim();

/**
 * The production condition: a closed Fall 2026, an open January 2027 with its
 * own applications, and 51 Growing Yourself Up applications carrying no
 * cohort on themselves or their Opportunity.
 *
 * raw_answers stays '{}' — a non-empty value materialises into
 * application_responses, which refuses DELETE even by cascade, so a fixture
 * that invents answers can never be torn down.
 */
const seed = async () => {
  // cohorts is not emptied by resetDb (it is reference data, not business
  // rows), so this spec owns and clears its own.
  // One transaction: under autocommit a temporary table declared ON COMMIT
  // DROP is destroyed the moment its own statement commits, so the inserts
  // below would not find it.
  psql(`
begin;
delete from public.applications where id >= ${BASE};
delete from public.deals where id >= ${BASE};
delete from public.contacts where id >= ${BASE};
delete from public.cohorts where id >= ${BASE};

create temporary table gyu on commit drop as
  select id from public.offers where name = 'Growing Yourself Up' and type = 'group';

insert into public.cohorts (id, offer_id, name, status)
  select ${FALL}, id, 'Growing Yourself Up — Fall 2026', 'completed' from gyu;
insert into public.cohorts (id, offer_id, name, status)
  select ${JANUARY}, id, 'Growing Yourself Up — January 2027', 'applications_open' from gyu;

insert into public.contacts (id, first_name, last_name, email_jsonb, phone_jsonb, tags, sales_eligibility, first_seen, last_seen)
  select ${BASE} + 100 + i, 'Cohortless', 'Applicant ' || i,
         jsonb_build_array(jsonb_build_object('email', 'repair' || i || '@example.com', 'type', 'Work')),
         '[]'::jsonb, '{}', 'normal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    from generate_series(1, ${TARGET_COUNT}) i;

insert into public.applications
  (id, contact_id, offer_id, intended_cohort_id, source, status, reviewed_at, submitted_at, raw_answers)
  select ${BASE} + 100 + i, ${BASE} + 100 + i, o.id, null, 'historical_import',
         case when i % 5 = 0 then 'approved' else 'pending' end,
         case when i % 5 = 0 then '2026-02-01T00:00:00Z'::timestamptz else null end,
         '2026-01-01T00:00:00Z', '{}'::jsonb
    from generate_series(1, ${TARGET_COUNT}) i, gyu o;

insert into public.contacts (id, first_name, last_name, email_jsonb, phone_jsonb, tags, sales_eligibility, first_seen, last_seen)
  select ${BASE} + 300 + i, 'January', 'Applicant ' || i,
         jsonb_build_array(jsonb_build_object('email', 'jan' || i || '@example.com', 'type', 'Work')),
         '[]'::jsonb, '{}', 'normal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    from generate_series(1, 3) i;
insert into public.applications
  (id, contact_id, offer_id, intended_cohort_id, source, status, submitted_at, raw_answers)
  select ${BASE} + 300 + i, ${BASE} + 300 + i, o.id, ${JANUARY}, 'historical_import',
         'pending', '2026-01-01T00:00:00Z', '{}'::jsonb
    from generate_series(1, 3) i, gyu o;
commit;
`);
};

const cohortless = () =>
  Number(
    psql(`
select count(*) from public.applications a
  join public.offers o on o.id = a.offer_id
  left join public.deals d on d.id = a.opportunity_id
 where o.name = 'Growing Yourself Up' and o.type = 'group'
   and a.intended_cohort_id is null
   and (a.opportunity_id is null or d.cohort_id is null);
`),
  );

type CreateSales = (sales: {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
}) => Promise<unknown>;

const signIn = async (page: Page, createSales: CreateSales) => {
  const email = `owner.repair.${Date.now()}@example.com`;
  await createSales({
    first_name: "Leif",
    last_name: "Owner",
    email,
    password: PASSWORD,
  });
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

test.afterEach(async () => {
  psql(`
delete from public.applications where id >= ${BASE};
delete from public.deals where id >= ${BASE};
delete from public.contacts where id >= ${BASE};
delete from public.cohorts where id >= ${BASE};
`);
  await db().from("offers").select("id").limit(1);
});

test.describe("the Fall 2026 cohort repair, end to end", () => {
  test("the Applications page files the repaired records under Fall 2026", async ({
    page,
    createSales,
  }) => {
    test.skip(
      test.info().project.name !== "chromium",
      "one browser is enough for a data-repair read-back",
    );

    await seed();
    expect(cohortless(), "the production condition is in place").toBe(
      TARGET_COUNT,
    );

    // Before: the page groups them as cohortless.
    await signIn(page, createSales);
    await page.goto("/#/applications");
    const gyu = page.locator(
      '[data-testid="application-programme"][data-programme="Growing Yourself Up"]',
    );
    await expect(gyu).toBeVisible();
    await expect(
      page.locator('[data-subsection="No cohort recorded"]'),
    ).toBeVisible();

    // Apply the real migration, exactly as a deploy would.
    psql(readFileSync(MIGRATION, "utf8"));
    expect(cohortless(), "nothing cohortless remains").toBe(0);

    // A FRESH browser context, so nothing is read from the first one's cache.
    const fresh = await page.context().browser()!.newContext();
    try {
      const page2 = await fresh.newPage();
      await signIn(page2, createSales);
      await page2.goto("/#/applications");

      const gyu2 = page2.locator(
        '[data-testid="application-programme"][data-programme="Growing Yourself Up"]',
      );
      await expect(gyu2).toBeVisible();

      // Fall 2026 is now a cohort subsection of Growing Yourself Up…
      const fall = page2.locator('[data-subsection="Fall 2026"]');
      await expect(fall).toBeVisible();
      expect(await gyu2.locator('[data-subsection="Fall 2026"]').count()).toBe(
        1,
      );

      // …holding all 51, by its own count.
      await expect(fall.getByText(String(TARGET_COUNT)).first()).toBeVisible();

      // …and "No cohort recorded" is gone.
      await expect(
        page2.locator('[data-subsection="No cohort recorded"]'),
      ).toHaveCount(0);

      // January 2027 is still its own cohort inside the same container,
      // untouched.
      const january = page2.locator('[data-subsection="January 2027"]');
      await expect(january).toBeVisible();
      expect(
        await gyu2.locator('[data-subsection="January 2027"]').count(),
      ).toBe(1);

      // Exactly one GYU container still, and one Copy link per real cohort —
      // the repair added no button and changed no URL.
      expect(
        await page2
          .locator(
            '[data-testid="application-programme"][data-programme="Growing Yourself Up"]',
          )
          .count(),
      ).toBe(1);
      const fallCopy = fall.getByRole("button", { name: /copy/i });
      await expect(fallCopy).toHaveCount(1);
    } finally {
      await fresh.close();
    }
  });
});
