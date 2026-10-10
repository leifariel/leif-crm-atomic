import { useParams } from "react-router";
import { useTranslate } from "ra-core";
import { Badge } from "@/components/ui/badge";

import { CohortCapacityCard } from "../dashboard/CohortCapacityCard";
import { applicationStatusBadgeVariant } from "../applications/applicationConstants";
import { applicationStatusLabels } from "../applications/applicationConstants";
import { enrollmentStatusLabels } from "../enrollments/enrollmentConstants";
import { formatISODateString } from "../deals/dealUtils";
import { humanizeCohortName } from "../cohorts/humanizeCohortName";
import { PageHeader, PersonCard, Section } from "../misc/ProgramLayout";
import { PreviewList } from "../misc/PreviewList";
import { ProgramCardMenu } from "./ProgramCardMenu";
import { AddToWaitlistButton } from "../waitlist/AddToWaitlistButton";
import { WaitlistSection } from "../waitlist/WaitlistSection";
import { useWaitlistEntries } from "../waitlist/useWaitlistEntries";
import { useGroupProgramData } from "./useGroupProgramData";
import { useGroupProgrammePeople } from "./useGroupProgrammePeople";

// A group programme's own page — Growing Yourself Up's counterpart to the
// Living Example's.
//
// It began as a home for the programme's general waitlist and a list of
// its rounds, which left the programme itself unanswerable: "who is in
// Growing Yourself Up", "who is deciding about it", "who has applied" are
// questions about the PROGRAMME, and every one of them had to be asked of
// each round in turn. It now reads like a round's page, one scope up:
// clients, who is deciding, the applications behind them, who is waiting —
// and then the rounds, which are navigation rather than an operational
// list.
//
// Programme-WIDE, never one round's data borrowed. See
// useGroupProgrammePeople.ts for the authorities and the scope guards.
export const GroupProgramPage = () => {
  const { offerId } = useParams();
  const translate = useTranslate();
  const { isPending, offer, cohorts } = useGroupProgramData(offerId);
  const {
    isPending: peoplePending,
    clients,
    peopleDeciding,
    applications,
  } = useGroupProgrammePeople(offerId, offer?.name ?? "");
  // Everyone waiting for this programme, whether they named a round or
  // not — the question this page asks. A round's page keeps asking its
  // own narrower one.
  const { isPending: waitlistPending, entries: waiting } = useWaitlistEntries({
    offerId,
    cohortId: null,
    acrossCohorts: true,
  });

  if (isPending || peoplePending || waitlistPending) return null;
  if (!offer) {
    return (
      <div className="p-4">
        <p className="text-sm text-muted-foreground">
          {translate("crm.programs.group_not_found", {
            _: "This program could not be found.",
          })}
        </p>
      </div>
    );
  }

  // The rounds are fetched for the navigation section below; labelling a
  // person's round is the people hook's job, and it reads every round
  // including completed ones.
  const labelFor = (cohortId: string | number | null) => {
    if (cohortId == null) return null;
    const cohort = cohorts.find(
      (candidate) => String(candidate.id) === String(cohortId),
    );
    return cohort ? humanizeCohortName(cohort.name, offer.name) : null;
  };

  const nobodyYet = translate("resources.cohorts.people.empty", {
    _: "Nobody yet.",
  });

  return (
    <div className="flex flex-col gap-8 mt-1 p-1 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <PageHeader title={offer.name} summary={offer.duration} />
        {/* The same one menu the 1:1 programme's page carries. A round has
            its own below; this one is the PROGRAMME's, and it is the only
            route to the Kit automation its decisions need. */}
        <div
          className="flex items-center gap-2"
          data-testid="programme-header-actions"
        >
          <ProgramCardMenu
            resource="offers"
            id={offer.id}
            name={offer.name}
            editPath={`/offers/${offer.id}`}
            archive={{ is_active: false }}
            archived={offer.is_active === false}
          />
        </div>
      </div>

      <Section
        title={translate("crm.programs.programme_clients", { _: "Clients" })}
        count={clients.length}
      >
        {clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">{nobodyYet}</p>
        ) : (
          <PreviewList
            storeKey={`offer.${offer.id}.programme-clients`}
            items={clients}
            renderRows={(visible) => (
              <div className="flex flex-col gap-2">
                {visible.map((client) => (
                  <PersonCard
                    key={client.enrollmentId}
                    contactId={client.contactId}
                    // The client's own record, the destination every other
                    // client list in the CRM uses.
                    rowLinkTo={`/enrollments/${client.enrollmentId}/show`}
                    name={client.name}
                    meta={client.cohortLabel}
                    trailing={
                      <Badge variant="outline" className="pointer-events-none">
                        {enrollmentStatusLabels[client.status]}
                      </Badge>
                    }
                  />
                ))}
              </div>
            )}
          />
        )}
      </Section>

      <Section
        title={translate("crm.dashboard.people_deciding_title", {
          _: "People Deciding",
        })}
        count={peopleDeciding.length}
      >
        {peopleDeciding.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {translate("crm.dashboard.people_deciding_empty", {
              _: "Nobody is currently deciding.",
            })}
          </p>
        ) : (
          <PreviewList
            storeKey={`offer.${offer.id}.programme-deciding`}
            items={peopleDeciding}
            renderRows={(visible) => (
              <div className="flex flex-col gap-2">
                {visible.map((person) => (
                  <PersonCard
                    key={person.dealId}
                    contactId={person.contactId}
                    name={person.name}
                    meta={person.cohortLabel}
                  />
                ))}
              </div>
            )}
          />
        )}
      </Section>

      <Section
        title={translate("resources.applications.name", { smart_count: 2 })}
        count={applications.length}
      >
        {applications.length === 0 ? (
          <p className="text-sm text-muted-foreground">{nobodyYet}</p>
        ) : (
          <PreviewList
            storeKey={`offer.${offer.id}.programme-applications`}
            items={applications}
            renderRows={(visible) => (
              <div className="flex flex-col gap-2">
                {visible.map((application) => (
                  <PersonCard
                    key={application.applicationId}
                    contactId={application.contactId}
                    to={`/applications/${application.applicationId}/show`}
                    name={application.name}
                    meta={[
                      application.cohortLabel,
                      formatISODateString(
                        application.submittedAt.split("T")[0]!,
                      ),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    trailing={
                      <Badge
                        variant={
                          applicationStatusBadgeVariant[application.status]
                        }
                      >
                        {applicationStatusLabels[application.status]}
                      </Badge>
                    }
                  />
                ))}
              </div>
            )}
          />
        )}
      </Section>

      <WaitlistSection
        entries={waiting}
        offerId={offer.id}
        offerName={offer.name}
        cohortId={null}
        cohortLabelFor={labelFor}
        action={<AddToWaitlistButton offerId={offer.id} cohortId={null} />}
      />

      {/* Navigation, not an operational list: the four sections above
          answer the programme, and this is how Leif reaches one round. */}
      <Section
        title={translate("crm.programs.cohorts_section", { _: "Cohorts" })}
        count={cohorts.length}
      >
        {cohorts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {translate("crm.programs.no_active_cohorts", {
              _: "No active cohorts.",
            })}
          </p>
        ) : (
          // A round's card is taller than a person's row, so a programme
          // with years of history behind it pushes everything below it off
          // the page. Same disclosure, same limit, counted in the heading.
          <PreviewList
            storeKey={`offer.${offer.id}.cohorts`}
            items={cohorts}
            renderRows={(visible) => (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
                {visible.map((cohort) => (
                  <CohortCapacityCard cohort={cohort} key={cohort.id} />
                ))}
              </div>
            )}
          />
        )}
      </Section>
    </div>
  );
};

GroupProgramPage.path = "/programs/group/:offerId";
