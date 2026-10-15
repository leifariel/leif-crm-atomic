import { useEffect, useState } from "react";
import { useDataProvider, useNotify, useRefresh, useTranslate } from "ra-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import {
  ownerDecisions,
  prospectDecisions,
} from "../deals/opportunityConstants";
import type {
  Deal,
  OpportunityOwnerDecision,
  OpportunityProspectDecision,
  SalesCall,
} from "../types";
import {
  correctCompletedSalesCall,
  type ImpressionsMode,
} from "./correctCompletedSalesCall";

/**
 * "That is not what happened."
 *
 * The edit form for an already-recorded call result. It opens on the SAME
 * episode's current facts -- a correction that started from a blank form
 * would be a second result, not a correction of the first.
 *
 * Deliberately a modal over the Opportunity rather than a page: it starts
 * from the Opportunity being worked on, it is bounded, and it asks for a
 * small number of choices (AGENTS.md, "Operational UX conventions").
 *
 * What it does NOT do is promise that every correction will be accepted.
 * Reversing a Won sale, an Enrollment, money, an issued Offer Page link or
 * a standing do-not-engage decision has no safe automatic undo, so the
 * database refuses those before changing anything and this says so in one
 * sentence rather than behind a wall of warning.
 */
export const CorrectSalesCallDialog = ({
  open,
  onOpenChange,
  salesCall,
  deal,
  contactName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  salesCall: SalesCall;
  deal: Deal;
  contactName: string;
}) => {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();

  const recordedImpressions = salesCall.impressions ?? "";

  const [attended, setAttended] = useState(salesCall.attendance === "attended");
  const [ownerDecision, setOwnerDecision] =
    useState<OpportunityOwnerDecision | null>(deal.owner_decision ?? null);
  const [prospectDecision, setProspectDecision] =
    useState<OpportunityProspectDecision | null>(
      deal.prospect_decision ?? null,
    );
  const [followUpDate, setFollowUpDate] = useState(deal.follow_up_date ?? "");
  const [impressions, setImpressions] = useState(recordedImpressions);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reopening shows what is recorded NOW, not what was typed and abandoned
  // last time.
  useEffect(() => {
    if (!open) return;
    setAttended(salesCall.attendance === "attended");
    setOwnerDecision(deal.owner_decision ?? null);
    setProspectDecision(deal.prospect_decision ?? null);
    setFollowUpDate(deal.follow_up_date ?? "");
    setImpressions(salesCall.impressions ?? "");
  }, [
    open,
    salesCall.attendance,
    salesCall.impressions,
    deal.owner_decision,
    deal.prospect_decision,
    deal.follow_up_date,
  ]);

  // The tri-state, derived from what Leif did to the box rather than from a
  // control he has to understand. Untouched is unchanged; emptied is a
  // deliberate clear; anything else is a replacement.
  const impressionsMode: ImpressionsMode =
    impressions === recordedImpressions
      ? "unchanged"
      : impressions.trim() === ""
        ? "clear"
        : "set";

  // A no-show that actually happened needs the decision it never recorded.
  const correctingToAttended =
    !!salesCall.attendance && attended && salesCall.attendance === "no_show";

  const canSubmit =
    ownerDecision != null &&
    (ownerDecision !== "would_work_with" ||
      (prospectDecision != null &&
        (prospectDecision !== "thinking" || !!followUpDate)));

  const handleSubmit = async () => {
    if (isSubmitting || !canSubmit) return;
    setIsSubmitting(true);
    try {
      const result = await correctCompletedSalesCall({
        dataProvider,
        salesCallId: salesCall.id,
        attendance: correctingToAttended ? "attended" : null,
        ownerDecision,
        prospectDecision:
          ownerDecision === "would_work_with" ? prospectDecision : null,
        followUpDate:
          ownerDecision === "would_work_with" && prospectDecision === "thinking"
            ? followUpDate
            : null,
        impressions: impressionsMode === "set" ? impressions : null,
        impressionsMode,
      });

      switch (result.status) {
        case "corrected":
          notify("resources.deals.sales_call.correction_saved", {
            type: "info",
            messageArgs: { _: "Result corrected." },
          });
          onOpenChange(false);
          refresh();
          return;
        case "no-change":
          notify("resources.deals.sales_call.correction_no_change", {
            type: "info",
            messageArgs: {
              _: "Nothing to change — that is already what is recorded.",
            },
          });
          onOpenChange(false);
          return;
        case "ambiguous-downstream-state":
        case "superseded-call-episode":
        case "invalid-transition":
        case "not-completed":
          // The reason is written for Leif by the one authority that knows
          // it; repeating it in two voices is how they diverge.
          notify(result.reason, { type: "warning" });
          return;
        case "missing-decision-date":
          notify(result.reason, { type: "warning" });
          return;
        case "validation-error":
          notify(result.message, { type: "warning" });
          return;
        default:
          notify("ra.notification.http_error", { type: "error" });
          return;
      }
    } catch {
      notify("ra.notification.http_error", { type: "error" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate("resources.deals.sales_call.correct_title", {
              _: "Edit call result",
            })}
          </DialogTitle>
          <DialogDescription>
            {translate("resources.deals.sales_call.correct_description", {
              _: "%{name}'s recorded result. Changing it keeps the original in the call's history.",
              name: contactName,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          {salesCall.attendance === "no_show" ? (
            <fieldset className="flex flex-col gap-3">
              <Label className="text-sm font-medium">
                {translate("resources.deals.sales_call.correct_attendance", {
                  _: "This call is recorded as a no-show",
                })}
              </Label>
              <div className="flex items-center gap-2">
                <input
                  id="correct-attended"
                  type="checkbox"
                  className="size-4"
                  checked={attended}
                  onChange={(event) => setAttended(event.target.checked)}
                />
                <Label htmlFor="correct-attended" className="font-normal">
                  {translate(
                    "resources.deals.sales_call.correct_actually_happened",
                    { _: "Actually, the call happened" },
                  )}
                </Label>
              </div>
            </fieldset>
          ) : (
            // Recording an attended call as a no-show would have to undo the
            // decision it already produced, and nothing here can do that
            // safely. Shown as the fact it is rather than a control that
            // would be refused.
            <p className="text-sm text-muted-foreground">
              {translate("resources.deals.sales_call.correct_attended_fixed", {
                _: "This call is recorded as having happened. To end the sale instead, use Remove from pipeline on the Opportunity.",
              })}
            </p>
          )}

          <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
            <Label className="text-sm font-medium">
              {translate("resources.deals.sales_call.owner_fit_question", {
                _: "Would I work with this person?",
              })}
            </Label>
            <RadioGroup
              value={ownerDecision ?? undefined}
              onValueChange={(value) => {
                setOwnerDecision(value as OpportunityOwnerDecision);
                if (value !== "would_work_with") setProspectDecision(null);
              }}
            >
              {ownerDecisions.map((choice) => (
                <div key={choice.value} className="flex items-center gap-2">
                  <RadioGroupItem
                    value={choice.value}
                    id={`correct-owner-${choice.value}`}
                  />
                  <Label
                    htmlFor={`correct-owner-${choice.value}`}
                    className="font-normal"
                  >
                    {choice.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>

            {ownerDecision === "would_work_with" && (
              <div className="flex flex-col gap-3 rounded-lg border p-4 mt-2">
                <Label className="text-sm font-medium">
                  {translate(
                    "resources.deals.sales_call.prospect_decision_question",
                    { _: "Their decision" },
                  )}
                </Label>
                <RadioGroup
                  value={prospectDecision ?? undefined}
                  onValueChange={(value) =>
                    setProspectDecision(value as OpportunityProspectDecision)
                  }
                >
                  {prospectDecisions.map((choice) => (
                    <div key={choice.value} className="flex items-center gap-2">
                      <RadioGroupItem
                        value={choice.value}
                        id={`correct-prospect-${choice.value}`}
                      />
                      <Label
                        htmlFor={`correct-prospect-${choice.value}`}
                        className="font-normal"
                      >
                        {choice.label}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>

                {prospectDecision === "thinking" && (
                  <div className="flex flex-col gap-2 mt-2">
                    <Label
                      htmlFor="correct-follow-up-date"
                      className="text-sm font-medium"
                    >
                      {translate("resources.deals.sales_call.follow_up_on", {
                        _: "Follow up on",
                      })}
                    </Label>
                    <Input
                      id="correct-follow-up-date"
                      type="date"
                      value={followUpDate}
                      onChange={(event) => setFollowUpDate(event.target.value)}
                    />
                  </div>
                )}
              </div>
            )}
          </fieldset>

          {/* Outside the fit/decision block on purpose: what Leif made of
              somebody is worth keeping whatever he decided about them, and
              Part 1's dialog only offered it under Would Work With. */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="correct-impressions"
              className="text-sm font-medium"
            >
              {translate("resources.deals.sales_call.impressions", {
                _: "Impressions (optional)",
              })}
            </Label>
            <Textarea
              id="correct-impressions"
              rows={3}
              value={impressions}
              placeholder="What you made of the call"
              onChange={(event) => setImpressions(event.target.value)}
            />
            {impressionsMode === "clear" && (
              <p className="text-xs text-muted-foreground">
                {translate("resources.deals.sales_call.impressions_clearing", {
                  _: "Saving will remove what was written here.",
                })}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            {translate("ra.action.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
            {translate("resources.deals.sales_call.correct_action", {
              _: "Save correction",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
