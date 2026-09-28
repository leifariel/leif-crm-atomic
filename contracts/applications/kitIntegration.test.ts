import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// Kit applies tags to real people, and a tag fires an email sequence Leif
// wrote. There is no "oops" that unsends one. So the things that decide WHICH
// tag, for WHOM, and WHETHER AT ALL are pinned here, against the repository's
// own text, where a later edit has to argue with a named assertion rather than
// slip past a green suite.

const read = (file: string) => readFileSync(file, "utf8");

// Comments say the credential's NAME all over this integration, on purpose —
// that is how the next reader learns where it lives. What must not exist is
// code that reaches for it outside the Edge Function, so the source scans
// below look at code only.
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");

const MIGRATION = read(
  "supabase/migrations/20260928200000_an_application_reaches_kit.sql",
);
const CLIENT = read("supabase/functions/_shared/kit.ts");
const PROCESSOR = read("supabase/functions/kit_sync/kitSyncProcessor.ts");
const FUNCTION = read("supabase/functions/kit_sync/index.ts");
const GRANTS = read("supabase/schemas/06_grants.sql");
const POLICIES = read("supabase/schemas/05_policies.sql");

// Leif's real tags, given in the resolved Kit contract. These numbers reach
// live automations; they are not placeholders and must never be edited to
// make a test pass.
const TAGS: Array<[number, string, string]> = [
  [1, "applicant", "24082722"],
  [1, "approved", "21784073"],
  [1, "needs_higher_care", "24082725"],
  [1, "not_fit", "21784076"],
  [2, "applicant", "24082724"],
  [2, "approved", "21481248"],
  [2, "needs_higher_care", "24082732"],
  [2, "not_fit", "21481382"],
];

describe("the tag mapping is exactly the one Leif gave", () => {
  test.each(TAGS)("offer %i / %s is tag %s", (offerId, event, tagId) => {
    const row = new RegExp(
      `\\(\\s*${offerId},\\s*'${event}',\\s*${tagId},\\s*'[A-Za-z_-]+'\\s*\\)`,
    );
    expect(MIGRATION).toMatch(row);
  });

  test("the programme names are Kit's own, MiniDD and GYU", () => {
    expect(MIGRATION).toContain("'MiniDD_Applicant'");
    expect(MIGRATION).toContain("'MiniDD_Approved'");
    expect(MIGRATION).toContain("'MiniDD_NeedsHigherCare'");
    expect(MIGRATION).toContain("'MiniDD_Denied'");
    expect(MIGRATION).toContain("'GYU-Applicant'");
    expect(MIGRATION).toContain("'GYU-Approved'");
    expect(MIGRATION).toContain("'GYU-NeedsHigherCare'");
    expect(MIGRATION).toContain("'GYU-Denied'");
  });

  test("an unmapped programme is refused, never guessed", () => {
    // enqueue_kit_application_sync looks the tag up and returns null when the
    // mapping is absent. There is no fallback, no default and no nearest
    // match anywhere in that function.
    const fn = MIGRATION.slice(
      MIGRATION.indexOf("function public.enqueue_kit_application_sync"),
    );
    expect(fn).toMatch(/if not found then[\s\S]*?return null;/);
    expect(fn).not.toMatch(/coalesce\(\s*v_tag/);
  });

  test("only these four events can be tagged at all", () => {
    expect(MIGRATION).toMatch(
      /check \(event in \('applicant', 'approved', 'needs_higher_care', 'not_fit'\)\)/,
    );
  });
});

describe("Do Not Engage stays inside the CRM", () => {
  test("it has no Kit tag, and the migration asserts that itself", () => {
    expect(MIGRATION).not.toMatch(/'do_not_engage',\s*\d/);
    expect(MIGRATION).toContain("Do Not Engage has a Kit tag; it must not");
  });

  test("the decision trigger does not name it", () => {
    const fn = MIGRATION.slice(
      MIGRATION.indexOf("function public.enqueue_kit_application_decision"),
    );
    const body = fn.slice(0, fn.indexOf("$$;"));
    expect(body).toMatch(
      /new\.status in \('approved', 'needs_higher_care', 'not_fit'\)/,
    );
    expect(body).not.toContain("do_not_engage");
  });

  test("a receipt that is already refused enqueues nothing", () => {
    const fn = MIGRATION.slice(
      MIGRATION.indexOf("function public.enqueue_kit_application_receipt"),
    );
    const body = fn.slice(0, fn.indexOf("$$;"));
    expect(body).toMatch(/if new\.status = 'pending' then/);
  });

  test("nothing anywhere unsubscribes or removes Kit state", () => {
    for (const source of [CLIENT, PROCESSOR, FUNCTION]) {
      expect(source.toLowerCase()).not.toContain("unsubscribe");
      expect(source).not.toMatch(/method:\s*"DELETE"/);
      expect(source).not.toMatch(/removeTag|deleteTag|untag/);
    }
  });
});

describe("tagging is additive", () => {
  test("no path removes the applicant tag when a decision tag is added", () => {
    expect(MIGRATION).not.toMatch(/delete from kit_sync_operations/i);
    expect(MIGRATION).toContain(
      "the applicant tag was removed; tagging is additive",
    );
  });
});

describe("deploying this emails nobody", () => {
  test("the boundary is the moment of deployment, not a date somebody typed", () => {
    expect(MIGRATION).toMatch(
      /insert into public\.kit_integration_settings \(id, not_before\)\s*\nvalues \(1, now\(\)\)/,
    );
  });

  test("an application older than the boundary is never enqueued", () => {
    const fn = MIGRATION.slice(
      MIGRATION.indexOf("function public.enqueue_kit_application_sync"),
    );
    expect(fn).toMatch(/v_app\.created_at < v_not_before/);
    // Missing settings fail closed rather than treating everything as new.
    expect(fn).toMatch(/v_not_before is null or/);
  });

  test("origin, not status, decides eligibility", () => {
    const fn = MIGRATION.slice(
      MIGRATION.indexOf("function public.enqueue_kit_application_sync"),
    );
    expect(fn).toMatch(/v_app\.source not in \('public_form', 'manual'\)/);
    // The 98 historical rows that sit at 'pending' are exactly why status is
    // not the criterion.
    expect(fn).not.toMatch(/v_app\.status = 'pending'/);
  });

  test("the migration proves, rather than promises, that it backfilled nothing", () => {
    expect(MIGRATION).toMatch(
      /select count\(\*\) INTO v_would_backfill FROM applications WHERE created_at >= v_not_before/i,
    );
    expect(MIGRATION).toContain("deploying the integration created Kit work");
  });

  test("there is no automatic historical reconciliation anywhere", () => {
    expect(MIGRATION).not.toMatch(
      /insert into kit_sync_operations\s*\n?\s*select/i,
    );
    expect(FUNCTION).not.toMatch(/backfill|reconcile/i);
  });
});

describe("the credential is server-side, and only server-side", () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(full) ? [full] : [];
    });

  test("no code under src/ reaches for the key, by that name or any other", () => {
    const offenders = sourceFiles("src").filter((file) => {
      const body = code(read(file));
      return (
        body.includes("KIT_API_KEY") ||
        /import\.meta\.env[^\n]*KIT/i.test(body) ||
        /process\.env[^\n]*KIT/i.test(body)
      );
    });
    expect(offenders).toEqual([]);
  });

  test("it is never exposed through a VITE_ variable", () => {
    for (const file of [
      ".env.example",
      ".env.development",
      ".env.e2e",
      "supabase/config.toml",
    ]) {
      expect(read(file)).not.toMatch(/VITE_KIT/i);
    }
    expect(FUNCTION).not.toMatch(/VITE_/);
  });

  test("only the Edge Function reads it, and it fails closed without it", () => {
    expect(FUNCTION).toMatch(/Deno\.env\.get\("KIT_API_KEY"\)/);
    expect(FUNCTION).toMatch(/if \(!apiKey\)/);
    // Checked before anything is claimed, so a missing key burns no attempts.
    const runProcessor = FUNCTION.slice(
      FUNCTION.indexOf("const runProcessor"),
      FUNCTION.indexOf("const notConfigured"),
    );
    expect(runProcessor.indexOf('Deno.env.get("KIT_API_KEY")')).toBeLessThan(
      runProcessor.indexOf("await processKitSyncOperations"),
    );
  });

  test("the client takes the key as an argument and never reads an environment", () => {
    expect(CLIENT).not.toMatch(/Deno\.env/);
    expect(CLIENT).not.toMatch(/process\.env/);
    expect(CLIENT).toMatch(/X-Kit-Api-Key/);
  });

  test("nothing logs the key, and every stored reason is redacted first", () => {
    expect(CLIENT).toMatch(/redactKey\(/);
    expect(CLIENT).not.toMatch(/console\.(log|error|warn)\([^)]*apiKey/);
  });
});

describe("a browser cannot name a Kit tag", () => {
  test("the operations table is read-only to authenticated, and closed to anon", () => {
    expect(GRANTS).toMatch(
      /revoke all on public\.kit_sync_operations from anon;/,
    );
    expect(GRANTS).toMatch(
      /grant select on public\.kit_sync_operations to authenticated;/,
    );
    expect(GRANTS).not.toMatch(
      /grant (insert|update|delete)[^\n]*public\.kit_sync_operations to authenticated/,
    );
    expect(POLICIES).toContain("No insert/update/delete policy exists");
  });

  test("the enqueue is internal — not even service_role may call it", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(GRANTS).toContain(
        `revoke all on function public.enqueue_kit_application_sync(bigint, text, text) from ${role};`,
      );
    }
    expect(GRANTS).not.toMatch(
      /grant execute on function public\.enqueue_kit_application_sync/,
    );
  });

  test("retry and claim belong to the Edge Function alone", () => {
    for (const fn of [
      "retry_kit_application_sync(bigint)",
      "claim_kit_sync_operations(integer)",
    ]) {
      expect(GRANTS).toContain(
        `revoke all on function public.${fn} from authenticated;`,
      );
      expect(GRANTS).toContain(
        `grant execute on function public.${fn} to service_role;`,
      );
    }
  });

  test("the public submission path cannot reach any of it", () => {
    const publicApplication = read(
      "supabase/functions/public_application/index.ts",
    );
    expect(publicApplication).not.toMatch(/kit/i);
    // And retry refuses anything that is not a signed-in user, before it
    // looks at an application id.
    expect(FUNCTION).toMatch(/Retry requires a signed-in user/);
    expect(FUNCTION.indexOf("Retry requires a signed-in user")).toBeLessThan(
      FUNCTION.indexOf("applicationId is required"),
    );
  });

  test("retry can only re-queue failed work, never invent or undo any", () => {
    const fn = MIGRATION.slice(
      MIGRATION.indexOf("function public.retry_kit_application_sync"),
    );
    const body = fn.slice(0, fn.indexOf("$$;"));
    expect(body).toMatch(/and status = 'failed'/);
    expect(body).not.toMatch(/insert into/i);
    expect(body).not.toMatch(/kit_tag_id/);
  });
});

describe("a bad minute at Kit does not become a person's problem", () => {
  test("only the three transient classes are ever retried automatically", () => {
    // A wrong key and a refusal Kit will repeat identically are not worth
    // asking again; "too fast", "Kit is down" and "Kit could not be reached"
    // are exactly what the next pass fixes.
    expect(PROCESSOR).toMatch(
      /TRANSIENT[^=]*=\s*new Set\(\[\s*"rate_limited",\s*"provider_unavailable",\s*"network",\s*\]\)/,
    );
    expect(PROCESSOR).not.toMatch(/TRANSIENT[\s\S]{0,120}"auth"/);
    expect(PROCESSOR).not.toMatch(/TRANSIENT[\s\S]{0,120}"rejected"/);
  });

  test("retrying is bounded, so a real outage still reaches Leif", () => {
    expect(PROCESSOR).toMatch(/MAX_TRANSIENT_ATTEMPTS = \d+/);
    expect(PROCESSOR).toMatch(
      /TRANSIENT\.has\(failureClass\) && attempts < MAX_TRANSIENT_ATTEMPTS/,
    );
  });

  test("a requeued operation goes back to pending with no failure timestamp", () => {
    expect(FUNCTION).toMatch(/status: requeue \? "pending" : "failed"/);
    expect(FUNCTION).toMatch(/failed_at: requeue \? null : now/);
    // The class and reason are still written either way — what happened stays
    // legible even while it is being retried.
    expect(FUNCTION).toMatch(/failure_class: failureClass/);
  });
});

describe("the CRM applies tags and nothing else", () => {
  test("no form, sequence, automation or broadcast is ever called", () => {
    for (const source of [CLIENT, PROCESSOR, FUNCTION]) {
      expect(source).not.toMatch(/v4\/forms/);
      expect(source).not.toMatch(/v4\/sequences/);
      expect(source).not.toMatch(/v4\/broadcasts/);
    }
    expect(CLIENT).toContain("/subscribers");
    expect(CLIENT).toContain("/tags/${tagId}/subscribers");
  });

  test("a Kit failure cannot touch the CRM's own truth", () => {
    // The processor only ever writes to kit_sync_operations, through the two
    // mark* callbacks, and to record_external_identity.
    expect(PROCESSOR).not.toMatch(/"applications"|'applications'/);
    expect(PROCESSOR).not.toMatch(/"deals"|'deals'/);
    expect(PROCESSOR).not.toMatch(/"tasks"|'tasks'/);
    expect(FUNCTION).not.toMatch(/from\("applications"\)/);
    expect(FUNCTION).not.toMatch(/from\("deals"\)/);
  });
});
