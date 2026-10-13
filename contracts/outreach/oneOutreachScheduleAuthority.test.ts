import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// ONE SCHEDULE AUTHORITY.
//
// The failure this prevents is the one capacity already suffered (see
// contracts/capacity/oneCapacityAnswer.test.ts): a surface works the answer
// out for itself, and two parts of the app disagree. For outreach the
// disagreement would be a Day-10 reminder in the worker and a Day-10 badge
// in the UI drifting to different days, or a SQL expression keeping its own
// copy of the calendar.
//
// So the day offsets live in exactly one module, and the database stores
// only which schedule governs a row, the completed step, and the computed
// next_action_at.

const AUTHORITY =
  "src/components/atomic-crm/outreach/applicationOutreachSchedule.ts";

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === "__screenshots__") return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|sql)$/.test(path) ? [path] : [];
  });

const read = (path: string) => readFileSync(path, "utf8");

const SOURCES = [...walk("src"), ...walk("supabase"), ...walk("e2e")];

describe("the outreach calendar lives in one module", () => {
  test("the authority declares the offsets", () => {
    const source = read(AUTHORITY);
    expect(source).toMatch(/dayOffset: 3\b/);
    expect(source).toMatch(/dayOffset: 10\b/);
    expect(source).toMatch(/dayOffset: 24\b/);
    expect(source).toMatch(/dayOffset: 31\b/);
  });

  test("nothing else holds a day offset of its own", () => {
    const offenders = SOURCES.filter(
      (path) => path !== AUTHORITY && /dayOffset\s*:/.test(read(path)),
    );
    expect(offenders).toEqual([]);
  });

  // The declarative schema files hold the WHOLE schema, so "mentions
  // outreach" is not the same as "is about outreach" -- 02_functions.sql
  // legitimately contains an `interval '7 days'` belonging to contact
  // merging. So the outreach SQL is excerpted rather than matched whole.
  const outreachSqlExcerpts = (): Array<[string, string]> => {
    const excerpts: Array<[string, string]> = [];

    for (const path of SOURCES) {
      if (!path.startsWith("supabase/migrations/")) continue;
      const source = read(path);
      if (/application_outreach/.test(source)) excerpts.push([path, source]);
    }

    const tables = read("supabase/schemas/01_tables.sql");
    const block = tables.match(
      /create table if not exists public\.application_outreach_attempts \([\s\S]*?\n\);/,
    );
    expect(block, "the outreach table block in 01_tables.sql").not.toBeNull();
    excerpts.push(["01_tables.sql (outreach block)", block![0]!]);

    const functions = read("supabase/schemas/02_functions.sql");
    const guard = functions.match(
      /create or replace function public\.guard_outreach_attempt_mutation\(\)[\s\S]*?\n\$\$;/,
    );
    expect(guard, "the outreach guard in 02_functions.sql").not.toBeNull();
    excerpts.push(["02_functions.sql (guard)", guard![0]!]);

    return excerpts;
  };

  test("no SQL that owns outreach contains the calendar", () => {
    // The database stores which schedule governs the row and when the CRM
    // should next act. It never derives that date, because then there would
    // be two calendars.
    const excerpts = outreachSqlExcerpts();
    expect(excerpts.length).toBeGreaterThan(2);

    for (const [label, source] of excerpts) {
      // `interval '3 days'` and friends, in any spacing.
      expect(source, `${label} derives an outreach date in SQL`).not.toMatch(
        /interval\s*'(3|7|10|14|24|31)\s*day/i,
      );
      expect(source, `${label} holds a day offset`).not.toMatch(
        /dayOffset|day_offset/,
      );
    }
  });

  test("no component or worker recomputes a reminder date", () => {
    const offenders = SOURCES.filter((path) => {
      if (path === AUTHORITY) return false;
      const source = read(path);
      if (!/outreach/i.test(source)) return false;
      // Millisecond day arithmetic next to outreach: the shape of a second
      // calendar growing somewhere else.
      return /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
