import type { ReactNode } from "react";

// The small bordered box Kit automation is configured in.
//
// Two places configure Kit — a Program's four event tags and a Cohort's
// optional round tag — and both are persistent configuration belonging to the
// record being edited. So both use the same container, in the CRM's existing
// rounded-bordered language (the same one KitStatusLine uses on an
// Application), rather than loose labels floating in a larger form. Sharing
// one component is also what stops the two drifting apart.
//
// Deliberately small: a configuration box, not a page and not a subsystem.
export const KitConfigBox = ({
  title,
  aside,
  children,
  note,
}: {
  title: string;
  // A short qualifier on the same line — "not fully configured" and the like.
  aside?: ReactNode;
  children: ReactNode;
  note?: ReactNode;
}) => (
  <div className="rounded-md border px-3 py-2 flex flex-col gap-2">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span className="text-sm font-medium">{title}</span>
      {aside}
    </div>
    {children}
    {note ? (
      <span className="text-xs text-muted-foreground">{note}</span>
    ) : null}
  </div>
);

// One configured value: what it is for, what it is currently set to, and the
// single control that changes it.
//
// A fixed grid rather than wrapping flex, because the wrapping version put the
// button in a different place on every row depending on how long the text
// beside it happened to be. Three columns at desktop width, the same three
// stacked in the same order when there is no room — never a layout that
// rearranges itself per row.
export const KitConfigRow = ({
  label,
  value,
  action,
}: {
  label: string;
  value: ReactNode;
  action: ReactNode;
}) => (
  <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] sm:items-center">
    <span className="text-sm text-muted-foreground">{label}</span>
    <span className="min-w-0 truncate text-sm">{value}</span>
    <div className="sm:justify-self-end">{action}</div>
  </div>
);
