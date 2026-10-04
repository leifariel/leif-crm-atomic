import { useTranslate } from "ra-core";
import { useWatch } from "react-hook-form";
import type { Identifier } from "ra-core";

import { formatISODateString } from "../deals/dealUtils";
import { useProjectedFinalWeek } from "./useProjectedFinalWeek";

// What the chosen start week means, said while Leif is choosing it.
//
// Read-only on purpose. The projection is arithmetic over the Year
// Tracking calendar, not a decision anybody makes, and the one date in
// this form that IS a decision — the actual end — is a different field
// with a different meaning (see ClientEditModal).
//
// It watches the live form value rather than the saved record, so the
// answer moves as the date picker moves. Nothing is written by this
// component.
export const ProjectedFinalWeekField = ({
  enrollmentId,
}: {
  enrollmentId: Identifier;
}) => {
  const translate = useTranslate();
  const startDate = useWatch({ name: "start_date" }) as
    | string
    | null
    | undefined;
  const { isPending, end } = useProjectedFinalWeek(
    enrollmentId,
    startDate || null,
  );

  const label = translate("resources.enrollments.fields.projected_final_week", {
    _: "Projected final session week",
  });

  const answer = () => {
    if (!startDate) {
      return translate("crm.programs.projection_needs_start_week", {
        _: "Not available until a start week is set",
      });
    }
    if (isPending) {
      return translate("ra.page.loading", { _: "Loading" });
    }
    if (end?.status === "known") {
      return formatISODateString(end.finalWeek.start);
    }
    if (end?.status === "incomplete") {
      // The capacity surfaces' own language for this: the calendar, not
      // the client, is what is missing. Never an invented date.
      return translate("crm.programs.projection_calendar_too_short", {
        _: "Can't calculate yet — your Year Tracking calendar reaches %{scheduled} of the %{required} session weeks it needs.",
        scheduled: end.weeksScheduled,
        required: end.weeksRequired,
      });
    }
    return translate("crm.programs.projection_needs_start_week", {
      _: "Not available until a start week is set",
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-sm text-muted-foreground">{answer()}</span>
      <span className="text-xs text-muted-foreground">
        {translate("resources.enrollments.fields.projected_final_week_help", {
          _: "Based on your Year Tracking calendar and 12 session weeks. Off weeks are skipped.",
        })}
      </span>
    </div>
  );
};
