import { useState } from "react";
import {
  useDataProvider,
  useGetList,
  useNotify,
  useRecordContext,
  useRefresh,
  useTranslate,
  type Identifier,
} from "ra-core";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { KitConfigBox, KitConfigRow } from "../applications/KitConfigBox";
import type { Offer, OfferPaymentOption, PricingMode } from "../types";
import {
  setOfferPaymentOption,
  setOfferPaymentOptionActive,
} from "./paymentOptionActions";

// What a programme offers, configured — not a database table.
//
// This was the admin kit's generic DataTable: row checkboxes, Select all,
// Export and Delete. None of those is Leif's job, and Delete was actively
// dangerous: `deals.selected_payment_option_id` points at these rows, so one
// of them is somebody's agreement.
//
// A payment option is a VERSIONED PROGRAMME TEMPLATE. Leif edits; the
// authority decides whether that is a correction or a new version, and says
// which so this can report something true. She is never asked to understand
// versions, and never offered a Delete that could take an agreement with it.
//
// Reuses the Kit automation box's own primitives, because it is the same kind
// of thing on the same form: a programme's configuration, stated as rows.

type Draft = {
  optionId: Identifier | null;
  name: string;
  total: string;
  installments: string;
  installmentAmount: string;
  isPublic: boolean;
  pricingMode: PricingMode;
};

const EMPTY: Draft = {
  optionId: null,
  name: "",
  total: "",
  installments: "1",
  installmentAmount: "",
  isPublic: true,
  pricingMode: "standard",
};

const draftFrom = (option: OfferPaymentOption): Draft => ({
  optionId: option.id,
  name: option.name,
  total: String(option.total),
  installments: String(option.installments),
  installmentAmount: String(option.installment_amount),
  isPublic: option.is_public,
  pricingMode: option.pricing_mode ?? "standard",
});

const money = (value: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    value,
  );

export const OfferPaymentOptionsSection = ({
  currency = "USD",
  readOnly = false,
}: {
  currency?: string;
  /** The Offer's show page lists them; the edit form configures them. */
  readOnly?: boolean;
}) => {
  const record = useRecordContext<Offer>();
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: options } = useGetList<OfferPaymentOption>(
    "offer_payment_options",
    {
      filter: {},
      pagination: { page: 1, perPage: 200 },
      sort: { field: "id", order: "ASC" },
    },
    { retry: false },
  );

  if (!record?.id) {
    return (
      <KitConfigBox
        title={translate("resources.offer_payment_options.name", {
          smart_count: 2,
        })}
      >
        <span className="text-sm text-muted-foreground">
          {translate("resources.offer_payment_options.save_first", {
            _: "Save this programme, then add its payment options here.",
          })}
        </span>
      </KitConfigBox>
    );
  }

  const mine = (options ?? [])
    .filter((option) => String(option.offer_id) === String(record.id))
    // Retired ones stay visible — they are what somebody agreed to — but
    // below the ones still on offer.
    .sort((a, b) =>
      a.is_active === b.is_active
        ? Number(a.id) - Number(b.id)
        : a.is_active === false
          ? 1
          : -1,
    );

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await setOfferPaymentOption(dataProvider, {
        offerId: record.id,
        name: draft.name,
        total: Number(draft.total),
        installments: Number(draft.installments),
        installmentAmount: Number(draft.installmentAmount),
        isPublic: draft.isPublic,
        pricingMode: draft.pricingMode,
        optionId: draft.optionId,
      });
      if (result.status === "versioned") {
        // Truthful on both halves: what changed, and what did not.
        notify(
          translate("resources.offer_payment_options.versioned", {
            _: "Updated for future clients. Existing agreements were left unchanged.",
          }),
          { type: "info" },
        );
      } else if (result.status === "added" || result.status === "updated") {
        notify(
          translate("resources.offer_payment_options.saved", {
            _: "Payment option saved.",
          }),
          { type: "info" },
        );
      } else {
        setError(
          translate(
            `resources.offer_payment_options.refused.${result.status}`,
            {
              _: REFUSALS[result.status] ?? "That could not be saved.",
            },
          ),
        );
        return;
      }
      setDraft(null);
      refresh();
    } catch {
      setError(
        translate("resources.offer_payment_options.refused.unknown", {
          _: "That could not be saved just now. Nothing was changed.",
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (optionId: Identifier, isActive: boolean) => {
    setSaving(true);
    try {
      await setOfferPaymentOptionActive(dataProvider, { optionId, isActive });
      notify(
        isActive
          ? translate("resources.offer_payment_options.reactivated", {
              _: "Offered again for new clients.",
            })
          : translate("resources.offer_payment_options.deactivated", {
              _: "No longer offered to new clients. Existing agreements are unchanged.",
            }),
        { type: "info" },
      );
      refresh();
    } catch {
      notify(
        translate("resources.offer_payment_options.refused.unknown", {
          _: "That could not be saved just now. Nothing was changed.",
        }),
        { type: "error" },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <KitConfigBox
        title={translate("resources.offer_payment_options.name", {
          smart_count: 2,
        })}
        aside={
          readOnly ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setDraft(EMPTY)}
            >
              {translate("resources.offer_payment_options.action.add", {
                _: "Add payment option",
              })}
            </Button>
          )
        }
        note={translate("resources.offer_payment_options.note", {
          _: "Changes apply to future clients. An option somebody already chose is never rewritten.",
        })}
      >
        {mine.length === 0 && (
          <span className="text-sm text-muted-foreground">
            {translate("resources.offer_payment_options.empty", {
              _: "No payment options yet.",
            })}
          </span>
        )}
        {mine.map((option) => (
          <KitConfigRow
            key={option.id}
            label={option.name}
            value={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {money(Number(option.total), currency)}
                  {option.installments > 1 && (
                    <span className="text-muted-foreground">
                      {" "}
                      ·{" "}
                      {translate(
                        "resources.offer_payment_options.instalments",
                        {
                          _: "%{count} × %{amount}",
                          count: option.installments,
                          amount: money(
                            Number(option.installment_amount),
                            currency,
                          ),
                        },
                      )}
                    </span>
                  )}
                </span>
                {(option.pricing_mode ?? "standard") === "scholarship" && (
                  <Badge variant="secondary">
                    {translate("resources.offer_payment_options.scholarship", {
                      _: "Scholarship",
                    })}
                  </Badge>
                )}
                {!option.is_public && (
                  <Badge variant="outline">
                    {translate("resources.offer_payment_options.authorised", {
                      _: "Authorisation required",
                    })}
                  </Badge>
                )}
                {option.is_active === false && (
                  <Badge variant="secondary">
                    {translate("resources.offer_payment_options.inactive", {
                      _: "Not offered",
                    })}
                  </Badge>
                )}
              </span>
            }
            action={
              readOnly ? null : (
                <span className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => setDraft(draftFrom(option))}
                  >
                    {translate("ra.action.edit", { _: "Edit" })}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() =>
                      void setActive(option.id, option.is_active === false)
                    }
                  >
                    {option.is_active === false
                      ? translate(
                          "resources.offer_payment_options.action.reactivate",
                          { _: "Offer again" },
                        )
                      : translate(
                          "resources.offer_payment_options.action.deactivate",
                          { _: "Deactivate" },
                        )}
                  </Button>
                </span>
              )
            }
          />
        ))}
      </KitConfigBox>

      <Dialog
        open={draft != null}
        onOpenChange={(open) => {
          if (!open) {
            setDraft(null);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {draft?.optionId == null
                ? translate("resources.offer_payment_options.action.add", {
                    _: "Add payment option",
                  })
                : translate("resources.offer_payment_options.action.edit", {
                    _: "Edit payment option",
                  })}
            </DialogTitle>
            <DialogDescription>
              {translate("resources.offer_payment_options.note", {
                _: "Changes apply to future clients. An option somebody already chose is never rewritten.",
              })}
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="payment-option-name">
                  {translate("resources.offer_payment_options.fields.name", {
                    _: "Name",
                  })}
                </Label>
                <Input
                  id="payment-option-name"
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </div>
              <div className="flex gap-3">
                <div className="flex flex-1 flex-col gap-1">
                  <Label htmlFor="payment-option-total">
                    {translate("resources.offer_payment_options.fields.total", {
                      _: "Total",
                    })}
                  </Label>
                  <Input
                    id="payment-option-total"
                    inputMode="decimal"
                    value={draft.total}
                    onChange={(event) =>
                      setDraft({ ...draft, total: event.target.value })
                    }
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <Label htmlFor="payment-option-installments">
                    {translate(
                      "resources.offer_payment_options.fields.installments",
                      { _: "Installments" },
                    )}
                  </Label>
                  <Input
                    id="payment-option-installments"
                    inputMode="numeric"
                    value={draft.installments}
                    onChange={(event) =>
                      setDraft({ ...draft, installments: event.target.value })
                    }
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <Label htmlFor="payment-option-amount">
                    {translate(
                      "resources.offer_payment_options.fields.installment_amount",
                      { _: "Each" },
                    )}
                  </Label>
                  <Input
                    id="payment-option-amount"
                    inputMode="decimal"
                    value={draft.installmentAmount}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        installmentAmount: event.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.pricingMode === "scholarship"}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        pricingMode: event.target.checked
                          ? "scholarship"
                          : "standard",
                      })
                    }
                  />
                  {translate("resources.offer_payment_options.scholarship", {
                    _: "Scholarship",
                  })}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!draft.isPublic}
                    onChange={(event) =>
                      setDraft({ ...draft, isPublic: !event.target.checked })
                    }
                  />
                  {translate("resources.offer_payment_options.authorised", {
                    _: "Authorisation required",
                  })}
                </label>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              {translate("ra.action.cancel", { _: "Cancel" })}
            </Button>
            <Button type="button" disabled={saving} onClick={() => void save()}>
              {translate("ra.action.save", { _: "Save changes" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

const REFUSALS: Record<string, string> = {
  "name-required": "A payment option needs a name.",
  "pricing-mode-invalid": "That is not a pricing mode this CRM knows.",
  "installments-invalid": "An option needs at least one installment.",
  "amount-invalid": "An amount cannot be negative.",
  "instalments-do-not-add-up":
    "The installments do not add up to the total. Stripe refuses a plan that cannot be charged exactly, so this does too.",
  "offer-invalid": "That programme could not be found.",
  "option-invalid": "That payment option could not be found.",
  "option-not-of-this-offer":
    "That payment option belongs to a different programme.",
};
