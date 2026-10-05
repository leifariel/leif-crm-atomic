import { createClient } from "@supabase/supabase-js";

import { expect } from "./fixtures";

// Samantha Herold's and Celia's exact production shape, synthetic.
//
// An imported Application for Growing Yourself Up aimed at a round still
// taking applications, with no Opportunity of its own — beside a live Deal
// for the same person and the same programme at `call_booked` carrying
// NO COHORT AT ALL. That missing round is the whole conflict: adoption
// matches on it, so "" never equalled the Application's intended round, and
// the page could say both "a live conversation already exists" and "no
// decision can be recorded here".
//
// The null cohort is deliberately NOT simplified away. Without it this
// fixture reproduces a different, easier problem.
//
// Ids far outside production's range, torn down after every test.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341";

export const db = () =>
  createClient(SUPABASE_URL, process.env.SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export const GYU_OFFER = 2;
export const LE_OFFER = 1;
export const COHORT_ID = 960001;
export const CONTACT_ID = 960001;
export const APPLICATION_ID = 960001;
export const DEAL_ID = 960001;
export const SECOND_DEAL_ID = 960002;
export const OTHER_OFFER_DEAL_ID = 960003;

const AT = "2026-09-01T00:00:00.000Z";

export const cleanup = async () => {
  const client = db();
  await client.from("applications").delete().in("id", [APPLICATION_ID]);
  await client
    .from("deals")
    .delete()
    .in("id", [DEAL_ID, SECOND_DEAL_ID, OTHER_OFFER_DEAL_ID]);
  await client.from("contacts").delete().eq("id", CONTACT_ID);
  await client.from("cohorts").delete().eq("id", COHORT_ID);
};

export type SeedShape = {
  // A second live GYU conversation, so the owner must choose.
  ambiguous?: boolean;
  // A live conversation for a DIFFERENT programme, which must never be
  // offered and must be refused by the database if attempted anyway.
  otherOffer?: boolean;
};

export const seedResolution = async (
  createSales: (args: {
    first_name: string;
    last_name: string;
    email: string;
    password: string;
  }) => Promise<{ id: number | string }>,
  credentials: { email: string; password: string },
  shape: SeedShape = {},
) => {
  await cleanup();
  const client = db();

  const sales = await createSales({
    first_name: "Resolution",
    last_name: "Spec",
    ...credentials,
  });

  const cohort = await client.from("cohorts").insert({
    id: COHORT_ID,
    offer_id: GYU_OFFER,
    name: "Growing Yourself Up — January 2027",
    status: "applications_open",
  });
  expect(cohort.error).toBeNull();

  const contact = await client.from("contacts").insert({
    id: CONTACT_ID,
    first_name: "Samantha",
    last_name: "Herold",
    sales_id: sales.id,
  });
  expect(contact.error).toBeNull();

  // The live conversation: same person, same programme, NO ROUND.
  const deal = await client.from("deals").insert({
    id: DEAL_ID,
    name: "Samantha Herold",
    contact_id: CONTACT_ID,
    offer_id: GYU_OFFER,
    cohort_id: null,
    stage: "call_booked",
    amount: 1400,
    sales_id: sales.id,
    index: 0,
    created_at: AT,
    stage_entered_at: AT,
  });
  expect(deal.error).toBeNull();

  if (shape.ambiguous) {
    const second = await client.from("deals").insert({
      id: SECOND_DEAL_ID,
      name: "Samantha Herold (second)",
      contact_id: CONTACT_ID,
      offer_id: GYU_OFFER,
      cohort_id: null,
      stage: "interested",
      amount: 1400,
      sales_id: sales.id,
      index: 0,
      created_at: "2026-09-15T00:00:00.000Z",
      stage_entered_at: "2026-09-15T00:00:00.000Z",
    });
    expect(second.error).toBeNull();
  }

  if (shape.otherOffer) {
    const other = await client.from("deals").insert({
      id: OTHER_OFFER_DEAL_ID,
      name: "Samantha Herold (Living Example)",
      contact_id: CONTACT_ID,
      offer_id: LE_OFFER,
      cohort_id: null,
      stage: "interested",
      amount: 4000,
      sales_id: sales.id,
      index: 0,
      created_at: AT,
      stage_entered_at: AT,
    });
    expect(other.error).toBeNull();
  }

  const application = await client.from("applications").insert({
    id: APPLICATION_ID,
    contact_id: CONTACT_ID,
    opportunity_id: null,
    offer_id: GYU_OFFER,
    intended_cohort_id: COHORT_ID,
    status: "pending",
    source: "historical_import",
    // Deliberately empty. materialize_native_application_responses()
    // skips an Application with no answers, and an Application WITH
    // materialised answers can never be deleted — application_responses is
    // an immutable submission record. This spec is about the Opportunity
    // link, so it does not need answers and must not leave a permanent row.
    raw_answers: {},
    submitted_at: AT,
  });
  expect(application.error).toBeNull();

  return { salesId: sales.id };
};

// What the database itself holds, read independently of the browser.
export const readApplication = async () => {
  const { data, error } = await db()
    .from("applications")
    .select("id, contact_id, offer_id, opportunity_id, status, source")
    .eq("id", APPLICATION_ID)
    .single();
  expect(error).toBeNull();
  return data!;
};

export const readDeals = async () => {
  const { data, error } = await db()
    .from("deals")
    .select("id, contact_id, offer_id, cohort_id, stage, archived_at")
    .eq("contact_id", CONTACT_ID)
    .order("id");
  expect(error).toBeNull();
  return data ?? [];
};
