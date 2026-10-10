import type { DataProvider, Identifier, RaRecord } from "ra-core";

import type {
  Application,
  Contact,
  Deal,
  Enrollment,
  WaitlistEntry,
} from "../types";

// Inviting the oldest people waiting.
//
// THE SERVER DECIDES WHO. What the browser had on screen is a display — it
// can be stale, filtered, or collapsed to three rows — and a display may not
// decide who gets an email. Both calls below reach a SECURITY DEFINER
// function that works the list out from the database at the moment of the
// click, and the second one writes the batch, the invitations and the Kit
// outbox rows in a single transaction.
//
// Nobody is marked Invited here. That happens when Kit confirms the tag,
// through a trigger on the outbox, which is the only evidence worth
// believing.

export type InvitationExclusionReason =
  | "already-invited"
  | "invitation-in-flight"
  | "contact-missing"
  | "do-not-engage"
  | "no-email"
  | "already-applied"
  | "already-a-client"
  | "kit-refused-this-address-before";

export type InvitationCandidate = {
  waitlistEntryId: Identifier;
  contactId: Identifier;
  name: string;
  email: string | null;
  joinedAt: string;
  cohortId: Identifier | null;
  eligible: boolean;
  exclusionReason: InvitationExclusionReason | null;
  /** 1-based position among the eligible, oldest first. Null when excluded. */
  rankIfEligible: number | null;
};

export type InvitedPerson = {
  waitlistEntryId: Identifier;
  contactId: Identifier;
  name: string;
  email: string | null;
  joinedAt: string;
  invitationId: Identifier;
};

export type SkippedPerson = {
  waitlistEntryId: Identifier;
  contactId: Identifier;
  name: string;
  reason: InvitationExclusionReason | "no-email";
};

export type InviteResult =
  | { status: "nothing-asked-for" }
  /** The programme has no Kit tag for an invitation yet. */
  | { status: "not-configured"; offerId: Identifier }
  | { status: "nobody-eligible"; skipped: SkippedPerson[] }
  | {
      status: "queued";
      batchId: Identifier;
      kitTagId: number;
      kitTagName: string;
      requested: number;
      queued: number;
      invited: InvitedPerson[];
      skipped: SkippedPerson[];
    };

type InvitationCapableProvider = DataProvider & {
  waitlistInvitationCandidates?: (input: {
    offerId: Identifier;
    cohortId: Identifier | null;
  }) => Promise<Record<string, unknown>[]>;
  inviteOldestWaiting?: (input: {
    offerId: Identifier;
    cohortId: Identifier | null;
    limit: number | null;
    entryIds: Identifier[] | null;
    label: string | null;
  }) => Promise<Record<string, unknown>>;
};

const shapeCandidate = (raw: Record<string, unknown>): InvitationCandidate => ({
  waitlistEntryId: raw.waitlist_entry_id as Identifier,
  contactId: raw.contact_id as Identifier,
  name: String(raw.contact_name ?? "").trim(),
  email: (raw.email as string | null) ?? null,
  joinedAt: String(raw.joined_at ?? ""),
  cohortId: (raw.cohort_id as Identifier | null) ?? null,
  eligible: raw.eligible === true,
  exclusionReason:
    (raw.exclusion_reason as InvitationExclusionReason | null) ?? null,
  rankIfEligible:
    raw.rank_if_eligible == null ? null : Number(raw.rank_if_eligible),
});

const shapePerson = (raw: Record<string, unknown>): InvitedPerson => ({
  waitlistEntryId: raw.waitlist_entry_id as Identifier,
  contactId: raw.contact_id as Identifier,
  name: String(raw.name ?? "").trim(),
  email: (raw.email as string | null) ?? null,
  joinedAt: String(raw.joined_at ?? ""),
  invitationId: raw.invitation_id as Identifier,
});

const shapeSkipped = (raw: Record<string, unknown>): SkippedPerson => ({
  waitlistEntryId: raw.waitlist_entry_id as Identifier,
  contactId: raw.contact_id as Identifier,
  name: String(raw.name ?? "").trim(),
  reason: raw.reason as SkippedPerson["reason"],
});

const shapeResult = (raw: Record<string, unknown>): InviteResult => {
  const status = String(raw.status ?? "nothing-asked-for");
  const skipped = ((raw.skipped as Record<string, unknown>[]) ?? []).map(
    shapeSkipped,
  );
  if (status === "queued") {
    return {
      status,
      batchId: raw.batch_id as Identifier,
      kitTagId: Number(raw.kit_tag_id),
      kitTagName: String(raw.kit_tag_name ?? ""),
      requested: Number(raw.requested ?? 0),
      queued: Number(raw.queued ?? 0),
      invited: ((raw.invited as Record<string, unknown>[]) ?? []).map(
        shapePerson,
      ),
      skipped,
    };
  }
  if (status === "nobody-eligible") return { status, skipped };
  if (status === "not-configured") {
    return { status, offerId: raw.offer_id as Identifier };
  }
  return { status: "nothing-asked-for" };
};

/**
 * Who could be invited, and why somebody could not. Reads; writes nothing.
 */
export const waitlistInvitationCandidates = async (
  dataProvider: DataProvider,
  input: { offerId: Identifier; cohortId: Identifier | null },
): Promise<InvitationCandidate[]> => {
  const rpc = (dataProvider as InvitationCapableProvider)
    .waitlistInvitationCandidates;
  if (typeof rpc === "function") return (await rpc(input)).map(shapeCandidate);
  return (await candidatesMirror(dataProvider, input)).map(shapeCandidate);
};

export const inviteOldestWaiting = async (
  dataProvider: DataProvider,
  input: {
    offerId: Identifier;
    cohortId: Identifier | null;
    limit?: number | null;
    entryIds?: Identifier[] | null;
    label?: string | null;
  },
): Promise<InviteResult> => {
  const payload = {
    offerId: input.offerId,
    cohortId: input.cohortId,
    limit: input.limit ?? null,
    entryIds: input.entryIds ?? null,
    label: input.label ?? null,
  };
  const rpc = (dataProvider as InvitationCapableProvider).inviteOldestWaiting;
  if (typeof rpc === "function") return shapeResult(await rpc(payload));
  return shapeResult(await inviteMirror(dataProvider, payload));
};

// ---------------------------------------------------------------------------
// The mirrors
// ---------------------------------------------------------------------------
// The same decisions in the same order, for the demo provider and the
// component tests. What they cannot reproduce is the transaction, the row
// lock, or the trigger that ends somebody's waiting — which is exactly why
// production runs the database authority and why the rules themselves are
// proved against real Postgres in e2e/waitlistBatchInvitations.spec.ts.

const all = async <T extends RaRecord>(
  dataProvider: DataProvider,
  resource: string,
) =>
  (
    await dataProvider.getList<T>(resource, {
      filter: {},
      pagination: { page: 1, perPage: 2000 },
      sort: { field: "id", order: "ASC" },
    })
  ).data;

const emailsOf = (contact: Contact | undefined) =>
  (contact?.email_jsonb ?? [])
    .map((entry) => entry.email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email));

export const candidatesMirror = async (
  dataProvider: DataProvider,
  { offerId, cohortId }: { offerId: Identifier; cohortId: Identifier | null },
): Promise<Record<string, unknown>[]> => {
  const [entries, contacts, applications, deals, enrollments, invitations] =
    await Promise.all([
      all<WaitlistEntry>(dataProvider, "waitlist_entries"),
      all<Contact>(dataProvider, "contacts"),
      all<Application>(dataProvider, "applications"),
      all<Deal>(dataProvider, "deals"),
      all<Enrollment>(dataProvider, "enrollments"),
      all<RaRecord & { waitlist_entry_id: Identifier; status: string }>(
        dataProvider,
        "waitlist_invitations",
      ).catch(() => []),
    ]);

  const contactById = new Map(contacts.map((c) => [String(c.id), c]));
  const activeEnrollmentDeals = new Set(
    enrollments
      .filter((e) => ["onboarding", "active", "offboarding"].includes(e.status))
      .map((e) => String(e.opportunity_id)),
  );

  const waiting = entries
    .filter(
      (entry) =>
        String(entry.offer_id) === String(offerId) &&
        (cohortId == null || String(entry.cohort_id) === String(cohortId)) &&
        ["waiting", "invited"].includes(entry.status),
    )
    .sort(
      (a, b) =>
        a.joined_at.localeCompare(b.joined_at) || Number(a.id) - Number(b.id),
    );

  // One place per person — the oldest — exactly as the database picks it.
  const oldestPerPerson = [
    ...new Map(
      waiting.map((entry) => [String(entry.contact_id), entry]),
    ).values(),
  ];

  let rank = 0;
  return oldestPerPerson
    .sort(
      (a, b) =>
        a.joined_at.localeCompare(b.joined_at) || Number(a.id) - Number(b.id),
    )
    .map((entry) => {
      const contact = contactById.get(String(entry.contact_id));
      const emails = emailsOf(contact);
      const reason: InvitationExclusionReason | null =
        entry.status === "invited" ||
        invitations.some(
          (i) =>
            String(i.waitlist_entry_id) === String(entry.id) &&
            i.status === "sent",
        )
          ? "already-invited"
          : !contact
            ? "contact-missing"
            : contact.sales_eligibility === "do_not_engage"
              ? "do-not-engage"
              : emails.length === 0
                ? "no-email"
                : applications.some(
                      (a) =>
                        String(a.contact_id) === String(entry.contact_id) &&
                        String(a.offer_id) === String(offerId),
                    )
                  ? "already-applied"
                  : deals.some(
                        (d) =>
                          String(d.contact_id) === String(entry.contact_id) &&
                          String(d.offer_id) === String(offerId) &&
                          (d.stage === "won" ||
                            activeEnrollmentDeals.has(String(d.id))),
                      )
                    ? "already-a-client"
                    : null;
      if (reason == null) rank += 1;
      return {
        waitlist_entry_id: entry.id,
        contact_id: entry.contact_id,
        contact_name:
          `${contact?.first_name ?? ""} ${contact?.last_name ?? ""}`.trim(),
        email: emails[0] ?? null,
        joined_at: entry.joined_at,
        cohort_id: entry.cohort_id ?? null,
        eligible: reason == null,
        exclusion_reason: reason,
        rank_if_eligible: reason == null ? rank : null,
      };
    });
};

export const inviteMirror = async (
  dataProvider: DataProvider,
  {
    offerId,
    cohortId,
    limit,
    entryIds,
    label,
  }: {
    offerId: Identifier;
    cohortId: Identifier | null;
    limit: number | null;
    entryIds: Identifier[] | null;
    label: string | null;
  },
): Promise<Record<string, unknown>> => {
  if (limit == null && entryIds == null) return { status: "nothing-asked-for" };

  const mappings = await all<
    RaRecord & {
      offer_id: Identifier;
      event: string;
      kit_tag_id: number;
      kit_tag_name: string;
    }
  >(dataProvider, "kit_tag_mappings").catch(() => []);
  const mapping = mappings.find(
    (m) =>
      String(m.offer_id) === String(offerId) && m.event === "waitlist_invited",
  );
  if (!mapping) return { status: "not-configured", offer_id: offerId };

  const candidates = await candidatesMirror(dataProvider, {
    offerId,
    cohortId,
  });
  const asked = candidates.filter(
    (row) =>
      entryIds == null ||
      entryIds.some((id) => String(id) === String(row.waitlist_entry_id)),
  );

  const { data: batch } = await dataProvider.create(
    "waitlist_invitation_batches",
    {
      data: {
        offer_id: offerId,
        cohort_id: cohortId,
        label: label ?? "Invite to apply",
        status: "prepared",
      } as never,
    },
  );

  const invited: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  for (const row of asked) {
    if (!row.eligible) {
      skipped.push({
        waitlist_entry_id: row.waitlist_entry_id,
        contact_id: row.contact_id,
        name: row.contact_name,
        email: row.email,
        joined_at: row.joined_at,
        reason: row.exclusion_reason,
      });
      continue;
    }
    if (limit != null && invited.length >= limit) break;

    const { data: invitation } = await dataProvider.create(
      "waitlist_invitations",
      {
        data: {
          batch_id: batch.id,
          waitlist_entry_id: row.waitlist_entry_id,
          contact_id: row.contact_id,
          status: "prepared",
          prepared_at: new Date().toISOString(),
        } as never,
      },
    );
    await dataProvider.create("kit_sync_operations", {
      data: {
        contact_id: row.contact_id,
        application_id: null,
        waitlist_invitation_id: invitation.id,
        kind: "waitlist_invited",
        origin: "waitlist_invitation",
        email: row.email,
        kit_tag_id: mapping.kit_tag_id,
        kit_tag_name: mapping.kit_tag_name,
        status: "pending",
      } as never,
    });
    invited.push({
      waitlist_entry_id: row.waitlist_entry_id,
      contact_id: row.contact_id,
      name: row.contact_name,
      email: row.email,
      joined_at: row.joined_at,
      invitation_id: invitation.id,
    });
  }

  return {
    status: invited.length === 0 ? "nobody-eligible" : "queued",
    batch_id: invited.length === 0 ? null : batch.id,
    offer_id: offerId,
    cohort_id: cohortId,
    kit_tag_id: mapping.kit_tag_id,
    kit_tag_name: mapping.kit_tag_name,
    requested: limit ?? entryIds?.length ?? 0,
    queued: invited.length,
    invited,
    skipped,
  };
};
