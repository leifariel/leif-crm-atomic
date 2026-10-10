import { useGetList, useGetMany, type Identifier } from "ra-core";

import type { Application, Contact, Deal, Enrollment } from "../types";
import { NON_APPROVED_TERMINAL_APPLICATION_STATUSES } from "../applications/applicationConstants";
import { isPersonDeciding } from "../deals/peopleDeciding";
import { classifyCohortOpportunity } from "./cohortCapacity";

const ACTIVE_ENROLLMENT_STATUSES: ReadonlySet<Enrollment["status"]> = new Set([
  "onboarding",
  "active",
  "offboarding",
]);

export type CohortEnrolledClient = {
  dealId: Identifier;
  // The canonical client profile. Never inferred: a row only exists below
  // when its Enrollment has already been found, and the database holds
  // `enrollments_opportunity_id_key unique (opportunity_id)` — at most one
  // Enrollment per Opportunity — so there is exactly one and no ambiguity
  // to guess at. It is the same Enrollment this row's status comes from.
  enrollmentId: Identifier;
  contactId: Identifier;
  name: string;
  status: Enrollment["status"];
};

export type CohortDecidingPerson = {
  dealId: Identifier;
  contactId: Identifier;
  name: string;
  stage: string;
};

export type CohortApplicationRow = {
  applicationId: Identifier;
  // Null when the applicant never became a sales Opportunity — the Deal is
  // the optional relationship, so this row does not require one.
  dealId: Identifier | null;
  contactId: Identifier;
  name: string;
  status: Application["status"];
  submittedAt: string;
};

// Backs the Cohort detail page's "Enrolled Clients" / "People Deciding" /
// "Applications" sections: real Deal/Enrollment/Application/Contact data
// grouped by meaning, reusing the existing tested authorities rather than
// reinterpreting them.
//
// TWO DIFFERENT QUESTIONS, TWO DIFFERENT AUTHORITIES, and conflating them
// was a real bug Leif found in production:
//
//   who occupies a seat          classifyCohortOpportunity -> "enrolled"
//   who is DECIDING              deals/peopleDeciding.ts -> isPersonDeciding
//
// "People Deciding" used to be classifyCohortOpportunity's "in_sales"
// bucket, which is every live Opportunity that is not yet Won — Interested,
// Application Received, Approved and Call Booked included. So an applicant
// whose application Leif had just APPROVED appeared under "People Deciding"
// on the round's page, while the Pipeline and the Dashboard both said they
// were at Approved and not deciding anything yet.
//
// There is exactly one definition of Decision in this app and it already
// existed: isPersonDeciding — a live Opportunity at the Decision stage.
// The Pipeline's Decision column and the Dashboard's People Deciding both
// use it, after the same two-definitions bug was fixed between THEM. This
// page is now the third caller rather than a third definition.
//
// classifyCohortOpportunity keeps its job: it answers capacity ("is this
// Opportunity still being sold for this round"), which genuinely does
// include everyone pre-Won, and useCohortCapacity still asks it.
export const useCohortPageData = (cohortId?: Identifier) => {
  const { data: deals, isPending: dealsPending } = useGetList<Deal>(
    "deals",
    {
      filter: { cohort_id: cohortId },
      pagination: { page: 1, perPage: 1000 },
      sort: { field: "id", order: "ASC" },
    },
    { enabled: cohortId != null },
  );

  const dealIds = deals?.map((deal) => deal.id) ?? [];
  const opportunityIdList = `(${dealIds.join(",")})`;

  const { data: enrollments, isPending: enrollmentsPending } =
    useGetList<Enrollment>(
      "enrollments",
      {
        filter: { "opportunity_id@in": opportunityIdList },
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "id", order: "ASC" },
      },
      { enabled: !dealsPending },
    );

  // "Applications for this Cohort" has two sources, and both are real:
  //   - intended_cohort_id — the canonical statement of what the applicant
  //     applied FOR. It does not require a Deal, so this is the only way a
  //     legitimate applicant who never entered the pipeline appears here.
  //   - the Cohort's own Deals — legacy rows predating intended_cohort_id
  //     carry no intent value and would otherwise vanish from this page.
  // Queried separately and merged by id rather than choosing one and
  // silently dropping the other population.
  const { data: intendedApplications, isPending: intendedPending } =
    useGetList<Application>(
      "applications",
      {
        filter: { intended_cohort_id: cohortId },
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "submitted_at", order: "DESC" },
      },
      { enabled: cohortId != null },
    );

  const { data: dealApplications, isPending: dealApplicationsPending } =
    useGetList<Application>(
      "applications",
      {
        filter: { "opportunity_id@in": opportunityIdList },
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "submitted_at", order: "DESC" },
      },
      { enabled: !dealsPending },
    );

  const applicationsPending = intendedPending || dealApplicationsPending;
  const applications = [
    ...new Map(
      [...(intendedApplications ?? []), ...(dealApplications ?? [])].map(
        (application) => [String(application.id), application],
      ),
    ).values(),
  ].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

  // Contacts must cover applicants who have no Deal, or their rows would
  // render with an empty name.
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
    dealsPending ||
    enrollmentsPending ||
    applicationsPending ||
    (contactIds.length > 0 && contactsPending);

  if (isPending || !deals) {
    return {
      isPending: true,
      enrolledClients: [] as CohortEnrolledClient[],
      peopleDeciding: [] as CohortDecidingPerson[],
      applications: [] as CohortApplicationRow[],
    };
  }

  const contactById = new Map(
    (contacts ?? []).map((contact) => [String(contact.id), contact]),
  );
  const nameForContact = (contactId: Identifier) => {
    const contact = contactById.get(String(contactId));
    return contact ? `${contact.first_name} ${contact.last_name}` : "";
  };

  const enrollmentByOpportunity = new Map(
    (enrollments ?? []).map((enrollment) => [
      String(enrollment.opportunity_id),
      enrollment,
    ]),
  );
  // "rejected" no longer exists as a single status (Native Applications
  // slice, §1: outcomes are distinct) — any of the three non-approved
  // terminal review outcomes means this person isn't moving toward a
  // purchase anymore. Deal.outcome already carries this once reviewApplication
  // runs, but this stays as a defensive fallback for classifyCohortOpportunity
  // (see its own doc comment).
  const rejectedApplicationOpportunityIds = new Set(
    (applications ?? [])
      .filter((application) =>
        NON_APPROVED_TERMINAL_APPLICATION_STATUSES.has(application.status),
      )
      .map((application) => String(application.opportunity_id)),
  );

  const enrolledClients: CohortEnrolledClient[] = [];
  const peopleDeciding: CohortDecidingPerson[] = [];

  for (const deal of deals) {
    const enrollment = enrollmentByOpportunity.get(String(deal.id));
    // Decision is the sales pipeline's answer, never the application's.
    // An approved application stays in Applications, with its truthful
    // status, until the Opportunity itself reaches Decision.
    if (isPersonDeciding(deal)) {
      peopleDeciding.push({
        dealId: deal.id,
        contactId: deal.contact_id,
        name: nameForContact(deal.contact_id),
        stage: deal.stage,
      });
      continue;
    }

    const group = classifyCohortOpportunity({
      stage: deal.stage,
      outcome: deal.outcome,
      enrollment,
      hasRejectedApplication: rejectedApplicationOpportunityIds.has(
        String(deal.id),
      ),
    });

    if (
      group === "enrolled" &&
      enrollment &&
      ACTIVE_ENROLLMENT_STATUSES.has(enrollment.status)
    ) {
      enrolledClients.push({
        dealId: deal.id,
        enrollmentId: enrollment.id,
        contactId: deal.contact_id,
        name: nameForContact(deal.contact_id),
        status: enrollment.status,
      });
    }
  }

  const applicationRows: CohortApplicationRow[] = (applications ?? []).map(
    (application) => {
      // The person comes from the Application's own canonical contact_id,
      // not from the Deal — an applicant with no Opportunity still has a
      // name to show here rather than rendering as an empty row.
      return {
        applicationId: application.id,
        dealId: application.opportunity_id ?? null,
        contactId: application.contact_id,
        name: nameForContact(application.contact_id),
        status: application.status,
        submittedAt: application.submitted_at,
      };
    },
  );

  return {
    isPending: false,
    enrolledClients: enrolledClients.sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    peopleDeciding: peopleDeciding.sort((a, b) => a.name.localeCompare(b.name)),
    applications: applicationRows,
  };
};
