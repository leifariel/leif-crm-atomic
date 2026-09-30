import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { Notification } from "@/components/admin/notification";
import { testI18nProvider } from "@/components/atomic-crm/providers/commons/i18nProvider";
import { createDataProvider } from "@/components/atomic-crm/providers/fakerest";
import { createCrmDb, createTestAuthProvider } from "@/test/StoryWrapper";
import type { Offer } from "@/components/atomic-crm/types";

// Configuring Kit is not the same act as browsing Kit.
//
// Opening Cohort Edit used to print a list of Leif's Kit tags under "Cohort
// tag (optional)" — GYU-NeedsHigherCare, MiniDD_Applicant, "Imported September
// 13th…" — because the shared picker fetched the catalog on mount and, with an
// empty search box, rendered the first eight results. He had asked for
// nothing. These tests hold the line on both live cohorts he saw it on, and on
// the Program form that shares the picker.
//
// No test reaches Kit: the FakeRest provider stands in for the catalog, which
// is also what proves no call site depends on the provider being up.

const CATALOG = [
  { id: 24082725, name: "GYU-NeedsHigherCare" },
  { id: 24082722, name: "MiniDD_Applicant" },
  { id: 24082724, name: "GYU-Applicant" },
  { id: 21784076, name: "MiniDD_Denied" },
  { id: 99001, name: "GYU_Cohort2" },
  { id: 99002, name: "Imported September 13th 2026" },
];

const GYU: Offer = {
  id: 2,
  name: "Growing Yourself Up",
  type: "cohort",
  duration: "8 weeks",
  current_price: 2000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Offer;

const MAPPINGS = [
  {
    id: 1,
    offer_id: 2,
    event: "applicant",
    kit_tag_id: 24082724,
    kit_tag_name: "GYU-Applicant",
    created_at: "2026-09-28T23:04:40.000Z",
  },
  {
    id: 2,
    offer_id: 2,
    event: "approved",
    kit_tag_id: 21481248,
    kit_tag_name: "GYU-Approved",
    created_at: "2026-09-28T23:04:40.000Z",
  },
];

// The two rounds Leif actually opened, in their real production state: both
// applications-era cohorts of Growing Yourself Up, neither with a tag of its
// own.
const cohort = (over: Record<string, unknown> = {}) => ({
  id: 3,
  offer_id: 2,
  name: "Growing Yourself Up — Fall 2026",
  status: "applications_closed",
  applications_open_at: "2026-09-14",
  applications_close_at: "2026-09-20",
  program_start_at: "2026-09-22",
  program_end_at: "2026-11-10",
  minimum_capacity: 5,
  target_capacity: 10,
  maximum_capacity: 10,
  duration_value: 8,
  duration_unit: "weeks",
  kit_tag_id: null,
  kit_tag_name: null,
  created_at: "2026-09-14T16:33:55.000Z",
  updated_at: "2026-09-22T13:40:09.000Z",
  ...over,
});

const build = (route: string, cohorts: unknown[] = [cohort()]) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [],
      offers: [GYU],
      cohorts,
      deals: [],
      applications: [],
      kit_tag_mappings: MAPPINGS,
      kit_integration_settings: [
        { id: 1, not_before: "2026-09-28T23:04:40.000Z" },
      ],
      kit_tags: CATALOG,
      kit_sync_operations: [],
      tasks: [],
      enrollment_onboarding_items: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return (
    <MemoryRouter initialEntries={[route]}>
      <CRM
        dataProvider={dataProvider}
        authProvider={createTestAuthProvider()}
        i18nProvider={testI18nProvider}
        store={memoryStore()}
        disableTelemetry
        layout={({ children }) => (
          <>
            {children}
            <Notification />
          </>
        )}
      />
    </MemoryRouter>
  );
};

// Every tag name in the catalog that is NOT this cohort's configured value.
// If any of them is on screen, a catalog has been dumped.
const catalogLeakedInto = (text: string, except: string[] = []) =>
  CATALOG.filter((tag) => !except.includes(tag.name))
    .map((tag) => tag.name)
    .filter((name) => text.includes(name));

describe("Cohort Edit — Kit configuration", () => {
  it("does not dump the Kit catalog on Fall 2026 merely because the page opened", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(build("/cohorts/3"));

    await expect.element(screen.getByText("Cohort tag")).toBeVisible();
    // The programme's own mapped tag may legitimately appear elsewhere on the
    // form; nothing else from the catalog may.
    expect(
      catalogLeakedInto(document.body.textContent ?? "", ["GYU-Applicant"]),
    ).toEqual([]);
    expect(document.body.textContent ?? "").not.toContain(
      "Search your Kit tags",
    );
  });

  it("does not dump the Kit catalog on January 2027 either", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(
      build("/cohorts/4", [
        cohort({
          id: 4,
          name: "Growing Yourself Up — January 2027",
          status: "applications_open",
          applications_close_at: "2027-01-17",
          program_start_at: "2027-01-19",
          program_end_at: "2027-03-09",
        }),
      ]),
    );

    await expect.element(screen.getByText("Cohort tag")).toBeVisible();
    expect(
      catalogLeakedInto(document.body.textContent ?? "", ["GYU-Applicant"]),
    ).toEqual([]);
  });

  it("says Not set, which is January 2027's real production value", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(
      build("/cohorts/4", [
        cohort({ id: 4, name: "Growing Yourself Up — January 2027" }),
      ]),
    );

    await expect.element(screen.getByText("Not set")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Choose" }))
      .toBeVisible();
  });

  it("shows the catalog only inside the selection lightbox", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(build("/cohorts/3"));

    await expect.element(screen.getByText("Not set")).toBeVisible();
    await screen.getByRole("button", { name: "Choose" }).click();

    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect.element(screen.getByText("Choose Kit tag")).toBeVisible();
    // Now — and only now — the real catalog and its search are present.
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog?.textContent ?? "").toContain("GYU_Cohort2");
    expect(
      dialog?.querySelector("input[placeholder='Search your Kit tags']"),
    ).toBeTruthy();
  });

  it("searches the real catalog inside the lightbox", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(build("/cohorts/3"));

    await screen.getByRole("button", { name: "Choose" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    await screen.getByPlaceholder("Search your Kit tags").fill("Cohort2");
    await expect
      .element(screen.getByRole("button", { name: "GYU_Cohort2" }))
      .toBeVisible();
  });

  it("writes nothing when the lightbox is cancelled", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(build("/cohorts/3"));

    await screen.getByRole("button", { name: "Choose" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await screen.getByRole("button", { name: "Cancel" }).click();

    // Back to the form, still unconfigured, still no catalog on it.
    await expect.element(screen.getByText("Not set")).toBeVisible();
    expect(
      catalogLeakedInto(document.body.textContent ?? "", ["GYU-Applicant"]),
    ).toEqual([]);
  });

  it("renders a configured tag as the current value, not as a search", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(
      build("/cohorts/3", [
        cohort({ kit_tag_id: 99001, kit_tag_name: "GYU_Cohort2" }),
      ]),
    );

    await expect.element(screen.getByText("GYU_Cohort2")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Change" }))
      .toBeVisible();
    expect(document.body.textContent ?? "").not.toContain(
      "Search your Kit tags",
    );
  });

  it("still says the tag is additive and future-only", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(build("/cohorts/3"));

    await expect.element(screen.getByText("Cohort tag")).toBeVisible();
    expect(document.body.textContent ?? "").toContain(
      "Existing applicants are not retagged",
    );
  });
});

describe("Program Edit — Kit automation", () => {
  it("houses the four mappings in one bordered box, with no catalog on the form", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(build("/offers/2", []));

    await expect
      .element(screen.getByText("Kit automation", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent ?? "").toContain("GYU-Applicant");
    expect(document.body.textContent ?? "").toContain("GYU-Approved");
    // Unmapped events say so rather than being guessed at.
    expect(document.body.textContent ?? "").toContain("Not set");
    expect(document.body.textContent ?? "").not.toContain(
      "Search your Kit tags",
    );

    const box = [...document.querySelectorAll("div")].find(
      (node) =>
        node.className.includes("rounded-md") &&
        node.className.includes("border") &&
        (node.textContent ?? "").includes("Kit automation"),
    );
    expect(box).toBeTruthy();
    expect(box?.textContent ?? "").toContain("GYU-Applicant");
  });

  it("opens the same bounded lightbox to change a mapping", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(build("/offers/2", []));

    await expect
      .element(screen.getByText("Kit automation", { exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Change" }).first().click();

    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect.element(screen.getByText("Choose Kit tag")).toBeVisible();
    expect(
      document
        .querySelector("[role='dialog']")
        ?.querySelector("input[placeholder='Search your Kit tags']"),
    ).toBeTruthy();
  });

  it("still states that a change reaches only future Kit actions", async () => {
    await page.viewport(1280, 1000);
    const screen = await render(build("/offers/2", []));

    await expect
      .element(screen.getByText("Kit automation", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent ?? "").toContain(
      "Changes apply to future Kit actions",
    );
  });
});
