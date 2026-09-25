import { isActiveOpportunity } from "../deals/dealActivity";
import type { Application, Cohort, Deal } from "../types";

// Which bucket an Application belongs in, and why.
//
// The page used to answer this with `source`: public_form meant review
// work, everything else meant history. That put six January 2027
// applications Leif needs to read now into a Historical section, because
// of how the rows arrived rather than what they are.
//
// These are the facts that actually decide it:
//
//   reviewed_at   reviewApplication.ts writes it alongside the outcome,
//                 so it is the only evidence of a review made IN the CRM.
//                 It is null on all 164 production records, including the
//                 58 whose status says 'approved'. Those decisions were
//                 real — they were just made outside this system, and the
//                 moment is unknown; types.ts is explicit that "a decided
//                 status with no timestamp is valid history, never 'not
//                 reviewed'". So they are not relabelled as un-reviewed,
//                 and not promoted into a Reviewed list that would imply
//                 Leif worked through them here either.
//
//   cohort status an open cohort is live business. An application to a
//                 cohort still taking applications is work regardless of
//                 how it got here.
//
//   the Deal      only ever consulted for "is a sales process still
//                 running", never for which programme this is.
export type ApplicationBucket =
  | "needs-review"
  | "reviewed"
  | "pre-crm-active-sales"
  | "historical";

export type ClassifiableApplication = Pick<
  Application,
  "status" | "source" | "reviewed_at"
>;

/**
 * Is a sales process still running behind this Application?
 *
 * The rule itself is not restated here. dealActivity.ts found this written
 * out by hand about nine times in three subtly different shapes, all of
 * which happened to agree on that day's data — so the authority is
 * public.deal_is_active() and its one TypeScript mirror. This adds only
 * the question this page asks on top of it: is there a Deal at all.
 */
export const hasLiveSalesProcess = (
  deal: Pick<Deal, "stage" | "outcome" | "archived_at"> | null | undefined,
): boolean => deal != null && isActiveOpportunity(deal);

export const classifyApplication = (
  application: ClassifiableApplication,
  context: {
    cohort?: Pick<Cohort, "status"> | null;
    deal?: Pick<Deal, "stage" | "outcome" | "archived_at"> | null;
  } = {},
): ApplicationBucket => {
  // 1. A real decision was recorded here. Nothing else can outrank that.
  if (application.reviewed_at != null) return "reviewed";

  // 2. Still waiting on Leif, and genuinely current-funnel work.
  //
  //    Three ways in, and they are deliberately not the same clause:
  //
  //      public_form  somebody submitted the live application.
  //      manual       Leif entered it herself, which is as current as it
  //                   gets — she does not need a cohort to be open to
  //                   have just created something she means to decide on.
  //      the rescue   an IMPORTED record aimed at a cohort still taking
  //                   applications. This is the narrow case that frees
  //                   the six January 2027 records, and it is narrow on
  //                   purpose: without the open-cohort condition it would
  //                   sweep 99 old questionnaires into review work.
  if (application.status === "pending") {
    if (
      application.source === "public_form" ||
      application.source === "manual"
    ) {
      return "needs-review";
    }
    if (
      application.source === "historical_import" &&
      context.cohort?.status === "applications_open"
    ) {
      return "needs-review";
    }
  }

  // 3. An old-funnel questionnaire whose sales conversation is still
  //    going. Not review work — the old funnel had no review step, so no
  //    decision is owed — but not history either, because the person is
  //    still in play. Saying either would be untrue, so it says neither.
  if (
    application.source === "historical_import" &&
    hasLiveSalesProcess(context.deal)
  ) {
    return "pre-crm-active-sales";
  }

  // 4. Everything else: the old funnel, finished. The imported decisions
  //    live here — real history, kept as it was recorded, neither
  //    rewritten nor promoted into a list that implies a review Leif did
  //    not do in this system.
  return "historical";
};
