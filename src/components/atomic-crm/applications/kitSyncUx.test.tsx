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
import type {
  Application,
  Deal,
  KitSyncOperation,
  Offer,
} from "@/components/atomic-crm/types";

// The Application page's whole account of Kit: silent when Kit was never
// going to hear about this person, one muted line when it is done, and a card
// only when somebody has to do something.

const LE: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Offer;

const buildCrm = (operations: Partial<KitSyncOperation>[]) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 3, first_name: "Ada", last_name: "Lovelace" }),
      ],
      offers: [LE],
      deals: [
        {
          id: 5,
          contact_id: 3,
          offer_id: 1,
          name: "Ada Lovelace",
          stage: "application_received",
          offer_name_snapshot: "The Living Example",
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: "2026-09-29T00:00:00.000Z",
          updated_at: "2026-09-29T00:00:00.000Z",
        } as unknown as Deal,
      ],
      applications: [
        {
          id: 9,
          contact_id: 3,
          opportunity_id: 5,
          offer_id: 1,
          intended_cohort_id: null,
          status: "pending",
          source: "public_form",
          raw_answers: {},
          submitted_at: "2026-09-29T00:00:00.000Z",
          reviewed_at: null,
          created_at: "2026-09-29T00:00:00.000Z",
          updated_at: "2026-09-29T00:00:00.000Z",
        } as unknown as Application,
      ],
      kit_sync_operations: operations.map(
        (over, index) =>
          ({
            id: index + 1,
            application_id: 9,
            contact_id: 3,
            kind: "applicant",
            email: "ada@example.com",
            kit_tag_id: 24082722,
            kit_tag_name: "MiniDD_Applicant",
            status: "pending",
            attempts: 0,
            last_attempt_at: null,
            succeeded_at: null,
            failed_at: null,
            failure_class: null,
            failure_reason: null,
            kit_subscriber_id: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...over,
          }) as KitSyncOperation,
      ),
      tasks: [],
      enrollment_onboarding_items: [],
    } as never),
    silent: true,
    latency: 0,
  });

  return {
    dataProvider,
    element: (
      <MemoryRouter initialEntries={["/applications/9/show"]}>
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
    ),
  };
};

const failed = {
  status: "failed" as const,
  failed_at: new Date().toISOString(),
  failure_class: "provider_unavailable" as const,
  failure_reason: "Kit responded 503",
};

describe("an application with no Kit work", () => {
  it("says nothing about Kit at all", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm([]);
    const screen = await render(element);

    await expect
      .element(screen.getByText("Ada Lovelace", { exact: false }).first())
      .toBeVisible();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Kit sync needs attention");
    expect(text).not.toContain("Added to Kit");
  });
});

describe("an application Kit has finished with", () => {
  it("names the tags in one quiet line, and asks for nothing", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm([
      {
        status: "succeeded",
        succeeded_at: new Date().toISOString(),
        kit_subscriber_id: "42",
      },
      {
        kind: "decision",
        kit_tag_id: 21784073,
        kit_tag_name: "MiniDD_Approved",
        status: "succeeded",
        succeeded_at: new Date().toISOString(),
        kit_subscriber_id: "42",
      },
    ]);
    const screen = await render(element);

    await expect
      .element(
        screen.getByText("Added to Kit — MiniDD_Applicant, MiniDD_Approved."),
      )
      .toBeVisible();
    expect(document.body.textContent ?? "").not.toContain(
      "Kit sync needs attention",
    );
  });
});

describe("an application Kit never finished", () => {
  it("says what is true, what it costs, and offers the one action", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm([failed]);
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit sync needs attention"))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "This applicant was saved in the CRM, but Kit did not finish syncing, so the emails that follow from this have not gone out.",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText("Kit was unavailable."))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Retry Kit sync" }))
      .toBeVisible();
  });

  it("keeps the provider's own words behind a disclosure, never in the headline", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm([failed]);
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit sync needs attention"))
      .toBeVisible();
    // The status code exists, for when it helps — inside a closed <details>,
    // not in the sentence Leif reads first.
    const details = document.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Kit responded 503");
  });

  it("does not say the application itself went wrong", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm([failed]);
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit sync needs attention"))
      .toBeVisible();
    const text = document.body.textContent ?? "";
    // The CRM's own truth is untouched and unquestioned by a Kit failure.
    expect(text).not.toContain("application failed");
    expect(text).not.toContain("could not be saved");
  });

  it("retries by returning the failed work to the queue, and nothing else", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = buildCrm([
      {
        status: "succeeded",
        succeeded_at: new Date().toISOString(),
        kit_subscriber_id: "42",
      },
      {
        kind: "decision",
        kit_tag_id: 21784073,
        kit_tag_name: "MiniDD_Approved",
        ...failed,
      },
    ]);
    const screen = await render(element);

    await screen.getByRole("button", { name: "Retry Kit sync" }).click();
    await expect.element(screen.getByText("Asking Kit again.")).toBeVisible();

    const { data } = await dataProvider.getList<KitSyncOperation>(
      "kit_sync_operations",
      {
        filter: { application_id: 9 },
        pagination: { page: 1, perPage: 10 },
        sort: { field: "id", order: "ASC" },
      },
    );
    // The failed one is queued again, with its failure cleared.
    const decision = data.find((row) => row.kind === "decision");
    expect(decision?.status).toBe("pending");
    expect(decision?.failure_class ?? null).toBeNull();
    expect(decision?.failed_at ?? null).toBeNull();
    // The one that already succeeded is not touched — no second tag call.
    const applicant = data.find((row) => row.kind === "applicant");
    expect(applicant?.status).toBe("succeeded");
    expect(applicant?.kit_subscriber_id).toBe("42");
  });

  it("offers no button for work that is merely late, because there is nothing to re-queue", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm([
      { created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    ]);
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit sync needs attention"))
      .toBeVisible();
    expect(document.body.textContent ?? "").toContain(
      "This has been waiting longer than it should.",
    );
    const buttons = Array.from(document.body.querySelectorAll("button")).map(
      (button) => button.textContent?.trim(),
    );
    expect(buttons).not.toContain("Retry Kit sync");
  });
});
