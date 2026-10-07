import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// Geometry, against the real built CSS.
//
// The vitest browser project has no Tailwind plugin, so every utility class
// is inert there and a layout assertion measures the user agent instead.
// This file is the only place the card's SHAPE can honestly be checked.
//
// What was wrong: Card already carries py-6, and TestimonialCard added py-3
// to its CardContent on top of that, so it stood taller than every sibling
// on the page — an empty slab with two short lines floating in it. So the
// assertion here is NOT a height ceiling (the broken card was only ~24px
// taller, and any ceiling loose enough to be stable would have passed on
// it too). It measures the inset itself: the distance from the card's top
// edge to its first line of text, compared against a sibling card's. That
// number was 36px and had to be 24px.
//
// resetDb (an automatic fixture) empties contacts/deals/enrollments/tasks
// before every test, so this file needs no cleanup of its own. It does have
// to configure the Offer, because `offers` is deliberately NOT truncated.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const LE_OFFER = 1;
const BASE = 987000;
const AT = "2026-09-01T00:00:00.000Z";

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/** An offboarding Living Example client, so the card and its siblings render. */
const seed = async () => {
  const client = db();

  // The card renders only for a programme that asks. Set explicitly rather
  // than inherited from whatever an earlier spec left on the row.
  await client
    .from("offers")
    .update({
      collects_testimonial: true,
      testimonial_activated_at: new Date(
        Date.now() - 365 * 86400000,
      ).toISOString(),
    })
    .eq("id", LE_OFFER);

  await client.from("contacts").insert({
    id: BASE + 1,
    first_name: "Layout",
    last_name: "Probe",
    email_jsonb: [{ email: "layout.probe@example.com", type: "Work" }],
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

  // handle_deal_won() already created the Enrollment.
  const e = await client
    .from("enrollments")
    .select("id")
    .eq("opportunity_id", BASE + 1)
    .single();
  if (e.error) throw new Error(`no enrollment: ${e.error.message}`);
  const id = e.data.id as number;

  await client
    .from("enrollment_onboarding_items")
    .update({ status: "done" })
    .eq("enrollment_id", id);
  await client.from("enrollments").update({ status: "active" }).eq("id", id);
  await client
    .from("enrollments")
    .update({ status: "offboarding" })
    .eq("id", id);
  return id;
};

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

const openEnrollment = async (page: Page, createSales: CreateSales) => {
  const enrollmentId = await seed();
  const email = `owner.layout.${Date.now()}@example.com`;
  await createSales({
    first_name: "Leif",
    last_name: "Owner",
    email,
    password: PASSWORD,
  });
  await signIn(page, email);
  await page.goto(`/#/enrollments/${enrollmentId}/show`);
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
};

type CreateSales = (sales: {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
}) => Promise<unknown>;

/**
 * For every card on the page: its height, and the inset from its top edge
 * to the top of its first line of text. Measured from the real built CSS.
 */
const measureCards = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="card"]')].map((card) => {
      const box = card.getBoundingClientRect();
      const content = card.querySelector('[data-slot="card-content"]');
      const first = content?.querySelector("span, p, h1, h2, h3, div");
      const firstBox = first?.getBoundingClientRect();
      return {
        text: (card.textContent ?? "").trim().slice(0, 60),
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        inset: firstBox ? firstBox.top - box.top : null,
      };
    }),
  );

test.describe("Testimonial card layout", () => {
  test("is inset like every other card, not a slab of its own", async ({
    page,
    createSales,
  }) => {
    test.skip(
      test.info().project.name !== "chromium",
      "desktop geometry runs on the desktop project",
    );

    await openEnrollment(page, createSales);

    const card = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Testimonial" })
      .first();
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();

    const cards = await measureCards(page);
    const mine = cards.find((c) => c.text.startsWith("Testimonial"));
    expect(mine, "the Testimonial card is on the page").toBeTruthy();
    expect(mine!.inset, "its first line was measured").not.toBeNull();

    // Every other card that has a measurable inset. There must be some —
    // an assertion with nothing to compare against proves nothing.
    const others = cards.filter((c) => c !== mine && c.inset != null);
    expect(
      others.length,
      "there are sibling cards to compare against",
    ).toBeGreaterThan(0);

    // THE assertion. 24px (Card's own py-6) on every card, including this
    // one. The broken version measured 36px here.
    for (const other of others) {
      expect(
        Math.abs(mine!.inset! - other.inset!),
        `inset ${mine!.inset} vs ${other.inset} on "${other.text}"`,
      ).toBeLessThanOrEqual(1);
    }

    // Same column as its siblings: one rhythm, not a one-off.
    const aligned = others.filter(
      (o) =>
        Math.abs(o.left - mine!.left) <= 1 &&
        Math.abs(o.width - mine!.width) <= 1,
    );
    expect(
      aligned.length,
      "shares a column with a sibling card",
    ).toBeGreaterThan(0);

    // The action sits on the right-hand end, vertically inside the card.
    const mark = page.getByRole("button", {
      name: "Mark testimonial received",
    });
    const markBox = (await mark.boundingBox())!;
    expect(markBox.x).toBeGreaterThan(mine!.left + mine!.width / 2);
    expect(markBox.x + markBox.width).toBeLessThanOrEqual(
      mine!.left + mine!.width,
    );
    expect(markBox.y).toBeGreaterThanOrEqual(mine!.top - 1);
    expect(markBox.y + markBox.height).toBeLessThanOrEqual(
      mine!.top + mine!.height + 1,
    );
  });

  test("stacks rather than squeezes on a Pixel 5", async ({
    page,
    createSales,
  }) => {
    const width = 393;
    await page.setViewportSize({ width, height: 851 });
    await openEnrollment(page, createSales);

    const card = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Testimonial" })
      .first();
    await card.scrollIntoViewIfNeeded();
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);

    // No horizontal page overflow anywhere.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);

    // Status and action both readable, and the action is BELOW the status
    // rather than crushed beside it at this width (flex-col until sm:).
    const status = page.getByText("Not received");
    await expect(status).toBeVisible();
    const statusBox = (await status.boundingBox())!;

    const mark = page.getByRole("button", {
      name: "Mark testimonial received",
    });
    await expect(mark).toBeVisible();
    const markBox = (await mark.boundingBox())!;
    expect(markBox.y).toBeGreaterThanOrEqual(statusBox.y + statusBox.height);
    expect(markBox.x).toBeGreaterThanOrEqual(0);
    expect(markBox.x + markBox.width).toBeLessThanOrEqual(width);
    // A tappable target, not a hairline.
    expect(markBox.height).toBeGreaterThan(24);
    await mark.click({ trial: true });
  });
});
