// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import {
  assessCheckoutForDeal,
  CHECKOUT_FACT_COLUMNS,
} from "../_shared/postSaleCheckout.ts";
import { AGREED_TERMS_OPTION_ID } from "../_shared/agreedTermsOption.ts";

// Payment domain foundation slice: the production read path for the
// public /offer/:token personalized Offer Page. Deliberately NOT gated by
// AuthMiddleware/UserMiddleware — a prospect has no CRM account, same
// shape as public_application/index.ts. Every table's RLS is
// `to authenticated` only, so this uses supabaseAdmin (service-role,
// bypasses RLS) to resolve a Deal by its opaque token on the prospect's
// behalf.
//
// Business rules here MIRROR (do not share code with — Deno/Edge Functions
// don't import from src/) src/components/atomic-crm/deals/
// publicOfferPageContext.ts and recordOfferPageOpened.ts, the FakeRest/
// dev-testable "logic of record" for this same slice. Keep the two in
// sync by hand if either changes — the same dual-implementation
// convention already used throughout this app.
//
// Smoke-test locally: `make start-supabase-functions`, then:
//
//   curl -i --location --request POST \
//     'http://127.0.0.1:54321/functions/v1/offer_page' \
//     --header 'Content-Type: application/json' \
//     --data '{"action":"context","token":"<a-real-deal-token>"}'

type DealRow = {
  id: number;
  contact_id: number;
  offer_id: number;
  cohort_id: number | null;
  stage: string;
  pricing_mode: string;
  offer_name_snapshot: string | null;
  offer_price_snapshot: number | null;
  selected_payment_option_id: number | null;
  selected_payment_total: number | null;
  selected_installment_count: number | null;
  selected_installment_amount: number | null;
  stripe_subscription_id: string | null;
  stripe_subscription_schedule_id: string | null;
  payment_setup_confirmed_at: string | null;
  offer_page_opened_at: string | null;
};

type ContactRow = {
  id: number;
  first_name: string | null;
  last_name: string | null;
};

type CohortRow = { id: number; name: string };

type OfferPaymentOptionRow = {
  id: number;
  name: string;
  total: number;
  installments: number;
  installment_amount: number;
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const findDealByToken = async (token: string): Promise<DealRow | null> => {
  const { data } = await supabaseAdmin
    .from("deals")
    .select(
      `contact_id, offer_id, cohort_id, offer_name_snapshot, offer_price_snapshot, selected_payment_option_id, offer_page_opened_at, ${CHECKOUT_FACT_COLUMNS}`,
    )
    .eq("offer_page_token", token)
    .maybeSingle();
  return (data as DealRow | null) ?? null;
};

// A sold client is not shopping: the terms Leif recorded ARE the offer, so
// the catalog is not consulted at all. Offering Becky 4 x $1,000 against
// her agreed single payment of $4,000 would invite her to execute
// something nobody agreed to.
const resolveCatalogOptions = async (
  deal: DealRow,
): Promise<
  {
    id: number;
    name: string;
    total: number;
    installments: number;
    installmentAmount: number;
  }[]
> => {
  if (deal.selected_payment_option_id != null) {
    if (
      deal.selected_payment_total == null ||
      deal.selected_installment_count == null ||
      deal.selected_installment_amount == null
    ) {
      return [];
    }
    const { data: option } = await supabaseAdmin
      .from("offer_payment_options")
      .select("name")
      .eq("id", deal.selected_payment_option_id)
      .maybeSingle();
    return [
      {
        id: deal.selected_payment_option_id,
        name: (option as { name: string } | null)?.name ?? "",
        total: deal.selected_payment_total,
        installments: deal.selected_installment_count,
        installmentAmount: deal.selected_installment_amount,
      },
    ];
  }

  const { data: options } = await supabaseAdmin
    .from("offer_payment_options")
    .select("id, name, total, installments, installment_amount")
    .eq("offer_id", deal.offer_id)
    .eq("is_public", true)
    .eq("pricing_mode", deal.pricing_mode)
    .order("id", { ascending: true });
  return ((options ?? []) as OfferPaymentOptionRow[]).map((option) => ({
    id: option.id,
    name: option.name,
    total: option.total,
    installments: option.installments,
    installmentAmount: option.installment_amount,
  }));
};

const handleContext = async (body: Record<string, unknown>) => {
  const token = String(body.token ?? "");
  if (!token) return jsonResponse({ kind: "not-found" });

  const deal = await findDealByToken(token);
  if (!deal || deal.offer_price_snapshot == null) {
    return jsonResponse({ kind: "not-found" });
  }

  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("id, first_name, last_name")
    .eq("id", deal.contact_id)
    .maybeSingle();
  if (!contact) return jsonResponse({ kind: "not-found" });
  const contactRow = contact as ContactRow;

  let cohortName: string | null = null;
  if (deal.cohort_id != null) {
    const { data: cohort } = await supabaseAdmin
      .from("cohorts")
      .select("id, name")
      .eq("id", deal.cohort_id)
      .maybeSingle();
    cohortName = (cohort as CohortRow | null)?.name ?? null;
  }

  const assessment = await assessCheckoutForDeal(deal);
  const paymentOptions =
    assessment.status === "catalog"
      ? await resolveCatalogOptions(deal)
      : assessment.status === "payable"
        ? [
            {
              id: AGREED_TERMS_OPTION_ID,
              name:
                assessment.terms.installments === 1
                  ? "Payment"
                  : "Payment plan",
              total: assessment.terms.total,
              installments: assessment.terms.installments,
              installmentAmount: assessment.terms.installmentAmount,
            },
          ]
        : [];

  return jsonResponse({
    kind: "found",
    contactName:
      `${contactRow.first_name ?? ""} ${contactRow.last_name ?? ""}`.trim(),
    offerName: deal.offer_name_snapshot ?? "",
    cohortName,
    frozenPrice: deal.offer_price_snapshot,
    isScholarship: deal.pricing_mode === "scholarship",
    paymentOptions,
    // Four situations that used to be one "alreadyWon", and the wrong one
    // was announced: somebody just sold to, who had paid nothing, was told
    // "Payment received". Each state now says only what it knows.
    payment: describePaymentState(assessment),
  });
};

const describePaymentState = (
  assessment: Awaited<ReturnType<typeof assessCheckoutForDeal>>,
): { status: string; collected: number; remaining: number | null } => {
  if (assessment.status === "catalog") {
    return { status: "choosing", collected: 0, remaining: null };
  }
  if (assessment.status === "payable") {
    return {
      status: "payable",
      collected: assessment.collected,
      remaining: assessment.terms.total - assessment.collected,
    };
  }
  const status =
    assessment.reason === "paid-in-full"
      ? "paid-in-full"
      : assessment.reason === "plan-exists"
        ? "plan-exists"
        : assessment.reason === "setup-confirmed-elsewhere"
          ? "setup-elsewhere"
          : // terms-unknown and not-representable are the CRM own problem to
            // solve, never something to explain to the buyer.
            "unavailable";
  return { status, collected: assessment.collected, remaining: null };
};

const handleRecordOpened = async (body: Record<string, unknown>) => {
  const token = String(body.token ?? "");
  if (!token) return jsonResponse({ status: "not-found" });

  const deal = await findDealByToken(token);
  if (!deal) return jsonResponse({ status: "not-found" });
  if (!deal.offer_page_opened_at) {
    await supabaseAdmin
      .from("deals")
      .update({ offer_page_opened_at: new Date().toISOString() })
      .eq("id", deal.id);
  }
  return jsonResponse({ status: "recorded" });
};

Deno.serve(async (req: Request) =>
  OptionsMiddleware(req, async (req) => {
    if (req.method !== "POST") {
      return createErrorResponse(405, "Method Not Allowed");
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return createErrorResponse(400, "Invalid JSON body");
    }

    try {
      if (body.action === "context") return await handleContext(body);
      if (body.action === "record-opened")
        return await handleRecordOpened(body);
      return createErrorResponse(400, "Unknown action");
    } catch (error) {
      console.error("offer_page error:", error);
      return createErrorResponse(
        500,
        `Failed to process offer page request: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }),
);
