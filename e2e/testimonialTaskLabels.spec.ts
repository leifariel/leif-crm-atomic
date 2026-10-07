import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// The production failure, reproduced at full fidelity.
//
// Leif read "collect_testimonial" on Enrollment 48 while the deployed bundle
// demonstrably contained "Ask for testimonial". The runtime task vocabulary
// is not the one a release ships: useConfigurationContext reads
// app.configuration out of the persisted store and merges it over
// defaultConfiguration ONE KEY DEEP, and useConfigurationLoader fills that
// store from the `configuration` singleton row. `taskTypes` is one of those
// keys, so a vocabulary saved before a release replaces that release's
// wholesale and every type added since is simply absent from it.
//
// This file is the only environment where that whole chain actually runs.
// The vitest harness replaces the Layout that useConfigurationLoader lives
// in, so no component test there can load a saved configuration at all —
// measured, and the reason the suite was green while production was not.
// Here the real app, the real Layout, the real loader and the real store all
// run against a `configuration` row this spec writes.
//
// `configuration` is NOT emptied by resetDb (it is a singleton, not business
// data), so this spec puts it back the way it found it.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const LE_OFFER = 1;
const BASE = 988000;
const AT = "2026-09-01T00:00:00.000Z";

/** The vocabulary as saved before the testimonial stages existed. */
const SAVED_BEFORE_THIS_RELEASE = [
  { value: "sales_call", label: "Sales Call" },
  { value: "follow_up", label: "Follow-up" },
  { value: "review_application", label: "Review Application" },
  { value: "onboarding_item", label: "Onboarding" },
  { value: "offboarding_item", label: "Offboarding" },
  { value: "other", label: "Other" },
];

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const STAGES = [
  {
    type: "collect_testimonial",
    label: "Ask for testimonial",
    text: "Collect Layout Probe's testimonial",
  },
  {
    type: "testimonial_followup_1",
    label: "Testimonial follow-up",
    text: "Follow up for Layout Probe's testimonial — 1/2",
  },
  {
    type: "testimonial_followup_2",
    label: "Final testimonial follow-up",
    text: "Follow up for Layout Probe's testimonial — 2/2",
  },
];

/** Put the saved vocabulary in place, exactly as the Settings page would. */
const saveStaleConfiguration = async () => {
  const client = db();
  const { error } = await client
    .from("configuration")
    .upsert({ id: 1, config: { taskTypes: SAVED_BEFORE_THIS_RELEASE } });
  if (error) throw new Error(`could not save configuration: ${error.message}`);
};

const restoreConfiguration = async () => {
  await db().from("configuration").upsert({ id: 1, config: {} });
};

/**
 * An offboarding Living Example client carrying all three stage tasks in the
 * shape reconcile_testimonial_tasks() writes them.
 */
const seed = async (salesId: number) => {
  const client = db();
  await client.from("contacts").insert({
    id: BASE + 1,
    first_name: "Layout",
    last_name: "Probe",
    email_jsonb: [{ email: "label.probe@example.com", type: "Work" }],
    phone_jsonb: [],
    tags: [],
    sales_eligibility: "normal",
    first_seen: AT,
    last_seen: AT,
  });
  await client.from("deals").insert({
    id: BASE + 1,
    name: "Layout Probe — The Living Example",
    contact_id: BASE + 1,
    offer_id: LE_OFFER,
    stage: "won",
    amount: 4000,
    index: 0,
    created_at: AT,
    updated_at: AT,
    stage_entered_at: AT,
  });
  const e = await client
    .from("enrollments")
    .select("id")
    .eq("opportunity_id", BASE + 1)
    .single();
  if (e.error) throw new Error(`no enrollment: ${e.error.message}`);
  const enrollmentId = e.data.id as number;

  await client
    .from("enrollment_onboarding_items")
    .update({ status: "done" })
    .eq("enrollment_id", enrollmentId);
  await client
    .from("enrollments")
    .update({ status: "active" })
    .eq("id", enrollmentId);
  await client
    .from("enrollments")
    .update({ status: "offboarding" })
    .eq("id", enrollmentId);

  // Entering offboarding already made Day 0 through the engine — the real
  // row, with the engine's own text. Only the two follow-ups are stated
  // here, so all three stages are on screen at once, which the engine
  // deliberately never does (Day 7 waits on Day 0 being ticked off).
  // tasks_one_testimonial_stage_per_enrollment is what refuses a second
  // Day 0, and this spec respects it rather than working around it.
  const { error } = await client.from("tasks").insert(
    STAGES.filter((s) => s.type !== "collect_testimonial").map((stage, i) => ({
      id: BASE + 10 + i,
      contact_id: BASE + 1,
      enrollment_id: enrollmentId,
      type: stage.type,
      text: stage.text,
      due_date: "2026-09-02T00:00:00.000Z",
      status: "pending",
      sales_id: salesId,
    })),
  );
  if (error) throw new Error(`could not insert tasks: ${error.message}`);

  // The engine assigns Day 0 to the first administrator; the Dashboard lists
  // the signed-in owner's own tasks, so point every stage at this test's
  // owner rather than inventing a second Day 0.
  const owned = await client
    .from("tasks")
    .update({ sales_id: salesId, due_date: "2026-09-02T00:00:00.000Z" })
    .eq("enrollment_id", enrollmentId)
    .in(
      "type",
      STAGES.map((s) => s.type),
    )
    .select("id");
  if (owned.error)
    throw new Error(`could not own tasks: ${owned.error.message}`);
  if ((owned.data ?? []).length !== STAGES.length) {
    throw new Error(
      `expected ${STAGES.length} stage tasks, found ${(owned.data ?? []).length}`,
    );
  }
  return enrollmentId;
};

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

type CreateSales = (sales: {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
}) => Promise<unknown>;

const signedInOwner = async (page: Page, createSales: CreateSales) => {
  const email = `owner.labels.${Date.now()}@example.com`;
  await createSales({
    first_name: "Leif",
    last_name: "Owner",
    email,
    password: PASSWORD,
  });
  const sales = await db()
    .from("sales")
    .select("id")
    .eq("email", email)
    .single();
  if (sales.error) throw new Error(`no sales row: ${sales.error.message}`);
  const enrollmentId = await seed(sales.data.id as number);
  await signIn(page, email);
  return enrollmentId;
};

test.describe("testimonial task labels under a configuration saved before this release", () => {
  test.beforeEach(saveStaleConfiguration);
  test.afterEach(restoreConfiguration);

  test("the Enrollment page names every stage", async ({
    page,
    createSales,
  }) => {
    const enrollmentId = await signedInOwner(page, createSales);
    await page.goto(`/#/enrollments/${enrollmentId}/show`);
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

    // The saved vocabulary really is in effect: a type it DOES define reads
    // from it. Without this the test could pass on a page that never loaded
    // the configuration at all.
    await expect(
      page.getByText("Offboarding", { exact: true }).first(),
    ).toBeVisible();

    for (const stage of STAGES) {
      await expect(
        page.getByText(stage.label, { exact: true }).first(),
      ).toBeVisible();
      await expect(page.getByText(stage.type)).toHaveCount(0);
    }
  });

  test("the Dashboard names every stage, with the person", async ({
    page,
    createSales,
  }) => {
    await signedInOwner(page, createSales);
    await page.goto("/#/");
    await expect(page.getByText("Business at a Glance")).toBeVisible();

    for (const stage of STAGES) {
      await expect(
        page.getByText(`${stage.label}:`, { exact: true }).first(),
      ).toBeVisible();
      await expect(page.getByText(stage.type)).toHaveCount(0);
    }
    await expect(page.getByText("Layout Probe").first()).toBeVisible();
  });
});
