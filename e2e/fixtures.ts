import { test as base, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const adminSupabase = createClient(
  process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54341",
  process.env.SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Tables in FK-safe deletion order (children before parents).
//
// This list used to stop at the ten tables the CRM had when it was written,
// and the deletes were fired without checking their errors. Everything
// added since — Enrollments, Applications, the waiting list, sales calls,
// client sessions, the deal event tables — referenced `contacts` or
// `deals` and was never cleared, so from `contacts` onward every delete
// silently failed whenever one of those specs had run.
//
// The consequence was not a dirty database. It was undeletable USERS:
// `sales` could not be deleted while `contacts` referenced it, and
// `auth.users` could not be deleted while `sales` referenced it —
// `sales.user_id` has no ON DELETE CASCADE, whatever the old comment
// below claimed. The pool therefore grew past one page of listUsers() and
// specs that sign in as a fixed address started failing with "already been
// registered", in files nobody had touched.
//
// So: the full child-first order, and errors are no longer swallowed. A
// table added in the future that references one of these will fail loudly
// here instead of quietly disabling the reset.
const TABLES = [
  // Enrollment children
  "client_session_cadence_issues",
  "client_sessions",
  "enrollment_expected_sessions",
  "enrollment_offboarding_items",
  "enrollment_onboarding_items",
  "enrollment_status_events",
  // Referencing deals AND enrollments, so before both
  "scholarship_slot_events",
  "scholarship_slots",
  "tasks",
  "enrollments",
  // Waiting list, before contacts and deals
  "waitlist_invitations",
  "waitlist_invitation_batches",
  "waitlist_entries",
  // An Application is deletable ONLY while it has no materialised answers.
  // application_responses is an immutable submission record whose BEFORE
  // DELETE trigger refuses even a cascade from its parent, and a Contact
  // holding such an Application inherits that through
  // applications_contact_id_fkey — which blocks sales, and then auth.users.
  //
  // materialize_native_application_responses() skips an Application whose
  // raw_answers is null or '{}', so a fixture that does not need answers
  // should not invent them. One that genuinely needs them must use fixed
  // ids and reset the fields it cares about, because its rows are permanent
  // by design. The reset below will say so loudly rather than quietly
  // leaving them.
  "applications",
  // Deal children
  "deal_payment_schedule_items",
  "deal_stage_events",
  "deal_notes",
  "sales_calls",
  // Contact children
  "kit_sync_operations",
  "contact_notes",
  // Parents
  "deals",
  "contacts",
  "companies",
  "tags",
  "favicons_excluded_domains",
  "sales",
];

// Deliberately NOT in the list above, because service_role is not granted
// DELETE on them — checked one by one against the real schema:
//
//   deal_offer_events, deal_outcome_events, deal_stripe_plan_objects,
//   contact_external_identities, contact_stripe_customers
//     append-only or provider-owned, and all of them ON DELETE CASCADE
//     from deals or contacts, so emptying the parent clears them.
//
//   contact_merges
//     also undeletable, and its FK to contacts is NO ACTION rather than
//     cascade. If a spec ever records a merge, the contacts delete below
//     will fail loudly and name the table. That is the right outcome: the
//     answer is a grant decision, not a quieter reset.
//
//   configuration
//     was in this list for as long as it existed and never once worked.
//     Nothing needs it cleared.
//
// That posture is production's, not a clean-room quirk, which is why the
// reset works around it rather than widening a grant to suit a test.

async function resetDb() {
  for (const table of TABLES) {
    // Supabase client delete need a where clause to get executed, so we use one that will match on all rows (id is not null)
    const { error } = await adminSupabase
      .from(table)
      .delete()
      .not("id", "is", null);
    if (error) {
      throw new Error(`resetDb could not clear ${table}: ${error.message}`);
    }
  }

  // Delete all auth users. NOT a cascade: sales.user_id references
  // auth.users with no ON DELETE CASCADE, which is why sales has to be
  // emptied above first — and why this used to fail with "Database error
  // deleting user" (FK sales_user_id_fkey, SQLSTATE 23503) once anything
  // was left referencing a sales row.
  //
  // Paginated, because listUsers() returns ONE PAGE — fifty by default —
  // and this used to delete only that page. For a long time the clean room
  // never held fifty users so nobody noticed. Then a spec that makes a
  // fresh user per test pushed the pool past the limit, and the leftovers
  // started outliving the reset: every spec that signs in as a fixed
  // address began failing with "A user with this email address has already
  // been registered", in files nobody had touched. Measured at the time:
  // page 1 and page 2 both full, and john@doe.com on neither.
  // A page at a time, five deletes at a time, and it STOPS when a pass
  // makes no progress.
  //
  // Three separate things were learned here and all three are load-bearing:
  //
  //   - listUsers() returns ONE PAGE (fifty by default), and this used to
  //     delete only that page. For a long time the clean room never held
  //     fifty users so nothing noticed. A spec that makes a fresh user per
  //     test pushed the pool past the limit, the leftovers outlived the
  //     reset, and every spec signing in as a fixed address started failing
  //     with "already been registered" — in files nobody had touched.
  //
  //   - two hundred concurrent deletes took the local auth service down
  //     with ECONNRESET. Hence batches of five.
  //
  //   - some users CANNOT be deleted: the delete 500s with "Database error
  //     deleting user" while business rows this function does not truncate
  //     (offers, enrollments, applications, waitlist_entries) still
  //     reference their sales row. Looping until the list is empty
  //     therefore spins forever, which is how a one-page cleanup became
  //     thirty-second timeouts across the whole suite. A pass that frees
  //     nobody ends the loop and leaves the rest; the next test's own
  //     unique address is unaffected, which is why specs should use one.
  for (;;) {
    const { data } = await adminSupabase.auth.admin.listUsers({
      page: 1,
      perPage: 50,
    });
    if (data.users.length === 0) break;
    const before = data.users.length;
    for (let i = 0; i < data.users.length; i += 5) {
      await Promise.all(
        data.users
          .slice(i, i + 5)
          .map((user) => adminSupabase.auth.admin.deleteUser(user.id)),
      );
    }
    const { data: after } = await adminSupabase.auth.admin.listUsers({
      page: 1,
      perPage: 50,
    });
    if (after.users.length >= before) break;
  }
}

async function createUser({
  email,
  password,
}: {
  email: string;
  password: string;
}) {
  const { data, error } = await adminSupabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    throw new Error(`Failed to create user: ${error.message}`);
  }

  return data.user;
}

async function createSales({
  first_name,
  last_name,
  email,
  password,
}: {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
}) {
  const { data: userData, error: userError } =
    await adminSupabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

  if (userError) {
    throw new Error(`Failed to create sales: ${userError.message}`);
  }

  const { data, error } = await adminSupabase
    .from("sales")
    .update({ first_name, last_name, administrator: false })
    .eq("user_id", userData.user?.id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create sales: ${error.message}`);
  }

  return data;
}

async function createNotes({
  contactId,
  salesId,
  notes,
}: {
  contactId: string | number;
  salesId: string | number;
  notes: {
    text: string;
    date?: string;
    status?: "cold" | "warm" | "hot";
  }[];
}) {
  if (notes.length === 0) return;

  const { error } = await adminSupabase.from("contact_notes").insert(
    notes.map(({ text, date, status = "cold" }) => ({
      contact_id: contactId,
      sales_id: salesId,
      text,
      date,
      status,
    })),
  );

  if (error) {
    throw new Error(`Failed to create notes: ${error.message}`);
  }
}

async function createCompany({
  name,
  salesId,
}: {
  name: string;
  salesId: string | number;
}) {
  const { data, error } = await adminSupabase
    .from("companies")
    .insert({ name, sales_id: salesId })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to create company: ${error.message}`);
  }

  return data;
}

async function createContact({
  first_name,
  last_name,
  title = "",
  company_id = null,
  sales_id,
  notes = [],
}: {
  first_name: string;
  last_name: string;
  title?: string;
  company_id?: string | number | null;
  sales_id: string | number;
  notes?: {
    text: string;
    date?: string;
    status?: "cold" | "warm" | "hot";
  }[];
}) {
  const { data, error } = await adminSupabase
    .from("contacts")
    .insert({
      first_name,
      last_name,
      title,
      company_id,
      sales_id,
      // Deliberately a minute in the past, not `now()`. A client-generated
      // "now" lands marginally ahead of the database clock, which makes
      // last_seen a FUTURE time — a thing the domain forbids, and which
      // clamp_contact_last_seen() correctly refuses to let stand. Its
      // repair path reads contact_external_identities as the calling role,
      // and service_role has no SELECT there (on MAIN as well as here), so
      // the fixture's own bad value surfaced as "permission denied".
      // Writing an honest timestamp is the fix; widening the grant would
      // have been the clean room drifting from production again.
      first_seen: new Date(Date.now() - 60_000).toISOString(),
      last_seen: new Date(Date.now() - 60_000).toISOString(),
      has_newsletter: false,
      tags: [],
      gender: "unknown",
      status: "cold",
      background: "",
      email_jsonb: [],
      phone_jsonb: [],
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to create contact: ${error.message}`);
  }

  await createNotes({
    contactId: data.id,
    salesId: sales_id,
    notes,
  });

  return data;
}

// Mobile navigates differently, and the helper used to pretend otherwise.
// It took `isMobile` and ignored it, so every mobile spec that tried to
// reach Contacts waited five seconds for a link that is not on the bottom
// bar at all — Contacts lives behind "More" there (MobileNavigation.tsx's
// MORE_PATHS), while the Dashboard is the home button.
const getMenuMethod = ({
  page,
  isMobile,
}: {
  page: Page;
  isMobile: boolean;
}) => ({
  goToDashboard: async () => {
    await page.getByRole("link", { name: "Dashboard" }).click();
    await page.waitForLoadState("networkidle");
  },
  goToContacts: async () => {
    if (isMobile) {
      await page.getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Contacts" }).click();
    } else {
      await page.getByRole("link", { name: "Contacts" }).click();
    }
    await page.waitForLoadState("networkidle");
  },
});

const dismissToast = async (page: Page, content: string) => {
  await expect(page.getByText(content)).toBeVisible();
  await page.getByLabel("Close toast").first().click();
  // Since we are in optimistic UI, dismissing the toast trigger the request to the api linked to the toast message
  await page.waitForLoadState("networkidle");
};

export const test = base.extend<{
  resetDb: void;
  createUser: typeof createUser;
  createSales: typeof createSales;
  createCompany: typeof createCompany;
  createContact: typeof createContact;
  createNotes: typeof createNotes;
  menu: ReturnType<typeof getMenuMethod>;
  dismissToast: (content: string) => Promise<void>;
}>({
  resetDb: [
    // The first argument to a Playwright fixture function must use object destructuring ({}) — _ is not allowed.
    // Playwright uses this to statically analyze which fixtures are requested.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await resetDb();
      await use();
    },
    { auto: true },
  ],
  // eslint-disable-next-line no-empty-pattern
  createUser: async ({}, cb) => {
    await cb(createUser);
  },
  // eslint-disable-next-line no-empty-pattern
  createSales: async ({}, cb) => {
    await cb(createSales);
  },
  // eslint-disable-next-line no-empty-pattern
  createCompany: async ({}, cb) => {
    await cb(createCompany);
  },
  // eslint-disable-next-line no-empty-pattern
  createContact: async ({}, cb) => {
    await cb(createContact);
  },
  // eslint-disable-next-line no-empty-pattern
  createNotes: async ({}, cb) => {
    await cb(createNotes);
  },
  menu: async ({ page, isMobile }, cb) => {
    await cb(getMenuMethod({ page, isMobile }));
  },
  dismissToast: async ({ page }, cb) => {
    await cb((content: string) => dismissToast(page, content));
  },
});

export { expect };
