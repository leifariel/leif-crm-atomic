import type { DataProvider, Identifier } from "ra-core";

import type { KitSyncOperation } from "../types";

// Asking again.
//
// The browser never talks to Kit and never names a Kit tag: it asks the
// kit_sync Edge Function, which holds the credential, and that function asks
// retry_kit_application_sync(), which only ever returns FAILED work to
// pending. Nothing here can create an operation, choose a tag, or disturb one
// that already succeeded — so pressing Retry twice, or pressing it after it
// worked, is safe by construction rather than by care.

export type RetryKitSyncResult = { requeued: number };

type KitRetryCapableProvider = DataProvider & {
  retryKitSync?: (applicationId: Identifier) => Promise<RetryKitSyncResult>;
};

export const retryKitSync = async (
  dataProvider: DataProvider,
  applicationId: Identifier,
): Promise<RetryKitSyncResult> => {
  const rpc = (dataProvider as KitRetryCapableProvider).retryKitSync;
  if (typeof rpc === "function") return await rpc(applicationId);
  return retryKitSyncMirror(dataProvider, applicationId);
};

/**
 * The database half, for the provider that has no Edge Function behind it.
 * Deliberately only the half that is real — it re-queues failed work exactly as
 * retry_kit_application_sync() does, and stops there. There is no Kit to call
 * and nothing here pretends otherwise.
 */
export const retryKitSyncMirror = async (
  dataProvider: DataProvider,
  applicationId: Identifier,
): Promise<RetryKitSyncResult> => {
  const { data: operations } = await dataProvider.getList<KitSyncOperation>(
    "kit_sync_operations",
    {
      filter: { application_id: applicationId },
      pagination: { page: 1, perPage: 50 },
      sort: { field: "id", order: "ASC" },
    },
  );

  const failed = operations.filter(
    (operation) => operation.status === "failed",
  );
  for (const operation of failed) {
    await dataProvider.update("kit_sync_operations", {
      id: operation.id,
      data: {
        status: "pending",
        failure_class: null,
        failure_reason: null,
        failed_at: null,
      },
      previousData: operation,
    });
  }

  return { requeued: failed.length };
};
