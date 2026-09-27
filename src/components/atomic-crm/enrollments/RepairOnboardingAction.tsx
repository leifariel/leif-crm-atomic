import { useState } from "react";
import { useDataProvider, useGetList, useNotify, useRefresh } from "ra-core";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { describePlan } from "./transferClientOffer";
import {
  foreignRequirementKeys,
  onboardingMatchesOffer,
  proposePreviousOffer,
  reconcileClientOnboarding,
} from "./reconcileClientOnboarding";
import type {
  Deal,
  Enrollment,
  EnrollmentOnboardingItem,
  Offer,
  OnboardingRequirementTemplate,
} from "../types";

// A client whose setup belongs to a programme they are not in.
//
// Jenna Smith's Opportunity was changed from Growing Yourself Up to The Living
// Example before the transfer guard existed, and her onboarding stayed GYU. The
// transfer action cannot help her — her programme is already right — and she
// should not live with a checklist for a programme she never joined because the
// repair arrived after the damage.
//
// Noticing it is automatic: the live requirement keys either are the current
// programme's or they are not. Repairing it is a decision, so it says what is
// wrong in a card on the page, and asks the one question it cannot answer —
// which programme the setup came from — in a modal over that page (AGENTS.md ->
// Operational UX conventions). The answer becomes the client's history.

const TERMINAL = ["completed", "withdrawn", "ended"];

export const RepairOnboardingAction = ({
  deal,
  enrollment,
  items,
}: {
  deal: Deal;
  enrollment: Enrollment;
  items: EnrollmentOnboardingItem[];
}) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [previousOfferId, setPreviousOfferId] = useState<string>("");
  const [repairing, setRepairing] = useState(false);

  // retry: false and a bounded page, for the same reason
  // MoveClientProgrammeAction does it: a control that offers something must
  // degrade to offering nothing rather than hanging the page it sits on.
  const { data: offers } = useGetList<Offer>(
    "offers",
    {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "name", order: "ASC" },
    },
    { retry: false },
  );

  const { data: templates } = useGetList<OnboardingRequirementTemplate>(
    "onboarding_requirement_templates",
    {
      filter: { is_active: true },
      pagination: { page: 1, perPage: 200 },
      sort: { field: "sort_order", order: "ASC" },
    },
    { retry: false },
  );

  const currentTemplates = (templates ?? []).filter(
    (template) => String(template.offer_id) === String(deal.offer_id),
  );

  // Nothing to say until both halves are loaded: "no requirements" and "not
  // loaded yet" look identical, and only one of them is a mismatch.
  if (currentTemplates.length === 0) return null;
  if (TERMINAL.includes(enrollment.status)) return null;
  if (onboardingMatchesOffer(items, currentTemplates)) return null;

  const currentName =
    (offers ?? []).find((offer) => String(offer.id) === String(deal.offer_id))
      ?.name ??
    deal.offer_name_snapshot ??
    "their current programme";

  const foreignKeys = foreignRequirementKeys(items, currentTemplates);
  const candidates = (offers ?? [])
    .filter((offer) => String(offer.id) !== String(deal.offer_id))
    .map((offer) => ({
      offer,
      keys: (templates ?? [])
        .filter((template) => String(template.offer_id) === String(offer.id))
        .map((template) => template.key),
    }))
    .filter((candidate) => candidate.keys.length > 0);

  // A suggestion, not a decision: exactly one programme whose setup accounts
  // for every stale requirement, and only when there is no second candidate.
  const proposed = proposePreviousOffer(
    foreignKeys,
    candidates.map((candidate) => ({
      offerId: candidate.offer.id,
      keys: candidate.keys,
    })),
  );
  const selectedId =
    previousOfferId || (proposed != null ? String(proposed) : "");
  const selected = candidates.find(
    (candidate) => String(candidate.offer.id) === selectedId,
  );
  const previousName =
    selected?.offer.name ??
    candidates.find(
      (candidate) => String(candidate.offer.id) === String(proposed),
    )?.offer.name ??
    null;
  const plan = describePlan(items, currentTemplates);
  // Only the requirements whose wording actually changes are worth a line.
  // "Meditation library access" is called the same thing in both programmes, so
  // saying it will be updated is true of the row and meaningless to Leif.
  const renamed = items
    .filter((item) => item.status !== "retired" && item.status !== "done")
    .map((item) => ({
      item,
      template: currentTemplates.find(
        (template) => template.key === item.requirement_key,
      ),
    }))
    .filter(({ template }) => template != null && template.label !== undefined)
    .filter(({ item, template }) => template!.label !== item.label)
    .map(({ template }) => template!.label);
  // Only where another programme's requirements are actually present does one
  // have to be named. A programme whose own requirements merely grew is not a
  // transfer and records no history.
  const needsSource = foreignKeys.length > 0;

  const repair = async () => {
    if (needsSource && !selected) return;
    setRepairing(true);
    try {
      const result = await reconcileClientOnboarding(dataProvider, {
        opportunityId: deal.id,
        fromOfferId: needsSource ? (selected?.offer.id ?? null) : null,
      });
      if (result.status === "reconciled") {
        setOpen(false);
        notify("Onboarding repaired", { type: "info" });
        refresh();
      } else if (result.status === "already-aligned") {
        setOpen(false);
        notify("This onboarding already matches their programme.", {
          type: "info",
        });
        refresh();
      } else if (result.status === "needs-source-offer") {
        notify("Choose the programme this setup came from first.", {
          type: "warning",
        });
      } else if (result.status === "source-offer-mismatch") {
        notify(
          `That programme does not include ${result.unmatchedKeys.join(", ")}, so the setup did not come from it.`,
          { type: "warning" },
        );
      } else if (result.status === "terminal-enrollment") {
        notify("This client has finished — their record stays as it is.", {
          type: "warning",
        });
      } else {
        notify("Could not repair this onboarding.", { type: "warning" });
      }
    } catch {
      notify("ra.notification.http_error", { type: "error" });
    } finally {
      setRepairing(false);
    }
  };

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Onboarding needs repair</span>
            <span className="text-sm text-muted-foreground">
              {previousName
                ? `This client is in ${currentName}, but their onboarding is still set up for ${previousName}.`
                : `This client is in ${currentName}, but their onboarding is set up for a different programme.`}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            className="self-start sm:self-auto"
            onClick={() => setOpen(true)}
          >
            Repair onboarding
          </Button>
        </CardContent>
      </Card>

      {open && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Repair onboarding</DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Current programme</span>
                <span>{currentName}</span>
              </div>

              {needsSource && (
                <div className="flex flex-col gap-1 text-sm">
                  <label
                    className="text-muted-foreground"
                    htmlFor="repair-previous-offer"
                  >
                    Previous setup
                  </label>
                  <select
                    id="repair-previous-offer"
                    className="border rounded-md px-2 py-1 text-sm"
                    value={selectedId}
                    onChange={(event) => setPreviousOfferId(event.target.value)}
                  >
                    <option value="">Choose a programme…</option>
                    {candidates.map((candidate) => (
                      <option
                        key={candidate.offer.id}
                        value={String(candidate.offer.id)}
                      >
                        {candidate.offer.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-muted-foreground">
                    {proposed != null
                      ? "Suggested from the current onboarding setup."
                      : "More than one programme fits this setup, so pick the right one."}
                  </span>
                </div>
              )}

              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                <span>This will:</span>
                <ul className="list-disc pl-5">
                  {plan.keptDone.length > 0 && (
                    <li>{`Keep ${listOf(plan.keptDone)}`}</li>
                  )}
                  {plan.added.length > 0 && (
                    <li>{`Add ${listOf(plan.added)}`}</li>
                  )}
                  {renamed.length > 0 && (
                    <li>{`Update ${listOf(renamed)} to ${currentName}`}</li>
                  )}
                  {plan.retired.length > 0 && (
                    <li>{`Remove ${listOf(plan.retired)} from current onboarding`}</li>
                  )}
                  <li>
                    Keep the original application and sales call unchanged
                  </li>
                </ul>
              </div>

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpen(false)}
                  disabled={repairing}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={repair}
                  disabled={repairing || (needsSource && !selected)}
                >
                  {repairing ? "Repairing…" : "Repair onboarding"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};

const listOf = (labels: string[]) =>
  labels.length <= 1
    ? labels.join("")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
