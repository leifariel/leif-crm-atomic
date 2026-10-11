import { useEffect, useRef, useState } from "react";
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
  invitableIn,
  inviteFromPreflight,
  passedOverIn,
  runWaitlistPreflight,
  type InvitationExclusionReason,
  type PreflightResult,
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

// Kit's own words, said the way Leif would say them.
export const KIT_STATE_LABELS: Record<string, string> = {
  "kit-cancelled": "unsubscribed in Kit",
  "kit-complained": "marked an email as spam",
  "kit-bounced": "their address bounces",
  "kit-inactive": "not active in Kit",
  "kit-unreachable": "Kit could not be reached",
  "kit-unconfirmed": "Kit did not confirm them",
  "beyond-the-number-asked-for": "beyond the number asked for",
};

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

const reasonLabel = (reason: string | null): string => {
  if (!reason) return "";
  if (reason in KIT_STATE_LABELS) return KIT_STATE_LABELS[reason]!;
  if (reason in EXCLUSION_LABELS) {
    return EXCLUSION_LABELS[reason as InvitationExclusionReason];
  }
  // An unknown word is shown as it is. Guessing at a friendly phrasing for
  // a reason nobody has reasoned about would be inventing meaning.
  return reason;
};

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
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [failed, setFailed] = useState(false);
  /** How many were asked for when this preview was taken. */
  const [approvedCount, setApprovedCount] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestedCount =
    mode.kind === "oldest" ? mode.count : mode.entryIds.length;

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

  // THE PREFLIGHT IS THE LIST. It asks the database who is eligible and
  // then asks KIT whether each of those people can actually be sent
  // anything — cancelled, complained, bounced and inactive are all people
  // who have told Kit to stop. Discovering that after Leif confirms "25"
  // is how she invites twenty-two believing she invited twenty-five.
  //
  // AND IT RUNS EXACTLY ONCE PER OPENING. The snapshot Leif reads is the
  // snapshot Confirm consumes, and nothing between those two moments may
  // replace it.
  //
  // THE BUG THIS GUARD EXISTS FOR, from the first real batch. This effect
  // used to re-run whenever one of its dependencies took a new identity.
  // `dataProvider` is such a dependency: ra-core memoizes the proxy on
  // [dataProvider, logoutIfAccessDenied, queryClient], and
  // logoutIfAccessDenied is a useCallback over
  // [authProvider, logout, notify, handleRedirect] -> [navigate]. None of
  // that is stable by contract. On 2026-10-11 Leif opened the dialog at
  // 13:02:07 (preflight 8), the effect re-ran at 13:04:55 (preflight 9),
  // and her click at 13:04:57 consumed 9 — the snapshot nobody had read.
  // The two happened to hold the same 25 people, so the batch was right;
  // it was right by luck, because no one joined and no Kit state moved in
  // those three minutes.
  //
  // Making one dependency stable would not fix it — the next unstable one
  // would do the same. So the run is guarded by a ref instead, and a
  // re-render for any reason at all is a no-op.
  const runStarted = useRef(false);
  // Bumped whenever a result stops being wanted, so a reply that arrives
  // after a close is dropped. The effect deliberately has NO cleanup: a
  // cleanup would fire on every dependency change and abandon a request the
  // guard above had already decided to keep.
  const runToken = useRef(0);
  useEffect(() => () => void (runToken.current += 1), []);

  useEffect(() => {
    if (!open) {
      runToken.current += 1;
      runStarted.current = false;
      setPreflight(null);
      setApprovedCount(null);
      setFailed(false);
      return;
    }
    if (runStarted.current) return;
    runStarted.current = true;
    const token = runToken.current;
    setApprovedCount(requestedCount);
    setFailed(false);
    void runWaitlistPreflight(dataProvider, {
      offerId,
      cohortId,
      requested: requestedCount,
      entryIds: mode.kind === "selected" ? mode.entryIds : null,
    })
      .then((result) => {
        if (runToken.current === token) setPreflight(result);
      })
      .catch(() => {
        if (runToken.current === token) setFailed(true);
      });
  }, [open, dataProvider, offerId, cohortId, mode, requestedCount]);

  // A preview of who Kit will deliver to goes stale; the server gives it two
  // hours and refuses it after that. Re-reading the clock re-renders, which
  // is safe now and would not have been before: it would have run a whole
  // new preflight every thirty seconds.
  useEffect(() => {
    if (!open) return;
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [open]);

  const expired =
    preflight?.expiresAt != null && Date.parse(preflight.expiresAt) <= now;
  // Asking for a different number is a different question, and the honest
  // answer is a new preview rather than a quietly swapped one.
  const countMoved = approvedCount != null && approvedCount !== requestedCount;
  const stale = expired || countMoved;

  const askedEligible = invitableIn(preflight?.rows ?? []);
  const passedOver = passedOverIn(preflight?.rows ?? []);

  const oldestJoined = askedEligible[0]?.joinedAt ?? null;
  const newestJoined =
    askedEligible[askedEligible.length - 1]?.joinedAt ?? null;
  const day = (value: string | null) =>
    value ? formatISODateString(value.split("T")[0]!) : "—";

  const handleConfirm = async () => {
    if (preflight == null) return;
    // Belt as well as braces: the button is disabled, and the server
    // refuses a used or expired preflight anyway. Sending one regardless
    // would be the UI claiming something it cannot know.
    if (stale) return;
    setBusy(true);
    try {
      // Exactly the people in the snapshot above — never a list worked out
      // again afterwards, which could contain somebody Leif never saw.
      const result = await inviteFromPreflight(dataProvider, {
        preflightId: preflight.preflightId,
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

          {preflight != null && preflight.shortBy > 0 && (
            <p className="text-sm text-muted-foreground">
              {translate("resources.waitlist_entries.invite.short_by", {
                _: "%{count} fewer than asked for — there are not that many people Kit will deliver to.",
                count: preflight.shortBy,
              })}
            </p>
          )}

          {expired && (
            <p className="text-sm text-destructive">
              {translate("resources.waitlist_entries.invite.expired", {
                _: "This preview is out of date — who Kit will deliver to may have changed. Close this and open it again to check. Nothing was sent.",
              })}
            </p>
          )}

          {countMoved && !expired && (
            <p className="text-sm text-destructive">
              {translate("resources.waitlist_entries.invite.count_moved", {
                _: "This preview is for %{approved}, not %{asked}. Close this and open it again to preview %{asked}. Nothing was sent.",
                approved: approvedCount,
                asked: requestedCount,
              })}
            </p>
          )}

          {failed && (
            <p className="text-sm text-destructive">
              {translate("resources.waitlist_entries.invite.preflight_failed", {
                _: "Could not check who can be invited. Nothing was sent.",
              })}
            </p>
          )}

          {preflight != null && askedEligible.length < 1 && (
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
                  <li key={String(row.waitlistEntryId)}>
                    {row.name} — {reasonLabel(row.exclusionReason)}
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
            disabled={
              busy ||
              preflight == null ||
              askedEligible.length === 0 ||
              mapping == null ||
              stale
            }
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
