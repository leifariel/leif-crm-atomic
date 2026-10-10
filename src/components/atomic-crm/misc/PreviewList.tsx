import type { ReactNode } from "react";
import { useStore, useTranslate } from "ra-core";

// One long list, shown short.
//
// Every "who is in this" section on a programme page grows without a
// ceiling: the Living Example waitlist is already ~50 people, a round
// accumulates applications all the way to its close, and Enrolled Clients
// only ever gets longer. Rendered in full they turn a page Leif reads in
// one glance into a page she scrolls past — the Cohort page's four
// person-sections between the header and the Cohort Details she came for.
//
// So each section states its SIZE in the heading (`Applications · 34`) and
// shows the first few rows, with the rest one click away and the click
// staying on the page. The heading is the part that matters: a collapsed
// list that doesn't say how much it is hiding is worse than a long one.
//
// This is the only implementation of that behaviour. The Waitlist had its
// own copy first (and the dashboard's task buckets another); a second
// slightly-different "N more" is how the same list ends up expanding
// differently depending on which page you reached it from.

/**
 * How many rows a collapsed section shows.
 *
 * Three. Eight was tried first, taken from the Waitlist's own value, and
 * Leif's answer after using it was that the page is still too tall: five
 * sections of eight is forty rows before the thing she scrolled for. At
 * three, a section is a headline with a sample — "there are twenty, here
 * are the first three" — and the whole page fits.
 *
 * One number for every section on purpose. A per-section limit makes the
 * page's rhythm depend on which section you happen to be looking at.
 */
export const PREVIEW_LIMIT = 3;

export const PreviewList = <T,>({
  storeKey,
  items,
  renderRows,
  limit = PREVIEW_LIMIT,
  showAll = false,
}: {
  /**
   * Stable, caller-chosen identity for THIS section on THIS record, e.g.
   * `cohort.12.applications`. Expansion is remembered against it, so a
   * refresh, a mutation refetch, or opening and closing a lightbox leaves
   * the section exactly as Leif left it. Expanding a round's Applications
   * must not expand another round's.
   */
  storeKey: string;
  items: T[];
  /**
   * Renders the rows the section has decided to show, in the section's own
   * container (a `flex flex-col gap-2` column, a grid of cards, one
   * divided Card). The disclosure control is rendered beneath whatever
   * comes back, so it sits in the same place in every section.
   */
  renderRows: (visible: T[]) => ReactNode;
  limit?: number;
  /**
   * Show every item regardless of the collapse — the Waitlist's local
   * search uses this, because a search that only looked at the first eight
   * rows would quietly answer the wrong question.
   */
  showAll?: boolean;
}) => {
  const translate = useTranslate();
  const [expanded, setExpanded] = useStore<boolean>(
    `preview.${storeKey}`,
    false,
  );

  const collapsed = !showAll && !expanded;
  const visible = collapsed ? items.slice(0, limit) : items;
  const remaining = items.length - visible.length;
  // Only offered when collapsing would actually hide something: an
  // expanded list of six must not keep a "Show less" that does nothing.
  const canCollapse = !showAll && expanded && items.length > limit;

  return (
    <div className="flex flex-col gap-2" data-testid={`preview-${storeKey}`}>
      {renderRows(visible)}
      {(remaining > 0 || canCollapse) && (
        <button
          type="button"
          onClick={() => setExpanded(remaining > 0)}
          className="text-sm text-muted-foreground underline hover:no-underline text-left px-1 pt-0.5"
        >
          {remaining > 0
            ? translate("crm.preview.more", {
                _: "%{count} more",
                count: remaining,
              })
            : translate("crm.preview.show_less", { _: "Show less" })}
        </button>
      )}
    </div>
  );
};
