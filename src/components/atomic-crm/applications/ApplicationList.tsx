import { useState } from "react";
import { useTranslate } from "ra-core";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DateField } from "@/components/admin/date-field";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

import { PageHeader, PersonCard } from "../misc/ProgramLayout";
import { humanizeCohortName } from "../cohorts/humanizeCohortName";
import { CopyApplicationLinkButton } from "../public-application/CopyApplicationLinkButton";
import { ApplicationCreateDialog } from "./ApplicationCreateDialog";
import {
  applicationStatusBadgeVariant,
  applicationStatusLabels,
} from "./applicationConstants";
import type { ApplicationBucket } from "./classifyApplication";
import {
  useApplicationsGrouped,
  type ApplicationRow,
  type ApplicationSection,
} from "./useApplicationsGrouped";

// The Applications page answers three questions, in this order: which
// programme, does Leif need to review this, and if not what is it really.
//
// It used to answer the second one first, with a single global Needs
// Review list, and it decided membership by provenance — which buried six
// January 2027 applications Leif needed to read. Programme comes first
// now, and within each programme the subsections say only what is true.
// See classifyApplication.ts for the rules and the facts behind them.
export const ApplicationList = () => {
  const translate = useTranslate();
  const { isPending, sections, totals } = useApplicationsGrouped();
  const [createOpen, setCreateOpen] = useState(false);

  if (isPending) return null;

  const isEmpty = sections.length === 0;

  return (
    <div className="flex flex-col gap-8 mt-1 p-1 max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <PageHeader
            title={translate("resources.applications.name", { smart_count: 2 })}
            summary={translate("resources.applications.orientation")}
          />
        </div>
        {/* This page IS All Applications — the header and the nav item say
            so, so there is no button that only navigates to where you
            already are. New Application is a real action, so it gets one. */}
        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {translate("resources.applications.action.create", {
            _: "New Application",
          })}
        </Button>
      </div>

      <ApplicationCreateDialog open={createOpen} onOpenChange={setCreateOpen} />

      {totals["needs-review"] > 0 && (
        <p className="text-sm text-muted-foreground">
          {translate("resources.applications.waiting_summary", {
            _: "%{count} waiting for you across %{programmes} programmes.",
            count: totals["needs-review"],
            programmes: sections.filter(
              (s) => s.buckets["needs-review"].length > 0,
            ).length,
          })}
        </p>
      )}

      {isEmpty && (
        <p className="text-sm text-muted-foreground">
          {translate("resources.applications.empty", {
            _: "No applications yet.",
          })}
        </p>
      )}

      {sections.map((section) => (
        <ProgrammeSection key={section.key} section={section} />
      ))}
    </div>
  );
};

// One programme or cohort, with only the subsections it actually has.
const ProgrammeSection = ({ section }: { section: ApplicationSection }) => {
  const translate = useTranslate();
  const { offer, cohort, buckets } = section;

  const title = cohort
    ? humanizeCohortName(cohort.name, offer.name)
    : offer.name;

  // Only where the destination is unambiguous: the 1:1 programme has one
  // public form, and a cohort has its own. A group Offer with no cohort
  // context does not, so it gets no link rather than a guessed one.
  const applyPath = cohort
    ? `/apply/growing-yourself-up/${cohort.id}`
    : offer.type === "individual"
      ? "/apply/living-example"
      : null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          {cohort && (
            <span className="text-sm text-muted-foreground">{offer.name}</span>
          )}
          <h2 className="text-xl font-semibold">{title}</h2>
        </div>
        {applyPath && (
          <CopyApplicationLinkButton
            path={applyPath}
            label={translate("resources.applications.apply_link_label", {
              _: "%{name} application",
              name: title,
            })}
          />
        )}
      </div>

      {/* Waiting on Leif — always open, because it is the reason to be
          here. The rest are collapsed history he can open when he wants
          it. An empty subsection is omitted entirely rather than becoming
          a box with nothing in it. */}
      <BucketSection
        bucket="needs-review"
        rows={buckets["needs-review"]}
        label={translate("resources.applications.needs_review", {
          _: "Needs Review",
        })}
        open
      />
      <BucketSection
        bucket="reviewed"
        rows={buckets.reviewed}
        label={translate("resources.applications.reviewed", {
          _: "Reviewed",
        })}
      />
      <BucketSection
        bucket="pre-crm-active-sales"
        rows={buckets["pre-crm-active-sales"]}
        label={translate("resources.applications.pre_crm_active", {
          _: "Pre-CRM — Active Sales",
        })}
        note={translate("resources.applications.pre_crm_active_note", {
          _: "Old-funnel questionnaires whose sales conversation is still open. No review is owed on these.",
        })}
      />
      <BucketSection
        bucket="historical"
        rows={buckets.historical}
        label={translate("resources.applications.historical", {
          _: "Historical",
        })}
        note={translate("resources.applications.historical_note", {
          _: "Pre-CRM questionnaires from the old book-a-call funnel. Any decision shown was recorded before this CRM.",
        })}
      />
    </section>
  );
};

const BucketSection = ({
  bucket,
  rows,
  label,
  note,
  open = false,
}: {
  bucket: ApplicationBucket;
  rows: ApplicationRow[];
  label: string;
  note?: string;
  open?: boolean;
}) => {
  if (rows.length === 0) return null;

  if (open) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-semibold">{label}</h3>
          <span className="text-sm text-muted-foreground">{rows.length}</span>
        </div>
        <ApplicationRows rows={rows} />
      </div>
    );
  }

  return (
    <Accordion type="single" collapsible>
      <AccordionItem value={bucket} className="border-none">
        <AccordionTrigger className="text-base font-semibold hover:no-underline py-0">
          {label}
          <span className="text-sm font-normal text-muted-foreground ml-auto mr-2">
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
