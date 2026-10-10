import { useGetList, useGetMany, type Identifier } from "ra-core";

import { classifyCohortOpportunity } from "../cohorts/cohortCapacity";
import { humanizeCohortName } from "../cohorts/humanizeCohortName";
import { isPersonDeciding } from "../deals/peopleDeciding";
import type { Application, Cohort, Contact, Deal, Enrollment } from "../types";

// The people of a GROUP PROGRAMME, across every round it has run.
//
// A round's page answers "who is in this round". The programme's page
// answers "who is in this programme" — Leif runs Growing Yourself Up as a
// thing that outlives any one round, and the question "who is deciding
// about GYU right now" has no round to ask it of.
//
// Nothing here is a new definition. Every section reuses the authority the
// round's page already uses:
//
//   client     classifyCohortOpportunity -> "enrolled", plus an active
//              Enrollment. Not re-derived from stages.
//   deciding   deals/peopleDeciding.ts -> isPersonDeciding, a live
//              Opportunity at the Decision stage. Never an approved
//              application.
//   application  the application record itself, with its own status.
//
// What IS new is the scope, and the two things scope can get wrong:
// leaking another programme's people in, and counting one person twice.
// Everything is keyed by its own row id and filtered on this Offer.

const ACTIVE_ENROLLMENT_STATUSES: ReadonlySet<Enrollment["status"]> = new Set([
  "onboarding",
  "active",
  "offboarding",
]);

export type ProgrammeClient = {
  enrollmentId: Identifier;
  dealId: Identifier;
  contactId: Identifier;
  name: string;
  status: Enrollment["status"];
  cohortLabel: string | null;
};

export type ProgrammeDecider = {
  dealId: Identifier;
  contactId: Identifier;
  name: string;
  cohortLabel: string | null;
};

export type ProgrammeApplication = {
  applicationId: Identifier;
  contactId: Identifier;
  name: string;
  status: Application["status"];
  submittedAt: string;
  cohortLabel: string | null;
};

export const useGroupProgrammePeople = (
  offerId: Identifier | undefined,
  offerName: string,
) => {
  // Every round, including completed ones. The navigation list on the page
  // hides completed rounds; a LABEL may not, or a client of last spring's
  // round would be rendered with no round at all.
  const { data: cohorts, isPending: cohortsPending } = useGetList<Cohort>(
    "cohorts",
    {
      filter: { offer_id: offerId },
      pagination: { page: 1, perPage: 500 },
      sort: { field: "program_start_at", order: "ASC" },
    },
    { enabled: offerId != null },
  );

  const { data: deals, isPending: dealsPending } = useGetList<Deal>(
    "deals",
    {
      // THE CROSS-OFFER GUARD. An Opportunity belongs to one Offer, so
      // filtering here is what keeps a Living Example decider off this
      // page — not a check further down that somebody could forget.
      filter: { offer_id: offerId },
      pagination: { page: 1, perPage: 1000 },
      sort: { field: "id", order: "ASC" },
    },
    { enabled: offerId != null },
  );

  const dealIds = (deals ?? []).map((deal) => deal.id);
  const { data: enrollments, isPending: enrollmentsPending } =
    useGetList<Enrollment>(
      "enrollments",
      {
        filter: { "opportunity_id@in": `(${dealIds.join(",")})` },
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "id", order: "ASC" },
      },
      { enabled: !dealsPending },
    );

  // Applications have TWO truthful sources for "this programme", exactly
  // as they do for a round, and dropping either loses real records:
  // applications.offer_id is nullable, so a legacy application says which
  // programme it is for only through the round it intended.
  const { data: offerApplications, isPending: offerApplicationsPending } =
    useGetList<Application>(
      "applications",
      {
        filter: { offer_id: offerId },
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "submitted_at", order: "DESC" },
      },
      { enabled: offerId != null },
    );

  const cohortIdList = `(${(cohorts ?? []).map((cohort) => cohort.id).join(",")})`;
  const { data: cohortApplications, isPending: cohortApplicationsPending } =
    useGetList<Application>(
      "applications",
      {
        filter: { "intended_cohort_id@in": cohortIdList },
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "submitted_at", order: "DESC" },
      },
      { enabled: !cohortsPending && (cohorts ?? []).length > 0 },
    );

  // DEDUPLICATION, done once and by id. An application that both names
  // this Offer and intends one of its rounds comes back from both queries;
  // it is one application either way.
  const applications = [
    ...new Map(
      [...(offerApplications ?? []), ...(cohortApplications ?? [])].map(
        (application) => [String(application.id), application],
      ),
    ).values(),
  ].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

  const contactIds = [
    ...new Set([
      ...(deals ?? []).map((deal) => deal.contact_id),
      ...applications.map((application) => application.contact_id),
    ]),
  ];
  const { data: contacts, isPending: contactsPending } = useGetMany<Contact>(
    "contacts",
    { ids: contactIds },
    { enabled: contactIds.length > 0 },
  );

  const isPending =
    offerId == null ||
    cohortsPending ||
    dealsPending ||
    enrollmentsPending ||
    offerApplicationsPending ||
    ((cohorts ?? []).length > 0 && cohortApplicationsPending) ||
    (contactIds.length > 0 && contactsPending);

  if (isPending) {
    return {
      isPending: true,
      clients: [] as ProgrammeClient[],
      peopleDeciding: [] as ProgrammeDecider[],
      applications: [] as ProgrammeApplication[],
    };
  }

  const contactById = new Map(
    (contacts ?? []).map((contact) => [String(contact.id), contact]),
  );
  const nameFor = (contactId: Identifier) => {
    const contact = contactById.get(String(contactId));
    return contact ? `${contact.first_name} ${contact.last_name}` : "";
  };

  // The round's own name, with the programme's name stripped out of it —
  // "Growing Yourself Up — Fall 2026" under a heading that already says
  // Growing Yourself Up is noise, and the helper for that already exists.
  const labelByCohort = new Map(
    (cohorts ?? []).map((cohort) => [
      String(cohort.id),
      humanizeCohortName(cohort.name, offerName),
    ]),
  );
  const labelFor = (cohortId: Identifier | null | undefined) =>
    cohortId == null ? null : (labelByCohort.get(String(cohortId)) ?? null);

  // At most one Enrollment per Opportunity (enrollments_opportunity_id_key),
  // so a client cannot arrive twice through this join.
  const enrollmentByOpportunity = new Map(
    (enrollments ?? []).map((enrollment) => [
      String(enrollment.opportunity_id),
      enrollment,
    ]),
  );

  const clients: ProgrammeClient[] = [];
  const peopleDeciding: ProgrammeDecider[] = [];

  for (const deal of deals ?? []) {
    if (isPersonDeciding(deal)) {
      peopleDeciding.push({
        dealId: deal.id,
        contactId: deal.contact_id,
        name: nameFor(deal.contact_id),
        cohortLabel: labelFor(deal.cohort_id),
      });
      continue;
    }

    const enrollment = enrollmentByOpportunity.get(String(deal.id));
    const group = classifyCohortOpportunity({
      stage: deal.stage,
      outcome: deal.outcome,
      enrollment,
    });
    if (
      group === "enrolled" &&
      enrollment &&
      ACTIVE_ENROLLMENT_STATUSES.has(enrollment.status)
    ) {
      clients.push({
        enrollmentId: enrollment.id,
        dealId: deal.id,
        contactId: deal.contact_id,
        name: nameFor(deal.contact_id),
        status: enrollment.status,
        cohortLabel: labelFor(deal.cohort_id),
      });
    }
  }

  return {
    isPending: false,
    clients: clients.sort((a, b) => a.name.localeCompare(b.name)),
    peopleDeciding: peopleDeciding.sort((a, b) => a.name.localeCompare(b.name)),
    applications: applications.map((application) => ({
      applicationId: application.id,
      contactId: application.contact_id,
      name: nameFor(application.contact_id),
      status: application.status,
      submittedAt: application.submitted_at,
      cohortLabel: labelFor(application.intended_cohort_id),
    })),
  };
};
