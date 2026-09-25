import { useGetOne } from "ra-core";

import type { Application, Cohort, Contact, Deal, Offer } from "../types";

// Backs the Application review page (Native Applications slice, §2/§3):
// who applied, for what, and — when there is one — the Opportunity behind
// it, so the page can read "Rosalind Park — The Living Example · Submitted
// Aug 31, 2026 · Pending" instead of a raw "Application #4".
//
// Person and programme come from the APPLICATION's own columns. They used
// to be read through opportunity_id -> Deal -> contact/offer/cohort, which
// meant an Application with no Opportunity resolved to nothing and its
// page rendered blank: 78 imported production records, and now every
// record Leif enters by hand, since creating one starts no sales process.
// The Deal is still loaded where it exists — Related Sales and the review
// actions both genuinely need it — it is simply no longer the only way to
// find out who this is.
export const useApplicationReviewData = (application?: Application) => {
  const { data: deal, isPending: dealPending } = useGetOne<Deal>(
    "deals",
    { id: application?.opportunity_id as Deal["id"] },
    { enabled: application?.opportunity_id != null },
  );

  const contactId = application?.contact_id ?? deal?.contact_id;
  const { data: contact, isPending: contactPending } = useGetOne<Contact>(
    "contacts",
    { id: contactId as Contact["id"] },
    { enabled: contactId != null },
  );

  const offerId = application?.offer_id ?? deal?.offer_id;
  const { data: offer, isPending: offerPending } = useGetOne<Offer>(
    "offers",
    { id: offerId as Offer["id"] },
    { enabled: offerId != null },
  );

  const cohortId = application?.intended_cohort_id ?? deal?.cohort_id;
  const { data: cohort, isPending: cohortPending } = useGetOne<Cohort>(
    "cohorts",
    { id: cohortId as Cohort["id"] },
    { enabled: cohortId != null },
  );

  const hasDeal = application?.opportunity_id != null;
  const isPending =
    application == null ||
    (hasDeal && dealPending) ||
    (contactId != null && contactPending) ||
    (offerId != null && offerPending) ||
    (cohortId != null && cohortPending);

  return {
    isPending,
    // Absent rather than pending: a manual Application has no sales
    // process behind it, and the page says so rather than waiting for one.
    deal: isPending || !hasDeal ? undefined : deal,
    contact: isPending ? undefined : contact,
    offer: isPending ? undefined : offer,
    cohort: isPending || cohortId == null ? undefined : cohort,
  };
};
