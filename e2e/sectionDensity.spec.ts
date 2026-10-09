import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// A round's page says how many, and shows a few.
//
// Leif opens a Growing Yourself Up round to answer one question. The page
// used to render every row of every section on the way there — every
// application the round has ever received, then the whole waitlist — and
// the Cohort Details he scrolled for sat underneath all of it.
//
// Run in the built app against real Postgres because the claim is about a
// page that is genuinely long: the collapse, the count in the heading, and
// the expansion surviving a RELOAD (the state lives in the admin store, so
// only a real browser can show that it does).
//
// Seeded deliberately past the limit. A fixture of three would pass against
// the old unbounded page and prove nothing.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const GYU = 2;
const COHORT = 976900;
const APPLICANT_BASE = 976000;
const APPLICATION_BASE = 976500;
const WAITING_BASE = 977000;
const APPLICATIONS = 20;
const WAITING = 14;
// Mirrors PREVIEW_LIMIT in src/components/atomic-crm/misc/PreviewList.tsx.
// Written out rather than imported: this spec is a statement about what the
// built bundle does, and importing the constant would let a change to it
// silently rewrite the expectation.
const PREVIEW = 8;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const range = (count: number) => Array.from({ length: count }, (_, i) => i);

const seed = async () => {
  const client = db();
  await client.from("cohorts").delete().eq("id", COHORT);
  await client.from("cohorts").insert({
    id: COHORT,
    offer_id: GYU,
    name: "Growing Yourself Up — Density Round",
    status: "applications_open",
    applications_open_at: "2026-01-01",
    applications_close_at: "2027-12-31",
    program_start_at: "2027-03-01",
    program_end_at: "2027-04-26",
  });

  await client.from("contacts").insert([
    ...range(APPLICATIONS).map((i) => ({
      id: APPLICANT_BASE + i,
      first_name: "Applied",
      last_name: `Person${String(i).padStart(2, "0")}`,
      email_jsonb: [{ email: `applied${i}@example.test`, type: "Work" }],
    })),
    ...range(WAITING).map((i) => ({
      id: WAITING_BASE + i,
      first_name: "Waiting",
      last_name: `Person${String(i).padStart(2, "0")}`,
      email_jsonb: [{ email: `waiting${i}@example.test`, type: "Work" }],
    })),
  ]);

  await client.from("applications").insert(
    range(APPLICATIONS).map((i) => ({
      id: APPLICATION_BASE + i,
      contact_id: APPLICANT_BASE + i,
      offer_id: GYU,
      intended_cohort_id: COHORT,
      opportunity_id: null,
      status: "pending",
      source: "public_form",
      submitted_at: `2026-03-${String(1 + i).padStart(2, "0")}T09:00:00.000Z`,
      raw_answers: {},
    })),
  );

  await client.from("waitlist_entries").insert(
    range(WAITING).map((i) => ({
      id: WAITING_BASE + i,
      contact_id: WAITING_BASE + i,
      offer_id: GYU,
      cohort_id: COHORT,
      status: "waiting",
      source: "manual",
      joined_at: `2026-02-${String(1 + i).padStart(2, "0")}T09:00:00.000Z`,
    })),
  );
};

const cleanup = async () => {
  const client = db();
  await client
    .from("applications")
    .delete()
    .gte("id", APPLICATION_BASE)
    .lt("id", APPLICATION_BASE + 200);
  await client.from("waitlist_entries").delete().gte("id", WAITING_BASE);
  // Whoever the quick-add test typed in, found by the address it used.
  await client.from("contacts").delete().like("last_name", "Densityadd%");
  await client.from("contacts").delete().gte("id", APPLICANT_BASE);
  await client.from("cohorts").delete().eq("id", COHORT);
};

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

const openRound = async (page: Page) => {
  await page.evaluate((id) => {
    window.location.hash = `#/cohorts/${id}/show`;
  }, COHORT);
  await expect(
    page.getByRole("heading", { name: `Applications · ${APPLICATIONS}` }),
  ).toBeVisible();
};

// Only a row FOR one application matches: the resource's own list link
// (`#/applications`) carries no id.
const applicationRows = (page: Page) =>
  page.locator('a[href*="/applications/"]');
const waitlistRows = (page: Page) => page.locator('a[href*="/contacts/"]');

test.describe("a long section on a round's page", () => {
  test.beforeEach(seed);
  test.afterEach(cleanup);

  test("counts, collapses, opens in place, and closes again", async ({
    page,
    createSales,
  }) => {
    const email = `density-${Date.now()}@example.com`;
    await createSales({
      first_name: "Density",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });

    await signIn(page, email);
    await openRound(page);

    // 1 — every section states its size, including the Waitlist.
    await expect(
      page.getByRole("heading", { name: `Waitlist · ${WAITING}` }),
    ).toBeVisible();

    // 2 — and shows the preview rows only.
    await expect(applicationRows(page)).toHaveCount(PREVIEW);

    // 3 — saying how many it is holding back.
    const more = page.getByRole("button", {
      name: `${APPLICATIONS - PREVIEW} more`,
    });
    await expect(more).toBeVisible();

    // 4 — opening it stays on the page.
    const route = page.url();
    await more.click();
    await expect(applicationRows(page)).toHaveCount(APPLICATIONS);
    expect(page.url()).toBe(route);
    await expect(
      page.getByRole("heading", {
        name: "Growing Yourself Up — Density Round",
      }),
    ).toBeVisible();

    // 5 — opening Applications left the Waitlist exactly as it was.
    await expect(
      page.getByRole("button", { name: `${WAITING - PREVIEW} more` }),
    ).toBeVisible();

    // 6 — and it closes again.
    await page.getByRole("button", { name: "Show less" }).click();
    await expect(applicationRows(page)).toHaveCount(PREVIEW);
    await expect(more).toBeVisible();
  });

  test("an opened section is still open after a reload", async ({
    page,
    createSales,
  }) => {
    const email = `density-reload-${Date.now()}@example.com`;
    await createSales({
      first_name: "Density",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });

    await signIn(page, email);
    await openRound(page);
    await page
      .getByRole("button", { name: `${APPLICATIONS - PREVIEW} more` })
      .click();
    await expect(applicationRows(page)).toHaveCount(APPLICATIONS);

    // 7 — a reload is the ordinary thing Leif does between two reads of a
    // section. Collapsing here would make opening it pointless.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: `Applications · ${APPLICATIONS}` }),
    ).toBeVisible();
    await expect(applicationRows(page)).toHaveCount(APPLICATIONS);
  });

  test("adding to an opened Waitlist keeps it open, and keeps your place", async ({
    page,
    createSales,
  }) => {
    // The two behaviours have to hold AT THE SAME TIME. The quick-add
    // repair kept the scroll by not remounting the page; an expansion held
    // in component state would still have snapped shut, putting Leif back
    // at the top of a list of fourteen.
    const email = `density-add-${Date.now()}@example.com`;
    await createSales({
      first_name: "Density",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });

    await page.setViewportSize({ width: 1280, height: 500 });
    await signIn(page, email);
    await openRound(page);

    await page
      .getByRole("button", { name: `${WAITING - PREVIEW} more` })
      .click();
    const openedRows = await waitlistRows(page).count();

    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(200);

    await page.getByRole("button", { name: "Add to Waitlist" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Email", { exact: true })
      .fill("gamma@densityadd.test");
    await dialog.getByLabel("Name", { exact: true }).fill("Gamma Densityadd");
    await dialog.getByRole("button", { name: "Add to waitlist" }).click();
    await expect(dialog).not.toBeVisible();

    // The new person is there, the heading counted them, the section never
    // closed, and we are still looking at it.
    await expect(
      page.getByRole("heading", { name: `Waitlist · ${WAITING + 1}` }),
    ).toBeVisible();
    // The ROW, not the confirmation toast that also says the name.
    await expect(
      page.getByRole("link", { name: "Gamma Densityadd" }),
    ).toBeVisible();
    await expect(waitlistRows(page)).toHaveCount(openedRows + 1);
    expect(
      await page.evaluate(() => window.scrollY),
      "still down at the Waitlist after adding to an opened one",
    ).toBeGreaterThan(200);
  });
});
