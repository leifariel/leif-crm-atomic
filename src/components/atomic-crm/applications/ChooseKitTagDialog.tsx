import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { KitTagPicker } from "./KitTagPicker";
import type { KitTag } from "./kitTagActions";

// Choosing a Kit tag, as a bounded action over the page you were already on.
//
// Picking a tag is exactly the shape the CRM's lightbox convention describes:
// it starts from a record being configured, asks for one choice, and ends. It
// used to happen two different ways — the Cohort form rendered the catalog
// inline and the Program form expanded it underneath a row — which is how the
// Cohort page came to display a list of somebody's Kit tags merely because it
// had been opened.
//
// Now both go through here, so the catalog is only ever on screen because Leif
// asked to choose a tag, and cancelling leaves the record exactly as it was.
export const ChooseKitTagDialog = ({
  open,
  onOpenChange,
  title = "Choose Kit tag",
  onSelect,
  onClear,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  onSelect: (tag: KitTag) => void;
  // Offered only where clearing is a configuration the database accepts.
  onClear?: () => void;
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        {/* `active` is the picker's explicit selection mode: it loads and
            shows the catalog here because this dialog IS the act of
            choosing. Nothing else mounts it. */}
        <KitTagPicker
          active={open}
          value={null}
          onChange={(tag) => {
            if (!tag) return;
            onSelect(tag);
            onOpenChange(false);
          }}
        />

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {onClear ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onClear();
                onOpenChange(false);
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>
    </DialogContent>
  </Dialog>
);
