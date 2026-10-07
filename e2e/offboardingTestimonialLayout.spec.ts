import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// Geometry, against the real built CSS.
//
// The testimonial used to be its own card floating beneath the offboarding
// checklist, with its own Card padding and a gap above it — a slab that said,
// wrongly, that asking for a testimonial is a separate concern from winding a
// client down. It is now a row inside that one container.
//
// This file is the only place that shape can honestly be checked: the vitest
// browser project has no Tailwind plugin, so every utility class is inert
// there and a pixel assertion would measure the user agent instead. The
// structural half (same container, no nested card, denominator untouched) is
// also asserted in enrollments/testimonialRow.test.tsx; what is here is what
// only real CSS can answer — the divider, the gap, the alignment, the phone.
//
// Each assertion below fails against the previous layout, where the row was a
// sibling Card: it had no divider above it, it was separated by a gap plus two
// lots of card padding, and it was not inside the checklist's container at all.
//
// resetDb (an automatic fixture) empties contacts/deals/enrollments/tasks
// before every test. The Offer is configured here because `offers` is
// deliberately NOT truncated.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const LE_OFFER = 1;
const BASE = 989000;
const AT = "2026-09-01T00:00:00.000Z";

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/** An offboarding Living Example client, so the checklist and the row render. */
const seed = async () => {
  const client = db();

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
    email_jsonb: [{ email: "offboarding.probe@example.com", type: "Work" }],
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

type CreateSales = (sales: {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
}) => Promise<unknown>;

const openEnrollment = async (page: Page, createSales: CreateSales) => {
  const enrollmentId = await seed();
  const email = `owner.offb.${Date.now()}@example.com`;
  await createSales({
    first_name: "Leif",
    last_name: "Owner",
    email,
    password: PASSWORD,
  });
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
  await page.goto(`/#/enrollments/${enrollmentId}/show`);
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(page.getByTestId("testimonial-row")).toBeVisible();
};

/**
 * Everything the assertions need, measured in one pass against the real
 * built CSS: where the testimonial row and the requirement row sit, whether
 * they share a container, and what the browser actually computed for the
 * divider.
 */
const measure = (page: Page) =>
  page.evaluate(() => {
    const row = document.querySelector('[data-testid="testimonial-row"]')!;
    const rowBox = row.getBoundingClientRect();
    const style = getComputedStyle(row);

    // The requirement row: the checkbox's row inside the same column.
    const checkbox = document.querySelector('[role="checkbox"][class*="peer"]');
    const requirement =
      [...document.querySelectorAll('[role="checkbox"]')]
        .map((c) => c.parentElement)
        .find((r) => r && r.parentElement === row.parentElement) ?? null;
    void checkbox;

    const card = row.closest('[data-slot="card"]');
    const cardBox = card?.getBoundingClientRect() ?? null;
    const content = row.closest('[data-slot="card-content"]');
    const contentStyle = content ? getComputedStyle(content) : null;

    const cardsMentioningTestimonial = [
      ...document.querySelectorAll('[data-slot="card"]'),
    ].filter((c) => (c.textContent ?? "").includes("Testimonial")).length;

    return {
      row: {
        top: rowBox.top,
        left: rowBox.left,
        right: rowBox.right,
        width: rowBox.width,
        height: rowBox.height,
        borderTopWidth: parseFloat(style.borderTopWidth),
        paddingTop: parseFloat(style.paddingTop),
      },
      requirement: requirement
        ? (() => {
            const b = requirement.getBoundingClientRect();
            const rs = getComputedStyle(requirement);
            return {
              top: b.top,
              bottom: b.bottom,
              left: b.left,
              right: b.right,
              // Tailwind v4's divide-y draws the rule on the BOTTOM of every
              // child except the last, so the divider above the testimonial
              // row belongs to this requirement row.
              borderBottomWidth: parseFloat(rs.borderBottomWidth),
              borderBottomStyle: rs.borderBottomStyle,
            };
          })()
        : null,
      sharesCardWithRequirement:
        !!requirement && requirement.closest('[data-slot="card"]') === card,
      card: cardBox
        ? { left: cardBox.left, right: cardBox.right, height: cardBox.height }
        : null,
      contentPaddingRight: contentStyle
        ? parseFloat(contentStyle.paddingRight)
        : null,
      cardsMentioningTestimonial,
      // A nested card between the row and the shared container would show up
      // here as a card that is a descendant of `card` and an ancestor of the
      // row.
      nestedCardAroundRow:
        row.parentElement?.closest('[data-slot="card"]') !== card,
      documentScrollWidth: document.documentElement.scrollWidth,
    };
  });

test.describe("the Offboarding container holds the testimonial", () => {
  test("desktop: one container, a real divider, no slab gap, aligned action", async ({
    page,
    createSales,
  }) => {
    test.skip(
      test.info().project.name !== "chromium",
      "desktop geometry runs on the desktop project",
    );

    await openEnrollment(page, createSales);
    const m = await measure(page);

    // ONE container. Exactly one card mentions the testimonial, and the
    // requirement row is inside it too. Previously there were two.
    expect(m.cardsMentioningTestimonial).toBe(1);
    expect(m.requirement, "the requirement row was measured").not.toBeNull();
    expect(m.sharesCardWithRequirement).toBe(true);
    expect(m.nestedCardAroundRow).toBe(false);

    // A real divider between the two rows, drawn by the container own
    // divide-y. Tailwind v4 puts it on the BOTTOM of every child but the
    // last, so it belongs to the requirement row and the testimonial row —
    // being last — correctly carries none. Two sibling cards had no divider
    // at all, just a gap.
    expect(m.requirement!.borderBottomWidth).toBeGreaterThanOrEqual(1);
    expect(m.requirement!.borderBottomStyle).not.toBe("none");
    expect(m.row.borderTopWidth).toBe(0);

    // No slab gap: the row begins immediately below the requirement row.
    // Two stacked cards put a gap plus two lots of card padding here.
    const gap = m.row.top - m.requirement!.bottom;
    expect(gap, `gap above the testimonial row was ${gap}px`).toBeLessThan(8);
    expect(gap).toBeGreaterThanOrEqual(0);

    // Modest row padding, in the checklist's own rhythm rather than a card's.
    expect(m.row.paddingTop).toBeLessThanOrEqual(12);

    // Left-aligned with the requirement row above it.
    expect(Math.abs(m.row.left - m.requirement!.left)).toBeLessThanOrEqual(1);

    // The action sits at the right-hand end of the row, inside the container.
    const mark = page.getByRole("button", {
      name: "Mark testimonial received",
    });
    const markBox = (await mark.boundingBox())!;
    expect(markBox.x).toBeGreaterThan(m.row.left + m.row.width / 2);
    expect(markBox.x + markBox.width).toBeLessThanOrEqual(m.row.right + 1);
    expect(markBox.y).toBeGreaterThanOrEqual(m.row.top - 1);
    expect(markBox.y + markBox.height).toBeLessThanOrEqual(
      m.row.top + m.row.height + 1,
    );
  });

  test("Pixel 5: the action stacks below, nothing overflows", async ({
    page,
    createSales,
  }) => {
    const width = 393;
    await page.setViewportSize({ width, height: 851 });
    await openEnrollment(page, createSales);
    const m = await measure(page);

    expect(m.cardsMentioningTestimonial).toBe(1);
    expect(m.sharesCardWithRequirement).toBe(true);
    expect(m.requirement!.borderBottomWidth).toBeGreaterThanOrEqual(1);
    expect(m.documentScrollWidth).toBeLessThanOrEqual(width);
    expect(m.row.left).toBeGreaterThanOrEqual(0);
    expect(m.row.right).toBeLessThanOrEqual(width);

    // Status readable, action below it rather than crushed beside it.
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

  test("the denominator still counts only the real requirement", async ({
    page,
    createSales,
  }) => {
    // Visual grouping must not change domain semantics: LE raises exactly
    // one offboarding requirement, and the testimonial is not one of them.
    await openEnrollment(page, createSales);

    await expect(page.getByText("Offboarding 0/1")).toBeVisible();
    await expect(page.getByText("Offboarding 0/2")).toHaveCount(0);
  });
});
