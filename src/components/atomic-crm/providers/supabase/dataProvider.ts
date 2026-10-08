import { supabaseDataProvider } from "ra-supabase-core";
import {
  withLifecycleCallbacks,
  type DataProvider,
  type GetListParams,
  type Identifier,
  type ResourceCallbacks,
} from "ra-core";
import type {
  ContactNote,
  Deal,
  DealNote,
  RAFile,
  Sale,
  SalesFormData,
  SignUpData,
} from "../../types";
import type { ConfigurationContextValue } from "../../root/ConfigurationContext";
import {
  refuseContactDelete,
  refuseContactMerge,
} from "../../contacts/contactSafety";
import type { AddKitTagResult } from "../../applications/kitTagActions";
import { ATTACHMENTS_BUCKET } from "../commons/attachments";
import { getIsInitialized } from "./authProvider";
import { getSupabaseClient } from "./supabase";

const getBaseDataProvider = () =>
  supabaseDataProvider({
    instanceUrl: import.meta.env.VITE_SUPABASE_URL,
    apiKey: import.meta.env.VITE_SB_PUBLISHABLE_KEY,
    supabaseClient: getSupabaseClient(),
    sortOrder: "asc,desc.nullslast" as any,
  });

const processCompanyLogo = async (params: any) => {
  const logo = params.data.logo;

  if (logo?.rawFile instanceof File) {
    await uploadToBucket(logo);
  }

  return {
    ...params,
    data: {
      ...params.data,
      logo,
    },
  };
};

const getDataProviderWithCustomMethods = () => {
  const baseDataProvider = getBaseDataProvider();

  return {
    ...baseDataProvider,
    async getList(resource: string, params: GetListParams) {
      if (resource === "companies") {
        return baseDataProvider.getList("companies_summary", params);
      }
      if (resource === "contacts") {
        return baseDataProvider.getList("contacts_summary", params);
      }
      if (resource === "activity_log") {
        const { data, total } = await baseDataProvider.getList(
          "activity_log",
          params,
        );
        // Rename snake_case view columns to camelCase to match Activity type
        return {
          data: data.map((row: any) => ({
            ...row,
            contactNote: row.contact_note ?? undefined,
            dealNote: row.deal_note ?? undefined,
            contact_note: undefined,
            deal_note: undefined,
          })),
          total,
        };
      }

      return baseDataProvider.getList(resource, params);
    },
    async getOne(resource: string, params: any) {
      if (resource === "companies") {
        return baseDataProvider.getOne("companies_summary", params);
      }
      if (resource === "contacts") {
        return baseDataProvider.getOne("contacts_summary", params);
      }

      return baseDataProvider.getOne(resource, params);
    },

    async signUp({ email, password, first_name, last_name }: SignUpData) {
      const response = await getSupabaseClient().auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name,
            last_name,
          },
        },
      });

      if (!response.data?.user || response.error) {
        console.error("signUp.error", response.error);
        throw new Error(response?.error?.message || "Failed to create account");
      }

      // Update the is initialized cache
      (getIsInitialized as any)._is_initialized_cache = true;

      return {
        id: response.data.user.id,
        email,
        password,
      };
    },
    async salesCreate(body: SalesFormData) {
      const { data, error } = await getSupabaseClient().functions.invoke<{
        data: Sale;
      }>("users", {
        method: "POST",
        body,
      });

      if (!data || error) {
        console.error("salesCreate.error", error);
        const errorDetails = await (async () => {
          try {
            return (await error?.context?.json()) ?? {};
          } catch {
            return {};
          }
        })();
        throw new Error(errorDetails?.message || "Failed to create the user");
      }

      return data.data;
    },
    async salesUpdate(
      id: Identifier,
      data: Partial<Omit<SalesFormData, "password">>,
    ) {
      const { email, first_name, last_name, administrator, avatar, disabled } =
        data;

      const { data: updatedData, error } =
        await getSupabaseClient().functions.invoke<{
          data: Sale;
        }>("users", {
          method: "PATCH",
          body: {
            sales_id: id,
            email,
            first_name,
            last_name,
            administrator,
            disabled,
            avatar,
          },
        });

      if (!updatedData || error) {
        console.error("salesCreate.error", error);
        throw new Error("Failed to update account manager");
      }

      return updatedData.data;
    },
    async updatePassword(id: Identifier) {
      const { data: passwordUpdated, error } =
        await getSupabaseClient().functions.invoke<boolean>("update_password", {
          method: "PATCH",
          body: {
            sales_id: id,
          },
        });

      if (!passwordUpdated || error) {
        console.error("update_password.error", error);
        throw new Error("Failed to update password");
      }

      return passwordUpdated;
    },
    async unarchiveDeal(deal: Deal) {
      // get all deals where stage is the same as the deal to unarchive
      const { data: deals } = await baseDataProvider.getList<Deal>("deals", {
        filter: { stage: deal.stage },
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "index", order: "ASC" },
      });

      // set index for each deal starting from 1, if the deal to unarchive is found, set its index to the last one
      const updatedDeals = deals.map((d, index) => ({
        ...d,
        index: d.id === deal.id ? 0 : index + 1,
        archived_at: d.id === deal.id ? null : d.archived_at,
      }));

      return await Promise.all(
        updatedDeals.map((updatedDeal) =>
          baseDataProvider.update("deals", {
            id: updatedDeal.id,
            data: updatedDeal,
            previousData: deals.find((d) => d.id === updatedDeal.id),
          }),
        ),
      );
    },
    async isInitialized() {
      return getIsInitialized();
    },
    // Gate B: marking a sales call No-show changes the Sales Call, the
    // Opportunity, the Contact's tags and the Task lifecycle together.
    // Production runs it as ONE Postgres transaction so the CRM can never
    // land in a half-state (call recorded no_show while the Opportunity
    // stays in the active pipeline, or an exited Opportunity with no
    // visible Contact history) because a second client write failed.
    async recordSalesCallNoShow(salesCallId: Identifier) {
      const { data, error } = await getSupabaseClient().rpc(
        "record_sales_call_no_show",
        { p_sales_call_id: salesCallId },
      );
      if (error) {
        console.error("record_sales_call_no_show.error", error);
        throw new Error("Failed to record the sales call as a no-show");
      }
      return data as { status: string };
    },
    // Cancelling is one human action, so production runs it as ONE
    // transaction too: the CRM can never land with the call cancelled while
    // the Opportunity still claims a booked call, or with the task still
    // pending, because a second client write failed.
    async recordSalesCallCancelled(salesCallId: Identifier) {
      const { data, error } = await getSupabaseClient().rpc(
        "record_sales_call_cancelled",
        { p_sales_call_id: salesCallId },
      );
      if (error) {
        console.error("record_sales_call_cancelled.error", error);
        throw new Error("Failed to record the sales call as cancelled");
      }
      return data as { status: string };
    },
    // Creating an Application by hand also establishes the canonical
    // Application Received Opportunity it cannot be reviewed without.
    // Production runs it as ONE transaction so the CRM can never land
    // holding an Application with no Opportunity — a record that looks
    // like review work and cannot be worked — because a second client
    // write failed. See applications/createManualApplication.ts.
    async createManualApplication(input: {
      contactId: Identifier;
      offerId: Identifier;
      cohortId?: Identifier | null;
    }) {
      const { data, error } = await getSupabaseClient().rpc(
        "create_manual_application",
        {
          p_contact_id: input.contactId,
          p_offer_id: input.offerId,
          p_cohort_id: input.cohortId ?? null,
        },
      );
      if (error) {
        console.error("create_manual_application.error", error);
        throw new Error("Failed to create the application");
      }
      return data as Record<string, unknown>;
    },
    // Recording an application decision. One transaction and two row locks,
    // because this used to be four separate writes: fail between the
    // Application and the Opportunity and the Application carried a decision
    // its Opportunity had never heard of, and two concurrent reviewers could
    // both read 'pending' and both proceed. The Kit decision trigger fires
    // inside this transaction, exactly once, with its existing rule intact.
    // See applications/reviewApplication.ts.
    async reviewApplication(input: {
      applicationId: Identifier;
      outcome: string;
      cohortId?: Identifier | null;
    }) {
      const { data, error } = await getSupabaseClient().rpc(
        "review_application",
        {
          p_application_id: input.applicationId,
          p_outcome: input.outcome,
          // The destination ROUND, for a recommendation into a programme that
          // has rounds and more than one of them open. Sent as null otherwise,
          // which is what the authority expects and what makes it assign the
          // only eligible round itself.
          p_cohort_id: input.cohortId ?? null,
        },
      );
      if (error) {
        console.error("review_application.error", error);
        throw new Error("Failed to record the decision");
      }
      return data as {
        status: string;
        application_status?: string;
        candidates?: Array<{ id: Identifier; name: string }> | null;
        recommended_offer_name?: string | null;
      };
    },
    // Bringing an imported Application into current operations. One
    // transaction for the same reason as above: the Opportunity a decision
    // needs and the record that the owner brought this person in are one
    // piece of lifecycle truth, and a half-applied version of it is an
    // Application that still cannot be reviewed. It touches no Kit state
    // and makes no provider call. See applications/adoptApplication.ts.
    async adoptImportedApplication(applicationId: Identifier) {
      const { data, error } = await getSupabaseClient().rpc(
        "adopt_imported_application",
        { p_application_id: applicationId },
      );
      if (error) {
        console.error("adopt_imported_application.error", error);
        throw new Error("Failed to bring the application into the CRM");
      }
      return data as Record<string, unknown>;
    },
    // Recording an attended call's outcome changes the Sales Call, the
    // Opportunity, the Contact and — on a yes — the Enrollment, its
    // onboarding checklist and its Tasks. Becky Schmauch's sale is why
    // this is one transaction: it used to be six separate requests, the
    // first three committed, the fourth was refused, and she was left
    // with a call marked Attended against an Opportunity still at Call
    // Booked. See completeSalesCallOutcome.ts.
    async completeAttendedSalesCall(input: {
      salesCallId: Identifier;
      ownerDecision: string;
      prospectDecision?: string | null;
      followUpDate?: string | null;
    }) {
      const { data, error } = await getSupabaseClient().rpc(
        "complete_attended_sales_call",
        {
          p_sales_call_id: input.salesCallId,
          p_owner_decision: input.ownerDecision,
          p_prospect_decision: input.prospectDecision ?? null,
          p_follow_up_date: input.followUpDate || null,
        },
      );
      if (error) {
        console.error("complete_attended_sales_call.error", error);
        throw new Error("Failed to record the sales call outcome");
      }
      return data as Record<string, unknown>;
    },
    // The prospect accepted, recorded from a Decision control rather than
    // from a call. Same primitive underneath as the sales-call path —
    // accept_sale() — so there is one place a sale is accepted and not
    // three. Convergent: a sale that landed halfway finishes rather than
    // being politely refused forever.
    async recordProspectAccepted(opportunityId: Identifier) {
      const { data, error } = await getSupabaseClient().rpc(
        "record_prospect_accepted",
        { p_opportunity_id: opportunityId },
      );
      if (error) {
        console.error("record_prospect_accepted.error", error);
        throw new Error("Failed to record the sale");
      }
      return data as Record<string, unknown>;
    },
    // Moving an enrolled client between programmes, in ONE transaction: the
    // Opportunity, the onboarding checklist, the Tasks and the history move
    // together or not at all. The offer field itself is refused for anyone
    // with an Enrollment (handle_deal_saved), so this is the only way —
    // Jenna Smith spent a week with a GYU checklist under an LE sale because
    // the field was the way.
    async transferEnrolledOpportunityOffer(
      opportunityId: Identifier,
      toOfferId: Identifier,
    ) {
      const { data, error } = await getSupabaseClient().rpc(
        "transfer_enrolled_opportunity_offer",
        { p_opportunity_id: opportunityId, p_to_offer_id: toOfferId },
      );
      if (error) {
        console.error("transfer_enrolled_opportunity_offer.error", error);
        throw new Error("Failed to move this client to the other programme");
      }
      return data as Record<string, unknown>;
    },
    // The other half of the same story, and deliberately a different
    // authority: here the Opportunity's offer is already right and only the
    // Enrollment's projection is stale, which is what Jenna Smith's pre-guard
    // edit left behind. The transfer above refuses her, correctly.
    async reconcileEnrollmentToCurrentOffer(
      opportunityId: Identifier,
      fromOfferId: Identifier | null,
    ) {
      const { data, error } = await getSupabaseClient().rpc(
        "reconcile_enrollment_to_current_offer",
        { p_opportunity_id: opportunityId, p_from_offer_id: fromOfferId },
      );
      if (error) {
        console.error("reconcile_enrollment_to_current_offer.error", error);
        throw new Error("Failed to repair this client's onboarding");
      }
      return data as Record<string, unknown>;
    },
    // The account's tag catalog, so Leif chooses a real tag by name instead of
    // copying a number out of Kit. Owner-only, server-side, and a read.
    async kitTags() {
      const { data, error } = await getSupabaseClient().functions.invoke<{
        tags: Array<{ id: number; name: string }>;
      }>("kit_sync", { method: "POST", body: { action: "tags" } });
      if (error || !data) {
        console.error("kit_sync.tags.error", error);
        throw new Error("Failed to read the Kit tags");
      }
      return data.tags ?? [];
    },
    // Creating a tag attaches it to nobody. Kit's create is idempotent on
    // name, so asking for one that exists returns the existing tag.
    async createKitTag(name: string) {
      const { data, error } = await getSupabaseClient().functions.invoke<{
        tag: { id: number; name: string };
      }>("kit_sync", { method: "POST", body: { action: "create_tag", name } });
      if (error || !data?.tag) {
        console.error("kit_sync.create_tag.error", error);
        throw new Error("Failed to create the Kit tag");
      }
      return data.tag;
    },
    // What Kit reports for this person — the provider's own answer rather
    // than the CRM quoting its records back.
    async contactKitTags(contactId: Identifier) {
      const { data, error } = await getSupabaseClient().functions.invoke<{
        tags: Array<{ id: number; name: string }>;
        knownToKit: boolean;
      }>("kit_sync", {
        method: "POST",
        body: { action: "contact_tags", contactId },
      });
      if (error || !data) {
        console.error("kit_sync.contact_tags.error", error);
        throw new Error("Failed to read this person's Kit tags");
      }
      return { tags: data.tags ?? [], knownToKit: Boolean(data.knownToKit) };
    },
    // Ask for one tag on one human. The database decides whether it is
    // allowed and records it durably; the worker carries it out.
    async addKitTag(input: {
      contactId: Identifier;
      kitTagId: number;
      kitTagName: string;
      applicationId?: Identifier | null;
    }): Promise<AddKitTagResult> {
      const { data, error } = await getSupabaseClient().functions.invoke<{
        requested: { status: string; operation_id?: number };
      }>("kit_sync", {
        method: "POST",
        body: {
          action: "manual_tag",
          contactId: input.contactId,
          kitTagId: input.kitTagId,
          kitTagName: input.kitTagName,
          applicationId: input.applicationId ?? null,
        },
      });
      if (error || !data?.requested) {
        console.error("kit_sync.manual_tag.error", error);
        throw new Error("Failed to request the Kit tag");
      }
      return {
        status: data.requested.status as AddKitTagResult["status"],
        operationId: data.requested.operation_id,
      };
    },
    // Which tag a programme's event applies, from now on. Validating
    // authority; it never touches an operation that already exists.
    async setProgramKitTag(input: {
      offerId: Identifier;
      event: string;
      kitTagId: number | null;
      kitTagName: string | null;
    }) {
      const { data, error } = await getSupabaseClient().rpc(
        "set_program_kit_tag",
        {
          p_offer_id: input.offerId,
          p_event: input.event,
          p_kit_tag_id: input.kitTagId,
          p_kit_tag_name: input.kitTagName,
        },
      );
      if (error) {
        console.error("set_program_kit_tag.error", error);
        throw new Error("Failed to save the Kit tag for this programme");
      }
      return data as { status: string };
    },
    // Asking Kit again for one application's failed work.
    //
    // Through the Edge Function, never the database and never Kit directly:
    // KIT_API_KEY exists only in that function's environment, kit_sync_operations
    // is read-only to this session, and retry_kit_application_sync() is granted to
    // service_role alone. So the browser can say "try again for this applicant"
    // and nothing else — it cannot create work, name a tag, or disturb an
    // operation that already succeeded.
    async retryKitSync(applicationId: Identifier) {
      const { data, error } = await getSupabaseClient().functions.invoke<{
        requeued: number;
      }>("kit_sync", {
        method: "POST",
        body: { action: "retry", applicationId },
      });
      if (error || !data) {
        console.error("kit_sync.retry.error", error);
        throw new Error("Failed to retry the Kit sync");
      }
      return { requeued: data.requeued ?? 0 };
    },
    // Refused here as well as in the Edge Function, so that a merge cannot
    // leave this machine even if some future caller finds the method.
    // See contacts/contactSafety.ts.
    async mergeContacts(_sourceId: Identifier, _targetId: Identifier) {
      return refuseContactMerge();
    },
    // Deleting a Contact cascades into its opportunities, sales calls,
    // client sessions, notes, Stripe identities, tasks and waitlist
    // entries. Removing the buttons is not enough on its own — any caller
    // that reaches for delete gets the same answer.
    async delete(resource: string, params: any) {
      if (resource === "contacts") return refuseContactDelete();
      return baseDataProvider.delete(resource, params);
    },
    async deleteMany(resource: string, params: any) {
      if (resource === "contacts") return refuseContactDelete();
      return baseDataProvider.deleteMany(resource, params);
    },
    async getConfiguration(): Promise<ConfigurationContextValue> {
      const { data } = await baseDataProvider.getOne("configuration", {
        id: 1,
      });
      return (data?.config as ConfigurationContextValue) ?? {};
    },
    async updateConfiguration(
      config: ConfigurationContextValue,
    ): Promise<ConfigurationContextValue> {
      const { data } = await baseDataProvider.update("configuration", {
        id: 1,
        data: { config },
        previousData: { id: 1 },
      });
      return data.config as ConfigurationContextValue;
    },
  } satisfies DataProvider;
};

export type CrmDataProvider = ReturnType<
  typeof getDataProviderWithCustomMethods
>;

const processConfigLogo = async (logo: any): Promise<string> => {
  if (typeof logo === "string") return logo;
  if (logo?.rawFile instanceof File) {
    await uploadToBucket(logo);
    return logo.src;
  }
  return logo?.src ?? "";
};

const lifeCycleCallbacks: ResourceCallbacks[] = [
  {
    resource: "configuration",
    beforeUpdate: async (params) => {
      const config = params.data.config;
      if (config) {
        config.lightModeLogo = await processConfigLogo(config.lightModeLogo);
        config.darkModeLogo = await processConfigLogo(config.darkModeLogo);
      }
      return params;
    },
  },
  {
    resource: "contact_notes",
    beforeSave: async (data: ContactNote, _, __) => {
      if (data.attachments) {
        data.attachments = await Promise.all(
          data.attachments.map((fi) => uploadToBucket(fi)),
        );
      }
      return data;
    },
  },
  {
    resource: "deal_notes",
    beforeSave: async (data: DealNote, _, __) => {
      if (data.attachments) {
        data.attachments = await Promise.all(
          data.attachments.map((fi) => uploadToBucket(fi)),
        );
      }
      return data;
    },
  },
  {
    resource: "sales",
    beforeSave: async (data: Sale, _, __) => {
      if (data.avatar) {
        await uploadToBucket(data.avatar);
      }
      return data;
    },
  },
  {
    resource: "contacts",
    beforeGetList: async (params) => {
      return applyFullTextSearch([
        "first_name",
        "last_name",
        "company_name",
        "title",
        "email",
        "phone",
        "background",
        // The free-text note, and the handles providers know a person by.
        // Both are search metadata only: identity lives on the immutable
        // provider id, so finding somebody by "@handle" never implies two
        // Contacts with the same handle text are one person.
        "identifiers",
        "external_identifiers_fts",
      ])(params);
    },
  },
  {
    resource: "companies",
    beforeGetList: async (params) => {
      return applyFullTextSearch([
        "name",
        "phone_number",
        "website",
        "zipcode",
        "city",
        "state_abbr",
      ])(params);
    },
    beforeCreate: async (params) => {
      const createParams = await processCompanyLogo(params);

      return {
        ...createParams,
        data: {
          created_at: new Date().toISOString(),
          ...createParams.data,
        },
      };
    },
    beforeUpdate: async (params) => {
      return await processCompanyLogo(params);
    },
  },
  {
    resource: "contacts_summary",
    beforeGetList: async (params) => {
      // Search must find a person by name OR email — e.g. the Opportunity
      // "Person" field looking up a returning client by "chris@..." — not
      // just by name (Programs + Opportunity UX slice, §2).
      return applyFullTextSearch(["first_name", "last_name", "email"])(params);
    },
  },
  {
    resource: "deals",
    beforeGetList: async (params) => {
      return applyFullTextSearch(["name", "category", "description"])(params);
    },
  },
];

export const getDataProvider = () => {
  if (import.meta.env.VITE_SUPABASE_URL === undefined) {
    throw new Error("Please set the VITE_SUPABASE_URL environment variable");
  }
  if (import.meta.env.VITE_SB_PUBLISHABLE_KEY === undefined) {
    throw new Error(
      "Please set the VITE_SB_PUBLISHABLE_KEY environment variable",
    );
  }
  return withLifecycleCallbacks(
    getDataProviderWithCustomMethods(),
    lifeCycleCallbacks,
  ) as CrmDataProvider;
};

const applyFullTextSearch = (columns: string[]) => (params: GetListParams) => {
  if (!params.filter?.q) {
    return params;
  }
  const { q, ...filter } = params.filter;
  return {
    ...params,
    filter: {
      ...filter,
      "@or": columns.reduce((acc, column) => {
        if (column === "email")
          return {
            ...acc,
            [`email_fts@ilike`]: q,
          };
        if (column === "phone")
          return {
            ...acc,
            [`phone_fts@ilike`]: q,
          };
        else
          return {
            ...acc,
            [`${column}@ilike`]: q,
          };
      }, {}),
    },
  };
};

const uploadToBucket = async (fi: RAFile) => {
  if (!fi.src.startsWith("blob:") && !fi.src.startsWith("data:")) {
    // Sign URL check if path exists in the bucket
    if (fi.path) {
      const { error } = await getSupabaseClient()
        .storage.from(ATTACHMENTS_BUCKET)
        .createSignedUrl(fi.path, 60);

      if (!error) {
        return fi;
      }
    }
  }

  const dataContent = fi.src
    ? await fetch(fi.src)
        .then((res) => {
          if (res.status !== 200) {
            return null;
          }
          return res.blob();
        })
        .catch(() => null)
    : fi.rawFile;

  if (dataContent == null) {
    // We weren't able to download the file from its src (e.g. user must be signed in on another website to access it)
    // or the file has no content (not probable)
    // In that case, just return it as is: when trying to download it, users should be redirected to the other website
    // and see they need to be signed in. It will then be their responsibility to upload the file back to the note.
    return fi;
  }

  const file = fi.rawFile;
  const fileParts = file.name.split(".");
  const fileExt = fileParts.length > 1 ? `.${file.name.split(".").pop()}` : "";
  const fileName = `${Math.random()}${fileExt}`;
  const filePath = `${fileName}`;
  const { error: uploadError } = await getSupabaseClient()
    .storage.from(ATTACHMENTS_BUCKET)
    .upload(filePath, dataContent);

  if (uploadError) {
    console.error("uploadError", uploadError);
    throw new Error("Failed to upload attachment");
  }

  const { data } = getSupabaseClient()
    .storage.from(ATTACHMENTS_BUCKET)
    .getPublicUrl(filePath);

  fi.path = filePath;
  fi.src = data.publicUrl;

  // save MIME type
  const mimeType = file.type;
  fi.type = mimeType;

  return fi;
};
