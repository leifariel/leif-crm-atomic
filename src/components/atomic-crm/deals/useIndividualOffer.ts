import { useGetList } from "ra-core";

import type { Deal, Offer } from "../types";

// The Opportunity's programme, but only when it is an individual one.
//
// A group round carries a start Leif published when he created the Cohort, so
// accepting that sale has nothing left to ask: handle_deal_saved() copies
// program_start_at onto the Enrollment as an owner-stated Start Week. An
// individual programme has no such date, which is why The Living Example is
// the case where a sale can be accepted and the start week left unsaid.
//
// retry: false, like every other control that renders beside a record: this
// must degrade to asking nothing rather than hanging the drawer it sits in.
export const useIndividualOffer = (deal: Deal): Offer | null => {
  const { data: offers } = useGetList<Offer>(
    "offers",
    {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "name", order: "ASC" },
    },
    { retry: false },
  );

  const offer = (offers ?? []).find(
    (candidate) => String(candidate.id) === String(deal.offer_id),
  );
  return offer?.type === "individual" ? offer : null;
};
