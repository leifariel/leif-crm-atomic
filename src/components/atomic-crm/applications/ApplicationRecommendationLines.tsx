import { useGetOne, useTranslate } from "ra-core";

import type { Application, Cohort, Offer } from "../types";

// What they applied for, and what was decided — side by side, because they
// are two different programmes and the page has to say so.
//
// Leif's requirement, in his own shape:
//
//     Applied for:  The Living Example
//     Decision:     Offer Growing Yourself Up
//
// Rendered only for an application that carries a recommendation. Every other
// decision leaves one programme in play, the heading already names it, and
// printing "Applied for" under a decision that did not move anybody would be
// answering a question nobody asked.
//
// The applied-for line deliberately repeats the programme (and its round)
// from the page heading. That repetition is the whole point: the Opportunity
// now says Growing Yourself Up, and without the original beside the decision
// the page would read as though the application itself had changed programme.
export const ApplicationRecommendationLines = ({
  application,
  offer,
  cohort,
}: {
  application: Application;
  /** The programme the application itself records. Never rewritten. */
  offer: Pick<Offer, "name">;
  cohort?: Pick<Cohort, "name"> | null;
}) => {
  const translate = useTranslate();
  const recommendedId = application.recommended_offer_id;
  const { data: recommended } = useGetOne<Offer>(
    "offers",
    { id: recommendedId! },
    { enabled: recommendedId != null, retry: false },
  );

  if (application.status !== "offered_other_programme") return null;

  const appliedFor = [offer.name, cohort?.name].filter(Boolean).join(" · ");

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">
        {translate("resources.applications.review.applied_for", {
          _: "Applied for",
        })}
      </dt>
      <dd>{appliedFor}</dd>
      <dt className="text-muted-foreground">
        {translate("resources.applications.review.decision", {
          _: "Decision",
        })}
      </dt>
      <dd>
        {recommended
          ? translate("resources.applications.review.offered_programme", {
              _: "Offer %{programme}",
              programme: recommended.name,
            })
          : // The recommendation is recorded; only its name has not arrived
            // yet. Saying "Offer —" would read as though no programme was
            // chosen, which is the one thing this block exists to prevent.
            translate("resources.applications.review.offered_programme_other", {
              _: "Offer the other programme",
            })}
      </dd>
    </dl>
  );
};
