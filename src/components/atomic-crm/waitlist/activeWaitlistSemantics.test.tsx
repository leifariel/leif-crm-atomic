import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { CoreAdminContext, memoryStore } from "ra-core";
import { QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { useWaitlistEntries } from "./useWaitlistEntries";
import { WaitlistSection } from "./WaitlistSection";
import { createDataProvider } from "../providers/fakerest/dataProvider";
import {
  createCrmDb,
  buildContact,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import { testI18nProvider } from "../providers/commons/i18nProvider";

// ACTIVE WAITLIST MEANS PEOPLE STILL WAITING TO BE INVITED.
//
// THE BUG THIS EXISTS FOR. After the first real batches went out on
// 2026-10-11, the programme pages still read "Waitlist · 63" for The Living
// Example and "Waitlist · 53" for Growing Yourself Up, when only 38 and 23
// people were genuinely still waiting. The 25 and 30 who had just been
// invited were counted, listed and selectable as though nothing had
// happened.
//
// The boundary was `useWaitlistEntries`, which filtered on
// ACTIVE_WAITLIST_STATUSES — a set meaning {waiting, invited} that exists to
// mirror the database's partial unique index for DUPLICATE PREVENTION. Two
// different questions had been answered by one constant: "may this person
// hold another place?" (yes, invited still blocks it) and "is this person
// still waiting for Leif?" (no, they have been invited). Its own comment
// claimed it governed both.
//
// Every waitlist surface reads through that one hook — programme pages,
// cohort pages, the Programs hub card, the Dashboard capacity card, the
// section header count, the list and the selection — so the fix is one rule
// in one place, and this file holds the real hook and the real section to
// it rather than re-stating the filter.

const LE = { waiting: 38, invited: 24, converted: 2, removed: 1 };
const GYU = { waiting: 23, invited: 30, converted: 0, removed: 1 };

type Seed = {
  contacts: ReturnType<typeof buildContact>[];
  entries: Record<string, unknown>[];
};

/** The production shape, person by person, so the counts are real rows. */
const seed = (): Seed => {
  const contacts: ReturnType<typeof buildContact>[] = [];
  const entries: Record<string, unknown>[] = [];
  let contactId = 0;
  let entryId = 0;
  let day = 0;

  const add = (offerId: number, status: string, label: string, n: number) => {
    for (let i = 1; i <= n; i++) {
      contactId += 1;
      entryId += 1;
      day += 1;
      contacts.push(
        buildContact({
          id: contactId,
          first_name: label,
          last_name: `${offerId === 1 ? "LE" : "GYU"}${i}`,
        }) as never,
      );
      entries.push({
        id: entryId,
        offer_id: offerId,
        cohort_id: null,
        contact_id: contactId,
        status,
        joined_at: new Date(
          Date.UTC(2026, 0, 1) + day * 3600_000,
        ).toISOString(),
      });
    }
  };

  for (const [offerId, counts] of [
    [1, LE],
    [2, GYU],
  ] as const) {
    add(offerId, "waiting", "Waiting", counts.waiting);
    add(offerId, "invited", "Invited", counts.invited);
    add(offerId, "converted", "Converted", counts.converted);
    add(offerId, "removed", "Removed", counts.removed);
  }
  return { contacts, entries };
};

/**
 * Exactly how a programme page wires it: the real hook, straight into the
 * real section. IndividualProgramPage.tsx and GroupProgramPage.tsx both do
 * this and nothing else with the result.
 */
const ProgrammeWaitlist = ({ offerId }: { offerId: number }) => {
  const { isPending, entries } = useWaitlistEntries({
    offerId,
    cohortId: null,
  });
  if (isPending) return <p>loading</p>;
  return (
    <WaitlistSection
      entries={entries}
      offerId={offerId}
      offerName={offerId === 1 ? "The Living Example" : "Growing Yourself Up"}
      cohortId={null}
    />
  );
};

const renderProgramme = async (offerId: number) => {
  const { contacts, entries } = seed();
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts,
      offers: [
        {
          id: 1,
          name: "The Living Example",
          type: "individual",
          duration: "4m",
          current_price: 4000,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: 2,
          name: "Growing Yourself Up",
          type: "group",
          duration: "4m",
          current_price: 3000,
          is_active: true,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      waitlist_entries: entries,
    } as never),
    silent: true,
    latency: 0,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await page.viewport(1280, 1200);
  const screen = await render(
    <MemoryRouter>
      <CoreAdminContext
        dataProvider={dataProvider}
        authProvider={createTestAuthProvider()}
        i18nProvider={testI18nProvider}
        store={memoryStore()}
        queryClient={queryClient}
      >
        <ProgrammeWaitlist offerId={offerId} />
      </CoreAdminContext>
    </MemoryRouter>,
  );
  return { screen, dataProvider, queryClient };
};

const headingText = (screen: { container: HTMLElement }) =>
  screen.container.querySelector("h2")?.textContent ?? "";

describe("the programme waitlist counts people still waiting", () => {
  it("The Living Example shows 38, not the 65 it has ever held", async () => {
    const { screen } = await renderProgramme(1);
    await expect.element(screen.getByText(/Waitlist ·/)).toBeInTheDocument();

    expect(headingText(screen)).toBe("Waitlist · 38");
  });

  it("Growing Yourself Up shows 23, not the 54 it has ever held", async () => {
    const { screen } = await renderProgramme(2);
    await expect.element(screen.getByText(/Waitlist ·/)).toBeInTheDocument();

    expect(headingText(screen)).toBe("Waitlist · 23");
  });

  it("nobody invited, converted or removed appears in the list", async () => {
    const { screen } = await renderProgramme(1);
    await expect.element(screen.getByText(/Waitlist ·/)).toBeInTheDocument();

    // Open the collapsed list so every row is actually in the DOM.
    const disclosure = [
      ...screen.container.querySelectorAll<HTMLElement>("button"),
    ].find((button) => /\d+ more/.test(button.textContent ?? ""));
    expect(
      disclosure,
      "the list should be collapsed with a disclosure",
    ).toBeTruthy();
    disclosure!.click();
    await expect
      .element(screen.getByText("Waiting LE38", { exact: true }))
      .toBeInTheDocument();

    const text = screen.container.textContent ?? "";
    // Every waiting person is there.
    for (let i = 1; i <= LE.waiting; i++) {
      expect(text, `Waiting LE${i} should be listed`).toContain(
        `Waiting LE${i}`,
      );
    }
    // And nobody else is, whatever their history.
    expect(text).not.toContain("Invited LE");
    expect(text).not.toContain("Converted LE");
    expect(text).not.toContain("Removed LE");
  });

  it("selection can only reach people who are still waiting", async () => {
    const { screen } = await renderProgramme(1);
    await expect.element(screen.getByText(/Waitlist ·/)).toBeInTheDocument();

    await screen.getByText("Select all").click();

    await expect
      .element(
        screen.getByRole("button", { name: /Invite selected to apply · 38/ }),
      )
      .toBeInTheDocument();
  });

  it("the history is still there — nothing was deleted to make the count right", async () => {
    const { dataProvider } = await renderProgramme(1);

    const all = await dataProvider.getList("waitlist_entries", {
      pagination: { page: 1, perPage: 500 },
      sort: { field: "id", order: "ASC" },
      filter: { offer_id: 1 },
    });
    const byStatus = (status: string) =>
      all.data.filter((row) => row.status === status).length;

    expect(all.data).toHaveLength(65);
    expect(byStatus("waiting")).toBe(38);
    expect(byStatus("invited")).toBe(24);
    expect(byStatus("converted")).toBe(2);
    expect(byStatus("removed")).toBe(1);
  });
});

describe("the count follows authoritative status, both ways", () => {
  it("a confirmed invitation removes the person on the next read", async () => {
    const { screen, dataProvider, queryClient } = await renderProgramme(1);
    await expect.element(screen.getByText(/Waitlist ·/)).toBeInTheDocument();
    expect(headingText(screen)).toBe("Waitlist · 38");

    // What the outbox trigger does when Kit confirms the tag: status and
    // invited_at, nothing else.
    await dataProvider.update("waitlist_entries", {
      id: 1,
      data: { status: "invited", invited_at: new Date().toISOString() },
      previousData: { id: 1 },
    } as never);
    await queryClient.invalidateQueries();

    await expect.element(screen.getByText("Waitlist · 37")).toBeInTheDocument();
    expect(screen.container.textContent ?? "").not.toContain("Waiting LE1");
  });

  it("an invitation that never confirmed leaves the person visible", async () => {
    const { screen, dataProvider, queryClient } = await renderProgramme(1);
    await expect.element(screen.getByText(/Waitlist ·/)).toBeInTheDocument();

    // A failed send: the invitation record exists and says so, and the
    // waitlist entry is deliberately untouched.
    await dataProvider.create("waitlist_invitation_batches", {
      data: { id: 1, offer_id: 1, cohort_id: null, status: "prepared" },
    } as never);
    await dataProvider.create("waitlist_invitations", {
      data: {
        id: 1,
        batch_id: 1,
        waitlist_entry_id: 1,
        contact_id: 1,
        status: "failed",
        failure_reason: "Kit would not deliver to this address",
      },
    } as never);
    await queryClient.invalidateQueries();

    expect(headingText(screen)).toBe("Waitlist · 38");
    expect(screen.container.textContent ?? "").toContain("Waiting LE1");
  });
});
