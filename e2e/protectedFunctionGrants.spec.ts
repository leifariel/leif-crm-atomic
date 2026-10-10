import { execFileSync } from "node:child_process";

import { expect, test } from "./fixtures";

import pinned from "../contracts/security/protectedFunctionGrants.json" with { type: "json" };

// WHO MAY EXECUTE WHAT, HELD BY CLASS RATHER THAN BY NAME.
//
// THE BUG THIS EXISTS FOR. Adding a parameter to a function means DROP and
// CREATE, and a created function starts with `proacl = NULL` — which in
// Postgres means EXECUTE TO PUBLIC. `enqueue_kit_operation` gained
// `p_waitlist_invitation_id` on 2026-10-10 and silently lost its revokes
// that way. A production preflight query happened to catch it; nothing in
// the repository would have.
//
// It is worse than it sounds, because a GRANT or REVOKE names ONE overload.
// `06_grants.sql` went on revoking the SEVEN-argument signature after the
// function had become an eight-argument one — which is not an error in
// Postgres and not a syntax problem in review. It simply does nothing.
//
// So three things are pinned here, against the real database the migration
// chain builds, not against the declaration:
//
//   1. every signature 06_grants.sql names resolves to a real function
//   2. the internal-only set is exactly what it was
//   3. nothing new is SECURITY DEFINER and PUBLIC-executable
//
// A function that loses its revokes DROPS OUT of (2) and usually appears in
// (3), so the regression shows up twice.

type Posture = {
  internalOnly: string[];
  serviceRoleOnly: string[];
  publicExecutable: string[];
  unresolvedGrantTargets: string[];
};

const USERS_LOOKUP = "get_user_id_by_email(email text)";
const ENQUEUE =
  "enqueue_kit_operation(p_contact_id bigint, p_application_id bigint, p_kind text, p_origin text, p_kit_tag_id bigint, p_kit_tag_name text, p_requested_by text, p_waitlist_invitation_id bigint)";

const regenerate =
  "If that is intended, regenerate it with `node scripts/protectedFunctionGrants.mjs --e2e --write`, read the diff, and be sure the new posture is the one you meant.";

test.describe("protected function grants", () => {
  let live: Posture;

  test.beforeAll(() => {
    live = JSON.parse(
      execFileSync("node", ["scripts/protectedFunctionGrants.mjs", "--e2e"], {
        encoding: "utf8",
        cwd: process.cwd(),
      }),
    ) as Posture;
  });

  test("every grant and revoke in 06_grants.sql names a function that exists", () => {
    // A signature nothing answers to is a revoke that does nothing. This is
    // the check that would have caught the seven-argument revoke.
    expect(
      live.unresolvedGrantTargets,
      "06_grants.sql names function signatures that no function in the database has, so those grants and revokes do nothing.",
    ).toEqual([]);
  });

  test("the internal-only functions are exactly the ones pinned", () => {
    expect(live.internalOnly.sort(), regenerate).toEqual(
      [...pinned.internalOnly].sort(),
    );
  });

  test("enqueue_kit_operation is executable by nobody but the database", () => {
    // Named explicitly as well as pinned by set, because this is the one
    // that actually went wrong: it writes a Kit tag operation for any
    // contact and any tag, so anon, authenticated and service_role must all
    // be refused.
    expect(
      live.internalOnly,
      "enqueue_kit_operation is no longer internal-only. anon, authenticated or service_role can now execute it.",
    ).toContain(ENQUEUE);
  });

  test("the service_role-only functions are exactly the ones pinned", () => {
    expect(live.serviceRoleOnly.sort(), regenerate).toEqual(
      [...pinned.serviceRoleOnly].sort(),
    );
  });

  test("get_user_id_by_email is callable by service_role and nobody else", () => {
    // Named as well as pinned by set, because this one actually went wrong:
    // nothing ever granted service_role, production held only
    // {postgres=X/postgres}, and the users Edge Function's recovery branch —
    // the one that fires when an auth account already exists — answered 500
    // instead of looking the id up. 20261010210000 states the posture rather
    // than inheriting it from ALTER DEFAULT PRIVILEGES.
    expect(
      live.serviceRoleOnly,
      "get_user_id_by_email is no longer service_role-only: either service_role lost EXECUTE (the users recovery branch 500s again) or a browser role gained it.",
    ).toContain(USERS_LOOKUP);
    // And it is NOT reachable any other way.
    expect(live.publicExecutable).not.toContain(USERS_LOOKUP);
    expect(live.internalOnly).not.toContain(USERS_LOOKUP);
  });

  test("nothing new is SECURITY DEFINER and executable by the public", () => {
    // Not asserted empty: see the snapshot's own note. Asserted UNCHANGED,
    // so a new one has to be looked at.
    expect(live.publicExecutable.sort(), regenerate).toEqual(
      [...pinned.publicExecutable].sort(),
    );
  });
});
