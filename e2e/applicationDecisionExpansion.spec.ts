import { createClient } from "@supabase/supabase-js";
import type { Browser, Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// SYSTEM GREEN for the two decisions Leif could not record.
//
// Nothing stubbed: the real production build in a real browser, the real data
// provider, real Postgres with the real roles, an INDEPENDENT SQL read-back,
// and a fresh browser context that cannot be answering from anything the
// deciding page held.
//
// Offering the other programme is NOT a rejection, so the two halves that must
// coexist are checked separately every time: the Application still says what
// they applied for (programme, round, questions, answers, submitted_at) and
// the SALES path has moved — on the SAME Opportunity, because a second one for
// one person's one decision is the duplicate this CRM refuses everywhere else.
//
// A bespoke decision is processed and decided; only the reply is written by
// hand. So each one is checked for its own Kit tag AND for the absence of the
// approved / not_fit tag an email automation may hang off.
//
// No real Kit call is possible here, and that is structural rather than
// careful: KIT_API_KEY does not exist in the clean room, and kit_sync returns
// before claiming any work without it. So every operation below stays exactly
// as the database enqueued it, which is what makes the intent readable.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";

const LE = 1;
const GYU = 2;
const COHORT = 970001;

// Far outside production's range, torn down after every test.
const ids = (n: number) => ({
  contact: 970100 + n,
  deal: 970100 + n,
  application: 970100 + n,
});

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const AT = "2026-09-01T00:00:00.000Z";

/** The six mappings Leif will create in Kit, named here exactly as reported. */
const NEW_MAPPINGS = [
  {
    offer_id: LE,
    event: "offered_other_programme",
    kit_tag_id: 970001,
    kit_tag_name: "LE_Offered_GYU",
  },
  {
    offer_id: LE,
    event: "bespoke_accepted",
    kit_tag_id: 970002,
    kit_tag_name: "LE_Bespoke_Accepted",
  },
  {
    offer_id: LE,
    event: "bespoke_denied",
    kit_tag_id: 970003,
    kit_tag_name: "LE_Bespoke_Denied",
  },
  {
    offer_id: GYU,
    event: "offered_other_programme",
    kit_tag_id: 970004,
    kit_tag_name: "GYU_Offered_LE",
  },
  {
    offer_id: GYU,
    event: "bespoke_accepted",
    kit_tag_id: 970005,
    kit_tag_name: "GYU_Bespoke_Accepted",
  },
  {
    offer_id: GYU,
    event: "bespoke_denied",
    kit_tag_id: 970006,
    kit_tag_name: "GYU_Bespoke_Denied",
  },
];

// THIS SPEC OWNS ITS PREMISE: exactly one OTHER active programme.
//
// A recommendation is only offered when there is one obvious destination, and
// the product correctly stops offering it when there is not — which is proved
// on its own in applicationDecisionUx.test.tsx. But `offers` is reference data
// that resetDb deliberately does not clear, so another spec's programme can
// still be active when this one runs. It happened: the whole suite went green
// on chromium and these two tests failed on Mobile Chrome, which runs after
// every chromium file, with the button simply absent. Nothing was wrong with
// the page.
//
// So the catalogue is set aside here and restored afterwards, and the premise
// is asserted rather than hoped for — with the offending programmes named, so
// a future failure says what it found instead of leaving somebody to guess.
let setAside: Array<{ id: number; name: string }> = [];
let roundsSetAside: number[] = [];

const isolateCatalogue = async () => {
  const client = db();
  const { data, error } = await client
    .from("offers")
    .select("id, name")
    .eq("is_active", true);
  expect(error).toBeNull();
  setAside = (data ?? []).filter(
    (offer) => offer.id !== LE && offer.id !== GYU,
  );
  if (setAside.length > 0) {
    const { error: hideError } = await client
      .from("offers")
      .update({ is_active: false })
      .in(
        "id",
        setAside.map((offer) => offer.id),
      );
    expect(error ?? hideError).toBeNull();
  }
  const { data: active } = await client
    .from("offers")
    .select("id, name")
    .eq("is_active", true);
  expect(
    (active ?? []).map((offer) => offer.name).sort(),
    `the two live programmes, and nothing else: ${JSON.stringify(active)}`,
  ).toEqual(["Growing Yourself Up", "The Living Example"]);

  // And the ROUNDS, for exactly the same reason and with exactly the same
  // consequence: a foreign open round makes a recommendation ambiguous, or
  // supplies one where a test meant there to be none. `cohorts` is reference
  // data resetDb does not clear either.
  const { data: openRounds } = await client
    .from("cohorts")
    .select("id")
    .eq("status", "applications_open");
  roundsSetAside = (openRounds ?? []).map((round) => round.id as number);
  if (roundsSetAside.length > 0) {
    await client
      .from("cohorts")
      .update({ status: "draft" })
      .in("id", roundsSetAside);
  }
};

/**
 * The Growing Yourself Up rounds a test wants to exist, and nothing else.
 *
 * Separate from the applicant's own round: a GYU applicant HAS one, and an LE
 * applicant offered GYU needs one to be offered INTO. Those are different
 * facts and conflating them is how the first version of this spec ended up
 * proving nothing about either.
 */
const seedRounds = async (
  rounds: Array<{ id: number; name: string; close?: string }>,
) => {
  const client = db();
  for (const round of rounds) {
    await client.from("cohorts").delete().eq("id", round.id);
    const { error } = await client.from("cohorts").insert({
      id: round.id,
      offer_id: GYU,
      name: round.name,
      status: "applications_open",
      applications_open_at: "2026-01-01",
      applications_close_at: round.close ?? "2027-12-31",
      program_start_at: "2027-03-01",
      program_end_at: "2027-04-26",
    });
    expect(error).toBeNull();
  }
};

const clearRounds = async (ids: number[]) => {
  const client = db();
  for (const id of ids) await client.from("cohorts").delete().eq("id", id);
};

const restoreCatalogue = async () => {
  const client = db();
  if (setAside.length > 0) {
    await client
      .from("offers")
      .update({ is_active: true })
      .in(
        "id",
        setAside.map((offer) => offer.id),
      );
    setAside = [];
  }
  if (roundsSetAside.length > 0) {
    await client
      .from("cohorts")
      .update({ status: "applications_open" })
      .in("id", roundsSetAside);
    roundsSetAside = [];
  }
};

const seedMappings = async () => {
  const client = db();
  for (const mapping of NEW_MAPPINGS) {
    const { error } = await client.rpc("set_program_kit_tag", {
      p_offer_id: mapping.offer_id,
      p_event: mapping.event,
      p_kit_tag_id: mapping.kit_tag_id,
      p_kit_tag_name: mapping.kit_tag_name,
    });
    expect(error).toBeNull();
  }
};

const clearMappings = async () => {
  const client = db();
  for (const mapping of NEW_MAPPINGS) {
    await client.rpc("set_program_kit_tag", {
      p_offer_id: mapping.offer_id,
      p_event: mapping.event,
      p_kit_tag_id: null,
      p_kit_tag_name: null,
    });
  }
};

const seedApplicant = async (
  createSales: (args: {
    first_name: string;
    last_name: string;
    email: string;
    password: string;
  }) => Promise<{ id: number | string }>,
  {
    n,
    offerId,
    withCohort = false,
    ownerEmail,
    lastName,
  }: {
    n: number;
    offerId: number;
    withCohort?: boolean;
    ownerEmail: string;
    lastName: string;
  },
) => {
  const client = db();
  const sale = await createSales({
    first_name: "Owner",
    last_name: "Decision",
    email: ownerEmail,
    password: PASSWORD,
  });
  const id = ids(n);

  if (withCohort) {
    await client.from("cohorts").delete().eq("id", COHORT);
    const { error } = await client.from("cohorts").insert({
      id: COHORT,
      offer_id: GYU,
      name: "Growing Yourself Up — Decision Round",
      status: "applications_open",
      applications_open_at: "2026-01-01",
      applications_close_at: "2027-12-31",
    });
    expect(error).toBeNull();
  }

  const { error: contactError } = await client.from("contacts").insert({
    id: id.contact,
    first_name: "Robin",
    last_name: lastName,
    sales_id: sale.id,
    email_jsonb: [
      { email: `robin.${lastName.toLowerCase()}@applicant.test`, type: "Work" },
    ],
  });
  expect(contactError).toBeNull();

  const { error: dealError } = await client.from("deals").insert({
    id: id.deal,
    name: `Robin ${lastName}`,
    contact_id: id.contact,
    offer_id: offerId,
    cohort_id: withCohort ? COHORT : null,
    stage: "application_received",
    amount: offerId === LE ? 4500 : 1400,
    sales_id: sale.id,
    index: 0,
    entry_path: "other",
    description: "",
  });
  expect(dealError).toBeNull();

  // raw_answers stays '{}' on purpose: materialize_native_application_
  // responses() skips it, so this fixture creates no immutable answer rows and
  // resetDb can still clear it. The answers themselves are not what these
  // decisions are about.
  const { error: appError } = await client.from("applications").insert({
    id: id.application,
    contact_id: id.contact,
    offer_id: offerId,
    intended_cohort_id: withCohort ? COHORT : null,
    opportunity_id: id.deal,
    status: "pending",
    source: "public_form",
    submitted_at: AT,
    raw_answers: {},
  });
  expect(appError).toBeNull();

  return id;
};

const cleanupApplicant = async (n: number) => {
  const client = db();
  const id = ids(n);
  await client
    .from("kit_sync_operations")
    .delete()
    .eq("application_id", id.application);
  await client.from("applications").delete().eq("id", id.application);
  await client.from("deals").delete().eq("id", id.deal);
  await client.from("contacts").delete().eq("id", id.contact);
  await client.from("cohorts").delete().eq("id", COHORT);
};

const signIn = async (page: Page, email: string) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveTitle(/Leif CRM/);
  await expect(page.getByText("Business at a Glance")).toBeVisible();
};

// Hash-routed on purpose (CRM.tsx), so moving between two #/... paths is a
// same-document change and page.goto() will not re-navigate for one.
const openApplication = async (page: Page, applicationId: number) => {
  await page.evaluate((id) => {
    window.location.hash = `#/applications/${id}/show`;
  }, applicationId);
  await expect(page.getByText("Robin", { exact: false }).first()).toBeVisible();
};

const freshBrowserAt = async (
  browser: Browser,
  email: string,
  applicationId: number,
) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  await openApplication(page, applicationId);
  return { context, page };
};

const readApplication = async (applicationId: number) => {
  const { data, error } = await db()
    .from("applications")
    .select(
      "id, contact_id, offer_id, intended_cohort_id, opportunity_id, status, recommended_offer_id, reviewed_at, submitted_at, raw_answers, source",
    )
    .eq("id", applicationId)
    .single();
  expect(error).toBeNull();
  return data!;
};

const readDealsFor = async (contactId: number) => {
  const { data, error } = await db()
    .from("deals")
    .select(
      "id, offer_id, cohort_id, stage, outcome, owner_decision, archived_at",
    )
    .eq("contact_id", contactId)
    .order("id", { ascending: true });
  expect(error).toBeNull();
  return data!;
};

const readKitOperations = async (applicationId: number) => {
  const { data, error } = await db()
    .from("kit_sync_operations")
    .select("kind, kit_tag_id, kit_tag_name, status")
    .eq("application_id", applicationId)
    .order("id", { ascending: true });
  expect(error).toBeNull();
  return data!;
};

const readOfferEvents = async (opportunityId: number) => {
  const { data, error } = await db()
    .from("deal_offer_events")
    .select(
      "opportunity_id, enrollment_id, from_offer_id, to_offer_id, source, occurred_at",
    )
    .eq("opportunity_id", opportunityId);
  expect(error).toBeNull();
  return data!;
};

// Postgres hands back '+00:00' where the fixture wrote 'Z'. The claim is that
// the submission moment did not change, not that the wire format matches.
const sameInstant = (a: string | null, b: string) =>
  a != null && new Date(a).getTime() === new Date(b).getTime();

const freshEmail = (label: string) =>
  `decision-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

test.describe("offering the other programme", () => {
  test.beforeEach(isolateCatalogue);
  test.beforeEach(seedMappings);
  test.afterEach(clearMappings);
  test.afterEach(restoreCatalogue);

  test("The Living Example -> Offer Growing Yourself Up", async ({
    page,
    browser,
    createSales,
  }) => {
    const email = freshEmail("le-gyu");
    // One round taking applications, so there is nothing to choose between.
    await seedRounds([
      { id: 970201, name: "Growing Yourself Up — Spring 2027" },
    ]);
    const id = await seedApplicant(createSales, {
      n: 1,
      offerId: LE,
      ownerEmail: email,
      lastName: "FromLe",
    });
    try {
      const before = await readDealsFor(id.contact);
      expect(before).toHaveLength(1);

      await signIn(page, email);
      await openApplication(page, id.application);

      // The button names the destination rather than making Leif find out.
      await page
        .getByRole("button", { name: "Offer Growing Yourself Up" })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText("still records the programme they applied for", {
          exact: false,
        }),
      ).toBeVisible();
      // The round they would join, named before the click.
      await expect(
        dialog.getByText("the only round still taking applications", {
          exact: false,
        }),
      ).toBeVisible();
      await dialog
        .getByRole("button", { name: "Offer Growing Yourself Up" })
        .click();
      await expect(page.getByText("Decision recorded.")).toBeVisible();

      // INDEPENDENT DATABASE READ-BACK — not the page's opinion of itself.
      const application = await readApplication(id.application);
      expect(application.status).toBe("offered_other_programme");
      expect(application.recommended_offer_id).toBe(GYU);
      expect(application.reviewed_at).not.toBeNull();
      // SOURCE-APPLICATION PRESERVATION.
      expect(application.offer_id).toBe(LE);
      expect(sameInstant(application.submitted_at, AT)).toBe(true);
      expect(application.source).toBe("public_form");
      expect(application.raw_answers).toEqual({});

      // OPPORTUNITY TRUTH: the same one, moved, with no duplicate anywhere.
      const after = await readDealsFor(id.contact);
      expect(after).toHaveLength(1);
      expect(String(after[0]!.id)).toBe(String(id.deal));
      expect(after[0]!.offer_id).toBe(GYU);
      expect(after[0]!.stage).toBe("approved");
      expect(after[0]!.outcome).toBeNull();
      expect(after[0]!.archived_at).toBeNull();
      // AND A ROUND. The first version of this left it null, which wins into
      // a client with no round and no start date.
      expect(after[0]!.cohort_id).toBe(970201);

      // The programme change is recorded where the Application/Opportunity
      // agreement guard looks for it — written by the database, since
      // deal_offer_events is closed to a browser.
      const events = await readOfferEvents(id.deal);
      expect(events).toHaveLength(1);
      expect(events[0]!.from_offer_id).toBe(LE);
      expect(events[0]!.to_offer_id).toBe(GYU);
      expect(events[0]!.enrollment_id).toBeNull();
      expect(events[0]!.occurred_at).not.toBeNull();

      // KIT INTENT: the cross-programme tag, and ONLY it. No MiniDD_Approved.
      const operations = await readKitOperations(id.application);
      const decision = operations.filter((row) => row.kind === "decision");
      expect(decision).toHaveLength(1);
      expect(decision[0]!.kit_tag_name).toBe("LE_Offered_GYU");
      expect(operations.map((row) => row.kit_tag_name)).not.toContain(
        "MiniDD_Approved",
      );
      expect(operations.map((row) => row.kit_tag_name)).not.toContain(
        "MiniDD_Denied",
      );
      // Nothing claims delivery.
      expect(decision[0]!.status).not.toBe("succeeded");

      // FRESH BROWSER: both programmes said out loud, and no stale LE
      // destination workflow left anywhere on the page.
      const { context, page: fresh } = await freshBrowserAt(
        browser,
        email,
        id.application,
      );
      try {
        // The recommended programme's NAME arrives from its own read, so the
        // line resolves a beat after the page does. Waited for rather than
        // snapshotted: a read taken mid-flight was the one flake this spec
        // produced, and it was the test that was wrong, not the page.
        await expect(
          fresh
            .getByText("Offer Growing Yourself Up", { exact: false })
            .first(),
        ).toBeVisible();
        const rendered = await fresh.locator("body").innerText();
        expect(rendered).toContain("Applied for");
        expect(rendered).toContain("The Living Example");
        expect(rendered).toContain("Offer Growing Yourself Up");
        expect(rendered).toContain("Decision recorded.");
        // No decision buttons survive a recorded decision.
        await expect(
          fresh.getByRole("button", { name: "Approve" }),
        ).toHaveCount(0);
        await expect(
          fresh.getByRole("button", { name: "Bespoke response" }),
        ).toHaveCount(0);

        // FRESH PIPELINE: the sale is on the recommended programme.
        await fresh.evaluate(() => {
          window.location.hash = "#/deals";
        });
        await expect(
          fresh.getByText("Robin FromLe", { exact: false }).first(),
        ).toBeVisible();
      } finally {
        await context.close();
      }
    } finally {
      await cleanupApplicant(1);
      await clearRounds([970201]);
    }
  });

  test("no round open: refused, and said so before the click", async ({
    page,
    createSales,
  }) => {
    const email = freshEmail("le-gyu-none");
    // A round exists, and it is not taking applications.
    await seedRounds([{ id: 970202, name: "Growing Yourself Up — Closed" }]);
    await db()
      .from("cohorts")
      .update({ status: "applications_closed" })
      .eq("id", 970202);
    const id = await seedApplicant(createSales, {
      n: 11,
      offerId: LE,
      ownerEmail: email,
      lastName: "NoRound",
    });
    try {
      await signIn(page, email);
      await openApplication(page, id.application);

      await page
        .getByRole("button", { name: "Offer Growing Yourself Up" })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("has no round open")).toBeVisible();
      await expect(
        dialog.getByText("a client with no round and no start date", {
          exact: false,
        }),
      ).toBeVisible();
      // Nothing to click but Cancel.
      await expect(dialog.getByRole("button", { name: /^Offer/ })).toHaveCount(
        0,
      );

      // INDEPENDENT READ-BACK: nothing happened.
      const application = await readApplication(id.application);
      expect(application.status).toBe("pending");
      expect(application.reviewed_at).toBeNull();
      const deals = await readDealsFor(id.contact);
      expect(deals[0]!.offer_id).toBe(LE);
      expect(deals[0]!.cohort_id).toBeNull();
      expect(await readOfferEvents(id.deal)).toHaveLength(0);
      expect(
        (await readKitOperations(id.application)).filter(
          (row) => row.kind === "decision",
        ),
      ).toHaveLength(0);

      // And the database refuses it directly too, not only the page.
      const { data: refusal } = await db().rpc("review_application", {
        p_application_id: id.application,
        p_outcome: "offered_other_programme",
        p_cohort_id: null,
      });
      expect((refusal as { status: string }).status).toBe("no-eligible-cohort");
    } finally {
      await cleanupApplicant(11);
      await clearRounds([970202]);
    }
  });

  test("two rounds open: Leif chooses, and that round is what is recorded", async ({
    page,
    createSales,
  }) => {
    const email = freshEmail("le-gyu-two");
    await seedRounds([
      { id: 970203, name: "Spring 2027", close: "2027-06-30" },
      { id: 970204, name: "Summer 2027", close: "2027-09-30" },
    ]);
    const id = await seedApplicant(createSales, {
      n: 12,
      offerId: LE,
      ownerEmail: email,
      lastName: "TwoRounds",
    });
    try {
      await signIn(page, email);
      await openApplication(page, id.application);

      // The database will not guess either, asked directly.
      const { data: asked } = await db().rpc("review_application", {
        p_application_id: id.application,
        p_outcome: "offered_other_programme",
        p_cohort_id: null,
      });
      expect((asked as { status: string }).status).toBe(
        "cohort-choice-required",
      );
      expect(await readApplication(id.application)).toMatchObject({
        status: "pending",
      });

      await page
        .getByRole("button", { name: "Offer Growing Yourself Up" })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Which round?")).toBeVisible();
      await expect(dialog.getByText("Spring 2027")).toBeVisible();
      await expect(dialog.getByText("Summer 2027")).toBeVisible();
      // No single confirm, because confirming without choosing is a guess.
      await expect(
        dialog.getByRole("button", { name: "Offer Growing Yourself Up" }),
      ).toHaveCount(0);

      // The second round.
      await dialog
        .getByRole("button", { name: "Offer this round" })
        .nth(1)
        .click();
      await expect(page.getByText("Decision recorded.")).toBeVisible();

      const deals = await readDealsFor(id.contact);
      expect(deals).toHaveLength(1);
      expect(deals[0]!.offer_id).toBe(GYU);
      expect(deals[0]!.cohort_id).toBe(970204);
      // And the application still says what it always said.
      const application = await readApplication(id.application);
      expect(application.offer_id).toBe(LE);
      expect(application.intended_cohort_id).toBeNull();
      expect(application.recommended_offer_id).toBe(GYU);
    } finally {
      await cleanupApplicant(12);
      await clearRounds([970203, 970204]);
    }
  });

  test("Growing Yourself Up -> Offer The Living Example, original cohort intact", async ({
    page,
    browser,
    createSales,
  }) => {
    const email = freshEmail("gyu-le");
    const id = await seedApplicant(createSales, {
      n: 2,
      offerId: GYU,
      withCohort: true,
      ownerEmail: email,
      lastName: "FromGyu",
    });
    try {
      await signIn(page, email);
      await openApplication(page, id.application);

      await page
        .getByRole("button", { name: "Offer The Living Example" })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /Confirm|Offer/ }).click();
      await expect(page.getByText("Decision recorded.")).toBeVisible();

      const application = await readApplication(id.application);
      expect(application.status).toBe("offered_other_programme");
      expect(application.recommended_offer_id).toBe(LE);
      // SOURCE-APPLICATION PRESERVATION, including the round they named.
      expect(application.offer_id).toBe(GYU);
      expect(String(application.intended_cohort_id)).toBe(String(COHORT));
      expect(sameInstant(application.submitted_at, AT)).toBe(true);

      const after = await readDealsFor(id.contact);
      expect(after).toHaveLength(1);
      expect(after[0]!.offer_id).toBe(LE);
      // A round belongs to the programme that has rounds. The Living Example
      // has none, so the SALE leaves it behind — while the APPLICATION keeps
      // it, which is the pair this whole decision turns on.
      expect(after[0]!.cohort_id).toBeNull();
      expect(String(application.intended_cohort_id)).toBe(String(COHORT));
      expect(after[0]!.stage).toBe("approved");
      expect(after[0]!.outcome).toBeNull();

      const events = await readOfferEvents(id.deal);
      expect(events).toHaveLength(1);
      expect(events[0]!.from_offer_id).toBe(GYU);
      expect(events[0]!.to_offer_id).toBe(LE);

      const operations = await readKitOperations(id.application);
      const decision = operations.filter((row) => row.kind === "decision");
      expect(decision).toHaveLength(1);
      expect(decision[0]!.kit_tag_name).toBe("GYU_Offered_LE");
      expect(operations.map((row) => row.kit_tag_name)).not.toContain(
        "GYU-Approved",
      );
      expect(operations.map((row) => row.kit_tag_name)).not.toContain(
        "GYU-Denied",
      );

      const { context, page: fresh } = await freshBrowserAt(
        browser,
        email,
        id.application,
      );
      try {
        await expect(
          fresh.getByText("Offer The Living Example", { exact: false }).first(),
        ).toBeVisible();
        const rendered = await fresh.locator("body").innerText();
        expect(rendered).toContain("Applied for");
        expect(rendered).toContain("Growing Yourself Up");
        expect(rendered).toContain("Offer The Living Example");
        // No stale GYU destination workflow: the page no longer offers to
        // decide, and the sale is not on a GYU round any more.
        await expect(
          fresh.getByRole("button", { name: "Approve" }),
        ).toHaveCount(0);
      } finally {
        await context.close();
      }
    } finally {
      await cleanupApplicant(2);
    }
  });
});

test.describe("a bespoke decision", () => {
  test.beforeEach(isolateCatalogue);
  test.beforeEach(seedMappings);
  test.afterEach(clearMappings);
  test.afterEach(restoreCatalogue);

  const cases = [
    {
      n: 3,
      label: "le-accept",
      offerId: LE,
      lastName: "LeAccept",
      item: "Bespoke Accepted",
      status: "bespoke_accepted",
      tag: "LE_Bespoke_Accepted",
      forbidden: ["MiniDD_Approved", "MiniDD_Denied"],
      stage: "approved",
      outcome: null as string | null,
    },
    {
      n: 4,
      label: "le-reject",
      offerId: LE,
      lastName: "LeReject",
      item: "Bespoke Denied",
      status: "bespoke_denied",
      tag: "LE_Bespoke_Denied",
      forbidden: ["MiniDD_Approved", "MiniDD_Denied"],
      stage: "application_received",
      outcome: "not_fit" as string | null,
    },
    {
      n: 5,
      label: "gyu-accept",
      offerId: GYU,
      lastName: "GyuAccept",
      item: "Bespoke Accepted",
      status: "bespoke_accepted",
      tag: "GYU_Bespoke_Accepted",
      forbidden: ["GYU-Approved", "GYU-Denied"],
      stage: "approved",
      outcome: null as string | null,
    },
    {
      n: 6,
      label: "gyu-reject",
      offerId: GYU,
      lastName: "GyuReject",
      item: "Bespoke Denied",
      status: "bespoke_denied",
      tag: "GYU_Bespoke_Denied",
      forbidden: ["GYU-Approved", "GYU-Denied"],
      stage: "application_received",
      outcome: "not_fit" as string | null,
    },
  ];

  for (const scenario of cases) {
    test(`${scenario.item} on a ${scenario.offerId === LE ? "Living Example" : "Growing Yourself Up"} application is processed and answers nobody`, async ({
      page,
      browser,
      createSales,
    }) => {
      const email = freshEmail(scenario.label);
      const id = await seedApplicant(createSales, {
        n: scenario.n,
        offerId: scenario.offerId,
        withCohort: scenario.offerId === GYU,
        ownerEmail: email,
        lastName: scenario.lastName,
      });
      try {
        await signIn(page, email);
        await openApplication(page, id.application);

        await page.getByRole("button", { name: "Bespoke response" }).click();
        await page.getByRole("menuitem", { name: scenario.item }).click();
        await expect(page.getByText("Decision recorded.")).toBeVisible();

        // PROCESSED, with the semantic outcome of its automatic counterpart.
        const application = await readApplication(id.application);
        expect(application.status).toBe(scenario.status);
        expect(application.reviewed_at).not.toBeNull();
        // Nothing was recommended, so nothing claims to have been.
        expect(application.recommended_offer_id).toBeNull();
        // And no programme moved.
        expect(application.offer_id).toBe(scenario.offerId);

        const deals = await readDealsFor(id.contact);
        expect(deals).toHaveLength(1);
        expect(deals[0]!.offer_id).toBe(scenario.offerId);
        expect(deals[0]!.stage).toBe(scenario.stage);
        expect(deals[0]!.outcome).toBe(scenario.outcome);
        expect(await readOfferEvents(id.deal)).toHaveLength(0);

        // THE CORRECT BESPOKE TAG, AND NOT THE EMAIL-TRIGGERING ONE.
        const operations = await readKitOperations(id.application);
        const decision = operations.filter((row) => row.kind === "decision");
        expect(decision).toHaveLength(1);
        expect(decision[0]!.kit_tag_name).toBe(scenario.tag);
        for (const forbidden of scenario.forbidden) {
          expect(operations.map((row) => row.kit_tag_name)).not.toContain(
            forbidden,
          );
        }
        // Nothing anywhere says a reply went out.
        expect(decision[0]!.status).not.toBe("succeeded");

        // FRESH BROWSER: the decision is recorded, no "bespoke" limbo is
        // left, and the page promises no email.
        const { context, page: fresh } = await freshBrowserAt(
          browser,
          email,
          id.application,
        );
        try {
          const rendered = await fresh.locator("body").innerText();
          expect(rendered).toContain(scenario.item);
          expect(rendered).toContain("Decision recorded.");
          expect(rendered).not.toContain("Bespoke response");
          expect(rendered.toLowerCase()).not.toContain("email sent");
          // Not relabelled as the automatic decision.
          expect(rendered).not.toContain("Not Fit");
        } finally {
          await context.close();
        }
      } finally {
        await cleanupApplicant(scenario.n);
      }
    });
  }
});

test.describe("the decisions Leif already had", () => {
  const existing = [
    {
      n: 7,
      label: "approve",
      button: "Approve",
      status: "approved",
      stage: "approved",
      outcome: null as string | null,
      tag: "MiniDD_Approved",
    },
    {
      n: 8,
      label: "nhc",
      button: "Needs Higher Care",
      status: "needs_higher_care",
      stage: "application_received",
      outcome: "needs_higher_care" as string | null,
      tag: "MiniDD_NeedsHigherCare",
    },
    {
      n: 9,
      label: "notfit",
      button: "Not Fit",
      status: "not_fit",
      stage: "application_received",
      outcome: "not_fit" as string | null,
      tag: "MiniDD_Denied",
    },
  ];

  for (const scenario of existing) {
    test(`${scenario.button} behaves exactly as it did`, async ({
      page,
      createSales,
    }) => {
      const email = freshEmail(scenario.label);
      const id = await seedApplicant(createSales, {
        n: scenario.n,
        offerId: LE,
        ownerEmail: email,
        lastName: `Control${scenario.n}`,
      });
      try {
        await signIn(page, email);
        await openApplication(page, id.application);
        await page.getByRole("button", { name: scenario.button }).click();
        await expect(page.getByText("Decision recorded.")).toBeVisible();

        const application = await readApplication(id.application);
        expect(application.status).toBe(scenario.status);
        expect(application.recommended_offer_id).toBeNull();
        expect(application.offer_id).toBe(LE);

        const deals = await readDealsFor(id.contact);
        expect(deals).toHaveLength(1);
        expect(deals[0]!.offer_id).toBe(LE);
        expect(deals[0]!.stage).toBe(scenario.stage);
        expect(deals[0]!.outcome).toBe(scenario.outcome);
        // No programme moved, so no programme history was invented.
        expect(await readOfferEvents(id.deal)).toHaveLength(0);

        // The tag each one has always applied.
        const operations = await readKitOperations(id.application);
        const decision = operations.filter((row) => row.kind === "decision");
        expect(decision).toHaveLength(1);
        expect(decision[0]!.kit_tag_name).toBe(scenario.tag);
      } finally {
        await cleanupApplicant(scenario.n);
      }
    });
  }

  test("Do Not Engage is still lost plus the owner decision, and still reaches no tag", async ({
    page,
    createSales,
  }) => {
    const email = freshEmail("dne");
    const id = await seedApplicant(createSales, {
      n: 10,
      offerId: LE,
      ownerEmail: email,
      lastName: "ControlDne",
    });
    try {
      await signIn(page, email);
      await openApplication(page, id.application);
      await page.getByRole("button", { name: "Do Not Engage" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog
        .getByRole("button", { name: /Confirm|Do Not Engage/ })
        .click();
      await expect(page.getByText("Decision recorded.")).toBeVisible();

      const application = await readApplication(id.application);
      expect(application.status).toBe("do_not_engage");

      const deals = await readDealsFor(id.contact);
      expect(deals[0]!.outcome).toBe("lost");
      expect(deals[0]!.owner_decision).toBe("do_not_engage");

      // Structural: do_not_engage is not a permitted Kit event, so there is
      // no decision operation at all.
      const operations = await readKitOperations(id.application);
      expect(operations.filter((row) => row.kind === "decision")).toHaveLength(
        0,
      );
    } finally {
      await cleanupApplicant(10);
    }
  });
});
