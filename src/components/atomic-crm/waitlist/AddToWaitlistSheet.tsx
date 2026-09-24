import { useMemo } from "react";
import type { Identifier } from "ra-core";
import { useDataProvider, useTranslate } from "ra-core";
import { TextInput } from "@/components/admin/text-input";

import { CreateDialog } from "../misc/CreateDialog";
import type { Contact } from "../types";
import { WaitlistPersonInput } from "./WaitlistPersonInput";
import {
  CONTACT_EMAIL_SOURCE,
  WaitlistContactEmailInput,
} from "./WaitlistContactEmailInput";
import {
  attachEmailToContact,
  checkEmailOwnership,
} from "./waitlistContactEmail";

// "+ Add to Waitlist" (Waitlists slice, §9). Offer is always implied by the
// hosting page; Cohort is implied too when opened from a Cohort page
// (cohortId: <id>) — never asked again here. Only desired timing and
// notes are optional extras; nothing meaningless is required, and Source
// is stamped "manual" rather than asked, since Leif is the one adding it.
export const AddToWaitlistSheet = ({
  open,
  onOpenChange,
  offerId,
  cohortId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offerId: Identifier;
  cohortId: Identifier | null;
}) => {
  const translate = useTranslate();

  // Human-acceptance repair pass, §2 (root cause): ra-core's
  // useAugmentedForm re-derives its defaultValues via
  // JSON.stringify(defaultValues) and calls reset() whenever that string
  // changes — an inline `new Date().toISOString()` here produced a NEW
  // string on every re-render of this component, so the "contacts" query
  // invalidation that fires the instant the quick-create Contact is
  // created (WaitlistPersonInput's onCreate) re-rendered this sheet mid-
  // flow, reset the whole form back to defaultValues, and silently wiped
  // out the just-selected Person. Freezing joined_at for the sheet's
  // open lifecycle (only recomputed when it actually opens) keeps the
  // JSON.stringify output stable across incidental re-renders while it's
  // open, so no unrelated re-render can ever reset the form underneath
  // the user again.
  const joinedAt = useMemo(() => new Date().toISOString(), [open]);
  const dataProvider = useDataProvider();

  // The email is a fact about the PERSON, so it is written to the Contact
  // and then removed from what becomes the waitlist entry. Doing it here,
  // in the transform, keeps it on the one save Leif pressed: the Contact
  // is updated first and the entry is only created if that succeeded, so
  // there is never an active entry for somebody nobody can reach.
  //
  // The ownership check runs again here, not only in the field validator.
  // The validator is what Leif sees; this is what actually guards the
  // write, because a validator can be raced by a Contact created in
  // another tab between typing and saving.
  const transform = async (data: Record<string, unknown>) => {
    const { [CONTACT_EMAIL_SOURCE]: typedEmail, ...entry } = data;
    const email = typeof typedEmail === "string" ? typedEmail.trim() : "";
    if (email === "") return entry;

    const contactId = entry.contact_id as Identifier;
    const ownership = await checkEmailOwnership(dataProvider, email, contactId);
    if (ownership.status === "belongs-to-another") {
      // Refuses the whole save rather than merging two people or moving
      // an address off somebody else. Leif decides which of them this is.
      const name =
        `${ownership.owner.first_name ?? ""} ${ownership.owner.last_name ?? ""}`.trim() ||
        "another contact";
      throw new Error(`${name} already has this email — nothing was saved.`);
    }

    const { data: contact } = await dataProvider.getOne<Contact>("contacts", {
      id: contactId,
    });
    await attachEmailToContact(dataProvider, contact, email);
    return entry;
  };

  return (
    <CreateDialog
      resource="waitlist_entries"
      transform={transform}
      title={translate("resources.waitlist_entries.sheet.add", {
        _: "Add to Waitlist",
      })}
      redirect={false}
      open={open}
      onOpenChange={onOpenChange}
      defaultValues={{
        offer_id: offerId,
        cohort_id: cohortId,
        status: "waiting",
        // Leif is creating this by hand, so the origin is known: "manual",
        // never the "Unknown" an empty attribution field rendered as.
        source: "manual",
        joined_at: joinedAt,
      }}
    >
      <div className="flex flex-col gap-4">
        <WaitlistPersonInput offerId={offerId} cohortId={cohortId} />
        {/* Only appears when the chosen person has no email yet — a
            brand-new one created just above, or an older record that
            predates the rule. */}
        <WaitlistContactEmailInput />
        <TextInput
          source="desired_timing"
          label={translate("resources.waitlist_entries.fields.desired_timing", {
            _: "Desired timing",
          })}
          helperText={false}
        />
        <TextInput
          source="notes"
          label={translate("resources.waitlist_entries.fields.notes", {
            _: "Notes",
          })}
          multiline
          helperText={false}
        />
      </div>
    </CreateDialog>
  );
};
