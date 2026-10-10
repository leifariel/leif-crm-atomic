#!/usr/bin/env node
// Regenerates contracts/security/protectedFunctionGrants.json from a live
// database.
//
//   node scripts/protectedFunctionGrants.mjs            # print the live posture
//   node scripts/protectedFunctionGrants.mjs --write     # rewrite the snapshot
//   node scripts/protectedFunctionGrants.mjs --e2e       # read the e2e instance
//
// Everything it runs is read-only: the catalogs and has_function_privilege.
//
// WHY THIS EXISTS. Adding a parameter to a function means DROP and CREATE,
// and a newly created function starts with `proacl = NULL` — which in
// Postgres means EXECUTE TO PUBLIC. `enqueue_kit_operation` gained a
// parameter on 2026-10-10 and silently lost its revokes that way; the
// production preflight caught it and 20261010160000 restored them. Nothing
// would have caught it.
//
// So this pins TWO SETS, by class rather than by name:
//
//   internalOnly — SECURITY DEFINER, callable (not a trigger function), and
//     executable by NONE of anon / authenticated / service_role. These are
//     the functions only the database itself may call. A function that loses
//     its revokes DROPS OUT of this set, which is exactly the regression.
//
//   serviceRoleOnly — SECURITY DEFINER, callable, and executable by
//     service_role and nobody else. These are the internals an Edge
//     Function may reach and a browser may not. A function that loses its
//     service_role grant DROPS OUT (get_user_id_by_email did, and the users
//     recovery branch answered 500); one that gains PUBLIC or a browser role
//     drops out too.
//
//   publicExecutable — SECURITY DEFINER, callable, and executable by
//     PUBLIC. BOTH ways of getting there count: `proacl IS NULL`, the
//     default a freshly created function carries, and an explicit GRANT TO
//     PUBLIC, which leaves proacl non-null and is just as open. Checking
//     only the first would have missed the second.
//     That combination means anyone may call a function that runs as its
//     owner. It is deliberately NOT asserted to be empty: see the snapshot's
//     own note for the one entry that is there on purpose.
//
// Browser-callable RPCs are untouched by either set: they hold explicit
// grants, so they are neither internal-only nor NULL-ACL.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SNAPSHOT = path.join(
  REPO_ROOT,
  "contracts/security/protectedFunctionGrants.json",
);
const GRANTS = path.join(REPO_ROOT, "supabase/schemas/06_grants.sql");

// Every function signature 06_grants.sql names, exactly as written.
//
// A GRANT or REVOKE names ONE overload. Naming a signature that does not
// exist is not an error in Postgres and not a syntax problem here — it
// simply does nothing, leaving the real function on whatever ACL it was
// created with. That is how enqueue_kit_operation came to be described by a
// seven-argument revoke after it had become an eight-argument function.
//
// Asking the database to resolve each one (to_regprocedure) is exact, and
// needs no parsing of parameter declarations or normalising of type
// spellings.
const grantTargets = () => {
  const sql = readFileSync(GRANTS, "utf8");
  const found = new Set();
  const re = /on\s+function\s+(public\.[a-z0-9_]+\s*\([^)]*\))/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    found.add(m[1].replace(/\s+/g, " ").trim());
  }
  return [...found].sort();
};

// `prorettype <> 'trigger'` is what "callable" means here: a trigger
// function cannot be invoked as an RPC whatever its ACL says, so including
// them would bury the real finding under three dozen harmless rows.
const SQL = `
with callable as (
  select p.oid,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature,
         p.proacl,
         p.prosecdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prorettype <> 'trigger'::regtype
)
select jsonb_build_object(
  'internalOnly', coalesce((
    select jsonb_agg(signature order by signature)
      from callable c
     where c.prosecdef
       and not has_function_privilege('anon', c.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', c.oid, 'EXECUTE')
       and not has_function_privilege('service_role', c.oid, 'EXECUTE')),
    '[]'::jsonb),
  'serviceRoleOnly', coalesce((
    select jsonb_agg(signature order by signature)
      from callable c
     where c.prosecdef
       and has_function_privilege('service_role', c.oid, 'EXECUTE')
       and not has_function_privilege('anon', c.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', c.oid, 'EXECUTE')
       and not (c.proacl is null
                or exists (select 1 from aclexplode(c.proacl) a
                            where a.grantee = 0 and a.privilege_type = 'EXECUTE'))),
    '[]'::jsonb),
  'publicExecutable', coalesce((
    select jsonb_agg(signature order by signature)
      from callable c
     where c.prosecdef
       and (c.proacl is null
            or exists (select 1 from aclexplode(c.proacl) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE'))),
    '[]'::jsonb)
) as contract;`;

// Pull the JSON out of a command's stdout, and say something useful when
// there isn't any — the same failure mode, and the same fix, as
// salesCallSchemaContract.mjs documents at length.
const parseJsonFrom = (raw, what) => {
  const start = raw.indexOf("{");
  if (start !== -1) {
    try {
      return JSON.parse(raw.slice(start));
    } catch {
      /* fall through to the explicit failure below */
    }
  }
  throw new Error(
    `${what} produced no JSON on stdout. It printed:\n${raw.trim() || "(nothing)"}`,
  );
};

// The clean room is read through psql in its own container, not through
// `supabase db query` — the CLI is not a dependency, so its stdout format is
// not a contract. Same reasoning as salesCallSchemaContract.mjs.
const readLive = (useE2e, sql = SQL) => {
  if (useE2e) {
    const raw = execFileSync(
      "docker",
      [
        "exec",
        "-i",
        "supabase_db_atomic-crm-e2e",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-t",
        "-A",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ],
      { input: sql, encoding: "utf8", cwd: REPO_ROOT },
    );
    return parseJsonFrom(raw, "psql in the clean-room container");
  }

  const raw = execFileSync("npx", ["supabase", "db", "query", "--linked"], {
    input: SQL,
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return parseJsonFrom(raw, "supabase db query --linked").rows[0].contract;
};

const resolveSql = (targets) => `
select jsonb_build_object('unresolved', coalesce(jsonb_agg(sig order by sig), '[]'::jsonb)) as contract
  from (values ${targets.map((t) => "(" + quote(t) + ")").join(",")}) as v(sig)
 where to_regprocedure(sig) is null;`;

// Single-quote a SQL literal. These strings come from a file in this
// repository, not from input, but the signatures contain no quotes and a
// deliberate escape keeps it that way.
const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";

const useE2e = process.argv.includes("--e2e");
const live = readLive(useE2e);

const targets = grantTargets();
const unresolved =
  targets.length === 0
    ? []
    : (readLive(useE2e, resolveSql(targets)).unresolved ?? []);

const posture = {
  internalOnly: live.internalOnly ?? [],
  serviceRoleOnly: live.serviceRoleOnly ?? [],
  publicExecutable: live.publicExecutable ?? [],
  // Signatures 06_grants.sql names that no function in the database has.
  // Each one is a grant or revoke that silently does nothing.
  unresolvedGrantTargets: unresolved,
};

if (process.argv.includes("--write")) {
  const existing = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  writeFileSync(
    SNAPSHOT,
    JSON.stringify({ ...existing, ...posture }, null, 2) + "\n",
  );
  console.error(
    `wrote ${SNAPSHOT} from ${useE2e ? "the clean room" : "the linked project"}`,
  );
}

process.stdout.write(JSON.stringify(posture, null, 2) + "\n");
