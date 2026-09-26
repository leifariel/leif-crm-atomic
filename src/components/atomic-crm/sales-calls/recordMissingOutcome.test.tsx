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
import type { Deal, Offer, SalesCall } from "../types";

// Becky Schmauch could not finish her own sale.
//
// Her Opportunity read "Sales Call · Completed / Attended" and offered no
// action at all, because the page asked whether attendance had been
// recorded rather than whether a DECISION had. The backend convergence path
// existed and was unreachable from the UI.
//
// These drive the real Opportunity page: the action appears on her shape,
// opens the SAME outcome dialog, and submitting Yes goes through the one
// canonical path.

const offer: Offer = {
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

const deal = (over: Partial<Deal> = {}): Deal =>
  ({
    id: 900,
    contact_id: 1,
    offer_id: 1,
    cohort_id: null,
    name: "Becky Schmauch",
    stage: "call_booked",
    outcome: null,
    owner_decision: null,
    prospect_decision: null,
    follow_up_date: null,
    amount: 4000,
    entry_path: "other",
    description: "",
    archived_at: null,
    pricing_mode: "standard",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...over,
  }) as Deal;

const call = (over: Partial<SalesCall> = {}): SalesCall =>
  ({
    id: 700,
    opportunity_id: 900,
    contact_id: 1,
    scheduled_at: "2026-09-20T17:00:00.000Z",
    original_scheduled_at: "2026-09-20T17:00:00.000Z",
    scheduled_on: "2026-09-20",
    schedule_precision: "exact",
    status: "completed",
    attendance: "attended",
    attendance_recorded_at: "2026-09-20T18:00:00.000Z",
    reschedule_count: 0,
    source: "manual",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T18:00:00.000Z",
    ...over,
  }) as SalesCall;

const buildCrm = (
  deals: Deal[],
  calls: SalesCall[],
  events: unknown[] = [],
) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 1, first_name: "Becky", last_name: "Schmauch" }),
      ],
      offers: [offer],
      cohorts: [],
      deals,
      sales_calls: calls,
      sales_call_events: events,
      applications: [],
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });
  const element = (
    <MemoryRouter initialEntries={["/deals/900/show"]}>
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

type Screen = Awaited<ReturnType<typeof render>>;

const listAll = (dp: ReturnType<typeof createDataProvider>, resource: string) =>
  dp.getList(resource, {
    filter: {},
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });

const recordOutcome = (screen: Screen) =>
  screen.getByRole("button", { name: "Record outcome" });

describe("a completed, attended call whose decision never landed", () => {
  it("offers Record outcome on Becky's exact shape", async () => {
    await page.viewport(1280, 1100);
    const { element } = buildCrm([deal()], [call()]);
    const screen = await render(element);

    await expect
      .element(screen.getByText("Sales Call · Completed"))
      .toBeVisible();
    // The gap: this used to be the end of it.
    await expect
      .element(screen.getByText(/no decision was recorded/i))
      .toBeVisible();
    await expect.element(recordOutcome(screen)).toBeVisible();
  });

  it("opens the canonical outcome dialog, with Attended already understood", async () => {
    await page.viewport(1280, 1100);
    const { element } = buildCrm([deal()], [call()]);
    const screen = await render(element);

    await recordOutcome(screen).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();

    const dialog = screen.getByRole("dialog").element() as HTMLElement;
    // Titled for what it does: the call is already complete, and only its
    // outcome is missing. (It is the same component — see the contract in
    // contracts/deals/wonIsWritableByItsOwnWriter.test.ts.)
    expect(dialog.textContent).toContain("Record Outcome");
    // Attendance is stated, not re-asked: offering No-show here would let a
    // recovery rewrite a recorded fact.
    expect(dialog.textContent).toContain("recorded as Attended");
    expect(dialog.textContent).not.toContain("What happened with this call?");
    // And the question that has no answer is the one on screen.
    expect(dialog.textContent).toContain("Would I work with this person?");
  });

  it("records Yes through the canonical path: Won, one Enrollment, no duplicate event", async () => {
    await page.viewport(1280, 1100);
    const { element, dataProvider } = buildCrm(
      [deal()],
      [call()],
      // She already has her attendance event from the half-landed attempt.
      [
        {
          id: 1,
          sales_call_id: 700,
          kind: "attendance_recorded",
          occurred_at: "2026-09-20T18:00:00.000Z",
          attendance: "attended",
        },
      ],
    );
    const screen = await render(element);

    await recordOutcome(screen).click();
    await screen.getByLabelText("Would work with").click();
    await screen.getByLabelText("Yes", { exact: true }).click();
    await screen
      .getByRole("button", { name: /record|save|complete/i })
      .last()
      .click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("deals", { id: 900 });
        return data.stage;
      })
      .toBe("won");

    const { data: won } = await dataProvider.getOne("deals", { id: 900 });
    expect(won.prospect_decision).toBe("yes");

    // Exactly one Enrollment, and no second attendance event.
    const events = await listAll(dataProvider, "sales_call_events");
    expect(
      events.data.filter((e) => e.kind === "attendance_recorded").length,
    ).toBe(1);
  });
});

describe("when no decision is owed", () => {
  it("offers no recovery action once the outcome is fully recorded", async () => {
    await page.viewport(1280, 1100);
    const { element } = buildCrm(
      [
        deal({
          owner_decision: "would_work_with",
          prospect_decision: "yes",
          stage: "won",
        }),
      ],
      [call()],
    );
    const screen = await render(element);

    // Wait for something POSITIVE: an absence is satisfied while loading.
    await expect
      .element(screen.getByText("Sales Call · Completed"))
      .toBeVisible();
    // And the decision it DOES have is shown, rather than only "Attended".
    // Queried as an element, not through screen.container: the Opportunity
    // is itself a Dialog, so its content lives in a portal outside it.
    await expect
      .element(screen.getByText("Would work with", { exact: false }))
      .toBeVisible();
    await expect.element(recordOutcome(screen)).not.toBeInTheDocument();
  });

  it("offers nothing on a no-show, and does not reopen it as attended", async () => {
    await page.viewport(1280, 1100);
    const { element } = buildCrm(
      [deal()],
      [
        call({
          attendance: "no_show",
          attendance_recorded_at: "2026-09-20T18:00:00.000Z",
        }),
      ],
    );
    const screen = await render(element);

    await expect
      .element(screen.getByText("Sales Call · Completed"))
      .toBeVisible();
    await expect.element(recordOutcome(screen)).not.toBeInTheDocument();
  });

  it("offers nothing once the sale has ended some other way", async () => {
    await page.viewport(1280, 1100);
    const { element } = buildCrm(
      [deal({ outcome: "lost", prospect_decision: "no" })],
      [call()],
    );
    const screen = await render(element);

    await expect
      .element(screen.getByText("Sales Call · Completed"))
      .toBeVisible();
    await expect.element(recordOutcome(screen)).not.toBeInTheDocument();
  });
});

describe("the normal fresh completion still works", () => {
  it("still shows Complete Sales Call on an unresolved booked call", async () => {
    await page.viewport(1280, 1100);
    const { element } = buildCrm(
      [deal()],
      [
        call({
          status: "booked",
          attendance: null,
          attendance_recorded_at: null,
        }),
      ],
    );
    const screen = await render(element);

    await expect
      .element(screen.getByRole("button", { name: "Complete Sales Call" }))
      .toBeVisible();
    await expect.element(recordOutcome(screen)).not.toBeInTheDocument();
  });

  it("asks what happened on a fresh call, rather than assuming Attended", async () => {
    await page.viewport(1280, 1100);
    const { element } = buildCrm(
      [deal()],
      [
        call({
          status: "booked",
          attendance: null,
          attendance_recorded_at: null,
        }),
      ],
    );
    const screen = await render(element);

    await screen.getByRole("button", { name: "Complete Sales Call" }).click();
    const dialog = screen.getByRole("dialog").element() as HTMLElement;
    expect(dialog.textContent).toContain("What happened with this call?");
    expect(dialog.textContent).not.toContain("recorded as Attended");
  });
});
