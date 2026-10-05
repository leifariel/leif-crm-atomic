import { useState } from "react";
import { useDataProvider, useNotify, useRefresh } from "ra-core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { useConfigurationContext } from "../root/ConfigurationContext";
import { findDealLabel, formatISODateString } from "../deals/dealUtils";
import type { Application } from "../types";
import type {
  OpportunityCandidate,
  ResolutionVerdict,
} from "./resolveApplicationOpportunity";

// Linking an Application to the sales conversation that already exists.
//
// The third option that was missing. Samantha Herold and Celia each had a
// live Growing Yourself Up Opportunity and an Application that pointed at
// nothing, so the page could tell Leif both that a conversation existed and
// that no decision could be recorded — and offer him nothing to do about it.
//
// A lightbox over the Application, never a separate repair page: this is a
// bounded operational decision taken from the record already on screen
// (AGENTS.md -> Operational UX conventions).
//
// It writes exactly one field. No Opportunity is created, none is modified,
// and the Application stays the Application. The database refuses any link
// whose Opportunity belongs to another person or another programme
// (enforce_application_opportunity_agreement), so the worst a stale screen
// can do is be told no.
export const ResolveOpportunityDialog = ({
  application,
  applicantName,
  verdict,
  open,
  onOpenChange,
}: {
  application: Application;
  applicantName: string;
  verdict: ResolutionVerdict;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const { dealStages } = useConfigurationContext();
  const [working, setWorking] = useState<string | null>(null);

  if (verdict.kind === "none") return null;

  const candidates =
    verdict.kind === "one" ? [verdict.candidate] : verdict.candidates;

  const link = async (candidate: OpportunityCandidate) => {
    setWorking(String(candidate.id));
    try {
      await dataProvider.update("applications", {
        id: application.id,
        data: { opportunity_id: candidate.id },
        previousData: application,
      });
      notify(`${applicantName} is linked to that sales conversation.`, {
        type: "info",
      });
      onOpenChange(false);
      refresh();
    } catch (error) {
      // The database's own refusal, said as it was given. These are real
      // answers about the business — wrong person, wrong programme — not
      // failures to retry blindly.
      notify(
        error instanceof Error
          ? error.message
          : "That could not be linked just now. Nothing was changed.",
        { type: "warning", autoHideDuration: 0 },
      );
    } finally {
      setWorking(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {verdict.kind === "one"
              ? "Link this application to the existing sales conversation?"
              : "Which sales conversation is this application part of?"}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {verdict.kind === "one"
            ? `${applicantName} already has a live sales conversation for this programme. Linking it here records the decision against that conversation — nothing new is created.`
            : `${applicantName} has more than one live sales conversation for this programme, so which one this application belongs to is yours to say.`}
        </p>

        <div className="flex flex-col gap-2">
          {candidates.map((candidate) => (
            <div
              key={candidate.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">
                  {findDealLabel(dealStages, candidate.stage)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {[
                    `Opportunity ${candidate.id}`,
                    `started ${formatISODateString(candidate.createdAt.slice(0, 10))}`,
                    candidate.stageEnteredAt
                      ? `at this stage since ${formatISODateString(candidate.stageEnteredAt.slice(0, 10))}`
                      : null,
                    // Said plainly, because a missing round is exactly what
                    // kept these two apart in the first place.
                    candidate.cohortId == null
                      ? "no round recorded"
                      : `round ${candidate.cohortId}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={working != null}
                onClick={() => link(candidate)}
              >
                {working === String(candidate.id) ? "Linking…" : "Link"}
              </Button>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
