import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// SAVING A KIT TAG HAS TO SAVE IT.
//
// Leif set "Invited from the waitlist" on The Living Example, was told it had
// saved, navigated away, came back, and the row said "Not set". It had never
// been written: `set_program_kit_tag` carried its own list of acceptable
// events, `waitlist_invited` was not on it, and the function answers a
// refusal by RETURNING `{"status":"event-invalid"}` rather than raising. So
// PostgREST replied 200 and the picker — which checked only for an error —
// said saved.
//
// contracts/applications/kitMappingEvents.test.ts holds the three lists
// together at authoring time. This proves the round trip against real
// Postgres, as the real roles, because "it persisted" is a property of the
// database and nothing else.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;

const admin = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

type Result = { status?: string; kit_tag_name?: string };

const setTag = async (
  offerId: number,
  event: string,
  tagId: number | null,
  tagName: string | null,
) => {
  const { data, error } = await admin().rpc("set_program_kit_tag", {
    p_offer_id: offerId,
    p_event: event,
    p_kit_tag_id: tagId,
    p_kit_tag_name: tagName,
  });
  expect(error).toBeNull();
  return data as Result;
};

/** What the database actually holds — read separately, never inferred. */
const mappingFor = async (offerId: number, event: string) => {
  const { data } = await admin()
    .from("kit_tag_mappings")
    .select("offer_id, event, kit_tag_id, kit_tag_name")
    .eq("offer_id", offerId)
    .eq("event", event)
    .maybeSingle();
  return data;
};

const cleanup = async () => {
  for (const offerId of [LE, GYU]) {
    await admin()
      .from("kit_tag_mappings")
      .delete()
      .eq("offer_id", offerId)
      .eq("event", "waitlist_invited");
  }
};

test.describe("a Kit mapping that reports saved is saved", () => {
  test.beforeEach(cleanup);
  test.afterEach(cleanup);

  test("LE waitlist_invited persists and reads back", async () => {
    expect(await mappingFor(LE, "waitlist_invited")).toBeNull();

    const result = await setTag(
      LE,
      "waitlist_invited",
      24500001,
      "LE_Waitlist_Invited",
    );
    // The status is the claim, and it has to be the true one.
    expect(result.status).toBe("set");

    // A FRESH read, which is what Leif's return visit does.
    const row = await mappingFor(LE, "waitlist_invited");
    expect(row).not.toBeNull();
    expect(row!.kit_tag_name).toBe("LE_Waitlist_Invited");
    expect(Number(row!.kit_tag_id)).toBe(24500001);
  });

  test("GYU waitlist_invited persists and reads back", async () => {
    const result = await setTag(
      GYU,
      "waitlist_invited",
      24500002,
      "GYU_Waitlist_Invited",
    );
    expect(result.status).toBe("set");

    const row = await mappingFor(GYU, "waitlist_invited");
    expect(row!.kit_tag_name).toBe("GYU_Waitlist_Invited");
  });

  test("changing an existing waitlist_invited mapping persists the change", async () => {
    await setTag(LE, "waitlist_invited", 24500001, "LE_Waitlist_Invited");
    const result = await setTag(
      LE,
      "waitlist_invited",
      24500009,
      "LE_Waitlist_Invited_v2",
    );
    expect(result.status).toBe("set");

    const row = await mappingFor(LE, "waitlist_invited");
    expect(row!.kit_tag_name).toBe("LE_Waitlist_Invited_v2");
    expect(Number(row!.kit_tag_id)).toBe(24500009);
  });

  test("clearing it removes the row", async () => {
    await setTag(LE, "waitlist_invited", 24500001, "LE_Waitlist_Invited");
    const result = await setTag(LE, "waitlist_invited", null, null);
    expect(result.status).toBe("cleared");
    expect(await mappingFor(LE, "waitlist_invited")).toBeNull();
  });

  test("an event nobody recognises is refused AND writes nothing", async () => {
    // The refusal shape the picker now reads: a named status, not an
    // exception, and no row behind it.
    const result = await setTag(LE, "not_a_real_event", 24500001, "Whatever");
    expect(result.status).toBe("event-invalid");
    expect(await mappingFor(LE, "not_a_real_event")).toBeNull();
  });

  test("the ordinary mappings still persist", async () => {
    // The applicant mapping is real production configuration, so it is read
    // and restored rather than overwritten blind.
    const before = await mappingFor(LE, "applicant");
    const result = await setTag(
      LE,
      "applicant",
      Number(before?.kit_tag_id ?? 24082722),
      String(before?.kit_tag_name ?? "MiniDD_Applicant"),
    );
    expect(result.status).toBe("set");
    const after = await mappingFor(LE, "applicant");
    expect(after!.kit_tag_name).toBe(
      before?.kit_tag_name ?? "MiniDD_Applicant",
    );
  });
});
