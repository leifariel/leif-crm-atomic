import { useTranslate, type Identifier } from "ra-core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { Cohort, Offer } from "../types";

// Recommending the other programme, asked for in one place.
//
// A generic Confirm was enough while the destination was just a programme. It
// stopped being enough the moment the destination had ROUNDS: offering
// Growing Yourself Up means offering a specific round, and the dialog has to
// cope with four different truths about them —
//
//   the destination has no rounds      confirm, and say the round is left behind
//   exactly one round is taking people name it, and confirm
//   several rounds are                 ask WHICH, because that answer becomes
//                                      part of somebody's history
//   none is                            say so, and offer nothing to click
//
// The several-rounds case follows ResolveOpportunityDialog's existing
// language: one bordered row per candidate with its own button, so choosing
// and confirming are the same click rather than two.
export const RecommendProgrammeDialog = ({
  open,
  onOpenChange,
  applicantName,
  recommended,
  eligibleCohorts,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicantName: string;
  /** The one other active programme. */
  recommended: Pick<Offer, "id" | "name" | "type">;
  /**
   * Every round of it still taking people, soonest deadline first. Empty for
   * an individual programme, which has none — and empty for a group one whose
   * rounds have all closed, which is why the two cases are told apart by the
   * programme's type rather than by this being empty.
   */
  eligibleCohorts: Array<Pick<Cohort, "id" | "name">>;
  busy: boolean;
  onConfirm: (cohortId: Identifier | null) => void;
}) => {
  const translate = useTranslate();
  const isGroup = recommended.type === "group";
  const needsChoice = isGroup && eligibleCohorts.length > 1;
  const blocked = isGroup && eligibleCohorts.length === 0;
  const theOnlyRound = isGroup && eligibleCohorts.length === 1;

  // What is true about the Application either way, said before anything else,
  // because it is the thing a recommendation is most easily mistaken for.
  const preserved = translate(
    "resources.applications.review.recommend_preserved",
    {
      _: "Their application still records the programme they applied for. Their sales opportunity moves to %{programme}, and Kit may send the message configured for that recommendation.",
      programme: recommended.name,
    },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {blocked
              ? translate(
                  "resources.applications.review.recommend_blocked_title",
                  {
                    _: "%{programme} has no round open",
                    programme: recommended.name,
                  },
                )
              : translate(
                  "resources.applications.review.recommend_confirm_title",
                  {
                    _: "Offer %{name} %{programme} instead?",
                    name: applicantName,
                    programme: recommended.name,
                  },
                )}
          </DialogTitle>
          <DialogDescription>
            {blocked
              ? translate(
                  "resources.applications.review.recommend_blocked_body",
                  {
                    _: "Every round of %{programme} has closed its applications, and a sale with no round becomes a client with no round and no start date. Open a round first, then record this decision.",
                    programme: recommended.name,
                  },
                )
              : preserved}
          </DialogDescription>
        </DialogHeader>

        {theOnlyRound && (
          <p className="text-sm">
            {translate("resources.applications.review.recommend_only_round", {
              _: "They would join %{cohort}, the only round still taking applications.",
              cohort: eligibleCohorts[0].name,
            })}
          </p>
        )}

        {needsChoice && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">
              {translate(
                "resources.applications.review.recommend_choose_round",
                {
                  _: "Which round?",
                },
              )}
            </p>
            {eligibleCohorts.map((cohort) => (
              <div
                key={cohort.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border px-3 py-2"
              >
                <span className="text-sm">{cohort.name}</span>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => onConfirm(cohort.id)}
                >
                  {translate(
                    "resources.applications.review.recommend_pick_round",
                    {
                      _: "Offer this round",
                    },
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {translate("ra.action.cancel", { _: "Cancel" })}
          </Button>
          {/* Nothing to confirm when a round has to be chosen — each row
              carries its own button — and nothing to confirm at all when no
              round is open. */}
          {!needsChoice && !blocked && (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                onConfirm(theOnlyRound ? eligibleCohorts[0].id : null)
              }
            >
              {translate("resources.applications.review.recommend_confirm", {
                _: "Offer %{programme}",
                programme: recommended.name,
              })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
