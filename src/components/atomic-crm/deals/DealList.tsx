import { useGetIdentity, useListContext, useTranslate } from "ra-core";
import { matchPath, useLocation } from "react-router";
import { CreateButton } from "@/components/admin/create-button";
import { ExportButton } from "@/components/admin/export-button";
import { List } from "@/components/admin/list";
import { FilterButton } from "@/components/admin/filter-form";
import { SearchInput } from "@/components/admin/search-input";

import { TopToolbar } from "../layout/TopToolbar";
import { DealArchivedList } from "./DealArchivedList";
import { DealCreate } from "./DealCreate";
import { DealEdit } from "./DealEdit";
import { DealEmpty } from "./DealEmpty";
import { DealListContent } from "./DealListContent";
import { DealShow } from "./DealShow";
import { PIPELINE_PAGE_SIZE } from "./pipelineQuery";

const DealList = () => {
  const { identity } = useGetIdentity();

  if (!identity) return null;

  const dealFilters = [<SearchInput source="q" alwaysOn />];

  return (
    <List
      // Every active Opportunity, not the hundred longest-in-stage. With
      // perPage=100 and more than a hundred open sales, whichever card had
      // just moved was the newest and silently fell off the board
      // (Porsche Brown, then Anna Howard, 2026-10-29). See pipelineQuery.ts.
      perPage={PIPELINE_PAGE_SIZE}
      // Won leaves the active board the same way an archived deal already
      // does: excluded from the list query, still reachable by direct link
      // and from the owning Contact's history. An outcome (Nurture/Needs
      // Higher Care/Not Fit/Lost) is this app's other established "exited"
      // signal (see peopleDeciding.ts, personContext.ts,
      // classifyCohortOpportunity) — Application review now sets it on a
      // still-open stage (Native Applications slice, §5/§6/§7), so the
      // active pipeline must exclude it here too.
      filter={{
        "archived_at@is": null,
        "stage@neq": "won",
        "outcome@is": null,
      }}
      title={false}
      // Kanban queue-ordering slice: getDealsByStage (DealListContent.tsx)
      // re-sorts each column client-side. This sort used to decide WHICH
      // hundred cards a truncated fetch kept — and it kept the oldest, so
      // the card that had just moved was the one dropped. It is now only a
      // stable fetch order; the board fetches every active Opportunity and
      // says so if it ever cannot (PipelineTruncationNotice).
      sort={{ field: "stage_entered_at", order: "ASC" }}
      filters={dealFilters}
      actions={<DealActions />}
      pagination={null}
    >
      <DealLayout />
    </List>
  );
};

const DealLayout = () => {
  const location = useLocation();
  const translate = useTranslate();
  const matchCreate = matchPath("/deals/create", location.pathname);
  const matchShow = matchPath("/deals/:id/show", location.pathname);
  const matchEdit = matchPath("/deals/:id", location.pathname);

  const { data, isPending, filterValues } = useListContext();
  const hasFilters = filterValues && Object.keys(filterValues).length > 0;

  if (isPending) return null;
  if (!data?.length && !hasFilters)
    return (
      <>
        <DealEmpty>
          <DealShow open={!!matchShow} id={matchShow?.params.id} />
          <DealArchivedList />
        </DealEmpty>
      </>
    );

  return (
    <div className="w-full">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">
          {translate("crm.navigation.pipeline")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {translate("resources.deals.pipeline_orientation")}
        </p>
      </div>
      <DealListContent />
      <DealArchivedList />
      <DealCreate open={!!matchCreate} />
      <DealEdit open={!!matchEdit && !matchCreate} id={matchEdit?.params.id} />
      <DealShow open={!!matchShow} id={matchShow?.params.id} />
    </div>
  );
};

const DealActions = () => (
  <TopToolbar>
    <FilterButton />
    <ExportButton />
    <CreateButton label="resources.deals.action.new" />
  </TopToolbar>
);

export default DealList;
