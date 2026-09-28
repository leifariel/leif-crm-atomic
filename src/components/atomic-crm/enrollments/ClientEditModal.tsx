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
          transform={ownerStatesTheStartWeek}
          mutationOptions={{
            onSuccess: () => {
              notify("Client updated", { type: "info" });
              onOpenChange(false);
              refresh();
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
