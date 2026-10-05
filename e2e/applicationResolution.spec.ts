import type { Browser, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  APPLICATION_ID,
  CONTACT_ID,
  DEAL_ID,
  GYU_OFFER,
  OTHER_OFFER_DEAL_ID,
  SECOND_DEAL_ID,
  cleanup,
  db,
  readApplication,
  readDeals,
  seedResolution,
} from "./applicationResolutionFixture";

// SYSTEM GREEN for the resolution path.
//
// Samantha Herold and Celia could not be decided at all. The page told Leif
// both "There is already a live sales conversation with this person for this
// programme" and "No sales opportunity is linked to this application, so a
// decision cannot be recorded here yet" — both true, and together a dead end.
//
// The whole chain, nothing stubbed: real browser, real production build,
// real UI interaction, real data provider, real Postgres, an INDEPENDENT SQL
// read-back, and a fresh browser context.

const PASSWORD = "password";

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveTitle(/Leif CRM/);
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

// Hash-routed on purpose (CRM.tsx), so moving between two #/... paths is a
// same-document change and page.goto() will not re-navigate for one.
const openApplication = async (page: Page) => {
  await page.evaluate((id) => {
    window.location.hash = `#/applications/${id}/show`;
  }, APPLICATION_ID);
  await expect(
    page.getByText("Samantha Herold", { exact: false }).first(),
  ).toBeVisible();
};

const freshBrowserAt = async (browser: Browser, email: string) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  await openApplication(page);
  return { context, page };
};

test.describe("resolving an Application onto the conversation that exists", () => {
  let email: string;

  const freshEmail = () =>
    `resolution-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  test.afterEach(async () => {
    await cleanup();
  });

  test("the dead end is now a way out, and it links the exact Opportunity", async ({
    page,
    browser,
    createSales,
  }) => {
    email = freshEmail();
    await seedResolution(createSales, { email, password: PASSWORD });

    const dealsBefore = await readDeals();
    expect(dealsBefore).toHaveLength(1);
    expect((await readApplication()).opportunity_id).toBeNull();

    await signIn(page, email);
    await openApplication(page);

    // The conflict is still named — a second Opportunity beside a live one
    // would be worse than the dead end.
    await expect(
      page.getByText("already a live sales conversation", { exact: false }),
    ).toBeVisible();
    // And now there is something to do about it.
    await page
      .getByRole("button", { name: "Resolve sales conversation" })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Told truthfully, including the absence that caused all of this.
    await expect(
      dialog.getByText(`Opportunity ${DEAL_ID}`, { exact: false }),
    ).toBeVisible();
    await expect(
      dialog.getByText("no round recorded", { exact: false }),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Link" }).click();
    await expect(
      page.getByText("linked to that sales conversation", { exact: false }),
    ).toBeVisible();

    // INDEPENDENT DATABASE READ-BACK. Not the page's opinion of itself.
    const application = await readApplication();
    expect(String(application.opportunity_id)).toBe(String(DEAL_ID));
    expect(String(application.id)).toBe(String(APPLICATION_ID));
    expect(String(application.contact_id)).toBe(String(CONTACT_ID));
    expect(String(application.offer_id)).toBe(String(GYU_OFFER));

    // ZERO duplicate Opportunity, and the existing one untouched —
    // including the missing round, which linking must not invent.
    const dealsAfter = await readDeals();
    expect(dealsAfter).toHaveLength(dealsBefore.length);
    expect(String(dealsAfter[0]!.id)).toBe(String(DEAL_ID));
    expect(dealsAfter[0]!.stage).toBe("call_booked");
    expect(dealsAfter[0]!.cohort_id).toBeNull();
    expect(dealsAfter[0]!.archived_at).toBeNull();

    // FRESH BROWSER: nothing the saving context held can answer for this.
    const { context, page: fresh } = await freshBrowserAt(browser, email);
    try {
      const rendered = await fresh.locator("body").innerText();
      // The contradiction is gone, both halves of it.
      expect(rendered).not.toContain("No sales opportunity is linked");
      expect(rendered).not.toContain("already a live sales conversation");
      expect(rendered).not.toContain("Resolve sales conversation");
      // And the decision can finally be recorded.
      await expect(
        fresh.getByRole("button", { name: "Approve" }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("two live conversations are both shown, and neither is chosen", async ({
    page,
    createSales,
  }) => {
    email = freshEmail();
    await seedResolution(
      createSales,
      { email, password: PASSWORD },
      { ambiguous: true },
    );

    await signIn(page, email);
    await openApplication(page);
    await page
      .getByRole("button", { name: "Resolve sales conversation" })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("more than one live sales conversation", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      dialog.getByText(`Opportunity ${DEAL_ID}`, { exact: false }),
    ).toBeVisible();
    await expect(
      dialog.getByText(`Opportunity ${SECOND_DEAL_ID}`, { exact: false }),
    ).toBeVisible();

    // Nothing was written by merely opening the question.
    expect((await readApplication()).opportunity_id).toBeNull();
    // Two Link buttons, neither preferred.
    await expect(dialog.getByRole("button", { name: "Link" })).toHaveCount(2);
  });

  test("the database refuses a link to another programme, UI or not", async ({
    createSales,
  }) => {
    // The server authority, tested by bypassing the page entirely — this is
    // what makes the UI's restraint a guarantee rather than a convention.
    email = freshEmail();
    await seedResolution(
      createSales,
      { email, password: PASSWORD },
      { otherOffer: true },
    );

    const { error } = await db()
      .from("applications")
      .update({ opportunity_id: OTHER_OFFER_DEAL_ID })
      .eq("id", APPLICATION_ID);

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/different programme|Offer/i);
    // And nothing was written.
    expect((await readApplication()).opportunity_id).toBeNull();
  });

  test("linking the same Opportunity twice leaves exactly one correct link", async ({
    createSales,
  }) => {
    email = freshEmail();
    await seedResolution(createSales, { email, password: PASSWORD });

    const first = await db()
      .from("applications")
      .update({ opportunity_id: DEAL_ID })
      .eq("id", APPLICATION_ID);
    expect(first.error).toBeNull();

    // The replay. Whether it is accepted or refused, the persisted state
    // must be the same afterwards.
    const second = await db()
      .from("applications")
      .update({ opportunity_id: DEAL_ID })
      .eq("id", APPLICATION_ID);
    expect(second.error).toBeNull();

    const application = await readApplication();
    expect(String(application.opportunity_id)).toBe(String(DEAL_ID));

    const deals = await readDeals();
    expect(deals).toHaveLength(1);
    const { count } = await db()
      .from("applications")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", CONTACT_ID);
    expect(count).toBe(1);
  });
});
