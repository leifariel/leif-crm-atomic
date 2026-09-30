import type { Application, Cohort } from "../types";

// Whether an imported Application can be brought into the CRM, and why not.
//
// One rule, read by the Application page and pinned by tests, mirroring
// adopt_imported_application()'s own gates. The database is still the
// authority — this decides whether to OFFER the act, never whether it is
// allowed — but the two say the same thing, so the button is never present
// for something the transaction would refuse.
//
// Deliberately narrow. `historical_import` is on 161 production records and
// almost all of them are exactly what they look like: finished history. The
// ones that are not are the handful aimed at a round still taking
// applications, which is the same condition classifyApplication() uses to
// call them review work in the first place.

/** Statuses whose mapping to the current lifecycle is proven. */
export const ADOPTABLE_STATUSES = ["pending"] as const;

export type AdoptionBlock =
  | "not-imported"
  | "already-adopted"
  | "already-linked"
  | "status-unsupported"
  | "no-open-cohort";

export type AdoptionEligibility =
  | { canAdopt: true }
  | { canAdopt: false; reason: AdoptionBlock };

export const applicationAdoption = (
  application: Pick<
    Application,
    "source" | "status" | "crm_adopted_at" | "opportunity_id"
  > & { intended_cohort_id?: number | string | null },
  cohort: Pick<Cohort, "status"> | null | undefined,
): AdoptionEligibility => {
  // Provenance is the only thing adoption speaks about. A live submission is
  // current by construction.
  if (application.source !== "historical_import") {
    return { canAdopt: false, reason: "not-imported" };
  }
  if (application.crm_adopted_at != null) {
    return { canAdopt: false, reason: "already-adopted" };
  }
  // Nothing is blocked: it already has the Opportunity a decision needs.
  if (application.opportunity_id != null) {
    return { canAdopt: false, reason: "already-linked" };
  }
  if (!(ADOPTABLE_STATUSES as readonly string[]).includes(application.status)) {
    return { canAdopt: false, reason: "status-unsupported" };
  }
  if (cohort?.status !== "applications_open") {
    return { canAdopt: false, reason: "no-open-cohort" };
  }
  return { canAdopt: true };
};

/**
 * What the owner is told when the transaction refuses.
 *
 * Every one of these names a real thing to look at rather than a code. The
 * two that fire in production today — a live sales conversation already
 * running — both point at somebody Leif is mid-conversation with.
 */
export const ADOPTION_REFUSALS: Record<string, string> = {
  "later-stage":
    "There is already a sales conversation for this programme, further along than an application decision. Open the opportunity instead.",
  "other-active-sale":
    "There is already a live sales conversation with this person for this programme. Open that opportunity rather than starting a second one.",
  "ambiguous-opportunity":
    "This person has more than one live opportunity for this programme, so which one this application belongs to is not clear. Have a look before bringing them in.",
  "status-unsupported":
    "Only an application still waiting on a decision can be brought in.",
  "no-open-cohort":
    "This application is for a round that is no longer taking applications.",
  "not-imported": "This application is already part of the CRM.",
  "do-not-engage": "This person is marked do not engage.",
  "offer-invalid": "That programme is no longer active.",
  "contact-invalid": "That person could not be found.",
  "application-invalid": "That application could not be found.",
};

export const adoptionRefusalSentence = (status: string): string =>
  ADOPTION_REFUSALS[status] ??
  "That could not be done just now. Nothing was changed.";
