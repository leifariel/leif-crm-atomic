import { useState } from "react";
import { useRecordContext } from "ra-core";

import { Button } from "@/components/ui/button";

import { ManageKitTagsModal } from "../applications/ManageKitTagsModal";
import type { Contact } from "../types";

// The person-level Kit tag manager, reached from the person. A short
// contextual action, so it opens over the Contact rather than navigating away
// (AGENTS.md -> Operational UX conventions), and it is the SAME component the
// Application reaches — a manual tag is a tag on a human either way.
//
// Absent for somebody marked Do Not Engage: the CRM declined to work with
// them, the database refuses a manual tag for them anyway, and offering the
// button would only be a route to a refusal.
export const ManageKitTagsButton = () => {
  const record = useRecordContext<Contact>();
  const [open, setOpen] = useState(false);

  if (!record || record.sales_eligibility === "do_not_engage") return null;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        Manage Kit tags
      </Button>
      {open && (
        <ManageKitTagsModal
          contactId={record.id}
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
        />
      )}
    </>
  );
};
