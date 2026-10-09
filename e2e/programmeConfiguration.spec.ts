import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// Leif could not configure a programme's Kit tags, twice over.
//
// The first repair gave the Programs HUB's group programme the "⋯" menu its
// 1:1 sibling already had. That was a real gap and it is still fixed. It was
// not the gap she hit: she manages a programme from its own DETAIL page —
// /#/programs/individual/1 — and that page has a heading, Copy Application
// Link and capacity, and no way to edit the programme at all. Neither does
// the group one.
//
// I then "proved" the affordance was live by counting a prop name in the
// production bundle. That proof was worthless for the question actually being
// asked: a call site existing somewhere says nothing about whether the route
// Leif walks exposes it. This spec asks the question the way she does —
// through the real navigation, in the built app, against real Postgres — and
// it is written to FAIL against the structure that shipped.
//
// What it must reach, for BOTH programmes: the Offer's existing edit form and
// the Kit automation box on it, carrying the three events this slice added.

const PASSWORD = "password";

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveTitle(/Leif CRM/);
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

/**
 * The route Leif walks, not a deep link.
 *
 * Starting from the nav is the point: a detail page reached by typing its URL
 * would not have proved she can get there, and getting there is half of what
 * went wrong.
 */
const openProgrammeDetail = async (page: Page, programme: string) => {
  await page.getByRole("link", { name: "Programs" }).click();
  await expect(
    page.getByRole("heading", { name: "Programs", exact: true }),
  ).toBeVisible();
  // A 1:1 programme is a CARD whose link also carries its capacity, so the
  // accessible name is not just the programme name. Filtered by the text it
  // contains, which is true of both shapes.
  await page.getByRole("link").filter({ hasText: programme }).first().click();
  await expect(
    page.getByRole("heading", { name: programme, exact: true }),
  ).toBeVisible();
};

const headerActions = (page: Page) =>
  page.getByTestId("programme-header-actions");

const editFromTheDetailPage = async (page: Page, programme: string) => {
  // Scoped to the HEADER on purpose. The group programme's page also lists
  // its rounds, and a round card carries a menu of its own that goes to the
  // round's form — reaching for "the first Program actions on the page" found
  // that one and proved nothing. The programme's menu is the one in its
  // header.
  await expect(headerActions(page)).toBeVisible();
  await headerActions(page)
    .getByRole("button", { name: "Program actions" })
    .click();
  await page.getByRole("menuitem", { name: "Edit program" }).click();

  // The Offer's own edit form, filled in from the record.
  await expect(page.getByLabel(/^Name/)).toHaveValue(programme);
};

const kitRowsAreVisible = async (page: Page) => {
  await expect(page.getByText("Kit automation", { exact: true })).toBeVisible();
  for (const row of [
    "Offered the other programme",
    "Bespoke Accepted",
    "Bespoke Denied",
  ]) {
    await expect(page.getByText(row, { exact: true })).toBeVisible();
  }
};

test.describe("a programme is configurable from its own page", () => {
  const freshEmail = (label: string) =>
    `programme-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

  test("The Living Example: Programs -> the programme -> Edit program -> Kit automation", async ({
    page,
    createSales,
  }) => {
    const email = freshEmail("le");
    await createSales({
      first_name: "Programme",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });

    await signIn(page, email);
    await openProgrammeDetail(page, "The Living Example");

    // The page Leif is on carries what she already uses...
    await expect(
      page.getByRole("button", { name: /Copy Application Link/i }),
    ).toBeVisible();
    // ...and, now, a way to configure the programme itself.
    await editFromTheDetailPage(page, "The Living Example");
    await kitRowsAreVisible(page);
  });

  test("Growing Yourself Up: Programs -> the programme -> Edit program -> Kit automation", async ({
    page,
    createSales,
  }) => {
    const email = freshEmail("gyu");
    await createSales({
      first_name: "Programme",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });

    await signIn(page, email);
    await openProgrammeDetail(page, "Growing Yourself Up");
    await editFromTheDetailPage(page, "Growing Yourself Up");
    await kitRowsAreVisible(page);
  });

  test("exactly one programme-level menu, and none on a client row", async ({
    page,
    createSales,
  }) => {
    const email = freshEmail("one");
    await createSales({
      first_name: "Programme",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });

    await signIn(page, email);
    await openProgrammeDetail(page, "The Living Example");

    // One in the header, and one only: a detail page is about one programme
    // and says so once.
    await expect(
      headerActions(page).getByRole("button", { name: "Program actions" }),
    ).toHaveCount(1);
    // And nothing was added to the client rows below it. The Living Example's
    // page lists its clients; none of them gained a programme control.
    await expect(
      page.getByRole("button", { name: "Program actions" }),
    ).toHaveCount(1);
  });
});
