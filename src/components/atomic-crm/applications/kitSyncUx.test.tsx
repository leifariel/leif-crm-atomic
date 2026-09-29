import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The Application page's whole account of Kit, as Leif reads it: one compact
// line for every state, a card only for the one that needs him, and silence
// only for an imported record that is finished history.

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

const buildCrm = ({
  operations = [],
  status = "pending",
  source = "public_form",
}: {
  operations?: Partial<KitSyncOperation>[];
  status?: string;
  source?: string;
} = {}) => {
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
          status,
          source,
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

const succeeded = {
  status: "succeeded" as const,
  succeeded_at: new Date().toISOString(),
  kit_subscriber_id: "42",
};
const failed = {
  status: "failed" as const,
  failed_at: new Date().toISOString(),
  failure_class: "provider_unavailable" as const,
  failure_reason: "Kit responded 503",
};
const DECISION = {
  kind: "decision" as const,
  kit_tag_id: 21784073,
  kit_tag_name: "MiniDD_Approved",
};

// Nothing on this page may reach Kit: the answer comes from the CRM's own
// rows. A spy on fetch proves it rather than trusting the code to behave.
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(window, "fetch");
});
afterEach(() => {
  fetchSpy.mockRestore();
});
const kitCalls = () =>
  (fetchSpy.mock.calls as unknown as Array<[string | Request | URL]>).filter(
    ([input]) => {
      const url =
        typeof input === "string"
          ? input
          : ((input as Request)?.url ?? String(input));
      return url.includes("kit.com");
    },
  );

describe("Kit is handling it", () => {
  it("says Kit: Tagged, and keeps tag names out of the way", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ operations: [succeeded] });
    const screen = await render(element);

    await expect.element(screen.getByText("Kit: Tagged ✓")).toBeVisible();
    // The tag name exists, behind a disclosure that starts shut — not in the
    // line Leif reads every day.
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Added to Kit — MiniDD_Applicant");
    const details = document.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("MiniDD_Applicant");
    expect(kitCalls()).toEqual([]);
  });

  it("says Tagged on a decided application once both tags have landed", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      status: "approved",
      operations: [succeeded, { ...DECISION, ...succeeded }],
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Kit: Tagged ✓")).toBeVisible();
  });

  it("says Kit: Syncing while the decision tag is still on its way", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      status: "approved",
      operations: [succeeded, DECISION],
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Kit: Syncing…")).toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("Kit: Tagged");
  });
});

describe("Kit is not handling it", () => {
  it("tells Leif plainly that a live applicant needs a manual email", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ operations: [] });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit: Not synced — email manually"))
      .toBeVisible();
    expect(kitCalls()).toEqual([]);
  });

  it("says nothing at all for an imported historical record", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      source: "historical_import",
      operations: [],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Ada Lovelace", { exact: false }).first())
      .toBeVisible();
    const text = document.body.textContent ?? "";
    // The contract that matters: history must never read as outstanding work.
    expect(text).not.toContain("email manually");
    expect(text).not.toContain("Kit: ");
  });

  it("says Kit is not used for somebody the CRM refused", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ status: "do_not_engage", operations: [] });
    const screen = await render(element);

    await expect.element(screen.getByText("Kit: Not used")).toBeVisible();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("email manually");
    expect(text).not.toContain("Needs attention");
  });
});

describe("when somebody has to look", () => {
  it("keeps the card, the reason and the retry action", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ operations: [failed] });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit: Needs attention"))
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
    // The provider's own words stay behind a closed disclosure.
    const details = document.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Kit responded 503");
    expect(kitCalls()).toEqual([]);
  });

  it("retries by re-queuing only the failed work", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = buildCrm({
      status: "approved",
      operations: [succeeded, { ...DECISION, ...failed }],
    });
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
    const decision = data.find((row) => row.kind === "decision");
    expect(decision?.status).toBe("pending");
    expect(decision?.failure_class ?? null).toBeNull();
    const applicant = data.find((row) => row.kind === "applicant");
    expect(applicant?.status).toBe("succeeded");
    // Still no Kit call from the browser: the retry goes through the CRM.
    expect(kitCalls()).toEqual([]);
  });

  it("offers no button for work that is merely late", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      operations: [
        { created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      ],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Kit: Needs attention"))
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
