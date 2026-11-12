import { DragDropContext, type OnDragEndResponder } from "@hello-pangea/dnd";
import { AlertTriangle } from "lucide-react";
import {
  useDataProvider,
  useGetList,
  useListContext,
  useNotify,
} from "ra-core";
import { useMemo, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { useConfigurationContext } from "../root/ConfigurationContext";
import type { Deal, SalesCall } from "../types";
import { DealColumn } from "./DealColumn";
import type { DealsByStage } from "./stages";
import { getDealsByStage } from "./stages";
import { applyDealStageDrop } from "./applyDealStageDrop";
import { isPipelineTruncated, PIPELINE_PAGE_SIZE } from "./pipelineQuery";
import { PostSaleSetupContext } from "./postSaleSetupContext";
import { describeStageEditRefusal } from "./stageEditRefusal";
import { useOnboardingPipeline } from "./useOnboardingPipeline";
import { usePipelineRefresh } from "./usePipelineRefresh";

/** A card the user has just dropped, shown in place until the server agrees. */
type PendingMove = { dealId: Deal["id"]; from: string; to: string };

export const DealListContent = () => {
  const { dealStages, dealPipelineStatuses } = useConfigurationContext();
  // Won (and any other configured pipeline-exit status) never renders as an
  // active Kanban column — it's excluded from the list query itself (see
  // DealList's filter), this just keeps the column set consistent with it.
  const activeDealStages = useMemo(
    () =>
      dealStages.filter((stage) => !dealPipelineStatuses.includes(stage.value)),
    [dealStages, dealPipelineStatuses],
  );
  const { data: unorderedDeals, total, isPending } = useListContext<Deal>();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refreshPipeline = usePipelineRefresh();

  // Won Opportunities whose setup is not finished. They are excluded from
  // the board's own query (Won is a pipeline-exit status), so they are
  // fetched separately and placed in the Onboarding column — the sale is
  // done, the setup work is not.
  const onboarding = useOnboardingPipeline();

  // Call Booked is ordered by the next genuine booked call, so the board
  // needs the calls themselves. Only booked ones matter for ordering.
  const { data: salesCalls } = useGetList<SalesCall>("sales_calls", {
    filter: { status: "booked" },
    pagination: { page: 1, perPage: PIPELINE_PAGE_SIZE },
    sort: { field: "scheduled_at", order: "ASC" },
  });

  // ONE authority for where a card sits: the server's rows, grouped.
  //
  // This used to be copied into local useState by an effect and then edited
  // in place by the drag handler, which gave the board two copies of the
  // truth that could disagree. It is now derived, every render, from the
  // queries themselves — so whatever invalidates them is, by construction,
  // what the board shows.
  const serverBoard = useMemo<DealsByStage>(() => {
    const board = getDealsByStage(
      unorderedDeals ?? [],
      activeDealStages,
      salesCalls,
    );
    // Onboarding is SYNTHETIC: every Won Opportunity whose post-sale
    // setup is unfinished, and nothing else. Deliberately NOT the rows
    // whose stage value happens to read "onboarding" — fourteen dormant
    // records were mechanically renamed from "committed" and never made
    // a sale, so the stage value alone is not eligibility.
    board.onboarding = [...onboarding.deals];
    return board;
  }, [unorderedDeals, activeDealStages, salesCalls, onboarding.deals]);

  // The only local state left: a drop in flight. It is an overlay on the
  // server's board, not a second board, and it is discarded the moment the
  // refetch that follows the write has landed — success or failure. A
  // refused write therefore cannot leave a card missing: the overlay goes
  // and the server's placement comes back.
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const dealsByStage = useMemo(
    () =>
      pendingMove ? applyPendingMove(serverBoard, pendingMove) : serverBoard,
    [serverBoard, pendingMove],
  );

  if (isPending) return null;

  const loaded = unorderedDeals?.length ?? 0;
  const truncated = isPipelineTruncated(loaded, total);

  const onDragEnd: OnDragEndResponder = (result) => {
    const { destination, source } = result;
    if (!destination || destination.droppableId === source.droppableId) return;

    const sourceDeal = dealsByStage[source.droppableId]?.[source.index];
    if (!sourceDeal) return;

    // Move the card immediately, to the END of the destination column —
    // not the drop index — because the shared "deals" stage-change hook
    // always stamps stage_entered_at to "now" and the column sorts
    // oldest-first, so the bottom is exactly where the real data will put
    // it once the update round-trips.
    setPendingMove({
      dealId: sourceDeal.id,
      from: source.droppableId,
      to: destination.droppableId,
    });

    // The durable half lives in applyDealStageDrop so it can be proven
    // without simulating a browser drag.
    applyDealStageDrop(dataProvider, { result, dealsByStage })
      .then((outcome) => {
        // A refused drop used to snap the card back and say nothing, so a
        // gesture that cannot work looked like one that had failed. Won
        // and Onboarding are the two columns this reaches: neither is a
        // stage you move a card into, and the board should say which it
        // is rather than leave Leif to guess.
        if (!outcome.applied && outcome.reason === "synthetic-column") {
          const to = result.destination?.droppableId;
          notify(
            to === "won"
              ? "resources.deals.drop.won_is_a_sale"
              : "resources.deals.drop.onboarding_is_derived",
            {
              type: "info",
              messageArgs: {
                _:
                  to === "won"
                    ? "A sale is recorded on the call or the prospect's decision, not by moving the card."
                    : "Onboarding shows itself: a card appears here once the sale is won and its setup is unfinished.",
              },
            },
          );
        }
      })
      .catch((error: unknown) => {
        // The database refused the move. Say why, in Leif's terms, and let
        // the refetch below put the card back where the server has it.
        const refusal = describeStageEditRefusal(error);
        notify(refusal.key, {
          type: "warning",
          messageArgs: { _: refusal.message },
        });
      })
      .then(() => refreshPipeline())
      .finally(() => setPendingMove(null));
  };

  return (
    <PostSaleSetupContext.Provider value={onboarding.setupByDeal}>
      {truncated && <PipelineTruncationNotice loaded={loaded} total={total!} />}
      <DragDropContext onDragEnd={onDragEnd}>
        <div className="flex gap-4 overflow-x-auto pb-2">
          {activeDealStages.map((stage) => (
            <DealColumn
              stage={stage.value}
              deals={dealsByStage[stage.value] ?? []}
              key={stage.value}
            />
          ))}
        </div>
      </DragDropContext>
    </PostSaleSetupContext.Provider>
  );
};

/**
 * Never again a board that quietly shows fewer people than exist. If the
 * server ever holds more active Opportunities than one page returns, this
 * says so, with both numbers, instead of dropping whoever moved last.
 */
const PipelineTruncationNotice = ({
  loaded,
  total,
}: {
  loaded: number;
  total: number;
}) => (
  <Card className="mb-4 border-destructive" role="alert">
    <CardContent className="flex items-center gap-3 py-3 text-sm">
      <AlertTriangle className="size-4 text-destructive shrink-0" />
      <span>
        The board is showing {loaded} of {total} open opportunities, so some
        people are not on it. Nothing has been lost — they are still under
        Contacts — but the board needs fixing before it can be trusted.
      </span>
    </CardContent>
  </Card>
);

// Places the dropped card at the end of its destination column, over the
// server's board. Immutability: builds new arrays rather than splicing the
// existing ones in place. If the server has already moved the card (the
// refetch won the race), the overlay is a no-op rather than a duplicate.
const applyPendingMove = (
  board: DealsByStage,
  { dealId, from, to }: PendingMove,
): DealsByStage => {
  const card = board[from]?.find((deal) => deal.id === dealId);
  if (!card || !board[to]) return board;
  return {
    ...board,
    [from]: board[from].filter((deal) => deal.id !== dealId),
    [to]: [...board[to].filter((deal) => deal.id !== dealId), card],
  };
};
