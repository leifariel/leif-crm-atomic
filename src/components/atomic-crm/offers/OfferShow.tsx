import { NumberField } from "@/components/admin/number-field";
import { RecordField } from "@/components/admin/record-field";
import { Show } from "@/components/admin/show";

import { useConfigurationContext } from "../root/ConfigurationContext";
import type { Offer } from "../types";
import { OfferPaymentOptionsSection } from "./OfferPaymentOptionsSection";
import { offerTypeLabels } from "./offerConstants";

// Administrative/reference UI: lets the owner inspect an Offer's shape and
// payment options. Not meant to be beautiful — see the domain-model proof
// slice report for why Offer editing isn't built in this slice.
export const OfferShow = () => (
  <Show>
    <div className="flex flex-col gap-4">
      <RecordField source="name" />
      <RecordField label="resources.offers.fields.type" render={renderType} />
      <RecordField source="duration" />
      <RecordField label="resources.offers.fields.current_price">
        <PriceField />
      </RecordField>
      <RecordField source="max_active_clients" />
      <RecordField
        label="resources.offers.fields.is_active"
        render={(record: Offer) => (record.is_active ? "Yes" : "No")}
      />
      <PaymentOptionsSection />
    </div>
  </Show>
);

const renderType = (record: Offer) => offerTypeLabels[record.type];

const PriceField = () => {
  const { currency } = useConfigurationContext();
  return (
    <NumberField
      source="current_price"
      options={{ style: "currency", currency }}
    />
  );
};

// The same rows the edit form configures, read only. Configuring them is
// one job in one place (OfferInputs -> OfferPaymentOptionsSection); this
// page reports.
//
// It used to be the admin kit's DataTable, which brought row checkboxes,
// Select all, Export and a bulk Delete — against rows that
// deals.selected_payment_option_id points at. None of that was Leif's job
// and the Delete was the dangerous part.
const PaymentOptionsSection = () => {
  const { currency } = useConfigurationContext();
  return <OfferPaymentOptionsSection currency={currency} readOnly />;
};
