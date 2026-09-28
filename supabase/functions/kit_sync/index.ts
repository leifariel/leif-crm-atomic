// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { createKitClient } from "../_shared/kit.ts";
import { processKitSyncOperations } from "./kitSyncProcessor.ts";

// The only thing in this system that holds the Kit credential.
//
// Nothing in the browser can reach Kit: the outbox is read-only to
// `authenticated`, the enqueue is SECURITY DEFINER, and `KIT_API_KEY` exists
// only in this function's environment. What the browser can do is ask this
// function to retry a particular application's failed work — with its own
// Supabase session, which is the same "prove who you are" posture
// sync_year_planning_calendar uses.
//
// Two legitimate callers, and neither may impersonate the other:
//
//   the five-minute cron job   carries x-cron-secret, because pg_net has no
//                              user session. It may `process`.
//   Leif's browser             carries his own Supabase JWT and no secret at
//                              all. It may `process` and `retry`.
//
// An unauthenticated caller — including the public application form, which
// reaches `public_application` and nothing else — may do neither.

type RetryBody = { action?: string; applicationId?: number | string };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const runProcessor = async () => {
  const apiKey = Deno.env.get("KIT_API_KEY");
  if (!apiKey) {
    // Checked before anything is claimed, so a missing key leaves the queue
    // exactly as it was rather than burning attempts on work that cannot
    // possibly succeed.
    return null;
  }

  const kit = createKitClient(apiKey);
  return await processKitSyncOperations({
    kit,
    db: {
      rpc: async (fn, args) => {
        const { data, error } = await supabaseAdmin.rpc(fn, args);
        return { data, error };
      },
      markSucceeded: async (id, subscriberId) => {
        const { error } = await supabaseAdmin
          .from("kit_sync_operations")
          .update({
            status: "succeeded",
            succeeded_at: new Date().toISOString(),
            kit_subscriber_id: subscriberId,
            failure_class: null,
            failure_reason: null,
            failed_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);
        if (error) throw new Error(error.message);
      },
      // A transient failure goes back to pending, so the next five-minute
      // pass simply tries again: Kit being briefly down must not turn into
      // an applicant waiting for somebody to notice. The class and reason are
      // still written, so what happened is legible either way — and a pending
      // row stays quiet in the UI until it has been waiting far too long.
      markFailed: async (id, failureClass, reason, requeue) => {
        const now = new Date().toISOString();
        const { error } = await supabaseAdmin
          .from("kit_sync_operations")
          .update({
            status: requeue ? "pending" : "failed",
            failed_at: requeue ? null : now,
            failure_class: failureClass,
            failure_reason: reason,
            updated_at: now,
          })
          .eq("id", id);
        if (error) throw new Error(error.message);
      },
    },
  });
};

const notConfigured = () =>
  createErrorResponse(503, "Kit is not configured for this project.");

Deno.serve(async (req: Request) =>
  OptionsMiddleware(req, async (req) => {
    if (req.method !== "POST") {
      return createErrorResponse(405, "Method Not Allowed");
    }

    let body: RetryBody;
    try {
      body = (await req.json()) as RetryBody;
    } catch {
      return createErrorResponse(400, "Invalid JSON body");
    }

    const authorization = req.headers.get("Authorization") ?? "";
    let isOwner = false;
    if (authorization.startsWith("Bearer ")) {
      const { data, error } = await supabaseAdmin.auth.getUser(
        authorization.slice("Bearer ".length),
      );
      if (error || !data?.user) {
        return createErrorResponse(401, "Unauthorized");
      }
      isOwner = true;
    }

    if (!isOwner) {
      const cronSecret = Deno.env.get("CRON_INVOKE_SECRET");
      if (!cronSecret) {
        return createErrorResponse(
          503,
          "Cron invocation secret is not configured.",
        );
      }
      if (req.headers.get("x-cron-secret") !== cronSecret) {
        // Deliberately generic — never confirm or deny which part of the
        // check failed, the same convention as every other function here.
        return createErrorResponse(401, "Invalid cron invocation secret.");
      }
    }

    try {
      if (body.action === "retry") {
        // Retrying is the owner's, not the schedule's: the cron job has no
        // application in front of it and no reason to single one out.
        if (!isOwner) {
          return createErrorResponse(403, "Retry requires a signed-in user.");
        }
        if (body.applicationId == null) {
          return createErrorResponse(400, "applicationId is required.");
        }
        // The database decides what may be retried. This function cannot
        // create an operation, choose a tag, or disturb one that succeeded —
        // retry_kit_application_sync only ever returns failed work to pending.
        const { data: requeued, error } = await supabaseAdmin.rpc(
          "retry_kit_application_sync",
          { p_application_id: body.applicationId },
        );
        if (error) {
          console.error("kit_sync retry error:", error.message);
          return createErrorResponse(500, "Could not queue the retry.");
        }
        const summary = await runProcessor();
        if (summary === null) return notConfigured();
        return jsonResponse({ requeued: requeued ?? 0, ...summary });
      }

      if (body.action === "process" || body.action == null) {
        const summary = await runProcessor();
        if (summary === null) return notConfigured();
        return jsonResponse(summary);
      }

      return createErrorResponse(400, "Unknown action");
    } catch (error) {
      // Never the provider's words and never the key: the client gets a shape
      // it can act on, the server log gets the message and nothing more.
      console.error(
        "kit_sync error:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return createErrorResponse(500, "Failed to process Kit sync");
    }
  }),
);
