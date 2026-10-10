// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleRequest } from "./handleRequest.ts";

// Thin on purpose. What this function DOES lives in runSync.ts and who may
// ask lives in handleRequest.ts, so both are reachable from a test —
// Deno.serve at module scope is not. Same shape as acuity_webhook.
Deno.serve(handleRequest);
