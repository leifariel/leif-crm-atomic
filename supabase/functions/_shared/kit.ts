// Kit (formerly ConvertKit) v4, and nothing more than the CRM needs.
//
// The integration's whole responsibility is two calls: make sure the person
// exists as a subscriber, and add a tag. It never creates a form, a sequence
// or an automation, and it never sends an email — which tag triggers which
// email is decided in Kit, by Leif, with no change here.
//
// Authentication is the v4 header, `X-Kit-Api-Key`. The key lives in the Edge
// Function's own environment and is passed in as an argument: nothing in this
// module reads it from anywhere, so it cannot leak into a bundle, a log line
// or an error message by accident. `redactKey` is the belt to that braces —
// every outgoing reason is passed through it before it is stored.

export type KitFailureClass =
  | "auth"
  | "rejected"
  | "rate_limited"
  | "provider_unavailable"
  | "network"
  | "not_configured"
  | "unknown";

export type KitResult<T> =
  | { ok: true; value: T }
  | { ok: false; failureClass: KitFailureClass; reason: string };

export const KIT_API_BASE = "https://api.kit.com/v4";

// What a status code means for "should anyone retry this?".
//
//   auth                  the key is wrong or revoked. Retrying changes
//                         nothing until Leif replaces it.
//   rejected              Kit understood and said no — a tag id that does not
//                         exist, an address it will not accept. A human has to
//                         look; another attempt will be refused identically.
//   rate_limited          too fast. The next cron pass is the fix.
//   provider_unavailable  Kit is having a bad minute. Retry.
export const classifyKitStatus = (status: number): KitFailureClass => {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  if (status >= 400) return "rejected";
  return "unknown";
};

// Never let the credential reach a stored reason, a console line, or a
// response body — not even if a provider echoes it back at us.
export const redactKey = (text: string, apiKey: string): string =>
  apiKey ? text.split(apiKey).join("[redacted]") : text;

const MAX_REASON = 200;

const readErrorReason = async (
  response: Response,
  apiKey: string,
): Promise<string> => {
  let detail = "";
  try {
    const body = (await response.json()) as { errors?: unknown };
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      detail = String(body.errors[0]);
    }
  } catch {
    // A non-JSON body tells us nothing worth storing.
  }
  const reason = detail
    ? `Kit responded ${response.status}: ${detail}`
    : `Kit responded ${response.status}`;
  return redactKey(reason, apiKey).slice(0, MAX_REASON);
};

const subscriberIdOf = (body: unknown): string | null => {
  const subscriber = (body as { subscriber?: { id?: unknown } } | null)
    ?.subscriber;
  const id = subscriber?.id;
  return id == null ? null : String(id);
};

export type KitClient = {
  upsertSubscriber: (
    email: string,
  ) => Promise<KitResult<{ subscriberId: string }>>;
  addTag: (
    tagId: number,
    email: string,
  ) => Promise<KitResult<{ subscriberId: string | null }>>;
};

export const createKitClient = (
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): KitClient => {
  const request = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<KitResult<unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(`${KIT_API_BASE}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kit-Api-Key": apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return {
        ok: false,
        failureClass: "network",
        reason: redactKey(
          `Could not reach Kit: ${error instanceof Error ? error.message : "unknown error"}`,
          apiKey,
        ).slice(0, MAX_REASON),
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        failureClass: classifyKitStatus(response.status),
        reason: await readErrorReason(response, apiKey),
      };
    }

    try {
      return { ok: true, value: await response.json() };
    } catch {
      return { ok: true, value: null };
    }
  };

  const get = async (path: string): Promise<KitResult<unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(`${KIT_API_BASE}${path}`, {
        headers: { "X-Kit-Api-Key": apiKey },
      });
    } catch (error) {
      return {
        ok: false,
        failureClass: "network",
        reason: redactKey(
          `Could not reach Kit: ${error instanceof Error ? error.message : "unknown error"}`,
          apiKey,
        ).slice(0, MAX_REASON),
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        failureClass: classifyKitStatus(response.status),
        reason: await readErrorReason(response, apiKey),
      };
    }
    try {
      return { ok: true, value: await response.json() };
    } catch {
      return { ok: true, value: null };
    }
  };

  // Every tag page, followed to the end. Bounded so a runaway cursor cannot
  // spin: twenty pages of 1000 is far more tags than a person has.
  const collectTags = async (path: string): Promise<KitResult<KitTag[]>> => {
    const tags: KitTag[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const query = `${path}?per_page=1000${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const result = await get(query);
      if (!result.ok) return result;
      const body = result.value as {
        tags?: Array<{ id?: unknown; name?: unknown }>;
        pagination?: { has_next_page?: boolean; end_cursor?: string };
      } | null;
      for (const tag of body?.tags ?? []) {
        if (tag?.id == null) continue;
        tags.push({ id: Number(tag.id), name: String(tag.name ?? "") });
      }
      if (!body?.pagination?.has_next_page || !body.pagination.end_cursor)
        break;
      after = body.pagination.end_cursor;
    }
    return { ok: true, value: tags };
  };

  return {
    listTags: () => collectTags("/tags"),

    createTag: async (name) => {
      const result = await request("/tags", { name });
      if (!result.ok) return result;
      const tag = (
        result.value as { tag?: { id?: unknown; name?: unknown } } | null
      )?.tag;
      if (tag?.id == null) {
        return {
          ok: false,
          failureClass: "unknown",
          reason: "Kit accepted the tag but returned no id",
        };
      }
      return {
        ok: true,
        value: { id: Number(tag.id), name: String(tag.name ?? name) },
      };
    },

    subscriberTags: (subscriberId) =>
      collectTags(`/subscribers/${encodeURIComponent(subscriberId)}/tags`),

    // Kit v4 treats this as an upsert: an address it already knows comes back
    // as the existing subscriber rather than a second one. Running it twice is
    // the same as running it once, which is what makes a replayed operation
    // safe at the provider as well as in the database.
    upsertSubscriber: async (email) => {
      const result = await request("/subscribers", { email_address: email });
      if (!result.ok) return result;
      const subscriberId = subscriberIdOf(result.value);
      if (!subscriberId) {
        return {
          ok: false,
          failureClass: "unknown",
          reason: "Kit accepted the subscriber but returned no id",
        };
      }
      return { ok: true, value: { subscriberId } };
    },

    // Adding a tag the person already carries is a no-op at Kit, so this is
    // idempotent too — and additive by nature: it never removes anything.
    addTag: async (tagId, email) => {
      const result = await request(`/tags/${tagId}/subscribers`, {
        email_address: email,
      });
      if (!result.ok) return result;
      return {
        ok: true,
        value: { subscriberId: subscriberIdOf(result.value) },
      };
    },
  };
};
