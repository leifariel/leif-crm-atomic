import { beforeEach, describe, expect, it, vi } from "vitest";

// WHAT THE TOAST SAYS.
//
// On a non-2xx, supabase-js throws FunctionsHttpError and its `message` is
// the generic "Edge Function returned a non-2xx status code". The body the
// function actually sent is on `context`, a Response nobody was reading —
// so the Edge Function could say "Your session has expired. Sign in again
// and retry." and Leif would still see an opaque failure. That is exactly
// what happened on 2026-10-10: one wasted click and a blind diagnosis.

const invoke = vi.hoisted(() => vi.fn());

vi.mock("../providers/supabase/supabase", () => ({
  getSupabaseClient: () => ({ functions: { invoke } }),
}));

import { syncYearTracking } from "./syncYearTracking";

/** A FunctionsHttpError as supabase-js actually shapes it. */
const httpError = (status: number, serverBody: unknown) => ({
  name: "FunctionsHttpError",
  message: "Edge Function returned a non-2xx status code",
  context: new Response(JSON.stringify(serverBody), {
    status,
    headers: { "Content-Type": "application/json" },
  }),
});

beforeEach(() => {
  invoke.mockReset();
});

describe("Sync Calendar reports what the server said", () => {
  it("shows the expired-session message, not the generic one", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: httpError(401, {
        status: 401,
        message: "Your session has expired. Sign in again and retry.",
      }),
    });

    const result = await syncYearTracking();

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toBe(
      "Your session has expired. Sign in again and retry.",
    );
    expect(result.message).not.toContain("non-2xx");
  });

  it("shows the sync failure, including that pressing it again is safe", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: httpError(500, {
        status: 500,
        message:
          "Calendar sync failed part-way: Failed to fetch the Year Planning calendar feed: 503. Steps that already finished stayed applied, and running it again is safe.",
      }),
    });

    const result = await syncYearTracking();

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("calendar feed: 503");
    expect(result.message).toContain("running it again is safe");
  });

  it("falls back to its own words when the server sent none", async () => {
    // A network failure has no response body at all. The old copy is still
    // the right thing to say then.
    invoke.mockResolvedValue({
      data: null,
      error: { name: "FunctionsFetchError", message: "" },
    });

    const result = await syncYearTracking();

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toBe(
      "The Year Tracking calendar could not be reached.",
    );
  });

  it("still reports the counts on success", async () => {
    invoke.mockResolvedValue({
      data: {
        windowsUpserted: 56,
        windowsDeleted: 1,
        assignment: {
          assignmentsCreated: 3,
          slotsRenumbered: 2,
          slotsRetiredWithHistory: 1,
        },
      },
      error: null,
    });

    const result = await syncYearTracking();

    expect(result).toEqual({
      status: "ok",
      windowsUpserted: 56,
      windowsDeleted: 1,
      assignmentsCreated: 3,
      slotsRenumbered: 2,
      slotsRetiredWithHistory: 1,
    });
  });
});
