import { useState } from "react";
import { useTranslate } from "ra-core";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { ClientEditModal } from "../enrollments/ClientEditModal";
import { enrollmentStatusLabels } from "../enrollments/enrollmentConstants";
import type { SlotHolder } from "../capacity/slotHolder";
import { PersonCard, Section } from "../misc/ProgramLayout";

// The clients Leif has committed to and not yet placed in a week.
//
// They used to be inside Current Clients, because the occupancy model
// counted a null start date as occupying a slot from today. That was wrong
// about capacity — Todd Jacobsen made a twelve-client programme read
// 13 / 12 — and fixing it correctly took them off the page entirely: the
// sections were occupied and committed, and an unscheduled client is
// neither. Leif found Todd in production reduced to one sentence of grey
// footnote text under the openings forecast, with no row to click.
//
// So the page has three client sections, one per phase, and a commitment
// with no week is a client with a question rather than a client who has
// vanished. The question is the row's whole content: who, what state they
// are in, and the one thing missing.
//
// The button opens ClientEditModal — the same component StartWeekCard
// opens and the same one /enrollments/:id/edit wraps. There is exactly one
// start-week editor in this app and exactly one save path, which is the
// path that was repaired after it silently discarded Todd's first save.
export const NeedsStartWeekSection = ({
  clients,
}: {
  clients: SlotHolder[];
}) => {
  const translate = useTranslate();
  const [editing, setEditing] = useState<SlotHolder | null>(null);

  if (clients.length === 0) return null;

  return (
    <>
      <Section
        title={translate("crm.programs.needs_start_week", {
          _: "Needs Start Week",
        })}
      >
        <div className="flex flex-col gap-2">
          {clients.map((client) => (
            <PersonCard
              key={client.enrollmentId}
              contactId={client.contactId}
              // Their own client page, not their Contact page: that is
              // where the rest of the enrollment lives, and where
              // StartWeekCard asks the same question.
              rowLinkTo={`/enrollments/${client.enrollmentId}/show`}
              name={
                client.name ||
                translate("crm.programs.unnamed_client", {
                  _: "an unnamed client",
                })
              }
              meta={translate("crm.programs.start_week_not_set", {
                _: "Start week not set",
              })}
              trailing={
                // Transparent by default, and only the button takes
                // clicks back. The row behind this is a link, and measured
                // on a Pixel 5 it was this wrapper — its own padding and
                // the gap between badge and button — that intercepted the
                // tap at the row's centre, so tapping the row did nothing
                // on a narrow screen. Decoration and whitespace are not
                // click targets; the control is.
                <div className="pointer-events-none flex items-center gap-2">
                  <Badge variant="outline">
                    {enrollmentStatusLabels[client.status]}
                  </Badge>
                  <Button
                    type="button"
                    size="sm"
                    className="pointer-events-auto"
                    onClick={() => setEditing(client)}
                  >
                    {translate("crm.programs.set_start_week", {
                      _: "Set start week",
                    })}
                  </Button>
                </div>
              }
            />
          ))}
        </div>
      </Section>

      {editing && (
        <ClientEditModal
          enrollmentId={editing.enrollmentId}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}
    </>
  );
};
