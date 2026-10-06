import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// SYSTEM GREEN for the testimonial sequence, for BOTH programmes.
//
// Real browser, real production build, real UI, real data provider, real
// Postgres, an INDEPENDENT SQL read-back after every step, and a fresh
// browser context.
//
// The journey is parameterised over the two Offers rather than copied,
// because the engine is deliberately one engine: Growing Yourself Up was
// enabled later and uses the same column, the same task types, the same
// card, the same reconciler and the same hourly job as The Living Example.
// Running the identical journey for both is also how this file proves LE
// still behaves exactly as it did before GYU was switched on — the only
// difference between the two cases is which requirements offboarding
// raises.
//
// ONE TEST PER PROGRAMME DOES THE WHOLE WRITE JOURNEY. `resetDb` in
// fixtures.ts is an automatic fixture that empties every table before EVERY
// test, so seeded rows cannot be shared across tests.
//
// Time travel instead of waiting a fortnight: Day 0 is the entered_at of
// the Enrollment's 'offboarding' status event, so moving that row moves the
// cadence. The programme's OWN activation boundary is moved with it —
// otherwise an anchor pushed back past it would correctly stop being
// eligible, which is the boundary working rather than the cadence failing.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const AT = "2026-09-01T00:00:00.000Z";

const STAGES = [
  "collect_testimonial",
  "testimonial_followup_1",
  "testimonial_followup_2",
] as const;

type Programme = {
  label: string;
  offerId: number;
  /** Fixture id base, clear of every other spec (9600xx–9790xx are taken). */
  base: number;
  /** The offboarding requirements this programme genuinely raises. */
  requirements: string[];
};

const PROGRAMMES: Programme[] = [
  {
    label: "The Living Example",
    offerId: 1,
    base: 984000,
    requirements: ["notes_archived"],
  },
  {
    label: "Growing Yourself Up",
    offerId: 2,
    base: 985000,
    requirements: ["slack_removed", "calendar_removed"],
  },
];

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/**
 * A client of this programme, carried to the brink of offboarding but NOT
 * over it, because crossing that line is the thing under test.
 *
 * Winning the Opportunity is what creates the Enrollment
 * (handle_deal_won), and enrollments.opportunity_id is unique, so this
 * takes the row the CRM made rather than inserting its own.
 */
const seed = async (p: Programme) => {
  const client = db();
  const contactId = p.base + 1;
  const dealId = p.base + 1;

  const contact = await client.from("contacts").insert({
    id: contactId,
    first_name: "Testimonial",
    last_name: "Journey",
    email_jsonb: [{ email: `tj.${p.offerId}@example.com`, type: "Work" }],
    phone_jsonb: [],
    tags: [],
    sales_eligibility: "normal",
    first_seen: AT,
    last_seen: AT,
  });
  if (contact.error) throw new Error(`seed contact: ${contact.error.message}`);

  const deal = await client.from("deals").insert({
    id: dealId,
    name: `Testimonial Journey — ${p.label}`,
    contact_id: contactId,
    offer_id: p.offerId,
    stage: "won",
    amount: 1000,
    index: 0,
    created_at: AT,
    updated_at: AT,
    stage_entered_at: AT,
  });
  if (deal.error) throw new Error(`seed deal: ${deal.error.message}`);

  const enrollment = await client
    .from("enrollments")
    .select("id")
    .eq("opportunity_id", dealId)
    .single();
  if (enrollment.error) {
    throw new Error(
      `winning should create an enrollment: ${enrollment.error.message}`,
    );
  }
  const enrollmentId = enrollment.data.id as number;

  // Activation refuses an unfinished onboarding checklist; the lifecycle
  // refuses skipped stages.
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

const cleanup = async (p: Programme) => {
  const client = db();
  const dealId = p.base + 1;
  const enrollment = await client
    .from("enrollments")
    .select("id")
    .eq("opportunity_id", dealId)
    .maybeSingle();
  const enrollmentId = enrollment.data?.id;
  if (enrollmentId) {
    for (const table of [
      "tasks",
      "enrollment_offboarding_items",
      "enrollment_onboarding_items",
      "enrollment_status_events",
    ]) {
      await client.from(table).delete().eq("enrollment_id", enrollmentId);
    }
    await client.from("enrollments").delete().eq("id", enrollmentId);
  }
  await client
    .from("tasks")
    .delete()
    .eq("contact_id", p.base + 1);
  await client.from("deals").delete().eq("id", dealId);
  await client
    .from("contacts")
    .delete()
    .eq("id", p.base + 1);
};

/** Move Day 0 back, and this programme's own boundary with it. */
const travelBack = async (p: Programme, enrollmentId: number, days: number) => {
  const client = db();
  await client
    .from("offers")
    .update({
      testimonial_activated_at: new Date(
        Date.now() - 365 * 86400000,
      ).toISOString(),
    })
    .eq("id", p.offerId);

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
  const { error } = await db().rpc("reconcile_testimonial_tasks");
  if (error) throw new Error(`reconcile: ${error.message}`);
};

const stagesFor = async (enrollmentId: number) => {
  const { data, error } = await db()
    .from("tasks")
    .select("type, status, done_date, enrollment_id")
    .eq("enrollment_id", enrollmentId)
    .in("type", STAGES as unknown as string[])
    .order("type", { ascending: true });
  if (error) throw new Error(`read stages: ${error.message}`);
  return data ?? [];
};

const completeStage = async (enrollmentId: number, type: string) => {
  const { error } = await db()
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

for (const programme of PROGRAMMES) {
  test.describe(`Testimonial sequence — ${programme.label}`, () => {
    test.beforeEach(async () => {
      await cleanup(programme);
    });

    test.afterEach(async () => {
      await cleanup(programme);
    });

    test("day 0, day 7, day 14, then it stops — and receipt suppresses the open ask", async ({
      page,
      createSales,
    }) => {
      test.skip(
        test.info().project.name !== "chromium",
        "authoritative write journey runs once, on desktop",
      );

      const enrollmentId = await seed(programme);
      const client = db();
      const email = `owner.t${programme.offerId}.${Date.now()}@example.com`;
      await createSales({
        first_name: "Leif",
        last_name: "Owner",
        email,
        password: PASSWORD,
      });
      await signIn(page, email);

      // ---- DAY 0, through the real UI ------------------------------
      await openClient(page, enrollmentId);
      await page.getByRole("button", { name: "Start offboarding" }).click();
      await expect(
        page.getByText("Testimonial", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Not received")).toBeVisible();

      // This programme's own offboarding requirements, unchanged by any of
      // this — and a testimonial is not one of them.
      const items = await client
        .from("enrollment_offboarding_items")
        .select("requirement_key, is_required")
        .eq("enrollment_id", enrollmentId);
      expect(items.data!.map((i) => i.requirement_key).sort()).toEqual(
        [...programme.requirements].sort(),
      );
      for (const item of items.data!) expect(item.is_required).toBe(true);

      let stages = await stagesFor(enrollmentId);
      expect(stages).toHaveLength(1);
      expect(stages[0].type).toBe("collect_testimonial");
      expect(stages[0].done_date).toBeNull();

      // Repeated AND concurrent reconciliation adds nothing: the unique
      // index is the authority, not a check-then-insert.
      await reconcile();
      await Promise.all([reconcile(), reconcile(), reconcile()]);
      expect(await stagesFor(enrollmentId)).toHaveLength(1);

      // ---- DAY 6: nothing -----------------------------------------
      await travelBack(programme, enrollmentId, 6);
      await completeStage(enrollmentId, "collect_testimonial");
      await reconcile();
      stages = await stagesFor(enrollmentId);
      expect(stages.map((s) => s.type)).toEqual(["collect_testimonial"]);

      // ---- DAY 7: the first follow-up, exactly once ---------------
      await travelBack(programme, enrollmentId, 1);
      await reconcile();
      await reconcile();
      stages = await stagesFor(enrollmentId);
      expect(stages.map((s) => s.type).sort()).toEqual([
        "collect_testimonial",
        "testimonial_followup_1",
      ]);
      const first = stages.find((s) => s.type === "testimonial_followup_1")!;
      expect(first.done_date).toBeNull();
      expect(first.enrollment_id).toBe(enrollmentId);

      // ---- DAY 13: still nothing further --------------------------
      await travelBack(programme, enrollmentId, 6);
      await completeStage(enrollmentId, "testimonial_followup_1");
      await reconcile();
      expect(
        (await stagesFor(enrollmentId)).some(
          (s) => s.type === "testimonial_followup_2",
        ),
      ).toBe(false);

      // ---- DAY 14: the second follow-up, exactly once -------------
      await travelBack(programme, enrollmentId, 1);
      await reconcile();
      await Promise.all([reconcile(), reconcile()]);
      expect((await stagesFor(enrollmentId)).map((s) => s.type).sort()).toEqual(
        [
          "collect_testimonial",
          "testimonial_followup_1",
          "testimonial_followup_2",
        ],
      );

      // ---- The ordinary offboarding completes, testimonial NULL ---
      // This is the point of the whole design: the client's reply cannot
      // hold the Enrollment open.
      await client
        .from("enrollment_offboarding_items")
        .update({ status: "done" })
        .eq("enrollment_id", enrollmentId);
      const completed = await client
        .from("enrollments")
        .update({ status: "completed" })
        .eq("id", enrollmentId)
        .select("status, testimonial_received_at")
        .single();
      expect(completed.error).toBeNull();
      expect(completed.data!.status).toBe("completed");
      expect(completed.data!.testimonial_received_at).toBeNull();

      // ---- RECEIPT suppresses the open ask ------------------------
      await openClient(page, enrollmentId);
      await page
        .getByRole("button", { name: "Mark testimonial received" })
        .click();
      await expect(page.getByText(/Received /)).toBeVisible();

      const enrollment = await client
        .from("enrollments")
        .select("testimonial_received_at")
        .eq("id", enrollmentId)
        .single();
      expect(enrollment.data!.testimonial_received_at).not.toBeNull();

      // Cancelled, not completed: Leif did not do it, it stopped being
      // necessary. Both truths survive.
      stages = await stagesFor(enrollmentId);
      const second = stages.find((s) => s.type === "testimonial_followup_2")!;
      expect(second.status).toBe("cancelled");
      expect(second.done_date).not.toBeNull();
      expect(
        stages.find((s) => s.type === "testimonial_followup_1")!.status,
      ).toBe("completed");

      // ---- NOTHING comes back -------------------------------------
      await reconcile();
      await reconcile();
      stages = await stagesFor(enrollmentId);
      expect(stages).toHaveLength(3);
      expect(stages.filter((s) => s.done_date === null)).toHaveLength(0);

      // ---- A fresh browser context agrees ------------------------
      const fresh = await page.context().browser()!.newContext();
      const freshPage = await fresh.newPage();
      await signIn(freshPage, email);
      await openClient(freshPage, enrollmentId);
      await expect(freshPage.getByText(/Received /)).toBeVisible();
      await expect(
        freshPage.getByRole("button", { name: "Mark testimonial received" }),
      ).toHaveCount(0);
      await fresh.close();

      // ---- The invariant the index names -------------------------
      const fourth = await client.from("tasks").insert({
        contact_id: programme.base + 1,
        enrollment_id: enrollmentId,
        type: "testimonial_followup_2",
        text: "A third ask",
        status: "pending",
        due_date: AT,
      });
      expect(fourth.error).not.toBeNull();
      expect(fourth.error!.message).toMatch(/duplicate key|unique/i);
    });

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
        email: `owner.s${programme.offerId}.${Date.now()}@example.com`,
        password: PASSWORD,
      });

      const enrollmentId = await seed(programme);
      const client = db();
      await client
        .from("enrollments")
        .update({ status: "offboarding" })
        .eq("id", enrollmentId);
      await travelBack(programme, enrollmentId, 20);

      await completeStage(enrollmentId, "collect_testimonial");
      await reconcile();
      await completeStage(enrollmentId, "testimonial_followup_1");
      await reconcile();
      await completeStage(enrollmentId, "testimonial_followup_2");
      await reconcile();
      await reconcile();

      expect(await stagesFor(enrollmentId)).toHaveLength(3);

      // Asked twice, never received. Nothing claimed otherwise.
      const enrollment = await client
        .from("enrollments")
        .select("testimonial_received_at")
        .eq("id", enrollmentId)
        .single();
      expect(enrollment.data!.testimonial_received_at).toBeNull();
    });

    // Read-only: safe in every project, and the one that runs at phone
    // width.
    test("the testimonial card fits a phone", async ({ page, createSales }) => {
      const enrollmentId = await seed(programme);
      await db()
        .from("enrollments")
        .update({ status: "offboarding" })
        .eq("id", enrollmentId);

      const email = `owner.m${programme.offerId}.${Date.now()}@example.com`;
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
}

// The boundary is per programme, and an explicit opt-in is the only way
// across it. No UI drives this, so it is proved against the database.
test.describe("Testimonial eligibility boundaries", () => {
  test.skip(
    () => test.info().project.name !== "chromium",
    "writes to the shared database; runs once",
  );

  const BASE = 986000;

  const cleanupBoundary = async () => {
    const client = db();
    for (const id of [BASE + 1, BASE + 2]) {
      const e = await client
        .from("enrollments")
        .select("id")
        .eq("opportunity_id", id)
        .maybeSingle();
      if (e.data?.id) {
        for (const table of [
          "tasks",
          "enrollment_offboarding_items",
          "enrollment_onboarding_items",
          "enrollment_status_events",
        ]) {
          await client.from(table).delete().eq("enrollment_id", e.data.id);
        }
        await client.from("enrollments").delete().eq("id", e.data.id);
      }
      await client.from("tasks").delete().eq("contact_id", id);
      await client.from("deals").delete().eq("id", id);
      await client.from("contacts").delete().eq("id", id);
    }
  };

  test.beforeEach(cleanupBoundary);
  test.afterEach(cleanupBoundary);

  test("a client who offboarded before their programme switched on is excluded, until Leif says otherwise", async () => {
    const client = db();
    const id = BASE + 1;

    await client.from("contacts").insert({
      id,
      first_name: "Before",
      last_name: "Boundary",
      email_jsonb: [],
      phone_jsonb: [],
      tags: [],
      sales_eligibility: "normal",
      first_seen: AT,
      last_seen: AT,
    });
    await client.from("deals").insert({
      id,
      name: "Before Boundary — LE",
      contact_id: id,
      offer_id: 1,
      stage: "won",
      amount: 1000,
      index: 0,
      created_at: AT,
      updated_at: AT,
      stage_entered_at: AT,
    });
    const e = await client
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", id)
      .single();
    const enrollmentId = e.data!.id as number;

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

    // Push their offboarding to before the programme's activation, and
    // clear the Day 0 task the trigger raised while they were still
    // eligible — this is the shape of a genuinely pre-boundary client.
    const activated = await client
      .from("offers")
      .select("testimonial_activated_at")
      .eq("id", 1)
      .single();
    await client
      .from("enrollment_status_events")
      .update({
        entered_at: new Date(
          new Date(
            activated.data!.testimonial_activated_at as string,
          ).getTime() -
            3 * 3600000,
        ).toISOString(),
      })
      .eq("enrollment_id", enrollmentId)
      .eq("status", "offboarding");
    await client
      .from("tasks")
      .delete()
      .eq("enrollment_id", enrollmentId)
      .in("type", STAGES as unknown as string[]);

    // Excluded: the reconciler raises nothing for them, however often it
    // runs.
    await reconcile();
    await reconcile();
    expect(await stagesFor(enrollmentId)).toHaveLength(0);

    // Until Leif explicitly includes that one client — which is what the
    // main-only migration does for Enrollments 48 and 50.
    await client
      .from("enrollments")
      .update({ testimonial_sequence_opted_in_at: new Date().toISOString() })
      .eq("id", enrollmentId);
    await reconcile();
    const stages = await stagesFor(enrollmentId);
    expect(stages).toHaveLength(1);
    expect(stages[0].type).toBe("collect_testimonial");

    // And opting them in did not move the programme's boundary, so nobody
    // else came with them.
    const after = await client
      .from("offers")
      .select("testimonial_activated_at")
      .eq("id", 1)
      .single();
    expect(after.data!.testimonial_activated_at).toBe(
      activated.data!.testimonial_activated_at,
    );
  });
});
