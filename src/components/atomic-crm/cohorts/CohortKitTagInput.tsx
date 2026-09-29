import { useFormContext, useWatch } from "react-hook-form";

import { KitTagPicker } from "../applications/KitTagPicker";

// The round's own Kit tag, optional.
//
// Additive: a future applicant to this round gets it IN ADDITION to the
// programme's applicant tag, as a separate operation. Leaving it empty is
// perfectly normal — most rounds have no tag of their own.
export const CohortKitTagInput = () => {
  const { control, setValue } = useFormContext();
  const kitTagId = useWatch({ control, name: "kit_tag_id" });
  const kitTagName = useWatch({ control, name: "kit_tag_name" });

  return (
    <section className="flex flex-col gap-2">
      <span className="text-sm font-medium">Kit</span>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">
          Cohort tag (optional)
        </span>
        <KitTagPicker
          value={
            kitTagId
              ? { id: Number(kitTagId), name: String(kitTagName ?? "") }
              : null
          }
          onChange={(tag) => {
            // Both or neither: a tag id with no name is a row the database
            // refuses, and a name with no id is not a tag.
            setValue("kit_tag_id", tag ? tag.id : null, { shouldDirty: true });
            setValue("kit_tag_name", tag ? tag.name : null, {
              shouldDirty: true,
            });
          }}
        />
      </div>
      <span className="text-xs text-muted-foreground">
        Applied in addition to the programme's applicant tag for future
        applications to this cohort. Existing applicants are not retagged.
      </span>
    </section>
  );
};
