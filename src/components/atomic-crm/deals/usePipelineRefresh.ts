import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { PIPELINE_RESOURCES } from "./pipelineQuery";

/**
 * After a write that changes what the Pipeline shows, re-read it from the
 * server.
 *
 * Authoritative refetch rather than cache surgery, on purpose. A stage edit
 * can change stage, outcome, stage_entered_at and an Enrollment's status at
 * once, and can move a card INTO a list it was never in (Won -> Decision
 * leaves the synthetic Onboarding query and has to enter the board's own).
 * Patching the cached rows in place — what a pessimistic react-admin save
 * does — updates a card the cache already holds and cannot add one it does
 * not. So every Pipeline query is invalidated, and the columns re-derive
 * from what the server says.
 *
 * Resolves once the refetch of every ACTIVE pipeline query has finished, so
 * a caller can drop an optimistic placement only when the real one is in.
 */
export const usePipelineRefresh = () => {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      Promise.all(
        PIPELINE_RESOURCES.map((resource) =>
          queryClient.invalidateQueries({ queryKey: [resource] }),
        ),
      ).then(() => undefined),
    [queryClient],
  );
};
