import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card, CardContent } from "@/components/ui/card";

// Shared visual language for "program-shaped" pages (the Living Example /
// any 1:1 Offer page, and now Cohort detail pages) — extracted so the two
// visibly feel like members of the same product family instead of a custom
// page next to a stock Atomic screen (Runtime + Visual Consistency slice,
// §2/§7). Deliberately small: three primitives, not a design system.

// Eyebrow (optional parent context) + title + a one-line stat summary.
export const PageHeader = ({
  eyebrow,
  title,
  afterTitle,
  summary,
}: {
  eyebrow?: ReactNode;
  title: string;
  // A line that belongs to the person or thing named in the title rather
  // than to the summary beneath it — the Application page puts the
  // applicant's email here. It is a sibling of the summary, not part of
  // it, because `summary` renders inside a <p> and the things that belong
  // here (PersonEmail) render block elements of their own.
  afterTitle?: ReactNode;
  summary?: ReactNode;
}) => (
  <div>
    {eyebrow && <p className="text-sm text-muted-foreground">{eyebrow}</p>}
    <h1 className="text-2xl font-semibold">{title}</h1>
    {afterTitle}
    {summary && <p className="text-lg text-muted-foreground">{summary}</p>}
  </div>
);

// A titled group of content — the "clean rounded section" unit. Content is
// left to the caller (a list of PersonCard rows, a details Card, an empty
// state) so this stays a layout primitive, not a data component.
//
// `emphasis` (Applications hierarchy repair): "primary" (default, unchanged
// for every existing caller) is the full text-xl heading. "secondary" is
// for a Section nested under a more important heading of its own (e.g. a
// Cohort's Section nested under its parent Offer's heading) — smaller and
// muted, so the parent stays visually primary.
// `action` puts a control on the heading row itself — the place a
// section-level "+ Add…" button belongs, rather than in a page header far
// above the list it acts on.
export const Section = ({
  title,
  id,
  emphasis = "primary",
  action,
  children,
}: {
  title: string;
  id?: string;
  emphasis?: "primary" | "secondary";
  action?: ReactNode;
  children: ReactNode;
}) => (
  <div
    id={id}
    className={id ? "flex flex-col gap-3 scroll-mt-4" : "flex flex-col gap-3"}
  >
    <div className="flex items-center justify-between gap-3">
      <h2
        className={
          emphasis === "secondary"
            ? "text-base font-medium text-muted-foreground"
            : "text-xl font-semibold"
        }
      >
        {title}
      </h2>
      {action}
    </div>
    {children}
  </div>
);

// One rounded row: a person's name (linking to their Contact by default, or
// `to` for a more specific destination such as the Opportunity in
// question) plus a short trailing context (a Badge, a status string, a
// date) — the same shape as the Living Example page's Current Clients /
// Upcoming Openings rows.
//
// Density pass: Card's own default `py-6` was compounding with this row's
// `py-3` (48px + 24px of pure vertical padding per row before any content)
// — the CRM-wide "oversized list card" complaint traced back to exactly
// this. `p-0` on Card removes its ambient padding (same technique
// waitlist/WaitlistSection.tsx's own outer Card already uses), leaving
// CardContent's own tight `px-4 py-2.5` — the Waitlist row's own density —
// as the only padding. Still one full rounded Card per record (not merged
// into a shared divide-y list): every PersonCard-based section (Enrolled
// Clients, People Deciding, Applications, Current Clients, and the single
// "Related Sales" card on the Application detail page) gets this for free.
export const PersonCard = ({
  contactId,
  to,
  rowLinkTo,
  name,
  meta,
  trailing,
}: {
  // Empty/null when the Opportunity carries no Contact — deals.contact_id
  // is nullable, and a row that links to /contacts//show is worse than a
  // row that simply does not link.
  contactId: string | number | null | undefined;
  // Where the NAME links. Defaults to the Contact page.
  to?: string;
  // Where the WHOLE ROW links, matching the Clients page where the entire
  // row is one link. Its own prop rather than a behaviour of `to`:
  // Applications already pass `to`, and overloading it silently turned
  // their rows into links and their Approve button into decoration.
  // Caught by applicationManualEntry.test.tsx, which is why that test
  // exists.
  rowLinkTo?: string;
  name: string;
  meta?: ReactNode;
  trailing?: ReactNode;
}) => {
  const linkable =
    contactId !== null && contactId !== undefined && contactId !== "";

  if (rowLinkTo) {
    return (
      <Card className="p-0">
        <CardContent className="relative flex items-center justify-between gap-3 px-4 py-2.5">
          {/* A stretched link rather than a wrapper, so `trailing` can hold
              a real button. Nesting a <button> inside an <a> is invalid and
              would navigate on every click of it — which is exactly what
              "Set start week" must not do. */}
          <Link
            to={rowLinkTo}
            aria-label={name}
            className="absolute inset-0 rounded-xl transition-colors hover:bg-accent/50"
          />
          <div className="pointer-events-none relative flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{name}</span>
            {meta && (
              <span className="truncate text-xs text-muted-foreground">
                {meta}
              </span>
            )}
          </div>
          {/* Transparent, so the link behind it still owns the row.
              Measured on a Pixel 5: with this wrapper taking clicks, the
              row's geometric centre fell inside it and tapping the row did
              nothing at all on a narrow screen.

              The rule for a row with a destination: everything in
              `trailing` is decoration unless it says otherwise, and a real
              control opts back in with `pointer-events-auto`. See
              NeedsStartWeekSection's "Set start week" button. */}
          {trailing && (
            <div className="pointer-events-none relative shrink-0">
              {trailing}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="p-0">
      <CardContent className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex min-w-0 flex-col">
          {to || linkable ? (
            <Link
              to={to ?? `/contacts/${contactId}/show`}
              className="text-sm font-medium hover:underline truncate"
            >
              {name}
            </Link>
          ) : (
            <span className="text-sm font-medium truncate">{name}</span>
          )}
          {meta && (
            <span className="text-xs text-muted-foreground truncate">
              {meta}
            </span>
          )}
        </div>
        {trailing && <div className="shrink-0">{trailing}</div>}
      </CardContent>
    </Card>
  );
};
