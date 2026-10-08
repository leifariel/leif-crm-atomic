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
  { event: "bespoke_accepted", label: "Bespoke acceptance" },
  { event: "bespoke_rejected", label: "Bespoke rejection" },
];

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
      await setProgramKitTag(dataProvider, {
        offerId: record.id,
        event,
        kitTagId: tag ? tag.id : null,
        kitTagName: tag ? tag.name : null,
      });
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
