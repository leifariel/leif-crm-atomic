import type { DataProvider, Identifier } from "ra-core";

import type { KitSyncOperation, KitTagMapping } from "../types";

// Everything the owner-facing Kit controls ask for, in one place.
//
// The browser never talks to Kit. Every call here reaches the kit_sync Edge
// Function — the only thing holding the credential — or a validating database
// authority. A FakeRest mirror stands in where there is no Edge Function, so
// the demo and the tests exercise the same call sites without a provider.

export type KitTag = { id: number; name: string };

export type KitTagEvent =
  | "applicant"
  | "approved"
  | "needs_higher_care"
  | "not_fit"
  | "offered_other_programme"
  | "bespoke_accepted"
  | "bespoke_denied";

export type AddKitTagResult = {
  status:
    | "requested"
    | "already-requested"
    | "do-not-engage"
    | "no-email"
    | "contact-invalid"
    | "tag-invalid"
    | "application-invalid";
  operationId?: Identifier;
};

type KitCapableProvider = DataProvider & {
  kitTags?: () => Promise<KitTag[]>;
  createKitTag?: (name: string) => Promise<KitTag>;
  contactKitTags?: (
    contactId: Identifier,
  ) => Promise<{ tags: KitTag[]; knownToKit: boolean }>;
  addKitTag?: (input: {
    contactId: Identifier;
    kitTagId: number;
    kitTagName: string;
    applicationId?: Identifier | null;
  }) => Promise<AddKitTagResult>;
  setProgramKitTag?: (input: {
    offerId: Identifier;
    event: KitTagEvent;
    kitTagId: number | null;
    kitTagName: string | null;
  }) => Promise<{ status: string }>;
};

const capable = (dataProvider: DataProvider) =>
  dataProvider as KitCapableProvider;

/** The account's whole tag catalog, so a tag is chosen rather than typed. */
export const kitTags = async (
  dataProvider: DataProvider,
): Promise<KitTag[]> => {
  const rpc = capable(dataProvider).kitTags;
  if (typeof rpc === "function") return await rpc();
  return await kitTagsMirror(dataProvider);
};

/**
 * Kit's own create is idempotent on name, case-insensitively: an existing name
 * comes back as the existing tag rather than a duplicate. So this never forks
 * the catalog, and the id that returns is the one to store.
 */
export const createKitTag = async (
  dataProvider: DataProvider,
  name: string,
): Promise<KitTag> => {
  const rpc = capable(dataProvider).createKitTag;
  if (typeof rpc === "function") return await rpc(name);
  return await createKitTagMirror(dataProvider, name);
};

/** What Kit says this person carries — the provider's answer, not ours. */
export const contactKitTags = async (
  dataProvider: DataProvider,
  contactId: Identifier,
): Promise<{ tags: KitTag[]; knownToKit: boolean }> => {
  const rpc = capable(dataProvider).contactKitTags;
  if (typeof rpc === "function") return await rpc(contactId);
  return await contactKitTagsMirror(dataProvider, contactId);
};

/** Ask for one tag on one human. Durable, idempotent, and carried out by the
 *  same worker as everything automatic. */
export const addKitTag = async (
  dataProvider: DataProvider,
  input: {
    contactId: Identifier;
    kitTagId: number;
    kitTagName: string;
    applicationId?: Identifier | null;
  },
): Promise<AddKitTagResult> => {
  const rpc = capable(dataProvider).addKitTag;
  if (typeof rpc === "function") return await rpc(input);
  return await addKitTagMirror(dataProvider, input);
};

/** Which tag a programme's event should apply, from now on. */
export const setProgramKitTag = async (
  dataProvider: DataProvider,
  input: {
    offerId: Identifier;
    event: KitTagEvent;
    kitTagId: number | null;
    kitTagName: string | null;
  },
): Promise<{ status: string }> => {
  const rpc = capable(dataProvider).setProgramKitTag;
  if (typeof rpc === "function") return await rpc(input);
  return await setProgramKitTagMirror(dataProvider, input);
};

// ---------------------------------------------------------------------------
// The mirrors
// ---------------------------------------------------------------------------
// A provider with no Edge Function behind it has no Kit either, so these
// reproduce only the half that is real: the CRM's own durable records. Nothing
// here pretends a provider confirmed anything.

export const kitTagsMirror = async (dataProvider: DataProvider) => {
  const { data } = await dataProvider.getList<KitTag & { id: number }>(
    "kit_tags",
    {
      filter: {},
      pagination: { page: 1, perPage: 500 },
      sort: { field: "name", order: "ASC" },
    },
  );
  return data.map((tag) => ({ id: Number(tag.id), name: tag.name }));
};

export const createKitTagMirror = async (
  dataProvider: DataProvider,
  name: string,
) => {
  const existing = (await kitTagsMirror(dataProvider)).find(
    (tag) => tag.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (existing) return existing;
  const { data } = await dataProvider.create<KitTag & { id: number }>(
    "kit_tags",
    { data: { name: name.trim() } as never },
  );
  return { id: Number(data.id), name: data.name };
};

export const contactKitTagsMirror = async (
  dataProvider: DataProvider,
  contactId: Identifier,
) => {
  const { data } = await dataProvider.getList<KitSyncOperation>(
    "kit_sync_operations",
    {
      filter: { contact_id: contactId, status: "succeeded" },
      pagination: { page: 1, perPage: 200 },
      sort: { field: "id", order: "ASC" },
    },
  );
  const seen = new Map<number, string>();
  for (const operation of data) {
    seen.set(Number(operation.kit_tag_id), operation.kit_tag_name);
  }
  return {
    tags: [...seen].map(([id, name]) => ({ id, name })),
    knownToKit: data.length > 0,
  };
};

export const addKitTagMirror = async (
  dataProvider: DataProvider,
  {
    contactId,
    kitTagId,
    kitTagName,
    applicationId = null,
  }: {
    contactId: Identifier;
    kitTagId: number;
    kitTagName: string;
    applicationId?: Identifier | null;
  },
): Promise<AddKitTagResult> => {
  const { data: contact } = await dataProvider
    .getOne("contacts", { id: contactId })
    .catch(() => ({ data: null as { sales_eligibility?: string } | null }));
  if (!contact) return { status: "contact-invalid" };
  // The same refusal the database makes: a manual route around Do Not Engage
  // would make that decision decorative.
  if (contact.sales_eligibility === "do_not_engage") {
    return { status: "do-not-engage" };
  }

  const { data: existing } = await dataProvider.getList<KitSyncOperation>(
    "kit_sync_operations",
    {
      filter: { contact_id: contactId, origin: "manual_owner" },
      pagination: { page: 1, perPage: 200 },
      sort: { field: "id", order: "ASC" },
    },
  );
  const already = existing.find(
    (operation) => Number(operation.kit_tag_id) === kitTagId,
  );
  if (already) {
    return { status: "already-requested", operationId: already.id };
  }

  const { data: created } = await dataProvider.create<KitSyncOperation>(
    "kit_sync_operations",
    {
      data: {
        application_id: applicationId,
        contact_id: contactId,
        kind: "manual",
        origin: "manual_owner",
        requested_by: "owner",
        email: "",
        kit_tag_id: kitTagId,
        kit_tag_name: kitTagName,
        status: "pending",
        attempts: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never,
    },
  );
  return { status: "requested", operationId: created.id };
};

export const setProgramKitTagMirror = async (
  dataProvider: DataProvider,
  {
    offerId,
    event,
    kitTagId,
    kitTagName,
  }: {
    offerId: Identifier;
    event: KitTagEvent;
    kitTagId: number | null;
    kitTagName: string | null;
  },
) => {
  const { data } = await dataProvider.getList<KitTagMapping>(
    "kit_tag_mappings",
    {
      filter: {},
      pagination: { page: 1, perPage: 200 },
      sort: { field: "id", order: "ASC" },
    },
  );
  const existing = data.find(
    (mapping) =>
      String(mapping.offer_id) === String(offerId) && mapping.event === event,
  );

  if (kitTagId == null) {
    if (existing) {
      await dataProvider.delete("kit_tag_mappings", { id: existing.id });
    }
    return { status: "cleared" };
  }

  if (existing) {
    await dataProvider.update("kit_tag_mappings", {
      id: existing.id,
      data: { kit_tag_id: kitTagId, kit_tag_name: kitTagName },
      previousData: existing,
    });
  } else {
    await dataProvider.create("kit_tag_mappings", {
      data: {
        offer_id: offerId,
        event,
        kit_tag_id: kitTagId,
        kit_tag_name: kitTagName,
        created_at: new Date().toISOString(),
      } as never,
    });
  }
  return { status: "set" };
};
