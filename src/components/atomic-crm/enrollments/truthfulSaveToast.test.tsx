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
import type { Deal, Enrollment, Offer } from "@/components/atomic-crm/types";

// Leif set Todd Jacobsen's start week. The CRM said "Client updated". The
// week was not there afterwards.
//
// The missing week is one bug. The sentence is a worse one, because it is
// the thing that sent him away believing the decision was recorded — and it
// would have said the same about any field, in any form, for any reason the
// write did not take. So the success message is now earned from the record
// that came back, and these are the four cases that keep it honest:
//
//   1. an honest save says so, and gets out of the way
//   2. a write that is accepted and does not persist does NOT say "updated"
//   3. clearing the week on purpose is a statement, and saving it is a save
//   4. a status-only edit is not tripped up by a week nobody touched
//
// Case 2 is the regression. Before this repair it showed "Client updated"
// and closed the modal.

const LE = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as Offer;

type Lie = (saved: Partial<Enrollment>) => Partial<Enrollment>;

// Every update the provider was actually ASKED for. Under the undoable
// default this list stayed empty while the CRM said "Client updated".
const asked: { resource: string; data: Partial<Enrollment> }[] = [];

const buildCrm = ({
  startDate = null,
  lie,
  rejectWith,
  route = "/enrollments/7/show",
}: {
  startDate?: string | null;
  lie?: Lie;
  rejectWith?: string;
  route?: string;
} = {}) => {
  const base = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 3, first_name: "Nadia", last_name: "Okoro" }),
      ],
      offers: [LE],
      deals: [
        {
          id: 5,
          contact_id: 3,
          offer_id: 1,
          name: "Nadia Okoro",
          stage: "won",
          offer_name_snapshot: "The Living Example",
          offer_price_snapshot: 4000,
          amount: 4000,
          index: 0,
          sales_id: 0,
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z",
        } as unknown as Deal,
      ],
      enrollments: [
        {
          id: 7,
          opportunity_id: 5,
          status: "active",
          onboarding_tracking: "tracked",
          start_date: startDate,
          start_date_source: startDate ? "owner" : null,
          end_date: null,
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z",
        } as unknown as Enrollment,
      ],
      enrollment_onboarding_items: [],
      tasks: [],
    } as never),
    silent: true,
    latency: 0,
  });

  // A provider that accepts the write and reports a record that does not
  // carry it. This is the shape of the Todd failure as the browser saw it:
  // no error anywhere, and the value simply not there.
  const dataProvider = {
    ...base,
    update: async (resource: string, params: { data: unknown }) => {
      asked.push({ resource, data: params.data as Partial<Enrollment> });
      if (rejectWith && resource === "enrollments") {
        throw new Error(rejectWith);
      }
      const result = await base.update(resource, params as never);
      return lie && resource === "enrollments"
        ? { data: lie(result.data as Partial<Enrollment>) }
        : result;
    },
  };

  return {
    dataProvider,
    element: (
      <MemoryRouter initialEntries={[route]}>
        <CRM
          dataProvider={dataProvider as never}
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

const openEditor = async (screen: Awaited<ReturnType<typeof render>>) => {
  await screen.getByRole("button", { name: "Set start week" }).click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
};

// By its label, the way Leif finds it. The dialog renders in a portal,
// outside the render container, so a container-scoped locator misses it.
const startWeekField = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByLabelText(/^Start week/);

describe("the save reaching the database at all", () => {
  it("asks the provider, rather than only its own cache", async () => {
    // The regression, and the root of the Todd failure. EditBase defaults
    // to mutationMode="undoable": onSuccess fires on an OPTIMISTIC record
    // and the real update is deferred until ra-core's undo toast emits
    // "end". This modal raises its own toast and closes itself, so that
    // "end" never came and the update was never sent — not after five
    // seconds, not ever. Before the fix this list was empty.
    await page.viewport(1280, 1400);
    asked.length = 0;
    const { element } = buildCrm();
    const screen = await render(element);

    await openEditor(screen);
    await startWeekField(screen).fill("2026-11-09");
    await screen.getByRole("button", { name: "Save" }).click();
    await expect.element(screen.getByText("Client updated")).toBeVisible();

    const updates = asked.filter((call) => call.resource === "enrollments");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data.start_date).toBe("2026-11-09");
    expect(updates[0]!.data.start_date_source).toBe("owner");
  });
});

describe("an honest save", () => {
  it("says the client was updated and gets out of the way", async () => {
    await page.viewport(1280, 1400);
    const { dataProvider, element } = buildCrm();
    const screen = await render(element);

    await openEditor(screen);
    await startWeekField(screen).fill("2026-11-09");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.element(screen.getByText("Client updated")).toBeVisible();
    const { data } = await dataProvider.getOne<Enrollment>("enrollments", {
      id: 7,
    });
    expect(data.start_date).toBe("2026-11-09");
    expect(data.start_date_source).toBe("owner");
  });
});

describe("a write that is accepted and does not persist", () => {
  it("does not claim the client was updated", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      lie: (saved) => ({ ...saved, start_date: null }),
    });
    const screen = await render(element);

    await openEditor(screen);
    await startWeekField(screen).fill("2026-11-09");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("Not saved", { exact: false }))
      .toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("Client updated");
  });

  it("names the start week and the real outcome", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      lie: (saved) => ({ ...saved, start_date: null }),
    });
    const screen = await render(element);

    await openEditor(screen);
    await startWeekField(screen).fill("2026-11-09");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(
        screen.getByText("start week saved as empty, not 2026-11-09", {
          exact: false,
        }),
      )
      .toBeVisible();
  });

  it("keeps the modal open, and keeps saying so", async () => {
    // Closing on a save that did not happen hides it: there is nothing Leif
    // can do about it from the page behind. So the modal stays, and the
    // warning has no auto-dismiss — it is not a passing status line, it is
    // an unfinished decision.
    //
    // The field itself does reset: ra-core reinitialises the form from the
    // record that came back, which is exactly the record missing the week.
    // Fighting that would mean fighting the form library for a value that
    // is already on screen in the message, named as the week he asked for.
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      lie: (saved) => ({ ...saved, start_date: null }),
    });
    const screen = await render(element);

    await openEditor(screen);
    await startWeekField(screen).fill("2026-11-09");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("Not saved", { exact: false }))
      .toBeVisible();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    // What he asked for is still in front of him.
    await expect
      .element(screen.getByText("2026-11-09", { exact: false }))
      .toBeVisible();
  });

  it("reports a week saved as a DIFFERENT day rather than accepting it", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      lie: (saved) => ({ ...saved, start_date: "2026-11-02" }),
    });
    const screen = await render(element);

    await openEditor(screen);
    await startWeekField(screen).fill("2026-11-09");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("saved as 2026-11-02", { exact: false }))
      .toBeVisible();
  });
});

describe("a write the database refuses", () => {
  it("does not claim the client was updated", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm({ rejectWith: "permission denied" });
    const screen = await render(element);

    await openEditor(screen);
    await startWeekField(screen).fill("2026-11-09");
    await screen.getByRole("button", { name: "Save" }).click();

    // ra-core's own error path handles the message; what matters here is
    // that the success sentence is nowhere on screen.
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("Client updated");
  });
});

describe("a saved record about a different client", () => {
  it("is never reported as a save", async () => {
    // The one failure a value comparison reads as perfect: every field
    // matches and it is somebody else's row.
    //
    // Measured here, ra-core refuses it BEFORE this modal's own check ever
    // runs — useEditController throws "Fetched record's id attribute
    // (4242) must match the requested 'id' (7)" into the error boundary.
    // So this asserts the outcome that matters rather than this file's own
    // wording, and assessEnrollmentSave's identity check (unit-tested in
    // savedWhatWasStated.test.ts) stays as the second lock on a path where
    // ra-core does not look.
    await page.viewport(1280, 1400);
    const { element } = buildCrm({
      lie: (saved) => ({ ...saved, id: 4242 }),
    });
    const screen = await render(element);

    await openEditor(screen);
    await startWeekField(screen).fill("2026-11-09");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("Save", { exact: false }).first())
      .toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("Client updated");
  });
});

describe("clearing the start week on purpose", () => {
  it("is a statement, and saving it is a save", async () => {
    await page.viewport(1280, 1400);
    // An owner-stated week raises no card, so the modal is reached through
    // the thin /edit wrapper — the same component, the other door.
    const { dataProvider, element } = buildCrm({
      startDate: "2026-11-09",
      route: "/enrollments/7/edit",
    });
    const screen = await render(element);

    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect.element(startWeekField(screen)).toHaveValue("2026-11-09");
    await startWeekField(screen).fill("");
    // Commit the clear before submitting. DateInput deliberately does NOT
    // push an empty value through onChange ("The input reset is handled in
    // the onBlur event handler"), so the field is only cleared once it
    // loses focus.
    //
    // This line became necessary when the modal gained the projected final
    // session week, which subscribes to start_date via useWatch: the extra
    // re-render changed the timing enough that this synthetic click raced
    // the blur. A real browser does not — mousedown blurs before click —
    // and the Golden Journey proves that path against the production
    // build, desktop and Pixel 5. So this is the test catching up with the
    // component, not a defect being papered over.
    await startWeekField(screen).element().blur();
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.element(screen.getByText("Client updated")).toBeVisible();
    const { data } = await dataProvider.getOne<Enrollment>("enrollments", {
      id: 7,
    });
    expect(data.start_date ?? null).toBeNull();
    // And no source either — the only honest way to say "not decided yet".
    expect(data.start_date_source ?? null).toBeNull();
  });
});

describe("an edit that does not touch the start week", () => {
  it("is not tripped up by a week nobody stated", async () => {
    await page.viewport(1280, 1400);
    const { element } = buildCrm();
    const screen = await render(element);

    await openEditor(screen);
    // Save with the form exactly as it loaded: no week, no finish date.
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.element(screen.getByText("Client updated")).toBeVisible();
    expect(document.body.textContent ?? "").not.toContain("Not saved");
  });
});
