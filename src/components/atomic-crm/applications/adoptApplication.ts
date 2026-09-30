import type { DataProvider, Identifier } from "ra-core";

import type { Application, Cohort, Deal, Offer } from "../types";
import { isActiveOpportunity } from "../deals/dealActivity";

// Bringing an imported Application into current CRM operations.
//
// One call, one transaction, one answer. The lifecycle truth this establishes
// — the Opportunity a decision can be recorded against, and the record that
// the owner brought this person in — has to be established together or not at
// all, which is why it is a database authority rather than a sequence of
// browser writes that can stop halfway.
//
// It makes no Kit work and no provider call, and the database guarantees that
// structurally rather than by remembering to: the Kit receipt trigger fires
// only on INSERT and the decision trigger only on a status change, and
// adoption does neither.

export type AdoptionStatus =
  | "adopted"
  | "already-adopted"
  | "not-imported"
  | "status-unsupported"
  | "no-open-cohort"
  | "offer-invalid"
  | "contact-invalid"
  | "application-invalid"
  | "do-not-engage"
  | "later-stage"
  | "other-active-sale"
  | "already-pending"
  | "ambiguous-opportunity";

export type AdoptionResult = {
  status: AdoptionStatus | string;
  application_id?: Identifier;
  opportunity_id?: Identifier | null;
  created_opportunity?: boolean;
  reused_opportunity?: boolean;
  stage?: string;
  adopted_at?: string;
};

type AdoptionCapableProvider = DataProvider & {
  adoptImportedApplication?: (
    applicationId: Identifier,
  ) => Promise<AdoptionResult>;
};

export const adoptImportedApplication = async (
  dataProvider: DataProvider,
  applicationId: Identifier,
): Promise<AdoptionResult> => {
  const rpc = (dataProvider as AdoptionCapableProvider)
    .adoptImportedApplication;
  if (typeof rpc === "function") return await rpc(applicationId);
  return await adoptImportedApplicationMirror(dataProvider, applicationId);
};

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------
// A provider with no database function behind it reproduces the same decisions
// in the same order, so the demo and the tests exercise the real call site.
// It cannot reproduce the transaction or the advisory lock — nothing in a
// browser can — which is exactly why the production path is not this.
export const adoptImportedApplicationMirror = async (
  dataProvider: DataProvider,
  applicationId: Identifier,
): Promise<AdoptionResult> => {
  const { data: application } = await dataProvider.getOne<Application>(
    "applications",
    { id: applicationId },
  );
  if (!application) return { status: "application-invalid" };

  if (application.source !== "historical_import") {
    return { status: "not-imported" };
  }
  if (application.crm_adopted_at != null) {
    return {
      status: "already-adopted",
      application_id: application.id,
      opportunity_id: application.opportunity_id ?? null,
      adopted_at: application.crm_adopted_at,
    };
  }
  if (application.status !== "pending") {
    return { status: "status-unsupported" };
  }
  if (application.intended_cohort_id == null) {
    return { status: "no-open-cohort" };
  }

  const { data: cohort } = await dataProvider.getOne<Cohort>("cohorts", {
    id: application.intended_cohort_id,
  });
  if (cohort?.status !== "applications_open") {
    return { status: "no-open-cohort" };
  }

  const { data: offer } = await dataProvider.getOne<Offer>("offers", {
    id: application.offer_id as Identifier,
  });
  if (!offer?.is_active) return { status: "offer-invalid" };

  const adoptedAt = new Date().toISOString();

  if (application.opportunity_id != null) {
    await dataProvider.update("applications", {
      id: application.id,
      data: { crm_adopted_at: adoptedAt },
      previousData: application,
    });
    return {
      status: "adopted",
      application_id: application.id,
      opportunity_id: application.opportunity_id,
      created_opportunity: false,
      reused_opportunity: true,
    };
  }

  const { data: deals } = await dataProvider.getList<Deal>("deals", {
    filter: { contact_id: application.contact_id },
    pagination: { page: 1, perPage: 200 },
    sort: { field: "id", order: "ASC" },
  });
  const forOffer = (deals ?? []).filter(
    (deal) =>
      String(deal.offer_id) === String(application.offer_id) &&
      isActiveOpportunity(deal),
  );
  const atThisRound = forOffer.filter(
    (deal) =>
      String(deal.cohort_id ?? "") === String(application.intended_cohort_id),
  );

  if (atThisRound.length > 1) {
    return { status: "ambiguous-opportunity" };
  }

  let opportunityId: Identifier;
  let reused = false;

  if (atThisRound.length === 1) {
    const deal = atThisRound[0];
    // One Opportunity is one claim on one decision. Reusing one that already
    // carries a pending Application would let approving either move the shared
    // Opportunity, leaving the other pending against a decision already made.
    const { data: waiting } = await dataProvider.getList<Application>(
      "applications",
      {
        filter: { opportunity_id: deal.id, status: "pending" },
        pagination: { page: 1, perPage: 10 },
        sort: { field: "id", order: "DESC" },
      },
    );
    const other = (waiting ?? []).find(
      (one) => String(one.id) !== String(application.id),
    );
    if (other) {
      return {
        status: "already-pending",
        application_id: other.id,
        opportunity_id: deal.id,
      };
    }
    if (!REVIEWABLE_STAGES.includes(deal.stage)) {
      return {
        status: "later-stage",
        opportunity_id: deal.id,
        stage: deal.stage,
      };
    }
    opportunityId = deal.id;
    reused = true;
  } else {
    const other = forOffer[0];
    if (other) {
      return {
        status: "other-active-sale",
        opportunity_id: other.id,
        stage: other.stage,
      };
    }
    const { data: created } = await dataProvider.create<Deal>("deals", {
      data: {
        contact_id: application.contact_id,
        offer_id: application.offer_id,
        cohort_id: application.intended_cohort_id,
        stage: "application_received",
        amount: offer.current_price,
        entry_path: "other",
        description: "",
      } as Partial<Deal>,
    });
    opportunityId = created.id;
  }

  await dataProvider.update("applications", {
    id: application.id,
    data: { opportunity_id: opportunityId, crm_adopted_at: adoptedAt },
    previousData: application,
  });

  return {
    status: "adopted",
    application_id: application.id,
    opportunity_id: opportunityId,
    created_opportunity: !reused,
    reused_opportunity: reused,
  };
};

// The stages a review still speaks to. Past these, approving would drag a
// live sale backward, so adoption refuses rather than setting that up — the
// same list and the same reasoning create_manual_application() uses.
const REVIEWABLE_STAGES: string[] = [
  "interested",
  "application_received",
  "approved",
];
