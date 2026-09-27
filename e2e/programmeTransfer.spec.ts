import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// Jenna Smith booked a Growing Yourself Up call and bought The Living Example.
// Her Opportunity was edited to LE three minutes after the sale, through the
// ordinary offer field, and her onboarding stayed GYU: "Invite jenna smith to
// GYU Slack", a Google Calendar invite, a GYU curriculum item and four pending
// Tasks against a programme she never joined.
//
// Both writes were correct. The sale seeded GYU's checklist while she was still
// GYU; nothing reconciles an Enrollment when its Opportunity's offer changes,
// because there was no such thing as changing programmes — no transfer, no
// event, and no guard on the field.
//
// Run against real Postgres as the real roles, because that is where the guard
// and the one-transaction promise live. A FakeRest test cannot fail this way.
//
// Named to sort after onboarding.spec.ts on purpose: that spec needs a database
// with no users at all (it drives the first-run "Welcome to Atomic CRM" screen),
// and anything using the createSales fixture beforehand takes that away. Found
// by doing it — nine specs failed until this file movedlater alphabetically.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";

const asAdmin = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const asSignedInUser = async (email: string, password: string) => {
  const client = createClient(
    SUPABASE_URL,
    process.env.VITE_SB_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error } = await client.auth.signInWithPassword({ email, password });
  expect(error).toBeNull();
  return client;
};

const newSale = async (
  createSales: (args: {
    first_name: string;
    last_name: string;
    email: string;
    password: string;
  }) => Promise<{ id: number | string }>,
  label: string,
) => {
  const email = `move-${label}-${Date.now()}@example.com`;
  const password = "Password123!";
  const sale = await createSales({
    first_name: "Move",
    last_name: label,
    email,
    password,
  });
  return { sale, email, password };
};

// A GYU client, built the way the app builds one: sold through the canonical
// path so the Enrollment and its five GYU requirements are real.
const seedGyuClient = async (salesId: number | string, label: string) => {
  const admin = asAdmin();
  const { data: contact } = await admin
    .from("contacts")
    .insert({ first_name: "Move", last_name: label, sales_id: salesId })
    .select("id")
    .single();
  const { data: deal } = await admin
    .from("deals")
    .insert({
      name: `Move ${label}`,
      contact_id: contact!.id,
      offer_id: 2,
      stage: "call_booked",
      amount: 1400,
      sales_id: salesId,
      index: 0,
      entry_path: "other",
      description: "",
    })
    .select("id")
    .single();

  // The application she actually submitted, for the programme she applied to.
  const { data: application } = await admin
    .from("applications")
    .insert({
      contact_id: contact!.id,
      offer_id: 2,
      opportunity_id: deal!.id,
      status: "approved",
      source: "public_form",
      submitted_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    })
    .select("id")
    .single();

  await admin.rpc("record_prospect_accepted", { p_opportunity_id: deal!.id });

  const { data: enrollment } = await admin
    .from("enrollments")
    .select("id")
    .eq("opportunity_id", deal!.id)
    .single();

  // Contract signed under GYU, exactly like hers.
  await admin
    .from("enrollment_onboarding_items")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("enrollment_id", enrollment!.id)
    .eq("requirement_key", "contract");

  return {
    admin,
    contactId: contact!.id,
    dealId: deal!.id,
    applicationId: application!.id,
    enrollmentId: enrollment!.id,
  };
};

const itemsOf = async (
  admin: ReturnType<typeof asAdmin>,
  enrollmentId: number,
) => {
  const { data } = await admin
    .from("enrollment_onboarding_items")
    .select(
      "id, requirement_key, label, status, completed_at, retired_at, retired_from_offer_id, source_offer_id",
    )
    .eq("enrollment_id", enrollmentId)
    .order("sort_order");
  return data!;
};

const tasksOf = async (
  admin: ReturnType<typeof asAdmin>,
  enrollmentId: number,
) => {
  const { data } = await admin
    .from("tasks")
    .select("id, text, status, done_date, onboarding_item_id")
    .eq("enrollment_id", enrollmentId)
    .order("id");
  return data!;
};

test.describe("moving an enrolled client between programmes", () => {
  test("the whole client moves, or nothing does", async ({ createSales }) => {
    const { sale } = await newSale(createSales, "whole");
    const { admin, dealId, applicationId, enrollmentId } = await seedGyuClient(
      sale.id,
      "whole",
    );

    const before = await itemsOf(admin, enrollmentId);
    expect(before).toHaveLength(5);
    expect(before.filter((i) => i.status === "done")).toHaveLength(1);
    const contractCompletedAt = before.find(
      (i) => i.requirement_key === "contract",
    )!.completed_at;

    const { data: result, error } = await admin.rpc(
      "transfer_enrolled_opportunity_offer",
      { p_opportunity_id: dealId, p_to_offer_id: 1 },
    );
    expect(error).toBeNull();
    expect(result.status).toBe("transferred");
    expect(Number(result.from_offer_id)).toBe(2);
    expect(Number(result.to_offer_id)).toBe(1);

    // The Opportunity and its commercial snapshot followed.
    const { data: deal } = await admin
      .from("deals")
      .select(
        "offer_id, offer_name_snapshot, offer_price_snapshot, stage, cohort_id",
      )
      .eq("id", dealId)
      .single();
    expect(Number(deal!.offer_id)).toBe(1);
    expect(deal!.offer_name_snapshot).toBe("The Living Example");
    expect(Number(deal!.offer_price_snapshot)).toBe(4000);
    // Moving programmes is not a sales event: she is still sold.
    expect(deal!.stage).toBe("won");

    const items = await itemsOf(admin, enrollmentId);
    const live = items.filter((i) => i.status !== "retired");
    expect(live.map((i) => i.requirement_key).sort()).toEqual([
      "contract",
      "curriculum_access",
      "meditation_library_access",
      "notion_access",
    ]);
    expect(live.filter((i) => i.status === "done")).toHaveLength(1);

    // The contract keeps its own history, to the timestamp.
    const contract = items.find((i) => i.requirement_key === "contract")!;
    expect(contract.status).toBe("done");
    expect(contract.completed_at).toBe(contractCompletedAt);

    // The GYU-only requirements are withdrawn, not deleted.
    for (const key of ["slack_access", "calendar_access"]) {
      const item = items.find((i) => i.requirement_key === key)!;
      expect(item.status, key).toBe("retired");
      expect(item.retired_at, key).not.toBeNull();
      expect(Number(item.retired_from_offer_id), key).toBe(2);
    }

    // The shared curriculum requirement points at the new programme, once.
    const curriculum = items.filter(
      (i) => i.requirement_key === "curriculum_access",
    );
    expect(curriculum).toHaveLength(1);
    expect(curriculum[0].label).toBe("Living Example curriculum access");
    expect(curriculum[0].status).toBe("pending");

    // The shared meditation requirement is preserved as it was.
    const meditation = items.filter(
      (i) => i.requirement_key === "meditation_library_access",
    );
    expect(meditation).toHaveLength(1);
    expect(meditation[0].status).toBe("pending");

    // Notion is added, once.
    expect(
      items.filter((i) => i.requirement_key === "notion_access"),
    ).toHaveLength(1);

    // Tasks: the retired ones cancelled, the live ones asking for the right
    // thing, one per requirement.
    const tasks = await tasksOf(admin, enrollmentId);
    const retiredIds = items
      .filter((i) => i.status === "retired")
      .map((i) => i.id);
    const cancelled = tasks.filter((t) =>
      retiredIds.includes(t.onboarding_item_id as number),
    );
    expect(cancelled).toHaveLength(2);
    for (const task of cancelled) {
      expect(task.status).toBe("cancelled");
      expect(task.done_date).not.toBeNull();
    }
    const openTasks = tasks.filter((t) => t.status === "pending");
    expect(openTasks.map((t) => t.text).join(" ")).not.toMatch(/GYU/);
    for (const item of live.filter((i) => i.status !== "done")) {
      expect(
        openTasks.filter((t) => t.onboarding_item_id === item.id),
        item.requirement_key,
      ).toHaveLength(1);
    }

    // Exactly one Enrollment, exactly one transfer event.
    const { data: enrollments } = await admin
      .from("enrollments")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(enrollments).toHaveLength(1);
    const { data: events } = await admin
      .from("deal_offer_events")
      .select("from_offer_id, to_offer_id, enrollment_id")
      .eq("opportunity_id", dealId);
    expect(events).toHaveLength(1);
    expect(Number(events![0].enrollment_id)).toBe(enrollmentId);

    // Her history is untouched, and still writable now that a transfer
    // explains why it disagrees with the sale.
    const { data: application } = await admin
      .from("applications")
      .select("offer_id, status")
      .eq("id", applicationId)
      .single();
    expect(Number(application!.offer_id)).toBe(2);
    const { error: appWrite } = await admin
      .from("applications")
      .update({ status: "approved" })
      .eq("id", applicationId);
    expect(appWrite).toBeNull();
  });

  test("a second move changes nothing", async ({ createSales }) => {
    const { sale } = await newSale(createSales, "replay");
    const { admin, dealId, enrollmentId } = await seedGyuClient(
      sale.id,
      "replay",
    );

    await admin.rpc("transfer_enrolled_opportunity_offer", {
      p_opportunity_id: dealId,
      p_to_offer_id: 1,
    });
    const firstItems = await itemsOf(admin, enrollmentId);
    const firstTasks = await tasksOf(admin, enrollmentId);

    const { data: replay } = await admin.rpc(
      "transfer_enrolled_opportunity_offer",
      { p_opportunity_id: dealId, p_to_offer_id: 1 },
    );
    expect(replay.status).toBe("already-on-offer");

    expect(await itemsOf(admin, enrollmentId)).toEqual(firstItems);
    expect(await tasksOf(admin, enrollmentId)).toEqual(firstTasks);
    const { data: events } = await admin
      .from("deal_offer_events")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(events).toHaveLength(1);
  });

  test("an ordinary signed-in user cannot move an enrolled client by editing the offer", async ({
    createSales,
  }) => {
    const { sale, email, password } = await newSale(createSales, "guard");
    const { admin, dealId, enrollmentId } = await seedGyuClient(
      sale.id,
      "guard",
    );
    const user = await asSignedInUser(email, password);

    const { error } = await user
      .from("deals")
      .update({ offer_id: 1 })
      .eq("id", dealId);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/transfer_enrolled_opportunity_offer/i);

    // Nothing moved, on either side.
    const { data: deal } = await admin
      .from("deals")
      .select("offer_id")
      .eq("id", dealId)
      .single();
    expect(Number(deal!.offer_id)).toBe(2);
    const items = await itemsOf(admin, enrollmentId);
    expect(items.filter((i) => i.status === "retired")).toHaveLength(0);
    const { data: events } = await admin
      .from("deal_offer_events")
      .select("id")
      .eq("opportunity_id", dealId);
    expect(events).toHaveLength(0);
  });

  test("the same user CAN move them through the transfer", async ({
    createSales,
  }) => {
    // The guard is about the field, not about the person: this is her action.
    const { sale, email, password } = await newSale(createSales, "allowed");
    const { admin, dealId } = await seedGyuClient(sale.id, "allowed");
    const user = await asSignedInUser(email, password);

    const { data: result, error } = await user.rpc(
      "transfer_enrolled_opportunity_offer",
      { p_opportunity_id: dealId, p_to_offer_id: 1 },
    );
    expect(error).toBeNull();
    expect(result.status).toBe("transferred");

    const { data: deal } = await admin
      .from("deals")
      .select("offer_id")
      .eq("id", dealId)
      .single();
    expect(Number(deal!.offer_id)).toBe(1);
  });

  test("a pre-Enrollment offer change is still an ordinary edit", async ({
    createSales,
  }) => {
    const { sale, email, password } = await newSale(createSales, "presale");
    const admin = asAdmin();
    const { data: contact } = await admin
      .from("contacts")
      .insert({ first_name: "Move", last_name: "presale", sales_id: sale.id })
      .select("id")
      .single();
    const { data: deal } = await admin
      .from("deals")
      .insert({
        name: "Move presale",
        contact_id: contact!.id,
        offer_id: 2,
        stage: "call_booked",
        amount: 1400,
        sales_id: sale.id,
        index: 0,
        entry_path: "other",
        description: "",
      })
      .select("id")
      .single();

    const user = await asSignedInUser(email, password);
    const { error } = await user
      .from("deals")
      .update({ offer_id: 1 })
      .eq("id", deal!.id);
    expect(error).toBeNull();

    const { data: after } = await admin
      .from("deals")
      .select("offer_id, offer_name_snapshot")
      .eq("id", deal!.id)
      .single();
    expect(Number(after!.offer_id)).toBe(1);
    expect(after!.offer_name_snapshot).toBe("The Living Example");
    // No event: nothing downstream existed to move.
    const { data: events } = await admin
      .from("deal_offer_events")
      .select("id")
      .eq("opportunity_id", deal!.id);
    expect(events).toHaveLength(0);
  });

  test("moving into a group programme needs its round chosen", async ({
    createSales,
  }) => {
    const { sale } = await newSale(createSales, "group");
    const { admin, dealId } = await seedGyuClient(sale.id, "group");

    await admin.rpc("transfer_enrolled_opportunity_offer", {
      p_opportunity_id: dealId,
      p_to_offer_id: 1,
    });
    const { data: back } = await admin.rpc(
      "transfer_enrolled_opportunity_offer",
      { p_opportunity_id: dealId, p_to_offer_id: 2 },
    );
    expect(back.status).toBe("needs-cohort");

    // And it changed nothing on the way to saying so.
    const { data: deal } = await admin
      .from("deals")
      .select("offer_id")
      .eq("id", dealId)
      .single();
    expect(Number(deal!.offer_id)).toBe(1);
  });

  test("a retired requirement does not block activation", async ({
    createSales,
  }) => {
    // Without excluding retired rows, a transferred client could never be
    // activated: her withdrawn GYU requirements would count as outstanding.
    const { sale } = await newSale(createSales, "activate");
    const { admin, dealId, enrollmentId } = await seedGyuClient(
      sale.id,
      "activate",
    );
    await admin.rpc("transfer_enrolled_opportunity_offer", {
      p_opportunity_id: dealId,
      p_to_offer_id: 1,
    });

    // Finish the Living Example checklist.
    await admin
      .from("enrollment_onboarding_items")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("enrollment_id", enrollmentId)
      .neq("status", "retired");

    const { error } = await admin
      .from("enrollments")
      .update({ status: "active" })
      .eq("id", enrollmentId);
    expect(error).toBeNull();

    const items = await itemsOf(admin, enrollmentId);
    // The retired rows are still retired: finishing onboarding did not revive
    // them, and nothing marked them done.
    expect(items.filter((i) => i.status === "retired")).toHaveLength(2);
  });
});
