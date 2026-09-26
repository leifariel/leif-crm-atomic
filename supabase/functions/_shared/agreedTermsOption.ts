// The id the Offer Page sends back when it asks to pay the agreed terms of
// an already-sold Opportunity. Not an `offer_payment_options` row: a real
// agreement need not exist in the catalog (8 of 29 Opportunities with
// recorded terms match no catalog row), and the server re-resolves the
// amount from the Deal regardless of what the browser sends.
//
// Mirrors AGREED_TERMS_OPTION_ID in
// src/components/atomic-crm/deals/publicOfferPageContext.ts.
export const AGREED_TERMS_OPTION_ID = "agreed-terms";
