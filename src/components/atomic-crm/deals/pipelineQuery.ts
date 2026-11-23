// What the Pipeline board reads, and how it learns that what it read is old.
//
// THE DEFECT THIS EXISTS FOR (2026-10-29, Porsche Brown and Anna Howard).
// The board's list query asked for perPage=100, sorted by stage_entered_at
// ascending, with no pagination UI. Production holds more than 100 active
// Opportunities (105 on 2026-11-12). So the board silently showed the 100
// that had been in their stage LONGEST and dropped the rest — and a card
// that had just changed stage was, by construction, the newest, so it was
// the one dropped. Porsche moved and vanished; Anna's later call moved Anna,
// Anna became the newest, Anna vanished, and Porsche came back. Nobody's
// data was ever wrong. The board was a window that cut off its own edge.
//
// The first repair asked for 1000 in one request. Production then showed
// "100 of 105": the hosted API's own "Max rows" is 100, and the server, not
// perPage, decides how many rows one response holds. So every read
// is completed by the Supabase data provider itself: a first page the cap
// cut short is read page by page until the server's count is reached
// (providers/commons/fetchAllPages.ts). PipelineTruncationNotice stays as
// the emergency guard if even that comes back short; it is not the normal
// state.

/**
 * The page size for the board's own list query.
 *
 * Only the size of the FIRST request. The server may return fewer (the
 * hosted cap is 100); fetchAllPages learns that size and keeps paging.
 */
export const PIPELINE_PAGE_SIZE = 1000;

/**
 * Every resource whose rows decide which column a card sits in, whether it
 * is on the board at all, or what order a column is in.
 *
 * deals              stage, outcome, archived_at, stage_entered_at
 * sales_calls        Call Booked ordering; the result that moves a card
 * enrollments        the synthetic Onboarding column (Won + an Enrollment)
 * enrollment_onboarding_items, deal_payment_schedule_items,
 * deal_stripe_plan_objects
 *                    whether that Onboarding card's setup is finished
 */
export const PIPELINE_RESOURCES = [
  "deals",
  "sales_calls",
  "enrollments",
  "enrollment_onboarding_items",
  "deal_payment_schedule_items",
  "deal_stripe_plan_objects",
] as const;

/** Did the list come back short of what the server says exists? */
export const isPipelineTruncated = (
  loaded: number,
  total: number | undefined,
): boolean => total != null && total > loaded;
