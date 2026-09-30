import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// CRM account creation is owner/admin controlled. Public self-registration is
// forbidden.
//
// This is not a preference. On 2026-09-30 production was found with signup
// OPEN, while `authenticated` held `GRANT ALL` on deals, applications,
// contact_notes, tasks, enrollments and sales, and every RLS policy read
// `USING (true) WITH CHECK (true)`. Anyone who signed up and confirmed an
// email could therefore read and write every client record through PostgREST
// without ever loading the app — `administrator` is an application flag the
// database does not enforce, and handle_new_user() gates nobody.
//
// Signup was closed in production the same day. This guard exists so the
// repository cannot put it back: `supabase config push` writes every property
// this file DECLARES, so a `true` here is one command away from reopening the
// hole.
//
// The deeper debt — narrowing the authenticated role and making RLS mean
// something — is tracked in HANDOFF and deliberately NOT attempted here.

const CONFIG = readFileSync("supabase/config.toml", "utf8");

// Every `enable_signup` in the file, with the section it belongs to.
const signupSettings = (): Array<{ section: string; value: string }> => {
  const out: Array<{ section: string; value: string }> = [];
  let section = "(root)";
  for (const line of CONFIG.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) {
      section = header[1];
      continue;
    }
    const setting = line.match(/^\s*enable_signup\s*=\s*(\S+)/);
    if (setting) out.push({ section, value: setting[1] });
  }
  return out;
};

describe("public signup is forbidden", () => {
  test("every enable_signup in the Supabase config is false", () => {
    const settings = signupSettings();
    // If this drops to zero the assertion below becomes vacuous, which is how
    // a guard quietly stops guarding.
    expect(settings.length).toBeGreaterThanOrEqual(3);
    for (const { section, value } of settings) {
      expect(
        value,
        `[${section}].enable_signup must be false — public self-registration is forbidden`,
      ).toBe("false");
    }
  });

  test("the rule is stated where somebody would change it", () => {
    expect(CONFIG).toMatch(/PUBLIC SELF-REGISTRATION IS FORBIDDEN/);
  });

  test("nothing in CI pushes auth configuration", () => {
    // Production auth is managed out of band. If a workflow ever starts
    // pushing this file, the local-development values in it (site_url of
    // localhost, email confirmations off, db major_version 15) would land on
    // production — so that has to be a deliberate, reviewed change.
    const workflows = ["deploy.yml", "check.yml"]
      .map((file) => {
        try {
          return readFileSync(`.github/workflows/${file}`, "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    expect(workflows).not.toMatch(/supabase\s+config\s+push/);
  });
});
