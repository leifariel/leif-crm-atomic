import type { Offer } from "../types";
import type { ApplicationSection } from "./useApplicationsGrouped";

export type ApplicationProgramme = {
  /** `offer:<id>` — stable across renders. */
  key: string;
  offer: Offer;
  /**
   * The programme's sections, in the order useApplicationsGrouped already
   * put them. For The Living Example that is a single cohortless section;
   * for Growing Yourself Up it is one per cohort, plus at most one
   * cohortless section for applications that never recorded one.
   */
  sections: ApplicationSection[];
  /** Applications across every section of this programme. */
  total: number;
  needsReview: number;
};

/**
 * One programme, one container.
 *
 * A cohort is not a programme. The page used to render one flat section per
 * cohort-or-offer, so Growing Yourself Up's cohorts became peer titles
 * sitting alongside The Living Example — three programmes on screen where
 * there are two, and the sort could interleave them.
 *
 * This groups those sections under their Offer WITHOUT re-sorting anything.
 * Programme order is first-appearance order in the already-sorted list, so
 * the priority useApplicationsGrouped established — a section with review
 * work outranks one without, then open cohorts, then the rolling 1:1, then
 * newest cohort — still decides both which programme comes first and the
 * order of cohorts inside it. Nothing here re-ranks, reclassifies or
 * recounts; it only nests.
 */
export const groupSectionsByProgramme = (
  sections: ApplicationSection[],
): ApplicationProgramme[] => {
  const byOffer = new Map<string, ApplicationProgramme>();

  for (const section of sections) {
    const key = `offer:${section.offer.id}`;
    const programme = byOffer.get(key) ?? {
      key,
      offer: section.offer,
      sections: [],
      total: 0,
      needsReview: 0,
    };
    programme.sections.push(section);
    programme.total += section.total;
    programme.needsReview += section.buckets["needs-review"].length;
    byOffer.set(key, programme);
  }

  // Map preserves insertion order, which is first-appearance order in the
  // sorted input — deliberately, see above.
  return [...byOffer.values()];
};
