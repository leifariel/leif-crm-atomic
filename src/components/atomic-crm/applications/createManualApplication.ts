import type { DataProvider, Identifier } from "ra-core";

import type { Application, Contact, Deal, Offer } from "../types";
import {
  ACTIVE_SALES_STAGES,
  isActiveOpportunity,
  type ActiveSalesStage,
} from "../deals/dealActivity";
import { syncWaitlistForActiveDeal } from "../waitlist/waitlistSync";

// An Application Leif entered herself — and the Opportunity that has to
// come with it.
//
// A current-funnel Application is not a standalone record. The pipeline's
// first stage IS "Application Received", and every review outcome writes
// to the Application AND its Opportunity together (reviewApplication.ts).
// An Application with no Opportunity therefore cannot be reviewed at all —
// so creating one without the other would produce a record that looks like
// work and cannot be worked.
//
// The canonical public-form path establishes exactly this pair inside one
// transaction: public.submit_public_application() resolves the Contact,
// reuses or creates a Deal at 'application_received', then writes the
// Application pointing at it. That function cannot be reused verbatim
// here — it identifies the applicant BY EMAIL (Leif picks a specific
// Contact, who may have no email yet), it is granted to service_role
// only, and it stamps source='public_form' / entry_path='application_form',
// both of which would be false. So this mirrors its invariant rather than
// its signature: same stage, same Deal shape, same reuse rule, same
// transaction.
//
// Two implementations, the same pattern as sales-calls/cancelSalesCall.ts:
// production runs ONE Postgres transaction (create_manual_application),
// and the mirror below is the step-by-step version FakeRest and the demo
// run. The entry point picks whichever the provider offers.

export type ManualApplicationInput = {
  contactId: Identifier;
  offerId: Identifier;
  cohortId?: Identifier | null;
};

// The last stage at which a pending Application review still makes sense.
//
// reviewApplication.ts's "approved" outcome WRITES stage = 'approved' onto
// the Opportunity. That is forward motion from interested or application_
// received, and a no-op at approved — but on a sale already at call_booked
// or decision it would drag the person BACKWARD through the pipeline on
// the strength of a review, which is the same mistake the cancelled-call
// path made and had retired: a stage is where the sale actually got to.
const LAST_REVIEWABLE_STAGE: ActiveSalesStage = "approved";

/**
 * Can a new pending Application be attached to a sale at this stage
 * without its eventual review moving the sale backwards?
 *
 * Ordering comes from ACTIVE_SALES_STAGES, never a second list. Anything
 * not in it fails closed — including the legacy 'onboarding' value, which
 * deal_is_active() still reports as active (fourteen rows renamed from
 * 'committed') but which is far past any review.
 */
export const acceptsApplicationReview = (stage: string): boolean => {
  const position = ACTIVE_SALES_STAGES.indexOf(stage as ActiveSalesStage);
  return (
    position !== -1 &&
    position <= ACTIVE_SALES_STAGES.indexOf(LAST_REVIEWABLE_STAGE)
  );
};

export type CreateManualApplicationResult =
  | {
      status: "created";
      applicationId: Identifier;
      opportunityId: Identifier;
      /** True when an existing active Opportunity was used rather than a new one. */
      reusedOpportunity: boolean;
    }
  // This person already has an application waiting on Leif for this
  // programme. Surfaced, never silently duplicated or merged: a second
  // pending Application against one live sale is two claims on the same
  // decision.
  | {
      status: "already-pending";
      applicationId: Identifier;
      opportunityId: Identifier;
    }
  // The sale is live and already past the point a review speaks to.
  // Refused rather than attached: creating a second Opportunity beside a
  // live one is wrong, and attaching to this one would set up a
  // stage regression the moment Leif decides. She is shown the sale
  // instead.
  | {
      status: "later-stage";
      opportunityId: Identifier;
      stage: string;
    }
  // A durable "no future direct sales" gate. The dialog blocks it too;
  // this is the backstop that holds when the dialog is not the caller.
  | { status: "do-not-engage" }
  | { status: "offer-invalid" }
  | { status: "cohort-invalid" };

type ManualApplicationCapableProvider = DataProvider & {
  createManualApplication?: (
    input: ManualApplicationInput,
  ) => Promise<Record<string, unknown>>;
};

/** Entry point: the transactional RPC where the provider offers one. */
export const createManualApplication = async (
  dataProvider: DataProvider,
  input: ManualApplicationInput,
): Promise<CreateManualApplicationResult> => {
  const rpc = (dataProvider as ManualApplicationCapableProvider)
    .createManualApplication;
  if (typeof rpc === "function") {
    const result = await rpc(input);
    return {
      status: result.status as CreateManualApplicationResult["status"],
      applicationId: result.application_id as Identifier,
      opportunityId: result.opportunity_id as Identifier,
      stage: result.stage as string,
      reusedOpportunity: Boolean(result.reused_opportunity),
    } as CreateManualApplicationResult;
  }
  return createManualApplicationMirror(dataProvider, input);
};

/**
 * The step-by-step implementation, exported so a provider that registers
 * itself as RPC-capable can point straight at it instead of dispatching
 * back into its own registration forever.
 */
export const createManualApplicationMirror = async (
  dataProvider: DataProvider,
  { contactId, offerId, cohortId = null }: ManualApplicationInput,
): Promise<CreateManualApplicationResult> => {
  const { data: offer } = await dataProvider
    .getOne<Offer>("offers", { id: offerId })
    .catch(() => ({ data: null as Offer | null }));
  if (!offer || offer.is_active === false) return { status: "offer-invalid" };

  // A cohort of a different programme is a record that contradicts itself.
  // The dialog scopes the choices; this refuses the pairing outright.
  if (cohortId != null) {
    const { data: cohort } = await dataProvider
      .getOne("cohorts", { id: cohortId })
      .catch(() => ({ data: null as { offer_id?: Identifier } | null }));
    if (!cohort || String(cohort.offer_id) !== String(offerId)) {
      return { status: "cohort-invalid" };
    }
  }

  const { data: contact } = await dataProvider
    .getOne<Contact>("contacts", { id: contactId })
    .catch(() => ({ data: null as Contact | null }));
  if (contact?.sales_eligibility === "do_not_engage") {
    return { status: "do-not-engage" };
  }

  const existingDeal = await findActiveOpportunity(dataProvider, {
    contactId,
    offerId,
    cohortId,
  });

  if (existingDeal) {
    if (!acceptsApplicationReview(existingDeal.stage)) {
      return {
        status: "later-stage",
        opportunityId: existingDeal.id,
        stage: existingDeal.stage,
      };
    }

    const pending = await findPendingApplication(dataProvider, existingDeal.id);
    if (pending) {
      return {
        status: "already-pending",
        applicationId: pending.id,
        opportunityId: existingDeal.id,
      };
    }
  }

  const deal =
    existingDeal ??
    (
      await dataProvider.create<Deal>("deals", {
        // The same shape submit_public_application() writes, with one
        // honest difference: entry_path. 'application_form' would claim
        // the public form produced this, so it stays 'other' — none of the
        // named paths, because Leif entered it directly.
        data: {
          contact_id: contactId,
          offer_id: offerId,
          cohort_id: cohortId,
          stage: "application_received",
          outcome: null,
          owner_decision: null,
          amount: offer.current_price,
          entry_path: "other",
          description: "",
        },
      })
    ).data;

  // Reusing writes nothing to "deals", so the provider's own afterCreate
  // waitlist sync never fires for that branch — the canonical function
  // does this same explicit sync for the same reason.
  if (existingDeal) {
    await syncWaitlistForActiveDeal(existingDeal, dataProvider);
  }

  const { data: application } = await dataProvider.create<Application>(
    "applications",
    {
      data: {
        contact_id: contactId,
        opportunity_id: deal.id,
        offer_id: offerId,
        intended_cohort_id: cohortId,
        source: "manual",
        status: "pending",
        reviewed_at: null,
        // No questionnaire was filled in, and the empty object says so.
        raw_answers: {},
        submitted_at: new Date().toISOString(),
      },
    },
  );

  return {
    status: "created",
    applicationId: application.id,
    opportunityId: deal.id,
    reusedOpportunity: existingDeal != null,
  };
};

// The same predicate and the same ordering the canonical function uses:
// one active sales attempt per person per Offer (per Cohort where there
// is one), oldest first.
const findActiveOpportunity = async (
  dataProvider: DataProvider,
  {
    contactId,
    offerId,
    cohortId,
  }: {
    contactId: Identifier;
    offerId: Identifier;
    cohortId: Identifier | null;
  },
): Promise<Deal | null> => {
  const { data: deals } = await dataProvider.getList<Deal>("deals", {
    filter: {
      contact_id: contactId,
      offer_id: offerId,
      ...(cohortId != null ? { cohort_id: cohortId } : {}),
    },
    pagination: { page: 1, perPage: 100 },
    sort: { field: "id", order: "ASC" },
  });
  return deals.find(isActiveOpportunity) ?? null;
};

const findPendingApplication = async (
  dataProvider: DataProvider,
  opportunityId: Identifier,
): Promise<Application | null> => {
  const { data: applications } = await dataProvider.getList<Application>(
    "applications",
    {
      filter: { opportunity_id: opportunityId },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "DESC" },
    },
  );
  return applications.find((a) => a.status === "pending") ?? null;
};
