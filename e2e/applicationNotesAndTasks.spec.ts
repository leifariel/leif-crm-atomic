import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// SYSTEM GREEN for Leif's private working area on an Application.
//
// Real browser, real production build, real UI, real data provider, real
// Postgres, an INDEPENDENT SQL read-back after every write, and fresh page
// loads in between.
//
// ONE TEST DOES THE WHOLE WRITE JOURNEY, deliberately.
//
// `resetDb` in fixtures.ts is an automatic fixture: it deletes every row
// of every table before EACH test. So seeded rows cannot be shared across
// tests — a journey split into "add a note", then "add another", then
// "check isolation" has its fixture deleted underneath it between the
// steps, and the symptom is not an empty table. It is the page's own
// honest "That note could not be saved", because the Application the note
// points at no longer exists. That is what made the earlier split version
// fail while each test passed on its own.
//
// Hence: one setup, one browser, one journey, many assertions. The mobile
// test does layout only and writes nothing.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const LE_OFFER = 1;

// Ids far outside production's range, and outside every other spec's:
// applicationResolutionFixture uses 9600xx, the waitlist spec 9700xx.
const CONTACT_ID = 978001;
const APP_A = 978001;
const APP_B = 978002;
const AT = "2026-09-01T00:00:00.000Z";

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/**
 * One Contact, TWO Applications for that Contact, and the open
 * review_application task the CRM projects for work awaiting review.
 *
 * `raw_answers` is '{}' on purpose: materialize_native_application_responses()
 * skips an empty payload, so these fixtures never create the immutable
 * application_responses rows that refuse to be deleted.
 */
const seed = async () => {
  const client = db();

  const contact = await client.from("contacts").insert({
    id: CONTACT_ID,
    first_name: "Noted",
    last_name: "Applicant",
    email_jsonb: [{ email: "noted.applicant@example.com", type: "Work" }],
    phone_jsonb: [],
    tags: [],
    sales_eligibility: "normal",
    first_seen: AT,
    last_seen: AT,
  });
  if (contact.error) throw new Error(`seed contact: ${contact.error.message}`);

  for (const id of [APP_A, APP_B]) {
    const app = await client.from("applications").insert({
      id,
      contact_id: CONTACT_ID,
      source: "manual",
      status: "pending",
      submitted_at: AT,
      raw_answers: {},
      offer_id: LE_OFFER,
    });
    if (app.error) {
      throw new Error(`seed application ${id}: ${app.error.message}`);
    }
  }

  const task = await client.from("tasks").insert({
    contact_id: CONTACT_ID,
    application_id: APP_A,
    type: "review_application",
    text: "Review Noted Applicant's application",
    status: "pending",
    due_date: AT,
  });
  if (task.error) throw new Error(`seed review task: ${task.error.message}`);
};

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

// Hash-routed (CRM.tsx), so moving between two #/... paths is a
// same-document navigation.
const openApplication = async (page: Page, id: number) => {
  await page.goto(`/#/applications/${id}/show`);
  await expect(page.getByText("Notes & follow-up")).toBeVisible();
};

/**
 * A note as RENDERED, never the composer's own value.
 *
 * This guard matters. An earlier version asserted `getByText(text)` right
 * after typing, which happily matched the textarea the text had been typed
 * into — so it passed while nothing had been saved at all. Scoping to the
 * notes list makes the assertion about what the page shows back.
 */
const savedNotes = (page: Page) => page.getByTestId("application-notes");
const followUps = (page: Page) => page.getByTestId("application-follow-ups");
const composer = (page: Page) => page.getByLabel("Note", { exact: true });

const addNote = async (page: Page, text: string) => {
  const box = composer(page);
  const add = page.getByRole("button", { name: "Add this note" });
  // Click before typing: the button is disabled while the field is empty,
  // so a fill landing before React attaches its handler would leave the
  // DOM holding text the component never saw.
  await box.click();
  await box.fill(text);
  await expect(add).toBeEnabled();
  await add.click();
  // Authoritative success: rendered in the LIST, and the composer back to
  // empty.
  await expect(savedNotes(page).getByText(text)).toBeVisible();
  await expect(box).toHaveValue("");
};

const addFollowUp = async (page: Page, text: string) => {
  await page.getByRole("button", { name: "Add task" }).click();
  const description = page.getByLabel(/^Description/);
  await description.click();
  await description.fill(text);
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(followUps(page).getByText(text)).toBeVisible();
};

test.describe("Application notes and follow-up, against real Postgres", () => {
  test("the whole working-area journey: notes, isolation, follow-up tasks", async ({
    page,
    createSales,
  }) => {
    // Writes run once, on desktop. The mobile test below proves layout and
    // writes nothing, so the two can never race over the same rows.
    test.skip(
      test.info().project.name !== "chromium",
      "authoritative write journey runs once, on desktop",
    );

    await seed();
    const client = db();
    const email = `owner.journey.${Date.now()}@example.com`;
    await createSales({
      first_name: "Leif",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });
    await signIn(page, email);

    // ---- 1. A note on Application A --------------------------------
    await openApplication(page, APP_A);
    await addNote(page, "NOTE ALPHA");

    const afterAlpha = await client
      .from("application_notes")
      .select("id, application_id, text")
      .eq("application_id", APP_A);
    expect(afterAlpha.error).toBeNull();
    expect(afterAlpha.data).toHaveLength(1);
    expect(afterAlpha.data![0].text).toBe("NOTE ALPHA");
    expect(afterAlpha.data![0].application_id).toBe(APP_A);

    // ---- 2. It survives a full reload, as a SAVED note -------------
    await page.reload();
    await openApplication(page, APP_A);
    await expect(savedNotes(page).getByText("NOTE ALPHA")).toBeVisible();
    // The regression guard: after a reload the composer is empty, so the
    // assertion above cannot be satisfied by typed text.
    await expect(composer(page)).toHaveValue("");

    // ---- 3. A second note, beside the first ------------------------
    await addNote(page, "NOTE BETA");

    const afterBeta = await client
      .from("application_notes")
      .select("text, application_id")
      .eq("application_id", APP_A)
      .order("date", { ascending: true });
    expect(afterBeta.data).toHaveLength(2);
    expect(afterBeta.data!.map((row) => row.text)).toEqual([
      "NOTE ALPHA",
      "NOTE BETA",
    ]);

    await page.reload();
    await openApplication(page, APP_A);
    await expect(savedNotes(page).getByText("NOTE ALPHA")).toBeVisible();
    await expect(savedNotes(page).getByText("NOTE BETA")).toBeVisible();

    // ---- 4. The other Application has neither ----------------------
    // The whole reason application_notes exists rather than reusing
    // contact_notes: this is the SAME person.
    const onB = await client
      .from("application_notes")
      .select("id")
      .eq("application_id", APP_B);
    expect(onB.data).toHaveLength(0);

    await openApplication(page, APP_B);
    await expect(page.getByText("NOTE ALPHA")).toHaveCount(0);
    await expect(page.getByText("NOTE BETA")).toHaveCount(0);

    // Back to A, and both are still there.
    await openApplication(page, APP_A);
    await expect(savedNotes(page).getByText("NOTE ALPHA")).toBeVisible();
    await expect(savedNotes(page).getByText("NOTE BETA")).toBeVisible();

    // ---- 5. Follow-up tasks beside the open review task ------------
    const beforeTasks = await client
      .from("tasks")
      .select("id, type")
      .eq("application_id", APP_A);
    expect(beforeTasks.data).toHaveLength(1);
    expect(beforeTasks.data![0].type).toBe("review_application");

    await addFollowUp(page, "FOLLOW UP ONE");
    await addFollowUp(page, "FOLLOW UP TWO");

    const afterTasks = await client
      .from("tasks")
      .select("id, type, text, application_id, done_date")
      .eq("application_id", APP_A)
      .order("id", { ascending: true });
    expect(afterTasks.data).toHaveLength(3);

    const review = afterTasks.data!.filter(
      (row) => row.type === "review_application",
    );
    expect(review).toHaveLength(1);
    expect(review[0].done_date).toBeNull();

    const manual = afterTasks.data!.filter((row) => row.type === "other");
    expect(manual.map((row) => row.text).sort()).toEqual([
      "FOLLOW UP ONE",
      "FOLLOW UP TWO",
    ]);
    for (const row of manual) expect(row.application_id).toBe(APP_A);

    // ---- 6. None of that decided anything -------------------------
    const app = await client
      .from("applications")
      .select("status, reviewed_at")
      .eq("id", APP_A)
      .single();
    expect(app.data!.status).toBe("pending");
    expect(app.data!.reviewed_at).toBeNull();

    // ---- 7. A fresh browser context still shows all of it ---------
    const fresh = await page.context().browser()!.newContext();
    const freshPage = await fresh.newPage();
    await signIn(freshPage, email);
    await openApplication(freshPage, APP_A);
    await expect(followUps(freshPage).getByText("FOLLOW UP ONE")).toBeVisible();
    await expect(followUps(freshPage).getByText("FOLLOW UP TWO")).toBeVisible();
    await expect(savedNotes(freshPage).getByText("NOTE ALPHA")).toBeVisible();
    await expect(savedNotes(freshPage).getByText("NOTE BETA")).toBeVisible();
    await fresh.close();

    // ---- 8. The invariant the index names is still enforced -------
    const second = await client.from("tasks").insert({
      contact_id: CONTACT_ID,
      application_id: APP_A,
      type: "review_application",
      text: "A second review",
      status: "pending",
      due_date: AT,
    });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toMatch(/duplicate key|unique/i);

    // ---- 9. Completing a follow-up leaves the review task open ----
    await client
      .from("tasks")
      .update({ done_date: new Date().toISOString(), status: "completed" })
      .eq("application_id", APP_A)
      .eq("text", "FOLLOW UP ONE");

    const stillOpen = await client
      .from("tasks")
      .select("done_date")
      .eq("application_id", APP_A)
      .eq("type", "review_application")
      .single();
    expect(stillOpen.data!.done_date).toBeNull();
  });

  // Read-only: writes nothing, so it is safe in every project — and it is
  // the one that runs at phone width, where the controls have to be
  // reachable rather than merely present.
  test("the working area is usable at phone width", async ({
    page,
    createSales,
  }) => {
    await seed();
    const email = `owner.mobile.${Date.now()}@example.com`;
    await createSales({
      first_name: "Leif",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });
    await page.setViewportSize({ width: 393, height: 851 });
    await signIn(page, email);
    await openApplication(page, APP_A);

    // The email under the name, inside the viewport.
    const emailLink = page.getByRole("link", {
      name: "noted.applicant@example.com",
    });
    await expect(emailLink).toBeVisible();
    const emailBox = (await emailLink.boundingBox())!;
    expect(emailBox.x).toBeGreaterThanOrEqual(0);
    expect(emailBox.x + emailBox.width).toBeLessThanOrEqual(393);

    // No horizontal page overflow.
    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(393);

    const addTask = page.getByRole("button", { name: "Add task" });
    await addTask.scrollIntoViewIfNeeded();
    await expect(addTask).toBeVisible();
    const taskBox = (await addTask.boundingBox())!;
    expect(taskBox.height).toBeGreaterThan(24);
    expect(taskBox.x + taskBox.width).toBeLessThanOrEqual(393);
    // Really the top element at its own centre: nothing invisible over it.
    await addTask.click({ trial: true });

    const box = composer(page);
    await box.scrollIntoViewIfNeeded();
    await expect(box).toBeVisible();
    const boxBox = (await box.boundingBox())!;
    expect(boxBox.width).toBeGreaterThan(200);
    expect(boxBox.x + boxBox.width).toBeLessThanOrEqual(393);
    await box.click({ trial: true });
  });
});
