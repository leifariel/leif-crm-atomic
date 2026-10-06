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
  ApplicationNote,
  Offer,
  Task,
} from "@/components/atomic-crm/types";

// Leif's private working area on an Application.
//
// The rule these exist for: a Contact may apply more than once, and his
// reasoning about one application must never surface on another. That is
// why the notes hang from application_id and not from contact_id.

const livingExample: Offer = {
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

const applicationFor = (id: number): Application => ({
  id,
  contact_id: 1,
  opportunity_id: null,
  source: "manual",
  status: "pending",
  submitted_at: "2026-08-31T09:00:00.000Z",
  reviewed_at: null,
  offer_id: 1,
  raw_answers: {},
  summary: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const note = (
  id: number,
  applicationId: number,
  text: string,
  date: string,
): ApplicationNote =>
  ({
    id,
    application_id: applicationId,
    text,
    date,
    sales_id: 0,
  }) as ApplicationNote;

const task = (overrides: Partial<Task> & Pick<Task, "id" | "type">): Task =>
  ({
    contact_id: 1,
    text: "a task",
    due_date: "2026-09-01T00:00:00.000Z",
    done_date: null,
    status: "pending",
    sales_id: 0,
    ...overrides,
  }) as Task;

const buildTestCrm = ({
  applications,
  application_notes = [],
  tasks = [],
  applicationId,
}: {
  applications: Application[];
  application_notes?: ApplicationNote[];
  tasks?: Task[];
  applicationId: number;
}) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      contacts: [buildContact({ id: 1 })],
      offers: [livingExample],
      offer_payment_options: [],
      applications,
      application_notes,
      tasks,
      deals: [],
      enrollments: [],
    }),
    silent: true,
  });

  const element = (
    <MemoryRouter initialEntries={[`/applications/${applicationId}/show`]}>
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

describe("Application notes & follow-up", () => {
  it("shows the section at the foot of the page", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm({
      applications: [applicationFor(1)],
      applicationId: 1,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Notes & follow-up"))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: /Add task/ }))
      .toBeInTheDocument();
  });

  it("shows this Application's notes, newest first", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm({
      applications: [applicationFor(1)],
      application_notes: [
        note(1, 1, "Really strong application.", "2026-09-01T09:00:00.000Z"),
        note(
          2,
          1,
          "Want to sit with the support question.",
          "2026-09-02T09:00:00.000Z",
        ),
      ],
      applicationId: 1,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Really strong application."))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Want to sit with the support question."))
      .toBeInTheDocument();
  });

  // The reason this table exists rather than reusing contact_notes.
  it("never shows another Application's notes, even for the same person", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm({
      applications: [applicationFor(1), applicationFor(2)],
      application_notes: [
        note(
          1,
          1,
          "Thinking about the first application.",
          "2026-09-01T09:00:00.000Z",
        ),
        note(
          2,
          2,
          "Thinking about the second application.",
          "2026-09-02T09:00:00.000Z",
        ),
      ],
      applicationId: 2,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Thinking about the second application."))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Thinking about the first application."))
      .not.toBeInTheDocument();
  });

  it("is quiet when there are no notes, rather than showing an empty box", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm({
      applications: [applicationFor(1)],
      applicationId: 1,
    });
    const screen = await render(element);

    // The section and its composer are there; no note text, and nothing
    // claiming there are notes.
    await expect
      .element(screen.getByText("Notes & follow-up"))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Really strong application."))
      .not.toBeInTheDocument();
  });

  it("lists this Application's follow-up tasks and leaves the review task to Review Decision", async () => {
    await page.viewport(1280, 900);
    const { element } = buildTestCrm({
      applications: [applicationFor(1)],
      tasks: [
        task({
          id: 1,
          type: "review_application",
          text: "Review Ada Lovelace's application",
          application_id: 1,
        }),
        task({
          id: 2,
          type: "other",
          text: "Email applicant about schedule",
          application_id: 1,
        }),
        task({
          id: 3,
          type: "other",
          text: "Review application Friday",
          application_id: 1,
        }),
        // Another Application's follow-up, and a bare Contact task: both
        // belong elsewhere.
        task({
          id: 4,
          type: "other",
          text: "Something about a different application",
          application_id: 2,
        }),
        task({ id: 5, type: "other", text: "Unrelated contact task" }),
      ],
      applicationId: 1,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("Email applicant about schedule"))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Review application Friday"))
      .toBeInTheDocument();

    // Not the review task — that IS the Review Decision section above.
    await expect
      .element(screen.getByText("Review Ada Lovelace's application"))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Something about a different application"))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Unrelated contact task"))
      .not.toBeInTheDocument();
  });

  it("adding a note keeps the ones already there", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm({
      applications: [applicationFor(1)],
      application_notes: [
        note(1, 1, "The first thought.", "2026-09-01T09:00:00.000Z"),
      ],
      applicationId: 1,
    });
    const screen = await render(element);

    await expect
      .element(screen.getByText("The first thought."))
      .toBeInTheDocument();

    await screen
      .getByRole("textbox", { name: /note/i })
      .fill("A second thought.");
    await screen.getByRole("button", { name: /add this note/i }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getList("application_notes", {
          filter: { application_id: 1 },
          pagination: { page: 1, perPage: 10 },
          sort: { field: "date", order: "DESC" },
        });
        return data.map((row) => row.text).sort();
      })
      .toEqual(["A second thought.", "The first thought."]);

    // Nothing was overwritten: the older note is still on screen.
    await expect
      .element(screen.getByText("The first thought."))
      .toBeInTheDocument();

    // And writing a private note decided nothing. The shared composer
    // used to write the note status back onto the parent record for every
    // kind of note — a Contact behaviour that, on an Application, would
    // have reached its own decision state.
    const app = await dataProvider.getOne("applications", { id: 1 });
    expect(app.data.status).toBe("pending");
    expect(app.data.reviewed_at).toBeNull();
  });

  it("adding a task does not touch the Application's decision", async () => {
    await page.viewport(1280, 900);
    const { element, dataProvider } = buildTestCrm({
      applications: [applicationFor(1)],
      applicationId: 1,
    });
    const screen = await render(element);

    const before = await dataProvider.getOne("applications", { id: 1 });

    await screen.getByRole("button", { name: /Add task/ }).click();
    await screen
      .getByRole("textbox", { name: /description/i })
      .fill("Clarify support needs");
    await screen.getByRole("button", { name: /^save$/i }).click();

    await expect
      .poll(async () => {
        const { data } = await dataProvider.getList("tasks", {
          filter: { application_id: 1 },
          pagination: { page: 1, perPage: 10 },
          sort: { field: "id", order: "ASC" },
        });
        return data.length;
      })
      .toBe(1);

    const after = await dataProvider.getOne("applications", { id: 1 });
    expect(after.data.status).toBe(before.data.status);
    expect(after.data.reviewed_at).toBe(before.data.reviewed_at);

    // And it points at this Application, not merely at the person.
    const { data: tasks } = await dataProvider.getList("tasks", {
      filter: { application_id: 1 },
      pagination: { page: 1, perPage: 10 },
      sort: { field: "id", order: "ASC" },
    });
    expect(tasks[0]!.application_id).toBe(1);
    expect(tasks[0]!.type).toBe("other");
  });
});
