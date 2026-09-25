import { useEffect } from "react";
import { required, useGetList, useTranslate } from "ra-core";
import { useFormContext, useWatch } from "react-hook-form";
import { AutocompleteInput } from "@/components/admin/autocomplete-input";
import { ReferenceInput } from "@/components/admin/reference-input";

import type { Offer } from "../types";

// Which programme, and — for a cohort programme — which run of it.
//
// Shared by the create and correct dialogs, because "what does a valid
// programme answer look like" has to be one answer. Two copies would
// eventually disagree, and the disagreement would be a record the page
// cannot file.
export const ApplicationProgramFields = () => {
  const translate = useTranslate();
  const { setValue } = useFormContext();
  const offerId = useWatch({ name: "offer_id" });
  const cohortId = useWatch({ name: "intended_cohort_id" });

  const { data: offers } = useGetList<Offer>("offers", {
    filter: {},
    pagination: { page: 1, perPage: 100 },
    sort: { field: "id", order: "ASC" },
  });
  const offer = (offers ?? []).find(
    (candidate) => String(candidate.id) === String(offerId),
  );
  const needsCohort = offer?.type === "group";

  // Moving an application to the rolling 1:1 programme drops the cohort
  // with it. Hiding the field alone would leave the old value in the form
  // and save a 1:1 application that names a Growing Yourself Up cohort —
  // a record that contradicts itself, and one no section could hold.
  useEffect(() => {
    if (!needsCohort && cohortId != null && cohortId !== "") {
      setValue("intended_cohort_id", null, { shouldDirty: true });
    }
  }, [needsCohort, cohortId, setValue]);

  return (
    <div className="flex flex-col gap-3">
      <ReferenceInput source="offer_id" reference="offers">
        <AutocompleteInput
          label={translate("resources.applications.fields.offer", {
            _: "Offer",
          })}
          optionText="name"
          helperText={false}
          validate={required()}
        />
      </ReferenceInput>

      {needsCohort && (
        // Scoped to the chosen Offer, so a cohort of a different programme
        // is not selectable — a cross-offer pairing would be a record that
        // contradicts itself just as surely.
        <ReferenceInput
          source="intended_cohort_id"
          reference="cohorts"
          filter={{ offer_id: offerId }}
        >
          <AutocompleteInput
            label={translate("resources.applications.fields.cohort", {
              _: "Cohort",
            })}
            optionText="name"
            helperText={false}
            validate={required()}
          />
        </ReferenceInput>
      )}
    </div>
  );
};
