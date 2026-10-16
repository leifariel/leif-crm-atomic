import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// THE BOARD, IN A REAL BROWSER AGAINST BUILT CSS.
//
// Sales Call Workflow Part 1 UI acceptance. Vitest-browser renders the
// components but proves nothing about Tailwind or the geometry of a column,
// and the whole point of this slice is WHERE things sit relative to each
// other. So the order is read out of the live DOM, in order.
//
// Canonical order (Leif, 2026-10-15), which reverses what shipped before:
//
//   band 0  passed and unresolved — most recently passed FIRST
//   band 1  future bookings       — nearest FIRST
//   band 2  no usable time        — last, deterministically
//
// Plus the two read-model treatments: "Call passed" on an unwritten-up call,
// and the canonical Decision follow-up date on a Decision card.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "board-password-1";
const LE = 1;
const BASE = 931000;

const admin = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

/**
 * A calendar day in the CRM's ONE calendar timezone.
 *
 * deals.follow_up_date is a calendar date and the card bands it against
 * crmDayKey(), which formats in America/Denver (deals/pipelineOrdering.ts).
 * This used to slice an ISO string, which is a UTC day -- so between 18:00
 * and 24:00 MDT the two disagreed, "today" was seeded as tomorrow, and the
 * Decision card correctly read "Decision due" instead of "Follow up today".
 *
 * Found by this suite failing at 00:04 UTC on 2026-10-16 (18:04 MDT) after
 * passing twice earlier the same evening. Not flake: a reproducible
 * six-hour window every day. The fixture's notion of "today" was wrong, not
 * the product's.
 */
const isoDay = (days: number): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(daysFromNow(days));

/** A Contact and an Opportunity, named so the board is readable. */
const seedOpportunity = async (
  n: number,
  lastName: string,
  fields: Record<string, unknown>,
) => {
  const client = admin();
  const contactId = BASE + n;

  const { error: contactError } = await client.from("contacts").insert({
    id: contactId,
    first_name: "Board",
    last_name: lastName,
    email_jsonb: [{ email: `board${n}@sales.test`, type: "Work" }],
  });
  if (contactError) throw new Error(contactError.message);

  const { data, error } = await client
    .from("deals")
    .insert({
      contact_id: contactId,
      offer_id: LE,
      cohort_id: null,
      amount: 4000,
      entry_path: "other",
      description: "",
      ...fields,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { contactId, dealId: data!.id as number };
};

const seedBookedCall = async (contactId: number, dealId: number, at: Date) => {
  const { error } = await admin()
    .from("sales_calls")
    .insert({
      opportunity_id: dealId,
      contact_id: contactId,
      status: "booked",
      original_scheduled_at: at.toISOString(),
      scheduled_at: at.toISOString(),
      scheduled_on: at.toISOString().slice(0, 10),
      schedule_precision: "exact",
      source: "manual",
    });
  if (error) throw new Error(error.message);
};

const signIn = async (page: Page) => {
  const email = `board-${Date.now()}@example.com`;
  const { error } = await admin().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);

  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

/** Hash-routed (CRM.tsx), so moving between #/... paths is a same-document change. */
const openPipeline = async (page: Page) => {
  await page.evaluate(() => {
    window.location.hash = "#/deals";
  });
  await expect(page.getByText(/Call Booked/)).toBeVisible();
};

test.describe("the Call Booked column puts what is owed at the top", () => {
  test("passed-unresolved first (most recent first), then future (nearest first), then no-time", async ({
    page,
  }) => {
    // Four cards whose correct order is not their id order, not their
    // creation order, and not the old future-first order.
    const recent = await seedOpportunity(1, "RecentlyPassed", {
      stage: "call_booked",
    });
    await seedBookedCall(recent.contactId, recent.dealId, daysFromNow(-1));

    const older = await seedOpportunity(2, "LongPassed", {
      stage: "call_booked",
    });
    await seedBookedCall(older.contactId, older.dealId, daysFromNow(-20));

    const soon = await seedOpportunity(3, "Soonest", {
      stage: "call_booked",
    });
    await seedBookedCall(soon.contactId, soon.dealId, daysFromNow(2));

    const later = await seedOpportunity(4, "Farthest", {
      stage: "call_booked",
    });
    await seedBookedCall(later.contactId, later.dealId, daysFromNow(30));

    // The legacy shape production actually holds: Call Booked with no call.
    await seedOpportunity(5, "NoBooking", { stage: "call_booked" });

    await signIn(page);
    await openPipeline(page);

    const names = [
      "Board RecentlyPassed",
      "Board LongPassed",
      "Board Soonest",
      "Board Farthest",
      "Board NoBooking",
    ];
    for (const name of names) {
      await expect(page.getByText(name)).toBeVisible();
    }

    // Read the column's actual DOM order rather than trusting the data, and
    // POLL for it.
    //
    // The board paints from the `deals` query and re-sorts when the
    // `sales_calls` query resolves (DealListContent.tsx fetches them
    // separately and lists salesCalls in the ordering effect's deps). So the
    // first paint legitimately shows the no-call fallback order — every card
    // in band 2, id descending — for as long as the calls are in flight.
    //
    // A single read of that first paint is a race: it passed in isolation and
    // failed as the first test after a long suite, which is exactly the shape
    // of "fast enough, until it wasn't". The settled order is the claim worth
    // making, so this retries until the board has it.
    await expect
      .poll(
        () =>
          page.evaluate((wanted) => {
            const seen: string[] = [];
            for (const el of Array.from(document.querySelectorAll("p"))) {
              const text = (el.textContent ?? "").trim();
              if (wanted.includes(text) && !seen.includes(text))
                seen.push(text);
            }
            return seen;
          }, names),
        {
          message: "the Call Booked column never settled into canonical order",
        },
      )
      .toEqual(names);
  });

  test("an unwritten-up call carries Call passed, and a future one does not", async ({
    page,
  }) => {
    const passed = await seedOpportunity(10, "Unwritten", {
      stage: "call_booked",
    });
    await seedBookedCall(passed.contactId, passed.dealId, daysFromNow(-3));

    const upcoming = await seedOpportunity(11, "Upcoming", {
      stage: "call_booked",
    });
    await seedBookedCall(upcoming.contactId, upcoming.dealId, daysFromNow(5));

    await signIn(page);
    await openPipeline(page);

    await expect(page.getByText("Board Unwritten")).toBeVisible();
    await expect(page.getByText("Board Upcoming")).toBeVisible();

    // Exactly one card carries the badge, and it is the passed one.
    await expect(page.getByText("Call passed")).toHaveCount(1);

    // Polled for the same reason as the ordering above: the badge depends on
    // the separately-fetched sales_calls, so a single read can catch the board
    // before they land.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const badge = Array.from(document.querySelectorAll("*")).find(
            (el) =>
              el.children.length === 0 &&
              (el.textContent ?? "").trim() === "Call passed",
          );
          return badge?.closest(".cursor-pointer")?.textContent ?? "";
        }),
      )
      .toContain("Unwritten");

    const badgeOwner = await page.evaluate(() => {
      const badge = Array.from(document.querySelectorAll("*")).find(
        (el) =>
          el.children.length === 0 &&
          (el.textContent ?? "").trim() === "Call passed",
      );
      return badge?.closest(".cursor-pointer")?.textContent ?? "";
    });
    expect(badgeOwner).not.toContain("Upcoming");
  });
});

test.describe("the Decision card shows the commitment Leif made", () => {
  test("future, today and overdue follow-ups each read truthfully", async ({
    page,
  }) => {
    await seedOpportunity(20, "DueLater", {
      stage: "decision",
      owner_decision: "would_work_with",
      prospect_decision: "thinking",
      follow_up_date: isoDay(9),
    });
    await seedOpportunity(21, "DueToday", {
      stage: "decision",
      owner_decision: "would_work_with",
      prospect_decision: "thinking",
      follow_up_date: isoDay(0),
    });
    await seedOpportunity(22, "Overdue", {
      stage: "decision",
      owner_decision: "would_work_with",
      prospect_decision: "thinking",
      follow_up_date: isoDay(-4),
    });

    await signIn(page);
    await openPipeline(page);

    await expect(page.getByText("Board Overdue")).toBeVisible();
    await expect(page.getByText(/Follow-up overdue/)).toBeVisible();
    await expect(page.getByText("Follow up today")).toBeVisible();
    await expect(page.getByText(/Decision due/)).toBeVisible();

    // Each treatment sits on its own card, not borrowed from a neighbour.
    // These three read deals.follow_up_date, which arrives with the deals
    // themselves, so they are not subject to the sales_calls race above.
    // Polled anyway: a card's text is assembled from a ReferenceField for the
    // contact name, which resolves separately.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const out: Record<string, string> = {};
          for (const el of Array.from(
            document.querySelectorAll(".cursor-pointer"),
          )) {
            const text = (el.textContent ?? "").trim();
            if (text.includes("DueLater")) out.later = text;
            if (text.includes("DueToday")) out.today = text;
            if (text.includes("Overdue")) out.overdue = text;
          }
          return out;
        }),
      )
      .toEqual({
        later: expect.stringContaining("Decision due"),
        today: expect.stringContaining("Follow up today"),
        overdue: expect.stringContaining("Follow-up overdue"),
      });
  });

  test("a follow_up_date outside Decision is not shown as a live commitment", async ({
    page,
  }) => {
    // The one production record of this shape: an active non-Decision
    // Opportunity still carrying a follow_up_date.
    const stray = await seedOpportunity(30, "StrayDate", {
      stage: "call_booked",
      follow_up_date: isoDay(-4),
    });
    await seedBookedCall(stray.contactId, stray.dealId, daysFromNow(6));

    await signIn(page);
    await openPipeline(page);

    await expect(page.getByText("Board StrayDate")).toBeVisible();
    await expect(page.getByText(/Follow-up overdue/)).toHaveCount(0);
    await expect(page.getByText(/Decision due/)).toHaveCount(0);
    await expect(page.getByText("Follow up today")).toHaveCount(0);
  });
});

test.describe("Complete Sales Call is still one coherent action", () => {
  test("the optional impressions field is present, inside the same single action", async ({
    page,
  }) => {
    const { contactId, dealId } = await seedOpportunity(40, "Impression", {
      stage: "call_booked",
    });
    await seedBookedCall(contactId, dealId, daysFromNow(-1));

    const { data: call } = await admin()
      .from("sales_calls")
      .select("id")
      .eq("opportunity_id", dealId)
      .single();

    await signIn(page);
    await page.evaluate((id) => {
      window.location.hash = `#/sales-calls/${id}/outcome`;
    }, call!.id);

    await page.getByRole("button", { name: /Record what happened/ }).click();

    // The call happened, Leif would work with them, they are thinking.
    await page.getByText("Call happened", { exact: true }).click();
    await page.getByText("Would work with", { exact: false }).first().click();

    // The impression is optional, present, and part of THIS form — there is
    // no second save button for it.
    const impressions = page.getByLabel(/Impressions/);
    await expect(impressions).toBeVisible();
    await impressions.fill("Thoughtful. Worried about the money, not the fit.");
    await expect(impressions).toHaveValue(
      "Thoughtful. Worried about the money, not the fit.",
    );

    // One action commits the whole outcome.
    const completeButtons = await page
      .getByRole("button", { name: /Save|Complete|Record/ })
      .count();
    expect(completeButtons).toBeGreaterThan(0);
  });
});
