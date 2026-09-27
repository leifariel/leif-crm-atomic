import { useState } from "react";
import { useDataProvider, useGetList, useNotify, useRefresh } from "ra-core";

import { Button } from "@/components/ui/button";

import { describePlan, transferClientOffer } from "./transferClientOffer";
import type {
  Deal,
  Enrollment,
  EnrollmentOnboardingItem,
  Offer,
  OnboardingRequirementTemplate,
} from "../types";

// Moving a client to a different programme, as an explicit act.
//
// Jenna Smith's Opportunity was changed from Growing Yourself Up to The Living
// Example through the ordinary offer field. The Opportunity moved; her
// onboarding did not, so she spent the week with "Invite jenna smith to GYU
// Slack" on the dashboard and a GYU curriculum item against a programme she
// never bought. The offer is no longer a field on an enrolled client — the
// database refuses that edit — so this is the way, and it says what it will do
// before it does it.
export const MoveClientProgrammeAction = ({
  deal,
  items,
}: {
  deal: Deal;
  // Taken as a prop rather than looked up: this only ever renders where a
  // client already exists, and the transfer itself re-reads the Enrollment
  // server-side.
  enrollment: Enrollment;
  items: EnrollmentOnboardingItem[];
}) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [target, setTarget] = useState<Offer | null>(null);
  const [moving, setMoving] = useState(false);

  // retry: false, deliberately.
  //
  // This renders on every client page, including harnesses and states where
  // the programme list is not available — and ra-core retries a failed list
  // until the render times out. A control that OFFERS something must degrade
  // to offering nothing, never to hanging the page it sits on. Found by three
  // unrelated capacity tests timing out at 15s.
  const { data: offers } = useGetList<Offer>(
    "offers",
    {
      filter: { is_active: true },
      pagination: { page: 1, perPage: 50 },
      sort: { field: "name", order: "ASC" },
    },
    { retry: false },
  );

  // Only a different, individual programme can be moved into: a group round
  // is somebody's decision about which round, and this action never guesses
  // one. The server refuses it too.
  const candidates = (offers ?? []).filter(
    (offer) =>
      String(offer.id) !== String(deal.offer_id) && offer.type === "individual",
  );

  const { data: templates } = useGetList<OnboardingRequirementTemplate>(
    "onboarding_requirement_templates",
    {
      filter: { offer_id: target?.id, is_active: true },
      pagination: { page: 1, perPage: 50 },
      sort: { field: "sort_order", order: "ASC" },
    },
    { enabled: target != null, retry: false },
  );

  if (candidates.length === 0) return null;

  const plan = target != null ? describePlan(items, templates ?? []) : null;

  const move = async () => {
    if (!target) return;
    setMoving(true);
    try {
      const result = await transferClientOffer(dataProvider, {
        opportunityId: deal.id,
        toOfferId: target.id,
      });
      if (result.status === "transferred") {
        notify(`Moved to ${target.name}.`, { type: "info" });
        setTarget(null);
        refresh();
      } else if (result.status === "already-on-offer") {
        notify("This client is already on that programme.", { type: "info" });
        setTarget(null);
      } else if (result.status === "needs-cohort") {
        notify(result.reason, { type: "warning" });
      } else if (result.status === "no-enrollment") {
        notify(
          "This Opportunity has no client yet — change its programme on the Opportunity itself.",
          { type: "warning" },
        );
      } else {
        notify("Could not move this client.", { type: "warning" });
      }
    } catch {
      notify("ra.notification.http_error", { type: "error" });
    } finally {
      setMoving(false);
    }
  };

  if (!target) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {candidates.map((offer) => (
          <Button
            key={offer.id}
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 justify-start text-sm text-muted-foreground"
            onClick={() => setTarget(offer)}
          >
            {`Move client to ${offer.name}`}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-col gap-1 text-sm">
        <span>
          <span className="text-muted-foreground">Current: </span>
          {deal.offer_name_snapshot ?? "this programme"}
        </span>
        <span>
          <span className="text-muted-foreground">Move to: </span>
          {target.name}
        </span>
      </div>

      {plan && (
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <span>This will:</span>
          <ul className="list-disc pl-5">
            {plan.keptDone.length > 0 && (
              <li>{`keep ${listOf(plan.keptDone)} — already done`}</li>
            )}
            {plan.relabelled.length > 0 && (
              <li>{`update ${listOf(plan.relabelled)} to ${target.name}`}</li>
            )}
            {plan.retired.length > 0 && (
              <li>
                {`retire ${listOf(plan.retired)} and cancel their pending tasks`}
              </li>
            )}
            {plan.added.length > 0 && <li>{`add ${listOf(plan.added)}`}</li>}
            <li>keep the original application and sales call as they are</li>
          </ul>
        </div>
      )}

      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={move} disabled={moving}>
          {moving ? "Moving…" : `Yes — move to ${target.name}`}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setTarget(null)}
          disabled={moving}
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
