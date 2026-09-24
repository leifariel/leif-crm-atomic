import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { memoryStore } from "ra-core";
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
import type { Contact, Offer, WaitlistEntry } from "../types";

// Editing one waitlist row.
//
// Leif added somebody through quick-create, then noticed she had spelled
// his name wrong — and the row's Edit gave her desired timing, notes and
// priority, in a bottom sheet the height of the whole viewport. The person
// whose row it was could not be corrected without leaving for Contacts.
//
// So these cover both halves: the surface is a dialog rather than a
// full-height sheet, and the person on the row is editable from it —
// while name and email stay facts about the CONTACT and timing / notes /
// priority stay facts about the ENTRY.

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

const entry = (over: Partial<WaitlistEntry> = {}): WaitlistEntry =>
  ({
    id: 1,
    contact_id: 1,
    offer_id: 1,
    cohort_id: null,
    status: "waiting",
    joined_at: "2026-01-01T00:00:00.000Z",
    desired_timing: null,
    notes: null,
    priority: null,
    source: "manual",
    invited_at: null,
    converted_at: null,
    converted_opportunity_id: null,
    removed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as WaitlistEntry;

const buildTestCrm = (contacts: Contact[], entries: WaitlistEntry[]) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts,
      offers: [livingExample],
      cohorts: [],
      offer_payment_options: [],
      applications: [],
      enrollments: [],
      deals: [],
      waitlist_entries: entries,
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

  const element = (
    <MemoryRouter initialEntries={["/programs/individual/1"]}>
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

  return { element, dataProvider };
};

const misspelled = buildContact({
  id: 1,
  first_name: "Jhon",
  last_name: "Smtih",
  email_jsonb: [{ email: "jhon@example.com", type: "Work" }],
});

const openEditDialog = async (screen: Awaited<ReturnType<typeof render>>) => {
  await screen.getByRole("button", { name: "Waitlist entry actions" }).click();
  await screen.getByRole("menuitem", { name: "Edit" }).click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
};

describe("editing a waitlist row", () => {
  it("opens as a dialog, not a full-height sheet or a page of its own", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm([misspelled], [entry()]);
    const screen = await render(element);

    await openEditDialog(screen);

    // Still on the Program page — Edit never navigated anywhere. Read
    // from the DOM rather than by role, because an open modal marks the
    // rest of the page aria-hidden, and via MemoryRouter there is no URL
    // to inspect either.
    expect(screen.container.textContent).toContain("The Living Example");
    expect(screen.container.textContent).toContain("Waitlist");

    // And the surface is a dialog that sizes to its content, rather than
    // the h-dvh bottom sheet that put a screenful of nothing under three
    // short fields.
    const dialog = screen.getByRole("dialog").element() as HTMLElement;
    expect(dialog.className).not.toContain("h-dvh");
    expect(dialog.getBoundingClientRect().height).toBeLessThan(
      window.innerHeight,
    );
  });

  it("shows the person already on the row, under their own heading", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm([misspelled], [entry()]);
    const screen = await render(element);

    await openEditDialog(screen);

    const dialog = screen.getByRole("dialog");
    await expect
      .element(dialog.getByText("Person", { exact: true }))
      .toBeVisible();
    await expect
      .element(dialog.getByText("Waitlist", { exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByLabelText(/^First name/))
      .toHaveValue("Jhon");
    await expect
      .element(screen.getByLabelText(/^Last name/))
      .toHaveValue("Smtih");
    await expect
      .element(screen.getByLabelText(/^Email/))
      .toHaveValue("jhon@example.com");
  });

  it("never offers to swap the row onto a different person", async () => {
    // The Person section is fields, not the search control. Leif should
    // not be able to turn John's entry into Sarah's from an Edit dialog.
    await page.viewport(1280, 900);
    const { element } = buildTestCrm([misspelled], [entry()]);
    const screen = await render(element);

    await openEditDialog(screen);

    await expect
      .element(screen.getByText("Search by name or email…"))
      .not.toBeInTheDocument();
  });

  it("corrects the name on that same Contact, without making another one", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm([misspelled], [entry()]);
    const screen = await render(element);

    await openEditDialog(screen);
    await screen.getByLabelText(/^First name/).fill("John");
    await screen.getByLabelText(/^Last name/).fill("Smith");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("contacts", { id: 1 });
        return `${data.first_name} ${data.last_name}`;
      })
      .toBe("John Smith");

    const { total } = await dataProvider.getList("contacts", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(total).toBe(1);
  });

  it("corrects the email on that same Contact, replacing the wrong one rather than keeping both", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm([misspelled], [entry()]);
    const screen = await render(element);

    await openEditDialog(screen);
    await screen.getByLabelText(/^Email/).fill("john@example.com");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("contacts", { id: 1 });
        return (data.email_jsonb ?? []).map((e: { email: string }) => e.email);
      })
      // Replaced, not appended — a typo should stop being on the record.
      .toEqual(["john@example.com"]);
  });

  it("saves the waitlist fields onto the entry, and nothing else", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm([misspelled], [entry()]);
    const screen = await render(element);

    await openEditDialog(screen);
    await screen.getByLabelText(/^Desired timing/).fill("Spring");
    await screen.getByLabelText(/^Notes/).fill("Met at the workshop");
    await screen.getByLabelText(/^Priority/).fill("2");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("waitlist_entries", {
          id: 1,
        });
        return data.desired_timing;
      })
      .toBe("Spring");

    const { data: saved } = await dataProvider.getOne("waitlist_entries", {
      id: 1,
    });
    expect(saved.notes).toBe("Met at the workshop");
    expect(Number(saved.priority)).toBe(2);
    // The person's details are NOT copied onto the entry.
    expect(saved).not.toHaveProperty("contact_first_name");
    expect(saved).not.toHaveProperty("contact_email");
    expect(JSON.stringify(saved)).not.toContain("jhon@example.com");

    const { total } = await dataProvider.getList("waitlist_entries", {
      filter: {},
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(total).toBe(1);
  });

  it("refuses an email that already belongs to somebody else, and changes nothing", async () => {
    await page.viewport(1280, 900);
    const other = buildContact({
      id: 2,
      first_name: "Sarah",
      last_name: "Jones",
      email_jsonb: [{ email: "sarah.jones@example.com", type: "Work" }],
    });
    const { element, dataProvider } = buildTestCrm(
      [misspelled, other],
      [entry()],
    );
    const screen = await render(element);

    await openEditDialog(screen);
    await screen.getByLabelText(/^Email/).fill("sarah.jones@example.com");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .element(screen.getByText(/Sarah Jones already has this email/i))
      .toBeInTheDocument();

    // Neither Contact moved.
    const { data: mine } = await dataProvider.getOne("contacts", { id: 1 });
    expect(mine.email_jsonb.map((e: { email: string }) => e.email)).toEqual([
      "jhon@example.com",
    ]);
    const { data: theirs } = await dataProvider.getOne("contacts", { id: 2 });
    expect(theirs.email_jsonb.map((e: { email: string }) => e.email)).toEqual([
      "sarah.jones@example.com",
    ]);
  });

  it("will not let an active entry be left with no way to reach the person", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm([misspelled], [entry()]);
    const screen = await render(element);

    await openEditDialog(screen);
    await screen.getByLabelText(/^Email/).fill("");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .element(screen.getByText(/email is needed so you can reach them/i))
      .toBeInTheDocument();

    const { data } = await dataProvider.getOne("contacts", { id: 1 });
    expect(data.email_jsonb.map((e: { email: string }) => e.email)).toEqual([
      "jhon@example.com",
    ]);
  });

  it("changes nothing when the dialog is closed instead of saved", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm([misspelled], [entry()]);
    const screen = await render(element);

    await openEditDialog(screen);
    await screen.getByLabelText(/^First name/).fill("Discarded");
    await screen.getByLabelText(/^Desired timing/).fill("Discarded too");
    await page.getByRole("button", { name: "Close" }).click();

    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();

    const { data: contact } = await dataProvider.getOne("contacts", { id: 1 });
    expect(contact.first_name).toBe("Jhon");
    const { data: saved } = await dataProvider.getOne("waitlist_entries", {
      id: 1,
    });
    expect(saved.desired_timing).toBeNull();
  });

  it("closes on a successful save and shows the corrected name on the row", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm([misspelled], [entry()]);
    const screen = await render(element);

    await openEditDialog(screen);
    await screen.getByLabelText(/^First name/).fill("John");
    await screen.getByLabelText(/^Last name/).fill("Smith");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    // The row Leif was looking at, now right.
    await expect.element(screen.getByText("John Smith")).toBeVisible();
  });

  it("leaves the row's own status actions alone", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm([misspelled], [entry()]);
    const screen = await render(element);

    await screen
      .getByRole("button", { name: "Waitlist entry actions" })
      .click();

    // Status transitions still have their own dedicated actions; the
    // generic edit form never took them over.
    await expect
      .element(screen.getByRole("menuitem", { name: "Mark Invited" }))
      .toBeVisible();
  });
});
