import { useState } from "react";
import {
  useDataProvider,
  useGetList,
  useNotify,
  useRecordContext,
  useRefresh,
} from "ra-core";

import { Button } from "@/components/ui/button";

import { ChooseKitTagDialog } from "../applications/ChooseKitTagDialog";
import { KitConfigBox, KitConfigRow } from "../applications/KitConfigBox";
import {
  setProgramKitTag,
  type KitTag,
  type KitTagEvent,
} from "../applications/kitTagActions";
import type { KitTagMapping, Offer } from "../types";

// Which Kit tag this programme's events apply, editable by Leif.
//
// It used to take a migration to change one of these numbers, which made every
// new programme a code change. Now it is four pickers and a save, and the one
// rule that keeps it safe is stated where he reads it: a change reaches future
// Kit actions and nothing that already happened.
//
// Restrained on purpose — the CRM's existing section language, not a new page
// and not a subsystem. Missing tags are said out loud rather than guessed at.
const EVENTS: Array<{ event: KitTagEvent; label: string }> = [
  { event: "applicant", label: "Applicant" },
  { event: "approved", label: "Approved" },
  { event: "needs_higher_care", label: "Needs Higher Care" },
  { event: "not_fit", label: "Not Fit" },
  { event: "offered_other_programme", label: "Offered the other programme" },
  // Their own tags, deliberately separate from Approved / Not Fit: a bespoke
  // decision must never apply a tag an email automation may be hanging off.
  { event: "bespoke_accepted", label: "Bespoke Accepted" },
  { event: "bespoke_denied", label: "Bespoke Denied" },
  // Inviting somebody off the waitlist to apply. A fact about the
  // PROGRAMME, like the others — and deliberately not the Applicant tag,
  // which means an application was actually submitted.
  { event: "waitlist_invited", label: "Invited from the waitlist" },
];

// What the writer's refusals mean, in Leif's terms rather than the
// database's. Only 'set' and 'cleared' are success; everything else means
// nothing was written, and saying otherwise is the bug this exists for.
const describeRefusal = (status: string | undefined): string => {
  switch (status) {
    case "tag-already-used-by-another-decision":
      return "That tag is already used by another decision on this programme. Nothing was changed.";
    case "tag-invalid":
      return "That tag could not be used. Nothing was changed.";
    case "offer-invalid":
      return "This programme could not be found. Nothing was changed.";
    case "event-invalid":
      // Not something Leif can do anything about: the server does not
      // recognise this slot, which means the CRM disagrees with itself.
      return "The server did not recognise this Kit slot, so nothing was saved. This needs a fix, not a retry.";
    default:
      return "Could not save that Kit tag. Nothing was changed.";
  }
};

export const OfferKitSection = () => {
  const record = useRecordContext<Offer>();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [editing, setEditing] = useState<KitTagEvent | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: mappings } = useGetList<KitTagMapping>(
    "kit_tag_mappings",
    {
      filter: {},
      pagination: { page: 1, perPage: 100 },
      sort: { field: "offer_id", order: "ASC" },
    },
    { retry: false },
  );

  // Only on a programme that exists. A brand-new one is saved first and
  // configured immediately afterwards, rather than contorting the create
  // transaction into a multi-write illusion.
  if (!record?.id) {
    return (
      <KitConfigBox title="Kit automation">
        <span className="text-sm text-muted-foreground">
          Save this programme, then choose its Kit tags here.
        </span>
      </KitConfigBox>
    );
  }

  const mappingFor = (event: KitTagEvent) =>
    (mappings ?? []).find(
      (mapping) =>
        String(mapping.offer_id) === String(record.id) &&
        mapping.event === event,
    );

  const save = async (event: KitTagEvent, tag: KitTag | null) => {
    setSaving(true);
    try {
      const result = await setProgramKitTag(dataProvider, {
        offerId: record.id,
        event,
        kitTagId: tag ? tag.id : null,
        kitTagName: tag ? tag.name : null,
      });

      // BELIEVE THE AUTHORITY, NOT THE ABSENCE OF AN ERROR.
      //
      // set_program_kit_tag() refuses by returning a NAMED STATUS, on
      // purpose, so a picker can say what happened. This did not read it: it
      // awaited the call, saw no exception, and said "saved". Leif set
      // "Invited from the waitlist", was told it saved, came back and found
      // "Not set" — the writer had answered 'event-invalid' and nothing was
      // ever written. A consequential write may only report success when the
      // authority says it persisted.
      if (result?.status !== "set" && result?.status !== "cleared") {
        notify(describeRefusal(result?.status), { type: "error" });
        return;
      }

      notify(tag ? `${tag.name} saved.` : "Tag cleared.", { type: "info" });
      setEditing(null);
      refresh();
    } catch {
      notify("Could not save that Kit tag.", { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const configured = EVENTS.filter(({ event }) => mappingFor(event)).length;

  const editingMapping = editing ? mappingFor(editing) : undefined;

  return (
    <>
      <KitConfigBox
        title="Kit automation"
        aside={
          configured < EVENTS.length ? (
            <span className="text-xs text-muted-foreground">
              Kit automation not fully configured
            </span>
          ) : null
        }
        note="Changes apply to future Kit actions. Existing applicants are not retagged."
      >
        {EVENTS.map(({ event, label }) => {
          const mapping = mappingFor(event);
          return (
            <KitConfigRow
              key={event}
              label={label}
              value={
                mapping ? (
                  mapping.kit_tag_name
                ) : (
                  <span className="text-muted-foreground">Not set</span>
                )
              }
              action={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => setEditing(event)}
                >
                  {mapping ? "Change" : "Choose"}
                </Button>
              }
            />
          );
        })}
      </KitConfigBox>

      {/* The catalog opens over the form rather than expanding underneath the
          row, so a long tag list never pushes the rest of the programme off
          the screen — and cancelling is unambiguous. */}
      <ChooseKitTagDialog
        open={editing !== null}
        onOpenChange={(next) => !next && setEditing(null)}
        title="Choose Kit tag"
        onSelect={(tag) => editing && save(editing, tag)}
        onClear={
          editingMapping ? () => editing && save(editing, null) : undefined
        }
      />
    </>
  );
};
