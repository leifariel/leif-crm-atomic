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
import type { Deal, Enrollment, Offer, Task } from "../types";

// The two surfaces Leif actually reads a testimonial task on, each rendering
// a task in the shape reconcile_testimonial_tasks() writes.
//
// What this file proves: both surfaces route their title through
// resolveTaskTypeLabel, so neither can show a stored identifier for a type
// the codebase describes. What it deliberately does NOT claim: anything
// about a configuration saved before this release. That state is not
// reachable from here — the harness replaces the Layout that
// useConfigurationLoader lives in, and neither a <CRM taskTypes> prop nor a
// pre-seeded store reaches useConfigurationContext under it (measured: the
// context reports this release's full vocabulary either way). The regression
// for that lives in tasks/taskTypeLabel.test.ts, where the vocabulary is an
// argument and the broken state can be stated outright.
//
// Path under test, confirmed by instrumenting the real component rather than
// reading imports: ClientShow -> TasksCard -> TasksListByDueDate ->
// TaskListFilter -> TasksIterator -> Task.

const offer: Offer = {
  id: 1,
  name: "The Living Example",
  type: "individual",
  duration: "12 weeks",
  current_price: 4000,
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
  offer_name_snapshot: "The Living Example",
  offer_price_snapshot: 4000,
  sales_id: 0,
  index: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  stage_entered_at: "2026-01-01T00:00:00.000Z",
};

const enrollment: Enrollment = {
  id: 1,
  opportunity_id: 1,
  onboarding_tracking: "tracked" as const,
  status: "offboarding",
  start_date: "2026-01-01",
  end_date: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

/**
 * The shape the engine writes: a real enrollment_id, the engine's own text
 * (which keeps its "1/2"), and a due_date that is a genuine commitment —
 * Day 0 is the offboarding date. Dated in the past so it lands in a bucket
 * deterministically rather than depending on today.
 */
const stageTask = (id: number, type: string, text: string): Task => ({
  id,
  contact_id: 1,
  type,
  text,
  due_date: "2026-01-02T00:00:00.000Z",
  done_date: null,
  status: "pending",
  sales_id: 0,
  enrollment_id: 1,
});

const ALL_THREE = [
  stageTask(900, "collect_testimonial", "Collect Maya Chen's testimonial"),
  stageTask(
    901,
    "testimonial_followup_1",
    "Follow up for Maya Chen's testimonial — 1/2",
  ),
  stageTask(
    902,
    "testimonial_followup_2",
    "Follow up for Maya Chen's testimonial — 2/2",
  ),
];

const buildPage = (tasks: Task[], route: string) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [
        buildContact({ id: 1, first_name: "Maya", last_name: "Chen" }),
      ],
      offers: [offer],
      deals: [wonDeal],
      enrollments: [enrollment],
      tasks,
    } as any),
    latency: 0,
    silent: true,
  });

  return (
    <MemoryRouter initialEntries={[route]}>
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
};

const RAW = [
  "collect_testimonial",
  "testimonial_followup_1",
  "testimonial_followup_2",
];

describe("testimonial task labels on the surfaces Leif reads them on", () => {
  it("the Enrollment page names all three stages", async () => {
    const screen = await render(buildPage(ALL_THREE, "/enrollments/1/show"));

    // This surface passes filterByContact, so showContact is false and the
    // title is the label alone — the page is already about Maya.
    await expect.element(screen.getByText("Ask for testimonial")).toBeVisible();
    await expect
      .element(screen.getByText("Testimonial follow-up", { exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Final testimonial follow-up"))
      .toBeVisible();

    for (const raw of RAW) {
      await expect.element(screen.getByText(raw)).not.toBeInTheDocument();
    }
  });

  it("the Dashboard names all three stages, with the person", async () => {
    const screen = await render(buildPage(ALL_THREE, "/"));

    // No filterByContact here, so showContact is on and the title carries
    // the person: "{label}: {person}".
    for (const label of [
      "Ask for testimonial:",
      "Testimonial follow-up:",
      "Final testimonial follow-up:",
    ]) {
      await expect
        .element(screen.getByText(label, { exact: true }))
        .toBeVisible();
    }
    await expect
      .element(screen.getByText("Maya Chen").first())
      .toBeInTheDocument();

    for (const raw of RAW) {
      await expect.element(screen.getByText(raw)).not.toBeInTheDocument();
    }
  });

  // "other" renders its own free text, not a type label — the behaviour this
  // repair must not disturb. One render per test: two CRM trees mounted in
  // one test make every match ambiguous.
  const manual = () => stageTask(910, "other", "Ring the venue about parking");

  it("an ordinary manual task is unaffected on the Enrollment page", async () => {
    const screen = await render(buildPage([manual()], "/enrollments/1/show"));
    await expect
      .element(screen.getByText("Ring the venue about parking"))
      .toBeVisible();
    await expect
      .element(screen.getByText("other", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("an ordinary manual task is unaffected on the Dashboard", async () => {
    const screen = await render(buildPage([manual()], "/"));
    await expect
      .element(screen.getByText("Ring the venue about parking"))
      .toBeVisible();
    await expect
      .element(screen.getByText("other", { exact: true }))
      .not.toBeInTheDocument();
  });
});
