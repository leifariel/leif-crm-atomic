import { useRef } from "react";

import { EditBase, Form, required, useNotify, useRefresh } from "ra-core";
import type { Identifier } from "ra-core";

import { DateInput } from "@/components/admin/date-input";
import { SelectInput } from "@/components/admin/select-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { Enrollment } from "../types";
import { enrollmentStatuses } from "./enrollmentConstants";
import { assessEnrollmentSave, saveOutcomeMessage } from "./savedWhatWasStated";

// The three operational facts about a client Leif actually edits: where they
// are in the programme, the week they start, and the day they finished if
// they have.
//
// A modal over the client's own page, never a page of its own (AGENTS.md ->
// Operational UX conventions): this is a handful of fields about the record
// already on screen, and walking Leif to a separate screen to set a Start
// Week is how a Start Week ends up never being set. /enrollments/:id/edit is
// a thin wrapper around this same component for a direct link or a reload.
//
// Saving IS the owner statement. Whatever date is left in the Start Week
// field is, by the act of saving, a date Leif has stated — which is what
// promotes it to the canonical `owner` provenance the capacity ledger is
// allowed to plan around. Clearing it returns the Enrollment to having no
// Start Week, with no source, which is the only honest way to say "not
// decided yet": there is no second field, and nothing anywhere infers one
// from a booking.
const ownerStatesTheStartWeek = (data: Partial<Enrollment>) => ({
  ...data,
  start_date_source: data.start_date ? ("owner" as const) : null,
});

export const ClientEditModal = ({
  enrollmentId,
  onOpenChange,
}: {
  enrollmentId: Identifier | null;
  onOpenChange: (open: boolean) => void;
}) => {
  const notify = useNotify();
  const refresh = useRefresh();
  // What the form last submitted. A ref, not state: it is written during
  // the submit that is already in flight and read when that submit comes
  // back, and re-rendering on it would do nothing but discard the record.
  const stated = useRef<Partial<Enrollment> | null>(null);

  if (enrollmentId == null) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit client</DialogTitle>
        </DialogHeader>
        <EditBase
          resource="enrollments"
          id={enrollmentId}
          actions={false}
          redirect={false}
          // THIS is why Todd Jacobsen's start week vanished, and it was
          // never the database.
          //
          // EditBase defaults to mutationMode="undoable". In that mode
          // ra-core patches its own cache, calls onSuccess with the
          // OPTIMISTIC record, and QUEUES the real dataProvider.update to
          // be run by whichever notification is raised next. Notification
          // pops it with takeMutation() and then runs it only
          // `if (undoable)` (notification.tsx).
          //
          // This modal's onSuccess raised a plain notify("Client updated").
          // So the queued write was taken off the queue by a toast that did
          // not know it was holding one, and dropped. Not delayed — gone.
          // Verified: dataProvider.update was never called, not after nine
          // seconds, and the record still said null. Leif read "Client
          // updated" over a write that never happened.
          //
          // (TaskEdit has the same shape and survives only because its
          // notify passes undoable: true. That is a trap, not a pattern.)
          //
          // Pessimistic: ask the database first, and let what it says be
          // the answer. This modal is a handful of fields and a Save
          // button; there is no list that needs to feel instant, and a
          // start week is a decision Leif needs recorded, not animated.
          mutationMode="pessimistic"
          transform={(data: Partial<Enrollment>) => {
            // Keep what was sent, so success can be checked against it
            // rather than against what the form happens to hold now.
            const sent = ownerStatesTheStartWeek(data);
            stated.current = sent;
            return sent;
          }}
          mutationOptions={{
            // ra-core hands onSuccess the record the dataProvider returned,
            // which for PostgREST is the row the database actually wrote.
            // That record — not the absence of an error — is what entitles
            // the CRM to say "Client updated".
            //
            // Leif set Todd Jacobsen's start week, read "Client updated",
            // and the week was not there. A save message that can be wrong
            // is worse than the missing save: it sends him away believing
            // the decision is recorded.
            onSuccess: (saved: Partial<Enrollment>) => {
              const verdict = assessEnrollmentSave({
                stated: stated.current ?? {},
                saved,
              });
              const message = saveOutcomeMessage(verdict);
              if (verdict.kind === "saved") {
                notify(message, { type: "info" });
                onOpenChange(false);
                refresh();
                return;
              }
              // Stay open, holding what he typed. Closing on a save that
              // did not happen loses the statement as well as hiding it,
              // and there is nothing he can do about it from the page
              // behind.
              //
              // And deliberately no refresh(): there is nothing new to
              // show, and refetching remounts the page that owns this
              // modal — which would close it and throw away what he
              // typed, the precise thing this branch exists to prevent.
              notify(message, { type: "warning", autoHideDuration: 0 });
            },
          }}
        >
          <Form className="flex flex-col gap-4">
            <SelectInput
              source="status"
              choices={enrollmentStatuses}
              optionText="label"
              optionValue="value"
              helperText={false}
              validate={required()}
            />
            <div className="flex flex-col sm:flex-row gap-4">
              <DateInput
                source="start_date"
                label="resources.enrollments.fields.start_week"
                helperText="resources.enrollments.fields.start_week_help"
              />
              <DateInput
                source="end_date"
                label="resources.enrollments.fields.end_date"
                helperText={false}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Save
              </Button>
            </div>
          </Form>
        </EditBase>
      </DialogContent>
    </Dialog>
  );
};
