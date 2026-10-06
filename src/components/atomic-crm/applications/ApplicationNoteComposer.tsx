import { useState } from "react";
import {
  useCreate,
  useGetIdentity,
  useListContext,
  useNotify,
  useTranslate,
  type Identifier,
} from "ra-core";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// Why this is not the shared NoteCreate.
//
// The shared composer cannot take a second note without a page reload,
// and that is NOT a problem this slice introduced: with every file here
// reverted, the Opportunity drawer behaves identically — the first note
// saves, the box keeps its text, and the next note is silently dropped.
// CreateBase holds the record it just created and the form re-seeds from
// it, landing after the success handler's own reset().
//
// Fixing that belongs to its own slice, with the Opportunity and Contact
// pages in scope and their own acceptance. So the Application page keeps
// everything else shared — the same application_notes table following the
// contact_notes/deal_notes pattern, the same Note component rendering,
// editing and deleting each note — and owns only the control that types
// one, which is small enough to be obviously correct.
export const ApplicationNoteComposer = ({
  applicationId,
}: {
  applicationId: Identifier;
}) => {
  const translate = useTranslate();
  const notify = useNotify();
  const { identity } = useGetIdentity();
  const { refetch } = useListContext();
  const [create] = useCreate();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async () => {
    const body = text.trim();
    if (body === "" || saving) return;
    setSaving(true);
    try {
      await create(
        "application_notes",
        {
          data: {
            application_id: applicationId,
            text: body,
            date: new Date().toISOString(),
            sales_id: identity?.id,
          },
        },
        { returnPromise: true },
      );
      // Cleared only once the write succeeded, so a failure never costs
      // Leif what he typed.
      setText("");
      await refetch();
    } catch {
      notify(
        translate("resources.applications.review.note_failed", {
          _: "That note could not be saved. Nothing was changed.",
        }),
        { type: "error" },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={translate("resources.applications.review.note_label", {
          _: "Note",
        })}
        placeholder={translate("resources.applications.review.note_hint", {
          _: "What are you thinking about this application?",
        })}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={saving || text.trim() === ""}
          onClick={() => void add()}
        >
          {translate("resources.notes.action.add_this", {
            _: "Add this note",
          })}
        </Button>
      </div>
    </div>
  );
};
