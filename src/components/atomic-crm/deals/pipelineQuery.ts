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
// So the board asks for every active Opportunity the API will return, and
// says so out loud if it ever cannot (see PipelineTruncationNotice) instead
// of quietly showing fewer people than exist.

/**
 * The page size for the board's own list query.
 *
 * PostgREST's max_rows (supabase/config.toml) is 1000, so this is "all of
 * them" with headroom of an order of magnitude over today. It is a ceiling,
 * not a window: if it is ever reached the board reports it rather than
 * dropping cards.
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
