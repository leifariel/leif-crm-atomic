import { useDataProvider, useGetOne, useTranslate } from "ra-core";
import { useWatch } from "react-hook-form";

import { TextInput } from "@/components/admin/text-input";

import type { Contact } from "../types";
import {
  checkEmailOwnership,
  contactHasEmail,
  isPlausibleEmail,
} from "./waitlistContactEmail";

// The email a waitlist entry needs, asked for only when it is missing.
//
// Shown when the selected person has no email, which covers both ways that
// happens: somebody just created inline here (a brand-new Contact never
// has one), and somebody found by search whose record predates the rule.
// Hidden entirely when the person already has an address, because asking
// Leif to retype something the CRM already knows is how a form teaches
// people to ignore it.
//
// It writes to the CONTACT, not to the waitlist entry — see
// waitlistContactEmail.ts. The field name is deliberately not a column on
// `waitlist_entries`; AddToWaitlistSheet's transform strips it before the
// entry is created.
export const CONTACT_EMAIL_SOURCE = "contact_email";

export const WaitlistContactEmailInput = () => {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const contactId = useWatch({ name: "contact_id" });

  const { data: contact, isPending } = useGetOne<Contact>(
    "contacts",
    { id: contactId },
    { enabled: contactId != null },
  );

  // Nobody chosen yet, still loading, or they can already be reached.
  if (contactId == null || isPending || contactHasEmail(contact)) return null;

  const validateEmail = async (value: unknown) => {
    const email = typeof value === "string" ? value.trim() : "";

    if (email === "") {
      // Required, and the message says WHY rather than just "required" —
      // the rule is about being able to reach the person, not about the
      // form being complete.
      return translate("resources.waitlist_entries.email.required", {
        _: "An email is needed so you can reach them about an opening.",
      });
    }

    if (!isPlausibleEmail(email)) {
      return translate("resources.waitlist_entries.email.invalid", {
        _: "That does not look like an email address.",
      });
    }

    // Identity, not formatting. If somebody else already has this address
    // these may be one person twice, a typo, or a shared inbox — the CRM
    // cannot tell, so it stops and names the other person instead of
    // merging them or moving the address.
    const ownership = await checkEmailOwnership(dataProvider, email, contactId);
    if (ownership.status === "belongs-to-another") {
      return translate("resources.waitlist_entries.email.belongs_to_another", {
        _: "%{name} already has this email. Add them from the search above, or use a different address for this person.",
        name:
          `${ownership.owner.first_name ?? ""} ${ownership.owner.last_name ?? ""}`.trim() ||
          "Another contact",
      });
    }

    return undefined;
  };

  return (
    <TextInput
      source={CONTACT_EMAIL_SOURCE}
      label={translate("resources.waitlist_entries.email.label", {
        _: "Email",
      })}
      helperText={translate("resources.waitlist_entries.email.helper", {
        _: "Saved on their contact, not on this waitlist entry.",
      })}
      validate={validateEmail}
    />
  );
};
