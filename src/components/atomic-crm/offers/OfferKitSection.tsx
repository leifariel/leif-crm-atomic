import { useState } from "react";
import {
  useDataProvider,
  useGetList,
  useNotify,
  useRecordContext,
  useRefresh,
} from "ra-core";

import { Button } from "@/components/ui/button";

import { KitTagPicker } from "../applications/KitTagPicker";
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
      <section className="flex flex-col gap-1 pt-2">
        <span className="text-sm font-medium">Kit automation</span>
        <span className="text-sm text-muted-foreground">
          Save this programme, then choose its Kit tags here.
        </span>
      </section>
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

  return (
    <section className="flex flex-col gap-2 pt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-medium">Kit automation</span>
        {configured < EVENTS.length && (
          <span className="text-xs text-muted-foreground">
            Kit automation not fully configured
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {EVENTS.map(({ event, label }) => {
          const mapping = mappingFor(event);
          return (
            <li
              key={event}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
            >
              <span className="text-sm text-muted-foreground w-44">
                {label}
              </span>
              {editing === event ? (
                <div className="flex-1 min-w-48 flex flex-col gap-2">
                  <KitTagPicker
                    value={null}
                    disabled={saving}
                    onChange={(tag) => tag && save(event, tag)}
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                    {mapping && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        onClick={() => save(event, null)}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {mapping ? mapping.kit_tag_name : "Not set"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(event)}
                  >
                    {mapping ? "Change" : "Choose"}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <span className="text-xs text-muted-foreground">
        Changes apply to future Kit actions. Existing applicants are not
        retagged.
      </span>
    </section>
  );
};
