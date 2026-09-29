import { useState } from "react";
import { useDataProvider, useNotify, useRefresh } from "ra-core";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { addKitTag } from "../applications/kitTagActions";
import { retryKitSync } from "../applications/retryKitSync";
import { useKitWorkQueue, type KitManualRow } from "./useKitWorkQueue";

// ONE Dashboard item for everything Kit still needs, opening over the page.
//
// Not one row per person: five people needing a tag is one thing to do, and a
// Task each would bury the rest of Needs Attention under work that resolves
// itself the moment a tag is confirmed. It is derived, so it disappears on its
// own — nothing is ever ticked off by hand.
//
// "Kit needs attention" rather than "Tag applicants in Kit", because the list
// also holds automatic syncs that failed, which is not tagging work.
export const KitNeedsAttention = () => {
  const { isPending, manual, problems, count } = useKitWorkQueue();
  const [open, setOpen] = useState(false);

  if (isPending || count === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <Card className="p-0">
        <CardContent className="p-0">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
            onClick={() => setOpen(true)}
          >
            <span className="text-sm">Kit needs attention · {count}</span>
            <span className="text-xs text-muted-foreground">Open</span>
          </button>
        </CardContent>
      </Card>
      {open && (
        <KitWorkModal
          manual={manual}
          problems={problems}
          onOpenChange={(next) => setOpen(next)}
        />
      )}
    </div>
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
                  <li
                    key={String(row.applicationId)}
                    className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2"
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm">{row.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {[row.programme, row.cohort]
                          .filter(Boolean)
                          .join(" · ")}
                        {row.applicationStatus
                          ? ` · ${row.applicationStatus}`
                          : ""}
                      </span>
                      <ul className="text-xs text-muted-foreground flex flex-wrap gap-x-3">
                        {row.required.map((tag) => (
                          <li key={tag.kitTagId}>
                            {tag.done ? "✓" : "○"} {tag.kitTagName}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={working === String(row.applicationId)}
                      onClick={() => addRequired(row)}
                    >
                      Add required tags
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {problems.length > 0 && (
            <section className="flex flex-col gap-2">
              <span className="text-sm font-medium">Sync problems</span>
              <ul className="flex flex-col divide-y">
                {problems.map((row, index) => (
                  <li
                    key={`${row.contactId}-${index}`}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm">{row.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {row.tagName} did not reach Kit.
                      </span>
                    </div>
                    {row.isRetryable && row.applicationId != null && (
                      <Button
                        type="button"
                        size="sm"
                        disabled={working === `retry-${row.applicationId}`}
                        onClick={() => retry(row.applicationId)}
                      >
                        Retry Kit sync
                      </Button>
                    )}
                  </li>
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
