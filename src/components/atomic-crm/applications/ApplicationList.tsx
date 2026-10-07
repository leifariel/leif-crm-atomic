import { useState } from "react";
import { useTranslate } from "ra-core";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

import { PageHeader } from "../misc/ProgramLayout";
import { ApplicationCreateDialog } from "./ApplicationCreateDialog";
import { ApplicationProgrammeCard } from "./ApplicationProgrammeCard";
import { groupSectionsByProgramme } from "./groupSectionsByProgramme";
import { useApplicationsGrouped } from "./useApplicationsGrouped";

// The Applications page answers three questions, in this order: which
// programme, does Leif need to review this, and if not what is it really.
//
// It used to answer the second one first, with a single global Needs Review
// list, and it decided membership by provenance — which buried six January
// 2027 applications Leif needed to read. Programme comes first now, and
// within each programme the subsections say only what is true. See
// classifyApplication.ts for the rules and the facts behind them.
//
// ONE PROGRAMME = ONE CONTAINER. The page previously rendered one loose
// section per cohort-or-offer, so GYU's cohorts read as peer programmes
// beside The Living Example. Grouping and rendering now live in
// groupSectionsByProgramme.ts and ApplicationProgrammeCard.tsx; this file is
// the page shell.
export const ApplicationList = () => {
  const translate = useTranslate();
  const { isPending, sections, totals } = useApplicationsGrouped();
  const [createOpen, setCreateOpen] = useState(false);

  const programmes = groupSectionsByProgramme(sections);
  const isEmpty = programmes.length === 0;

  return (
    <div className="flex flex-col gap-6 mt-1 p-1 max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <PageHeader
            title={translate("resources.applications.name", { smart_count: 2 })}
            summary={translate("resources.applications.orientation")}
          />
        </div>
        {/* This page IS All Applications — the header and the nav item say
            so, so there is no button that only navigates to where you
            already are. New Application is a real action, so it gets one. */}
        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {translate("resources.applications.action.create", {
            _: "New Application",
          })}
        </Button>
      </div>

      <ApplicationCreateDialog open={createOpen} onOpenChange={setCreateOpen} />

      {/* Loading says so, rather than rendering a blank page. The header and
          the New Application action are already real and usable while the
          programmes arrive, so only they wait. */}
      {isPending && (
        <p className="text-sm text-muted-foreground">
          {translate("resources.applications.loading", {
            _: "Loading applications…",
          })}
        </p>
      )}

      {!isPending && totals["needs-review"] > 0 && (
        <p className="text-sm text-muted-foreground">
          {translate("resources.applications.waiting_summary", {
            _: "%{count} waiting for you across %{programmes} programmes.",
            count: totals["needs-review"],
            // Programmes, now that a programme is one container — it used to
            // count cohort sections, so three GYU cohorts with review work
            // read as three programmes.
            programmes: programmes.filter((p) => p.needsReview > 0).length,
          })}
        </p>
      )}

      {!isPending && isEmpty && (
        <p className="text-sm text-muted-foreground">
          {translate("resources.applications.empty", {
            _: "No applications yet.",
          })}
        </p>
      )}

      {programmes.map((programme) => (
        <ApplicationProgrammeCard key={programme.key} programme={programme} />
      ))}
    </div>
  );
};
