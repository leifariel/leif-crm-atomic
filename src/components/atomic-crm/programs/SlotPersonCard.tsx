import type { ReactNode } from "react";
import { useTranslate } from "ra-core";
import { Badge } from "@/components/ui/badge";

import type { SlotHolder } from "../capacity/individualCapacity";
import { formatISODateString } from "../deals/dealUtils";
import { enrollmentStatusLabels } from "../enrollments/enrollmentConstants";
import { PersonCard } from "../misc/ProgramLayout";

// One client, on a programme page, in whichever phase they are in.
//
// Lifted out of IndividualProgramPage so Current Clients and Starting
// Later render the SAME row from the same file. They had drifted apart
// once already, and a client who moves between two sections should not
// change shape on the way.

// A Start Week and a final session week, said the way Leif works.
//
// The Living Example is twelve sessions across his available `1:1s`
// weeks, so the end is a WEEK on the Year Tracking calendar, not a date
// four months after the start. When the calendar has not been filled far
// enough ahead the row says exactly that, with the count, rather than
// showing a date nobody can stand behind.
const startWeekLine = (
  client: SlotHolder,
  translate: ReturnType<typeof useTranslate>,
): string => {
  if (!client.startDate) {
    return translate("crm.programs.start_week_not_set", {
      _: "Start week not set",
    });
  }
  const parts = [
    translate("crm.programs.starts_on", {
      _: "Starts %{start}",
      start: formatISODateString(client.startDate),
    }),
  ];
  if (client.end?.status === "known") {
    parts.push(
      translate("crm.programs.final_session_week", {
        _: "expected final session week %{week}",
        week: formatISODateString(client.end.finalWeek.start),
      }),
    );
    if (client.end.extensions > 0) {
      parts.push(
        translate("crm.programs.reschedule_extensions", {
          _: "+%{count} week for a reschedule |||| +%{count} weeks for reschedules",
          smart_count: client.end.extensions,
          count: client.end.extensions,
        }),
      );
    }
  } else if (client.end?.status === "incomplete") {
    parts.push(
      translate("crm.programs.end_unavailable", {
        _: "end unavailable — %{scheduled} of %{required} session weeks scheduled",
        scheduled: client.end.weeksScheduled,
        required: client.end.weeksRequired,
      }),
    );
  }
  if (!client.startWeekConfirmed) {
    parts.push(
      translate("crm.programs.start_week_unconfirmed", {
        _: "start week not confirmed",
      }),
    );
  }
  return parts.join(" · ");
};
export const SlotPersonCard = ({
  client,
  action,
}: {
  client: SlotHolder;
  // Anything this phase needs beside the status badge — today, the
  // "Set start week" button for a client who has agreed but has no week.
  // It must opt back into clicks with pointer-events-auto; see below.
  action?: ReactNode;
}) => {
  const translate = useTranslate();
  return (
    <PersonCard
      contactId={client.contactId}
      // The Enrollment, not the Contact — the same destination the Clients
      // page uses, and for the reason it already records: "this is the
      // client container, and the generic Contact page does not show
      // start/end dates, payment state, onboarding or sessions."
      //
      // This page sent Leif to /contacts/:id/show instead, because
      // PersonCard falls back to the Contact when given no destination. So
      // the same person opened two different pages depending on which list
      // he clicked them from.
      rowLinkTo={`/enrollments/${client.enrollmentId}/show`}
      // The CRM never invents a name; when it genuinely does not know
      // one, it says so rather than rendering a blank row.
      name={
        client.name ||
        translate("crm.programs.unnamed_client", { _: "an unnamed client" })
      }
      // The dates the row is about, said plainly: a recorded end gets its
      // day, a worked-out one gets its month and the word "expected".
      meta={startWeekLine(client, translate)}
      trailing={
        // pointer-events-none: the row is a link and this sits above it.
        // Measured on a Pixel 5 — without this the badge intercepts the
        // click at the row's centre, so on a narrow screen tapping the row
        // did nothing. Decoration should not be a click target; a real
        // control opts back in with pointer-events-auto.
        <div className="pointer-events-none flex items-center gap-2">
          <Badge variant="outline">
            {enrollmentStatusLabels[client.status]}
          </Badge>
          {action}
        </div>
      }
    />
  );
};
