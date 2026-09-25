import { ShowBase, useRecordContext, useTranslate } from "ra-core";
import { contactDisplayNameOr } from "../contacts/contactDisplayName";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

import type { Application } from "../types";
import { findDealLabel, formatTimestampString } from "../deals/dealUtils";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, PersonCard, Section } from "../misc/ProgramLayout";
import { ApplicationEditDialog } from "./ApplicationEditDialog";
import { useConfigurationContext } from "../root/ConfigurationContext";
import { ApplicationAnswers } from "./ApplicationAnswers";
import { ApplicationResponses } from "./ApplicationResponses";
import {
  applicationStatusBadgeVariant,
  applicationStatusLabels,
} from "./applicationConstants";
import { ApplicationReviewActions } from "./ApplicationReviewActions";
import { useApplicationReviewData } from "./useApplicationReviewData";

// The review command center (Native Applications slice, §2/§3): titled by
// the applicant, not "Application #4", using the same visual language as
// Living Example / GYU Cohort / Programs (PageHeader/Section/PersonCard —
// no new styling system).
export const ApplicationShow = () => (
  <ShowBase>
    <ApplicationShowContent />
  </ShowBase>
);

const ApplicationShowContent = () => {
  const record = useRecordContext<Application>();
  const translate = useTranslate();
  const { dealStages } = useConfigurationContext();
  const { isPending, deal, contact, offer, cohort } =
    useApplicationReviewData(record);
  const [editOpen, setEditOpen] = useState(false);

  // The Opportunity is no longer required to render the page. It used to
  // be, and an Application with none — 78 imported records, and every one
  // Leif enters by hand — opened to a blank screen. Person and programme
  // come from the Application itself now; the Deal only gates the parts
  // that genuinely need a sales process.
  if (!record || isPending || !contact || !offer) return null;

  const applicantName = contactDisplayNameOr(contact, deal?.name ?? "");
  const submittedLabel = translate(
    "resources.applications.fields.submitted_at",
    { _: "Submitted" },
  );
  const contextLine = [
    offer.name,
    cohort?.name,
    `${submittedLabel} ${formatTimestampString(record.submitted_at)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const stageLabel = deal
    ? (findDealLabel(dealStages, deal.stage) ?? deal.stage)
    : null;

  return (
    <div className="flex flex-col gap-8 mt-1 p-1 max-w-3xl">
      {/* Correcting which programme this was for — a misfiled application
          otherwise needs a database. Narrow on purpose: the decision
          itself belongs to Review Decision below, which records when it
          was made. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <PageHeader
            title={applicantName}
            summary={
              <span className="flex flex-wrap items-center gap-2">
                <span>{contextLine}</span>
                <Badge variant={applicationStatusBadgeVariant[record.status]}>
                  {applicationStatusLabels[record.status]}
                </Badge>
              </span>
            }
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
          <Pencil className="size-4" />
          {translate("resources.applications.action.edit", {
            _: "Correct application",
          })}
        </Button>
      </div>

      <ApplicationEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        applicationId={record.id}
      />

      {/*
        The Application is the page's primary object (Native Applications
        repair pass, §1): Summary/Answers/Review Decision all live inside
        one large rounded container, the same Card primitive every other
        "big rounded box" on this page's siblings (PersonCard, Cohort
        Details) already uses — so the Application itself is unmistakably
        what this page is about, and Related Sales below reads as
        supporting context, not a competing object.
      */}
      <Card>
        <CardContent className="flex flex-col gap-6">
          <Section
            title={translate("resources.applications.review.summary_title", {
              _: "Application Summary",
            })}
          >
            {record.summary ? (
              <p className="text-sm">{record.summary}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {translate("resources.applications.review.summary_empty", {
                  _: "No summary yet.",
                })}
              </p>
            )}
          </Section>

          <Section
            title={translate("resources.applications.review.answers_title", {
              _: "Application Answers",
            })}
          >
            {/* Which form this person filled in. The two recovered Notion
                forms differ by one clause, so "which wording did they
                answer" is a real question rather than a curiosity. */}
            {record.form_label && (
              <p className="text-xs text-muted-foreground">
                {record.form_label}
              </p>
            )}
            {/* Recovered and native submissions both land here. Responses
                carry their own question text; raw_answers is the older
                native payload and still renders through its labels map
                for Applications that have no materialised responses. */}
            <ApplicationResponses applicationId={record.id} />
            <ApplicationAnswers answers={record.raw_answers} />
          </Section>

          <Section
            title={translate("resources.applications.review.decision_title", {
              _: "Review Decision",
            })}
          >
            {/* Approving or denying writes the decision onto the sales
                Opportunity as well as the Application, so where there is
                no Opportunity there is nothing to record a decision
                against. Rather than guess at what approving a manual
                application should start, the page says plainly that it
                cannot be decided here yet. */}
            {deal ? (
              <ApplicationReviewActions
                application={record}
                deal={deal}
                applicantName={applicantName}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {translate("resources.applications.review.no_opportunity", {
                  _: "No sales opportunity is linked to this application, so a decision cannot be recorded here yet.",
                })}
              </p>
            )}
          </Section>
        </CardContent>
      </Card>

      {deal && (
        <Section
          title={translate(
            "resources.applications.review.related_sales_title",
            { _: "Related Sales" },
          )}
        >
          <PersonCard
            contactId={contact.id}
            to={`/deals/${deal.id}/show`}
            name={stageLabel ?? ""}
            meta={[offer.name, cohort?.name].filter(Boolean).join(" · ")}
          />
        </Section>
      )}
    </div>
  );
};
