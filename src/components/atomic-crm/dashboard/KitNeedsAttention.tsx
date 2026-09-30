import { useState } from "react";
import { useDataProvider, useNotify, useRefresh } from "ra-core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { addKitTag } from "../applications/kitTagActions";
import { retryKitSync } from "../applications/retryKitSync";
import { KitWorkRow, KitWorkTags } from "./KitWorkRow";
import { useKitWorkQueue, type KitManualRow } from "./useKitWorkQueue";

// ONE Needs Attention item for everything Kit still needs, opening over the
// page.
//
// Not one row per person: four people needing a tag is one thing to do, and a
// Task each would bury the rest of Needs Attention under work that resolves
// itself the moment a tag is confirmed. It is derived, so it disappears on its
// own — nothing is ever ticked off by hand.
//
// It used to be a full-width strip of its own, floating below all the task
// cards, which made Kit look like a separate system Leif had to remember to
// look at. It is not: it is one more thing needing attention, so it lives in
// the box that already means exactly that. See DashboardTasks for how the
// heading count treats it — ONE row, whatever number it is reporting.
//
// "Kit needs attention" rather than "Tag applicants in Kit", because the list
// also holds automatic syncs that failed, which is not tagging work.
export const KitNeedsAttentionRow = () => {
  const { isPending, manual, problems, count } = useKitWorkQueue();
  const [open, setOpen] = useState(false);

  if (isPending || count === 0) return null;

  return (
    <>
      <button
        type="button"
        className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
        onClick={() => setOpen(true)}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm">Kit</span>
          <span className="text-xs text-muted-foreground">
            {count === 1
              ? "1 applicant needs attention"
              : `${count} applicants need attention`}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">Open</span>
      </button>
      {open && (
        <KitWorkModal
          manual={manual}
          problems={problems}
          onOpenChange={(next) => setOpen(next)}
        />
      )}
    </>
  );
};

const KitWorkModal = ({
  manual,
  problems,
  onOpenChange,
}: {
  manual: KitManualRow[];
  problems: ReturnType<typeof useKitWorkQueue>["problems"];
  onOpenChange: (open: boolean) => void;
}) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [working, setWorking] = useState<string | null>(null);

  // Deterministic: exactly the tags this application's CURRENT state calls for
  // and has not had confirmed. Nothing already succeeded is asked for again,
  // and Leif never picks a decision tag from here.
  const addRequired = async (row: KitManualRow) => {
    setWorking(String(row.applicationId));
    try {
      for (const tag of row.required.filter((one) => !one.done)) {
        await addKitTag(dataProvider, {
          contactId: row.contactId,
          kitTagId: tag.kitTagId,
          kitTagName: tag.kitTagName,
          applicationId: row.applicationId,
        });
      }
      notify(`Queued for Kit: ${row.name}.`, { type: "info" });
    } catch {
      notify("Could not reach Kit just now. Try again in a moment.", {
        type: "error",
      });
    } finally {
      setWorking(null);
      refresh();
    }
  };

  const retry = async (applicationId: KitManualRow["applicationId"] | null) => {
    if (applicationId == null) return;
    setWorking(`retry-${applicationId}`);
    try {
      await retryKitSync(dataProvider, applicationId);
      notify("Asking Kit again.", { type: "info" });
    } catch {
      notify("Could not reach Kit just now. Try again in a moment.", {
        type: "error",
      });
    } finally {
      setWorking(null);
      refresh();
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Kit needs attention</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {manual.length > 0 && (
            <section className="flex flex-col gap-2">
              <span className="text-sm font-medium">Manual Kit work</span>
              <ul className="flex flex-col divide-y">
                {manual.map((row) => (
                  <KitWorkRow
                    key={String(row.applicationId)}
                    name={row.name}
                    detail={`${[row.programme, row.cohort]
                      .filter(Boolean)
                      .join(" · ")}${
                      row.applicationStatus ? ` · ${row.applicationStatus}` : ""
                    }`}
                    tags={<KitWorkTags tags={row.required} />}
                    action={
                      <Button
                        type="button"
                        size="sm"
                        disabled={working === String(row.applicationId)}
                        onClick={() => addRequired(row)}
                      >
                        Add required tags
                      </Button>
                    }
                  />
                ))}
              </ul>
            </section>
          )}

          {problems.length > 0 && (
            <section className="flex flex-col gap-2">
              <span className="text-sm font-medium">Sync problems</span>
              <ul className="flex flex-col divide-y">
                {/* Same row component as the manual work above, so a sync
                    problem and a tag still owed read as one list rather than
                    two layouts that happen to be stacked. */}
                {problems.map((row, index) => (
                  <KitWorkRow
                    key={`${row.contactId}-${index}`}
                    name={row.name}
                    detail={`${row.tagName} did not reach Kit.`}
                    action={
                      row.isRetryable && row.applicationId != null ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={working === `retry-${row.applicationId}`}
                          onClick={() => retry(row.applicationId)}
                        >
                          Retry Kit sync
                        </Button>
                      ) : null
                    }
                  />
                ))}
              </ul>
            </section>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
