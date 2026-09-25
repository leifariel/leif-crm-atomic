import { useTranslate, type Identifier } from "ra-core";

import { EditDialog } from "../misc/EditDialog";
import { ApplicationProgramFields } from "./ApplicationProgramFields";

// Correcting which programme an Application was for.
//
// Deliberately narrow. This is not the review lightbox and not a general
// record editor — it exists so a misfiled application can be moved to the
// cohort it actually belongs to, which is the correction that otherwise
// requires a database.
//
// What is NOT editable here, and why:
//
//   source        provenance. Whether a record came from the public form,
//                 an import, or Leif's own hand is a fact about the past;
//                 editing it would let the page be told a different story
//                 about where something came from.
//   status        decisions belong to the review action, which records
//                 reviewed_at alongside them. A status changed here would
//                 be a decision with no moment attached — exactly the
//                 shape the imported rows already have, and the reason
//                 Reviewed has to mean reviewed_at.
//   reviewed_at   a timestamp for something that either happened or did
//                 not. Never typed in.
//   contact_id    who an application is FOR is its identity. Moving it to
//                 another person silently rewrites two people's histories
//                 at once, so it is left out rather than offered — see the
//                 report; if it is ever needed it deserves its own
//                 deliberate action, the way waitlist reassignment does.
export const ApplicationEditDialog = ({
  open,
  onOpenChange,
  applicationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: Identifier;
}) => {
  const translate = useTranslate();

  // Only the two fields this dialog owns are written. Everything else on
  // the record is left exactly as the form received it.
  const transform = (data: Record<string, unknown>) => ({
    offer_id: data.offer_id,
    intended_cohort_id: data.intended_cohort_id ?? null,
  });

  return (
    <EditDialog
      resource="applications"
      id={applicationId}
      title={translate("resources.applications.action.edit", {
        _: "Correct application",
      })}
      redirect={false}
      mutationMode="pessimistic"
      transform={transform}
      open={open}
      onOpenChange={onOpenChange}
    >
      <ApplicationProgramFields />
    </EditDialog>
  );
};
