import { useState } from "react";
import {
  useDataProvider,
  useGetList,
  useNotify,
  useRefresh,
  type Identifier,
} from "ra-core";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import {
  kitFailureSentence,
  kitSyncState,
  type KitSyncOperation,
} from "./kitSyncState";
import { retryKitSync } from "./retryKitSync";

// Whether this applicant actually reached Leif's list.
//
// Quiet when it is fine — one muted line naming the tags that landed, because
// "which tag did they get" is the question he would otherwise open Kit to
// answer. A card only when somebody has to do something, in the same rounded
// operational language every other "this needs you" card on this CRM uses.
//
// It says nothing about the application itself. The application, the decision
// and the Opportunity are true whatever Kit did; what is at stake here is only
// the email that follows.

export const KitSyncCard = ({
  applicationId,
}: {
  applicationId: Identifier;
}) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [retrying, setRetrying] = useState(false);

  // retry: false, like every other control that renders beside a record —
  // a project whose data provider has no such resource must degrade to
  // saying nothing, never to hanging the page it sits on.
  const { data: operations } = useGetList<KitSyncOperation>(
    "kit_sync_operations",
    {
      filter: { application_id: applicationId },
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );

  const state = kitSyncState(operations ?? []);
  if (state.kind === "not-managed") return null;

  if (state.kind === "done") {
    return (
      <p className="text-xs text-muted-foreground">
        Added to Kit — {state.tags.join(", ")}.
      </p>
    );
  }

  if (state.kind === "working") {
    return (
      <p className="text-xs text-muted-foreground">
        Adding to Kit…
        {state.tags.length > 0
          ? ` Already applied: ${state.tags.join(", ")}.`
          : ""}
      </p>
    );
  }

  const onRetry = async () => {
    setRetrying(true);
    try {
      const { requeued } = await retryKitSync(dataProvider, applicationId);
      notify(
        requeued > 0
          ? "Asking Kit again."
          : "There is nothing left to retry — showing the current state.",
        { type: "info" },
      );
    } catch {
      notify("Could not reach Kit just now. Try again in a moment.", {
        type: "error",
      });
    } finally {
      setRetrying(false);
      refresh();
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Kit sync needs attention</span>
          <span className="text-sm text-muted-foreground">
            This applicant was saved in the CRM, but Kit did not finish syncing,
            so the emails that follow from this have not gone out.
          </span>
          <span className="text-sm text-muted-foreground">
            {state.isRetryable
              ? kitFailureSentence(state.failureClass)
              : "This has been waiting longer than it should."}
          </span>
          {/* The one place a technical detail is allowed, and it stays shut
              until asked for. */}
          {state.detail && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Details</summary>
              <span>{state.detail}</span>
            </details>
          )}
        </div>
        {state.isRetryable && (
          <Button
            type="button"
            size="sm"
            className="self-start sm:self-auto"
            disabled={retrying}
            onClick={onRetry}
          >
            Retry Kit sync
          </Button>
        )}
      </CardContent>
    </Card>
  );
};
