import { useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Ban,
  Check,
  ChevronDown,
  CircleX,
  PenLine,
} from "lucide-react";
import {
  useDataProvider,
  useGetList,
  useNotify,
  useRefresh,
  useTranslate,
  type Identifier,
} from "ra-core";
import { Confirm } from "@/components/admin/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { Application, Offer } from "../types";
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
  // The three only a recommendation can reach. All three are checked before
  // anything is written, so each one means the decision was not recorded.
  "recommendation-ambiguous":
    "There is more than one other programme now, so which one to recommend is no longer obvious. Nothing was recorded.",
  "already-enrolled":
    "This person is already enrolled, so their programme moves through the client page rather than an application decision.",
  "scholarship-held":
    "This opportunity holds a scholarship place, so its programme cannot change until that place is released.",
};

/**
 * Which programme a recommendation would point at.
 *
 * The one OTHER active programme, and Leif is never asked to pick it. If the
 * catalog ever holds more than one the button is not offered at all, which is
 * the same answer review_application() gives — a destination becomes part of
 * somebody's history the moment it is recorded, so a guess is not acceptable
 * at either layer.
 */
const useRecommendedProgramme = (
  fromOfferId: Identifier | null | undefined,
) => {
  const { data: offers } = useGetList<Offer>(
    "offers",
    {
      filter: {},
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );
  const candidates = (offers ?? []).filter(
    (offer) =>
      offer.is_active !== false && String(offer.id) !== String(fromOfferId),
  );
  return candidates.length === 1 ? candidates[0] : null;
};

// The operational control area of the Application review page (Native
// Applications slice, §2/§3). Every write goes through the reviewApplication
// domain action — this component only orchestrates the click, the pending
// state, and the confirmation steps; it never writes to a resource directly
// (§19).
export const ApplicationReviewActions = ({
  application,
  applicantName,
  fromOfferId,
}: {
  application: Application;
  applicantName: string;
  /**
   * The programme the SALES path is currently on — deals.offer_id, not the
   * Application's own offer_id, because that is what a recommendation moves
   * and what review_application() measures "the other programme" against.
   * Passed in because the page already holds the Opportunity and this
   * component deliberately does not fetch one.
   */
  fromOfferId?: Identifier | null;
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
  const [confirmingRecommendation, setConfirmingRecommendation] =
    useState(false);
  const recommended = useRecommendedProgramme(
    fromOfferId ?? application.offer_id,
  );

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
        {/* Offered only when there is exactly one other programme to offer,
            which is also the only case the authority will accept. Naming the
            destination on the button is the point: "Offer the other
            programme" would make Leif hover to find out what she is about
            to recommend. */}
        {recommended && (
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            onClick={() => setConfirmingRecommendation(true)}
          >
            <ArrowRightLeft className="w-4 h-4" />
            {translate("resources.applications.action.offer_other_programme", {
              _: "Offer %{programme}",
              programme: recommended.name,
            })}
          </Button>
        )}
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
        {/* A menu rather than two more buttons, because "bespoke" is one
            thought with two endings — and the menu never records the thought
            on its own: there is no "bespoke" status to be left sitting in,
            only an acceptance or a rejection. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={isBusy}>
              <PenLine className="w-4 h-4" />
              {translate("resources.applications.action.bespoke_response", {
                _: "Bespoke response",
              })}
              <ChevronDown className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => runOutcome("bespoke_accepted")}>
              {translate("resources.applications.action.bespoke_accepted", {
                _: "Bespoke acceptance",
              })}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => runOutcome("bespoke_rejected")}>
              {translate("resources.applications.action.bespoke_rejected", {
                _: "Bespoke rejection",
              })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
      {/* Confirmed, because two consequential things follow: the sales path
          moves to the other programme, and Kit may send that programme's
          cross-programme message. "May" is the honest word — the CRM reads
          which event a tag is configured for and never Kit's automation
          topology (kitAutomationRisk.ts). */}
      <Confirm
        isOpen={confirmingRecommendation && recommended != null}
        title={translate(
          "resources.applications.review.recommend_confirm_title",
          {
            _: "Offer %{name} %{programme} instead?",
            name: applicantName,
            programme: recommended?.name ?? "",
          },
        )}
        content={translate(
          "resources.applications.review.recommend_confirm_body",
          {
            _: "Their application still records the programme they applied for. Their sales opportunity moves to %{programme}, and Kit may send the message configured for that recommendation.",
            programme: recommended?.name ?? "",
          },
        )}
        confirmColor="primary"
        loading={isBusy}
        onConfirm={() => {
          setConfirmingRecommendation(false);
          runOutcome("offered_other_programme");
        }}
        onClose={() => setConfirmingRecommendation(false)}
      />
    </>
  );
};
