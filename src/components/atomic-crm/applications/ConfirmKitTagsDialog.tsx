import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { KitRequiredTag } from "./kitStatus";
import { kitEventRisk, kitRiskWarning } from "./kitAutomationRisk";

// The one question asked before any Kit tag is queued, from wherever the
// owner asked for it. A lightbox, because it is the CRM's own language for a
// short bounded question begun from a record already being read — and because
// the inline version it replaces left the original "Add required tags" button
// live right above it, so the obvious second click did nothing at all.
//
// It names the tags, warns once if any of them is an outcome tag, and offers
// exactly two ways out. The Application and the Dashboard both use this; a
// second copy is how the two would start warning about different things.
export const ConfirmKitTagsDialog = ({
  tags,
  personName = null,
  busy = false,
  onCancel,
  onConfirm,
}: {
  // The tags that would actually be queued: already filtered to what is
  // missing, so the dialog never offers to re-add something confirmed.
  tags: KitRequiredTag[];
  personName?: string | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  const risky = tags
    .filter((tag) => kitEventRisk(tag.event) === "sends-email")
    .map((tag) => tag.kitTagName);
  const warning = kitRiskWarning(risky);
  const one = tags.length === 1;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {`Add ${tags.length} Kit tag${one ? "" : "s"}${
              personName ? ` for ${personName}` : ""
            }?`}
          </DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col gap-0.5 text-sm">
          {tags.map((tag) => (
            <li key={tag.kitTagId}>{tag.kitTagName}</li>
          ))}
        </ul>
        {/* One sentence, only when something here can actually set an
            automation off. No second generic line underneath it: saying it
            twice made the dense case denser and the quiet case alarming. */}
        {warning && (
          <p className="text-sm text-muted-foreground">⚠️ {warning}</p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={onConfirm}>
            {one ? "Add tag" : "Add tags"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
