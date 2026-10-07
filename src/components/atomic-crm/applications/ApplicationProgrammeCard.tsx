import { useTranslate } from "ra-core";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { DateField } from "@/components/admin/date-field";

import { PersonCard } from "../misc/ProgramLayout";
import { humanizeCohortName } from "../cohorts/humanizeCohortName";
import { CopyApplicationLinkButton } from "../public-application/CopyApplicationLinkButton";
import {
  applicationStatusBadgeVariant,
  applicationStatusLabels,
} from "./applicationConstants";
import type { ApplicationBucket } from "./classifyApplication";
import type { ApplicationProgramme } from "./groupSectionsByProgramme";
import type {
  ApplicationRow,
  ApplicationSection,
} from "./useApplicationsGrouped";

// ONE PROGRAMME = ONE CLEARLY BOUNDED CONTAINER.
//
// Before this the page rendered one loose <section> per cohort-or-offer with
// a floating <h2> and no container at all, so Growing Yourself Up's cohorts
// read as peer programmes beside The Living Example — three titles on screen
// where there are two programmes — and the subsection headings floated with
// them. Now each programme is a single bordered Card; its cohorts are
// subordinate headings INSIDE it, separated by the container's own divider
// rows.
//
// Nothing here changes which applications exist, which bucket they are in,
// what they are counted as, or where a row goes. See
// groupSectionsByProgramme.ts for why the ordering is untouched too.

export const ApplicationProgrammeCard = ({
  programme,
}: {
  programme: ApplicationProgramme;
}) => {
  const translate = useTranslate();
  const { offer, sections, total, needsReview } = programme;

  // A programme-level link belongs here only where the programme itself has
  // ONE public form. The Living Example does. Growing Yourself Up does not —
  // each cohort has its own, so the link lives on the cohort heading rather
  // than being guessed at this level. See the cohort heading below.
  const programmeApplyPath =
    offer.type === "individual" ? "/apply/living-example" : null;

  return (
    // The testids are the stable hooks the structural regressions scope to.
    // Without them a test has to reach for class names or tag structure, which
    // is exactly what broke when this page stopped using loose <section>s.
    <Card
      className="p-0"
      data-testid="application-programme"
      data-programme={offer.name}
    >
      <CardContent className="p-0">
        {/* The programme's own heading, inside its container rather than
            floating above it. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-lg font-semibold truncate">{offer.name}</h2>
            <span className="text-sm text-muted-foreground tabular-nums">
              {total}
            </span>
            {needsReview > 0 && (
              <span className="text-xs text-muted-foreground">
                {translate("resources.applications.needs_review_inline", {
                  _: "%{count} waiting",
                  count: needsReview,
                })}
              </span>
            )}
          </div>
          {programmeApplyPath && (
            <CopyApplicationLinkButton
              path={programmeApplyPath}
              label={translate("resources.applications.apply_link_label", {
                _: "%{name} application",
                name: offer.name,
              })}
            />
          )}
        </div>

        {/* Every section of this programme, divided from each other and from
            the heading by the container's own rule. */}
        <div className="divide-y border-t">
          {sections.map((section) => (
            <ProgrammeSubsection
              key={section.key}
              section={section}
              showCohortHeading={offer.type !== "individual"}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

/**
 * One cohort of a programme — or, for the rolling 1:1 programme, simply its
 * applications with no extra heading, because the programme heading above
 * already named it and a second identical title would say nothing.
 */
const ProgrammeSubsection = ({
  section,
  showCohortHeading,
}: {
  section: ApplicationSection;
  showCohortHeading: boolean;
}) => {
  const translate = useTranslate();
  const { offer, cohort, buckets, total } = section;

  // A cohort's own public form. Only ever for a real cohort: a group Offer
  // with no cohort context has no unambiguous destination, so it gets no
  // link rather than a guessed one.
  const cohortApplyPath = cohort
    ? `/apply/growing-yourself-up/${cohort.id}`
    : null;

  // Cohortless applications on a group programme. Real: an application may
  // predate cohorts, or never have had one recorded on either the
  // application or its Deal. It is NOT a cohort, so it is not titled like
  // one, and it is not given a cohort's apply link.
  const heading = cohort
    ? humanizeCohortName(cohort.name, offer.name)
    : translate("resources.applications.no_cohort_recorded", {
        _: "No cohort recorded",
      });

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3"
      data-testid="application-subsection"
      data-subsection={heading}
    >
      {showCohortHeading && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 items-baseline gap-2">
            {/* Subordinate to the programme heading above: smaller, and a
                heading level down. A cohort is not a programme. */}
            <h3 className="text-sm font-medium truncate">{heading}</h3>
            <span className="text-xs text-muted-foreground tabular-nums">
              {total}
            </span>
          </div>
          {cohortApplyPath && (
            <CopyApplicationLinkButton
              path={cohortApplyPath}
              label={translate("resources.applications.apply_link_label", {
                _: "%{name} application",
                name: heading,
              })}
            />
          )}
        </div>
      )}

      {/* Waiting on Leif — always open, because it is the reason to be
          here. An empty subsection is omitted entirely rather than becoming
          a box with nothing in it. */}
      <OpenBucket
        rows={buckets["needs-review"]}
        label={translate("resources.applications.needs_review", {
          _: "Needs Review",
        })}
      />

      {/* The three history buckets are ONE collapsed group, not three loose
          headers. Each still opens independently and keeps its own name,
          because "reviewed", "still selling" and "pre-CRM questionnaire"
          are genuinely different things. */}
      <CollapsedBuckets
        items={[
          {
            bucket: "reviewed",
            rows: buckets.reviewed,
            label: translate("resources.applications.reviewed", {
              _: "Reviewed",
            }),
          },
          {
            bucket: "pre-crm-active-sales",
            rows: buckets["pre-crm-active-sales"],
            label: translate("resources.applications.pre_crm_active", {
              _: "Pre-CRM — Active Sales",
            }),
            note: translate("resources.applications.pre_crm_active_note", {
              _: "Old-funnel questionnaires whose sales conversation is still open. No review is owed on these.",
            }),
          },
          {
            bucket: "historical",
            rows: buckets.historical,
            label: translate("resources.applications.historical", {
              _: "Historical",
            }),
            note: translate("resources.applications.historical_note", {
              _: "Pre-CRM questionnaires from the old book-a-call funnel. Any decision shown was recorded before this CRM.",
            }),
          },
        ]}
      />
    </div>
  );
};

// Waiting on Leif — always open, because it is the reason to be here.
const OpenBucket = ({
  rows,
  label,
}: {
  rows: ApplicationRow[];
  label: string;
}) => {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h4 className="text-sm font-semibold">{label}</h4>
        <span className="text-sm text-muted-foreground tabular-nums ml-auto">
          {rows.length}
        </span>
      </div>
      <ApplicationRows rows={rows} />
    </div>
  );
};

type CollapsedBucket = {
  bucket: ApplicationBucket;
  rows: ApplicationRow[];
  label: string;
  note?: string;
};

// History he can open when he wants it. An empty bucket is omitted entirely
// rather than becoming a header with nothing behind it, and when every
// bucket is empty the whole group disappears instead of leaving a stray rule
// across the page.
const CollapsedBuckets = ({ items }: { items: CollapsedBucket[] }) => {
  const present = items.filter((item) => item.rows.length > 0);
  if (present.length === 0) return null;

  return (
    <Accordion type="multiple">
      {present.map(({ bucket, rows, label, note }) => (
        <AccordionItem key={bucket} value={bucket} className="border-none">
          {/* The chevron is the Accordion's own, so every collapsible thing
              on the page opens the same way. Counts sit at the same right
              edge as the open subsection's, so the column lines up. */}
          <AccordionTrigger className="text-sm font-semibold hover:no-underline py-1">
            {label}
            <span className="text-sm font-normal text-muted-foreground tabular-nums ml-auto mr-2">
              {rows.length}
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-2 pt-2">
              {note && <p className="text-xs text-muted-foreground">{note}</p>}
              <ApplicationRows rows={rows} />
            </div>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
};

const ApplicationRows = ({ rows }: { rows: ApplicationRow[] }) => {
  const translate = useTranslate();
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => {
        const submittedLabel = translate(
          "resources.applications.fields.submitted_at",
          { _: "Submitted" },
        );
        return (
          <PersonCard
            key={row.applicationId}
            contactId={row.contactId}
            to={`/applications/${row.applicationId}/show`}
            name={row.contactName}
            meta={
              <>
                {submittedLabel}{" "}
                {/* submitted_at is a full timestamp (timestamptz), not a
                    bare date — formatISODateString is for date-only columns
                    and throws on this shape, so reuse the same DateField
                    the previous flat table used for this exact column. */}
                <DateField
                  source="submitted_at"
                  record={{ submitted_at: row.submittedAt }}
                />
                {/* The sales fact that makes a Pre-CRM row live, said on
                    the row rather than left implied by the section. */}
                {row.bucket === "pre-crm-active-sales" && row.dealStage && (
                  <> · {row.dealStage.replace(/_/g, " ")}</>
                )}
              </>
            }
            trailing={
              <Badge variant={applicationStatusBadgeVariant[row.status]}>
                {applicationStatusLabels[row.status]}
              </Badge>
            }
          />
        );
      })}
    </div>
  );
};
