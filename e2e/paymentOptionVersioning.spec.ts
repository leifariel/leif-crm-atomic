import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./fixtures";

// A payment option somebody chose is no longer editable.
//
// `deals.selected_payment_option_id` points at these rows, so one of them is
// an agreement. Leif still has to be able to change what a programme offers —
// so an edit to a CHOSEN option creates the next version and retires the old
// one, and the Deal keeps pointing at what it agreed to.
//
// Run against real Postgres as the real roles, because the rule is a
// transaction with the row locked and a reference count, and none of that
// exists in a browser.
//
// The money question these exist to answer: after Leif edits, is an existing
// agreement still exactly what was agreed?

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";
const LE = 1;
const GYU = 2;
const BASE = 982000;

const admin = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const options = async (offerId = LE) => {
  const { data } = await admin()
    .from("offer_payment_options")
    .select(
      "id, offer_id, name, total, installments, installment_amount, is_public, pricing_mode, is_active, replaces_option_id",
    )
    .eq("offer_id", offerId)
    // The RPC uses the table's own identity sequence, so these rows do not
    // land in a reserved id range the way the fixtures above do. Found by
    // name instead — every one this spec creates is prefixed.
    .like("name", "Probe —%")
    .order("id", { ascending: true });
  return data ?? [];
};

const dealRow = async (id: number) => {
  const { data } = await admin()
    .from("deals")
    .select(
      "id, stage, selected_payment_option_id, selected_payment_total, selected_installment_count, selected_installment_amount",
    )
    .eq("id", id)
    .single();
  return data!;
};

const save = async (draft: Record<string, unknown>) => {
  const { data, error } = await admin().rpc("set_offer_payment_option", draft);
  expect(error).toBeNull();
  return data as Record<string, unknown>;
};

const cleanup = async () => {
  const client = admin();
  await client.from("deals").delete().gte("id", BASE);
  await client.from("contacts").delete().gte("id", BASE);
  // Replacements first: a version points at what it replaced.
  // Replacements first: a version points at what it replaced.
  await client
    .from("offer_payment_options")
    .delete()
    .like("name", "Probe —%")
    .not("replaces_option_id", "is", null);
  await client.from("offer_payment_options").delete().like("name", "Probe —%");
};

const seedOption = async (name: string, offerId = LE) => {
  const result = await save({
    p_offer_id: offerId,
    p_name: name,
    p_total: 4800,
    p_installments: 6,
    p_installment_amount: 800,
    p_is_public: true,
    p_pricing_mode: "standard",
  });
  expect(result.status).toBe("added");
  return Number(result.option_id);
};

test.describe("a payment option is a versioned programme template", () => {
  test.afterEach(cleanup);

  test("CASE 1 — nobody chose it, so the edit corrects the row itself", async () => {
    const id = await seedOption("Probe — untouched");

    const result = await save({
      p_offer_id: LE,
      p_name: "Probe — corrected",
      p_total: 5400,
      p_installments: 6,
      p_installment_amount: 900,
      p_is_public: true,
      p_pricing_mode: "standard",
      p_option_id: id,
    });
    expect(result.status).toBe("updated");
    expect(Number(result.option_id)).toBe(id);

    const after = await options();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id,
      name: "Probe — corrected",
      is_active: true,
      replaces_option_id: null,
    });
    expect(Number(after[0]!.total)).toBe(5400);
  });

  test("CASE 2 — a prospect chose it, so the edit becomes the next version", async ({
    createSales,
  }) => {
    const sale = await createSales({
      first_name: "Payment",
      last_name: "Owner",
      email: `payment-${Date.now()}@example.com`,
      password: "password",
    });
    const client = admin();
    const optionA = await seedOption("Probe — chosen");

    await client
      .from("contacts")
      .insert({ id: BASE + 1, first_name: "Pros", last_name: "Pect" });
    await client.from("deals").insert({
      id: BASE + 1,
      name: "Pros Pect",
      contact_id: BASE + 1,
      offer_id: LE,
      stage: "call_booked",
      sales_id: sale.id,
      index: 0,
      entry_path: "other",
      description: "",
    });
    await client
      .from("deals")
      .update({ selected_payment_option_id: optionA })
      .eq("id", BASE + 1);

    // handle_deal_saved() froze the terms onto the Deal when it chose.
    const agreed = await dealRow(BASE + 1);
    expect(agreed.selected_payment_option_id).toBe(optionA);
    expect(Number(agreed.selected_payment_total)).toBe(4800);
    expect(Number(agreed.selected_installment_amount)).toBe(800);

    const result = await save({
      p_offer_id: LE,
      p_name: "Probe — next version",
      p_total: 5400,
      p_installments: 6,
      p_installment_amount: 900,
      p_is_public: true,
      p_pricing_mode: "standard",
      p_option_id: optionA,
    });
    expect(result.status).toBe("versioned");
    expect(Number(result.replaced_option_id)).toBe(optionA);
    expect(Number(result.agreements_preserved)).toBe(1);
    const optionB = Number(result.option_id);

    const after = await options();
    const a = after.find((row) => row.id === optionA)!;
    const b = after.find((row) => row.id === optionB)!;

    // A IS UNTOUCHED, and no longer offered.
    expect(a.name).toBe("Probe — chosen");
    expect(Number(a.total)).toBe(4800);
    expect(Number(a.installment_amount)).toBe(800);
    expect(a.is_active).toBe(false);
    // B is the new one, and says what it replaced.
    expect(b.name).toBe("Probe — next version");
    expect(Number(b.total)).toBe(5400);
    expect(b.is_active).toBe(true);
    expect(Number(b.replaces_option_id)).toBe(optionA);

    // THE DEAL STILL AGREES TO WHAT IT AGREED TO.
    const unchanged = await dealRow(BASE + 1);
    expect(unchanged.selected_payment_option_id).toBe(optionA);
    expect(Number(unchanged.selected_payment_total)).toBe(4800);
    expect(Number(unchanged.selected_installment_count)).toBe(6);
    expect(Number(unchanged.selected_installment_amount)).toBe(800);

    // AND THE CHARGE WOULD BE THE SAME. The Deal's own terms are what
    // stripe_checkout now builds the charge from, so the two can only agree.
    expect(
      Number(unchanged.selected_installment_amount) *
        Number(unchanged.selected_installment_count),
    ).toBe(Number(unchanged.selected_payment_total));
    expect(Number(unchanged.selected_payment_total)).toBe(Number(a.total));
    expect(Number(unchanged.selected_payment_total)).not.toBe(Number(b.total));
  });

  test("CASE 3 — a Won client's money is untouched by a catalogue edit", async ({
    createSales,
  }) => {
    const sale = await createSales({
      first_name: "Payment",
      last_name: "Owner",
      email: `payment-won-${Date.now()}@example.com`,
      password: "password",
    });
    const client = admin();
    const optionA = await seedOption("Probe — sold on this");

    await client
      .from("contacts")
      .insert({ id: BASE + 2, first_name: "Won", last_name: "Client" });
    await client.from("deals").insert({
      id: BASE + 2,
      name: "Won Client",
      contact_id: BASE + 2,
      offer_id: LE,
      stage: "call_booked",
      sales_id: sale.id,
      index: 0,
      entry_path: "other",
      description: "",
    });
    await client
      .from("deals")
      .update({ selected_payment_option_id: optionA })
      .eq("id", BASE + 2);
    // Sold, through the canonical path — never by typing the stage.
    await client.rpc("record_prospect_accepted", {
      p_opportunity_id: BASE + 2,
    });

    const before = await dealRow(BASE + 2);
    expect(before.stage).toBe("won");
    const { data: enrollmentBefore } = await client
      .from("enrollments")
      .select("id, status, start_date")
      .eq("opportunity_id", BASE + 2)
      .single();
    const { count: scheduleBefore } = await client
      .from("deal_payment_schedule_items")
      .select("id", { count: "exact", head: true })
      .eq("deal_id", BASE + 2);

    await save({
      p_offer_id: LE,
      p_name: "Probe — repriced after the sale",
      p_total: 9900,
      p_installments: 1,
      p_installment_amount: 9900,
      p_is_public: true,
      p_pricing_mode: "standard",
      p_option_id: optionA,
    });

    // NOTHING about the client moved.
    const after = await dealRow(BASE + 2);
    expect(after).toEqual(before);
    const { data: enrollmentAfter } = await client
      .from("enrollments")
      .select("id, status, start_date")
      .eq("opportunity_id", BASE + 2)
      .single();
    expect(enrollmentAfter).toEqual(enrollmentBefore);
    const { count: scheduleAfter } = await client
      .from("deal_payment_schedule_items")
      .select("id", { count: "exact", head: true })
      .eq("deal_id", BASE + 2);
    expect(scheduleAfter).toBe(scheduleBefore);
  });

  test("CASE 4 — deactivating stops it being offered and cancels nothing", async ({
    createSales,
  }) => {
    const sale = await createSales({
      first_name: "Payment",
      last_name: "Owner",
      email: `payment-off-${Date.now()}@example.com`,
      password: "password",
    });
    const client = admin();
    const optionA = await seedOption("Probe — withdrawn");

    await client
      .from("contacts")
      .insert({ id: BASE + 3, first_name: "Still", last_name: "Paying" });
    await client.from("deals").insert({
      id: BASE + 3,
      name: "Still Paying",
      contact_id: BASE + 3,
      offer_id: LE,
      stage: "call_booked",
      sales_id: sale.id,
      index: 0,
      entry_path: "other",
      description: "",
    });
    await client
      .from("deals")
      .update({ selected_payment_option_id: optionA })
      .eq("id", BASE + 3);

    const { error } = await client.rpc("set_offer_payment_option_active", {
      p_option_id: optionA,
      p_is_active: false,
    });
    expect(error).toBeNull();

    const [row] = await options();
    expect(row.is_active).toBe(false);
    // The row is still there, and the Deal still points at it with its own
    // agreed terms. Retiring an option is not cancelling an agreement.
    const deal = await dealRow(BASE + 3);
    expect(deal.selected_payment_option_id).toBe(optionA);
    expect(Number(deal.selected_payment_total)).toBe(4800);
  });

  test("CASE 5 — is_public and pricing_mode stay independent of is_active", async () => {
    const id = await save({
      p_offer_id: GYU,
      p_name: "Probe — authorised only",
      p_total: 1400,
      p_installments: 1,
      p_installment_amount: 1400,
      p_is_public: false,
      p_pricing_mode: "scholarship",
    }).then((r) => Number(r.option_id));

    let [row] = await options(GYU);
    expect(row).toMatchObject({
      is_public: false,
      pricing_mode: "scholarship",
      is_active: true,
    });

    await admin().rpc("set_offer_payment_option_active", {
      p_option_id: id,
      p_is_active: false,
    });
    [row] = await options(GYU);
    // Withdrawn, and still exactly as private and as scholarship as it was.
    expect(row).toMatchObject({
      is_public: false,
      pricing_mode: "scholarship",
      is_active: false,
    });
  });

  test("the browser cannot write these rows at all", async () => {
    const id = await seedOption("Probe — closed table");
    const asOwner = createClient(
      SUPABASE_URL,
      process.env.VITE_SB_PUBLISHABLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    // Even signed out, the grant is what matters: insert/update/delete are
    // revoked from authenticated, so the versioning rule is a property of
    // the database rather than a habit of the UI.
    const { error: updateError } = await asOwner
      .from("offer_payment_options")
      .update({ total: 1 })
      .eq("id", id);
    expect(updateError).not.toBeNull();
  });
});
