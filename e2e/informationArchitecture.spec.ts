import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// ONE PROGRAMME = ONE CLEARLY BOUNDED CONTAINER, measured against the real
// built CSS.
//
// Both pages used to render loose sections with floating headings — the
// Applications page one per cohort-or-offer, so Growing Yourself Up's cohorts
// read as peer programmes, and the Clients page one Card per group, so a
// programme was three separate boxes with Past drifting below the last one.
//
// The structural half is also asserted in the component tests
// (applications/ApplicationList.test.tsx,
// enrollments/clientsInformationArchitecture.test.tsx). What is here is what
// only real CSS can answer: that each container is genuinely one bordered
// box, that the internal separators are real rules, that the counts line up
// on one right edge, and that none of it overflows a phone. The vitest
// browser project has no Tailwind plugin, so every utility class is inert
// there.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const PASSWORD = "password";
const LE_OFFER = 1;
const BASE = 990000;
const AT = "2026-09-01T00:00:00.000Z";
const PHONE = 393;

const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/**
 * One Living Example application awaiting review, and one Living Example
 * client who has finished — enough for both pages to render a programme
 * container with more than one section in it.
 */
/** Onboarding done, then active, then the start week that decides its group. */
const activate = async (enrollmentId: number, startDate: string) => {
  const client = db();
  await client
    .from("enrollment_onboarding_items")
    .update({ status: "done" })
    .eq("enrollment_id", enrollmentId);
  const r = await client
    .from("enrollments")
    // A start date may never exist without its provenance
    // (enrollments_start_date_has_a_source_check). Leif chose these.
    .update({
      status: "active",
      start_date: startDate,
      start_date_source: "owner",
    })
    .eq("id", enrollmentId)
    .select("id, status");
  if (r.error) throw new Error(`activate ${enrollmentId}: ${r.error.message}`);
  if (r.data?.[0]?.status !== "active") {
    throw new Error(`enrollment ${enrollmentId} did not become active`);
  }
};

const seed = async () => {
  const client = db();

  for (const [offset, name] of [
    [1, "Applicant"],
    [2, "Client"],
    [3, "Reviewed"],
    [4, "Upcoming"],
  ] as const) {
    const r = await client.from("contacts").insert({
      id: BASE + offset,
      first_name: "IA",
      last_name: name,
      email_jsonb: [
        { email: `ia.${name.toLowerCase()}@example.com`, type: "Work" },
      ],
      phone_jsonb: [],
      tags: [],
      sales_eligibility: "normal",
      first_seen: AT,
      last_seen: AT,
    });
    if (r.error) throw new Error(`seed contact ${name}: ${r.error.message}`);
  }

  const app = await client.from("applications").insert({
    id: BASE + 1,
    contact_id: BASE + 1,
    source: "manual",
    status: "pending",
    submitted_at: AT,
    raw_answers: {},
    offer_id: LE_OFFER,
  });
  if (app.error) throw new Error(`seed application: ${app.error.message}`);

  // A reviewed one too, so the programme has Needs Review AND Reviewed —
  // two sections, hence a real rule between them.
  const reviewed = await client.from("applications").insert({
    id: BASE + 3,
    contact_id: BASE + 3,
    source: "manual",
    status: "approved",
    submitted_at: AT,
    reviewed_at: AT,
    raw_answers: {},
    offer_id: LE_OFFER,
  });
  if (reviewed.error) {
    throw new Error(`seed reviewed application: ${reviewed.error.message}`);
  }

  const deal = await client.from("deals").insert({
    id: BASE + 2,
    name: "IA Client — The Living Example",
    contact_id: BASE + 2,
    offer_id: LE_OFFER,
    stage: "won",
    amount: 4000,
    index: 0,
    created_at: AT,
    updated_at: AT,
    stage_entered_at: AT,
  });
  if (deal.error) throw new Error(`seed deal: ${deal.error.message}`);

  const e = await client
    .from("enrollments")
    .select("id")
    .eq("opportunity_id", BASE + 2)
    .single();
  if (e.error) throw new Error(`no enrollment: ${e.error.message}`);
  await activate(e.data.id as number, "2026-01-05");

  // And an UPCOMING client, so Clients has Current AND Upcoming inside the
  // one container — which is what makes an inter-section rule exist.
  const pastDeal = await client.from("deals").insert({
    id: BASE + 4,
    name: "IA Upcoming — The Living Example",
    contact_id: BASE + 4,
    offer_id: LE_OFFER,
    stage: "won",
    amount: 4000,
    index: 0,
    created_at: AT,
    updated_at: AT,
    stage_entered_at: AT,
  });
  if (pastDeal.error) {
    throw new Error(`seed upcoming deal: ${pastDeal.error.message}`);
  }
  const pe = await client
    .from("enrollments")
    .select("id")
    .eq("opportunity_id", BASE + 4)
    .single();
  if (pe.error) throw new Error(`no upcoming enrollment: ${pe.error.message}`);
  // A start week well in the future, so this one reads as Upcoming.
  await activate(pe.data.id as number, "2027-03-01");
};

type CreateSales = (sales: {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
}) => Promise<unknown>;

const signIn = async (page: Page, createSales: CreateSales) => {
  await seed();
  const email = `owner.ia.${Date.now()}@example.com`;
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
};

/**
 * For a page of programme containers: is each one a single bordered box, do
 * all the headings and sections live inside one, and do the counts share a
 * right edge?
 */
const measure = (page: Page, containerTestId: string, childTestId: string) =>
  page.evaluate(
    ({ containerTestId, childTestId }) => {
      const containers = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="${containerTestId}"]`,
        ),
      ];
      const children = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="${childTestId}"]`,
        ),
      ];
      const headings = [
        ...document.querySelectorAll<HTMLElement>("h2, h3, h4"),
      ];

      return {
        containerCount: containers.length,
        programmeNames: containers.map((c) => c.getAttribute("data-programme")),
        // Each container draws its own border — one bounded box, not a bare
        // stack of rows.
        bordered: containers.every(
          (c) => parseFloat(getComputedStyle(c).borderBottomWidth) >= 1,
        ),
        boxes: containers.map((c) => {
          const b = c.getBoundingClientRect();
          return { left: b.left, right: b.right, width: b.width };
        }),
        // Nothing floats: every section and every heading is inside one.
        childrenAllInside: children.every((child) =>
          containers.some((c) => c.contains(child)),
        ),
        childCount: children.length,
        headingsAllInside: headings.every((h) =>
          containers.some((c) => c.contains(h)),
        ),
        headingCount: headings.length,
        // The internal separators are real rules, drawn by the container's
        // own divide-y (border-bottom on every child but the last).
        // Tailwind v4 divide-y draws border-BOTTOM on every child but the
        // last, so a container with one section has no inter-section rule to
        // measure — by design. The rule separating the heading from the
        // sections is the column own border-top, and that is always there.
        sectionColumns: containers.map((c) => {
          const col = c.querySelector<HTMLElement>(".divide-y");
          if (!col) return null;
          return {
            headingRule: parseFloat(getComputedStyle(col).borderTopWidth),
            sectionCount: col.children.length,
            interSectionRules: [...col.children].map((row) =>
              parseFloat(
                getComputedStyle(row as HTMLElement).borderBottomWidth,
              ),
            ),
          };
        }),
        scrollWidth: document.documentElement.scrollWidth,
        // The programme / cohort / section ladder, read off the real CSS.
        // Production acceptance failed because a cohort heading and a
        // section heading were the same size and weight, so a cohort read as
        // just another subsection. Weight alone would not have caught it.
        levels: ["programme", "cohort", "section"].map((level) => {
          const nodes = [
            ...document.querySelectorAll<HTMLElement>(
              `[data-level="${level}"]`,
            ),
          ];
          if (nodes.length === 0) return { level, present: false };
          const style = getComputedStyle(nodes[0]);
          return {
            level,
            present: true,
            count: nodes.length,
            fontSize: parseFloat(style.fontSize),
            fontWeight: parseInt(style.fontWeight, 10),
            texts: nodes.map((n) => (n.textContent ?? "").trim()),
          };
        }),
      };
    },
    { containerTestId, childTestId },
  );

const PAGES = [
  {
    label: "Applications",
    route: "/#/applications",
    ready: "Applications",
    container: "application-programme",
    child: "application-subsection",
    // The Living Example has exactly one section — it has no cohorts. That
    // GYU cohorts nest inside ONE container is proven in
    // applications/ApplicationList.test.tsx, which can fixture cohorts.
    expectMultiSection: false,
  },
  {
    label: "Clients",
    route: "/#/enrollments",
    ready: "The Living Example",
    container: "client-programme",
    child: "client-group",
    expectMultiSection: true,
  },
] as const;

for (const subject of PAGES) {
  test.describe(`${subject.label} information architecture`, () => {
    test("desktop: one bounded container per programme, nothing floating", async ({
      page,
      createSales,
    }) => {
      test.skip(
        test.info().project.name !== "chromium",
        "desktop geometry runs on the desktop project",
      );

      await signIn(page, createSales);
      await page.goto(subject.route);
      await expect(page.getByTestId(subject.container).first()).toBeVisible();

      const m = await measure(page, subject.container, subject.child);

      expect(m.containerCount).toBeGreaterThan(0);
      expect(m.bordered, "every container draws its own border").toBe(true);
      expect(m.headingCount).toBeGreaterThan(0);
      expect(
        m.headingsAllInside,
        "no programme, cohort or section heading floats outside a container",
      ).toBe(true);
      expect(m.childCount).toBeGreaterThan(0);
      expect(
        m.childrenAllInside,
        "every section sits inside a programme container",
      ).toBe(true);

      // The containers share one column, so the page reads as one rhythm.
      const [first] = m.boxes;
      for (const box of m.boxes) {
        expect(Math.abs(box.left - first.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.width - first.width)).toBeLessThanOrEqual(1);
      }

      // PROGRAMME > COHORT > SECTION, strictly, by size.
      const level = (name: string) =>
        m.levels.find((l) => l.level === name && l.present) ?? null;
      const programme = level("programme");
      expect(programme, "a programme heading is present").toBeTruthy();
      const cohort = level("cohort");
      const section = level("section");

      if (cohort) {
        expect(
          programme!.fontSize,
          "programme is larger than cohort",
        ).toBeGreaterThan(cohort.fontSize!);
        // And a cohort label never repeats the programme it sits inside.
        for (const text of cohort.texts ?? []) {
          for (const name of m.programmeNames) {
            expect(
              text.toLowerCase().startsWith(String(name).toLowerCase()),
              `cohort "${text}" repeats its programme`,
            ).toBe(false);
          }
        }
      }
      if (section) {
        const above = cohort ?? programme!;
        expect(
          above.fontSize,
          "a cohort (or the programme) is larger than a section",
        ).toBeGreaterThan(section.fontSize!);
      }

      // At least one real internal rule: the separators are the container's
      // own, not a second card's edge.
      // Every container rules its heading off from its sections, and where
      // it holds more than one section it rules those from each other too.
      // Against the old layout there was no container and no rule at all.
      let multiSection = 0;
      for (const col of m.sectionColumns) {
        expect(col, "the container has a section column").not.toBeNull();
        expect(
          col!.headingRule,
          "the heading is ruled off from the sections",
        ).toBeGreaterThanOrEqual(1);
        if (col!.sectionCount > 1) {
          multiSection += 1;
          // All but the last carry the rule.
          expect(
            col!.interSectionRules.slice(0, -1).every((w) => w >= 1),
            "each section but the last is ruled from the next",
          ).toBe(true);
          expect(col!.interSectionRules.at(-1)).toBe(0);
        }
      }
      if (subject.expectMultiSection) {
        expect(
          multiSection,
          "at least one container holds more than one section",
        ).toBeGreaterThan(0);
      }
    });

    test("Pixel 5: nothing overflows", async ({ page, createSales }) => {
      await page.setViewportSize({ width: PHONE, height: 851 });
      await signIn(page, createSales);
      await page.goto(subject.route);
      await expect(page.getByTestId(subject.container).first()).toBeVisible();

      const m = await measure(page, subject.container, subject.child);

      expect(m.scrollWidth).toBeLessThanOrEqual(PHONE);
      for (const box of m.boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(PHONE);
      }
      expect(m.headingsAllInside).toBe(true);
      expect(m.childrenAllInside).toBe(true);
    });
  });
}
