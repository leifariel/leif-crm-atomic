import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// SYSTEM GREEN for Add to Waitlist, email first.
//
// The whole chain, nothing stubbed: real browser, real production build
// (so Tailwind is actually applied — the vitest browser project has no
// Tailwind plugin, which makes every utility class inert there and layout
// assertions meaningless), real UI interaction, real data provider, real
// Postgres, and an INDEPENDENT SQL read-back of what was written.
//
// It also runs the modal at phone width, because the workflow this exists
// for is pasting an address out of Instagram, which happens on a phone.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const LE_OFFER = 1;
const EXISTING_CONTACT_ID = 970001;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const NEW_EMAIL = "waitlist.newcomer@example.com";
const EXISTING_EMAIL = "already.known@example.com";

// Identified by the names this spec creates and by its own out-of-range
// id, rather than by a generated search column, so teardown cannot depend
// on how search happens to be implemented.
const cleanup = async () => {
  const client = db();
  const { data: contacts } = await client
    .from("contacts")
    .select("id")
    .or(`id.eq.${EXISTING_CONTACT_ID},first_name.eq.Newcomer`);
  const ids = (contacts ?? []).map((row) => row.id);
  if (ids.length > 0) {
    await client.from("waitlist_entries").delete().in("contact_id", ids);
    await client.from("contacts").delete().in("id", ids);
  }
};

const seedExistingPerson = async () => {
  const client = db();
  const { error } = await client.from("contacts").insert({
    id: EXISTING_CONTACT_ID,
    first_name: "Already",
    last_name: "Known",
    email_jsonb: [{ email: EXISTING_EMAIL, type: "Work" }],
    phone_jsonb: [],
    tags: [],
    sales_eligibility: "normal",
    first_seen: "2026-01-01T00:00:00.000Z",
    last_seen: "2026-01-01T00:00:00.000Z",
  });
  if (error) throw new Error(`seed failed: ${error.message}`);
};

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

const openTheModal = async (page: Page) => {
  // Hash-routed (CRM.tsx).
  await page.goto(`/#/programs/individual/${LE_OFFER}`);
  await page.getByRole("button", { name: "Add to Waitlist" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
};

test.describe("Add to Waitlist — email first, against real Postgres", () => {
  test.beforeEach(async () => {
    await cleanup();
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test("one action creates the person with their email and their waitlist place", async ({
    page,
    createSales,
  }) => {
    const owner = `owner.waitlist.${Date.now()}@example.com`;
    await createSales({
      first_name: "Leif",
      last_name: "Owner",
      email: owner,
      password: PASSWORD,
    });
    await signIn(page, owner);
    await openTheModal(page);

    // The field the modal opens on already holds focus, so a paste lands
    // in the right place without clicking anything.
    await expect(page.getByLabel("Email")).toBeFocused();

    await page.getByLabel("Email").fill(NEW_EMAIL);
    await page.getByLabel("Name").fill("Newcomer From Instagram");
    await page.getByRole("button", { name: "Add to waitlist" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible();

    // INDEPENDENT read-back: not the UI's word for it.
    const client = db();
    const { data: contacts } = await client
      .from("contacts")
      .select("id, first_name, last_name, email_jsonb")
      .eq("first_name", "Newcomer");
    expect(contacts).toHaveLength(1);
    const created = contacts![0];
    expect(created.last_name).toBe("From Instagram");
    // Created WITH the address — never the empty email_jsonb the previous
    // flow produced and then asked about afterwards.
    expect(
      (created.email_jsonb as { email: string }[]).map((e) => e.email),
    ).toEqual([NEW_EMAIL]);

    const { data: entries } = await client
      .from("waitlist_entries")
      .select("id, contact_id, offer_id, cohort_id, status, source")
      .eq("contact_id", created.id);
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      offer_id: LE_OFFER,
      cohort_id: null,
      status: "waiting",
      source: "manual",
    });
  });

  test("an address the CRM already has offers that person instead of a second record", async ({
    page,
    createSales,
  }) => {
    await seedExistingPerson();
    const owner = `owner.waitlist.${Date.now()}@example.com`;
    await createSales({
      first_name: "Leif",
      last_name: "Owner",
      email: owner,
      password: PASSWORD,
    });
    await signIn(page, owner);
    await openTheModal(page);

    // Typed in a different case, because identity is the NORMALIZED
    // address, not the characters.
    await page.getByLabel("Email").fill(EXISTING_EMAIL.toUpperCase());
    await page.getByLabel("Name").click();

    await expect(page.getByText("Existing contact found")).toBeVisible();
    await expect(
      page.getByText("Already Known", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Use this contact" }).click();

    await expect(page.getByRole("dialog")).not.toBeVisible();

    const client = db();
    const { data: entries } = await client
      .from("waitlist_entries")
      .select("id, contact_id")
      .eq("contact_id", EXISTING_CONTACT_ID);
    expect(entries).toHaveLength(1);

    // And no duplicate person was created for the same address.
    const { data: duplicates } = await client
      .from("contacts")
      .select("id")
      .eq("last_name", "Known");
    expect(duplicates).toHaveLength(1);
  });

  test("is usable at phone width, which is where a pasted address comes from", async ({
    page,
    createSales,
  }) => {
    const owner = `owner.waitlist.${Date.now()}@example.com`;
    await createSales({
      first_name: "Leif",
      last_name: "Owner",
      email: owner,
      password: PASSWORD,
    });
    // Pixel-5 sized, the same viewport the client UX repair used.
    await page.setViewportSize({ width: 393, height: 851 });
    await signIn(page, owner);
    await openTheModal(page);

    const dialog = page.getByRole("dialog");
    const box = (await dialog.boundingBox())!;
    // Inside the viewport with a real gutter, not clipped off the side.
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(393);

    // Both fields are actually reachable and tappable, not overlapping or
    // collapsed to nothing — the failure mode a Tailwind-less unit test
    // cannot see.
    for (const label of ["Email", "Name"]) {
      const field = page.getByLabel(label);
      await expect(field).toBeVisible();
      const fieldBox = (await field.boundingBox())!;
      expect(fieldBox.height).toBeGreaterThan(24);
      expect(fieldBox.width).toBeGreaterThan(200);
    }

    const submit = page.getByRole("button", { name: "Add to waitlist" });
    await expect(submit).toBeVisible();
    const submitBox = (await submit.boundingBox())!;
    expect(submitBox.height).toBeGreaterThan(24);
    // It is really the top element at its own centre, so nothing invisible
    // is sitting over it.
    await submit.click({ trial: true });
  });
});
