import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { runSync } from "./runSync.ts";

// WHO IS ASKING, AND WHAT TO SAY WHEN IT GOES WRONG.
//
// Two legitimate callers and two failure modes, and for a while only one
// of each was handled deliberately. The cron path wrapped runSync() in
// try/catch and logged; the browser path awaited it bare, so a throw
// became an unlogged 500. On 2026-10-10 Leif's first Sync Calendar click
// did nothing and said nothing, worked immediately after she signed out
// and in, and no record existed of which failure it had been. Both paths
// are explicit now, and both say something she can act on.
//
// Separated from index.ts so it can be tested: index.ts only calls
// Deno.serve, the same shape acuity_webhook uses.
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

export const handleRequest = async (req: Request): Promise<Response> =>
  OptionsMiddleware(req, async (req) => {
    if (req.method !== "POST") {
      return createErrorResponse(405, "Method Not Allowed");
    }

    // Two legitimate callers, and neither may impersonate the other.
    //
    // The scheduled job carries the shared cron secret, because pg_net
    // has no user session. Leif pressing Sync Calendar carries his own
    // Supabase JWT and no secret at all — the browser must never hold
    // one. Either proves the caller; nothing else does.
    const authorization = req.headers.get("Authorization") ?? "";
    if (authorization.startsWith("Bearer ")) {
      const { data, error } = await supabaseAdmin.auth.getUser(
        authorization.slice("Bearer ".length),
      );
      if (error || !data?.user) {
        // A STALE SESSION SAYS SO. This used to answer "Unauthorized",
        // which reached Leif as an opaque failed toast and cost a whole
        // diagnosis: on 2026-10-10 the first Sync Calendar click did
        // nothing, said nothing, and worked immediately after signing out
        // and in. Nothing recorded which of the two had happened.
        console.error(
          "sync_year_planning_calendar: rejected a browser call —",
          error?.message ?? "the token resolved to no user",
        );
        return createErrorResponse(
          401,
          "Your session has expired. Sign in again and retry.",
        );
      }

      // The browser path gets the SAME deliberate handling as the cron
      // path below. It had none: runSync() was awaited bare, so a throw
      // became an unlogged 500 and the reason was lost.
      try {
        const result = await runSync();
        return jsonResponse(result);
      } catch (syncError) {
        const detail =
          syncError instanceof Error ? syncError.message : "Unknown error";
        // The internal detail goes to the logs, where it is useful and
        // safe. What comes back is true without being a stack trace.
        console.error("sync_year_planning_calendar error:", detail);
        return createErrorResponse(
          500,
          // NOT "nothing was changed" — that would be a lie. The four
          // stages are four sets of writes, not one transaction, so a
          // failure part-way leaves the earlier ones applied. Every stage
          // finds-or-creates by a unique index, which is why running it
          // again is genuinely safe rather than merely tolerable.
          `Calendar sync failed part-way: ${detail}. Steps that already finished stayed applied, and running it again is safe.`,
        );
      }
    }

    const cronSecret = Deno.env.get("CRON_INVOKE_SECRET");
    if (!cronSecret) {
      return createErrorResponse(
        503,
        "Cron invocation secret is not configured.",
      );
    }
    if (req.headers.get("x-cron-secret") !== cronSecret) {
      // Deliberately generic — never confirm/deny which part of the
      // check failed, same convention as acuity_webhook's own signature
      // check.
      return createErrorResponse(401, "Invalid cron invocation secret.");
    }

    try {
      const result = await runSync();
      return jsonResponse(result);
    } catch (error) {
      console.error(
        "sync_year_planning_calendar error:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return createErrorResponse(
        500,
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  });
