import { useState } from "react";
import { useDataProvider, useGetList, useNotify, useRefresh } from "ra-core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { Application, Cohort, Deal } from "../types";
import {
  adoptImportedApplication,
  type AdoptionResult,
} from "./adoptApplication";
import {
  applicationAdoption,
  adoptionConflict,
  adoptionRefusalSentence,
} from "./applicationAdoption";

// The one act that turns an imported record into current work.
//
// Taylor Carr's answers were on screen above a sentence saying no decision
// could be recorded about her. She had applied to a round still taking
// applications; the only thing missing was the Opportunity every review
// outcome writes to. This offers that, explicitly, and says what it will do
// in the terms the answer is about — a person and her application, not rows.
//
// It appears only where it is genuinely available, and disappears the moment
// it has been used.
export const BringIntoCrmCard = ({
  application,
  cohort,
  applicantName,
}: {
  application: Application;
  cohort: Cohort | null | undefined;
  applicantName: string;
}) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);

  // The person's other Opportunities, so the page does not offer an action
  // that today's data already says will be refused.
  const { data: deals } = useGetList<Deal>(
    "deals",
    {
      filter: { contact_id: application.contact_id },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );

  const eligibility = applicationAdoption(application, cohort);
  if (!eligibility.canAdopt) return null;

  const conflict = adoptionConflict(application, deals ?? []);
  if (conflict) {
    // Named, not hidden. There is a live sales conversation for this
    // programme, and which one this application belongs to is Leif's call.
    return (
      <div className="rounded-md border px-3 py-2">
        <span className="text-sm text-muted-foreground">
          {adoptionRefusalSentence(conflict)}
        </span>
      </div>
    );
  }

  const bringIn = async () => {
    setWorking(true);
    try {
      const result: AdoptionResult = await adoptImportedApplication(
        dataProvider,
        application.id,
      );
      if (result.status === "adopted" || result.status === "already-adopted") {
        notify(`${applicantName} is in the CRM.`, { type: "info" });
        setOpen(false);
        refresh();
        return;
      }
      // A refusal is a real answer about the business, not a failure. It
      // names what to look at, and nothing was written.
      notify(adoptionRefusalSentence(result.status), { type: "warning" });
      setOpen(false);
    } catch {
      notify("That could not be done just now. Nothing was changed.", {
        type: "error",
      });
    } finally {
      setWorking(false);
      refresh();
    }
  };

  return (
    <div className="rounded-md border px-3 py-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <span className="text-sm text-muted-foreground">
        This application came in with the import, and its round is still open.
        Bring it into the CRM to review it.
      </span>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Bring into CRM
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Bring {applicantName} into CRM?</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <span className="text-sm">This will:</span>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              <li>· start her sales opportunity for this programme</li>
              <li>· place her in the current pipeline</li>
              <li>· let you record a decision on this application</li>
              <li>
                · keep her original application and answers exactly as they are
              </li>
              <li>
                · leave her Kit tagging to you, as it is for everyone imported
              </li>
            </ul>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={working}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={working}
                onClick={bringIn}
              >
                Bring into CRM
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
