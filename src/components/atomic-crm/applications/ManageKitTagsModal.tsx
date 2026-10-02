import { useEffect, useState } from "react";
import { useDataProvider, useGetList, useNotify, useRefresh } from "ra-core";
import type { Identifier } from "ra-core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { KitSyncOperation, KitTagMapping } from "../types";
import { addKitTag, contactKitTags, type KitTag } from "./kitTagActions";
import { KitTagPicker } from "./KitTagPicker";
import { kitRiskSentence, kitTagRisk } from "./kitAutomationRisk";

// The person-level Kit tag manager, and the only one. An Application reaches
// the same component, because a manual tag is ultimately a tag on a human —
// building a second tag universe for Applications is how the two end up
// disagreeing about what somebody has been sent.
//
// First version adds only: no removal, no renaming, no bulk. Removal is a
// different decision with different consequences and it is not in this slice.
//
// Two sources of truth, named as such rather than blended:
//
//   what Kit reports   fetched on demand, only while this modal is open, so a
//                      Contact page never depends on the provider being up
//   what the CRM asked its own durable operations, which is what it can stand
//                      behind even when Kit cannot be reached
export const ManageKitTagsModal = ({
  contactId,
  applicationId = null,
  onOpenChange,
}: {
  contactId: Identifier;
  applicationId?: Identifier | null;
  onOpenChange: (open: boolean) => void;
}) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [chosen, setChosen] = useState<KitTag | null>(null);
  const [confirming, setConfirming] = useState<KitTag | null>(null);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<{
    tags: KitTag[];
    knownToKit: boolean;
  } | null>(null);
  const [providerError, setProviderError] = useState(false);

  const { data: operations } = useGetList<KitSyncOperation>(
    "kit_sync_operations",
    {
      filter: { contact_id: contactId },
      pagination: { page: 1, perPage: 200 },
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

  // On demand, and only here: the provider is asked while the modal is open
  // and never during ordinary page rendering.
  useEffect(() => {
    let cancelled = false;
    contactKitTags(dataProvider, contactId)
      .then((result) => {
        if (!cancelled) setProvider(result);
      })
      .catch(() => {
        if (!cancelled) setProviderError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dataProvider, contactId]);

  const pending = (operations ?? []).filter(
    (operation) =>
      operation.status === "pending" || operation.status === "processing",
  );
  const failed = (operations ?? []).filter(
    (operation) => operation.status === "failed",
  );

  const request = async (tag: KitTag) => {
    setAdding(true);
    try {
      const result = await addKitTag(dataProvider, {
        contactId,
        kitTagId: tag.id,
        kitTagName: tag.name,
        applicationId,
      });
      if (result.status === "requested") {
        // Queued, not done. The modal stays open so nothing here implies a
        // success that has not happened yet.
        notify(`${tag.name} queued for Kit.`, { type: "info" });
      } else if (result.status === "already-requested") {
        notify(`${tag.name} was already asked for.`, { type: "info" });
      } else if (result.status === "do-not-engage") {
        notify("This person is marked Do Not Engage, so Kit is not used.", {
          type: "warning",
        });
      } else {
        notify("That tag could not be requested.", { type: "warning" });
      }
      setChosen(null);
      setConfirming(null);
      refresh();
    } catch {
      notify("Could not reach Kit just now. Try again in a moment.", {
        type: "error",
      });
    } finally {
      setAdding(false);
    }
  };

  const onAdd = () => {
    if (!chosen) return;
    // One concise confirmation, and only where it is earned: an outcome tag
    // whose automation can send a real email. Every other tag adds silently.
    if (kitTagRisk(chosen.id, mappings ?? []) === "sends-email") {
      setConfirming(chosen);
      return;
    }
    void request(chosen);
  };

  const risk = chosen ? kitTagRisk(chosen.id, mappings ?? []) : "quiet";
  const riskNote = chosen ? kitRiskSentence(risk, chosen.name) : "";

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage Kit tags</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-1">
            <span className="text-sm font-medium">Kit tags</span>
            {providerError && (
              <span className="text-sm text-muted-foreground">
                Could not reach Kit just now, so this list is unavailable.
              </span>
            )}
            {!providerError && provider === null && (
              <span className="text-sm text-muted-foreground">
                Checking Kit…
              </span>
            )}
            {!providerError && provider !== null && (
              <>
                {provider.tags.length === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    {provider.knownToKit
                      ? "No tags on this person yet."
                      : "This person is not in Kit yet. Adding a tag will add them."}
                  </span>
                ) : (
                  <ul className="text-sm flex flex-wrap gap-x-3 gap-y-1">
                    {provider.tags.map((tag) => (
                      <li key={tag.id}>{tag.name}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {pending.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Queued: {pending.map((one) => one.kit_tag_name).join(", ")}.
              </span>
            )}
            {failed.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Did not reach Kit:{" "}
                {failed.map((one) => one.kit_tag_name).join(", ")}. It stays on
                the Kit work list until it does.
              </span>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <span className="text-sm font-medium">Add a tag</span>
            {/* This modal exists to add a tag, so choosing one is what it is
                already doing — the catalog and its search belong here. */}
            <KitTagPicker
              active
              value={chosen}
              onChange={setChosen}
              disabled={adding}
            />
            {/* Said once: the specific sentence when a tag is chosen, the
                general one until then. Both at once is what made the Add
                required tags confirmation too dense to read. */}
            {riskNote ? (
              <span className="text-xs text-muted-foreground">{riskNote}</span>
            ) : (
              <span className="text-xs text-muted-foreground">
                Adding a Kit tag may trigger an automation connected to that
                tag.
              </span>
            )}
          </section>

          {confirming && (
            <section className="rounded-md border px-3 py-2 flex flex-col gap-2">
              <span className="text-sm">Add {confirming.name}?</span>
              <span className="text-sm text-muted-foreground">
                Adding this tag may trigger a Kit automation connected to it.
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={adding}
                  onClick={() => void request(confirming)}
                >
                  Add tag
                </Button>
              </div>
            </section>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!chosen || adding || confirming !== null}
              onClick={onAdd}
            >
              Add tag
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
