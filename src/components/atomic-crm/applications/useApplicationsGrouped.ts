import { useGetList, useGetMany, type Identifier } from "ra-core";

import type { Application, Cohort, Contact, Deal, Offer } from "../types";
import {
  classifyApplication,
  type ApplicationBucket,
} from "./classifyApplication";

export type ApplicationRow = {
  applicationId: Identifier;
  // Optional on purpose: 78 production Applications have no Opportunity,
  // and a legitimate applicant who never entered the pipeline should not
  // vanish from the page for it.
  dealId: Identifier | null;
  contactId: Identifier;
  contactName: string;
  status: Application["status"];
  submittedAt: string;
  bucket: ApplicationBucket;
  // Surfaced on Pre-CRM rows so the sales context that makes them live is
  // visible on the row rather than implied by the section alone.
  dealStage: string | null;
};

export type ApplicationBuckets = Record<ApplicationBucket, ApplicationRow[]>;

export type ApplicationSection = {
  key: string;
  /** "The Living Example" or "Growing Yourself Up" */
  offer: Offer;
  /** null for an individual offer, the cohort for a group one */
  cohort: Cohort | null;
  buckets: ApplicationBuckets;
  total: number;
};

const emptyBuckets = (): ApplicationBuckets => ({
  "needs-review": [],
  reviewed: [],
  "pre-crm-active-sales": [],
  historical: [],
});

// The Applications page, grouped the way Leif reads it: which programme,
// then what it needs from him.
//
// It used to ask `source` first — public_form meant review work,
// historical_import meant history — and then find the programme by
// walking opportunity_id to the Deal. Both were wrong in a way that cost
// real work: six January 2027 applications Leif needs to read sat in a
// Historical section because of how they arrived, and 78 Applications had
// no Opportunity to walk, so they could not be placed at all.
//
// Programme and person come from the APPLICATION's own columns, which are
// populated on every production row: offer_id, intended_cohort_id,
// contact_id. The Deal is consulted for one question only — is a sales
// process still running — and never for identity.
//
// One exception, and it adds information rather than requiring it: five
// Fall 2026 records carry their cohort only on the Deal. Where the
// Application has no intended_cohort_id and the Deal names one, that is
// used. The two never disagree in production (checked), so this cannot
// silently override an Application's own answer.
export const useApplicationsGrouped = (): {
  isPending: boolean;
  sections: ApplicationSection[];
  totals: Record<ApplicationBucket, number>;
} => {
  const { data: applications, isPending: applicationsPending } =
    useGetList<Application>("applications", {
      // Every Application, whatever its provenance. What it IS decides
      // where it goes, not how it got here.
      filter: {},
      pagination: { page: 1, perPage: 1000 },
      sort: { field: "submitted_at", order: "DESC" },
    });

  const dealIds = [
    ...new Set(
      (applications ?? [])
        .map((a) => a.opportunity_id)
        .filter((id): id is Identifier => id != null),
    ),
  ];
  const { data: deals, isPending: dealsPending } = useGetMany<Deal>(
    "deals",
    { ids: dealIds },
    { enabled: dealIds.length > 0 },
  );

  const { data: offers, isPending: offersPending } = useGetList<Offer>(
    "offers",
    {
      filter: {},
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    },
  );
  const { data: cohorts, isPending: cohortsPending } = useGetList<Cohort>(
    "cohorts",
    {
      filter: {},
      pagination: { page: 1, perPage: 200 },
      sort: { field: "id", order: "ASC" },
    },
  );

  const contactIds = [
    ...new Set(
      (applications ?? [])
        .map((a) => a.contact_id)
        .filter((id): id is Identifier => id != null),
    ),
  ];
  const { data: contacts, isPending: contactsPending } = useGetMany<Contact>(
    "contacts",
    { ids: contactIds },
    { enabled: contactIds.length > 0 },
  );

  const isPending =
    applicationsPending ||
    offersPending ||
    cohortsPending ||
    (dealIds.length > 0 && dealsPending) ||
    (contactIds.length > 0 && contactsPending);

  if (isPending) {
    return {
      isPending: true,
      sections: [],
      totals: {
        "needs-review": 0,
        reviewed: 0,
        "pre-crm-active-sales": 0,
        historical: 0,
      },
    };
  }

  const dealById = new Map((deals ?? []).map((d) => [String(d.id), d]));
  const offerById = new Map((offers ?? []).map((o) => [String(o.id), o]));
  const cohortById = new Map((cohorts ?? []).map((c) => [String(c.id), c]));
  const contactById = new Map((contacts ?? []).map((c) => [String(c.id), c]));

  const sectionMap = new Map<string, ApplicationSection>();
  const totals: Record<ApplicationBucket, number> = {
    "needs-review": 0,
    reviewed: 0,
    "pre-crm-active-sales": 0,
    historical: 0,
  };

  for (const application of applications ?? []) {
    const deal =
      application.opportunity_id != null
        ? (dealById.get(String(application.opportunity_id)) ?? null)
        : null;

    // The Application's own offer_id first — it is set on every
    // production row, and it is what makes the 78 Opportunity-less ones
    // placeable at all. The Deal is a rescue for a row that somehow has
    // neither, never the requirement: nothing should vanish from this
    // page for want of an Opportunity.
    const offer =
      offerById.get(String(application.offer_id)) ??
      (deal ? (offerById.get(String(deal.offer_id)) ?? null) : null);
    if (!offer) continue;

    const cohortId = application.intended_cohort_id ?? deal?.cohort_id ?? null;
    const cohort =
      offer.type === "group" && cohortId != null
        ? (cohortById.get(String(cohortId)) ?? null)
        : null;

    const bucket = classifyApplication(application, { cohort, deal });

    const contact = contactById.get(String(application.contact_id));
    const row: ApplicationRow = {
      applicationId: application.id,
      dealId: deal?.id ?? null,
      contactId: application.contact_id,
      contactName: contact
        ? `${contact.first_name} ${contact.last_name}`.trim()
        : (deal?.name ?? "Unknown person"),
      status: application.status,
      submittedAt: application.submitted_at,
      bucket,
      dealStage: deal?.stage ?? null,
    };

    const key = cohort ? `cohort:${cohort.id}` : `offer:${offer.id}`;
    const section = sectionMap.get(key) ?? {
      key,
      offer,
      cohort,
      buckets: emptyBuckets(),
      total: 0,
    };
    section.buckets[bucket].push(row);
    section.total += 1;
    sectionMap.set(key, section);
    totals[bucket] += 1;
  }

  // Newest submission first inside every subsection — the same order the
  // list is already fetched in, made explicit so it survives grouping.
  for (const section of sectionMap.values()) {
    for (const rows of Object.values(section.buckets)) {
      rows.sort(byNewestSubmission);
    }
  }

  return {
    isPending: false,
    sections: [...sectionMap.values()].sort(bySectionOrder),
    totals,
  };
};

const byNewestSubmission = (a: ApplicationRow, b: ApplicationRow): number => {
  if (a.submittedAt !== b.submittedAt) {
    return b.submittedAt.localeCompare(a.submittedAt);
  }
  // Ties broken by name so the order never shuffles between renders.
  return a.contactName.localeCompare(b.contactName);
};

// What Leif has to act on, first.
//
// A section with review work outranks one without, because that is the
// question the page exists to answer. Then open cohorts ahead of closed
// ones, then the individual offer, then newest cohort first. Fully
// tie-broken on key so the order is stable across renders.
const bySectionOrder = (
  a: ApplicationSection,
  b: ApplicationSection,
): number => {
  const needs = (s: ApplicationSection) =>
    s.buckets["needs-review"].length > 0 ? 0 : 1;
  if (needs(a) !== needs(b)) return needs(a) - needs(b);

  const openCohort = (s: ApplicationSection) =>
    s.cohort?.status === "applications_open" ? 0 : 1;
  if (openCohort(a) !== openCohort(b)) return openCohort(a) - openCohort(b);

  // The rolling 1:1 programme above finished cohorts.
  const individual = (s: ApplicationSection) => (s.cohort == null ? 0 : 1);
  if (individual(a) !== individual(b)) return individual(a) - individual(b);

  if (a.cohort && b.cohort && a.cohort.id !== b.cohort.id) {
    return Number(b.cohort.id) - Number(a.cohort.id);
  }
  return a.key.localeCompare(b.key);
};
