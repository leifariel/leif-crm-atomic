import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { CRM } from "../root/CRM";
import { testI18nProvider } from "@/components/atomic-crm/providers/commons/i18nProvider";
import { createDataProvider } from "@/components/atomic-crm/providers/fakerest";
import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import type { Offer } from "@/components/atomic-crm/types";

// Why the capacity page failed CI once a fortnight.
//
// IndividualProgramPage.capacity.test.tsx lost three assertions at a time —
// "12 / 12 active" absent, "Full — 12 of 12 slots filled." absent, a 45s
// timeout on a month button — while passing 10/10 on its own. It read like a
// slow page, because that page renders null while its data loads.
//
// It was the wrong record. Captured from a real failure by adding the
// rendered text to that file's diagnostics: the page said "Growing Yourself
// Up" and "12 active" with no "/ 12". A group programme has no
// max_active_clients, so there was no ceiling to count against, no
// availability line and no openings it could calculate.
//
// Where it came from: on a mobile-width viewport CRM.tsx renders MobileAdmin,
// which wraps Admin in a PersistQueryClientProvider backed by localStorage
// (gcTime 24h, networkMode "offlineFirst"). Vitest browser mode runs every
// file in ONE browser context on one origin, so that cache is shared by all
// of them, and nothing cleared it between files.
//
// These two tests are the halves of that, in order: the hazard is real, and
// it no longer travels. The second only means anything because the first
// deliberately leaves a poisoned cache behind.

const livingExample = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  max_active_clients: 12,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Offer;

const CACHE_KEY = "REACT_QUERY_OFFLINE_CACHE";

// What another file's mobile mount leaves behind: its own Offer 1, which is
// a group programme with no 1:1 ceiling at all.
const leaveAnotherFilesOfferBehind = () => {
  const wrongOffer = {
    id: 1,
    name: "Growing Yourself Up",
    type: "group",
    duration: "8 weeks",
    current_price: 1400,
    max_active_clients: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const queryKey = ["offers", "getOne", { id: "1" }];
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({
      buster: "",
      timestamp: Date.now(),
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey,
            queryHash: JSON.stringify(queryKey),
            state: {
              data: wrongOffer,
              dataUpdateCount: 1,
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdateCount: 0,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              isInvalidated: false,
              status: "success",
              fetchStatus: "idle",
            },
          },
        ],
      },
    }),
  );
};

const buildDb = () =>
  createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 1, first_name: "Gina", last_name: "McNamara" }),
      ],
      offers: [livingExample],
      deals: [
        {
          id: 1,
          contact_id: 1,
          offer_id: 1,
          name: "Gina McNamara",
          stage: "won",
          offer_name_snapshot: "The Living Example",
          offer_price_snapshot: 4000,
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        } as never,
      ],
      enrollments: [
        {
          id: 1,
          opportunity_id: 1,
          status: "active",
          onboarding_tracking: "tracked",
          start_date: "2020-01-06",
          start_date_source: "owner",
          end_date: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        } as never,
      ],
      expected_session_windows: [],
      client_session_cadence_issues: [],
      waitlist_entries: [],
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

const asPage = (dataProvider: unknown) => (
  <MemoryRouter initialEntries={["/programs/individual/1"]}>
    <CRM
      dataProvider={dataProvider as never}
      authProvider={createTestAuthProvider()}
      i18nProvider={testI18nProvider}
      store={memoryStore()}
      disableTelemetry
    />
  </MemoryRouter>
);

// The provider never answers for offers. So whatever the page names, it can
// only have come from the restored cache — which is what makes the first
// test a measurement of the leak rather than a race against a live fetch.
const buildCrmWhoseOfferNeverLoads = () => {
  const base = buildDb();
  return asPage({
    ...base,
    getOne: async (resource: string, params: never) =>
      resource === "offers"
        ? (new Promise(() => {}) as never)
        : base.getOne(resource, params),
  });
};

// And the ordinary page, answering from its own database.
const buildCrm = () => asPage(buildDb());

describe("a persisted query cache left by another file", () => {
  it("does reach the page, and renders the wrong programme", async () => {
    // Mobile width on purpose: MobileAdmin is the only path that persists.
    await page.viewport(414, 896);
    leaveAnotherFilesOfferBehind();

    const screen = await render(buildCrmWhoseOfferNeverLoads());

    // The whole CI failure, in one line: a programme page for an offer this
    // test never created, with no ceiling to count against.
    await expect
      .element(
        screen.getByText("Growing Yourself Up", { exact: false }).first(),
      )
      .toBeVisible();
    const text = screen.container.textContent ?? "";
    // The real client count with the wrong programme's missing ceiling:
    // "1 active" where this page should say "1 / 12 active".
    expect(text).toContain("1 active");
    expect(text).not.toMatch(/\d+\s*\/\s*\d+\s+active/);
    expect(text).toContain("Can't calculate");

    // Left deliberately in place for the next test.
    expect(localStorage.getItem(CACHE_KEY)).toContain("Growing Yourself Up");
  });

  it("no longer survives into the next test, which renders its own programme", async () => {
    // src/test/isolateBrowserStorage.ts, wired as the app project's
    // setupFiles. This is the invariant the capacity page was missing: not
    // a faster page or a longer timeout, just storage that belongs to one
    // test at a time.
    //
    // Asserted as BUSINESS DATA and not as an empty storage key, because an
    // empty key is a proxy and the thing that actually went wrong was a
    // programme page reporting another programme's ceiling.
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();

    await page.viewport(414, 896);
    const screen = await render(buildCrm());

    await expect
      .element(screen.getByText("The Living Example", { exact: false }).first())
      .toBeVisible();
    const text = screen.container.textContent ?? "";
    expect(text).not.toContain("Growing Yourself Up");
    // Its own ceiling, and its own count against it.
    expect(text).toContain("1 / 12 active");
  });
});
