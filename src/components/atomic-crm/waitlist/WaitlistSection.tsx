import { useMemo, useState, type ReactNode } from "react";
import { useTranslate, type Identifier } from "ra-core";
import { Link } from "react-router";
import { Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

import { Section } from "../misc/ProgramLayout";
import { PreviewList } from "../misc/PreviewList";
import { formatTimestampString } from "../deals/dealUtils";
import type { WaitlistEntryRow } from "./useWaitlistEntries";
import {
  waitlistEntryStatusBadgeVariant,
  waitlistEntryStatusLabels,
} from "./waitlistConstants";
import { WaitlistEntryActions } from "./WaitlistEntryActions";
import { Checkbox } from "@/components/ui/checkbox";
import { InviteToApplyDialog, type InviteMode } from "./InviteToApplyDialog";
import { isInvitable } from "./waitlistInvitations";
import { isBulkInviteDeliveryEnabled } from "./waitlistInviteFeature";
import { isImportProvenance } from "./isImportProvenance";

// The "Waitlist" section shared by the Living Example, Group Program, and
// Cohort pages (Waitlists slice, §7/§8/§21). A real waitlist can run into
// the dozens (Leif's actual Living Example waitlist is ~50 people), so
// this is a single contained list — one rounded Card, dense divided rows —
// rather than one PersonCard per person; the same "contained list inside a
// rounded section" density pattern the Applications page already
// established for its own many-row sections, not a new visual language.
// Capped with a "N more" disclosure so 50+ waiting people never force the
// page itself to become enormous.
//
// Density pass: that collapse was first written here, and then every other
// programme section wanted it. It now lives in misc/PreviewList.tsx — the
// count in the heading, the preview limit, and the expand/collapse control
// are the same ones the Enrolled Clients, People Deciding, Applications and
// Cohorts sections use, so a list behaves the same wherever Leif meets it.

// Human-acceptance repair pass, §1: an 8-row collapse keeps a 50-person
// list from taking over the page, but doesn't make finding ONE person in
// it easy. A tiny local search (name/email — see useWaitlistEntries.ts's
// WaitlistEntryRow.email comment on why not Instagram handle) bypasses the
// collapse for its matches; only shown once the list is actually long
// enough that the collapse (and thus a search) matters.
// A waitlist long enough to need searching is a different question from a
// waitlist long enough to need collapsing, and they do not share a number.
// The collapse is PREVIEW_LIMIT (3); the search appears only once finding
// one person by eye is genuinely hard, which is where it has always been.
const SEARCH_THRESHOLD = 8;

export const WaitlistSection = ({
  entries,
  offerId,
  offerName,
  cohortId = null,
  cohortName = null,
  // Defaults to the feature flag; an explicit value lets tests exercise
  // both the production (hidden) and post-Gmail (visible) states.
  enableBulkInvite = isBulkInviteDeliveryEnabled(),
  // A control rendered with the section heading — "+ Add to Waitlist".
  // Leif adds people who arrive through Instagram by hand, several at a
  // time, and the button for it lived only in the page header, three
  // sections above the list it adds to.
  action,
  // One short factual sentence about whether there is room, shown above
  // the list because "who is waiting" and "is there space" are always
  // asked together. It states and never acts: no invitation, no move, no
  // email follows from reading it.
  availability = null,
  // Programme-wide lists only: which round each person is waiting on.
  // A round's own list leaves this unset, because the page already says.
  cohortLabelFor,
}: {
  entries: WaitlistEntryRow[];
  // Optional so a caller that has not been given batch-invite context yet
  // simply renders the list exactly as before.
  offerId?: Identifier;
  offerName?: string;
  cohortId?: Identifier | null;
  cohortName?: string | null;
  enableBulkInvite?: boolean;
  action?: ReactNode;
  availability?: string | null;
  cohortLabelFor?: (cohortId: Identifier | null) => string | null;
}) => {
  const translate = useTranslate();
  const [search, setSearch] = useState("");
  // Held by entry id, never by position. Collapsing the list changes which
  // rows are RENDERED and nothing else, so a selection survives it — which
  // is the whole reason this is a Set of ids and not an index.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [inviteMode, setInviteMode] = useState<InviteMode | null>(null);
  // How many to invite. Leif's real batches are 25 and 30.
  const [oldestCount, setOldestCount] = useState("25");

  // Hidden in production until Gmail delivery exists — a "prepared" batch
  // must never be presented as though people were actually invited.
  const canInvite = enableBulkInvite && offerId != null && offerName != null;
  // Only a membership that has not converted or been removed can be
  // invited. A previously invited one stays selectable on purpose — that
  // is the legitimate re-invite case.
  const invitableEntries = entries.filter(isInvitable);
  const selectedEntries = entries.filter((entry) =>
    selectedIds.has(String(entry.entryId)),
  );
  const allInvitableSelected =
    invitableEntries.length > 0 &&
    invitableEntries.every((entry) => selectedIds.has(String(entry.entryId)));

  const toggleOne = (entryId: Identifier) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      const key = String(entryId);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Select all covers only invitable rows — converted/removed people are
  // never silently swept into a batch.
  const toggleAll = () =>
    setSelectedIds(
      allInvitableSelected
        ? new Set()
        : new Set(invitableEntries.map((entry) => String(entry.entryId))),
    );

  const query = search.trim().toLowerCase();
  const isSearching = query !== "";
  const matchingEntries = useMemo(() => {
    if (!isSearching) return entries;
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(query) ||
        (entry.email?.toLowerCase().includes(query) ?? false),
    );
  }, [entries, isSearching, query]);

  const title = translate("resources.waitlist_entries.name", {
    _: "Waitlist",
    smart_count: 1,
  });

  return (
    <Section title={title} count={entries.length} action={action}>
      {availability && (
        <p className="text-sm text-muted-foreground -mt-1">{availability}</p>
      )}
      {canInvite && invitableEntries.length > 0 && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="px-0 text-xs text-muted-foreground"
            onClick={toggleAll}
          >
            {allInvitableSelected
              ? translate("resources.waitlist_entries.invite.clear", {
                  _: "Clear",
                })
              : translate("resources.waitlist_entries.invite.select_all", {
                  _: "Select all",
                })}
          </Button>
          <div className="flex items-center gap-2">
            {/* The ordinary batch: the oldest N still waiting. The number
                is the whole instruction — the SERVER works out who they
                are, because what is on screen may be collapsed, filtered
                or simply from five minutes ago. */}
            <label
              className="text-xs text-muted-foreground"
              htmlFor="waitlist-invite-oldest"
            >
              {translate("resources.waitlist_entries.invite.select_oldest", {
                _: "Invite oldest",
              })}
            </label>
            <Input
              id="waitlist-invite-oldest"
              type="number"
              min={1}
              max={500}
              value={oldestCount}
              onChange={(event) => setOldestCount(event.target.value)}
              className="h-8 w-20 text-sm"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                !Number.isFinite(Number(oldestCount)) || Number(oldestCount) < 1
              }
              onClick={() =>
                setInviteMode({
                  kind: "oldest",
                  count: Math.floor(Number(oldestCount)),
                })
              }
            >
              {translate("resources.waitlist_entries.invite.action_oldest", {
                _: "Invite to apply",
              })}
            </Button>
            {selectedEntries.length > 0 && (
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  setInviteMode({
                    kind: "selected",
                    entryIds: selectedEntries.map((entry) => entry.entryId),
                  })
                }
              >
                {translate("resources.waitlist_entries.invite.action", {
                  _: "Invite selected to apply",
                })}{" "}
                · {selectedEntries.length}
              </Button>
            )}
          </div>
        </div>
      )}
      {canInvite && inviteMode != null && (
        <InviteToApplyDialog
          open
          onOpenChange={(next) => {
            if (!next) setInviteMode(null);
          }}
          offerId={offerId!}
          offerName={offerName!}
          cohortId={cohortId}
          cohortName={cohortName}
          mode={inviteMode}
          onConfirmed={() => setSelectedIds(new Set())}
        />
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate("resources.waitlist_entries.empty", {
            _: "Nobody waiting.",
          })}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.length > SEARCH_THRESHOLD && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={translate(
                  "resources.waitlist_entries.search_placeholder",
                  { _: "Search name or email…" },
                )}
                className="h-8 pl-8 pr-8 text-sm"
              />
              {isSearching && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2"
                  onClick={() => setSearch("")}
                  aria-label={translate("ra.action.clear_input_value", {
                    _: "Clear",
                  })}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
          )}
          {isSearching && matchingEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground px-1">
              {translate("resources.waitlist_entries.search_empty", {
                _: "No one matches “%{query}”.",
                query: search.trim(),
              })}
            </p>
          ) : (
            <PreviewList
              storeKey={`waitlist.${offerId ?? "none"}.${cohortId ?? "general"}`}
              items={matchingEntries}
              // A search that only looked at the first eight rows would
              // answer the wrong question, so it bypasses the collapse.
              showAll={isSearching}
              renderRows={(visible) => (
                <Card className="p-0">
                  <CardContent className="p-0 divide-y">
                    {visible.map((entry) => (
                      <div
                        key={entry.entryId}
                        className="flex items-center justify-between gap-3 px-4 py-2.5"
                      >
                        {canInvite && (
                          <Checkbox
                            className="shrink-0"
                            aria-label={entry.name}
                            disabled={!isInvitable(entry)}
                            checked={selectedIds.has(String(entry.entryId))}
                            onCheckedChange={() => toggleOne(entry.entryId)}
                          />
                        )}
                        <div className="flex min-w-0 flex-1 items-baseline gap-2">
                          <Link
                            to={`/contacts/${entry.contactId}/show`}
                            className="text-sm font-medium hover:underline shrink-0"
                          >
                            {entry.name}
                          </Link>
                          <span className="text-xs text-muted-foreground truncate">
                            {metaFor(
                              entry,
                              (key, fallback) =>
                                translate(key, { _: fallback }),
                              cohortLabelFor?.(entry.cohortId) ?? null,
                            )}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge
                            variant={
                              waitlistEntryStatusBadgeVariant[entry.status]
                            }
                          >
                            {waitlistEntryStatusLabels[entry.status]}
                          </Badge>
                          <WaitlistEntryActions
                            entryId={entry.entryId}
                            status={entry.status}
                          />
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            />
          )}
        </div>
      )}
    </Section>
  );
};

const metaFor = (
  entry: WaitlistEntryRow,
  translate: (key: string, fallback: string) => string,
  cohortLabel: string | null,
) => {
  const joinedLabel = translate(
    "resources.waitlist_entries.fields.joined_at",
    "Joined",
  );
  // The round first, when there is one and the list spans several: it is
  // the thing that distinguishes two otherwise identical rows.
  const parts = cohortLabel ? [cohortLabel] : [];
  parts.push(`${joinedLabel} ${formatTimestampString(entry.joinedAt)}`);
  if (entry.desiredTiming) parts.push(entry.desiredTiming);
  // Import provenance stays STORED on the row — it is the audit trail for
  // how a historical membership's joined_at was derived, and deleting it
  // would destroy that. It just does not belong in the everyday row, where
  // 37 copies of "Historical import: waitlist order 3 of 21 is
  // source-confirmed (Existing List)..." drown out the person's name. A
  // note Leif actually typed still shows; only migration evidence is held
  // back, and it remains visible in the entry's own record.
  if (entry.notes && !isImportProvenance(entry.notes)) parts.push(entry.notes);
  return parts.join(" · ");
};
