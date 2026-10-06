import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// SYSTEM GREEN for the testimonial sequence.
//
// Real browser, real production build, real UI, real data provider, real
// Postgres, an INDEPENDENT SQL read-back after every step, and a fresh
// browser context at the end.
//
// ONE TEST DOES THE WHOLE WRITE JOURNEY. `resetDb` in fixtures.ts is an
// automatic fixture that empties every table before EVERY test, so seeded
// rows cannot be shared across tests — a cadence split across several
// tests has its fixture deleted underneath it between the steps.
//
// Time travel instead of waiting a fortnight: Day 0 is the entered_at of
// the Enrollment's 'offboarding' status event, so backdating that row moves
// the whole cadence. The prospective boundary is moved with it, because an
// anchor backdated past not_before would correctly stop being eligible —
// which is the boundary working, not the cadence failing.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const LE_OFFER = 1;

// Clear of every other spec: 9600xx resolution, 9700xx waitlist,
// 9780xx application notes.
const CONTACT_ID = 979001;
const DEAL_ID = 979001;
const AT = "2026-09-01T00:00:00.000Z";

const STAGES = [
  "collect_testimonial",
  "testimonial_followup_1",
  "testimonial_followup_2",
] as const;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/**
 * A client of the programme that asks, carried to the brink of
 * offboarding — but NOT over it, because crossing that line is the thing
 * under test.
 *
 * Winning the Opportunity is what creates the Enrollment
 * (handle_deal_won), and enrollments.opportunity_id is unique, so the
 * fixture takes the row the CRM made rather than inserting its own.
 */
const seed = async () => {
  const client = db();

  const contact = await client.from("contacts").insert({
    id: CONTACT_ID,
    first_name: "Testimonial",
    last_name: "Journey",
    email_jsonb: [{ email: "testimonial.journey@example.com", type: "Work" }],
    phone_jsonb: [],
    tags: [],
    sales_eligibility: "normal",
    first_seen: AT,
    last_seen: AT,
  });
  if (contact.error) throw new Error(`seed contact: ${contact.error.message}`);

  const deal = await client.from("deals").insert({
    id: DEAL_ID,
    name: "Testimonial Journey — The Living Example",
    contact_id: CONTACT_ID,
    offer_id: LE_OFFER,
    stage: "won",
    amount: 4000,
    index: 0,
    created_at: AT,
    updated_at: AT,
    stage_entered_at: AT,
  });
  if (deal.error) throw new Error(`seed deal: ${deal.error.message}`);

  const enrollment = await client
    .from("enrollments")
    .select("id")
    .eq("opportunity_id", DEAL_ID)
    .single();
  if (enrollment.error) {
    throw new Error(
      `winning should have created an enrollment: ${enrollment.error.message}`,
    );
  }
  const enrollmentId = enrollment.data.id as number;

  // Activation refuses an unfinished onboarding checklist, and the
  // lifecycle refuses skipped stages.
  await client
    .from("enrollment_onboarding_items")
    .update({ status: "done" })
    .eq("enrollment_id", enrollmentId);
  const active = await client
    .from("enrollments")
    .update({ status: "active" })
    .eq("id", enrollmentId);
  if (active.error) throw new Error(`activate: ${active.error.message}`);

  return enrollmentId;
};

const cleanup = async () => {
  const client = db();
  const enrollment = await client
    .from("enrollments")
    .select("id")
    .eq("opportunity_id", DEAL_ID)
    .maybeSingle();
  const enrollmentId = enrollment.data?.id;
  if (enrollmentId) {
    await client.from("tasks").delete().eq("enrollment_id", enrollmentId);
    await client
      .from("enrollment_offboarding_items")
      .delete()
      .eq("enrollment_id", enrollmentId);
    await client
      .from("enrollment_onboarding_items")
      .delete()
      .eq("enrollment_id", enrollmentId);
    await client
      .from("enrollment_status_events")
      .delete()
      .eq("enrollment_id", enrollmentId);
    await client.from("enrollments").delete().eq("id", enrollmentId);
  }
  await client.from("tasks").delete().eq("contact_id", CONTACT_ID);
  await client.from("deals").delete().eq("id", DEAL_ID);
  await client.from("contacts").delete().eq("id", CONTACT_ID);
};

/** Move Day 0 back, and the eligibility boundary with it. */
const travelBack = async (enrollmentId: number, days: number) => {
  const client = db();
  await client
    .from("testimonial_sequence_settings")
    .update({ not_before: new Date(Date.now() - 365 * 86400000).toISOString() })
    .eq("id", 1);

  const event = await client
    .from("enrollment_status_events")
    .select("id, entered_at")
    .eq("enrollment_id", enrollmentId)
    .eq("status", "offboarding")
    .order("entered_at", { ascending: false })
    .limit(1)
    .single();
  if (event.error)
    throw new Error(`no offboarding event: ${event.error.message}`);

  const moved = new Date(
    new Date(event.data.entered_at as string).getTime() - days * 86400000,
  ).toISOString();
  await client
    .from("enrollment_status_events")
    .update({ entered_at: moved })
    .eq("id", event.data.id);
};

const reconcile = async () => {
  const client = db();
  const { error } = await client.rpc("reconcile_testimonial_tasks");
  if (error) throw new Error(`reconcile: ${error.message}`);
};

const stagesFor = async (enrollmentId: number) => {
  const client = db();
  const { data, error } = await client
    .from("tasks")
    .select("type, status, done_date, enrollment_id")
    .eq("enrollment_id", enrollmentId)
    .in("type", STAGES as unknown as string[])
    .order("type", { ascending: true });
  if (error) throw new Error(`read stages: ${error.message}`);
  return data ?? [];
};

const completeStage = async (enrollmentId: number, type: string) => {
  const client = db();
  const { error } = await client
    .from("tasks")
    .update({ status: "completed", done_date: new Date().toISOString() })
    .eq("enrollment_id", enrollmentId)
    .eq("type", type);
  if (error) throw new Error(`complete ${type}: ${error.message}`);
};

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

const openClient = async (page: Page, enrollmentId: number) => {
  await page.goto(`/#/enrollments/${enrollmentId}/show`);
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
};

test.describe("Testimonial sequence, against real Postgres", () => {
  test.beforeEach(async () => {
    await cleanup();
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test("day 0, day 7, day 14, then it stops — and receipt suppresses the open ask", async ({
    page,
    createSales,
  }) => {
    test.skip(
      test.info().project.name !== "chromium",
      "authoritative write journey runs once, on desktop",
    );

    const enrollmentId = await seed();
    const client = db();
    const email = `owner.testimonial.${Date.now()}@example.com`;
    await createSales({
      first_name: "Leif",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });
    await signIn(page, email);

    // ---- DAY 0 -----------------------------------------------------
    // Start offboarding through the real UI, the way Leif does.
    await openClient(page, enrollmentId);
    await page.getByRole("button", { name: "Start offboarding" }).click();
    await expect(page.getByText("Testimonial", { exact: true })).toBeVisible();
    await expect(page.getByText("Not received")).toBeVisible();

    let stages = await stagesFor(enrollmentId);
    expect(stages).toHaveLength(1);
    expect(stages[0].type).toBe("collect_testimonial");
    expect(stages[0].done_date).toBeNull();

    // Repeated reconciliation adds nothing: the unique index is the
    // authority, not a check-then-insert.
    await reconcile();
    await reconcile();
    await Promise.all([reconcile(), reconcile(), reconcile()]);
    stages = await stagesFor(enrollmentId);
    expect(stages).toHaveLength(1);

    // ---- DAY 6: nothing ---------------------------------------------
    await travelBack(enrollmentId, 6);
    await completeStage(enrollmentId, "collect_testimonial");
    await reconcile();
    stages = await stagesFor(enrollmentId);
    expect(stages.map((s) => s.type)).toEqual(["collect_testimonial"]);

    // ---- DAY 7: the first follow-up, exactly once -------------------
    await travelBack(enrollmentId, 1);
    await reconcile();
    await reconcile();
    stages = await stagesFor(enrollmentId);
    expect(stages.map((s) => s.type).sort()).toEqual([
      "collect_testimonial",
      "testimonial_followup_1",
    ]);
    const followUp1 = stages.find((s) => s.type === "testimonial_followup_1")!;
    expect(followUp1.done_date).toBeNull();
    expect(followUp1.enrollment_id).toBe(enrollmentId);

    // ---- DAY 13: still no second follow-up --------------------------
    await travelBack(enrollmentId, 6);
    await completeStage(enrollmentId, "testimonial_followup_1");
    await reconcile();
    stages = await stagesFor(enrollmentId);
    expect(stages.some((s) => s.type === "testimonial_followup_2")).toBe(false);

    // ---- DAY 14: the second follow-up, exactly once -----------------
    await travelBack(enrollmentId, 1);
    await reconcile();
    await Promise.all([reconcile(), reconcile()]);
    stages = await stagesFor(enrollmentId);
    expect(stages.map((s) => s.type).sort()).toEqual([
      "collect_testimonial",
      "testimonial_followup_1",
      "testimonial_followup_2",
    ]);

    // ---- RECEIPT suppresses the OPEN ask ---------------------------
    // Through the real UI, on a page that has moved on from offboarding
    // in the meantime — a testimonial can arrive whenever.
    await openClient(page, enrollmentId);
    await page
      .getByRole("button", { name: "Mark testimonial received" })
      .click();
    await expect(page.getByText(/Received /)).toBeVisible();

    const enrollment = await client
      .from("enrollments")
      .select("testimonial_received_at, status")
      .eq("id", enrollmentId)
      .single();
    expect(enrollment.data!.testimonial_received_at).not.toBeNull();

    // The open follow-up was CANCELLED, not completed: Leif did not do
    // it, it stopped being necessary. Both truths survive.
    stages = await stagesFor(enrollmentId);
    const second = stages.find((s) => s.type === "testimonial_followup_2")!;
    expect(second.status).toBe("cancelled");
    expect(second.done_date).not.toBeNull();
    const first = stages.find((s) => s.type === "testimonial_followup_1")!;
    expect(first.status).toBe("completed");

    // ---- NOTHING comes back ----------------------------------------
    await reconcile();
    await reconcile();
    stages = await stagesFor(enrollmentId);
    expect(stages).toHaveLength(3);
    expect(stages.filter((s) => s.done_date === null)).toHaveLength(0);

    // ---- A fresh browser context agrees ----------------------------
    const fresh = await page.context().browser()!.newContext();
    const freshPage = await fresh.newPage();
    await signIn(freshPage, email);
    await openClient(freshPage, enrollmentId);
    await expect(freshPage.getByText(/Received /)).toBeVisible();
    await expect(
      freshPage.getByRole("button", { name: "Mark testimonial received" }),
    ).toHaveCount(0);
    await fresh.close();

    // ---- Routine offboarding was never blocked ---------------------
    // notes_archived is untouched by any of this, and completing it
    // completes the Enrollment.
    const items = await client
      .from("enrollment_offboarding_items")
      .select("requirement_key, status")
      .eq("enrollment_id", enrollmentId);
    expect(items.data!.map((i) => i.requirement_key)).toContain(
      "notes_archived",
    );

    await client
      .from("enrollment_offboarding_items")
      .update({ status: "done" })
      .eq("enrollment_id", enrollmentId);
    const completed = await client
      .from("enrollments")
      .update({ status: "completed" })
      .eq("id", enrollmentId)
      .select("status")
      .single();
    expect(completed.error).toBeNull();
    expect(completed.data!.status).toBe("completed");
  });

  // The other half of "it stops": a client who never replies. Separate
  // test, separate fixture — nothing is shared.
  test("a client who never replies is asked twice and then left alone", async ({
    createSales,
  }) => {
    test.skip(
      test.info().project.name !== "chromium",
      "authoritative write journey runs once, on desktop",
    );
    await createSales({
      first_name: "Leif",
      last_name: "Owner",
      email: `owner.silent.${Date.now()}@example.com`,
      password: PASSWORD,
    });

    const enrollmentId = await seed();
    const client = db();

    await client
      .from("enrollments")
      .update({ status: "offboarding" })
      .eq("id", enrollmentId);
    await travelBack(enrollmentId, 20);

    await completeStage(enrollmentId, "collect_testimonial");
    await reconcile();
    await completeStage(enrollmentId, "testimonial_followup_1");
    await reconcile();
    await completeStage(enrollmentId, "testimonial_followup_2");
    await reconcile();
    await reconcile();

    const stages = await stagesFor(enrollmentId);
    expect(stages).toHaveLength(3);

    // The honest end state: asked twice, never received. Nothing claimed
    // otherwise, and nothing new will ever be raised.
    const enrollment = await client
      .from("enrollments")
      .select("testimonial_received_at")
      .eq("id", enrollmentId)
      .single();
    expect(enrollment.data!.testimonial_received_at).toBeNull();

    // And the database itself refuses a fourth stage of any kind.
    const fourth = await client.from("tasks").insert({
      contact_id: CONTACT_ID,
      enrollment_id: enrollmentId,
      type: "testimonial_followup_2",
      text: "A third ask",
      status: "pending",
      due_date: AT,
    });
    expect(fourth.error).not.toBeNull();
    expect(fourth.error!.message).toMatch(/duplicate key|unique/i);
  });

  // Read-only: safe in every project, and the one that runs at phone
  // width.
  test("the testimonial card fits a phone", async ({ page, createSales }) => {
    const enrollmentId = await seed();
    const client = db();
    await client
      .from("enrollments")
      .update({ status: "offboarding" })
      .eq("id", enrollmentId);

    const email = `owner.tmobile.${Date.now()}@example.com`;
    await createSales({
      first_name: "Leif",
      last_name: "Owner",
      email,
      password: PASSWORD,
    });
    await page.setViewportSize({ width: 393, height: 851 });
    await signIn(page, email);
    await openClient(page, enrollmentId);

    const card = page.getByText("Testimonial", { exact: true });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();

    const mark = page.getByRole("button", {
      name: "Mark testimonial received",
    });
    await mark.scrollIntoViewIfNeeded();
    await expect(mark).toBeVisible();
    const box = (await mark.boundingBox())!;
    expect(box.height).toBeGreaterThan(24);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(393);
    await mark.click({ trial: true });

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(393);
  });
});
