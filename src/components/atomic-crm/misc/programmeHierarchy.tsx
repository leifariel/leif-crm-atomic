import type { ReactNode } from "react";

// ONE definition of the programme / cohort / section ladder, used by both the
// Applications page and the Clients page.
//
// Production acceptance failed on this: a cohort heading ("January 2027") and
// a section heading ("Needs Review") were both text-sm font-medium, so a
// cohort read as just another subsection of the programme. A reader could
// not tell at a glance which level they were at.
//
// So the ladder is explicit, and strictly ordered by size as well as weight:
//
//   PROGRAMME   text-lg  font-semibold   18px   the container's own name
//   COHORT      text-base font-semibold  16px   a round of that programme
//   SECTION     text-sm  font-medium     14px   Needs Review, Past, …
//
// Restrained on purpose: one step per level, no cohort made huge. The size
// ordering is what the regression asserts against the real built CSS, since
// weight alone would not have caught the failure (both were already
// different weights from the programme).
//
// Counts are secondary to the name everywhere: muted, tabular so columns
// line up, and never the thing the eye lands on first.

const COUNT_CLASS = "text-sm font-normal text-muted-foreground tabular-nums";

/** The programme itself — the strongest heading inside its container. */
export const ProgrammeHeading = ({
  children,
  count,
  note,
  trailing,
}: {
  children: ReactNode;
  count?: number;
  /** A muted aside, e.g. how many of the count are waiting on Leif. */
  note?: ReactNode;
  trailing?: ReactNode;
}) => (
  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
    <div className="flex min-w-0 items-baseline gap-2">
      <h2 className="text-lg font-semibold truncate" data-level="programme">
        {children}
      </h2>
      {count != null && <span className={COUNT_CLASS}>{count}</span>}
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
    {trailing}
  </div>
);

/**
 * A cohort of that programme. Clearly second-level: bigger and heavier than
 * a section, smaller than the programme.
 *
 * The name should already have had the programme's own name stripped from it
 * (humanizeCohortName) — the container above says which programme this is,
 * so "Growing Yourself Up — January 2027" inside a "Growing Yourself Up"
 * container says it twice.
 */
export const CohortHeading = ({
  children,
  count,
  trailing,
}: {
  children: ReactNode;
  count?: number;
  trailing?: ReactNode;
}) => (
  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
    <div className="flex min-w-0 items-baseline gap-2">
      <h3 className="text-base font-semibold truncate" data-level="cohort">
        {children}
      </h3>
      {count != null && <span className={COUNT_CLASS}>{count}</span>}
    </div>
    {trailing}
  </div>
);

/**
 * A section within a programme or a cohort — Needs Review, Past, Upcoming.
 * Subordinate to both, with its count on the right so the column aligns
 * with the collapsed sections' counts.
 */
export const SectionHeading = ({
  children,
  count,
  hint,
}: {
  children: ReactNode;
  count?: number;
  hint?: ReactNode;
}) => (
  <div className="flex items-baseline gap-2">
    <h4 className="text-sm font-medium" data-level="section">
      {children}
    </h4>
    {count != null && <span className={COUNT_CLASS}>{count}</span>}
    {hint && (
      <span className="text-xs text-muted-foreground ml-auto">{hint}</span>
    )}
  </div>
);

/** The class a collapsed section's own trigger uses, so it matches the above. */
export const SECTION_TRIGGER_CLASS =
  "text-sm font-medium hover:no-underline py-1";

export const SECTION_COUNT_CLASS = `${COUNT_CLASS} ml-auto mr-2`;
