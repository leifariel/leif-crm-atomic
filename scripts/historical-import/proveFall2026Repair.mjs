// Production-shaped proof for the MAIN-only Fall 2026 cohort repair.
//
// The repair is MAIN-only, so the clean room never applies it and no e2e run
// would ever exercise it. This script builds the production condition in the
// clean room's real Postgres — 51 cohortless Growing Yourself Up
// applications, a closed Fall 2026 cohort, an untouched January 2027, and
// Living Example rows alongside — applies the migration, then reads the
// result back with independent SQL rather than trusting the migration's own
// assertions.
//
// raw_answers is {} throughout, deliberately: a non-empty value
// materialises into application_responses, which is an immutable submission
// record that refuses DELETE even by cascade, so a fixture that invents
// answers can never be rebuilt. The migration asserts the answers checksum
// against production rows that do have them; here the checksum is still
// compared, it is just comparing {}.
//
// It then proves the thing that matters more than the happy path: that the
// migration REFUSES rather than guessing. Three premises are broken one at a
// time (a 50-row population, a target that already names another cohort, and
// an applications_open Fall 2026) and each must stop it.
//
// Run against a started clean room: make start-e2e-ci && node
// scripts/historical-import/proveFall2026Repair.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_CONTAINER = "supabase_db_atomic-crm-e2e";
const MIGRATION = resolve(
  REPO_ROOT,
  "supabase/migrations/20261007120000_fifty_one_applications_that_were_always_fall_2026.sql",
);
const TARGET_COUNT = 51;
const BASE = 992000;

const psql = (sql, { expectFailure = false } = {}) => {
  try {
    const out = execFileSync(
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
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        input: sql,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (expectFailure) {
      throw new Error(
        "expected this statement to be refused, but it succeeded",
      );
    }
    return out.trim();
  } catch (error) {
    if (expectFailure) return String(error.stderr ?? error.message);
    process.stderr.write(String(error.stderr ?? ""));
    throw error;
  }
};

const one = (sql) => psql(sql);

const check = (label, actual, expected) => {
  if (String(actual) !== String(expected)) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
  process.stdout.write(`  ok  ${label} = ${actual}` + "\n");
};

/**
 * Rebuild the production condition from scratch. Everything this script
 * creates is namespaced from BASE so it cannot collide with the clean room's
 * own seed or with any e2e fixture.
 */
const buildFixture = () => {
  psql(`
begin;

delete from public.applications where id >= ${BASE};
delete from public.deals where id >= ${BASE};
delete from public.contacts where id >= ${BASE};
delete from public.cohorts where id >= ${BASE};

-- The canonical group offer already exists in the clean room; find it rather
-- than inventing a second one, exactly as the migration does.
create temporary table fixture_offer on commit drop as
  select id from public.offers where name = 'Growing Yourself Up' and type = 'group';

-- A CLOSED Fall 2026 and an OPEN January 2027, which is the real shape: the
-- round being repaired into is over, the next one is taking applications.
insert into public.cohorts (id, offer_id, name, status)
select ${BASE} + 1, id, 'Growing Yourself Up — Fall 2026', 'completed' from fixture_offer;
insert into public.cohorts (id, offer_id, name, status)
select ${BASE} + 2, id, 'Growing Yourself Up — January 2027', 'applications_open' from fixture_offer;

-- ${TARGET_COUNT} cohortless GYU applications, deliberately mixed across the
-- buckets the page files them into, because the repair must preserve each
-- one's existing classification. A third carry an Opportunity with NO
-- cohort, which is the other half of why they render cohortless.
insert into public.contacts (id, first_name, last_name, email_jsonb, phone_jsonb, tags, sales_eligibility, first_seen, last_seen)
select ${BASE} + 100 + i, 'Cohortless', 'Applicant ' || i,
       jsonb_build_array(jsonb_build_object('email', 'cohortless' || i || '@example.com', 'type', 'Work')),
       '[]'::jsonb, '{}', 'normal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
  from generate_series(1, ${TARGET_COUNT}) i;

insert into public.deals (id, name, contact_id, offer_id, stage, amount, index, created_at, updated_at, stage_entered_at)
select ${BASE} + 100 + i, 'Cohortless deal ' || i, ${BASE} + 100 + i, o.id,
       'application_received', 1400, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
  from generate_series(1, ${TARGET_COUNT}) i, fixture_offer o
 where i % 3 = 0;

insert into public.applications
  (id, contact_id, opportunity_id, offer_id, intended_cohort_id, source, status, reviewed_at, submitted_at, raw_answers)
select ${BASE} + 100 + i,
       ${BASE} + 100 + i,
       case when i % 3 = 0 then ${BASE} + 100 + i else null end,
       o.id,
       null,
       'historical_import',
       case when i % 5 = 0 then 'approved' else 'pending' end,
       case when i % 5 = 0 then '2026-02-01T00:00:00Z'::timestamptz else null end,
       '2026-01-01T00:00:00Z',
       '{}'::jsonb
  from generate_series(1, ${TARGET_COUNT}) i, fixture_offer o;

-- January 2027 applications, which must not move.
insert into public.contacts (id, first_name, last_name, email_jsonb, phone_jsonb, tags, sales_eligibility, first_seen, last_seen)
select ${BASE} + 300 + i, 'January', 'Applicant ' || i,
       jsonb_build_array(jsonb_build_object('email', 'january' || i || '@example.com', 'type', 'Work')),
       '[]'::jsonb, '{}', 'normal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
  from generate_series(1, 4) i;
insert into public.applications
  (id, contact_id, offer_id, intended_cohort_id, source, status, submitted_at, raw_answers)
select ${BASE} + 300 + i, ${BASE} + 300 + i, o.id, ${BASE} + 2,
       'historical_import', 'pending', '2026-01-01T00:00:00Z', '{}'::jsonb
  from generate_series(1, 4) i, fixture_offer o;

-- And Living Example applications, which must not be touched either.
insert into public.contacts (id, first_name, last_name, email_jsonb, phone_jsonb, tags, sales_eligibility, first_seen, last_seen)
select ${BASE} + 500 + i, 'Living', 'Applicant ' || i,
       jsonb_build_array(jsonb_build_object('email', 'living' || i || '@example.com', 'type', 'Work')),
       '[]'::jsonb, '{}', 'normal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
  from generate_series(1, 3) i;
insert into public.applications
  (id, contact_id, offer_id, source, status, submitted_at, raw_answers)
select ${BASE} + 500 + i, ${BASE} + 500 + i, o.id, 'manual', 'pending',
       '2026-01-01T00:00:00Z', '{}'::jsonb
  from generate_series(1, 3) i, public.offers o
 where o.type = 'individual'
 limit 3;

commit;
`);
};

const cohortlessCount = () =>
  one(`
select count(*) from public.applications a
  join public.offers o on o.id = a.offer_id
  left join public.deals d on d.id = a.opportunity_id
 where o.name = 'Growing Yourself Up' and o.type = 'group'
   and a.intended_cohort_id is null
   and (a.opportunity_id is null or d.cohort_id is null);
`);

const migrationSql = readFileSync(MIGRATION, "utf8");

process.stdout.write("Building the production-shaped fixture…" + "\n");
buildFixture();
check("cohortless GYU applications before", cohortlessCount(), TARGET_COUNT);

// A fingerprint taken INDEPENDENTLY of the migration's own, so the read-back
// is not just the migration agreeing with itself.
const bucketFingerprint = () =>
  one(`
select md5(string_agg(a.id || ':' || a.status || ':' || coalesce(a.reviewed_at::text,'-') || ':' || a.source, ',' order by a.id))
  from public.applications a where a.id between ${BASE + 101} and ${BASE + 100 + TARGET_COUNT};
`);
const answersFingerprint = () =>
  one(`
select md5(string_agg(a.raw_answers::text, ',' order by a.id))
  from public.applications a where a.id between ${BASE + 101} and ${BASE + 100 + TARGET_COUNT};
`);
const beforeBuckets = bucketFingerprint();
const beforeAnswers = answersFingerprint();
const beforeJanuary = one(
  `select count(*) from public.applications where intended_cohort_id = ${BASE + 2};`,
);
const beforeLe = one(`
select count(*) from public.applications a join public.offers o on o.id = a.offer_id
 where o.type = 'individual';
`);

process.stdout.write("Applying the repair…" + "\n");
psql(migrationSql);

process.stdout.write("Reading back independently…" + "\n");
check("cohortless GYU applications after", cohortlessCount(), 0);
check(
  "targets now naming Fall 2026",
  one(
    `select count(*) from public.applications where intended_cohort_id = ${BASE + 1} and id between ${BASE + 101} and ${BASE + 100 + TARGET_COUNT};`,
  ),
  TARGET_COUNT,
);
check(
  "statuses / decisions / sources unchanged",
  bucketFingerprint(),
  beforeBuckets,
);
check("submitted answers unchanged", answersFingerprint(), beforeAnswers);
check(
  "January 2027 unchanged",
  one(
    `select count(*) from public.applications where intended_cohort_id = ${BASE + 2};`,
  ),
  beforeJanuary,
);
check(
  "Living Example unchanged",
  one(
    `select count(*) from public.applications a join public.offers o on o.id = a.offer_id where o.type = 'individual';`,
  ),
  beforeLe,
);
check(
  "no linked Opportunity gained a cohort",
  one(
    `select count(*) from public.deals where id between ${BASE + 101} and ${BASE + 100 + TARGET_COUNT} and cohort_id is not null;`,
  ),
  0,
);
// The buckets themselves: a pending historical_import target must NOT have
// become review work, which is only possible if Fall 2026 were open.
check(
  "Fall 2026 is not applications_open",
  one(`select status from public.cohorts where id = ${BASE + 1};`),
  "completed",
);

process.stdout.write("Re-running (idempotence)…" + "\n");
psql(migrationSql);
check("still zero cohortless", cohortlessCount(), 0);
check("still exactly the same targets", bucketFingerprint(), beforeBuckets);

process.stdout.write("Proving it refuses a broken premise…" + "\n");
const refusals = [
  {
    label: "a 50-row population",
    setup: `update public.applications set intended_cohort_id = ${BASE + 1} where id = ${BASE + 101};`,
    expect: /expected exactly 51 cohortless/i,
  },
  {
    label: "a target that already names another cohort",
    setup: `update public.applications set intended_cohort_id = ${BASE + 2} where id = ${BASE + 102};`,
    expect: /expected exactly 51 cohortless/i,
  },
  {
    label: "an applications_open Fall 2026",
    setup: `update public.cohorts set status = 'applications_open' where id = ${BASE + 1};`,
    expect: /still applications_open/i,
  },
];

for (const { label, setup, expect } of refusals) {
  buildFixture();
  psql(setup);
  const stderr = psql(migrationSql, { expectFailure: true });
  if (!expect.test(stderr)) {
    throw new Error(
      `${label}: refused, but not for the expected reason:\n${stderr}`,
    );
  }
  process.stdout.write(`  ok  refuses ${label}` + "\n");
}

// Tear down. The fixture cohorts in particular must not survive: a second
// "Fall 2026" under Growing Yourself Up is exactly the ambiguity the
// migration refuses, so leaving one behind would break every later run —
// which is how this script first discovered its own guard working.
process.stdout.write("Tearing the fixture down…" + "\n");
psql(`
delete from public.applications where id >= ${BASE};
delete from public.deals where id >= ${BASE};
delete from public.contacts where id >= ${BASE};
delete from public.cohorts where id >= ${BASE};
`);
check(
  "fixture cohorts removed",
  one(`select count(*) from public.cohorts where id >= ${BASE};`),
  0,
);

process.stdout.write("\nALL PROOFS PASSED" + "\n");
