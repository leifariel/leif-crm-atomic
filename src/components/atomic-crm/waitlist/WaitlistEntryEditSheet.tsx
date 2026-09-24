import { useDataProvider, useGetOne, useTranslate } from "ra-core";
import { useQueryClient } from "@tanstack/react-query";
import type { Identifier } from "ra-core";
import { TextInput } from "@/components/admin/text-input";
import { NumberInput } from "@/components/admin/number-input";

import { EditDialog } from "../misc/EditDialog";
import type { Contact, WaitlistEntry } from "../types";
import {
  checkEmailOwnership,
  isPlausibleEmail,
  primaryEmail,
  replacePrimaryEmail,
} from "./waitlistContactEmail";

// Editing one waitlist row, person included.
//
// This used to be an EditSheet, which renders a bottom sheet at h-dvh —
// the full height of the viewport — for three short fields, leaving a
// screenful of empty space under them. It is an EditDialog now: the same
// API, the compact centered variant, the counterpart CreateDialog already
// was for CreateSheet.
//
// It also used to edit only the waitlist fields, which meant that noticing
// a misspelled name here sent Leif off to Contacts to fix it and back
// again. The person is right there on the row, so their name and email are
// editable right here too.
//
// Two facts, two records, and they stay that way: name and email belong to
// the CONTACT, desired timing / notes / priority to the WAITLIST ENTRY.
// Nothing is copied across — see the transform below, which writes the
// Contact and then strips those fields before the entry is saved.
const CONTACT_FIELDS = [
  "contact_first_name",
  "contact_last_name",
  "contact_email",
] as const;

export const WaitlistEntryEditSheet = ({
  open,
  onOpenChange,
  entryId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryId: Identifier;
}) => {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const queryClient = useQueryClient();

  const { data: entry } = useGetOne<WaitlistEntry>(
    "waitlist_entries",
    { id: entryId },
    { enabled: open },
  );
  const { data: contact } = useGetOne<Contact>(
    "contacts",
    { id: entry?.contact_id as Identifier },
    { enabled: open && entry?.contact_id != null },
  );

  // Nothing renders until BOTH records are in hand.
  //
  // The form's defaultValues carry the person's details, and ra-core
  // re-derives those by stringifying them and calling reset() when the
  // string changes. Seeding them after the Contact arrives would therefore
  // reset the form under Leif mid-edit — the same failure the Add sheet's
  // frozen joined_at exists to prevent. Waiting means the values are
  // stable from the first render.
  if (!open || !entry || !contact) return null;

  const currentEmail = primaryEmail(contact);

  const transform = async (data: Record<string, unknown>) => {
    const entryFields = { ...data };
    for (const field of CONTACT_FIELDS) delete entryFields[field];

    const firstName = String(data.contact_first_name ?? "").trim();
    const lastName = String(data.contact_last_name ?? "").trim();
    const email = String(data.contact_email ?? "").trim();

    const nameChanged =
      firstName !== (contact.first_name ?? "").trim() ||
      lastName !== (contact.last_name ?? "").trim();
    const emailChanged =
      email.toLowerCase() !== currentEmail.trim().toLowerCase();

    // The Contact is written FIRST, and a failure here throws before the
    // entry is touched. That ordering is deliberate: the alternative
    // leaves the entry saved and the person's name still wrong, which is
    // the worse half to be left holding.
    if (emailChanged) {
      const ownership = await checkEmailOwnership(
        dataProvider,
        email,
        contact.id,
      );
      if (ownership.status === "belongs-to-another") {
        const name =
          `${ownership.owner.first_name ?? ""} ${ownership.owner.last_name ?? ""}`.trim() ||
          "another contact";
        throw new Error(`${name} already has this email — nothing was saved.`);
      }
      await replacePrimaryEmail(dataProvider, contact, email);
    }

    if (nameChanged) {
      await dataProvider.update("contacts", {
        id: contact.id,
        data: { first_name: firstName, last_name: lastName },
        previousData: contact,
      });
    }

    // The row shows the person's name through a reference to `contacts`,
    // and ra-core only invalidates the resource it is mutating — which
    // here is `waitlist_entries`. Without this the save succeeds and the
    // row keeps displaying the old, misspelled name, which is the exact
    // thing Leif opened the dialog to fix.
    if (nameChanged || emailChanged) {
      await queryClient.invalidateQueries({ queryKey: ["contacts"] });
    }

    return entryFields;
  };

  return (
    <EditDialog
      resource="waitlist_entries"
      id={entryId}
      title={translate("resources.waitlist_entries.sheet.edit", {
        _: "Edit waitlist entry",
      })}
      redirect={false}
      // Never undoable here. Undoable reports success before the write
      // happens, and this save also writes a Contact — so an Undo would
      // put the entry back and leave the person's corrected name in
      // place, with the toast having already claimed everything worked.
      mutationMode="pessimistic"
      transform={transform}
      defaultValues={{
        contact_first_name: contact.first_name ?? "",
        contact_last_name: contact.last_name ?? "",
        contact_email: currentEmail,
      }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {translate("resources.waitlist_entries.edit.person", {
              _: "Person",
            })}
          </h3>
          {/* The CRM's own name model, not a second one invented here. */}
          <div className="flex gap-3">
            <TextInput
              source="contact_first_name"
              label={translate("resources.contacts.fields.first_name", {
                _: "First name",
              })}
              helperText={false}
              className="flex-1"
            />
            <TextInput
              source="contact_last_name"
              label={translate("resources.contacts.fields.last_name", {
                _: "Last name",
              })}
              helperText={false}
              className="flex-1"
            />
          </div>
          <TextInput
            source="contact_email"
            label={translate("resources.contacts.fields.email", {
              _: "Email",
            })}
            helperText={false}
            validate={async (value: unknown) => {
              const email = typeof value === "string" ? value.trim() : "";
              if (email === "") {
                return translate("resources.waitlist_entries.email.required", {
                  _: "An email is needed so you can reach them about an opening.",
                });
              }
              if (!isPlausibleEmail(email)) {
                return translate("resources.waitlist_entries.email.invalid", {
                  _: "That does not look like an email address.",
                });
              }
              const ownership = await checkEmailOwnership(
                dataProvider,
                email,
                contact.id,
              );
              if (ownership.status === "belongs-to-another") {
                return translate(
                  "resources.waitlist_entries.email.belongs_to_another",
                  {
                    _: "%{name} already has this email. Add them from the search above, or use a different address for this person.",
                    name:
                      `${ownership.owner.first_name ?? ""} ${ownership.owner.last_name ?? ""}`.trim() ||
                      "Another contact",
                  },
                );
              }
              return undefined;
            }}
          />
        </section>

        <section className="flex flex-col gap-3 border-t pt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {translate("resources.waitlist_entries.edit.waitlist", {
              _: "Waitlist",
            })}
          </h3>
          <TextInput
            source="desired_timing"
            label={translate(
              "resources.waitlist_entries.fields.desired_timing",
              { _: "Desired timing" },
            )}
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
          <NumberInput
            source="priority"
            label={translate("resources.waitlist_entries.fields.priority", {
              _: "Priority (lower = sooner; optional)",
            })}
            helperText={false}
          />
        </section>
      </div>
    </EditDialog>
  );
};
