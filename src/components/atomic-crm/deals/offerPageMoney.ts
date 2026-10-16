// Payment domain foundation slice, human-acceptance repair: the public
// Offer Page must make the currency explicit (Leif works with
// international clients — a bare "$" is ambiguous between USD/CAD/AUD/
// etc.). Reuses this app's own existing currency source of truth
// (ConfigurationContextValue.currency, an ISO 4217 code — see
// root/ConfigurationContext.tsx — the same value every other money
// display in this app already reads via Intl.NumberFormat) rather than
// hardcoding "USD": the symbol/format come from Intl for whatever currency
// is actually configured, with the currency code appended explicitly so
// it's never ambiguous regardless of symbol. Whole-amount only (no cents)
// — matches this app's own real data, which is never fractional (GYU's
// $1,400/$700/$350, LE's $4,000).
// DEPOSITS MADE THIS FRACTIONAL. The comment above was true of every amount
// this page had ever shown -- $4,000, $1,400, $700 -- and the formatter was
// written to suppress ".00" accordingly. A deposit breaks that: $3,996 less
// $500 over six is 4 x $582.67 then 2 x $582.66, and rounding those to
// whole dollars on the prospect's own payment page would be a lie about what
// their card is going to be charged.
//
// So: whole amounts stay whole, exactly as before, and an amount with cents
// shows them. No existing display changes.
export const formatOfferPageAmount = (
  amount: number,
  currency: string,
): string => {
  const hasCents = Math.round(amount * 100) % 100 !== 0;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(amount);
  return formatted + " " + currency;
};
