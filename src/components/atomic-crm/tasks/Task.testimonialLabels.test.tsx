import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { buildDeal, buildTestCrm } from "./actionDestinationTestFixtures";
import { defaultTaskTypes } from "../root/defaultConfiguration";
import type { Task } from "../types";

// The testimonial stages are machinery's own task types, and the names
// machinery uses are not names Leif should ever read. `collect_testimonial`
// reached the screen because typeLabel() in Task.tsx falls back to the raw
// stored value for any type missing from the configured vocabulary, and the
// three stages were added to the database CHECK without being added to
// defaultTaskTypes.
//
// Display only: the stored `type` strings are exactly what they were, which
// is what the engine, the unique index and the reconciler all key on.
//
// The task TEXT is the engine's, and is left alone — reconcile_testimonial_
// tasks() writes "Follow up for Jules's testimonial — 1/2", so these
// fixtures use that real wording rather than empty text. A fixture with no
// text would let an assertion pass for the wrong reason.
const stage = (id: number, type: string, text: string): Task => ({
  id,
  contact_id: 1,
  type,
  text,
  due_date: "2026-01-01T00:00:00.000Z",
  done_date: null,
  status: "pending",
  sales_id: 0,
  enrollment_id: 1,
});

const PERSON = "Jules Litman-Cleper";

const allThreeStages = () => [
  stage(3000, "collect_testimonial", `Collect ${PERSON}'s testimonial`),
  stage(
    3001,
    "testimonial_followup_1",
    `Follow up for ${PERSON}'s testimonial — 1/2`,
  ),
  stage(
    3002,
    "testimonial_followup_2",
    `Follow up for ${PERSON}'s testimonial — 2/2`,
  ),
];

describe("Task — testimonial stage labels", () => {
  it("shows each stage by its human name, never the stored type", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm({
      deals: [buildDeal({ stage: "won" })],
      tasks: allThreeStages(),
    });
    const screen = await render(element);

    // The row's title is "{type label}: {person}", so the label carries the
    // ": " with it. Asserted exactly, because a loose match would let
    // "Final testimonial follow-up" satisfy the second stage as well.
    for (const label of [
      "Ask for testimonial:",
      "Testimonial follow-up:",
      "Final testimonial follow-up:",
    ]) {
      await expect
        .element(screen.getByText(label, { exact: true }))
        .toBeInTheDocument();
    }

    // No internal identifier anywhere on the page.
    for (const raw of [
      "collect_testimonial",
      "testimonial_followup_1",
      "testimonial_followup_2",
    ]) {
      await expect.element(screen.getByText(raw)).not.toBeInTheDocument();
    }
  });

  it("sends all three stages to the page that can answer them", async () => {
    // Registering the three types in the Needs Attention inventory is what
    // forced this: a type with no destination falls back to the generic
    // Task editor, where Description / Due date / Type / Status cannot
    // record that a testimonial arrived. The Enrollment's own page holds
    // the control that can — TestimonialCard's "Mark testimonial received".
    await page.viewport(1280, 900);
    const { element } = buildTestCrm({
      deals: [buildDeal({ stage: "won" })],
      tasks: allThreeStages(),
    });
    const screen = await render(element);
    // Wait for the rows to paint before reading the DOM directly; a bare
    // querySelectorAll straight after render() finds nothing yet and would
    // make this assertion vacuous.
    await expect
      .element(screen.getByText("Ask for testimonial:", { exact: true }))
      .toBeInTheDocument();

    const hrefs = [...document.querySelectorAll("a")]
      .filter((a) => /testimonial/i.test(a.textContent ?? ""))
      .map((a) => a.getAttribute("href") ?? "");

    expect(hrefs).toHaveLength(3);
    for (const href of hrefs) {
      // The Enrollment the task carries, resolved from Task.enrollment_id.
      expect(href).toContain("/enrollments/1/show");
    }
  });

  it("keeps the stage numbers out of the vocabulary itself", async () => {
    // The engine's task text still says "— 1/2", and that is its business.
    // What the LABEL must not do is repeat it: "Testimonial follow-up 1/2"
    // above a line that already ends in 1/2 says the same thing twice.
    // "Final" is the distinction worth having.
    const labels = defaultTaskTypes
      .filter((t) => t.value.includes("testimonial"))
      .map((t) => t.label);

    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label, label).not.toMatch(/\d/);
      expect(label, label).not.toContain("_");
    }
    expect(labels).toContain("Final testimonial follow-up");
  });

  it("every other task type is untouched", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm({
      deals: [buildDeal({ stage: "won" })],
      tasks: [
        stage(3020, "review_application", ""),
        stage(3021, "follow_up", "Check in with Terry"),
        {
          ...stage(
            3022,
            "offboarding_item",
            "Move SalesId Verify's session notes to Past Clients",
          ),
          offboarding_item_id: 1,
        },
      ],
    });
    const screen = await render(element);

    // Composed from the configured label, exactly as before.
    await expect
      .element(screen.getByText(/Review Application/))
      .toBeInTheDocument();
    await expect.element(screen.getByText(/Follow-up/)).toBeInTheDocument();
    // Still self-describing: its own text, not the generic type label.
    await expect
      .element(
        screen.getByText("Move SalesId Verify's session notes to Past Clients"),
      )
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("offboarding_item"))
      .not.toBeInTheDocument();
  });
});
