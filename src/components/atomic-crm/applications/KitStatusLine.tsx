import { useState } from "react";
import { useDataProvider, useGetList, useNotify, useRefresh } from "ra-core";

import { Button } from "@/components/ui/button";

import type {
  Application,
  Cohort,
  KitSyncOperation,
  KitTagMapping,
} from "../types";
import { kitStatus } from "./kitStatus";
import { KitSyncCard } from "./KitSyncCard";
import { ManageKitTagsModal } from "./ManageKitTagsModal";
import { addKitTag } from "./kitTagActions";
import {
  kitEventRisk,
  NEEDS_HIGHER_CARE_EMAIL_NOTE,
} from "./kitAutomationRisk";
import { ConfirmKitTagsDialog } from "./ConfirmKitTagsDialog";
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
  const [managing, setManaging] = useState(false);
  const [addingRequired, setAddingRequired] = useState(false);
  const [confirmingAdd, setConfirmingAdd] = useState(false);

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

  // Deterministic: it adds exactly the tags this application's CURRENT state
  // calls for and has not had confirmed. Leif never picks a decision tag from
  // here, and a tag that already succeeded is never asked for again.
  const onAddRequired = async () => {
    const missing = status.required.filter((tag) => !tag.done);
    setAddingRequired(true);
    try {
      for (const tag of missing) {
        await addKitTag(dataProvider, {
          contactId: application.contact_id,
          kitTagId: tag.kitTagId,
          kitTagName: tag.kitTagName,
          applicationId: application.id,
        });
      }
      notify(
        missing.length === 1
          ? `${missing[0].kitTagName} queued for Kit.`
          : `${missing.length} tags queued for Kit.`,
        { type: "info" },
      );
    } catch {
      notify("Could not reach Kit just now. Try again in a moment.", {
        type: "error",
      });
    } finally {
      setAddingRequired(false);
      refresh();
    }
  };

  // Adding a decision tag is the act that can actually send something, so it
  // asks first. The decision click itself never tags and never emails; this
  // button is where that becomes possible, and ManageKitTagsModal already
  // confirms the same way for a hand-picked tag.
  const missingRequired =
    status.kind === "manual-action" || status.kind === "attention"
      ? status.required.filter((tag) => !tag.done)
      : [];
  const risky = missingRequired.filter(
    (tag) => kitEventRisk(tag.event) === "sends-email",
  );
  const onAddRequiredClick = () => {
    if (risky.length > 0) {
      setConfirmingAdd(true);
      return;
    }
    void onAddRequired();
  };

  const confirmAddSection = confirmingAdd ? (
    <ConfirmKitTagsDialog
      tags={missingRequired}
      busy={addingRequired}
      onCancel={() => setConfirmingAdd(false)}
      onConfirm={() => {
        setConfirmingAdd(false);
        void onAddRequired();
      }}
    />
  ) : null;

  const manageButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setManaging(true)}
    >
      Manage Kit tags
    </Button>
  );

  const modal = managing ? (
    <ManageKitTagsModal
      contactId={application.contact_id}
      applicationId={application.id}
      onOpenChange={(open) => {
        if (!open) setManaging(false);
      }}
    />
  ) : null;

  if (status.kind === "attention") {
    return (
      <>
        <KitSyncCard status={status} retrying={retrying} onRetry={onRetry} />
        <div className="flex pt-1">{manageButton}</div>
        {confirmAddSection}
        {modal}
      </>
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
        {/* Already asked for and on its way. Without this the page read
            exactly as it did before the click, which is how somebody ends up
            asking for the same tag twice. */}
        {status.kind === "manual-syncing" && (
          <span className="text-xs text-muted-foreground">
            {status.required.filter((tag) => !tag.done).length} tag
            {status.required.filter((tag) => !tag.done).length === 1
              ? ""
              : "s"}{" "}
            queued
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

      {/* The one thing a Needs Higher Care decision must never let anybody
          assume. The tag can land and still no email has gone: Leif has not
          written that automation, and the CRM does not pretend otherwise. */}
      {application.status === "needs_higher_care" && (
        <span className="text-xs text-muted-foreground">
          {NEEDS_HIGHER_CARE_EMAIL_NOTE}
        </span>
      )}

      {status.kind !== "not-used" && (
        <div className="flex flex-wrap gap-2 pt-1">
          {status.kind === "manual-action" &&
            status.required.some((tag) => !tag.done) && (
              <Button
                type="button"
                size="sm"
                disabled={addingRequired || confirmingAdd}
                onClick={onAddRequiredClick}
              >
                Add required tags
              </Button>
            )}
          {manageButton}
        </div>
      )}
      {confirmAddSection}
      {modal}
    </div>
  );
};
