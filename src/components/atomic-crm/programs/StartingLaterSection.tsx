import { useState } from "react";
import { useTranslate } from "ra-core";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import type { SlotHolder } from "../capacity/slotHolder";
import { ClientEditModal } from "../enrollments/ClientEditModal";
import { PreviewList } from "../misc/PreviewList";
import { Section } from "../misc/ProgramLayout";
import { SlotPersonCard } from "./SlotPersonCard";

// Everybody who has agreed and has not started.
//
// Two capacity phases live here, and the distinction between them is real:
// `committed` has a start week, `unscheduled` does not. Neither occupies a
// slot today, which is why they are not Current Clients — the old model
// counted an undated commitment as occupying one from today, and
// Todd Jacobsen made a twelve-client programme read 13 / 12.
//
// They used to be two sections. That was the fix for losing Todd entirely
// (for a while he was one line of grey footnote text under the openings
// forecast, with nothing to click), and it worked — but it left the page
// carrying a whole extra heading for what is one question about one of
// these people. So they are one section again, and the distinction is
// carried by the row: a client with no week says so, wears a badge, and
// keeps its own button.
//
// THE ORDER IS THE SAFETY PROPERTY. Clients needing a week come first, so
// they are inside the collapsed preview rather than behind "N more". A
// section that hid the one person who needs something would be the Todd
// failure again in a new shape, and the three-row preview makes that easy
// to do by accident.
//
// The button opens ClientEditModal — the same component StartWeekCard
// opens and the same one /enrollments/:id/edit wraps. There is exactly one
// start-week editor in this app and exactly one save path, which is the
// path that was repaired after it silently discarded Todd's first save.
export const StartingLaterSection = ({
  offerId,
  committed,
  unscheduled,
}: {
  offerId: string | number;
  committed: SlotHolder[];
  unscheduled: SlotHolder[];
}) => {
  const translate = useTranslate();
  const [editing, setEditing] = useState<SlotHolder | null>(null);

  const clients = [...unscheduled, ...committed];
  if (clients.length === 0) return null;

  return (
    <>
      <Section
        title={translate("crm.programs.starting_later", {
          _: "Starting Later",
        })}
        count={clients.length}
      >
        {unscheduled.length > 0 && (
          // Said once, above the list, because it is the section's open
          // question rather than a property of the section.
          <p className="-mt-1 text-sm text-muted-foreground">
            {translate("crm.programs.starting_later_needs_week", {
              _: "%{count} of these still needs a start week. |||| %{count} of these still need a start week.",
              smart_count: unscheduled.length,
              count: unscheduled.length,
            })}
          </p>
        )}
        <PreviewList
          storeKey={`offer.${offerId}.starting-later`}
          items={clients}
          renderRows={(visible) => (
            <div className="flex flex-col gap-2">
              {visible.map((client) => (
                <SlotPersonCard
                  key={client.enrollmentId}
                  client={client}
                  action={
                    client.startDate ? null : (
                      <>
                        <Badge variant="secondary">
                          {translate("crm.programs.needs_start_week_badge", {
                            _: "Needs start week",
                          })}
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
                      </>
                    )
                  }
                />
              ))}
            </div>
          )}
        />
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
