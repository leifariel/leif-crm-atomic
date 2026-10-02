import { useState } from "react";
import { AlertTriangle, Ban, Check, CircleX } from "lucide-react";
import { useDataProvider, useNotify, useRefresh, useTranslate } from "ra-core";
import { Confirm } from "@/components/admin/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import type { Application } from "../types";
import {
  applicationStatusBadgeVariant,
  applicationStatusLabels,
} from "./applicationConstants";
import {
  reviewApplication,
  type ApplicationReviewOutcome,
} from "./reviewApplication";

// What the owner is told when the authority refuses. Each names a real
// situation rather than a code, and every one of them means nothing was
// written.
const REFUSAL_NOTICE: Record<string, string> = {
  "already-reviewed":
    "This application was already reviewed — showing the current state.",
  "no-opportunity":
    "This application has no sales opportunity to record a decision against.",
  "opportunity-mismatch":
    "This application and its opportunity belong to different people, so no decision was recorded.",
  "opportunity-invalid":
    "This application points at an opportunity that no longer exists.",
  "outcome-invalid": "That is not a decision this application can record.",
  "application-invalid": "That application could not be found.",
};

// The operational control area of the Application review page (Native
// Applications slice, §2/§3). Every write goes through the reviewApplication
// domain action — this component only orchestrates the click, the pending
// state, and (for Do Not Engage) the confirmation step; it never writes to
// a resource directly (§19).
export const ApplicationReviewActions = ({
  application,
  applicantName,
}: {
  application: Application;
  applicantName: string;
  // Accepted and ignored. review_application() resolves the Opportunity from
  // the Application under a lock, because a copy held by the page is exactly
  // as stale as the status it was meant to be checked against. The prop stays
  // in the type so callers that still pass it keep compiling.
  deal?: unknown;
}) => {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [pendingOutcome, setPendingOutcome] =
    useState<ApplicationReviewOutcome | null>(null);
  const [confirmingDoNotEngage, setConfirmingDoNotEngage] = useState(false);

  const runOutcome = async (outcome: ApplicationReviewOutcome) => {
    setPendingOutcome(outcome);
    try {
      const result = await reviewApplication({
        dataProvider,
        application,
        outcome,
      });
      if (!result.applied) {
        // The authority refused, under its lock, from current truth — a stale
        // tab, a double-click, or a decision somebody already recorded. Never
        // silently overwrite: say which, and show the real state.
        notify(
          REFUSAL_NOTICE[result.reason] ?? REFUSAL_NOTICE["already-reviewed"],
          {
            type: "warning",
          },
        );
      } else {
        notify("resources.applications.updated", { type: "info" });
      }
    } catch {
      notify("ra.notification.http_error", { type: "error" });
    } finally {
      setPendingOutcome(null);
      refresh();
    }
  };

  if (application.status !== "pending") {
    return (
      <div className="flex items-center gap-2">
        <Badge variant={applicationStatusBadgeVariant[application.status]}>
          {applicationStatusLabels[application.status]}
        </Badge>
        {/* States the decision and nothing else. It used to read "Reviewed
            — no further action needed.", which sat directly above a Kit box
            saying "Manual — action needed · 2 tags still to add": one of the
            two was always wrong, and this component cannot know whether
            anything else is outstanding. Whatever Kit still needs is said by
            the component that actually knows, immediately below. */}
        <span className="text-sm text-muted-foreground">
          {translate("resources.applications.review.already_reviewed", {
            _: "Decision recorded.",
          })}
        </span>
      </div>
    );
  }

  const isBusy = pendingOutcome != null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={applicationStatusBadgeVariant[application.status]}>
          {applicationStatusLabels[application.status]}
        </Badge>
        <Button
          size="sm"
          disabled={isBusy}
          onClick={() => runOutcome("approved")}
        >
          <Check className="w-4 h-4" />
          {translate("resources.applications.action.approve")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy}
          onClick={() => runOutcome("needs_higher_care")}
        >
          <AlertTriangle className="w-4 h-4" />
          {translate("resources.applications.action.needs_higher_care")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy}
          onClick={() => runOutcome("not_fit")}
        >
          <CircleX className="w-4 h-4" />
          {translate("resources.applications.action.not_fit")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={isBusy}
          onClick={() => setConfirmingDoNotEngage(true)}
        >
          <Ban className="w-4 h-4" />
          {translate("resources.applications.action.do_not_engage")}
        </Button>
      </div>
      <Confirm
        isOpen={confirmingDoNotEngage}
        title={translate("resources.applications.review.dne_confirm_title", {
          _: "Mark %{name} as Do Not Engage?",
          name: applicantName,
        })}
        content={translate("resources.applications.review.dne_confirm_body", {
          _: "This removes them from future direct sales eligibility.",
        })}
        confirmColor="warning"
        loading={isBusy}
        onConfirm={() => {
          setConfirmingDoNotEngage(false);
          runOutcome("do_not_engage");
        }}
        onClose={() => setConfirmingDoNotEngage(false)}
      />
    </>
  );
};
