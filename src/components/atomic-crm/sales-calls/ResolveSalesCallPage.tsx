import { useNavigate, useParams } from "react-router";

import { SalesCallResolutionModal } from "./SalesCallResolutionModal";

// A thin wrapper around the ONE shared SalesCallResolutionModal, never a
// second implementation (AGENTS.md -> Operational UX conventions). A Task row
// opens that modal in place, so ordinary Dashboard interaction never leaves
// the Dashboard; this route exists for a direct link, a reload, or arriving
// from outside the app. Closing it goes back in history, landing wherever Leif
// actually came from rather than on a dead end.
export const ResolveSalesCallPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();

  return (
    <SalesCallResolutionModal
      salesCallId={id ?? null}
      onOpenChange={(open) => {
        if (!open) navigate(-1);
      }}
    />
  );
};

ResolveSalesCallPage.path = "/sales-calls/:id/resolve";
