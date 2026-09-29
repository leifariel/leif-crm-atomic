import { useState } from "react";
import { useDataProvider, useGetList, useNotify, useRefresh } from "ra-core";

import type { Application, KitSyncOperation } from "../types";
import { kitStatus } from "./kitStatus";
import { KitSyncCard } from "./KitSyncCard";
import { retryKitSync } from "./retryKitSync";

// One line, on the Application, answering the only Kit question that matters
// at a glance: is Kit handling this, or is the decision email mine to send?
//
//   Kit: Tagged ✓                      everything the current state needs has landed
//   Kit: Syncing…                      on its way
//   Kit: Not synced — email manually    THE one that has to be visible
//   Kit: Needs attention               a card, and Retry Kit sync
//   Kit: Not used                      Do Not Engage; Kit is deliberately out of it
//
// Silent for an imported historical record, which has no Kit work and no work
// for anyone — dressing that up as unsynced would put 98 finished records into
// Leif's attention and teach him to ignore the line that matters.
//
// No Kit call is made here, ever. Everything is read from the CRM's own
// kit_sync_operations rows, which is why this is instant and truthful about
// what the CRM actually knows rather than what Kit might say.
export const KitStatusLine = ({
  application,
}: {
  application: Application;
}) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [retrying, setRetrying] = useState(false);

  // retry: false, like every other control that renders beside a record — a
  // provider without this resource must degrade to saying nothing rather than
  // hanging the page it sits on.
  const { data: operations } = useGetList<KitSyncOperation>(
    "kit_sync_operations",
    {
      filter: { application_id: application.id },
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );

  const status = kitStatus({ application, operations: operations ?? [] });

  if (status.kind === "historical") return null;

  const onRetry = async () => {
    setRetrying(true);
    try {
      const { requeued } = await retryKitSync(dataProvider, application.id);
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

  if (status.kind === "attention") {
    return (
      <KitSyncCard status={status} retrying={retrying} onRetry={onRetry} />
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{status.label}</span>
      {/* Tag names are for debugging a sync, not for reading every day. */}
      {status.tags.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Kit detail</summary>
          <span>Applied: {status.tags.join(", ")}.</span>
        </details>
      )}
    </div>
  );
};
