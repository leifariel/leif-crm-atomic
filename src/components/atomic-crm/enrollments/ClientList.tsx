import type { ReactNode } from "react";
import { useTranslate } from "ra-core";
import { Link } from "react-router";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ReferenceField } from "@/components/admin/reference-field";

import { humanizeCohortName } from "../cohorts/humanizeCohortName";
import {
  CohortHeading,
  ProgrammeHeading,
  SECTION_COUNT_CLASS,
  SECTION_TRIGGER_CLASS,
  SectionHeading,
} from "../misc/programmeHierarchy";
import { isStartWeekConfirmed } from "../capacity/slotHolder";
import { formatISODateString } from "../deals/dealUtils";
import { enrollmentStatusLabels } from "./enrollmentConstants";
import type { ClientRow, CohortGroup } from "./useClientsGrouped";
import { useClientsGrouped } from "./useClientsGrouped";

// "Clients" is a lifecycle view over the same Contacts, seen through their
// Enrollment. No separate Person table: the underlying resource is still
// `enrollments`.
//
// Split by Offer first, because LE and GYU are operationally different
// shapes and merging them hid the distinction: The Living Example is a
// rolling 1:1 container with its own dates per person, so it reads Current /
// Upcoming / Past; Growing Yourself Up runs as a cohort, so it reads by
// cohort. A single "Active" blob answered neither question.
//
// ONE PROGRAMME = ONE CLEARLY BOUNDED CONTAINER. Each group used to render
// its own Card, so a programme was three separate boxes with a floating <h2>
// above them and Past drifting below the previous box. Now the programme owns
// one bordered container and the groups are sections inside it, separated by
// the container's own divider rows. The groups, their membership, their
// counts, their order and every row's destination are untouched.
export const ClientList = () => {
  const translate = useTranslate();
  const { isPending, livingExample, gyuCohorts, gyuPast, other } =
    useClientsGrouped();

  if (isPending) return null;

  const hasLivingExample =
    livingExample.current.length > 0 ||
    livingExample.upcoming.length > 0 ||
    livingExample.past.length > 0;
  const hasGyu = gyuCohorts.length > 0 || gyuPast.length > 0;

  const isEmpty = !hasLivingExample && !hasGyu && other.length === 0;

  return (
    <div className="flex flex-col gap-6 mt-1 p-1 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">
          {translate("resources.enrollments.name", { smart_count: 2 })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {translate("resources.enrollments.orientation")}
        </p>
      </div>

      {isEmpty && (
        <p className="text-sm text-muted-foreground">
          {translate("resources.enrollments.empty", { _: "No clients yet." })}
        </p>
      )}

      {hasLivingExample && (
        <ProgrammeCard title="The Living Example">
          {livingExample.current.length > 0 && (
            <Group
              title={translate("resources.enrollments.current_clients", {
                _: "Current",
              })}
              // Says the order out loud so it is not something Leif has to
              // infer from the rows.
              hint={translate("resources.enrollments.current_order_hint", {
                _: "Newest start first",
              })}
              rows={livingExample.current}
            />
          )}

          {livingExample.upcoming.length > 0 && (
            <Group
              title={translate("resources.enrollments.upcoming_clients", {
                _: "Upcoming",
              })}
              hint={translate("resources.enrollments.upcoming_order_hint", {
                _: "Latest start first",
              })}
              rows={livingExample.upcoming}
            />
          )}

          {/* Past stays inside the programme's container. It used to be a
              separate box below it, which read as a fourth thing on the page
              rather than this programme's history. */}
          {livingExample.past.length > 0 && (
            <CollapsedGroup
              value="le-past"
              title={translate("resources.enrollments.past_clients", {
                _: "Past",
              })}
              rows={livingExample.past}
            />
          )}
        </ProgrammeCard>
      )}

      {hasGyu && (
        <ProgrammeCard title="Growing Yourself Up">
          {/* A cohort is subordinate to its programme, not a peer of it:
              same section treatment as Current/Upcoming above, inside the
              one Growing Yourself Up container. */}
          {gyuCohorts.map((group: CohortGroup) => (
            <Group
              key={group.key}
              level="cohort"
              // "Growing Yourself Up — January 2027" inside a "Growing
              // Yourself Up" container says it twice. The stored name is
              // untouched; only what Leif reads changes.
              title={humanizeCohortName(
                group.title,
                group.rows[0]?.offer?.name ?? "",
              )}
              rows={group.rows}
            />
          ))}

          {gyuPast.length > 0 && (
            <CollapsedGroup
              value="gyu-past"
              title={translate("resources.enrollments.past_cohort_clients", {
                _: "Past & withdrawn",
              })}
              rows={gyuPast}
            />
          )}
        </ProgrammeCard>
      )}

      {/* Anything whose Offer is neither of the two. It had no heading at
          all before — a bare group floating under the page — so it now says
          what it is, in its own container like everything else. */}
      {other.length > 0 && (
        <ProgrammeCard
          title={translate("resources.enrollments.other_clients", {
            _: "Other",
          })}
        >
          {/* No inner heading: the container above already says "Other",
              and repeating it would say it twice. */}
          <div className="px-4 py-3">
            <ClientRows rows={other} />
          </div>
        </ProgrammeCard>
      )}
    </div>
  );
};

/**
 * One programme, one bounded container: its name inside the border rather
 * than floating above it, and its groups divided from each other by the
 * container's own rule rather than each carrying a card of its own.
 */
const ProgrammeCard = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  // The testids are the stable hooks the structural regression scopes to,
  // so it never has to reach for class names or tag structure.
  <Card className="p-0" data-testid="client-programme" data-programme={title}>
    <CardContent className="p-0">
      <ProgrammeHeading>{title}</ProgrammeHeading>
      <div className="divide-y border-t">{children}</div>
    </CardContent>
  </Card>
);

const Group = ({
  title,
  hint,
  rows,
  level = "section",
}: {
  title: string;
  hint?: string;
  rows: ClientRow[];
  /** A cohort of the programme, or one of its lifecycle sections. */
  level?: "cohort" | "section";
}) => (
  <div
    className="flex flex-col gap-2 px-4 py-3"
    data-testid="client-group"
    data-group={title}
    data-level={level}
  >
    {level === "cohort" ? (
      <CohortHeading count={rows.length}>{title}</CohortHeading>
    ) : (
      <SectionHeading count={rows.length} hint={hint}>
        {title}
      </SectionHeading>
    )}
    <ClientRows rows={rows} />
  </div>
);

const CollapsedGroup = ({
  value,
  title,
  rows,
}: {
  value: string;
  title: string;
  rows: ClientRow[];
}) => (
  <Accordion
    type="single"
    collapsible
    className="px-4 py-3"
    data-testid="client-group"
    data-group={title}
  >
    <AccordionItem value={value} className="border-none">
      <AccordionTrigger className={SECTION_TRIGGER_CLASS}>
        {title}
        <span className={SECTION_COUNT_CLASS}>{rows.length}</span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="pt-2">
          <ClientRows rows={rows} />
        </div>
      </AccordionContent>
    </AccordionItem>
  </Accordion>
);

// The container's dates belong on the row. Leif should not have to open a
// client to find out when their programme runs.
//
// A Start Week, not a start date: the programme begins in a week, and it
// is a week Leif chooses. A client may book Session #1 early, late, or
// not at all, and none of that moves it.
//
// The end comes from the Year Tracking calendar, not from arithmetic on
// months. The Living Example is twelve sessions across Leif's available
// `1:1s` weeks, so the container ends when the twelfth of those weeks is
// over — plus one more week for each cross-week reschedule. There are no
// eligible weeks at all between 2 July and 13 September 2026, which is
// exactly the kind of gap a four-month calculation cannot see.
//
// When Year Tracking has not been filled far enough ahead the row says
// so, with the count, rather than showing a date nobody can stand behind.
const containerDates = (row: ClientRow): string => {
  if (!row.enrollment.start_date) {
    // Not a blank, and not a guess. An Enrollment with no Start Week is
    // waiting on Leif, and the row says so.
    return "Start week not set";
  }
  const parts = [`Starts ${formatISODateString(row.enrollment.start_date)}`];
  const end = row.expectedEnd ?? null;
  if (end?.status === "known") {
    parts.push(
      `final session week of ${formatISODateString(end.finalWeek.start)}`,
    );
  } else if (end?.status === "incomplete") {
    parts.push(
      `end unavailable — ${end.weeksScheduled} of ${end.weeksRequired} session weeks scheduled`,
    );
  }
  if (!isStartWeekConfirmed(row.enrollment)) {
    parts.push("start week not confirmed");
  }
  return parts.join(" · ");
};

// The rows only. The bordered container belongs to the PROGRAMME: this used
// to render a Card per group, so one programme was three separate boxes. The
// negative margin lets the row rules reach the container's edges while the
// group's own heading stays inset with the rest of the text.
const ClientRows = ({ rows }: { rows: ClientRow[] }) => (
  <div className="-mx-4 divide-y border-y">
    {rows.map((row) => (
      <Link
        key={row.enrollment.id}
        // The Enrollment, not the Contact: this is the client container, and
        // the generic Contact page does not show start/end dates, payment
        // state, onboarding or sessions.
        to={`/enrollments/${row.enrollment.id}/show`}
        className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors"
      >
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-medium truncate">
            {row.contactId != null ? (
              <ReferenceField
                source="contactId"
                reference="contacts"
                record={{ id: row.enrollment.id, contactId: row.contactId }}
                link={false}
              />
            ) : (
              "—"
            )}
          </span>
          <span className="text-xs text-muted-foreground truncate">
            {containerDates(row)}
          </span>
          {/* Inside a cohort section the heading already names the cohort,
              and GYU cohort names contain the offer name, so repeating both
              produced "Growing Yourself Up — Growing Yourself Up — Fall
              2026". Only shown when it adds something the section heading
              does not. */}
          {row.cohort == null && row.offer?.name && (
            <span className="text-xs text-muted-foreground truncate">
              {row.offer.name}
            </span>
          )}
        </div>
        <Badge
          variant={row.phase === "past" ? "secondary" : "outline"}
          className="shrink-0"
        >
          {row.phase === "upcoming"
            ? "Upcoming"
            : enrollmentStatusLabels[row.enrollment.status]}
        </Badge>
      </Link>
    ))}
  </div>
);
