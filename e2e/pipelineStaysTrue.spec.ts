import { execFileSync } from "node:child_process";

import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// THE PIPELINE TELLS THE TRUTH IMMEDIATELY, IN A REAL BROWSER AGAINST BUILT
// CSS AND REAL POSTGRES.
//
// The production defect (2026-10-29): Porsche Brown's call was recorded and
// she vanished from the board. Later, Anna Howard's unrelated call was
// recorded; Porsche came back and Anna vanished. Nobody's data was wrong.
// The board asked for the 100 Opportunities longest in their stage, and
// production held more than 100 — so whoever had JUST moved was the newest,
// and was the one cut off.
//
// This reproduces that shape exactly: 102 active Opportunities, three of
// them at Call Booked with a booked call each, the rest newer than them.
//
//   STEP 1  Person A (Porsche-shaped) — Call Booked -> Decision. A leaves
//           Call Booked and appears exactly once in Decision, counts
//           correct, no reload.                              (N, Q, R)
//   STEP 2  Person B (Anna-shaped) — Call Booked -> Decision, without
//           refreshing. B appears exactly once, A is still where it was,
//           nobody duplicates, counts correct.               (N, P, Q, R)
//           Person C — Call Booked -> Won, shown in Onboarding.   (O)
//   STEP 3  hard refresh: identical membership and counts.   (S)
//   and     browser membership == server membership.         (T)
//
// Plus the correction and stage-safety half:
//   - a refused drag does not remove the card               (U)
//   - Edit call result is discoverable, preloads, corrects to Decision and
//     the card shows the follow-up immediately               (AB, V, W)
//   - a raw stage edit that would contradict the call result is refused
//     with a sentence that names Edit call result            (AA)

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const DB_CONTAINER = "supabase_db_atomic-crm-e2e";
const PASSWORD = "pipeline-password-1";
const LE = 1;
const BASE = 991000;
const FILLER_BASE = 992000;
// 99 others + A + B + C = 102: more than the board used to fetch.
// 102 others + A + B + C = 105, production's count on 2026-11-23. The
// clean room caps a response at 100 rows, like production
// (supabase/config.e2e.toml), so the board has to page to show them all.
const FILLERS = 102;

const admin = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const psql = (sql: string) =>
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      DB_CONTAINER,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-t",
      "-A",
      "-U",
      "postgres",
      "-d",
      "postgres",
    ],
    { encoding: "utf8", input: sql },
  ).trim();

const must = <T>(
  step: string,
  r: { data: T; error: { message: string } | null },
) => {
  if (r.error) throw new Error(`${step}: ${r.error.message}`);
  return r.data;
};

const isoDay = (days: number): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + days * 86_400_000));

/** A person at Call Booked with a call booked in the future. */
const seedBooked = async (n: number, lastName: string) => {
  const client = admin();
  const contactId = BASE + n;
  must(
    `contact ${lastName}`,
    await client.from("contacts").insert({
      id: contactId,
      first_name: "Pipe",
      last_name: lastName,
      email_jsonb: [{ email: `pipe${n}@pipeline.test`, type: "Work" }],
    }),
  );
  const deal = must(
    `deal ${lastName}`,
    await client
      .from("deals")
      .insert({
        contact_id: contactId,
        offer_id: LE,
        cohort_id: null,
        stage: "call_booked",
        amount: 4000,
        entry_path: "other",
        description: "",
      })
      .select("id")
      .single(),
  ) as { id: number };
  const at = new Date(Date.now() + 2 * 86_400_000 + n * 3_600_000);
  must(
    `call ${lastName}`,
    await client.from("sales_calls").insert({
      opportunity_id: deal.id,
      contact_id: contactId,
      status: "booked",
      original_scheduled_at: at.toISOString(),
      scheduled_at: at.toISOString(),
      scheduled_on: at.toISOString().slice(0, 10),
      schedule_precision: "exact",
      source: "manual",
    }),
  );
  return { contactId, dealId: deal.id, name: `Pipe ${lastName}` };
};

/** Everyone else on the board. Inserted FIRST, so the people who move are
 * the newest — the very cards a one-request board cut off. */
const seedFillers = async (count = FILLERS) => {
  const client = admin();
  const contacts = Array.from({ length: count }, (_, i) => ({
    id: FILLER_BASE + i,
    first_name: "Filler",
    last_name: `Person${String(i).padStart(3, "0")}`,
    // No email: each one would ask for an avatar, and 99 of those in one
    // statement time out. Fillers only need to exist.
    email_jsonb: [],
  }));
  must("filler contacts", await client.from("contacts").insert(contacts));
  must(
    "filler deals",
    await client.from("deals").insert(
      contacts.map((c) => ({
        contact_id: c.id,
        offer_id: LE,
        cohort_id: null,
        stage: "approved",
        amount: 4000,
        entry_path: "other",
        description: "",
      })),
    ),
  );
};

const signIn = async (page: Page) => {
  const email = `pipeline-${Date.now()}@example.com`;
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

const openPipeline = async (page: Page) => {
  await page.evaluate(() => {
    window.location.hash = "#/deals";
  });
  await expect(page.locator('[data-stage="call_booked"]')).toBeVisible();
};

type Board = Record<string, { count: number; names: string[] }>;

/** Every column's header count and the names of the cards in it. */
const readBoard = (page: Page): Promise<Board> =>
  page.evaluate(() => {
    const board: Record<string, { count: number; names: string[] }> = {};
    for (const column of Array.from(
      document.querySelectorAll<HTMLElement>("[data-stage]"),
    )) {
      const header = column.querySelector("h3")?.textContent ?? "";
      const count = Number(header.match(/·\s*(\d+)/)?.[1] ?? "NaN");
      const names = Array.from(
        column.querySelectorAll<HTMLElement>(".cursor-pointer p.font-medium"),
      ).map((p) => (p.textContent ?? "").trim());
      board[column.dataset.stage!] = { count, names };
    }
    return board;
  });

const occurrences = (board: Board, name: string) =>
  Object.entries(board).flatMap(([stage, column]) =>
    column.names.filter((n) => n === name).map(() => stage),
  );

/** A is in exactly one column, and it is this one. */
const expectExactlyIn = async (page: Page, name: string, stage: string) =>
  expect
    .poll(async () => occurrences(await readBoard(page), name), {
      message: `${name} should be on the board exactly once, in ${stage}`,
    })
    .toEqual([stage]);

/** Every column's header count matches the cards it actually holds. */
const expectCountsHonest = async (page: Page) => {
  const board = await readBoard(page);
  for (const [stage, column] of Object.entries(board)) {
    expect(column.count, `${stage} header count`).toBe(column.names.length);
  }
  return board;
};

/** What the server says the board holds: every active, non-Won Opportunity. */
const serverActiveCount = async () => {
  const { count } = await admin()
    .from("deals")
    .select("id", { count: "exact", head: true })
    .is("archived_at", null)
    .is("outcome", null)
    .neq("stage", "won");
  return count ?? 0;
};

const completeCall = async (
  page: Page,
  dealId: number,
  decision: "Yes" | "Thinking",
) => {
  // The Opportunity opens as a modal OVER the board, which is where Leif
  // records a call from — so the board underneath is never reloaded.
  await page.evaluate((id) => {
    window.location.hash = `#/deals/${id}/show`;
  }, dealId);
  await page.getByRole("button", { name: "Complete Sales Call" }).click();
  await page.getByLabel("Call happened").check();
  await page.getByLabel("Would Work With").check();
  await page.getByLabel(decision).check();
  await page
    .getByRole("dialog", { name: "Complete Sales Call" })
    .getByRole("button", { name: "Complete Sales Call" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Complete Sales Call" }),
  ).toHaveCount(0);
  // Close the Opportunity the way Leif does, and land back on the SAME board.
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-stage="call_booked"]')).toBeVisible();
};

/** Cards on the board's active columns (Onboarding is a separate, derived read). */
const activeOnBoard = (bd: Board) =>
  Object.entries(bd)
    .filter(([stage]) => stage !== "onboarding")
    .reduce((sum, [, column]) => sum + column.names.length, 0);

/** Every card name on the board, so duplicates are visible. */
const allNames = (bd: Board) =>
  Object.entries(bd)
    .filter(([stage]) => stage !== "onboarding")
    .flatMap(([, column]) => column.names);

test.describe("the Pipeline shows every move immediately, and keeps showing it", () => {
  test("two sequential completions: both cards land, neither vanishes, counts and a hard refresh agree", async ({
    page,
  }) => {
    // Everyone else first; the three who move are the newest rows.
    await seedFillers();
    const a = await seedBooked(1, "Porscheshaped");
    const b = await seedBooked(2, "Annashaped");
    const c = await seedBooked(3, "Saidyes");
    expect(await serverActiveCount()).toBe(FILLERS + 3);

    await signIn(page);
    await openPipeline(page);

    // Before anything: all three at Call Booked, once each, and all 105 on
    // the board with no truncation warning (A, F, J).
    await expectExactlyIn(page, a.name, "call_booked");
    await expectExactlyIn(page, b.name, "call_booked");
    await expectExactlyIn(page, c.name, "call_booked");
    let board = await expectCountsHonest(page);
    expect(activeOnBoard(board)).toBe(FILLERS + 3);
    await expect(page.getByRole("alert")).toHaveCount(0);

    // STEP 1 — Person A (Porsche's final lifecycle): Call Booked -> Decision.
    // A is now the newest in its stage — exactly the card the old board cut.
    await completeCall(page, a.dealId, "Thinking");
    await expectExactlyIn(page, a.name, "decision");
    await expectExactlyIn(page, b.name, "call_booked");
    board = await expectCountsHonest(page);
    expect(board.call_booked.names).not.toContain(a.name);

    // STEP 2 — Person B (Anna): Call Booked -> Decision, WITHOUT a refresh.
    // B is now the newest. A must not come back from anywhere, because it
    // must never have left.
    await completeCall(page, b.dealId, "Thinking");
    await expectExactlyIn(page, b.name, "decision");
    await expectExactlyIn(page, a.name, "decision");
    board = await expectCountsHonest(page);

    // And Call Booked -> Won, which the board shows in Onboarding (O).
    await completeCall(page, c.dealId, "Yes");
    await expectExactlyIn(page, c.name, "onboarding");
    await expectExactlyIn(page, a.name, "decision");
    await expectExactlyIn(page, b.name, "decision");
    board = await expectCountsHonest(page);

    // T: the browser holds every active Opportunity the server does, and
    // there is no truncation warning.
    expect(activeOnBoard(board)).toBe(await serverActiveCount());
    await expect(page.getByRole("alert")).toHaveCount(0);

    const beforeReload = await readBoard(page);

    // STEP 3 — a hard refresh shows exactly the same board.
    await page.reload();
    await expect(page.locator('[data-stage="call_booked"]')).toBeVisible();
    await expectExactlyIn(page, a.name, "decision");
    await expectExactlyIn(page, b.name, "decision");
    await expectExactlyIn(page, c.name, "onboarding");
    await expect
      .poll(() => readBoard(page), {
        message: "the reloaded board differs from the live one",
      })
      .toEqual(beforeReload);
  });
});

test.describe("the board is complete past several server pages", () => {
  test("B: 205 active Opportunities, three pages of 100, every one exactly once", async ({
    page,
  }) => {
    await seedFillers(202);
    const mover = await seedBooked(4, "Newestmover");
    await seedBooked(5, "Staysbooked");
    await seedBooked(6, "Alsostays");
    expect(await serverActiveCount()).toBe(205);

    await signIn(page);
    await openPipeline(page);

    // All 205, each exactly once, nothing warned about (B, F, I, J).
    await expect
      .poll(async () => activeOnBoard(await readBoard(page)), {
        message: "the board never held all 205",
      })
      .toBe(205);
    // Names arrive in their own batched getMany, which the 100-row cap used
    // to cut short too. Every card must end up named, and named once.
    await expect
      .poll(
        async () =>
          new Set(allNames(await readBoard(page)).filter((n) => n !== "")).size,
        { message: "not every one of the 205 cards got its person's name" },
      )
      .toBe(205);
    let board = await expectCountsHonest(page);
    expect(allNames(board)).toHaveLength(205);
    await expect(page.getByRole("alert")).toHaveCount(0);

    // The newest card moves; it lands once, and nobody else leaves (C, D, E).
    const before = new Set(allNames(board));
    const decisionBefore = board.decision.names.length;
    await completeCall(page, mover.dealId, "Thinking");
    await expectExactlyIn(page, mover.name, "decision");
    board = await expectCountsHonest(page);
    expect(new Set(allNames(board))).toEqual(before);
    expect(board.decision.names).toHaveLength(decisionBefore + 1);
    expect(activeOnBoard(board)).toBe(await serverActiveCount());

    // G: a hard refresh shows exactly the same board.
    const beforeReload = await readBoard(page);
    await page.reload();
    await expect(page.locator('[data-stage="call_booked"]')).toBeVisible();
    await expect
      .poll(() => readBoard(page), {
        message: "the reloaded 205-row board differs from the live one",
      })
      .toEqual(beforeReload);
  });
});

test.describe("a result is corrected through Edit call result, never through the stage", () => {
  // Porsche's real production shape: her call said yes, the stage was then
  // changed to Decision by hand. The guard now refuses creating this, so it
  // is written the way a historical repair would be, as postgres in
  // migration mode — exactly the row that already exists in production.
  const seedPorscheShape = async (n: number, lastName: string) => {
    const contactId = BASE + n;
    const at = "2026-10-29T17:00:00.000Z";
    const dealId = Number(
      psql(`
        set app.migration_mode = 'true';
        insert into contacts (id, first_name, last_name, email_jsonb)
        values (${contactId}, 'Pipe', '${lastName}',
                '[{"email":"pipe${n}@pipeline.test","type":"Work"}]');
        with d as (
          insert into deals (contact_id, offer_id, cohort_id, stage, amount,
                             entry_path, description, owner_decision,
                             prospect_decision, follow_up_date)
          values (${contactId}, ${LE}, null, 'decision', 4000, 'other', '',
                  'would_work_with', 'yes', null)
          returning id
        ), c as (
          insert into sales_calls (opportunity_id, contact_id, status,
                                   attendance, attendance_recorded_at,
                                   original_scheduled_at, scheduled_at,
                                   scheduled_on, schedule_precision, source)
          select id, ${contactId}, 'completed', 'attended', '${at}', '${at}',
                 '${at}', '2026-10-29', 'exact', 'manual' from d
          returning id
        ), e as (
          -- The original completion's own history row, which a correction
          -- must leave exactly as it is.
          insert into sales_call_events (sales_call_id, kind, occurred_at, attendance)
          select id, 'attendance_recorded', '${at}', 'attended' from c
          returning id
        )
        select id from d;
      `)
        .split("\n")
        .pop(),
    );
    return { contactId, dealId, name: `Pipe ${lastName}` };
  };

  test("a refused drag puts the card back rather than losing it (U, AA)", async ({
    page,
  }) => {
    const p = await seedPorscheShape(10, "Dragrefused");
    await signIn(page);
    await openPipeline(page);
    await expectExactlyIn(page, p.name, "decision");

    // Keyboard drag, the library's own accessible path: lift, move one
    // column left (Decision -> Call Booked), drop.
    const card = page
      .locator('[data-stage="decision"] .cursor-pointer')
      .filter({ hasText: p.name });
    await card.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Space");

    await expect(page.getByText(/use Edit call result/i).first()).toBeVisible();
    await expectExactlyIn(page, p.name, "decision");

    const { data } = await admin()
      .from("deals")
      .select("stage")
      .eq("id", p.dealId)
      .single();
    expect(data!.stage).toBe("decision");
  });

  test("a raw stage edit that would contradict the call result says to use Edit call result (AA)", async ({
    page,
  }) => {
    const p = await seedPorscheShape(11, "Rawedit");
    await signIn(page);
    await page.evaluate((id) => {
      window.location.hash = `#/deals/${id}`;
    }, p.dealId);
    // The Edit dialog's own stage select.
    await page.getByRole("combobox").filter({ hasText: "Decision" }).click();
    await page.getByRole("option", { name: "Call Booked" }).click();
    await page.getByRole("button", { name: "Save" }).click();

    await expect(
      page.getByText(
        "This sale's call result says they said yes, so its stage can't be changed here. To change what happened on the call, open the Opportunity and use Edit call result.",
      ),
    ).toBeVisible();
    const { data } = await admin()
      .from("deals")
      .select("stage, prospect_decision")
      .eq("id", p.dealId)
      .single();
    expect(data).toEqual({ stage: "decision", prospect_decision: "yes" });
  });

  test("Edit call result preloads the episode, corrects yes -> thinking, and the card shows it at once (AB, V, W)", async ({
    page,
  }) => {
    const p = await seedPorscheShape(12, "Corrected");
    await signIn(page);
    await openPipeline(page);
    await expectExactlyIn(page, p.name, "decision");

    await page.evaluate((id) => {
      window.location.hash = `#/deals/${id}/show`;
    }, p.dealId);
    const edit = page.getByRole("button", { name: "Edit call result" });
    await expect(edit).toBeVisible();
    await edit.click();

    // By its own name: the Opportunity modal underneath also says "Their
    // decision", so a text filter would match both.
    const dialog = page.getByRole("dialog", { name: "Edit call result" });
    // Preloaded from the SAME episode: attended, Would Work With, Yes.
    await expect(dialog.getByLabel("Yes")).toBeChecked();
    await expect(dialog.getByLabel("Would Work With")).toBeChecked();

    await dialog.getByLabel("Thinking").check();
    const followUp = isoDay(5);
    await dialog.locator('input[type="date"]').fill(followUp);
    await dialog.getByRole("button", { name: /save/i }).click();
    await expect(dialog).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expectExactlyIn(page, p.name, "decision");
    const decisionCard = page
      .locator('[data-stage="decision"] .cursor-pointer')
      .filter({ hasText: p.name });
    await expect(decisionCard).toContainText(/Follow up|Decision due/);

    const client = admin();
    const deal = must(
      "deal",
      await client
        .from("deals")
        .select("stage, prospect_decision, follow_up_date")
        .eq("id", p.dealId)
        .single(),
    );
    expect(deal).toEqual({
      stage: "decision",
      prospect_decision: "thinking",
      follow_up_date: followUp,
    });
    const { count: calls } = await client
      .from("sales_calls")
      .select("id", { count: "exact", head: true })
      .eq("opportunity_id", p.dealId);
    expect(calls).toBe(1);
    const { count: tasks } = await client
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("opportunity_id", p.dealId)
      .eq("type", "follow_up")
      .is("done_date", null);
    expect(tasks).toBe(1);

    // Y: the correction is audited exactly once, on the same episode.
    // Z: the original completion's history row is untouched.
    const { data: call } = await client
      .from("sales_calls")
      .select("id")
      .eq("opportunity_id", p.dealId)
      .single();
    const events = must(
      "events",
      await client
        .from("sales_call_events")
        .select("kind, correction")
        .eq("sales_call_id", call!.id)
        .order("id"),
    ) as Array<{
      kind: string;
      correction: {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      } | null;
    }>;
    expect(events.map((e) => e.kind)).toEqual([
      "attendance_recorded",
      "outcome_corrected",
    ]);
    expect(events[1].correction!.before.prospect_decision).toBe("yes");
    expect(events[1].correction!.after.prospect_decision).toBe("thinking");
  });
});
