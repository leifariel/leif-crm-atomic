import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { memoryStore } from "ra-core";
import { MemoryRouter } from "react-router";

import { Notification } from "@/components/admin/notification";
import { CRM } from "../root/CRM";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import type {
  Deal,
  Enrollment,
  EnrollmentOffboardingItem,
  EnrollmentOnboardingItem,
  Offer,
} from "../types";

// Did the testimonial arrive? Leif must be able to answer that without
// reading task titles, and the CRM must never claim it arrived because the
// asking is over.
//
// No acuity appointment type on the offer, so SessionsCard stays out of
// these — the same isolation ClientShow.offboardingHierarchy.test.tsx uses.
const offerThatAsks: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "4 months",
  current_price: 4000,
  collects_testimonial: true,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const wonDeal: Deal = {
  id: 1,
  name: "Maya Chen",
  contact_id: 1,
  offer_id: 1,
  stage: "won",
  outcome: null,
  amount: 4000,
  sales_id: 0,
  index: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  stage_entered_at: "2026-01-01T00:00:00.000Z",
};

const doneOnboardingItems: EnrollmentOnboardingItem[] = [1, 2].map((id) => ({
  id,
  enrollment_id: 1,
  requirement_key: `onboard-${id}`,
  label: `Onboarding item ${id}`,
  task_text_template: `Complete onboarding item ${id}`,
  is_required: true,
  sort_order: id,
  status: "done",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
}));

const archiveNotes: EnrollmentOffboardingItem = {
  id: 1,
  enrollment_id: 1,
  requirement_key: "notes_archived",
  label: "Session notes archived",
  task_text_template: "Move Maya Chen's session notes to Past Clients",
  is_required: true,
  sort_order: 1,
  status: "pending",
  completed_at: null,
  external_ref: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

// Distinct ids per test, for the cross-test staleness reason
// ClientShow.offboardingHierarchy.test.tsx documents.
let nextId = 1;

const buildTestCrm = ({
  status = "offboarding",
  receivedAt = null,
  offer = offerThatAsks,
  withOffboardingItems = true,
}: {
  status?: Enrollment["status"];
  receivedAt?: string | null;
  offer?: Offer;
  withOffboardingItems?: boolean;
} = {}) => {
  const id = nextId++;
  const enrollment: Enrollment = {
    id,
    opportunity_id: id,
    onboarding_tracking: "tracked" as const,
    status,
    start_date: "2026-01-01",
    end_date: null,
    testimonial_received_at: receivedAt,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const deal: Deal = { ...wonDeal, id, contact_id: id, offer_id: offer.id };

  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [buildContact({ id, first_name: "Maya", last_name: "Chen" })],
      offers: [offer],
      deals: [deal],
      enrollments: [enrollment],
      enrollment_onboarding_items: doneOnboardingItems.map((item) => ({
        ...item,
        enrollment_id: id,
      })),
      enrollment_offboarding_items: withOffboardingItems
        ? [{ ...archiveNotes, enrollment_id: id }]
        : [],
      offboarding_requirement_templates: [],
      tasks: [],
    } as never),
    silent: true,
  });

  return {
    id,
    dataProvider,
    element: (
      <MemoryRouter initialEntries={[`/enrollments/${id}/show`]}>
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

describe("Testimonial card", () => {
  it("says it has not arrived, and offers the one action", async () => {
    const { element } = buildTestCrm();
    const screen = await render(element);

    await expect
      .element(screen.getByText("Testimonial", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText("Not received")).toBeVisible();
    await expect
      .element(
        screen.getByRole("button", { name: "Mark testimonial received" }),
      )
      .toBeVisible();
  });

  it("says when it arrived, and stops offering the action", async () => {
    const { element } = buildTestCrm({
      receivedAt: "2026-10-13T09:00:00.000Z",
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText(/Received Oct 13, 2026/))
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("button", { name: "Mark testimonial received" }),
      )
      .not.toBeInTheDocument();
  });

  it("stays out of a programme that does not ask", async () => {
    const { element } = buildTestCrm({
      offer: { ...offerThatAsks, collects_testimonial: false },
    });
    const screen = await render(element);

    // The page still renders; the testimonial card simply is not part of it.
    await expect
      .element(screen.getByRole("heading", { name: "Tasks" }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Testimonial", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("records receipt against the Enrollment, and says so only then", async () => {
    const { element, dataProvider, id } = buildTestCrm();
    const screen = await render(element);

    await screen
      .getByRole("button", { name: "Mark testimonial received" })
      .click();

    // The authority is the Enrollment row, not the toast.
    await expect
      .poll(async () => {
        const { data } = await dataProvider.getOne("enrollments", { id });
        return data.testimonial_received_at == null ? null : "set";
      })
      .toBe("set");

    await expect
      .element(screen.getByText("Testimonial recorded as received."))
      .toBeVisible();
  });

  // A client's testimonial must never block the Enrollment finishing, so
  // the card keeps working on a completed Enrollment — a testimonial can
  // arrive after everything else is done.
  it("is still there once the Enrollment has completed", async () => {
    const { element } = buildTestCrm({ status: "completed" });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Testimonial", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText("Not received")).toBeVisible();
  });

  it("is absent before offboarding has started at all", async () => {
    const { element } = buildTestCrm({
      status: "active",
      withOffboardingItems: false,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByRole("heading", { name: "Tasks" }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Testimonial", { exact: true }))
      .not.toBeInTheDocument();
  });
});
