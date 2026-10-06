import { useState } from "react";
import { Plus } from "lucide-react";
import {
  InfiniteListBase,
  useGetList,
  useListContext,
  useTranslate,
  type Identifier,
} from "ra-core";

import { Button } from "@/components/ui/button";

import { Section } from "../misc/ProgramLayout";
import { Note } from "../notes/Note";
import { ApplicationNoteComposer } from "./ApplicationNoteComposer";
import { TaskCreateSheet } from "../tasks/TaskCreateSheet";
import type { Task } from "../types";

// Leif's private working area, at the foot of the Application he is
// reading. Not part of the applicant's submitted material and never shown
// to them — `anon` is revoked from application_notes outright.
//
// Notes are scoped to ONE Application rather than to the Contact. A person
// may apply more than once, and "I want to sit with the support-level
// question" is about one of those applications; on the other one it would
// be noise at best and misleading at worst.
//
// Tasks come from the CRM's own task system, pointed at this Application
// through the `application_id` the tasks table already carries. The type
// is `other`, which the schema already describes as "Leif's own note",
// deliberately exempt from the machinery that cancels sales-driven tasks
// when an Opportunity ends.
export const ApplicationNotesAndFollowUp = ({
  applicationId,
  contactId,
}: {
  applicationId: Identifier;
  contactId: Identifier;
}) => {
  const translate = useTranslate();
  const [taskOpen, setTaskOpen] = useState(false);

  // The query lives here so closing the sheet can refetch it.
  // TaskCreateSheet supplies its own mutation onSuccess, which replaces
  // ra-core's default cache invalidation — so a task created there does
  // not appear until something asks again. Refetching when the sheet
  // closes is that something.
  const { data: tasks, refetch: refetchTasks } = useGetList<Task>("tasks", {
    filter: { application_id: applicationId },
    pagination: { page: 1, perPage: 50 },
    sort: { field: "due_date", order: "ASC" },
  });

  return (
    <Section
      title={translate("resources.applications.review.notes_title", {
        _: "Notes & follow-up",
      })}
      action={
        <Button variant="outline" size="sm" onClick={() => setTaskOpen(true)}>
          <Plus className="size-4" />
          {translate("resources.applications.review.add_task", {
            _: "Add task",
          })}
        </Button>
      }
    >
      <TaskCreateSheet
        open={taskOpen}
        onOpenChange={(open) => {
          setTaskOpen(open);
          if (!open) void refetchTasks();
        }}
        contact_id={contactId}
        application_id={applicationId}
      />

      <ApplicationFollowUpTasks tasks={tasks ?? []} />

      {/* Newest first. The composer is this page's own — see
          ApplicationNoteComposer for why — but each note is rendered,
          edited and deleted by the shared Note component, which is
          resource-agnostic and reads its resource from this list. */}
      {/* A restrained subsection, so the composer and the notes beneath it
          read as one thing — Leif's own thinking — rather than as loose
          text under the follow-up tasks. */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">
          {translate("resources.applications.review.private_notes", {
            _: "Private notes",
          })}
        </h3>
        <InfiniteListBase
          resource="application_notes"
          filter={{ application_id: applicationId }}
          sort={{ field: "date", order: "DESC" }}
          perPage={25}
          disableSyncWithLocation
          storeKey={false}
        >
          <ApplicationNoteComposer applicationId={applicationId} />
          <ApplicationNoteList />
        </InfiniteListBase>
      </div>
    </Section>
  );
};

// Newest first, each rendered by the shared Note component so editing
// and deleting behave exactly as they do for a Contact or an Opportunity.
const ApplicationNoteList = () => {
  const { data = [], isPending, error } = useListContext();
  if (isPending || error || data.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="application-notes">
      {data.map((note, index) => (
        // Each note in its own bordered card, in the CRM's existing
        // language (the same rounded-md border the operational cards on
        // this page already use) — so a saved note reads as a record
        // rather than as text floating under the box it was typed in.
        <div key={note.id} className="rounded-md border px-3 py-2">
          <Note
            note={note}
            isLast={index === data.length - 1}
            variant="compact"
          />
        </div>
      ))}
    </div>
  );
};

// Only this Application's own follow-ups. The person's wider task history
// stays where it already lives — dumping every task for the Contact here
// would make the review area ambiguous about what it is showing.
//
// The review task itself is deliberately absent: it is what the Review
// Decision section above IS, and repeating it here would read as a second
// thing to do.
const ApplicationFollowUpTasks = ({ tasks }: { tasks: Task[] }) => {
  const translate = useTranslate();

  const followUps = tasks.filter((task) => task.type !== "review_application");
  if (followUps.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1" data-testid="application-follow-ups">
      {followUps.map((task) => (
        <li key={task.id} className="text-sm flex items-baseline gap-2">
          <span
            className={
              task.done_date != null
                ? "text-muted-foreground line-through"
                : undefined
            }
          >
            {task.text}
          </span>
          {task.done_date == null && task.due_date && (
            <span className="text-xs text-muted-foreground">
              {translate("resources.tasks.fields.due_date", { _: "Due" })}{" "}
              {new Date(task.due_date).toLocaleDateString()}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
};
