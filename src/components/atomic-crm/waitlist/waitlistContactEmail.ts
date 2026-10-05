import type { DataProvider } from "ra-core";

import type { Contact } from "../types";
import { normalizeEmail } from "../public-application/submitApplication";

// A waitlist entry Leif cannot act on is not worth holding.
//
// The business rule, stated by Leif: an ACTIVE waitlist entry only means
// something if the person can actually be contacted, so every one of them
// belongs to a Contact with an email address. That is why the field below
// is required rather than offered — not to make the form tidy, but because
// an entry without a way to reach the person is a row that will sit there
// looking like a commitment and cannot become one.
//
// Email stays a fact about the CONTACT. It is never written onto the
// waitlist entry: the same person on two waitlists has one email, and
// copying it would create two places for it to disagree.

/**
 * The form field that carries a typed email through a waitlist dialog.
 *
 * Deliberately NOT a column on `waitlist_entries`: the address is a fact
 * about the person, so every dialog strips this key and writes it to the
 * Contact instead (see `applyTypedContactEmail`). It lives here rather
 * than beside the input because two different sheets and the function
 * that consumes it all need the same name.
 */
export const CONTACT_EMAIL_SOURCE = "contact_email";

// Deliberately loose — one @, something either side, a dot in the domain.
// The same shape the public application form accepts. A stricter regex
// rejects real addresses, and the only real proof an address works is
// mail arriving at it.
const PLAUSIBLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isPlausibleEmail = (email: string): boolean =>
  PLAUSIBLE_EMAIL.test(email.trim());

/**
 * Does this Contact already have an email we could reach them on?
 *
 * Blank strings count as absent: a Contact carrying `[{ email: "" }]` is
 * not contactable, and treating it as "has an email" would let exactly the
 * unreachable entry the rule exists to prevent slip through.
 */
export const contactHasEmail = (
  contact: Pick<Contact, "email_jsonb"> | null | undefined,
): boolean =>
  (contact?.email_jsonb ?? []).some(
    (entry) => typeof entry?.email === "string" && entry.email.trim() !== "",
  );

/**
 * The Contact that already owns this email, if somebody does.
 *
 * Scans every Contact and compares normalized addresses, the same way
 * submitApplication resolves an applicant. That is a full-table read, and
 * it is the established approach at this app's scale — see that file's own
 * note about a normalized indexed column being the real hardening.
 */
export const findContactByEmail = async (
  dataProvider: DataProvider,
  email: string,
): Promise<Contact | null> => {
  const wanted = normalizeEmail(email);
  if (wanted === "") return null;

  const { data: contacts } = await dataProvider.getList<Contact>("contacts", {
    filter: {},
    pagination: { page: 1, perPage: 1000 },
    sort: { field: "id", order: "ASC" },
  });

  return (
    contacts.find((contact) =>
      (contact.email_jsonb ?? []).some(
        (entry) => entry.email && normalizeEmail(entry.email) === wanted,
      ),
    ) ?? null
  );
};

export type EmailOwnership =
  | { status: "free" }
  | { status: "already-theirs" }
  | { status: "belongs-to-another"; owner: Contact };

/**
 * Who owns this address, from the point of view of the person being added.
 *
 * Three answers, and the third is the one that matters. An email is close
 * to identity: if somebody else already has it, these may be one person
 * under two records, or a typo, or a shared family address. The CRM cannot
 * know which, so it says so and stops. It never merges the two Contacts
 * and never moves the address off the other one — both of those are
 * decisions that would be made silently, on a guess, and would be
 * difficult to notice afterwards.
 */
export const checkEmailOwnership = async (
  dataProvider: DataProvider,
  email: string,
  contactId: number | string,
): Promise<EmailOwnership> => {
  const owner = await findContactByEmail(dataProvider, email);
  if (!owner) return { status: "free" };
  if (String(owner.id) === String(contactId))
    return { status: "already-theirs" };
  return { status: "belongs-to-another", owner };
};

/**
 * The address shown when a Contact's email is edited: their first one.
 *
 * A Contact can carry several. The waitlist dialogs show and edit one,
 * because the question they answer is "can Leif reach this person", not
 * "manage every address they have" — that is the Contact page's job.
 */
export const primaryEmail = (
  contact: Pick<Contact, "email_jsonb"> | null | undefined,
): string =>
  (contact?.email_jsonb ?? []).find(
    (entry) => typeof entry?.email === "string" && entry.email.trim() !== "",
  )?.email ?? "";

/**
 * Correct the address already on the Contact, rather than adding another.
 *
 * This is the edit case, and it is the opposite of attachEmailToContact
 * below. Leif fixing a typo means the wrong address should STOP being on
 * the record; appending would leave the CRM holding both and no way to
 * tell which one is real. Any further addresses the Contact has are kept
 * untouched — only the one the dialog showed is replaced.
 */
export const replacePrimaryEmail = async (
  dataProvider: DataProvider,
  contact: Contact,
  email: string,
): Promise<void> => {
  const trimmed = email.trim();
  if (trimmed === "") return;

  const existing = contact.email_jsonb ?? [];
  const firstRealIndex = existing.findIndex(
    (entry) => typeof entry?.email === "string" && entry.email.trim() !== "",
  );

  const next =
    firstRealIndex === -1
      ? [...existing, { email: trimmed, type: "Other" as const }]
      : existing.map((entry, index) =>
          index === firstRealIndex ? { ...entry, email: trimmed } : entry,
        );

  await dataProvider.update("contacts", {
    id: contact.id,
    data: { email_jsonb: next },
    previousData: contact,
  });
};

/**
 * Put the address on the Contact, having already established it is free.
 *
 * Appends rather than replaces, so an address Leif adds here never
 * overwrites one already recorded somewhere else on that person.
 */
/**
 * The one save: put the typed address on the Contact, then hand back the
 * waitlist entry without it.
 *
 * Shared by both dialogs that can create an entry, so the rule cannot
 * hold on one door and not the other. The ownership check runs here even
 * though the field validator already ran: the validator is what Leif
 * sees, this is what guards the write, because a Contact created in
 * another tab can land between typing and saving.
 *
 * Throws rather than merging two people or moving an address off
 * somebody else — that decision is Leif's, and made silently it would be
 * very hard to notice afterwards.
 */
export const applyTypedContactEmail = async (
  dataProvider: DataProvider,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const { [CONTACT_EMAIL_SOURCE]: typed, ...entry } = data;
  const email = typeof typed === "string" ? typed.trim() : "";
  if (email === "") return entry;

  const contactId = entry.contact_id as number | string;
  const ownership = await checkEmailOwnership(dataProvider, email, contactId);
  if (ownership.status === "belongs-to-another") {
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

export const attachEmailToContact = async (
  dataProvider: DataProvider,
  contact: Contact,
  email: string,
): Promise<void> => {
  const trimmed = email.trim();
  if (trimmed === "") return;

  const existing = contact.email_jsonb ?? [];
  const alreadyThere = existing.some(
    (entry) =>
      entry.email && normalizeEmail(entry.email) === normalizeEmail(trimmed),
  );
  if (alreadyThere) return;

  await dataProvider.update("contacts", {
    id: contact.id,
    data: {
      email_jsonb: [...existing, { email: trimmed, type: "Other" as const }],
    },
    previousData: contact,
  });
};
