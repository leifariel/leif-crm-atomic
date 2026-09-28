// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { classifyKitStatus, createKitClient, redactKey } from "./kit";

// The provider contract, held against a mock. Nothing here reaches Kit: a
// real call would tag a real person and could fire a real email sequence,
// which is exactly what automated tests must never be able to do.

const KEY = "kit_secret_do_not_leak";

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
});
const notOk = (status: number, body: unknown = {}) => ({
  ok: false,
  status,
  json: () => Promise.resolve(body),
});

describe("the Kit v4 request shape", () => {
  it("upserts a subscriber by email, authenticated with the v4 header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ subscriber: { id: 42 } }));
    const kit = createKitClient(KEY, fetchSpy as unknown as typeof fetch);

    const result = await kit.upsertSubscriber("ada@example.com");

    expect(result).toEqual({ ok: true, value: { subscriberId: "42" } });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.kit.com/v4/subscribers");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Kit-Api-Key"]).toBe(KEY);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ email_address: "ada@example.com" });
  });

  it("adds a tag by id, naming the subscriber by email", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ subscriber: { id: 42 } }));
    const kit = createKitClient(KEY, fetchSpy as unknown as typeof fetch);

    const result = await kit.addTag(24082722, "ada@example.com");

    expect(result.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.kit.com/v4/tags/24082722/subscribers");
    expect(JSON.parse(init.body)).toEqual({ email_address: "ada@example.com" });
  });

  it("never asks Kit to add anybody to a form, a sequence or an automation", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ subscriber: { id: 1 } }));
    const kit = createKitClient(KEY, fetchSpy as unknown as typeof fetch);

    await kit.upsertSubscriber("ada@example.com");
    await kit.addTag(21784073, "ada@example.com");

    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    for (const url of urls) {
      expect(url).not.toMatch(/\/forms\//);
      expect(url).not.toMatch(/\/sequences\//);
      expect(url).not.toMatch(/\/automations?\//);
      expect(url).not.toMatch(/broadcast/);
    }
  });

  it("refuses to call a tag applied when Kit returned no subscriber", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({}));
    const kit = createKitClient(KEY, fetchSpy as unknown as typeof fetch);

    const result = await kit.upsertSubscriber("ada@example.com");

    expect(result.ok).toBe(false);
  });
});

describe("what a failure means", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
    [503, "provider_unavailable"],
    [422, "rejected"],
    [404, "rejected"],
    [400, "rejected"],
  ])("classifies %i as %s", (status, expected) => {
    expect(classifyKitStatus(status)).toBe(expected);
  });

  it("classifies a refusal and keeps Kit's own words, briefly", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(notOk(422, { errors: ["Tag not found"] }));
    const kit = createKitClient(KEY, fetchSpy as unknown as typeof fetch);

    const result = await kit.addTag(999, "ada@example.com");

    expect(result).toEqual({
      ok: false,
      failureClass: "rejected",
      reason: "Kit responded 422: Tag not found",
    });
  });

  it("survives a body that is not JSON at all", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error("not json")),
    });
    const kit = createKitClient(KEY, fetchSpy as unknown as typeof fetch);

    const result = await kit.upsertSubscriber("ada@example.com");

    expect(result).toEqual({
      ok: false,
      failureClass: "provider_unavailable",
      reason: "Kit responded 503",
    });
  });

  it("treats an unreachable Kit as a network failure, not a refusal", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const kit = createKitClient(KEY, fetchSpy as unknown as typeof fetch);

    const result = await kit.upsertSubscriber("ada@example.com");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureClass).toBe("network");
  });
});

describe("the credential never leaves the function", () => {
  it("keeps the key out of a stored reason even when Kit echoes it back", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(notOk(401, { errors: [`Bad key ${KEY}`] }));
    const kit = createKitClient(KEY, fetchSpy as unknown as typeof fetch);

    const result = await kit.addTag(1, "ada@example.com");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain(KEY);
    expect(result.reason).toContain("[redacted]");
  });

  it("keeps it out of a network error message too", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(new Error(`connect failed using ${KEY}`));
    const kit = createKitClient(KEY, fetchSpy as unknown as typeof fetch);

    const result = await kit.upsertSubscriber("ada@example.com");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain(KEY);
  });

  it("caps what it keeps, so no provider payload is stored wholesale", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(notOk(422, { errors: ["x".repeat(5000)] }));
    const kit = createKitClient(KEY, fetchSpy as unknown as typeof fetch);

    const result = await kit.addTag(1, "ada@example.com");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeLessThanOrEqual(200);
  });

  it("redacts nothing when there is no key to redact", () => {
    expect(redactKey("plain text", "")).toBe("plain text");
  });
});
