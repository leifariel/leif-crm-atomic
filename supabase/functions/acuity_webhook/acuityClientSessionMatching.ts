import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { normalizeEmail } from "./acuityMatching.ts";
import type { ContactRow } from "./acuityMatching.ts";

// Client + Session Operations slice A. Mirrors (does not share code with —
// Deno Edge Functions can't import from src/) src/components/atomic-crm/
// sessions/clientSessionAcuityMapping.ts + matchClientSessionAppointment.ts
// + matchClientSessionEnrollment.ts, the fixture-tested "logic of record"
// for this same matching behavior. Deliberately separate from
// acuityMatching.ts's resolveOfferCohort/findActiveOpportunity above —
// those resolve a SALES CALL appointment type against active
// Opportunities; these resolve a PAID CLIENT SESSION appointment type
// against active Enrollments. A paid session must never enter sales_call
// logic merely because both read from `offers`/`deals`.

export type ClientSessionOfferRow = {
  id: number;
  name: string;
  client_session_acuity_appointment_type_id: string | null;
};
// Offer-level only (no Cohort-level session mapping — group-offer session
// attendance is out of scope for this slice). Never a display-name match —
// same stable-ID principle as acuityMatching.ts's own resolver.
export const resolveOfferForClientSession = async (
  appointmentTypeId: string,
): Promise<ClientSessionOfferRow | null> => {
  const { data: offers } = await supabaseAdmin
    .from("offers")
    .select("id, name, client_session_acuity_appointment_type_id")
    .eq("client_session_acuity_appointment_type_id", appointmentTypeId)
    .limit(1);
  return offers && offers.length > 0
    ? (offers[0] as ClientSessionOfferRow)
    : null;
};

// Same find-or-create-by-normalized-email principle as
// acuityMatching.ts's own findOrCreateContact, duplicated per this
// codebase's documented convention (small independent modules over a
// shared private helper) rather than imported.
export const findOrCreateContactForClientSession = async (params: {
  firstName: string;
  lastName: string;
  email: string;
}): Promise<ContactRow> => {
  const normalized = normalizeEmail(params.email);
  const { data: contacts } = await supabaseAdmin
    .from("contacts")
    .select("id, first_name, last_name, email_jsonb");
  const existing = ((contacts ?? []) as ContactRow[]).find((contact) =>
    (contact.email_jsonb ?? []).some(
      (entry) => entry.email && normalizeEmail(entry.email) === normalized,
    ),
  );
  if (existing) {
    await supabaseAdmin
      .from("contacts")
      .update({ last_seen: new Date().toISOString() })
      .eq("id", existing.id);
    return existing;
  }

  const { data: created, error } = await supabaseAdmin
    .from("contacts")
    .insert({
      first_name: params.firstName,
      last_name: params.lastName,
      email_jsonb: [{ email: normalized, type: "Other" }],
      phone_jsonb: [],
      tags: [],
      has_newsletter: false,
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      sales_eligibility: "normal",
    })
    .select("id, first_name, last_name, email_jsonb")
    .single();
  if (error || !created)
    throw new Error(error?.message ?? "Failed to create contact");
  return created as ContactRow;
};

// "Find the one legitimately serviceable Enrollment for this paid-client
// session" — never guessed. Only an ACTIVE Enrollment counts; zero or 2+
// active matches both come back unresolved (enrollment: null) rather than
// picking one.
// findActiveEnrollmentForClientSession USED TO LIVE HERE.
//
// It answered "which Enrollment owns this session?" once, at webhook time,
// from "this contact has exactly one ACTIVE Enrollment for this offer" —
// and wrote null whenever that was not yet true. Production proved that is
// not a rare miss: 62 of 255 sessions were left blank, 26 of them created
// before their Enrollment existed at all.
//
// The question now has ONE answer, in one place, consulted whenever it
// might have changed: the view client_session_enrollment_candidates, via
// ../_shared/reconcileClientSessionEnrollments.ts. Nothing here decides
// provenance any more, on purpose — a second implementation is how the two
// drift apart.
