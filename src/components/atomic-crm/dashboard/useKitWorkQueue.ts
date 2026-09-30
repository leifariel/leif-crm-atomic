import { useGetList, useGetMany } from "ra-core";

import { kitStatus, type KitRequiredTag } from "../applications/kitStatus";
import type {
  Application,
  Cohort,
  Contact,
  KitSyncOperation,
  KitTagMapping,
  Offer,
} from "../types";

// Everything Kit still needs from Leif, in one list.
//
// Deliberately DERIVED, never stored: no Task row per unsynced applicant. Five
// people needing a tag is one thing to do, not five things in a task list, and
// the moment a tag is confirmed the row leaves on its own because the
// underlying evidence changed — nothing has to be ticked off.
//
// It reuses the Application's own kitStatus, so the Dashboard and the
// Application page cannot disagree about whether somebody has been emailed.

export type KitManualRow = {
  applicationId: Application["id"];
  contactId: Contact["id"];
  name: string;
  programme: string;
  cohort: string | null;
  applicationStatus: string;
  required: KitRequiredTag[];
};

export type KitProblemRow = {
  applicationId: Application["id"] | null;
  contactId: Contact["id"];
  name: string;
  tagName: string;
  // Only a failed operation can be re-queued; one that is merely late is
  // already on its way, and offering a button would be theatre.
  isRetryable: boolean;
};

export type KitWorkQueue = {
  isPending: boolean;
  manual: KitManualRow[];
  problems: KitProblemRow[];
  count: number;
};

const TERMINAL = ["completed", "withdrawn", "ended"];

// Whether this Application is current operational work at all.
//
// An imported record is finished history and has no Kit work — unless the
// owner deliberately brought it into the CRM, which is the one thing that can
// make provenance stop deciding currentness. Same rule kitStatus applies, so
// the Dashboard and the Application page cannot disagree about who is owed a
// tag.
const isOperationalApplication = (
  application: Pick<Application, "source" | "crm_adopted_at">,
): boolean =>
  application.source !== "historical_import" ||
  application.crm_adopted_at != null;

export const useKitWorkQueue = (): KitWorkQueue => {
  const { data: applications, isPending: loadingApplications } =
    useGetList<Application>(
      "applications",
      {
        filter: {},
        pagination: { page: 1, perPage: 500 },
        sort: { field: "id", order: "ASC" },
      },
      { retry: false },
    );
  const { data: operations, isPending: loadingOperations } =
    useGetList<KitSyncOperation>(
      "kit_sync_operations",
      {
        filter: {},
        pagination: { page: 1, perPage: 500 },
        sort: { field: "id", order: "ASC" },
      },
      { retry: false },
    );
  const { data: mappings } = useGetList<KitTagMapping>(
    "kit_tag_mappings",
    {
      filter: {},
      pagination: { page: 1, perPage: 100 },
      sort: { field: "offer_id", order: "ASC" },
    },
    { retry: false },
  );
  const { data: settings } = useGetList(
    "kit_integration_settings",
    {
      filter: {},
      pagination: { page: 1, perPage: 1 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );
  const { data: offers } = useGetList<Offer>(
    "offers",
    {
      filter: {},
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );
  const { data: cohorts } = useGetList<Cohort>(
    "cohorts",
    {
      filter: {},
      pagination: { page: 1, perPage: 200 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );
  // Only the people this queue actually names. Deliberately getMany rather
  // than a list: listing contacts recomputes their derived relationship
  // fields, and a Dashboard section that merely labels five rows has no
  // business rewriting anybody's record to do it.
  const named = [
    ...new Set([
      ...(applications ?? [])
        .filter(isOperationalApplication)
        .map((application) => String(application.contact_id)),
      ...(operations ?? [])
        .filter((operation) => operation.status === "failed")
        .map((operation) => String(operation.contact_id)),
    ]),
  ];
  const { data: contacts } = useGetMany<Contact>(
    "contacts",
    { ids: named },
    { retry: false, enabled: named.length > 0 },
  );

  const notBefore =
    (settings?.[0] as { not_before?: string } | undefined)?.not_before ?? null;
  const allOperations = operations ?? [];
  const nameOf = (contactId: Application["contact_id"]) => {
    const contact = (contacts ?? []).find(
      (one) => String(one.id) === String(contactId),
    );
    return contact
      ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim()
      : "Somebody";
  };

  const manual: KitManualRow[] = [];
  for (const application of applications ?? []) {
    if (!isOperationalApplication(application)) continue;
    if (TERMINAL.includes(application.status)) continue;

    const cohort = (cohorts ?? []).find(
      (one) => String(one.id) === String(application.intended_cohort_id),
    );
    const mine = allOperations.filter(
      (operation) =>
        String(operation.application_id) === String(application.id) ||
        (operation.origin === "manual_owner" &&
          String(operation.contact_id) === String(application.contact_id)),
    );
    const status = kitStatus({
      application,
      operations: mine,
      mappings: mappings ?? [],
      cohortTag:
        cohort?.kit_tag_id != null
          ? {
              kitTagId: Number(cohort.kit_tag_id),
              kitTagName: String(cohort.kit_tag_name ?? ""),
            }
          : null,
      notBefore,
    });

    if (status.kind !== "manual-action") continue;
    manual.push({
      applicationId: application.id,
      contactId: application.contact_id,
      name: nameOf(application.contact_id),
      programme:
        (offers ?? []).find(
          (offer) => String(offer.id) === String(application.offer_id),
        )?.name ?? "",
      cohort: cohort?.name ?? null,
      applicationStatus: application.status,
      required: status.required,
    });
  }

  // Automatic work that did not land. Same "needs attention" rule the
  // Application already uses, so the two agree about what counts as trouble.
  const problems: KitProblemRow[] = allOperations
    .filter((operation) => operation.status === "failed")
    .map((operation) => ({
      applicationId: operation.application_id,
      contactId: operation.contact_id,
      name: nameOf(operation.contact_id),
      tagName: operation.kit_tag_name,
      isRetryable: true,
    }));

  return {
    isPending: loadingApplications || loadingOperations,
    manual,
    problems,
    count: manual.length + problems.length,
  };
};
