// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { createKitClient } from "../_shared/kit.ts";
import { processKitSyncOperations } from "./kitSyncProcessor.ts";
import { runWaitlistPreflight } from "./waitlistPreflight.ts";

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

type RequestBody = {
  action?: string;
  offerId?: number | string;
  cohortId?: number | string | null;
  requested?: number | string;
  entryIds?: Array<number | string>;
  applicationId?: number | string;
  contactId?: number | string;
  kitTagId?: number | string;
  kitTagName?: string;
  name?: string;
};

// The owner-only surface. Everything here is Leif choosing a tag or looking at
// the catalog, so all of it requires his own Supabase session — the cron
// secret proves a schedule, which is not a person, and a schedule has no
// business creating a tag.
const ownerOnly = new Set([
  "retry",
  "tags",
  "create_tag",
  "contact_tags",
  "manual_tag",
  // Asking Kit about people is the owner looking at her own list; a
  // schedule has nobody in front of it and no batch to plan.
  "waitlist_preflight",
]);

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

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return createErrorResponse(400, "Invalid JSON body");
    }

    const authorization = req.headers.get("Authorization") ?? "";
    let isOwner = false;
    // Who asked, when a person did. Recorded on a preflight so an audit can
    // say whose list it was; never used to decide what is allowed, which is
    // isOwner's job.
    let ownerEmail: string | null = null;
    if (authorization.startsWith("Bearer ")) {
      const { data, error } = await supabaseAdmin.auth.getUser(
        authorization.slice("Bearer ".length),
      );
      if (error || !data?.user) {
        return createErrorResponse(401, "Unauthorized");
      }
      isOwner = true;
      ownerEmail = data.user.email ?? null;
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
      if (body.action && ownerOnly.has(body.action) && !isOwner) {
        return createErrorResponse(403, "This requires a signed-in user.");
      }

      // The tag catalog, so Leif picks a real tag by name instead of copying
      // a number out of Kit. A read; it changes nothing.
      if (body.action === "tags") {
        const apiKey = Deno.env.get("KIT_API_KEY");
        if (!apiKey) return notConfigured();
        const result = await createKitClient(apiKey).listTags();
        if (!result.ok) {
          return createErrorResponse(502, "Could not read the Kit tags.", {
            failureClass: result.failureClass,
            detail: result.reason,
          });
        }
        return jsonResponse({ tags: result.value });
      }

      // Creating a tag attaches it to nobody — it only makes the tag exist so
      // it can be chosen. Kit's own create is idempotent on name, so asking
      // for one that exists returns the existing tag rather than a duplicate.
      if (body.action === "create_tag") {
        const apiKey = Deno.env.get("KIT_API_KEY");
        if (!apiKey) return notConfigured();
        const name = String(body.name ?? "").trim();
        if (!name) return createErrorResponse(400, "A tag name is required.");
        const result = await createKitClient(apiKey).createTag(name);
        if (!result.ok) {
          return createErrorResponse(502, "Kit would not create that tag.", {
            failureClass: result.failureClass,
            detail: result.reason,
          });
        }
        return jsonResponse({ tag: result.value });
      }

      // What Kit says this person actually carries — the truest answer
      // available, rather than the CRM quoting its own records back. Silent
      // when the CRM has never seen them in Kit, which is itself the answer.
      if (body.action === "contact_tags") {
        const apiKey = Deno.env.get("KIT_API_KEY");
        if (!apiKey) return notConfigured();
        if (body.contactId == null) {
          return createErrorResponse(400, "contactId is required.");
        }
        const { data: identity } = await supabaseAdmin
          .from("contact_external_identities")
          .select("external_user_id")
          .eq("provider", "kit")
          .eq("contact_id", body.contactId)
          .maybeSingle();
        if (!identity?.external_user_id) {
          return jsonResponse({ tags: [], knownToKit: false });
        }
        const result = await createKitClient(apiKey).subscriberTags(
          String(identity.external_user_id),
        );
        if (!result.ok) {
          return createErrorResponse(
            502,
            "Could not read this person's Kit tags.",
            {
              failureClass: result.failureClass,
              detail: result.reason,
            },
          );
        }
        return jsonResponse({ tags: result.value, knownToKit: true });
      }

      // Asking for one tag on one human. The database decides whether the
      // request is allowed and records it durably; this function only carries
      // it out, through the same worker as everything automatic.
      if (body.action === "manual_tag") {
        if (body.contactId == null || body.kitTagId == null) {
          return createErrorResponse(
            400,
            "contactId and kitTagId are required.",
          );
        }
        const { data: requested, error } = await supabaseAdmin.rpc(
          "request_kit_manual_tag",
          {
            p_contact_id: body.contactId,
            p_kit_tag_id: body.kitTagId,
            p_kit_tag_name: body.kitTagName ?? null,
            p_application_id: body.applicationId ?? null,
          },
        );
        if (error) {
          console.error("kit_sync manual_tag error:", error.message);
          return createErrorResponse(500, "Could not record the tag request.");
        }
        const summary = await runProcessor();
        if (summary === null) return notConfigured();
        return jsonResponse({ requested, ...summary });
      }

      // Who could actually be invited off a waitlist, Kit's answer
      // included. A READ: it asks Kit about each candidate in turn, writes
      // down what Kit said, and stops when it has as many safe people as
      // were asked for. It tags nobody, enqueues nothing, and moves no
      // waitlist place — the snapshot it leaves is what Leif confirms, and
      // invite_from_preflight() is what acts on it.
      if (body.action === "waitlist_preflight") {
        if (body.offerId == null || body.requested == null) {
          return createErrorResponse(
            400,
            "offerId and requested are required.",
          );
        }
        const apiKey = Deno.env.get("KIT_API_KEY");
        if (!apiKey) return notConfigured();
        const offerId = Number(body.offerId);
        const cohortId = body.cohortId == null ? null : Number(body.cohortId);
        const requested = Number(body.requested);
        if (!Number.isFinite(requested) || requested < 1 || requested > 500) {
          return createErrorResponse(400, "requested must be 1 to 500.");
        }

        const result = await runWaitlistPreflight({
          kit: createKitClient(apiKey),
          offerId,
          cohortId,
          requested,
          entryIds: Array.isArray(body.entryIds)
            ? body.entryIds.map((id) => Number(id))
            : null,
          createdBy: ownerEmail,
          db: {
            candidates: async (offer, cohort) => {
              const { data, error } = await supabaseAdmin.rpc(
                "waitlist_invitation_candidates",
                { p_offer_id: offer, p_cohort_id: cohort },
              );
              if (error) throw new Error(error.message);
              return data ?? [];
            },
            saveSnapshot: async (input) => {
              const { data: preflight, error } = await supabaseAdmin
                .from("waitlist_invitation_preflights")
                .insert({
                  offer_id: input.offerId,
                  cohort_id: input.cohortId,
                  requested: input.requested,
                  resolved: input.resolved,
                  created_by: input.createdBy,
                })
                .select("id")
                .single();
              if (error) throw new Error(error.message);
              if (input.rows.length > 0) {
                const { error: rowsError } = await supabaseAdmin
                  .from("waitlist_invitation_preflight_candidates")
                  .insert(
                    input.rows.map((row) => ({
                      preflight_id: preflight.id,
                      waitlist_entry_id: row.waitlistEntryId,
                      contact_id: row.contactId,
                      contact_name: row.name,
                      email: row.email,
                      joined_at: row.joinedAt,
                      db_eligible: row.dbEligible,
                      db_exclusion_reason: row.dbExclusionReason,
                      kit_subscriber_id: row.kitSubscriberId,
                      kit_state: row.kitState,
                      kit_checked_at: row.kitCheckedAt,
                      final_eligible: row.finalEligible,
                      exclusion_reason: row.exclusionReason,
                      final_rank: row.finalRank,
                    })),
                  );
                if (rowsError) throw new Error(rowsError.message);
              }
              return { preflightId: preflight.id as number };
            },
          },
        });
        return jsonResponse(result);
      }

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
