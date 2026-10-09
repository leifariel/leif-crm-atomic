import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// Leif adds people to a waitlist several at a time — they arrive through
// Instagram and she works through them in one sitting. The Waitlist sits near
// the bottom of a programme page, so every add was costing her a scroll back
// down: save, lightbox closes, page is at the top again.
//
// This is written from that actual sitting: scroll to the Waitlist, add
// somebody, and still be looking at the Waitlist afterwards — twice, because
// once is not the complaint.
//
// Deliberately NOT asserted by pixel. A remembered scroll offset would pass
// while the page jumped and came back, and would break the moment the page
// above the list changed height. What is asserted is that the Waitlist
// heading is still IN THE VIEWPORT, which is the thing Leif loses.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const LE = 1;
const FIRST_ID = 975001;
const SEEDED = 14;
const GYU = 2;
const COHORT = 975900;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/**
 * Enough people waiting that the page is genuinely taller than the window.
 *
 * On a short page everything is visible at once and the defect cannot show
 * itself — the test would pass against the broken build. The fixture has to
 * make the scroll real.
 */
const seedWaiting = async (
  salesId: number | string,
  where: { offerId: number; cohortId: number | null },
) => {
  const client = db();
  for (let i = 0; i < SEEDED; i += 1) {
    const id = FIRST_ID + i;
    await client.from("contacts").insert({
      id,
      first_name: "Waiting",
      last_name: `Person${String(i).padStart(2, "0")}`,
      sales_id: salesId,
      email_jsonb: [{ email: `waiting${id}@example.test`, type: "Work" }],
    });
    await client.from("waitlist_entries").insert({
      id,
      contact_id: id,
      offer_id: where.offerId,
      cohort_id: where.cohortId,
      status: "waiting",
      source: "manual",
    });
  }
};

const cleanup = async () => {
  const client = db();
  const ids = Array.from({ length: SEEDED + 6 }, (_, i) => FIRST_ID + i);
  await client.from("waitlist_entries").delete().in("id", ids);
  await client.from("contacts").delete().in("id", ids);
  // The people the test itself added, found by the addresses it used.
  await client.from("contacts").delete().like("last_name", "Addedbyhand%");
  await client.from("cohorts").delete().eq("id", COHORT);
};

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

// The heading carries its own count — "Waitlist · 14" — and the count is
// exactly what an add changes, so it is matched by shape rather than by text.
const waitlistHeading = (page: Page) =>
  page.getByRole("heading", { name: /^Waitlist · \d+$/ });

/**
 * Scroll down to the Waitlist and prove we actually moved.
 *
 * The first version of this used scrollIntoViewIfNeeded() and then asked
 * whether the heading was on screen. It passed against the broken build,
 * because the clean room's page is short enough that the heading was already
 * visible at scrollY 0 — so nothing scrolled and nothing could be lost. The
 * viewport is made short here for the same reason: the defect only exists
 * below the fold, and a test that cannot reach the fold cannot see it.
 */
const scrollToTheWaitlist = async (page: Page) => {
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(200);
  return page.evaluate(() => window.scrollY);
};

const addSomebody = async (page: Page, who: string) => {
  await page.getByRole("button", { name: "Add to Waitlist" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("Email", { exact: true })
    .fill(`${who.toLowerCase()}@addedbyhand.test`);
  await dialog.getByLabel("Name", { exact: true }).fill(`${who} Addedbyhand`);
  await dialog.getByRole("button", { name: "Add to waitlist" }).click();
  await expect(dialog).not.toBeVisible();
};

test.describe("adding to a waitlist leaves you where you were", () => {
  test.afterEach(cleanup);

  test("two people in a row, and the Waitlist never leaves the screen", async ({
    page,
    createSales,
  }) => {
    const email = `waitlist-place-${Date.now()}@example.com`;
    const sale = await createSales({
      first_name: "Waitlist",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });
    await seedWaiting(sale.id, { offerId: LE, cohortId: null });

    await page.setViewportSize({ width: 1280, height: 500 });
    await signIn(page, email);
    await page.getByRole("link", { name: "Programs" }).click();
    await page
      .getByRole("link")
      .filter({ hasText: "The Living Example" })
      .first()
      .click();
    await expect(waitlistHeading(page)).toBeVisible();

    const routeBefore = page.url();
    await scrollToTheWaitlist(page);

    await addSomebody(page, "Alpha");
    await expect(page.getByText("Alpha Addedbyhand")).toBeVisible();
    expect(
      await page.evaluate(() => window.scrollY),
      "still down at the Waitlist after the first add",
    ).toBeGreaterThan(200);

    await addSomebody(page, "Beta");
    await expect(page.getByText("Beta Addedbyhand")).toBeVisible();
    expect(
      await page.evaluate(() => window.scrollY),
      "still down at the Waitlist after the second add",
    ).toBeGreaterThan(200);

    // Both are there, and nothing navigated.
    await expect(page.getByText("Alpha Addedbyhand")).toBeVisible();
    expect(page.url()).toBe(routeBefore);
  });

  test("the same sitting, on a round's own page", async ({
    page,
    createSales,
  }) => {
    const email = `waitlist-round-${Date.now()}@example.com`;
    const sale = await createSales({
      first_name: "Waitlist",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });
    const client = db();
    await client.from("cohorts").delete().eq("id", COHORT);
    await client.from("cohorts").insert({
      id: COHORT,
      offer_id: GYU,
      name: "Growing Yourself Up — Scroll Round",
      status: "applications_open",
      applications_open_at: "2026-01-01",
      applications_close_at: "2027-12-31",
      program_start_at: "2027-03-01",
      program_end_at: "2027-04-26",
    });
    await seedWaiting(sale.id, { offerId: GYU, cohortId: COHORT });

    await page.setViewportSize({ width: 1280, height: 500 });
    await signIn(page, email);
    await page.evaluate((id) => {
      window.location.hash = `#/cohorts/${id}/show`;
    }, COHORT);
    await expect(waitlistHeading(page)).toBeVisible();

    await scrollToTheWaitlist(page);

    await addSomebody(page, "Gamma");
    await expect(page.getByText("Gamma Addedbyhand")).toBeVisible();
    expect(
      await page.evaluate(() => window.scrollY),
      "still down at the Waitlist after adding on a round page",
    ).toBeGreaterThan(200);
  });
});
