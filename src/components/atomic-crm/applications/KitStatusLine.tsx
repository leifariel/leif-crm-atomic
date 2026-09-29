import { useState } from "react";
import { useDataProvider, useGetList, useNotify, useRefresh } from "ra-core";

import type {
  Application,
  Cohort,
  KitSyncOperation,
  KitTagMapping,
} from "../types";
import { kitStatus } from "./kitStatus";
import { KitSyncCard } from "./KitSyncCard";
import { retryKitSync } from "./retryKitSync";

// Is Kit handling this application, or is it Leif's to do by hand?
//
// One compact strip, in the CRM's own bordered-container language rather than
// naked text floating between two cards — the information was right and the
// presentation was not. It sits at the foot of the Application's own content,
// where he looks straight after recording a decision.
//
//   Kit: Tagged ✓                    automatic, and everything current landed
//   Kit: Syncing…                    automatic, on its way
//   Kit: Needs attention             a card, and Retry Kit sync
//   Kit: Manual — action needed      predates the integration; tags are his
//   Kit: Manual — up to date ✓       every tag the CURRENT state needs is confirmed
//   Kit: Automation not configured   this programme has no Kit tags
//   Kit: Not used                    Do Not Engage
//
// Silent only for an imported historical record, which has no Kit work and no
// work for anyone. No Kit call is made here: every answer comes from the CRM's
// own durable rows.
export const KitStatusLine = ({
  application,
}: {
  application: Application;
}) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [retrying, setRetrying] = useState(false);

  // retry: false throughout — a provider without these resources must degrade
  // to saying nothing rather than hanging the page it sits on.
  const { data: applicationOperations } = useGetList<KitSyncOperation>(
    "kit_sync_operations",
    {
      filter: { application_id: application.id },
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );
  // A manual tag is about the human, not this application, so the person's own
  // confirmed tags are what say whether the manual work is done.
  const { data: contactOperations } = useGetList<KitSyncOperation>(
    "kit_sync_operations",
    {
      filter: { contact_id: application.contact_id, origin: "manual_owner" },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );
  const { data: mappings } = useGetList<KitTagMapping>(
    "kit_tag_mappings",
    {
      filter: {},
      pagination: { page: 1, perPage: 100 },
      sort: { field: "offer_id", order: "ASC" },
    },
    { retry: false },
  );
  const { data: settings } = useGetList(
    "kit_integration_settings",
    {
      filter: {},
      pagination: { page: 1, perPage: 1 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );
  const { data: cohorts } = useGetList<Cohort>(
    "cohorts",
    {
      filter: { id: application.intended_cohort_id },
      pagination: { page: 1, perPage: 1 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false, enabled: application.intended_cohort_id != null },
  );

  const cohort = cohorts?.[0];
  const status = kitStatus({
    application,
    operations: [
      ...(applicationOperations ?? []),
      ...(contactOperations ?? []),
    ],
    mappings: mappings ?? [],
    cohortTag:
      cohort?.kit_tag_id != null
        ? {
            kitTagId: Number(cohort.kit_tag_id),
            kitTagName: String(cohort.kit_tag_name ?? ""),
          }
        : null,
    notBefore:
      (settings?.[0] as { not_before?: string } | undefined)?.not_before ??
      null,
  });

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
    <div className="rounded-md border px-3 py-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-sm">{status.label}</span>
        {status.kind === "manual-action" && (
          <span className="text-xs text-muted-foreground">
            {status.required.filter((tag) => !tag.done).length} tag
            {status.required.filter((tag) => !tag.done).length === 1
              ? ""
              : "s"}{" "}
            still to add
          </span>
        )}
      </div>
      {/* Which tags, when it is his to do — named, because "add the tags" is
          not an instruction until it says which. */}
      {status.required.length > 0 && (
        <ul className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
          {status.required.map((tag) => (
            <li key={tag.kitTagId}>
              {tag.done ? "✓" : "○"} {tag.kitTagName}
            </li>
          ))}
        </ul>
      )}
      {/* Tag names are for debugging a sync, not for reading every day. */}
      {status.required.length === 0 && status.tags.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Kit detail</summary>
          <span>Applied: {status.tags.join(", ")}.</span>
        </details>
      )}
    </div>
  );
};
