// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WHAT LEIF IS TOLD WHEN A SYNC FAILS.
//
// On 2026-10-10 she pressed Sync Calendar, nothing happened, and nothing
// said why. It worked immediately after she signed out and in. The cause is
// still only inferred, because the browser path awaited runSync() bare: a
// throw became an unlogged 500, and a rejected token said "Unauthorized" to
// a server that logged nothing. Neither failure left a trace.
//
// These hold both paths to deliberate handling, and hold the COPY to being
// actionable and true — in particular not claiming that nothing changed,
// because the four stages are four sets of writes rather than one
// transaction.

const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
}));
const sync = vi.hoisted(() => ({ runSync: vi.fn() }));

vi.mock("../_shared/supabaseAdmin.ts", () => ({
  supabaseAdmin: { auth: auth },
}));
vi.mock("./runSync.ts", () => ({
  runSync: () => sync.runSync(),
}));

import { handleRequest } from "./handleRequest";

const SECRET = "cron-secret-for-the-test";
const post = (headers: Record<string, string> = {}) =>
  new Request("https://example.test/sync", { method: "POST", headers });

const body = async (response: Response) =>
  (await response.json()) as { message?: string; ok?: boolean };

let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  // The cron secret is read from the environment on the cron path.
  (globalThis as { Deno?: unknown }).Deno = {
    env: {
      get: (name: string) =>
        name === "CRON_INVOKE_SECRET" ? SECRET : undefined,
    },
  };
  auth.getUser.mockReset();
  sync.runSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the browser path", () => {
  it("tells Leif her session expired, and records why", async () => {
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "jwt expired" },
    });

    const response = await handleRequest(
      post({ Authorization: "Bearer stale" }),
    );

    expect(response.status).toBe(401);
    // Actionable, not "Unauthorized".
    expect((await body(response)).message).toBe(
      "Your session has expired. Sign in again and retry.",
    );
    // And the server said which of the two failures this was.
    expect(errors.join(" ")).toContain("rejected a browser call");
    expect(errors.join(" ")).toContain("jwt expired");
    // Nothing was attempted.
    expect(sync.runSync).not.toHaveBeenCalled();
  });

  it("catches a sync failure, logs the detail, and says what is true", async () => {
    auth.getUser.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
    sync.runSync.mockRejectedValue(
      new Error("Failed to fetch the Year Planning calendar feed: 503"),
    );

    const response = await handleRequest(
      post({ Authorization: "Bearer good" }),
    );

    expect(response.status).toBe(500);
    const message = (await body(response)).message ?? "";
    // The real reason reaches her, rather than a generic 500.
    expect(message).toContain("Year Planning calendar feed: 503");
    // It is safe to press again, and it says so.
    expect(message).toContain("running it again is safe");
    // And it does NOT claim the run left nothing behind: the stages are not
    // one transaction, so earlier writes stayed applied.
    expect(message).toContain("stayed applied");
    expect(message).not.toMatch(/nothing was changed/i);
    // The detail is in the logs too.
    expect(errors.join(" ")).toContain("sync_year_planning_calendar error:");
  });

  it("returns the sync's own result when it succeeds", async () => {
    auth.getUser.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
    sync.runSync.mockResolvedValue({ ok: true });

    const response = await handleRequest(
      post({ Authorization: "Bearer good" }),
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ ok: true });
    expect(errors).toEqual([]);
  });
});

describe("the cron path", () => {
  it("still catches and logs a sync failure", async () => {
    sync.runSync.mockRejectedValue(new Error("calendar unreachable"));

    const response = await handleRequest(post({ "x-cron-secret": SECRET }));

    expect(response.status).toBe(500);
    expect((await body(response)).message).toContain("calendar unreachable");
    expect(errors.join(" ")).toContain("sync_year_planning_calendar error:");
  });

  it("refuses a wrong secret without saying which part failed", async () => {
    const response = await handleRequest(post({ "x-cron-secret": "wrong" }));

    expect(response.status).toBe(401);
    expect((await body(response)).message).toBe(
      "Invalid cron invocation secret.",
    );
    expect(sync.runSync).not.toHaveBeenCalled();
  });
});

describe("both paths", () => {
  // The equivalence that was missing: a thrown runSync must be caught and
  // logged whoever asked. Only the wording differs, because only one of the
  // two callers is a person who can act on it.
  it.each([
    { who: "the browser", headers: { Authorization: "Bearer good" } },
    { who: "the cron job", headers: { "x-cron-secret": SECRET } },
  ])("$who gets a described 500 and a log line", async ({ headers }) => {
    auth.getUser.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
    sync.runSync.mockRejectedValue(new Error("boom"));

    const response = await handleRequest(post(headers));

    expect(response.status).toBe(500);
    expect((await body(response)).message).toContain("boom");
    expect(errors.join(" ")).toContain("sync_year_planning_calendar error:");
  });
});
