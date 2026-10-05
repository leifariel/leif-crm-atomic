import type { DataProvider, Identifier } from "ra-core";

import type { Contact, WaitlistEntry } from "../types";
import { isContactDoNotEngage } from "../contacts/doNotEngageGuard";
import { isPlausibleEmail, findContactByEmail } from "./waitlistContactEmail";
import { findActiveWaitlistEntry } from "./waitlistEntryValidation";

// Add to Waitlist, email first.
//
// The rule this is built around is Leif's and is durable: a CONTACT may
// exist without an email, but an ACTIVE WAITLIST ENTRY may not. A place
// opening up is only worth holding for somebody who can be told about it.
// So there is no "skip email" path here — recording a person with only a
// name is Contact creation, a different act, on a different page.
//
// The previous flow asked for the PERSON first through an autocomplete,
// created them with `email_jsonb: []`, and only then asked for an email in
// a second field. That put the one fact which identifies a person last,
// buried creation inside a dropdown, and created Contacts that the rule
// above says cannot be waitlisted yet. Email is asked first because it is
// the identity, not because it is tidy.
//
// Everything identity-related is delegated, never re-implemented:
// `findContactByEmail` + `normalizeEmail` decide whether this address is
// already somebody's, `isContactDoNotEngage` is the single Do Not Engage
// authority, and `findActiveWaitlistEntry` is the duplicate-membership
// guard that the Postgres partial unique index also enforces.

export type WaitlistEmailLookup =
  /** Nothing usable typed yet — not an answer about anybody. */
  | { kind: "unusable" }
  | { kind: "free" }
  | {
      kind: "existing";
      contact: Contact;
      doNotEngage: boolean;
      activeEntry: WaitlistEntry | null;
    };

/**
 * Who, if anyone, already owns this address — and what that means here.
 *
 * Deliberately answers all three questions at once (who owns it, may they
 * be engaged, are they already waiting) so the modal can tell the whole
 * truth in one card instead of revealing a problem after Leif commits.
 */
export const lookUpWaitlistEmail = async (
  dataProvider: DataProvider,
  {
    email,
    offerId,
    cohortId,
  }: { email: string; offerId: Identifier; cohortId: Identifier | null },
): Promise<WaitlistEmailLookup> => {
  if (!isPlausibleEmail(email)) return { kind: "unusable" };

  const contact = await findContactByEmail(dataProvider, email);
  if (!contact) return { kind: "free" };

  const [doNotEngage, activeEntry] = await Promise.all([
    isContactDoNotEngage(dataProvider, contact.id),
    findActiveWaitlistEntry(dataProvider, {
      contactId: contact.id,
      offerId,
      cohortId,
    }),
  ]);

  return { kind: "existing", contact, doNotEngage, activeEntry };
};

export type WaitlistAddResult =
  | { kind: "added"; contact: Contact; entry: WaitlistEntry }
  /** Somebody else owns this address — these may be one person twice. */
  | { kind: "email-taken"; contact: Contact }
  | { kind: "already-waiting"; contact: Contact; entry: WaitlistEntry }
  | { kind: "do-not-engage"; contact: Contact }
  /**
   * The Contact exists and the membership does not. Reported rather than
   * hidden: the person IS now in the CRM, and saying "nothing happened"
   * would send Leif to create them a second time.
   */
  | { kind: "contact-created-entry-failed"; contact: Contact; reason: string };

/** First and last name from one typed string, without inventing either. */
export const splitPersonName = (
  name: string,
): { firstName: string; lastName: string } => {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: "", lastName: "" };
  // A single word is a first name. Guessing that "Madonna" is a surname
  // would be worse than leaving the field genuinely empty.
  const [firstName, ...rest] = tokens;
  return { firstName, lastName: rest.join(" ") };
};

const createEntry = async (
  dataProvider: DataProvider,
  {
    contactId,
    offerId,
    cohortId,
  }: {
    contactId: Identifier;
    offerId: Identifier;
    cohortId: Identifier | null;
  },
): Promise<WaitlistEntry> => {
  const { data } = await dataProvider.create<WaitlistEntry>(
    "waitlist_entries",
    {
      data: {
        contact_id: contactId,
        offer_id: offerId,
        cohort_id: cohortId,
        status: "waiting",
        // Leif is doing this by hand, so the origin is known rather than
        // rendered as "Unknown" from an empty field.
        source: "manual",
        joined_at: new Date().toISOString(),
      },
    },
  );
  return data;
};

/**
 * Put an existing person on this waitlist.
 *
 * Never renames them. Leif may have typed a different spelling than the
 * record holds; choosing "Use this contact" means use that person, not
 * overwrite their name from a waitlist dialog.
 */
export const addExistingContactToWaitlist = async (
  dataProvider: DataProvider,
  {
    contact,
    offerId,
    cohortId,
  }: { contact: Contact; offerId: Identifier; cohortId: Identifier | null },
): Promise<WaitlistAddResult> => {
  // Re-checked at save time, not only when the card rendered: both facts
  // can change between Leif reading the card and pressing the button.
  if (await isContactDoNotEngage(dataProvider, contact.id)) {
    return { kind: "do-not-engage", contact };
  }

  const existing = await findActiveWaitlistEntry(dataProvider, {
    contactId: contact.id,
    offerId,
    cohortId,
  });
  if (existing) return { kind: "already-waiting", contact, entry: existing };

  const entry = await createEntry(dataProvider, {
    contactId: contact.id,
    offerId,
    cohortId,
  });
  return { kind: "added", contact, entry };
};

/**
 * Create the person and their membership as one act.
 *
 * The Contact is created WITH the address, so it never exists in the
 * unreachable state the waitlist rule forbids, and Leif is never asked to
 * go and find the person he just typed.
 *
 * The ownership check runs again here even though the modal already ran
 * it. The modal's check is what Leif sees; this one guards the write,
 * because a Contact created in another tab can land in between.
 */
export const addNewPersonToWaitlist = async (
  dataProvider: DataProvider,
  {
    email,
    name,
    offerId,
    cohortId,
    salesId,
  }: {
    email: string;
    name: string;
    offerId: Identifier;
    cohortId: Identifier | null;
    salesId?: Identifier;
  },
): Promise<WaitlistAddResult> => {
  const trimmedEmail = email.trim();

  const owner = await findContactByEmail(dataProvider, trimmedEmail);
  if (owner) return { kind: "email-taken", contact: owner };

  const { firstName, lastName } = splitPersonName(name);
  const now = new Date().toISOString();

  const { data: contact } = await dataProvider.create<Contact>("contacts", {
    data: {
      first_name: firstName,
      last_name: lastName,
      email_jsonb: [{ email: trimmedEmail, type: "Other" }],
      phone_jsonb: [],
      tags: [],
      sales_id: salesId,
      first_seen: now,
      last_seen: now,
    },
  });

  try {
    const entry = await createEntry(dataProvider, {
      contactId: contact.id,
      offerId,
      cohortId,
    });
    return { kind: "added", contact, entry };
  } catch (error) {
    return {
      kind: "contact-created-entry-failed",
      contact,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
