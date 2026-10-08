import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import { createCrmDb, createTestAuthProvider } from "@/test/StoryWrapper";
import type { Cohort, Offer } from "../types";

// Leif could not configure Growing Yourself Up's Kit tags, and this is why.
//
// The Kit automation box lives on the Offer's own edit form (OfferInputs ->
// OfferKitSection). On the Programs hub, a 1:1 programme's card carries a "⋯"
// menu whose first item is "Edit program" and routes to /offers/:id — so The
// Living Example was always configurable. A GROUP programme rendered as a bare
// text link to its own page, with no menu, and its own page has no edit
// affordance either. Its ROUNDS have menus, and those route to /cohorts/:id,
// which is a different form with a different Kit field.
//
// So the programme-level Kit mapping for Growing Yourself Up — the six events
// this slice added among them — had no route anywhere in the Programs UI. The
// only way in was the avatar menu's low-prominence Offers list, which is
// described in its own code as administrative/reference UI.
//
// This is the regression test for that, written from what Leif needed to do
// and could not.

const AT = "2026-01-01T00:00:00.000Z";

const livingExample: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "6 months",
  current_price: 4500,
  max_active_clients: 12,
  is_active: true,
  created_at: AT,
  updated_at: AT,
};

const growingYourselfUp: Offer = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 1400,
  is_active: true,
  created_at: AT,
  updated_at: AT,
};

const fallRound = {
  id: 3,
  offer_id: 2,
  name: "Growing Yourself Up — Fall 2026",
  status: "applications_open",
  program_start_at: "2026-09-22",
  program_end_at: "2026-11-16",
  created_at: AT,
  updated_at: AT,
} as unknown as Cohort;

const mountAt = async (path: string) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      offers: [livingExample, growingYourselfUp],
      cohorts: [fallRound],
      applications: [],
      deals: [],
      enrollments: [],
      waitlist_entries: [],
      kit_tag_mappings: [],
      kit_tags: [
        { id: 101, name: "GYU_Offered_LE" },
        { id: 102, name: "GYU_Bespoke_Accepted" },
        { id: 103, name: "GYU_Bespoke_Denied" },
      ],
    } as never),
    silent: true,
    latency: 0,
  });
  const screen = await render(
    <MemoryRouter initialEntries={[path]}>
      <CRM
        dataProvider={dataProvider}
        authProvider={createTestAuthProvider()}
        i18nProvider={testI18nProvider}
        store={memoryStore()}
        disableTelemetry
      />
    </MemoryRouter>,
  );
  return { screen, dataProvider };
};

const body = () => document.body.innerText.replace(/\s+/g, " ");

describe("a group programme is as configurable as a 1:1 one", () => {
  // A structural assertion was here — "the programme's heading row carries a
  // Program actions menu" — and the sensitivity check killed it: with the
  // repair reverted it still PASSED, because the heading's parent also
  // contains the round cards and a ROUND has a menu of its own. It was the
  // exact confusion its own comment warned about. A test that cannot fail for
  // the reason it was written is worse than no test, so the behavioural one
  // below carries this instead — and that one does fail without the repair.
  it("routes the group programme's Edit program to its own Offer form", async () => {
    const { screen } = await mountAt("/programs");

    await expect
      .element(
        screen.getByText("Growing Yourself Up", { exact: false }).first(),
      )
      .toBeVisible();

    // The second menu is the group programme's — 1:1 programmes are listed
    // first on the hub.
    await screen
      .getByRole("button", { name: "Program actions" })
      .nth(1)
      .click();
    await screen.getByRole("menuitem", { name: "Edit program" }).click();

    // The Offer's own form, filled in from the record — the programme's name
    // is an input VALUE here, not page text.
    await expect
      .element(screen.getByLabelText(/^Name/i))
      .toHaveValue("Growing Yourself Up");
    const text = body();
    // The Kit automation box, and the three events this slice added.
    expect(text).toContain("Kit automation");
    expect(text).toContain("Offered the other programme");
    expect(text).toContain("Bespoke Accepted");
    expect(text).toContain("Bespoke Denied");
    // The programme's form, not a round's: a round carries shared dates and a
    // programme outlives every round it runs.
    expect(text).not.toContain("Program start");
  });

  it("lets the Kit tag be chosen from the real catalogue rather than typed", async () => {
    const { screen, dataProvider } = await mountAt("/offers/2");

    await expect
      .element(screen.getByText("Kit automation", { exact: true }).first())
      .toBeVisible();
    // Nothing is configured yet, and the box says so rather than implying it is.
    expect(body()).toContain("Kit automation not fully configured");

    // The row for the recommendation, chosen from the catalogue.
    await screen.getByRole("button", { name: "Choose" }).nth(4).click();
    await expect.element(screen.getByText("Choose Kit tag")).toBeVisible();
    await screen.getByText("GYU_Offered_LE").click();

    const { data: mappings } = await dataProvider.getList("kit_tag_mappings", {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    });
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({
      offer_id: 2,
      event: "offered_other_programme",
      kit_tag_name: "GYU_Offered_LE",
      // Kit's own id, carried through from the catalogue. Never typed.
      kit_tag_id: 101,
    });
  });
});
