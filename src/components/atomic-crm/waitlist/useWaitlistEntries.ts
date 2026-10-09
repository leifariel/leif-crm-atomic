import { useGetList, useGetMany, type Identifier } from "ra-core";

import type { Contact, WaitlistEntry, WaitlistEntryStatus } from "../types";
import { ACTIVE_WAITLIST_STATUSES } from "./waitlistConstants";

export type WaitlistEntryRow = {
  entryId: Identifier;
  contactId: Identifier;
  name: string;
  // Every email on file, joined — used only for local search matching
  // (WaitlistSection.tsx, human-acceptance repair pass §1), never
  // displayed. No dedicated Instagram-handle field exists on Contact yet,
  // so search matches name/email only — see that file's own comment.
  email: string | null;
  status: WaitlistEntryStatus;
  joinedAt: string;
  desiredTiming: string | null;
  notes: string | null;
  priority: number | null;
};

// Backs every "Waitlist" section (Living Example / Group Program / Cohort
// pages, §7/§8) and their counts (Programs hub / Dashboard cards, §6/§15,
// and program capacity cards) — real WaitlistEntry + Contact data only.
// Returns *active* (waiting/invited) entries only: a Program/Cohort page's
// live waitlist is a current-operations view, not a history log — see
// waitlist/useContactWaitlists.ts for the Contact-side lifetime history
// (including converted/removed).
//
// `cohortId: null` means offer-level entries only (cohort_id IS NULL —
// general "wants this Offer" waiting, never silently including
// cohort-specific entries); `offerId` is required in this case. `cohortId:
// <id>` means that Cohort's entries only — a Cohort id alone already
// disambiguates, so `offerId` isn't needed (and is ignored) in this case,
// letting callers that only have a cohort id on hand (useCohortCapacity)
// use this without an extra Offer fetch. Never pass `undefined` for
// cohortId — pass `null` explicitly, so an offer-level and a
// cohort-specific query can never be confused with each other.
export const useWaitlistEntries = ({
  offerId,
  cohortId,
}: {
  offerId?: Identifier;
  cohortId: Identifier | null;
}) => {
  const { data: entries, isPending: entriesPending } =
    useGetList<WaitlistEntry>(
      "waitlist_entries",
      {
        filter:
          cohortId != null
            ? { cohort_id: cohortId }
            : { offer_id: offerId, "cohort_id@is": null },
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "joined_at", order: "ASC" },
      },
      { enabled: cohortId != null || offerId != null },
    );

  const activeEntries = (entries ?? []).filter((entry) =>
    ACTIVE_WAITLIST_STATUSES.has(entry.status),
  );

  const contactIds = [
    ...new Set(activeEntries.map((entry) => entry.contact_id)),
  ];
  const { data: contacts } = useGetMany<Contact>(
    "contacts",
    { ids: contactIds },
    {
      enabled: contactIds.length > 0,
      // ADDING ONE PERSON MUST NOT UNMOUNT THE PAGE.
      //
      // The id set is part of this query's key, so adding somebody makes it
      // a NEW query with no cached answer — which reported "pending" with no
      // data, and every page that hosts a waitlist guards on that with
      // `if (isPending) return null`. The whole page came out of the DOM for
      // a moment, the document collapsed to the height of the window, the
      // browser clamped the scroll to 0, and Leif — who adds people several
      // at a time — was returned to the top after every single one.
      //
      // Measured: scrollY 733 before the add, 0 after, with the document
      // height unchanged either side. Keeping the previous answer while the
      // new one loads means the rows she was already looking at never stop
      // existing, so there is nothing to collapse and nothing to restore.
      placeholderData: (previous: Contact[] | undefined) => previous,
    },
  );

  // Pending means "nothing to show yet", not "something is in flight". A
  // waitlist that has already rendered keeps rendering.
  const isPending =
    entriesPending || (contactIds.length > 0 && contacts == null);

  if (isPending) {
    return { isPending: true, entries: [] as WaitlistEntryRow[] };
  }

  const contactById = new Map(
    (contacts ?? []).map((contact) => [String(contact.id), contact]),
  );
  const nameFor = (contactId: Identifier) => {
    const contact = contactById.get(String(contactId));
    return contact ? `${contact.first_name} ${contact.last_name}` : "";
  };
  const emailFor = (contactId: Identifier) => {
    const emails = (contactById.get(String(contactId))?.email_jsonb ?? [])
      .map((entry) => entry.email)
      .filter(Boolean);
    return emails.length > 0 ? emails.join(", ") : null;
  };

  const rows: WaitlistEntryRow[] = activeEntries
    .map((entry) => ({
      entryId: entry.id,
      contactId: entry.contact_id,
      name: nameFor(entry.contact_id),
      email: emailFor(entry.contact_id),
      status: entry.status,
      joinedAt: entry.joined_at,
      desiredTiming: entry.desired_timing ?? null,
      notes: entry.notes ?? null,
      priority: entry.priority ?? null,
    }))
    // Priority first (lower = sooner) when set, then joined date — a
    // sortable hint, never a rigid FIFO rule (§14).
    .sort((a, b) => {
      if (a.priority != null && b.priority != null) {
        return a.priority - b.priority || a.joinedAt.localeCompare(b.joinedAt);
      }
      if (a.priority != null) return -1;
      if (b.priority != null) return 1;
      return a.joinedAt.localeCompare(b.joinedAt);
    });

  return { isPending: false, entries: rows };
};
