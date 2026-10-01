import { useGetList } from "ra-core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { ClientSession, Offer } from "../types";
import { formatTimestampString } from "../deals/dealUtils";

// The sessions behind "Sessions · N" on the History card.
//
// The count used to be a link to /client-sessions, a route that has never
// existed in this app — it was dead the day it was written (c84f19bf) and
// nothing tested it, so clicking it reached Not Found. Denise Cormier has ten
// sessions and that is exactly what happened.
//
// It is a lightbox rather than a page because of what the data turned out to
// be: ClientShow owns the real session workspace, but it is per-ENROLLMENT,
// and every one of the 22 production contacts who has sessions has no
// enrollment at all — their appointments carry a null enrollment_id. So there
// is no client page to send Leif to. This is a bounded question asked from a
// Contact he is already reading, which is exactly what the CRM's lightbox
// convention is for.
//
// It reports, and offers nothing to act on. Marking a no-show, resolving
// cadence and the rest live on ClientShow, where an enrollment gives them
// meaning; inventing a second place to do them is how two of them end up
// disagreeing.
export const ContactSessionsDialog = ({
  open,
  onOpenChange,
  sessions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: ClientSession[];
}) => {
  const { data: offers } = useGetList<Offer>(
    "offers",
    {
      filter: {},
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );

  const offerName = (id: ClientSession["offer_id"]) =>
    (offers ?? []).find((offer) => String(offer.id) === String(id))?.name ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sessions · {sessions.length}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {sessions.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              No sessions booked.
            </span>
          ) : (
            <ul className="flex max-h-96 flex-col divide-y overflow-y-auto">
              {sessions.map((session) => (
                <li
                  key={String(session.id)}
                  data-session-row=""
                  className="grid grid-cols-1 items-start gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm">
                      {formatTimestampString(session.scheduled_at)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {offerName(session.offer_id)}
                    </span>
                  </span>
                  {/* What actually happened outranks what was scheduled: a
                      kept booking and one nobody attended are not the same
                      fact, and the status column alone cannot say so. */}
                  <span className="text-xs text-muted-foreground sm:justify-self-end">
                    {session.no_show_at
                      ? "No-show"
                      : session.cancelled_at
                        ? "Cancelled"
                        : session.status}
                  </span>
                </li>
              ))}
            </ul>
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
