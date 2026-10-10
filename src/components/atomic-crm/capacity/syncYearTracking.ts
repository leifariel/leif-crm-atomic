import { getSupabaseClient } from "../providers/supabase/supabase";

// "Sync Calendar" — refresh Year Tracking.
//
// Deliberately the same shape as deals/syncStripe.ts: the browser holds no
// credential, supabase.functions.invoke carries the signed-in user's own
// JWT, and the Edge Function that already owns this integration does the
// work. There is exactly one Google Calendar synchronisation path in this
// repository and this calls it — sync_year_planning_calendar, the same
// function the scheduled job runs.
//
// That function authenticates the scheduled job with a shared cron secret,
// which pg_net needs because it has no user session. A browser must never
// hold that secret, so the function accepts a second, equally explicit
// proof instead: a valid Supabase JWT, which invoke() attaches. Neither
// caller can impersonate the other.
//
// Re-running it is safe. Every `1:1s` event upserts by (calendar id, event
// id) against a unique index, so a second run resolves to the same row
// rather than a duplicate week; an event that has vanished from the
// calendar is soft-deleted rather than removed, because a cadence issue
// may still reference it. The session-week pass that follows REBUILDS each
// container from the refreshed calendar rather than appending to it, so a
// sync can never leave the capacity board and a client's own session plan
// describing different timelines.
export type SyncCalendarResult =
  | {
      status: "ok";
      // Weeks the calendar now holds, and how many were newly seen.
      windowsUpserted: number;
      windowsDeleted: number;
      // The derived schedule this sync rebuilt, not just the calendar it
      // read. Sync Calendar leaves both in agreement or it has not
      // finished.
      assignmentsCreated: number;
      slotsRenumbered: number;
      slotsRetiredWithHistory: number;
    }
  | { status: "error"; message: string };

// The message the FUNCTION sent, not the one the client library made up.
//
// On a non-2xx, supabase-js throws FunctionsHttpError and its `message` is
// the generic "Edge Function returned a non-2xx status code" — the body it
// came with is on `context`, a Response nobody was reading. So the server
// could say "Your session has expired. Sign in again and retry." and Leif
// would still get an opaque toast, which is exactly what happened on
// 2026-10-10.
const serverMessage = async (error: unknown): Promise<string | null> => {
  const response = (error as { context?: unknown } | null)?.context;
  if (response instanceof Response) {
    try {
      const body = (await response.clone().json()) as { message?: unknown };
      if (typeof body?.message === "string" && body.message.trim() !== "") {
        return body.message;
      }
    } catch {
      // A non-JSON body is no worse than the generic message below.
    }
  }
  const fallback = (error as { message?: unknown } | null)?.message;
  return typeof fallback === "string" && fallback.trim() !== ""
    ? fallback
    : null;
};

export const syncYearTracking = async (): Promise<SyncCalendarResult> => {
  const { data, error } = await getSupabaseClient().functions.invoke<{
    windowsUpserted?: number;
    windowsDeleted?: number;
    assignment?: {
      enrollmentsRebuilt?: number;
      assignmentsCreated?: number;
      slotsRenumbered?: number;
      slotsRetiredWithHistory?: number;
    };
  }>("sync_year_planning_calendar", { method: "POST", body: {} });

  if (error) {
    return {
      status: "error",
      // The calendar not answering is a real, reportable state — never
      // silently leaving the old weeks on screen as though they were
      // fresh. And it has to say WHICH state: a stale session and an
      // unreachable calendar need different things from Leif.
      message:
        (await serverMessage(error)) ??
        "The Year Tracking calendar could not be reached.",
    };
  }

  return {
    status: "ok",
    windowsUpserted: data?.windowsUpserted ?? 0,
    windowsDeleted: data?.windowsDeleted ?? 0,
    assignmentsCreated: data?.assignment?.assignmentsCreated ?? 0,
    slotsRenumbered: data?.assignment?.slotsRenumbered ?? 0,
    slotsRetiredWithHistory: data?.assignment?.slotsRetiredWithHistory ?? 0,
  };
};
