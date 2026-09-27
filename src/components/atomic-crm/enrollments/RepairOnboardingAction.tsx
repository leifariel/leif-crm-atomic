import { useState } from "react";
import { useDataProvider, useGetList, useNotify, useRefresh } from "ra-core";

import { Button } from "@/components/ui/button";

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

// Repairing a client's setup so it says what their Opportunity already says.
//
// Jenna Smith's Opportunity was changed from Growing Yourself Up to The Living
// Example before the transfer guard existed, and her onboarding stayed GYU. The
// transfer action cannot help her — her programme is already right, so it
// correctly answers "already on that programme" — and the mismatch is not
// something she should have to live with because the repair arrived after the
// damage.
//
// Detecting it is automatic and deterministic: the live requirement keys either
// are the current programme's template or they are not. Repairing it is not. It
// asks which programme the stale requirements came from and does not infer that
// silently, because the answer becomes permanent history.

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

  // retry: false and a bounded page, for the same reason MoveClientProgrammeAction
  // does it: a control that offers something must degrade to offering nothing
  // rather than hanging the page it sits on.
  const { data: offers } = useGetList<Offer>(
    "offers",
    {
      filter: {},
      pagination: { page: 1, perPage: 50 },
      sort: { field: "name", order: "ASC" },
    },
    { retry: false },
  );

  // Every active template, so the current programme's requirements and the
  // candidates that could account for the stale ones come from one read.
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

  // Nothing to say until both halves are loaded: "no templates" and "not
  // loaded yet" look identical, and only one of them is a mismatch.
  if (currentTemplates.length === 0) return null;
  if (TERMINAL.includes(enrollment.status)) return null;
  if (onboardingMatchesOffer(items, currentTemplates)) return null;

  const currentName =
    (offers ?? []).find((offer) => String(offer.id) === String(deal.offer_id))
      ?.name ??
    deal.offer_name_snapshot ??
    "the current programme";

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

  // A proposal, not a decision: exactly one programme whose template accounts
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
  const plan = describePlan(items, currentTemplates);
  // Only where a programme change is actually in evidence does one have to be
  // named. A template that merely gained a requirement is not a transfer.
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
        notify(`Setup repaired to ${currentName}.`, { type: "info" });
        setOpen(false);
        refresh();
      } else if (result.status === "already-aligned") {
        notify("This client's setup already matches their programme.", {
          type: "info",
        });
        setOpen(false);
        refresh();
      } else if (result.status === "needs-source-offer") {
        notify("Choose the programme this setup came from first.", {
          type: "warning",
        });
      } else if (result.status === "source-offer-mismatch") {
        notify(
          `That programme does not have ${result.unmatchedKeys.join(", ")}, so it is not where this setup came from.`,
          { type: "warning" },
        );
      } else if (result.status === "terminal-enrollment") {
        notify("This client has finished — their record stays as it is.", {
          type: "warning",
        });
      } else {
        notify("Could not repair this client's setup.", { type: "warning" });
      }
    } catch {
      notify("ra.notification.http_error", { type: "error" });
    } finally {
      setRepairing(false);
    }
  };

  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 justify-start text-sm"
          onClick={() => setOpen(true)}
        >
          Repair onboarding to current programme
        </Button>
        <span className="text-xs text-muted-foreground">
          {`Their setup is still from a different programme than ${currentName}.`}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-col gap-1 text-sm">
        <span>
          <span className="text-muted-foreground">Current programme: </span>
          {currentName}
        </span>
        <span className="text-muted-foreground">
          Their setup is still the previous programme&apos;s. Repairing brings
          the setup to {currentName} and leaves the programme itself alone.
        </span>
      </div>

      {needsSource && (
        <div className="flex flex-col gap-1 text-sm">
          <label
            className="text-muted-foreground"
            htmlFor="repair-previous-offer"
          >
            Which programme was this setup from?
          </label>
          <select
            id="repair-previous-offer"
            className="border rounded-md px-2 py-1 text-sm"
            value={selectedId}
            onChange={(event) => setPreviousOfferId(event.target.value)}
          >
            <option value="">Choose the previous programme…</option>
            {candidates.map((candidate) => (
              <option
                key={candidate.offer.id}
                value={String(candidate.offer.id)}
              >
                {candidate.offer.name}
              </option>
            ))}
          </select>
          {proposed != null && !previousOfferId && (
            <span className="text-xs text-muted-foreground">
              Proposed because its setup is the one on file. Confirm it or
              choose another — this is recorded as their history.
            </span>
          )}
          {proposed == null && (
            <span className="text-xs text-muted-foreground">
              More than one programme could account for this setup, so it is not
              guessed.
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        <span>This will:</span>
        <ul className="list-disc pl-5">
          {plan.keptDone.length > 0 && (
            <li>{`keep ${listOf(plan.keptDone)} — already done`}</li>
          )}
          {plan.relabelled.length > 0 && (
            <li>{`update ${listOf(plan.relabelled)} to ${currentName}`}</li>
          )}
          {plan.retired.length > 0 && (
            <li>
              {`retire ${listOf(plan.retired)} and cancel their pending tasks`}
            </li>
          )}
          {plan.added.length > 0 && <li>{`add ${listOf(plan.added)}`}</li>}
          <li>leave the programme on the Opportunity exactly as it is</li>
          <li>keep the original application and sales call as they are</li>
        </ul>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={repair}
          disabled={repairing || (needsSource && !selected)}
        >
          {repairing ? "Repairing…" : `Yes — repair setup to ${currentName}`}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(false)}
          disabled={repairing}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
};

const listOf = (labels: string[]) =>
  labels.length <= 1
    ? labels.join("")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
