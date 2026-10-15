import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// EDITING A RECORDED RESULT, IN A REAL BROWSER AGAINST BUILT CSS.
//
// Sales Call Workflow Part 2 UI acceptance. The database half is proven in
// correctingARecordedResult.spec.ts; what this proves is the part only a
// real browser can: that Leif can FIND the edit, that it opens on the
// episode's own recorded facts rather than a blank form, that the three
// impressions answers are reachable from the one textarea, and that a
// refused correction says why instead of pretending to work.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "edit-result-password-1";
const LE = 1;
const BASE = 972000;

const admin = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const seed = async (
  n: number,
  lastName: string,
  {
    deal: dealFields = {},
    call: callFields = {},
  }: { deal?: Record<string, unknown>; call?: Record<string, unknown> } = {},
) => {
  const client = admin();
  const contactId = BASE + n;

  const { error: contactError } = await client.from("contacts").insert({
    id: contactId,
    first_name: "Edit",
    last_name: lastName,
    email_jsonb: [{ email: `edit${n}@sales.test`, type: "Work" }],
  });
  if (contactError) throw new Error(contactError.message);

  const { data: deal, error: dealError } = await client
    .from("deals")
    .insert({
      contact_id: contactId,
      offer_id: LE,
      cohort_id: null,
      stage: "decision",
      amount: 4000,
      entry_path: "other",
      description: "",
      owner_decision: "would_work_with",
      prospect_decision: "thinking",
      follow_up_date: "2026-10-20",
      ...dealFields,
    })
    .select("id")
    .single();
  if (dealError) throw new Error(dealError.message);

  const at = "2026-10-14T15:00:00.000Z";
  const { error: callError } = await client.from("sales_calls").insert({
    opportunity_id: deal!.id,
    contact_id: contactId,
    status: "completed",
    attendance: "attended",
    attendance_recorded_at: at,
    original_scheduled_at: at,
    scheduled_at: at,
    scheduled_on: "2026-10-14",
    schedule_precision: "exact",
    source: "manual",
    ...callFields,
  });
  if (callError) throw new Error(callError.message);

  return { contactId, dealId: deal!.id as number };
};

const signIn = async (page: Page) => {
  const email = `edit-${Date.now()}@example.com`;
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

/** Hash-routed (CRM.tsx), so this is a same-document change. */
const openOpportunity = async (page: Page, dealId: number) => {
  await page.evaluate((id) => {
    window.location.hash = `#/deals/${id}/show`;
  }, dealId);
  await expect(page.getByText("Sales Call · Completed")).toBeVisible();
};

const dealRow = async (dealId: number) => {
  const { data } = await admin()
    .from("deals")
    .select("stage, outcome, prospect_decision, follow_up_date")
    .eq("id", dealId)
    .single();
  return data!;
};

const callImpressions = async (dealId: number) => {
  const { data } = await admin()
    .from("sales_calls")
    .select("impressions")
    .eq("opportunity_id", dealId)
    .single();
  return data!.impressions as string | null;
};

test.describe("the recorded result is visible and editable", () => {
  test("what Leif wrote about the call is shown back to him", async ({
    page,
  }) => {
    // Part 1 could write an impression and nothing could read one back.
    const { dealId } = await seed(1, "Readable", {
      call: { impressions: "Clear about the money, wants to ask her partner." },
    });

    await signIn(page);
    await openOpportunity(page, dealId);

    await expect(page.getByText("Impressions", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Clear about the money, wants to ask her partner."),
    ).toBeVisible();
  });

  test("the edit opens on this episode's own facts, not a blank form", async ({
    page,
  }) => {
    const { dealId } = await seed(2, "Prefilled", {
      call: { impressions: "Warm." },
    });

    await signIn(page);
    await openOpportunity(page, dealId);
    await page.getByRole("button", { name: "Edit result" }).click();

    await expect(page.getByRole("dialog")).toBeVisible();
    // The recorded answers are already selected, and the recorded date and
    // impression are already in their fields.
    await expect(
      page.getByLabel("Would work with", { exact: false }),
    ).toBeChecked();
    await expect(page.getByLabel("Thinking", { exact: false })).toBeChecked();
    await expect(page.getByLabel("Follow up on")).toHaveValue("2026-10-20");
    await expect(page.getByLabel(/Impressions/)).toHaveValue("Warm.");
  });

  test("a new Decision date saves, and the Opportunity says so", async ({
    page,
  }) => {
    const { dealId } = await seed(3, "NewDate");

    await signIn(page);
    await openOpportunity(page, dealId);
    await page.getByRole("button", { name: "Edit result" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByLabel("Follow up on").fill("2026-11-02");
    await page.getByRole("button", { name: "Save correction" }).click();

    await expect
      .poll(async () => (await dealRow(dealId)).follow_up_date, {
        message: "the corrected Decision date never persisted",
      })
      .toBe("2026-11-02");

    // One follow-up Task, retargeted rather than duplicated.
    const { data: tasks } = await admin()
      .from("tasks")
      .select("id, due_date")
      .eq("opportunity_id", dealId)
      .eq("type", "follow_up")
      .is("done_date", null);
    expect(tasks).toHaveLength(1);
    expect(String(tasks![0].due_date)).toContain("2026-11-02");
  });

  test("emptying the box clears the impression, and says that is what it will do", async ({
    page,
  }) => {
    const { dealId } = await seed(4, "Clearing", {
      call: { impressions: "Something I would rather not keep." },
    });

    await signIn(page);
    await openOpportunity(page, dealId);
    await page.getByRole("button", { name: "Edit result" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByLabel(/Impressions/).fill("");
    // The one case where a blank box is a decision, so it is stated.
    await expect(
      page.getByText("Saving will remove what was written here."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Save correction" }).click();
    await expect
      .poll(() => callImpressions(dealId), {
        message: "the impression was never cleared",
      })
      .toBeNull();
  });

  test("replacing the text replaces it, and leaving it alone changes nothing", async ({
    page,
  }) => {
    const { dealId } = await seed(5, "Replacing", {
      call: { impressions: "First read." },
    });

    await signIn(page);
    await openOpportunity(page, dealId);
    await page.getByRole("button", { name: "Edit result" }).click();
    await page.getByLabel(/Impressions/).fill("Second read.");
    await page.getByRole("button", { name: "Save correction" }).click();

    await expect.poll(() => callImpressions(dealId)).toBe("Second read.");

    // Reopening and saving without touching anything is a no-op, and says so
    // rather than writing a second identical correction.
    await page.getByRole("button", { name: "Edit result" }).click();
    await expect(page.getByLabel(/Impressions/)).toHaveValue("Second read.");
    await page.getByRole("button", { name: "Save correction" }).click();

    // The toast says so in words, which is how Leif knows the click did
    // anything at all. It renders through messageArgs: the notification
    // component translates the message with notificationOptions.messageArgs
    // and nothing else, so notify(key, { _: fallback }) shows the raw KEY --
    // the defect a probe caught here, found in four sales-call surfaces
    // including two Part 1 shipped onto.
    await expect(
      page.getByText("Nothing to change — that is already what is recorded."),
    ).toBeVisible();
    expect(await callImpressions(dealId)).toBe("Second read.");

    const { data: events } = await admin()
      .from("sales_call_events")
      .select("id")
      .eq("kind", "outcome_corrected");
    expect(events).toHaveLength(1);
  });
});

test.describe("a correction that cannot be made safely says why", () => {
  test("a Won sale refuses, in a sentence, and stays Won", async ({ page }) => {
    const { dealId } = await seed(6, "AlreadyWon", {
      deal: { stage: "won", prospect_decision: "yes", follow_up_date: null },
    });

    await signIn(page);
    await openOpportunity(page, dealId);
    await page.getByRole("button", { name: "Edit result" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // "They said no" on a sale that already produced an Enrollment.
    await page.getByLabel("No", { exact: true }).check();
    await page.getByRole("button", { name: "Save correction" }).click();

    // One concise, truthful sentence -- not a wall of warning, and not a
    // silent failure.
    await expect(
      page.getByText(/cannot be safely undone from here/),
    ).toBeVisible();

    const deal = await dealRow(dealId);
    expect(deal.stage).toBe("won");
    expect(deal.prospect_decision).toBe("yes");
    expect(deal.outcome).toBeNull();
  });

  test("an attended call does not offer a no-show it would refuse", async ({
    page,
  }) => {
    const { dealId } = await seed(7, "NoRetraction");

    await signIn(page);
    await openOpportunity(page, dealId);
    await page.getByRole("button", { name: "Edit result" }).click();

    await expect(page.getByText(/recorded as having happened/)).toBeVisible();
    await expect(page.getByLabel("Actually, the call happened")).toHaveCount(0);
  });
});
