import { useEffect } from "react";
import { useTranslate } from "ra-core";
import { useLocation, useParams } from "react-router";
import { OpeningsLine } from "../capacity/OpeningsLine";
import { PageHeader, PersonCard, Section } from "../misc/ProgramLayout";
import { PreviewList } from "../misc/PreviewList";
import { ProgramCardMenu } from "./ProgramCardMenu";
import { findDealLabel } from "../deals/dealUtils";
import { CopyApplicationLinkButton } from "../public-application/CopyApplicationLinkButton";
import { LivingExampleApplicationPage } from "../public-application/LivingExampleApplicationPage";
import { AddToWaitlistButton } from "../waitlist/AddToWaitlistButton";
import { WaitlistSection } from "../waitlist/WaitlistSection";
import { useWaitlistEntries } from "../waitlist/useWaitlistEntries";
import { SlotPersonCard } from "./SlotPersonCard";
import { StartingLaterSection } from "./StartingLaterSection";
import { UpcomingOpeningsSection } from "./UpcomingOpeningsSection";
import { useIndividualProgramData } from "./useIndividualProgramData";
import { useConfigurationContext } from "../root/ConfigurationContext";

// The Living Example (or any future 1:1 Offer's) program page — a real
// user-facing page over the existing Offer + Enrollment data, not a new
// "Program" table.
export const IndividualProgramPage = () => {
  const { offerId } = useParams();
  const location = useLocation();
  const translate = useTranslate();
  const {
    isPending,
    offer,
    capacity,
    ifAllRescheduled,
    futureOpenings,
    lastSyncedAt,
    peopleDeciding,
  } = useIndividualProgramData(offerId);
  const { dealStages } = useConfigurationContext();
  const { isPending: waitlistPending, entries: waitlist } = useWaitlistEntries({
    offerId,
    cohortId: null,
  });

  // The Dashboard's "Next opening" link (LivingExampleCapacityCard.tsx)
  // points at this page's #upcoming-openings anchor. HashRouter's own `#`
  // means the browser never fires its native fragment-scroll for a
  // client-side route change, so it's done by hand once the content (and
  // the target element) actually exists.
  useEffect(() => {
    if (isPending || !location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    target?.scrollIntoView({ block: "start" });
  }, [isPending, location.hash]);

  if (isPending || waitlistPending) return null;
  if (!offer) {
    return (
      <div className="p-4">
        <p className="text-sm text-muted-foreground">
          {translate("crm.programs.individual_not_found", {
            _: "This program could not be found.",
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 mt-1 p-1 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title={offer.name}
          summary={
            <>
              {capacity?.active}
              {capacity?.max != null && <span> / {capacity.max}</span>}{" "}
              {translate("crm.dashboard.capacity_active", { _: "active" })}
              {capacity != null && capacity.overCapacityBy > 0 && (
                <span className="text-destructive">
                  {" · "}
                  {translate("crm.dashboard.capacity_over", {
                    _: "%{count} over capacity",
                    count: capacity.overCapacityBy,
                  })}
                </span>
              )}
              {capacity?.overCapacityBy === 0 && capacity.openings != null && (
                <span>
                  {" · "}
                  {/* The third place this rendered "[object Object]
                      openings". Openings became a ledger ANSWER and three
                      separate call sites went on interpolating the object
                      into a count; two were found by a test and this one
                      by reading the page. OpeningsLine is the only thing
                      that renders the answer now. */}
                  <OpeningsLine openings={capacity.openings} inline />
                </span>
              )}
              {capacity != null && capacity.committed.length > 0 && (
                <span>
                  {" · "}
                  {translate("crm.dashboard.capacity_committed", {
                    _: "%{count} starting later",
                    count: capacity.committed.length,
                  })}
                </span>
              )}
              {waitlist.length > 0 && (
                <span>
                  {" · "}
                  {translate("resources.waitlist_entries.count", {
                    _: "%{count} waiting",
                    count: waitlist.length,
                  })}
                </span>
              )}
              {capacity != null && capacity.unscheduled.length > 0 && (
                <span>
                  {" · "}
                  {translate("crm.programs.needing_a_start_week", {
                    _: "%{count} needs a start week |||| %{count} need a start week",
                    smart_count: capacity.unscheduled.length,
                    count: capacity.unscheduled.length,
                  })}
                </span>
              )}
              {capacity != null && capacity.unconfirmedStartWeek.length > 0 && (
                <span>
                  {" · "}
                  {translate("crm.programs.start_weeks_to_confirm", {
                    _: "%{count} start weeks to confirm",
                    count: capacity.unconfirmedStartWeek.length,
                  })}
                </span>
              )}
            </>
          }
        />
        {/* The programme's own header actions. Leif manages a programme from
            THIS page, so configuring it has to be here — the Programs hub's
            card menu was not somewhere she goes, and the Offers list is
            described in its own code as low-prominence administrative UI.
            One menu, beside the link she already uses. */}
        <div
          className="flex items-center gap-2"
          data-testid="programme-header-actions"
        >
          <CopyApplicationLinkButton
            path={LivingExampleApplicationPage.path}
            label={offer.name}
          />
          <ProgramCardMenu
            resource="offers"
            id={offer.id}
            name={offer.name}
            // The Offer's existing edit form, which is where the Kit
            // automation box lives. Never a second settings form.
            editPath={`/offers/${offer.id}`}
            archive={{ is_active: false }}
            archived={offer.is_active === false}
          />
        </div>
      </div>

      <Section
        title={translate("crm.programs.current_clients", {
          _: "Current Clients",
        })}
        count={capacity?.occupied.length ?? 0}
      >
        {capacity == null || capacity.occupied.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {translate("crm.programs.no_current_clients", {
              _: "No current clients.",
            })}
          </p>
        ) : (
          <PreviewList
            storeKey={`offer.${offer.id}.current-clients`}
            items={capacity.occupied}
            renderRows={(visible) => (
              <div className="flex flex-col gap-2">
                {visible.map((client) => (
                  <SlotPersonCard key={client.enrollmentId} client={client} />
                ))}
              </div>
            )}
          />
        )}
      </Section>

      {/* Agreed and set up, not started — with or without a week yet.
          Kept separate from Current Clients for the same reason the header
          no longer adds them together: an obligation is not an occupancy. */}
      {capacity != null && (
        <StartingLaterSection
          offerId={offer.id}
          committed={capacity.committed}
          unscheduled={capacity.unscheduled}
        />
      )}

      {futureOpenings != null && capacity != null && (
        <UpcomingOpeningsSection
          offerId={offer.id}
          capacity={capacity}
          ifAllRescheduled={ifAllRescheduled}
          futureOpenings={futureOpenings}
          lastSyncedAt={lastSyncedAt}
        />
      )}

      {/* Who is actually deciding — the Pipeline's Decision column, scoped
          to this programme. Below the openings because it is a sales
          question rather than a capacity one, and above the Waitlist
          because a person deciding is further along than a person
          waiting. */}
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
            storeKey={`offer.${offer.id}.deciding`}
            items={peopleDeciding}
            renderRows={(visible) => (
              <div className="flex flex-col gap-2">
                {visible.map((person) => (
                  <PersonCard
                    key={person.dealId}
                    contactId={person.contactId}
                    name={person.name}
                    meta={findDealLabel(dealStages, person.stage)}
                  />
                ))}
              </div>
            )}
          />
        )}
      </Section>

      <WaitlistSection
        entries={waitlist}
        offerId={offer.id}
        offerName={offer.name}
        cohortId={null}
        // The waitlist is where Leif adds the person who just messaged him
        // on Instagram, so the control belongs at the waitlist, not only
        // in the page header three sections up.
        action={<AddToWaitlistButton offerId={offer.id} cohortId={null} />}
        // Availability, stated beside the people waiting for it, because
        // the two questions are always asked together. It reports and
        // never acts: nobody is invited, moved, or emailed from here.
        availability={availabilityLine(capacity, translate)}
      />
    </div>
  );
};

// One short sentence about whether there is room, for the top of the
// waitlist. Deliberately a fact and nothing more — see Part I: who gets an
// opening is Leif's decision, and this line never makes it.
const availabilityLine = (
  capacity: ReturnType<typeof useIndividualProgramData>["capacity"],
  translate: ReturnType<typeof useTranslate>,
): string | null => {
  if (capacity == null || capacity.max == null) return null;
  if (capacity.overCapacityBy > 0) {
    return translate("crm.programs.waitlist_over_capacity", {
      _: "%{active} of %{max} slots filled — %{over} over capacity.",
      active: capacity.active,
      max: capacity.max,
      over: capacity.overCapacityBy,
    });
  }
  if (capacity.openings?.status === "unknown") {
    // Full or not, nobody can be started until the calendar reaches far
    // enough to hold their twelve session weeks. Saying "Full" here would
    // be the wrong reason for the right answer.
    return translate("crm.programs.waitlist_needs_calendar", {
      _: "%{active} of %{max} filled — availability unknown until Year Tracking covers %{required} session weeks (%{scheduled} so far).",
      active: capacity.active,
      max: capacity.max,
      scheduled: capacity.openings.weeksScheduled,
      required: capacity.openings.weeksRequired,
    });
  }
  if (capacity.openings != null && capacity.openings.openings > 0) {
    return translate("crm.programs.waitlist_openings_now", {
      _: "%{count} opening now (%{active} of %{max} filled).",
      count: capacity.openings.openings,
      active: capacity.active,
      max: capacity.max,
    });
  }
  return translate("crm.programs.waitlist_full", {
    _: "Full — %{active} of %{max} slots filled.",
    active: capacity.active,
    max: capacity.max,
  });
};

IndividualProgramPage.path = "/programs/individual/:offerId";
