import { useNavigate, useParams } from "react-router";

import { ClientEditModal } from "./ClientEditModal";

// A thin wrapper around the ONE shared ClientEditModal, never a second
// implementation (AGENTS.md -> Operational UX conventions). Editing a client
// from their own page opens that modal in place; this route exists for a
// direct link, a reload, or an EditButton elsewhere in the admin, and closing
// it goes back in history rather than to a dead end.
export const ClientEdit = () => {
  const navigate = useNavigate();
  // The id comes from the route, the same way every other resource edit
  // screen gets it — there is no record context above this component.
  const { id } = useParams();

  return (
    <ClientEditModal
      enrollmentId={id ?? null}
      onOpenChange={(open) => {
        if (!open) navigate(-1);
      }}
    />
  );
};
