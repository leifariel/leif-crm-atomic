import { Draggable } from "@hello-pangea/dnd";
import { useGetList, useRedirect, RecordContextProvider } from "ra-core";
import { ReferenceField } from "@/components/admin/reference-field";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

import type { Deal, SalesCall } from "../types";
import { passedUnresolvedCallFor } from "../sales-calls/callPassed";
import { usePostSaleSetup } from "./postSaleSetupContext";
import { needsNextSalesStep } from "./needsNextSalesStep";
import { formatISODateString } from "./dealUtils";
import { crmDayKey, followUpBand, FOLLOW_UP_BANDS } from "./pipelineOrdering";

export const DealCard = ({ deal, index }: { deal: Deal; index: number }) => {
  if (!deal) return null;

  return (
    // A sold Opportunity sitting in Onboarding is not dragged anywhere: it
    // leaves the board by having its setup finished. Dragging one would
    // silently rewrite the sale.
    <Draggable
      draggableId={String(deal.id)}
      index={index}
      isDragDisabled={deal.stage === "won"}
    >
      {(provided, snapshot) => (
        <DealCardContent provided={provided} snapshot={snapshot} deal={deal} />
      )}
    </Draggable>
  );
};

// The one thing still standing between this sale and the client being set
// up — "Payment setup pending", "Contract pending". One line, because the
// card has to be readable at a glance; the full checklist is in the drawer.
const PostSaleBlockerLine = ({ deal }: { deal: Deal }) => {
  const setup = usePostSaleSetup(deal.id);
  if (!setup?.headline) return null;
  return (
    <p className="text-xs text-amber-700 dark:text-amber-500 mt-1 truncate">
      {setup.headline}
      {setup.blockers.length > 1 && ` +${setup.blockers.length - 1} more`}
    </p>
  );
};

export const DealCardContent = ({
  provided,
  snapshot,
  deal,
}: {
  provided?: any;
  snapshot?: any;
  deal: Deal;
}) => {
  const redirect = useRedirect();
  const handleClick = () => {
    redirect(`/deals/${deal.id}/show`, undefined, undefined, undefined, {
      _scrollToTop: false,
    });
  };

  return (
    <div
      className="cursor-pointer"
      {...provided?.draggableProps}
      {...provided?.dragHandleProps}
      ref={provided?.innerRef}
      onClick={handleClick}
    >
      <RecordContextProvider value={deal}>
        <Card
          className={`py-3 transition-all duration-200 ${
            snapshot?.isDragging
              ? "opacity-90 transform rotate-1 shadow-lg"
              : "shadow-sm hover:shadow-md"
          }`}
        >
          <CardContent className="px-3 flex flex-col">
            <div className="flex-1 flex items-center gap-2">
              <p className="flex-1 text-sm font-medium mb-0">
                <ReferenceField
                  source="contact_id"
                  reference="contacts"
                  link={false}
                />
              </p>
              <NextSalesStepBadge deal={deal} />
              <CallPassedBadge deal={deal} />
            </div>
            <p className="text-xs text-muted-foreground mt-1 truncate">
              {/* What they are applying for. Money deliberately does NOT
                  appear here: the Pipeline is an operational workflow —
                  who needs what done next — not a revenue forecast, and a
                  "$4.00K" on every card read as a running total Leif was
                  meant to act on. The commercial terms still live in the
                  Opportunity drawer, where they answer a real question.
                  Nothing stored is removed. */}
              <ReferenceField
                source="offer_id"
                reference="offers"
                link={false}
              />
            </p>
            <DecisionFollowUpLine deal={deal} />
            <PostSaleBlockerLine deal={deal} />
          </CardContent>
        </Card>
      </RecordContextProvider>
    </div>
  );
};

// "Somebody has to decide what happens next with this person."
//
// A no-show used to set outcome = 'lost', so the card simply left the
// board and the question never had to be asked. It no longer does, which
// means the question is real — and it is DERIVED, never stored: active
// attempt, latest call cancelled or no-show, nothing booked since. See
// needsNextSalesStep.ts.
//
// This replaces a badge that read only the highest-id sales call and only
// while the stage still said Call Booked. Both were wrong: the highest id
// is the most recently CREATED row rather than the latest call (Mihaela's
// case), and a no-show now moves the stage to Approved, so that badge
// would never have appeared again.
//
// It disappears on its own the moment a genuine rebooking exists, because
// its premise stops being true. Nothing has to clear it.
const NextSalesStepBadge = ({ deal }: { deal: Deal }) => {
  const { data: salesCalls } = useGetList<SalesCall>("sales_calls", {
    filter: { opportunity_id: deal.id },
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });

  const reason = needsNextSalesStep(deal, salesCalls);
  if (!reason) return null;

  return (
    <Badge variant="destructive" className="shrink-0">
      {reason === "call_cancelled" ? "Cancelled" : "No-show"}
    </Badge>
  );
};

// "The call has been and gone and nobody has written it up."
//
// DERIVED AND INERT. It reads the same sales-call model the column sorts by
// and writes nothing: no stage change, no attendance, no task. A passed call
// is NOT a no-show — a no-show is something Leif observed and recorded, and
// this is only the CRM noticing that nobody has told it anything yet. See
// sales-calls/callPassed.ts.
//
// It disappears by itself once the call is completed or cancelled, because
// the call stops being `booked` and the premise stops being true.
//
// Deliberately `secondary` rather than `destructive`: the red badge beside
// it means something went wrong, and this means something is owed.
const CallPassedBadge = ({ deal }: { deal: Deal }) => {
  const { data: salesCalls } = useGetList<SalesCall>("sales_calls", {
    filter: { opportunity_id: deal.id },
    pagination: { page: 1, perPage: 50 },
    sort: { field: "id", order: "ASC" },
  });

  if (deal.stage !== "call_booked") return null;
  if (!passedUnresolvedCallFor(deal.id, salesCalls)) return null;

  return (
    <Badge variant="secondary" className="shrink-0">
      Call passed
    </Badge>
  );
};

// The commitment Leif made, on the card that is about keeping it.
//
// `deals.follow_up_date` is the ONLY source, and the band comes from
// `followUpBand` — the same function the column sorts by, so the card and
// its own position can never disagree. Deliberately NOT read from the
// follow-up Task: the Task projects this date, it does not own it.
//
// Rendered only while the lifecycle context is Decision. Production holds one
// active non-Decision Opportunity still carrying a `follow_up_date`, and
// presenting that as a live Decision commitment would be a lie about where
// that person actually is.
//
// A date passing changes this text and nothing else. It does not move the
// stage.
const DecisionFollowUpLine = ({ deal }: { deal: Deal }) => {
  if (deal.stage !== "decision") return null;
  if (!deal.follow_up_date) return null;

  const band = followUpBand(deal, crmDayKey(Date.now()));
  if (band === FOLLOW_UP_BANDS.overdue) {
    return (
      <p className="text-xs text-red-700 dark:text-red-400 mt-1 truncate">
        Follow-up overdue · {formatISODateString(deal.follow_up_date)}
      </p>
    );
  }
  if (band === FOLLOW_UP_BANDS.today) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-500 mt-1 truncate">
        Follow up today
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground mt-1 truncate">
      Decision due {formatISODateString(deal.follow_up_date)}
    </p>
  );
};
