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
// It used to be its own card floating beneath the offboarding checklist,
// which said — wrongly — that asking for a testimonial is a separate
// concern from winding a client down. It is the same concern; it is simply
// not a requirement. So it is now a row INSIDE that one container, and the
// structural assertions here are what hold it there.
//
// Structure only. Geometry (the divider, the gap, phone width) is proven
// against the real built CSS in e2e/offboardingTestimonialLayout.spec.ts —
// the vitest browser project has no Tailwind plugin, so every utility class
// is inert here and a pixel assertion would measure the user agent.
//
// No acuity appointment type on the offer, so SessionsCard stays out of
// these — the same isolation ClientShow.offboardingHierarchy.test.tsx uses.
const livingExample: Offer = {
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

const growingYourselfUp: Offer = {
  ...livingExample,
  id: 2,
  name: "Growing Yourself Up",
  type: "group",
  current_price: 2000,
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

const requirement = (
  id: number,
  requirement_key: string,
  label: string,
  status: "pending" | "done" = "pending",
): EnrollmentOffboardingItem => ({
  id,
  enrollment_id: 1,
  requirement_key,
  label,
  task_text_template: `Do ${label}`,
  is_required: true,
  sort_order: id,
  status,
  completed_at: null,
  external_ref: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

/** LE raises exactly one requirement. */
const LE_ITEMS = [requirement(1, "notes_archived", "Session notes archived")];
/** GYU raises exactly two. */
const GYU_ITEMS = [
  requirement(1, "slack_removed", "Remove from Slack"),
  requirement(2, "calendar_removed", "Remove from Google Calendar"),
];

// Distinct ids per test, for the cross-test staleness reason
// ClientShow.offboardingHierarchy.test.tsx documents.
let nextId = 1;

const buildTestCrm = ({
  status = "offboarding",
  receivedAt = null,
  offer = livingExample,
  items = LE_ITEMS,
}: {
  status?: Enrollment["status"];
  receivedAt?: string | null;
  offer?: Offer;
  items?: EnrollmentOffboardingItem[];
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
      enrollment_offboarding_items: items.map((item) => ({
        ...item,
        enrollment_id: id,
      })),
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

const testimonialRow = () =>
  document.querySelector('[data-testid="testimonial-row"]');

/** The Card a node sits in, or null when it sits in none. */
const cardOf = (node: Element | null) =>
  node?.closest('[data-slot="card"]') ?? null;

const nodeWithExactText = (text: string) =>
  [...document.querySelectorAll("span, p, h3, label")].find(
    (n) => (n.textContent ?? "").trim() === text,
  ) ?? null;

describe("the testimonial row lives inside the one Offboarding container", () => {
  it("LE: shares a container with notes_archived, and is divided from it", async () => {
    const { element } = buildTestCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByText("Session notes archived"))
      .toBeVisible();

    const row = testimonialRow();
    expect(row, "the testimonial row is on the page").not.toBeNull();

    const requirementLabel = nodeWithExactText("Session notes archived");
    expect(requirementLabel).not.toBeNull();

    // The whole point: ONE container holds both.
    const shared = cardOf(row);
    expect(shared, "the row sits in a card").not.toBeNull();
    expect(
      cardOf(requirementLabel),
      "requirement and testimonial share one container",
    ).toBe(shared);

    // And the separator is the container's own row language, not a second
    // card: both are children of the same divide-y column.
    const column = row!.parentElement!;
    expect(column.className).toContain("divide-y");
    expect(column.contains(requirementLabel!)).toBe(true);

    // No standalone testimonial card anywhere: exactly one Card mentions
    // "Testimonial", and it is the one that also holds the requirement.
    const cardsMentioning = [
      ...document.querySelectorAll('[data-slot="card"]'),
    ].filter((c) => (c.textContent ?? "").includes("Testimonial"));
    expect(cardsMentioning).toHaveLength(1);
    expect(cardsMentioning[0]).toBe(shared);
    expect(cardsMentioning[0].textContent).toContain("Session notes archived");
  });

  it("GYU: shares a container with both of its requirements", async () => {
    const { element } = buildTestCrm({
      offer: growingYourselfUp,
      items: GYU_ITEMS,
    });
    const screen = await render(element);
    await expect.element(screen.getByText("Remove from Slack")).toBeVisible();
    await expect
      .element(screen.getByText("Remove from Google Calendar"))
      .toBeVisible();

    const shared = cardOf(testimonialRow());
    expect(shared).not.toBeNull();
    expect(cardOf(nodeWithExactText("Remove from Slack"))).toBe(shared);
    expect(cardOf(nodeWithExactText("Remove from Google Calendar"))).toBe(
      shared,
    );
  });

  it("carries no checkbox, because it is not a requirement", async () => {
    // The visual signal that it is not counted. Every requirement row has
    // one; this row must not, or it would read as the third thing to tick.
    const { element } = buildTestCrm();
    const screen = await render(element);
    await expect
      .element(screen.getByText("Session notes archived"))
      .toBeVisible();

    const row = testimonialRow()!;
    expect(row.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    // The requirement row beside it does have one, so this is a real
    // distinction rather than an absence of checkboxes everywhere.
    expect(
      row.parentElement!.querySelectorAll('[role="checkbox"]').length,
    ).toBeGreaterThan(0);
  });
});

describe("visual grouping does not change domain semantics", () => {
  it("LE: the denominator still counts only notes_archived", async () => {
    const { element } = buildTestCrm();
    const screen = await render(element);

    await expect.element(screen.getByText("Offboarding 0/1")).toBeVisible();
    // Not 0/2 — the testimonial is in the container, never in the count.
    await expect
      .element(screen.getByText("Offboarding 0/2"))
      .not.toBeInTheDocument();
  });

  it("GYU: the denominator still counts only Slack and Calendar", async () => {
    const { element } = buildTestCrm({
      offer: growingYourselfUp,
      items: GYU_ITEMS,
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Offboarding 0/2")).toBeVisible();
    await expect
      .element(screen.getByText("Offboarding 0/3"))
      .not.toBeInTheDocument();
  });

  it("completion is offered with every requirement done and no testimonial", async () => {
    // The non-blocking rule, stated as the product states it: the client
    // can be completed while the testimonial has never arrived.
    const { element } = buildTestCrm({
      items: [
        requirement(1, "notes_archived", "Session notes archived", "done"),
      ],
    });
    const screen = await render(element);

    await expect.element(screen.getByText("Offboarding 1/1")).toBeVisible();
    await expect.element(screen.getByText("Not received")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Complete client" }))
      .toBeVisible();
  });
});

describe("what the row says", () => {
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
      offer: { ...livingExample, collects_testimonial: false },
    });
    const screen = await render(element);

    // The page and the checklist still render; the row simply is not part
    // of it, and no empty divider is left where it would have been.
    await expect
      .element(screen.getByText("Session notes archived"))
      .toBeVisible();
    await expect
      .element(screen.getByText("Testimonial", { exact: true }))
      .not.toBeInTheDocument();
    expect(testimonialRow()).toBeNull();
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

  it("is absent before offboarding has started at all", async () => {
    const { element } = buildTestCrm({ status: "active", items: [] });
    const screen = await render(element);

    await expect
      .element(screen.getByRole("heading", { name: "Tasks" }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Testimonial", { exact: true }))
      .not.toBeInTheDocument();
  });
});

describe("a completed Enrollment still exposes it", () => {
  // Adriano (Enrollment 50) is the accepted proof that testimonial outreach
  // survives ordinary offboarding completion. His checklist collapses — the
  // requirements are history — but the row must stay VISIBLE, not fold away
  // with them, or the refactor would hide exactly the case the sequence
  // exists for.
  it("remains visible without expanding the collapsed checklist", async () => {
    const { element } = buildTestCrm({
      status: "completed",
      items: [
        requirement(1, "notes_archived", "Session notes archived", "done"),
      ],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText(/Offboarding · Complete 1\/1/))
      .toBeVisible();

    // The OFFBOARDING disclosure specifically — a completed Enrollment
    // collapses its onboarding checklist too, so the first <details> on the
    // page is not the one this test is about.
    const details = [...document.querySelectorAll("details")].find((d) =>
      (d.querySelector("summary")?.textContent ?? "").includes("Offboarding"),
    );
    expect(details, "the offboarding disclosure is on the page").toBeTruthy();
    // Visible with that disclosure still shut.
    expect(details!.open).toBe(false);

    await expect
      .element(screen.getByText("Testimonial", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText("Not received")).toBeVisible();
    await expect
      .element(
        screen.getByRole("button", { name: "Mark testimonial received" }),
      )
      .toBeVisible();

    // Still part of the same Offboarding container, not a card of its own.
    const row = testimonialRow()!;
    expect(row.closest("details")).toBeNull();
    expect(row.closest(".rounded-lg.border")).toBe(
      details!.parentElement as Element,
    );

    // And nothing invented a requirement to carry it: the count is still
    // over the one real requirement, not two.
    await expect
      .element(screen.getByText("Offboarding · Complete 1/2"))
      .not.toBeInTheDocument();
  });

  it("a completed Enrollment that does not ask shows no empty strip", async () => {
    const { element } = buildTestCrm({
      status: "completed",
      offer: { ...livingExample, collects_testimonial: false },
      items: [
        requirement(1, "notes_archived", "Session notes archived", "done"),
      ],
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText(/Offboarding · Complete 1\/1/))
      .toBeVisible();
    expect(testimonialRow()).toBeNull();
  });
});
