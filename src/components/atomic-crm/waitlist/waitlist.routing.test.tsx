import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { memoryStore, type DataProvider } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { Notification } from "@/components/admin/notification";
import { testI18nProvider } from "@/components/atomic-crm/providers/commons/i18nProvider";
import { createDataProvider } from "@/components/atomic-crm/providers/fakerest";
import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import { dialogReadyForTyping, typeInto } from "@/test/dialogInteraction";
import type { Cohort, ContactNote, Offer, WaitlistEntry } from "../types";
import type { Db } from "@/components/atomic-crm/providers/fakerest/dataGenerator/types";

// Waitlists slice, §22 (PROGRAM UI / CONTACT UI / DNE): renders the full
// <CRM> through a route, the same convention CRM.routing.test.tsx already
// established, so these exercise real routing + real data-loading rather
// than a shallow component mount.
const livingExample: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  max_active_clients: 12,
  is_active: true,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const gyuOffer: Offer = {
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  duration: "8 weeks",
  current_price: 1400,
  is_active: true,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const septemberCohort: Cohort = {
  id: 1,
  offer_id: 2,
  name: "Growing Yourself Up — Fall 2026",
  status: "applications_open",
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const novemberCohort: Cohort = {
  id: 2,
  offer_id: 2,
  name: "Growing Yourself Up — January 2027",
  status: "applications_open",
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const seededContactNote: ContactNote = {
  id: 1,
  contact_id: 1,
  text: "Seed note",
  date: "2025-01-01T00:00:00.000Z",
  sales_id: 0,
  status: "warm",
};

const buildTestCrm = (
  initialEntries: string[],
  overrides: Partial<Db> = {},
) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [buildContact({ id: 1 })],
      contact_notes: [seededContactNote],
      offers: [livingExample, gyuOffer],
      cohorts: [septemberCohort, novemberCohort],
      offer_payment_options: [],
      applications: [],
      enrollments: [],
      deals: [],
      waitlist_entries: [],
      ...overrides,
    }),
    silent: true,
    latency: 0,
  });
  const authProvider = createTestAuthProvider();
  const store = memoryStore();

  const element = (
    <MemoryRouter initialEntries={initialEntries}>
      <CRM
        dataProvider={dataProvider}
        authProvider={authProvider}
        i18nProvider={testI18nProvider}
        store={store}
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

  return { element, dataProvider };
};

const entry = (
  overrides: Partial<WaitlistEntry> &
    Pick<WaitlistEntry, "id" | "contact_id" | "offer_id">,
): WaitlistEntry => ({
  cohort_id: null,
  status: "waiting",
  joined_at: "2026-01-01T00:00:00.000Z",
  desired_timing: null,
  notes: null,
  priority: null,
  source: null,
  invited_at: null,
  converted_at: null,
  converted_opportunity_id: null,
  removed_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("Living Example page — Waitlist section", () => {
  it("shows only active entries with a correct count; converted/removed are excluded", async () => {
    await page.viewport(1280, 900);
    const contacts = [
      buildContact({ id: 1, first_name: "Ada", last_name: "Lovelace" }),
      buildContact({ id: 2, first_name: "Owen", last_name: "Blake" }),
      buildContact({ id: 3, first_name: "Ivy", last_name: "Osei" }),
      buildContact({ id: 4, first_name: "Felix", last_name: "Tran" }),
    ];
    const entries = [
      entry({ id: 1, contact_id: 2, offer_id: 1, status: "waiting" }),
      entry({ id: 2, contact_id: 3, offer_id: 1, status: "converted" }),
      entry({ id: 3, contact_id: 4, offer_id: 1, status: "removed" }),
    ];

    const { element } = buildTestCrm(["/programs/individual/1"], {
      contacts,
      waitlist_entries: entries,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByRole("heading", { name: "Waitlist · 1" }))
      .toBeInTheDocument();
    await expect.element(screen.getByText("Owen Blake")).toBeInTheDocument();
    await expect.element(screen.getByText("Ivy Osei")).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Felix Tran"))
      .not.toBeInTheDocument();
  });
});

describe("Group Program page — Waitlist section", () => {
  // This page used to show offer-level entries ONLY, and a cohort-specific
  // entry was treated as a leak. Leif's answer after using it: the
  // programme's page is where she asks "who is waiting for Growing
  // Yourself Up", and somebody waiting for its September round is waiting
  // for Growing Yourself Up. So it aggregates, and each row says which
  // round it is for.
  //
  // The strictness it replaced has not been loosened anywhere else: a
  // ROUND's page still shows only its own (the describe below), and the
  // hook still refuses to confuse the two — the programme-wide scope is a
  // third, explicit case rather than a looser reading of "no cohort".
  it("shows everyone waiting for the programme, and says which round", async () => {
    await page.viewport(1280, 900);
    const contacts = [
      buildContact({ id: 1, first_name: "Dana", last_name: "Cole" }),
      buildContact({ id: 2, first_name: "Nadia", last_name: "Osei" }),
    ];
    const entries = [
      entry({
        id: 1,
        contact_id: 1,
        offer_id: 2,
        cohort_id: null,
        status: "waiting",
      }),
      entry({
        id: 2,
        contact_id: 2,
        offer_id: 2,
        cohort_id: 1,
        status: "waiting",
      }),
    ];

    const { element } = buildTestCrm(["/programs/group/2"], {
      contacts,
      waitlist_entries: entries,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByRole("heading", { name: "Waitlist · 2" }))
      .toBeInTheDocument();
    await expect.element(screen.getByText("Dana Cole")).toBeInTheDocument();
    await expect.element(screen.getByText("Nadia Osei")).toBeInTheDocument();
    // Once each — one waitlist row is one place, however it is reached.
    const body = screen.container.ownerDocument.body.textContent ?? "";
    expect(body.split("Nadia Osei").length - 1).toBe(1);
  });

  it("never shows another programme's waiting list", async () => {
    await page.viewport(1280, 900);
    const contacts = [
      buildContact({ id: 1, first_name: "Dana", last_name: "Cole" }),
      buildContact({ id: 2, first_name: "Owen", last_name: "Blake" }),
    ];
    const entries = [
      entry({
        id: 1,
        contact_id: 1,
        offer_id: 2,
        cohort_id: null,
        status: "waiting",
      }),
      // The Living Example's, which this page must never widen into.
      entry({
        id: 2,
        contact_id: 2,
        offer_id: 1,
        cohort_id: null,
        status: "waiting",
      }),
    ];

    const { element } = buildTestCrm(["/programs/group/2"], {
      contacts,
      waitlist_entries: entries,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByRole("heading", { name: "Waitlist · 1" }))
      .toBeInTheDocument();
    await expect.element(screen.getByText("Dana Cole")).toBeInTheDocument();
    await expect
      .element(screen.getByText("Owen Blake"))
      .not.toBeInTheDocument();
  });
});

describe("Cohort page — Waitlist section", () => {
  it("shows only that Cohort's entries — general GYU waiting and another Cohort's entries never leak in", async () => {
    await page.viewport(1280, 900);
    const contacts = [
      buildContact({ id: 1, first_name: "Malik", last_name: "Rowe" }),
      buildContact({ id: 2, first_name: "Dana", last_name: "Cole" }),
      buildContact({ id: 3, first_name: "Theo", last_name: "Marsh" }),
    ];
    const entries = [
      entry({
        id: 1,
        contact_id: 1,
        offer_id: 2,
        cohort_id: 1,
        status: "waiting",
      }),
      entry({
        id: 2,
        contact_id: 2,
        offer_id: 2,
        cohort_id: null,
        status: "waiting",
      }),
      entry({
        id: 3,
        contact_id: 3,
        offer_id: 2,
        cohort_id: 2,
        status: "waiting",
      }),
    ];

    const { element } = buildTestCrm(["/cohorts/1/show"], {
      contacts,
      waitlist_entries: entries,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByRole("heading", { name: "Waitlist · 1" }))
      .toBeInTheDocument();
    await expect.element(screen.getByText("Malik Rowe")).toBeInTheDocument();
    await expect.element(screen.getByText("Dana Cole")).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Theo Marsh"))
      .not.toBeInTheDocument();
  });
});

describe("ContactShow — Waitlists section", () => {
  it("shows both an active and a historical entry, with distinct status", async () => {
    await page.viewport(1280, 900);
    const contact = buildContact({
      id: 1,
      first_name: "Sarah",
      last_name: "Jones",
    });
    const entries = [
      entry({ id: 1, contact_id: 1, offer_id: 1, status: "waiting" }),
      entry({
        id: 2,
        contact_id: 1,
        offer_id: 2,
        cohort_id: 1,
        status: "removed",
        removed_at: "2026-01-05T00:00:00.000Z",
      }),
    ];

    const { element } = buildTestCrm(["/contacts/1/show"], {
      contacts: [contact],
      waitlist_entries: entries,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("The Living Example"))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Growing Yourself Up — Fall 2026"))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Waiting", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Removed", { exact: true }))
      .toBeInTheDocument();
  });
});

// The rule holds on BOTH doors. This path adds a known Contact to a
// waitlist by choosing the Offer, and it used to create the entry with no
// email requirement at all — so "an active waitlist entry requires a
// contactable email" was true from the programme page and false from here.
describe("ContactShow — adding to a waitlist still needs an email", () => {
  it("asks a Contact with no email for one, and writes it to the person", async () => {
    await page.viewport(1280, 900);
    const noEmail = buildContact({
      id: 1,
      first_name: "Reachable",
      last_name: "Nowhere",
      email_jsonb: [],
    });
    const { element, dataProvider } = buildTestCrm(["/contacts/1/show"], {
      contacts: [noEmail],
    });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add to Waitlist" }).click();
    await dialogReadyForTyping(screen);
    await screen.getByLabelText("Program").click();
    await screen.getByText("The Living Example").click();

    // The field is here because they cannot be reached yet.
    await screen.getByRole("button", { name: /^save$/i }).click();
    await expect
      .element(
        screen.getByText(
          "An email is needed so you can reach them about an opening.",
        ),
      )
      .toBeInTheDocument();

    const { total: blocked } = await dataProvider.getList("waitlist_entries", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(blocked).toBe(0);

    await typeInto(screen.getByLabelText(/^Email/), "reachable@example.com");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => {
        const { total } = await dataProvider.getList("waitlist_entries", {
          filter: {},
          pagination: { page: 1, perPage: 10 },
          sort: { field: "id", order: "ASC" },
        });
        return total;
      })
      .toBe(1);

    // On the PERSON, never on the entry.
    const { data: contact } = await dataProvider.getOne("contacts", { id: 1 });
    expect(contact.email_jsonb?.map((e: { email: string }) => e.email)).toEqual(
      ["reachable@example.com"],
    );

    const { data: entries } = await dataProvider.getList("waitlist_entries", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(entries[0]).not.toHaveProperty("contact_email");
    expect(JSON.stringify(entries[0])).not.toContain("reachable@example.com");
  });
});

describe("Add to Waitlist — Do Not Engage guard", () => {
  it("names a Do Not Engage person found by their email, and adds nothing", async () => {
    await page.viewport(1280, 900);
    const dneContact = buildContact({
      id: 2,
      first_name: "Willis",
      last_name: "Byrne",
      email_jsonb: [{ email: "willis.byrne@example.com", type: "Work" }],
      sales_eligibility: "do_not_engage",
    });

    const { element, dataProvider } = buildTestCrm(["/programs/individual/1"], {
      contacts: [buildContact({ id: 1 }), dneContact],
    });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add to Waitlist" }).click();
    await dialogReadyForTyping(screen);
    await typeInto(screen.getByLabelText("Email"), "willis.byrne@example.com");
    // Tab out of the field, which is what triggers the lookup.
    await screen.getByLabelText("Name").click();

    // The person is named rather than hidden — hiding them would just
    // invite a duplicate Contact under a second address.
    await expect
      .element(screen.getByText("Existing contact found"))
      .toBeInTheDocument();
    // exact, because the sentence below also contains their name.
    await expect
      .element(screen.getByText("Willis Byrne", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(
        screen.getByText(
          "Willis Byrne is marked Do Not Engage, so they can't be added to a waitlist.",
        ),
      )
      .toBeInTheDocument();

    // And there is no way to proceed: no "Use this contact" at all.
    await expect
      .element(screen.getByRole("button", { name: "Use this contact" }))
      .not.toBeInTheDocument();

    const { total } = await dataProvider.getList("waitlist_entries", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(total).toBe(0);
  });
});

// Human-acceptance repair pass, §1/§8: a real Living Example waitlist runs
// to ~50 people — the 8-row collapse keeps the page from sprawling, but a
// local search must still find someone past that boundary, and clearing it
// must restore the normal collapsed view.
describe("Waitlist search", () => {
  const manyEntries = (offset: number) =>
    Array.from({ length: 9 }, (_, i) =>
      entry({
        id: i + 1,
        contact_id: offset + i,
        offer_id: 1,
        status: "waiting",
        joined_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
  const manyContacts = (offset: number) => [
    ...Array.from({ length: 8 }, (_, i) =>
      buildContact({
        id: offset + i,
        first_name: `Person${i}`,
        last_name: "Common",
      }),
    ),
    buildContact({
      id: offset + 8,
      first_name: "Zelda",
      last_name: "Findable",
      email_jsonb: [{ email: "zelda.findable@example.com", type: "Home" }],
    }),
  ];

  it("finds a person past the collapsed boundary by name, regardless of collapsed state", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm(["/programs/individual/1"], {
      contacts: manyContacts(100),
      waitlist_entries: manyEntries(100),
    });
    const screen = await render(element);

    await expect
      .element(screen.getByRole("heading", { name: "Waitlist · 9" }))
      .toBeInTheDocument();
    // Not visible yet — past the 8-row collapse.
    await expect
      .element(screen.getByText("Zelda Findable"))
      .not.toBeInTheDocument();

    await screen.getByPlaceholder("Search name or email…").fill("Zelda");

    await expect
      .element(screen.getByText("Zelda Findable"))
      .toBeInTheDocument();
    // The collapse's own "N more" toggle is irrelevant while filtered.
    await expect
      .element(screen.getByText("Person0 Common"))
      .not.toBeInTheDocument();
  });

  it("finds a person by email", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm(["/programs/individual/1"], {
      contacts: manyContacts(200),
      waitlist_entries: manyEntries(200),
    });
    const screen = await render(element);

    await screen
      .getByPlaceholder("Search name or email…")
      .fill("zelda.findable@example.com");

    await expect
      .element(screen.getByText("Zelda Findable"))
      .toBeInTheDocument();
  });

  it("shows a no-match message for a query nobody matches, and clearing it restores the collapsed view", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm(["/programs/individual/1"], {
      contacts: manyContacts(300),
      waitlist_entries: manyEntries(300),
    });
    const screen = await render(element);

    const search = screen.getByPlaceholder("Search name or email…");
    await search.fill("nobody-matches-this");
    await expect
      .element(screen.getByText("No one matches “nobody-matches-this”."))
      .toBeInTheDocument();

    await search.fill("");
    await expect
      .element(screen.getByText("Zelda Findable"))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Person0 Common"))
      .toBeInTheDocument();
  });

  it("stays hidden on a short list (below the collapse threshold)", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm(["/programs/individual/1"], {
      contacts: [
        buildContact({ id: 400, first_name: "Solo", last_name: "Waiter" }),
      ],
      waitlist_entries: [
        entry({ id: 1, contact_id: 400, offer_id: 1, status: "waiting" }),
      ],
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Solo Waiter")).toBeInTheDocument();
    await expect
      .element(screen.getByPlaceholder("Search name or email…"))
      .not.toBeInTheDocument();
  });
});

// Human-acceptance repair pass, §2/§8: quick-creating a brand-new person
// from Add to Waitlist must select them immediately and keep the form
// open — the root cause was AddToWaitlistSheet.tsx's defaultValues
// recomputing a fresh joined_at on every render, resetting the whole form
// out from under the just-created selection (see that file's comment).
// Applications UX + Waitlist entry redesign: Add to Waitlist is email
// first. The old flow searched for a person, buried creation in the
// autocomplete's dropdown, created the Contact with no email, and only
// then asked for one — so the fact that identifies somebody was asked for
// last. These exercise the replacement, and every rule the old flow
// guarded is still here: an active entry needs a contactable email, an
// existing person is reused rather than duplicated, Do Not Engage still
// blocks, and a batch can go in one after another.
describe("Add to Waitlist — email first", () => {
  const entryCount = async (dataProvider: DataProvider) => {
    const { total } = await dataProvider.getList("waitlist_entries", {
      filter: {},
      pagination: { page: 1, perPage: 20 },
      sort: { field: "id", order: "ASC" },
    });
    return total;
  };

  it("creates the person and their waitlist place in one action", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/programs/individual/1"], {
      contacts: [buildContact({ id: 1 })],
    });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add to Waitlist" }).click();
    await dialogReadyForTyping(screen);
    await typeInto(screen.getByLabelText("Email"), "brand.new@example.com");
    await typeInto(screen.getByLabelText("Name"), "Brand New Person");
    await screen.getByRole("button", { name: "Add to waitlist" }).click();

    await expect.poll(() => entryCount(dataProvider)).toBe(1);

    const { data: contacts } = await dataProvider.getList("contacts", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    const created = contacts.filter(
      (c) => c.first_name === "Brand" && c.last_name === "New Person",
    );
    // Exactly one Contact, carrying the address it was created with —
    // never the empty email_jsonb the old flow produced.
    expect(created).toHaveLength(1);
    expect(
      created[0]!.email_jsonb?.map((e: { email: string }) => e.email),
    ).toEqual(["brand.new@example.com"]);

    // The email is a fact about the PERSON. It never reaches the entry.
    const { data: entries } = await dataProvider.getList("waitlist_entries", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(entries[0]!.contact_id).toBe(created[0]!.id);
    expect(entries[0]).not.toHaveProperty("contact_email");
    expect(JSON.stringify(entries[0])).not.toContain("brand.new@example.com");
  });

  it("refuses without an email, because a place nobody can be told about is not worth holding", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/programs/individual/1"], {
      contacts: [buildContact({ id: 1 })],
    });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add to Waitlist" }).click();
    await dialogReadyForTyping(screen);
    await typeInto(screen.getByLabelText("Name"), "No Address Person");
    await screen.getByRole("button", { name: "Add to waitlist" }).click();

    await expect
      .element(
        screen.getByText(
          "An email is needed so you can reach them about an opening.",
        ),
      )
      .toBeInTheDocument();

    // Nothing was created — not the entry, and not a Contact either.
    expect(await entryCount(dataProvider)).toBe(0);
    const { total: contactTotal } = await dataProvider.getList("contacts", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(contactTotal).toBe(1);
  });

  it("refuses without a name, since that is who the email is to", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/programs/individual/1"], {
      contacts: [buildContact({ id: 1 })],
    });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add to Waitlist" }).click();
    await dialogReadyForTyping(screen);
    await typeInto(screen.getByLabelText("Email"), "nameless@example.com");
    await screen.getByRole("button", { name: "Add to waitlist" }).click();

    await expect
      .element(
        screen.getByText(
          "A name is needed — this is who you will be writing to.",
        ),
      )
      .toBeInTheDocument();
    expect(await entryCount(dataProvider)).toBe(0);
  });

  it("offers the person it already has instead of creating a second record", async () => {
    await page.viewport(1280, 900);
    const existing = buildContact({
      id: 2,
      first_name: "Terra",
      last_name: "Israd",
      email_jsonb: [{ email: "Terra.Israd@Example.com", type: "Work" }],
    });
    const { element, dataProvider } = buildTestCrm(["/programs/individual/1"], {
      contacts: [buildContact({ id: 1 }), existing],
    });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add to Waitlist" }).click();
    await dialogReadyForTyping(screen);
    // Different case and surrounding space: the match is on the
    // NORMALIZED address, which is what makes it identity.
    // Typed with stray spaces on purpose — the app has to trim it. The
    // email input strips them from its own value before React ever sees
    // them, which is the browser being helpful, not the app being tested.
    await typeInto(
      screen.getByLabelText("Email"),
      "  terra.israd@example.com ",
      "terra.israd@example.com",
    );
    await screen.getByLabelText("Name").click();

    await expect
      .element(screen.getByText("Existing contact found"))
      .toBeInTheDocument();
    await screen.getByRole("button", { name: "Use this contact" }).click();

    await expect.poll(() => entryCount(dataProvider)).toBe(1);

    const { data: entries } = await dataProvider.getList("waitlist_entries", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(entries[0]!.contact_id).toBe(2);

    // No duplicate Contact, and the person was not renamed by a waitlist
    // dialog either.
    const { total: contactTotal } = await dataProvider.getList("contacts", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(contactTotal).toBe(2);
  });

  it("says plainly when they are already waiting, and adds nothing", async () => {
    await page.viewport(1280, 900);
    const existing = buildContact({
      id: 2,
      first_name: "Terra",
      last_name: "Israd",
      email_jsonb: [{ email: "terra.israd@example.com", type: "Work" }],
    });
    const { element, dataProvider } = buildTestCrm(["/programs/individual/1"], {
      contacts: [buildContact({ id: 1 }), existing],
      waitlist_entries: [entry({ id: 1, contact_id: 2, offer_id: 1 })],
    });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add to Waitlist" }).click();
    await dialogReadyForTyping(screen);
    await typeInto(screen.getByLabelText("Email"), "terra.israd@example.com");
    await screen.getByLabelText("Name").click();

    await expect
      .element(
        screen.getByText(
          "Terra Israd is already waiting for this one — nothing was added.",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Use this contact" }))
      .not.toBeInTheDocument();

    expect(await entryCount(dataProvider)).toBe(1);
  });

  it("mentions a similar name but never blocks on it — a shared name is not identity", async () => {
    await page.viewport(1280, 900);
    const namesake = buildContact({
      id: 2,
      first_name: "Terra",
      last_name: "Israd",
      email_jsonb: [{ email: "terra.israd@example.com", type: "Work" }],
    });
    const { element, dataProvider } = buildTestCrm(["/programs/individual/1"], {
      contacts: [buildContact({ id: 1 }), namesake],
    });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add to Waitlist" }).click();
    await dialogReadyForTyping(screen);
    // A DIFFERENT address, so this is a different person as far as the CRM
    // can honestly tell.
    await typeInto(screen.getByLabelText("Email"), "terra.israd.2@example.com");
    await typeInto(screen.getByLabelText("Name"), "Terra Israd");
    await screen.getByLabelText("Email").click();

    await expect
      .element(screen.getByText("Terra Israd — terra.israd@example.com"))
      .toBeInTheDocument();

    // Advisory only: the save goes through.
    await screen.getByRole("button", { name: "Add to waitlist" }).click();
    await expect.poll(() => entryCount(dataProvider)).toBe(1);

    const { total: contactTotal } = await dataProvider.getList("contacts", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(contactTotal).toBe(3);
  });

  it("starts clean when reopened, so a batch of people can go in one after another", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm(["/programs/individual/1"], {
      contacts: [buildContact({ id: 1 })],
    });
    const screen = await render(element);

    await screen.getByRole("button", { name: "Add to Waitlist" }).click();
    await dialogReadyForTyping(screen);
    await typeInto(screen.getByLabelText("Email"), "first.person@example.com");
    await typeInto(screen.getByLabelText("Name"), "First Person");
    await screen.getByRole("button", { name: "Add to waitlist" }).click();
    await expect.poll(() => entryCount(dataProvider)).toBe(1);

    await screen.getByRole("button", { name: "Add to Waitlist" }).click();
    await dialogReadyForTyping(screen);
    await expect.element(screen.getByLabelText("Email")).toHaveValue("");
    await expect.element(screen.getByLabelText("Name")).toHaveValue("");
  });
});

// Human-acceptance repair pass, §3/§7/§8: ContactShow gets a direct path
// into sales — Convert to Opportunity for an active Waitlist Entry (reuses
// the SAME centralized convertToOpportunity as the Program pages), or a
// prefilled + New Opportunity when there is no active entry.
describe("ContactShow — direct Opportunity actions", () => {
  it("Convert to Opportunity: creates the Opportunity, marks the entry Converted, and navigates to it", async () => {
    await page.viewport(1280, 900);
    const contact = buildContact({
      id: 5,
      first_name: "Owen",
      last_name: "Blake",
    });
    const { element } = buildTestCrm(["/contacts/5/show"], {
      contacts: [contact],
      waitlist_entries: [
        entry({ id: 1, contact_id: 5, offer_id: 1, status: "invited" }),
      ],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByRole("button", { name: "Convert to Opportunity" }))
      .toBeInTheDocument();
    // No "New Opportunity" fallback while an active entry exists.
    await expect
      .element(screen.getByRole("button", { name: "New Opportunity" }))
      .not.toBeInTheDocument();

    await screen
      .getByRole("button", { name: "Convert to Opportunity" })
      .click();

    // Navigated straight to the resulting Opportunity (DealShow's dialog).
    await expect
      .element(screen.getByRole("heading", { name: "Owen Blake" }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("dialog").getByText("Interested"))
      .toBeInTheDocument();
  });

  it("+ New Opportunity: prefills the Contact in the existing Create form — never re-search", async () => {
    await page.viewport(1280, 900);
    const contact = buildContact({
      id: 6,
      first_name: "Priya",
      last_name: "Nair",
    });
    const { element } = buildTestCrm(["/contacts/6/show"], {
      contacts: [contact],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByRole("button", { name: "Convert to Opportunity" }))
      .not.toBeInTheDocument();

    await screen.getByRole("button", { name: "New Opportunity" }).click();

    // The Person field already shows Priya — never a blank search box.
    await expect.element(screen.getByText("Priya Nair")).toBeInTheDocument();
    await expect
      .element(screen.getByText("Search by name or email…"))
      .not.toBeInTheDocument();
  });

  it("Do Not Engage remains blocked from Convert to Opportunity, and the Contact is never hidden", async () => {
    await page.viewport(1280, 900);
    const dneContact = buildContact({
      id: 7,
      first_name: "Willis",
      last_name: "Byrne",
      sales_eligibility: "do_not_engage",
    });
    const { element, dataProvider } = buildTestCrm(["/contacts/7/show"], {
      contacts: [dneContact],
      waitlist_entries: [
        entry({ id: 1, contact_id: 7, offer_id: 1, status: "waiting" }),
      ],
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Willis Byrne")).toBeInTheDocument();
    await screen
      .getByRole("button", { name: "Convert to Opportunity" })
      .click();

    // Blocked: still on the Contact page, no Opportunity created, entry
    // still Waiting.
    await expect
      .poll(async () => {
        const { total } = await dataProvider.getList("deals", {
          filter: {},
          pagination: { page: 1, perPage: 10 },
          sort: { field: "id", order: "ASC" },
        });
        return total;
      })
      .toBe(0);
    const { data: entryAfter } = await dataProvider.getOne("waitlist_entries", {
      id: 1,
    });
    expect(entryAfter.status).toBe("waiting");
  });
});
