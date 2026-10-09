import type { DataProvider, Identifier } from "ra-core";

import type { Deal, OfferPaymentOption, PricingMode } from "../types";

// Configuring what a programme offers.
//
// A payment option is a VERSIONED PROGRAMME TEMPLATE. The moment a Deal
// selects one, that row is somebody's agreement: editing it then creates the
// next version and retires the old one, and the Deal keeps pointing at what
// it agreed to. Leif never chooses between "edit" and "version" — she saves,
// and the authority decides.
//
// The browser cannot write offer_payment_options at all (20261009120000
// revoked it), so every call here reaches set_offer_payment_option, which
// counts the references and writes in one transaction with the row locked.
// A FakeRest mirror stands in where there is no database, so the demo and the
// component tests exercise the same call sites.

export type PaymentOptionDraft = {
  offerId: Identifier;
  name: string;
  total: number;
  installments: number;
  installmentAmount: number;
  isPublic: boolean;
  pricingMode: PricingMode;
  /** Omitted when adding. */
  optionId?: Identifier | null;
};

export type PaymentOptionResult =
  | { status: "added"; optionId: Identifier }
  // Nobody had chosen it, so the row itself was corrected.
  | { status: "updated"; optionId: Identifier }
  // Somebody had. The old row is untouched and retired; this is the new one.
  | {
      status: "versioned";
      optionId: Identifier;
      replacedOptionId: Identifier;
      agreementsPreserved: number;
    }
  | {
      status:
        | "offer-invalid"
        | "option-invalid"
        | "option-not-of-this-offer"
        | "name-required"
        | "pricing-mode-invalid"
        | "installments-invalid"
        | "amount-invalid"
        | "instalments-do-not-add-up";
    };

type PaymentOptionCapableProvider = DataProvider & {
  setOfferPaymentOption?: (
    draft: PaymentOptionDraft,
  ) => Promise<Record<string, unknown>>;
  setOfferPaymentOptionActive?: (input: {
    optionId: Identifier;
    isActive: boolean;
  }) => Promise<Record<string, unknown>>;
};

const shape = (raw: Record<string, unknown>): PaymentOptionResult => {
  const status = String(raw.status ?? "option-invalid");
  if (status === "versioned") {
    return {
      status,
      optionId: raw.option_id as Identifier,
      replacedOptionId: raw.replaced_option_id as Identifier,
      agreementsPreserved: Number(raw.agreements_preserved ?? 0),
    };
  }
  if (status === "added" || status === "updated") {
    return { status, optionId: raw.option_id as Identifier };
  }
  return { status } as PaymentOptionResult;
};

export const setOfferPaymentOption = async (
  dataProvider: DataProvider,
  draft: PaymentOptionDraft,
): Promise<PaymentOptionResult> => {
  const rpc = (dataProvider as PaymentOptionCapableProvider)
    .setOfferPaymentOption;
  if (typeof rpc === "function") return shape(await rpc(draft));
  return await setOfferPaymentOptionMirror(dataProvider, draft);
};

export const setOfferPaymentOptionActive = async (
  dataProvider: DataProvider,
  input: { optionId: Identifier; isActive: boolean },
): Promise<{ status: string }> => {
  const rpc = (dataProvider as PaymentOptionCapableProvider)
    .setOfferPaymentOptionActive;
  if (typeof rpc === "function")
    return (await rpc(input)) as { status: string };
  return await setOfferPaymentOptionActiveMirror(dataProvider, input);
};

// ---------------------------------------------------------------------------
// The mirrors
// ---------------------------------------------------------------------------
// The same decisions in the same order. What they cannot reproduce is the
// transaction or the row lock, which is exactly why production runs the
// database authority instead.

const validate = (draft: PaymentOptionDraft): PaymentOptionResult | null => {
  if (draft.name.trim() === "") return { status: "name-required" };
  if (!["standard", "scholarship"].includes(draft.pricingMode)) {
    return { status: "pricing-mode-invalid" };
  }
  if (!Number.isFinite(draft.installments) || draft.installments < 1) {
    return { status: "installments-invalid" };
  }
  if (draft.total < 0 || draft.installmentAmount < 0) {
    return { status: "amount-invalid" };
  }
  // The same arithmetic stripe_checkout refuses to charge on.
  if (
    draft.installments > 1 &&
    Math.round(draft.installmentAmount * draft.installments * 100) !==
      Math.round(draft.total * 100)
  ) {
    return { status: "instalments-do-not-add-up" };
  }
  return null;
};

export const setOfferPaymentOptionMirror = async (
  dataProvider: DataProvider,
  draft: PaymentOptionDraft,
): Promise<PaymentOptionResult> => {
  const invalid = validate(draft);
  if (invalid) return invalid;

  const row = {
    offer_id: draft.offerId,
    name: draft.name.trim(),
    total: draft.total,
    installments: draft.installments,
    installment_amount: draft.installmentAmount,
    is_public: draft.isPublic,
    pricing_mode: draft.pricingMode,
  };

  if (draft.optionId == null) {
    const { data } = await dataProvider.create<OfferPaymentOption>(
      "offer_payment_options",
      { data: { ...row, is_active: true } as never },
    );
    return { status: "added", optionId: data.id };
  }

  const existing = await dataProvider
    .getOne<OfferPaymentOption>("offer_payment_options", {
      id: draft.optionId,
    })
    .then(({ data }) => data)
    .catch(() => null);
  if (!existing) return { status: "option-invalid" };
  if (String(existing.offer_id) !== String(draft.offerId)) {
    return { status: "option-not-of-this-offer" };
  }

  const { data: deals } = await dataProvider.getList<Deal>("deals", {
    filter: { selected_payment_option_id: draft.optionId },
    pagination: { page: 1, perPage: 200 },
    sort: { field: "id", order: "ASC" },
  });

  if (deals.length === 0) {
    await dataProvider.update("offer_payment_options", {
      id: draft.optionId,
      data: row as never,
      previousData: existing,
    });
    return { status: "updated", optionId: draft.optionId };
  }

  const { data: created } = await dataProvider.create<OfferPaymentOption>(
    "offer_payment_options",
    {
      data: {
        ...row,
        is_active: true,
        replaces_option_id: draft.optionId,
      } as never,
    },
  );
  await dataProvider.update("offer_payment_options", {
    id: draft.optionId,
    data: { is_active: false } as never,
    previousData: existing,
  });
  return {
    status: "versioned",
    optionId: created.id,
    replacedOptionId: draft.optionId,
    agreementsPreserved: deals.length,
  };
};

export const setOfferPaymentOptionActiveMirror = async (
  dataProvider: DataProvider,
  { optionId, isActive }: { optionId: Identifier; isActive: boolean },
): Promise<{ status: string }> => {
  const existing = await dataProvider
    .getOne<OfferPaymentOption>("offer_payment_options", { id: optionId })
    .then(({ data }) => data)
    .catch(() => null);
  if (!existing) return { status: "option-invalid" };
  await dataProvider.update("offer_payment_options", {
    id: optionId,
    data: { is_active: isActive } as never,
    previousData: existing,
  });
  return { status: "set" };
};
