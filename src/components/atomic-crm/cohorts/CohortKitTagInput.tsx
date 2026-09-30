import { useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";

import { ChooseKitTagDialog } from "../applications/ChooseKitTagDialog";
import { KitConfigBox, KitConfigRow } from "../applications/KitConfigBox";

// The round's own Kit tag, optional.
//
// Additive: a future applicant to this round gets it IN ADDITION to the
// programme's applicant tag, as a separate operation. Leaving it empty is
// perfectly normal — most rounds have no tag of their own, and both live
// cohorts have none today.
//
// It reads as configuration now rather than as a search box. Opening Cohort
// Edit used to print a list of Kit tags under "Cohort tag (optional)", because
// the picker fetched and rendered the catalog simply by being mounted. The
// page says what the tag IS; choosing a different one is a bounded action
// behind Choose/Change. See KitTagPicker's `active` for the root-cause fix.
export const CohortKitTagInput = () => {
  const { control, setValue } = useFormContext();
  const kitTagId = useWatch({ control, name: "kit_tag_id" });
  const kitTagName = useWatch({ control, name: "kit_tag_name" });
  const [choosing, setChoosing] = useState(false);

  const configured = kitTagId != null && kitTagId !== "";

  // Both or neither: a tag id with no name is a row the database refuses, and
  // a name with no id is not a tag. Clearing sets both back to null, which is
  // the "no tag of its own" the schema already allows.
  const apply = (tag: { id: number; name: string } | null) => {
    setValue("kit_tag_id", tag ? tag.id : null, { shouldDirty: true });
    setValue("kit_tag_name", tag ? tag.name : null, { shouldDirty: true });
  };

  return (
    <>
      <KitConfigBox
        title="Kit"
        note="Applied in addition to the programme's applicant tag for future applications to this cohort. Existing applicants are not retagged."
      >
        <KitConfigRow
          label="Cohort tag"
          value={
            configured ? (
              String(kitTagName ?? "")
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )
          }
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setChoosing(true)}
            >
              {configured ? "Change" : "Choose"}
            </Button>
          }
        />
      </KitConfigBox>

      <ChooseKitTagDialog
        open={choosing}
        onOpenChange={setChoosing}
        title="Choose Kit tag"
        onSelect={(tag) => apply(tag)}
        // Clearing is only offered when there is something to clear, and it is
        // a configuration the database accepts: both columns back to null.
        onClear={configured ? () => apply(null) : undefined}
      />
    </>
  );
};
