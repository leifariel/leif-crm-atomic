import type { Browser, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import {
  OFFER_ID,
  OTHER_OFFER_ID,
  OTHER_OFFER_MAX,
  OTHER_OFFER_NAME,
  UNSCHEDULED,
  changedBetween,
  cleanup,
  countActiveDated,
  readEnrollment,
  seedGoldenJourney,
  snapshotEnrollments,
  week,
} from "./goldenJourneyFixture";

// SYSTEM GREEN for the start week.
//
// Two bugs got past everything this repo had, and both lived between the
// browser and Postgres:
//
//   - ra-core queued the real update for the next notification, and
//     ClientEditModal's own toast took it off the queue and discarded it.
//     dataProvider.update was never called. The CRM said "Client updated".
//   - a persisted query cache, shared across one browser origin, restored
//     ANOTHER programme's Offer into the capacity page, which then had no
//     ceiling to count against.
//
// Neither is reachable from SQL. A Postgres-only integration test would
// have replayed the migration, found the column writable, and reported
// green over a CRM that could not save a start week. So this journey runs
// the whole chain: real browser, real build, real UI interaction, real
// data provider, real Postgres, an INDEPENDENT read-back, a fresh browser,
// and the rendered truth again.
//
// The scenario is twelve genuinely active clients against a ceiling of
// twelve, plus one Todd-shaped commitment with no start week — the exact
// shape that made a twelve-client programme read 13 / 12 and erased a real
// open week along with it.

const PASSWORD = "password";
const UNSCHEDULED_NAME = `${UNSCHEDULED.first} ${UNSCHEDULED.last}`;

// date-fns "PP" for en-US, which is what the pages render.
const ppDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveTitle(/Leif CRM/);
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

// The app is hash-routed on purpose (CRM.tsx), so moving between two
// `#/...` paths is a same-document hash change. page.goto() will not
// re-navigate for one, so this does what the app itself does.
const goTo = async (page: Page, hash: string) => {
  await page.evaluate((target) => {
    window.location.hash = target;
  }, hash);
};

const openProgramme = async (page: Page, offerId: number | string) => {
  await goTo(page, `#/programs/individual/${offerId}`);
  await expect(
    page.getByRole("heading", { name: "Upcoming Openings" }),
  ).toBeVisible();
};

const openClient = async (page: Page, enrollmentId: number) => {
  await goTo(page, `#/enrollments/${enrollmentId}/show`);
  await expect(
    page.getByText(UNSCHEDULED_NAME, { exact: false }).first(),
  ).toBeVisible();
};

// StartWeekCard -> ClientEditModal -> DateInput -> Save: the same four
// things Leif touches, with nothing stubbed in between.
// `from` is the week the field should already be showing. It matters: the
// modal renders before EditBase's record lands, and DateInput re-keys its
// input when the form value arrives from outside — so typing into an empty
// field first and letting the record arrive second silently reverts what
// was typed. Measured, not guessed: the second save in the change case
// wrote nothing while the toast still said "Client updated", because that
// toast was about the save that DID happen.
const stateTheStartWeek = async (
  page: Page,
  iso: string,
  { from, save = true }: { from?: string; save?: boolean } = {},
) => {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel(/^Start week/);
  await expect(field).toHaveValue(from ?? "");
  await field.fill(iso);
  await expect(field).toHaveValue(iso);
  if (save) await dialog.getByRole("button", { name: "Save" }).click();
};

// Every PATCH the browser actually sent to PostgREST for enrollments.
const watchEnrollmentWrites = (page: Page) => {
  const writes: { method: string; url: string; body: string | null }[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().includes("/rest/v1/enrollments")
    ) {
      writes.push({
        method: request.method(),
        url: request.url(),
        body: request.postData(),
      });
    }
  });
  return writes;
};

// Which client section a name is rendered under, by reading the page in
// order. The three sections are the lifecycle: current, future, and
// committed-but-unplaced.
const SECTION_HEADINGS = [
  "Current Clients",
  "Starting Later",
  "Needs Start Week",
  "Upcoming Openings",
  "Waitlist",
];
const sectionOf = (body: string, name: string): string | null => {
  const at = body.indexOf(name);
  if (at === -1) return null;
  let found: string | null = null;
  for (const heading of SECTION_HEADINGS) {
    const h = body.indexOf(heading);
    if (h !== -1 && h < at) found = heading;
  }
  return found;
};

const occurrences = (body: string, name: string) => body.split(name).length - 1;

const freshBrowserAt = async (
  browser: Browser,
  email: string,
  hash: string,
) => {
  // A brand new context: no localStorage, no persisted query cache, no
  // session. Nothing the previous page held can answer for this one.
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  await goTo(page, hash);
  return { context, page };
};

test.describe("the start-week golden journey", () => {
  let seeded: Awaited<ReturnType<typeof seedGoldenJourney>>;
  // A fresh address per test. The fixture truncates auth users between
  // tests, but a fixed address still collides across the two Playwright
  // projects when their setup interleaves — the seam userAddingATask
  // already documents.
  let email: string;

  test.beforeEach(async ({ createSales }) => {
    email = `golden-journey-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;
    seeded = await seedGoldenJourney(createSales, {
      email,
      password: PASSWORD,
    });
  });

  test.afterEach(async () => {
    await cleanup();
  });

  test("twelve of twelve, and the thirteenth is a question rather than a number", async ({
    page,
  }) => {
    await signIn(page, email);
    await openProgramme(page, OFFER_ID);

    // The programme it was asked for, not one left in storage.
    await expect(
      page.getByRole("heading", { name: "The Living Example" }),
    ).toBeVisible();

    const rendered = await page.locator("body").innerText();
    // THE regression. Thirteen people are committed; twelve are clients.
    expect(rendered).toContain("12 / 12 active");
    expect(rendered).not.toContain("13 / 12");
    expect(rendered).toContain("Full — 12 of 12 slots filled.");

    // The thirteenth is on the page, in a client section of their own.
    // This used to be one grey sentence under the openings forecast, which
    // is where Leif went looking for Todd in production and found nothing
    // to click.
    expect(sectionOf(rendered, UNSCHEDULED_NAME)).toBe("Needs Start Week");
    expect(occurrences(rendered, UNSCHEDULED_NAME)).toBe(1);
    // The forecast still admits the numbers depend on it — as a count,
    // with no names and no action.
    expect(rendered).toMatch(
      /1 client still needs a start week, so future availability may change\./,
    );

    // And nothing invented a date for them.
    expect(rendered).not.toContain(`Starts ${ppDate(week(0))}`);

    // INDEPENDENT DATABASE READ-BACK. Not the page's opinion of itself.
    expect(await countActiveDated()).toBe(12);
    const row = await readEnrollment(seeded.unscheduledEnrollmentId);
    expect(row.start_date).toBeNull();
    expect(row.start_date_source).toBeNull();
    expect(row.end_date).toBeNull();
    expect(["onboarding", "active"]).toContain(row.status);
  });

  test("the genuine open week is still visible, because nothing erased it", async ({
    page,
  }) => {
    // The second half of the 13 / 12 failure, and the one that cost Leif
    // something: an active count above the ceiling leaves nothing to
    // offer, so the week the early finisher frees disappeared too.
    await signIn(page, email);
    await openProgramme(page, OFFER_ID);

    const rendered = await page.locator("body").innerText();
    // Somewhere ahead there is a week a new client could start in.
    expect(rendered).toMatch(/Week of \w{3} \d+/);
    expect(rendered).toMatch(/\d+ opening/);
    // Said as a month, because a projected finish is arithmetic rather
    // than a commitment (monthLabel.ts).
    expect(rendered).toContain("Early Finisher");
  });

  test("stating the start week through the real UI reaches the database", async ({
    page,
  }) => {
    await signIn(page, email);
    const writes = watchEnrollmentWrites(page);
    const before = await snapshotEnrollments();

    await openClient(page, seeded.unscheduledEnrollmentId);
    await expect(page.getByText("Start week not set")).toBeVisible();
    await page.getByRole("button", { name: "Set start week" }).click();

    const chosen = week(4);
    await stateTheStartWeek(page, chosen);

    // A. the success message, which is now earned from the saved record.
    await expect(page.getByText("Client updated")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain("Not saved");

    // B. the provider actually executed. Before the repair this list was
    // empty: ra-core had queued the write and the toast discarded it.
    const patches = writes.filter((write) =>
      write.url.includes(`id=eq.${seeded.unscheduledEnrollmentId}`),
    );
    expect(patches.length).toBeGreaterThanOrEqual(1);
    expect(patches[0]!.body).toContain(chosen);
    expect(patches[0]!.body).toContain("owner");

    // C. INDEPENDENT DATABASE READ-BACK.
    const row = await readEnrollment(seeded.unscheduledEnrollmentId);
    expect(row.start_date).toBe(chosen);
    expect(row.start_date_source).toBe("owner");

    // D. exactly one row changed, and it is the intended one.
    const after = await snapshotEnrollments();
    expect(changedBetween(before, after)).toEqual([
      seeded.unscheduledEnrollmentId,
    ]);
  });

  test("a fresh browser shows the same week, so nothing was cache-only", async ({
    page,
    browser,
  }) => {
    await signIn(page, email);
    await openClient(page, seeded.unscheduledEnrollmentId);
    await page.getByRole("button", { name: "Set start week" }).click();
    const chosen = week(4);
    await stateTheStartWeek(page, chosen);
    await expect(page.getByText("Client updated")).toBeVisible();

    // Nothing from the browser that did the saving survives into this one.
    const { context, page: fresh } = await freshBrowserAt(
      browser,
      email,
      `#/programs/individual/${OFFER_ID}`,
    );
    try {
      await expect(
        fresh.getByRole("heading", { name: "Upcoming Openings" }),
      ).toBeVisible();
      const rendered = await fresh.locator("body").innerText();
      expect(rendered).toContain(`Starts ${ppDate(chosen)}`);
      // And the question is no longer being asked, because it is answered:
      // they have moved sections, exactly once.
      expect(sectionOf(rendered, UNSCHEDULED_NAME)).toBe("Starting Later");
      expect(occurrences(rendered, UNSCHEDULED_NAME)).toBe(1);
      expect(rendered).not.toContain("Needs Start Week");
    } finally {
      await context.close();
    }
  });

  test("a future start week is a commitment, not an occupancy", async ({
    page,
  }) => {
    await signIn(page, email);
    await openClient(page, seeded.unscheduledEnrollmentId);
    await page.getByRole("button", { name: "Set start week" }).click();
    const chosen = week(4);
    await stateTheStartWeek(page, chosen);
    await expect(page.getByText("Client updated")).toBeVisible();

    await openProgramme(page, OFFER_ID);
    const rendered = await page.locator("body").innerText();

    // Still twelve clients today. A week four weeks out is an obligation,
    // not somebody Leif is working with now.
    expect(rendered).toContain("12 / 12 active");
    expect(rendered).not.toContain("13 / 12");
    // Counted from exactly the week stated, under its own heading.
    expect(rendered).toContain("Starting Later");
    expect(rendered).toContain(`Starts ${ppDate(chosen)}`);
    // And no earlier week was consumed on their behalf.
    expect(rendered).not.toContain(`Starts ${ppDate(week(3))}`);
    expect(await countActiveDated()).toBe(12);
  });

  test("changing it moves the commitment, and leaves nothing behind", async ({
    page,
    browser,
  }) => {
    await signIn(page, email);
    await openClient(page, seeded.unscheduledEnrollmentId);
    await page.getByRole("button", { name: "Set start week" }).click();
    const first = week(4);
    await stateTheStartWeek(page, first);
    await expect(page.getByText("Client updated")).toBeVisible();

    // Dismiss the first save's toast, so the second save's success cannot
    // be read off a message that was already on screen.
    await page.getByLabel("Close toast").first().click();
    await expect(page.getByText("Client updated")).toBeHidden();
    const before = await snapshotEnrollments();

    // Through the same UI again — the /edit door this time, which is a
    // thin wrapper around the same modal (AGENTS.md -> Operational UX).
    const second = week(8);
    await goTo(page, `#/enrollments/${seeded.unscheduledEnrollmentId}/edit`);
    await stateTheStartWeek(page, second, { from: first });
    await expect(page.getByText("Client updated")).toBeVisible();

    const row = await readEnrollment(seeded.unscheduledEnrollmentId);
    expect(row.start_date).toBe(second);
    expect(row.start_date_source).toBe("owner");
    expect(changedBetween(before, await snapshotEnrollments())).toEqual([
      seeded.unscheduledEnrollmentId,
    ]);

    const { context, page: fresh } = await freshBrowserAt(
      browser,
      email,
      `#/programs/individual/${OFFER_ID}`,
    );
    try {
      await expect(
        fresh.getByRole("heading", { name: "Upcoming Openings" }),
      ).toBeVisible();
      const rendered = await fresh.locator("body").innerText();
      // The new week is consumed, exactly once, and the old one released.
      expect(rendered).toContain(`Starts ${ppDate(second)}`);
      expect(rendered).not.toContain(`Starts ${ppDate(first)}`);
      expect(rendered.split(`Starts ${ppDate(second)}`).length - 1).toBe(1);
      expect(rendered).toContain("12 / 12 active");
    } finally {
      await context.close();
    }
  });

  test("clearing it returns them to needing a week, and frees nothing dated", async ({
    page,
  }) => {
    // Clearing IS supported through the real UI: the Start week field is a
    // DateInput and emptying it is an owner statement, which
    // ClientEditModal turns back into start_date null / source null. There
    // is no second field and nothing infers one.
    await signIn(page, email);
    await openClient(page, seeded.unscheduledEnrollmentId);
    await page.getByRole("button", { name: "Set start week" }).click();
    const chosen = week(4);
    await stateTheStartWeek(page, chosen);
    await expect(page.getByText("Client updated")).toBeVisible();
    expect(
      (await readEnrollment(seeded.unscheduledEnrollmentId)).start_date,
    ).toBe(chosen);
    await page.getByLabel("Close toast").first().click();
    await expect(page.getByText("Client updated")).toBeHidden();

    await goTo(page, `#/enrollments/${seeded.unscheduledEnrollmentId}/edit`);
    await stateTheStartWeek(page, "", { from: chosen });
    await expect(page.getByText("Client updated")).toBeVisible();

    const row = await readEnrollment(seeded.unscheduledEnrollmentId);
    expect(row.start_date).toBeNull();
    // No source either — the only honest way to say "not decided yet".
    expect(row.start_date_source).toBeNull();

    await openProgramme(page, OFFER_ID);
    const rendered = await page.locator("body").innerText();
    // Back to the section that asks the question, exactly once, and gone
    // from the one that answers it.
    expect(sectionOf(rendered, UNSCHEDULED_NAME)).toBe("Needs Start Week");
    expect(occurrences(rendered, UNSCHEDULED_NAME)).toBe(1);
    expect(rendered).toContain("12 / 12 active");
    expect(rendered).not.toContain("13 / 12");
    expect(rendered).not.toContain(`Starts ${ppDate(chosen)}`);
    expect(await countActiveDated()).toBe(12);
  });

  test("the unscheduled client has a section of its own, above the forecast", async ({
    page,
  }) => {
    await signIn(page, email);
    await openProgramme(page, OFFER_ID);

    const rendered = await page.locator("body").innerText();
    // A client section, with the other client sections — not a caveat
    // attached to a projection.
    expect(rendered).toContain("Needs Start Week");
    expect(rendered.indexOf("Needs Start Week")).toBeGreaterThan(
      rendered.indexOf("Current Clients"),
    );
    expect(rendered.indexOf("Needs Start Week")).toBeLessThan(
      rendered.indexOf("Upcoming Openings"),
    );
    // Nobody appears twice across the three sections.
    expect(occurrences(rendered, UNSCHEDULED_NAME)).toBe(1);
    // And the row says what it needs, with the action beside it.
    await expect(
      page.getByRole("button", { name: "Set start week" }).first(),
    ).toBeVisible();
  });

  test("setting the week from the programme page itself moves them", async ({
    page,
    browser,
  }) => {
    // The path Leif could not find: straight from the programme page,
    // through the same modal and the same repaired save.
    await signIn(page, email);
    const writes = watchEnrollmentWrites(page);
    await openProgramme(page, OFFER_ID);

    await page.getByRole("button", { name: "Set start week" }).first().click();
    const chosen = week(4);
    await stateTheStartWeek(page, chosen);
    await expect(page.getByText("Client updated")).toBeVisible();

    // One real write, to the intended Enrollment — no second editor and no
    // duplicated mutation logic.
    const patches = writes.filter((write) =>
      write.url.includes(`id=eq.${seeded.unscheduledEnrollmentId}`),
    );
    expect(patches.length).toBeGreaterThanOrEqual(1);
    const row = await readEnrollment(seeded.unscheduledEnrollmentId);
    expect(row.start_date).toBe(chosen);
    expect(row.start_date_source).toBe("owner");

    // Fresh browser: the grouping survived, and did not duplicate.
    const { context, page: fresh } = await freshBrowserAt(
      browser,
      email,
      `#/programs/individual/${OFFER_ID}`,
    );
    try {
      await expect(
        fresh.getByRole("heading", { name: "Upcoming Openings" }),
      ).toBeVisible();
      const rendered = await fresh.locator("body").innerText();
      expect(sectionOf(rendered, UNSCHEDULED_NAME)).toBe("Starting Later");
      expect(occurrences(rendered, UNSCHEDULED_NAME)).toBe(1);
      expect(rendered).toContain(`Starts ${ppDate(chosen)}`);
      // Nobody left needing one, so the section and its caveat are gone.
      expect(rendered).not.toContain("Needs Start Week");
      expect(rendered).not.toContain("still needs a start week");
      // Still twelve today: a week four weeks out is not an occupancy.
      expect(rendered).toContain("12 / 12 active");
      expect(await countActiveDated()).toBe(12);
    } finally {
      await context.close();
    }
  });

  test("clearing it from Starting Later returns them to Needs Start Week", async ({
    page,
    browser,
  }) => {
    await signIn(page, email);
    await openProgramme(page, OFFER_ID);
    await page.getByRole("button", { name: "Set start week" }).first().click();
    const chosen = week(4);
    await stateTheStartWeek(page, chosen);
    await expect(page.getByText("Client updated")).toBeVisible();
    await page.getByLabel("Close toast").first().click();
    await expect(page.getByText("Client updated")).toBeHidden();

    // Clear it through the real UI, from the client's own edit door.
    await goTo(page, `#/enrollments/${seeded.unscheduledEnrollmentId}/edit`);
    await stateTheStartWeek(page, "", { from: chosen });
    await expect(page.getByText("Client updated")).toBeVisible();

    const row = await readEnrollment(seeded.unscheduledEnrollmentId);
    expect(row.start_date).toBeNull();
    expect(row.start_date_source).toBeNull();

    const { context, page: fresh } = await freshBrowserAt(
      browser,
      email,
      `#/programs/individual/${OFFER_ID}`,
    );
    try {
      await expect(
        fresh.getByRole("heading", { name: "Needs Start Week" }),
      ).toBeVisible();
      const rendered = await fresh.locator("body").innerText();
      expect(sectionOf(rendered, UNSCHEDULED_NAME)).toBe("Needs Start Week");
      expect(occurrences(rendered, UNSCHEDULED_NAME)).toBe(1);
      expect(rendered).not.toContain(`Starts ${ppDate(chosen)}`);
      expect(rendered).toContain("12 / 12 active");
      expect(await countActiveDated()).toBe(12);
    } finally {
      await context.close();
    }
  });

  test("the editor is readable, and its projection is the page's own", async ({
    page,
    isMobile,
  }) => {
    // The two proofs that cannot be made in vitest.
    //
    // GEOMETRY. The app project has no tailwindcss() plugin, so every
    // utility class is inert there and a date input measures 143px — its
    // intrinsic size with no CSS. Here the real stylesheet is built, so
    // the widths below mean something. The reported defect was the End
    // field collapsing until "mm/dd/yyyy" clipped its own border.
    //
    // NO DIVERGENCE. The modal and the Programme row must show the SAME
    // projected final session week, because they call the same function
    // over the same calendar. Two engines is the failure this codebase
    // has already had three times.
    await signIn(page, email);
    await openProgramme(page, OFFER_ID);
    await page.getByRole("button", { name: "Set start week" }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const dates = dialog.locator('input[type="date"]');
    await expect(dates).toHaveCount(2);

    const boxes = [];
    for (let i = 0; i < 2; i += 1) {
      boxes.push((await dates.nth(i).boundingBox())!);
    }
    // Stacked, not side by side.
    expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height - 1);
    // Both the same width, and wide enough that the placeholder cannot
    // clip. 143px was the squeezed column; a date input needs roughly 110
    // for "mm/dd/yyyy" plus the picker control and padding.
    // Within a few pixels of each other. Measured 2.5px apart on a Pixel 5
    // at devicePixelRatio 2.75 — sub-pixel rounding, not a squeeze. The
    // defect being guarded against collapsed one of them to a third of
    // the other.
    expect(Math.abs(boxes[0]!.width - boxes[1]!.width)).toBeLessThan(4);
    expect(boxes[0]!.width).toBeGreaterThan(isMobile ? 240 : 320);
    // Inside the viewport, not spilling out of it.
    const viewport = page.viewportSize()!;
    expect(boxes[0]!.x).toBeGreaterThanOrEqual(0);
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(viewport.width);

    // The projection, answered live for the week being chosen.
    const chosen = week(4);
    await stateTheStartWeek(page, chosen, { save: false });
    const projection = dialog.getByText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    await expect(projection.first()).toBeVisible();
    const inModal = (await projection.first().innerText()).trim();

    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Client updated")).toBeVisible();

    // And the Programme row says the same thing, from the same authority.
    const rendered = await page.locator("body").innerText();
    expect(rendered).toContain(`Starts ${ppDate(chosen)}`);
    expect(rendered).toContain(`expected final session week ${inModal}`);
  });

  test("another programme's Offer cannot answer for this one", async ({
    page,
  }) => {
    // The fortnightly CI failure, as a real browser journey. The decoy is
    // an individual programme with a ceiling of three, so if its Offer
    // survives into the Living Example's page the numbers cannot hide it.
    await signIn(page, email);

    await openProgramme(page, OTHER_OFFER_ID);
    await expect(
      page.getByRole("heading", { name: OTHER_OFFER_NAME }),
    ).toBeVisible();
    expect(await page.locator("body").innerText()).toContain(
      `0 / ${OTHER_OFFER_MAX} active`,
    );

    await openProgramme(page, OFFER_ID);

    // Business data, not an empty storage key: the right programme, the
    // right ceiling, the right count.
    await expect(
      page.getByRole("heading", { name: "The Living Example" }),
    ).toBeVisible();
    const rendered = await page.locator("body").innerText();
    expect(rendered).toContain("12 / 12 active");
    expect(rendered).not.toContain(OTHER_OFFER_NAME);
    expect(rendered).not.toContain(`/ ${OTHER_OFFER_MAX} active`);
    expect(rendered).toContain("Full — 12 of 12 slots filled.");
  });
});
