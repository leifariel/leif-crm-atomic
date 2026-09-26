import { useEffect, useState } from "react";
import { useParams } from "react-router";

import { Button } from "@/components/ui/button";
import { NotFoundNotice } from "../public-application/NotFoundNotice";
import { PublicApplicationLayout } from "../public-application/PublicApplicationLayout";
import { useConfigurationContext } from "../root/ConfigurationContext";
import { formatOfferPageAmount } from "./offerPageMoney";
import type {
  OfferPagePaymentState,
  OfferPagePaymentStatus,
  PublicOfferPageContext,
} from "./publicOfferPageContext";
import type { PublicOfferPageDataSource } from "./publicOfferPageDataSource";

// Payment domain foundation + Stripe test-mode integration slices:
// /offer/:token — the personalized Offer Page. Shows the frozen price and
// the payment option(s) this specific prospect is authorized to see,
// records the first real open, and lets them start a real Checkout for
// whichever option they choose. The browser only ever sends the option's
// id — every commercial term actually charged is resolved fresh from CRM
// state server-side (resolveAuthorizedCheckoutTerms.ts /
// stripe_checkout/index.ts), never trusted from here.
const errorMessageFor = (
  status:
    | "not-found"
    | "payment-not-available"
    | "unauthorized-option"
    | "error",
): string => {
  switch (status) {
    case "payment-not-available":
      // Deliberately vague to the buyer and specific in the CRM: the real
      // reason is paid in full, a live plan, an arrangement Leif made
      // elsewhere, unrecorded terms or an unchargeable structure — none of
      // which is the buyer's to diagnose.
      return "This payment isn't available right now. Please refresh, or reply to my last message and I'll sort it out.";
    case "unauthorized-option":
      return "That payment option isn't available for this offer. Please refresh the page.";
    case "not-found":
      return "This link isn't available right now.";
    default:
      return "Something went wrong on our end. Please try again.";
  }
};

// One line at the top of the page, true in every state.
//
// It used to be two: "You're all set" for anybody Won, "a personalized
// offer" otherwise. "All set" was the wrong thing to tell a client who had
// just been sold to and had not paid a cent.
const orientationFor = (
  status: OfferPagePaymentStatus,
  contactName: string,
): string => {
  switch (status) {
    case "paid-in-full":
      return `You're all set, ${contactName}.`;
    case "plan-exists":
    case "setup-elsewhere":
      return `Your payment is arranged, ${contactName}.`;
    case "unavailable":
      return `Thanks, ${contactName} — I'll be in touch.`;
    case "payable":
      return `Here's what we agreed, ${contactName}.`;
    case "choosing":
    default:
      return `A personalized offer for ${contactName}.`;
  }
};

// The four situations the old single "alreadyWon" flag collapsed into one.
//
// `paymentSetupComplete` answers "should another checkout be offered?" — it
// is NOT "payment received". It is true for a live plan that has collected
// nothing and for an arrangement Leif made outside the CRM. Announcing
// "Payment received ✓" for either of those tells the buyer something false
// about their own money, which is the same class of mistake that once told
// Sam Milz his first $175 had arrived.
const PaymentStateNotice = ({
  payment,
  currency,
}: {
  payment: OfferPagePaymentState;
  currency: string;
}) => {
  if (payment.status === "choosing" || payment.status === "payable") {
    return null;
  }

  const money = (value: number) => formatOfferPageAmount(value, currency);

  if (payment.status === "paid-in-full") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-base font-semibold text-foreground">
          Payment received ✓
        </span>
        <p className="text-sm text-muted-foreground">
          You're all set. I've received your payment and will be in touch with
          your next steps.
        </p>
      </div>
    );
  }

  if (payment.status === "plan-exists") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-base font-semibold text-foreground">
          Payment plan set up ✓
        </span>
        <p className="text-sm text-muted-foreground">
          {/* What is actually true: an arrangement exists, and this much of
              it has been collected so far. Never "received in full". */}
          Your plan is in place
          {payment.collected > 0
            ? `, and ${money(payment.collected)} has been received so far`
            : ""}
          {payment.remaining != null && payment.remaining > 0
            ? `, with ${money(payment.remaining)} still to come`
            : ""}
          . Nothing further to do here.
        </p>
      </div>
    );
  }

  if (payment.status === "setup-elsewhere") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-base font-semibold text-foreground">
          Payment arranged ✓
        </span>
        <p className="text-sm text-muted-foreground">
          We've arranged your payment directly, so there's nothing to do on this
          page.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-base font-semibold text-foreground">
        Nothing to pay here yet
      </span>
      <p className="text-sm text-muted-foreground">
        I'll be in touch with your payment details.
      </p>
    </div>
  );
};

export const OfferPage = ({
  dataSource,
}: {
  dataSource: PublicOfferPageDataSource;
}) => {
  const { token } = useParams();
  const { currency } = useConfigurationContext();
  const [context, setContext] = useState<PublicOfferPageContext | "pending">(
    "pending",
  );
  const [payingOptionId, setPayingOptionId] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setContext({ kind: "not-found" });
      return;
    }
    let cancelled = false;
    dataSource.getContext(token).then((result) => {
      if (cancelled) return;
      setContext(result);
      if (
        result.kind === "found" &&
        (result.payment.status === "choosing" ||
          result.payment.status === "payable")
      ) {
        // Fire-and-forget: never blocks rendering, and a failure here
        // (e.g. a flaky network) must never prevent the prospect from
        // seeing their own offer.
        dataSource.recordOpened(token).catch(() => {});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dataSource, token]);

  if (context === "pending") return null;

  if (context.kind === "not-found") {
    return (
      <PublicApplicationLayout
        title="Your Offer"
        orientation="This link isn't available right now."
      >
        <NotFoundNotice />
      </PublicApplicationLayout>
    );
  }

  const handlePay = async (optionId: string) => {
    if (!token) return;
    setPayingOptionId(optionId);
    setPayError(null);
    try {
      const result = await dataSource.createCheckout(token, optionId);
      if (result.status !== "created") {
        setPayError(errorMessageFor(result.status));
        setPayingOptionId(null);
        return;
      }
      if (/^https?:\/\//.test(result.url)) {
        // A real Stripe Checkout URL — leaves this page entirely.
        window.location.href = result.url;
        return;
      }
      // Dev/demo completion (no real Stripe to redirect to) — refresh in
      // place rather than relying on a hash-only navigation to re-trigger
      // this component's own data fetch.
      const refreshed = await dataSource.getContext(token);
      setContext(refreshed);
      setPayingOptionId(null);
    } catch {
      setPayError(errorMessageFor("error"));
      setPayingOptionId(null);
    }
  };

  return (
    <PublicApplicationLayout
      title={`${context.offerName}${context.cohortName ? ` — ${context.cohortName}` : ""}`}
      orientation={orientationFor(context.payment.status, context.contactName)}
    >
      <div className="flex flex-col gap-4">
        <PaymentStateNotice payment={context.payment} currency={currency} />
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground tracking-wide">
            Price
          </span>
          <span className="text-2xl font-semibold">
            {formatOfferPageAmount(context.frozenPrice, currency)}
          </span>
          {context.isScholarship && (
            <span className="text-sm font-medium text-primary">
              Scholarship pricing
            </span>
          )}
        </div>
        {context.paymentOptions.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground tracking-wide">
              {context.payment.status === "payable"
                ? // Not a menu. These are the terms already agreed, and the
                  // only thing this page will let them execute.
                  "Agreed terms"
                : context.paymentOptions.length > 1
                  ? "Payment options"
                  : "Payment option"}
            </span>
            <div className="flex flex-col gap-2">
              {context.paymentOptions.map((option) => (
                <div
                  key={option.id}
                  className="rounded-lg border p-3 flex flex-col gap-2"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{option.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {option.installments === 1
                        ? `${formatOfferPageAmount(option.total, currency)} once`
                        : `${option.installments} × ${formatOfferPageAmount(option.installmentAmount, currency)}`}
                    </span>
                    {/* Terms, never a receipt. This line used to say
                        "First payment of $X received" for anybody already
                        Won, generated from the installment structure with
                        no payment behind it — which is what told Sam Milz
                        his first $175 had arrived before his plan had
                        charged anything. The Offer Page shows what was
                        agreed; what has actually been collected is the
                        CRM's business, not the buyer's landing page. */}
                  </div>
                  <Button
                    onClick={() => handlePay(String(option.id))}
                    disabled={payingOptionId != null}
                    size="sm"
                  >
                    {payingOptionId === String(option.id)
                      ? "Redirecting…"
                      : "Pay"}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
        {payError && <p className="text-sm text-destructive">{payError}</p>}
      </div>
    </PublicApplicationLayout>
  );
};

OfferPage.path = "/offer/:token";
