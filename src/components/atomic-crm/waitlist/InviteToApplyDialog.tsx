import { useEffect, useState } from "react";
import {
  useDataProvider,
  useGetList,
  useNotify,
  useRefresh,
  useTranslate,
  type Identifier,
} from "ra-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { humanizeCohortName } from "../cohorts/humanizeCohortName";
import { formatISODateString } from "../deals/dealUtils";
import type { KitTagMapping } from "../types";
import {
  inviteOldestWaiting,
  waitlistInvitationCandidates,
  type InvitationCandidate,
  type InvitationExclusionReason,
} from "./waitlistInvitationActions";

// The confirmation before a batch of invitations goes out.
//
// Leif invites twenty-five or thirty people at once, so this is ONE
// confirmation over the whole group — never thirty dialogs — and it states
// the four things she needs to decide on: how many, which Kit tag they will
// get, and how far back the group reaches.
//
// What it deliberately does NOT do is decide who. It asks the server for the
// preview and then asks the server to do the work; the browser sends HOW
// MANY, never WHICH PEOPLE. A list on screen can be stale, filtered, or
// collapsed to three rows, and none of those may decide who gets an email.
// The one exception is a hand-picked selection, where the people ARE the
// instruction — and even then the server re-checks every one of them.

export const EXCLUSION_LABELS: Record<InvitationExclusionReason, string> = {
  "already-invited": "already invited",
  "invitation-in-flight": "an invitation is already on its way",
  "contact-missing": "no contact record",
  "do-not-engage": "Do Not Engage",
  "no-email": "no email address",
  "already-applied": "has already applied",
  "already-a-client": "already a client",
  "kit-refused-this-address-before": "Kit refused this address before",
};

export type InviteMode =
  | { kind: "oldest"; count: number }
  | { kind: "selected"; entryIds: Identifier[] };

export const InviteToApplyDialog = ({
  open,
  onOpenChange,
  offerId,
  offerName,
  cohortId,
  cohortName,
  mode,
  onConfirmed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offerId: Identifier;
  offerName: string;
  cohortId: Identifier | null;
  cohortName?: string | null;
  mode: InviteMode;
  onConfirmed: () => void;
}) => {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<InvitationCandidate[] | null>(
    null,
  );

  // The programme's own tag for an invitation. Named in the confirmation
  // because it is the thing that actually reaches the person — Leif hangs
  // an automation off it, and sending the wrong one is not recoverable.
  const { data: mappings } = useGetList<KitTagMapping>(
    "kit_tag_mappings",
    {
      filter: {},
      pagination: { page: 1, perPage: 100 },
      sort: { field: "offer_id", order: "ASC" },
    },
    { retry: false, enabled: open },
  );
  const mapping = (mappings ?? []).find(
    (row) =>
      String(row.offer_id) === String(offerId) &&
      row.event === "waitlist_invited",
  );

  useEffect(() => {
    if (!open) {
      setCandidates(null);
      return;
    }
    let live = true;
    void waitlistInvitationCandidates(dataProvider, { offerId, cohortId })
      .then((rows) => {
        if (live) setCandidates(rows);
      })
      .catch(() => {
        if (live) setCandidates([]);
      });
    return () => {
      live = false;
    };
  }, [open, dataProvider, offerId, cohortId]);

  const eligible = (candidates ?? []).filter((row) => row.eligible);
  const asked =
    mode.kind === "oldest"
      ? eligible.slice(0, mode.count)
      : (candidates ?? []).filter((row) =>
          mode.entryIds.some(
            (id) => String(id) === String(row.waitlistEntryId),
          ),
        );
  const askedEligible = asked.filter((row) => row.eligible);
  const askedExcluded = asked.filter((row) => !row.eligible);
  // For the oldest-N path, everybody passed over on the way down the list.
  const passedOver =
    mode.kind === "oldest"
      ? (candidates ?? []).filter(
          (row) =>
            !row.eligible &&
            askedEligible.length > 0 &&
            row.joinedAt <= askedEligible[askedEligible.length - 1]!.joinedAt,
        )
      : askedExcluded;

  const oldestJoined = askedEligible[0]?.joinedAt ?? null;
  const newestJoined =
    askedEligible[askedEligible.length - 1]?.joinedAt ?? null;
  const day = (value: string | null) =>
    value ? formatISODateString(value.split("T")[0]!) : "—";

  const handleConfirm = async () => {
    setBusy(true);
    try {
      const result = await inviteOldestWaiting(dataProvider, {
        offerId,
        cohortId,
        // How many, not which — see the note at the top of this file.
        limit: mode.kind === "oldest" ? mode.count : null,
        entryIds: mode.kind === "selected" ? mode.entryIds : null,
        label:
          mode.kind === "oldest"
            ? `Oldest ${mode.count} waiting`
            : "Selected from the waitlist",
      });

      if (result.status === "not-configured") {
        notify(
          translate("resources.waitlist_entries.invite.not_configured", {
            _: "%{programme} has no Kit tag for an invitation yet. Set it on the programme first.",
            programme: offerName,
          }),
          { type: "warning" },
        );
        return;
      }
      if (result.status === "nobody-eligible") {
        notify(
          translate("resources.waitlist_entries.invite.nobody", {
            _: "Nobody was invited — everybody asked for was already invited, has applied, or cannot be emailed.",
          }),
          { type: "warning" },
        );
        return;
      }
      if (result.status === "queued") {
        notify(
          translate("resources.waitlist_entries.invite.queued", {
            _: "%{count} invitation queued. They stay Waiting until Kit confirms the tag. |||| %{count} invitations queued. They stay Waiting until Kit confirms each tag.",
            smart_count: result.queued,
            count: result.queued,
          }),
          { type: "info" },
        );
        onConfirmed();
        onOpenChange(false);
        return;
      }
      notify(
        translate("resources.waitlist_entries.invite.nothing_asked", {
          _: "Nothing was asked for.",
        }),
        { type: "warning" },
      );
    } catch {
      notify("ra.notification.http_error", { type: "error" });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const title =
    mode.kind === "oldest"
      ? translate("resources.waitlist_entries.invite.title_oldest", {
          _: "Invite %{count} people to apply to %{programme}",
          count: askedEligible.length,
          programme: offerName,
        })
      : translate("resources.waitlist_entries.invite.title_selected", {
          _: "Invite selected to apply to %{programme}",
          programme: offerName,
        });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md gap-0 p-0"
        aria-describedby={undefined}
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-5 py-4 text-sm">
          {cohortName && (
            <p className="text-xs text-muted-foreground">
              {humanizeCohortName(cohortName, offerName)}
            </p>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {translate("resources.waitlist_entries.invite.kit_tag", {
                _: "Kit tag",
              })}
            </span>
            <span className="font-medium">
              {mapping?.kit_tag_name ??
                translate("resources.waitlist_entries.invite.no_tag", {
                  _: "Not set for this programme yet",
                })}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {translate("resources.waitlist_entries.invite.oldest_joined", {
                  _: "Oldest joined",
                })}
              </span>
              <span>{day(oldestJoined)}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {translate("resources.waitlist_entries.invite.newest_joined", {
                  _: "Newest joined",
                })}
              </span>
              <span>{day(newestJoined)}</span>
            </div>
          </div>

          {candidates != null && askedEligible.length < 1 && (
            <p className="text-sm text-muted-foreground">
              {translate("resources.waitlist_entries.invite.none_eligible", {
                _: "Nobody here can be invited right now.",
              })}
            </p>
          )}

          {/* Who was passed over, and why. A count alone is not something
              anybody can act on. */}
          {passedOver.length > 0 && (
            <div className="flex flex-col gap-1 rounded-md border px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {translate("resources.waitlist_entries.invite.skipped", {
                  _: "%{count} skipped |||| %{count} skipped",
                  smart_count: passedOver.length,
                  count: passedOver.length,
                })}
              </span>
              <ul className="text-xs text-muted-foreground">
                {passedOver.slice(0, 6).map((row) => (
                  <li key={row.waitlistEntryId}>
                    {row.name} —{" "}
                    {row.exclusionReason
                      ? EXCLUSION_LABELS[row.exclusionReason]
                      : ""}
                  </li>
                ))}
                {passedOver.length > 6 && (
                  <li>
                    {translate("crm.preview.more", {
                      _: "%{count} more",
                      count: passedOver.length - 6,
                    })}
                  </li>
                )}
              </ul>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {translate("resources.waitlist_entries.invite.delivery_note", {
              _: "Each person gets the Kit tag above. Nobody stops being Waiting until Kit confirms their tag.",
            })}
          </p>
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {translate("ra.action.cancel", { _: "Cancel" })}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={busy || askedEligible.length === 0 || mapping == null}
          >
            {translate("resources.waitlist_entries.invite.confirm", {
              _: "Invite %{count}",
              count: askedEligible.length,
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
