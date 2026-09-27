import type { Offer, SalesCall } from "../types";

// What a call was BOOKED for, when that is no longer what was SOLD.
//
// Jenna Smith booked a Growing Yourself Up call on Acuity appointment type
// 64654501 and bought The Living Example. Both facts are true, both are
// durable, and her Opportunity can only ever show one of them — so the call
// says which programme it was for, derived rather than stored:
//
//   Booked for   the Acuity appointment type the booking came through,
//                resolved through offers.acuity_appointment_type_id
//   Sold         the Opportunity's own offer, which is the client they are now
//
// Nothing is written for this. A stored "originally booked for" column would
// be a second copy of a fact the booking already carries, free to drift from
// it — and it would have to be backfilled by guessing.
export const bookedProgrammeName = (
  salesCall: Pick<SalesCall, "acuity_appointment_type_id"> | null | undefined,
  offers: Pick<Offer, "id" | "name" | "acuity_appointment_type_id">[],
): string | null => {
  const typeId = salesCall?.acuity_appointment_type_id;
  if (typeId == null || String(typeId) === "") return null;
  const offer = offers.find(
    (candidate) =>
      candidate.acuity_appointment_type_id != null &&
      String(candidate.acuity_appointment_type_id) === String(typeId),
  );
  return offer?.name ?? null;
};

// Only worth saying when the two differ. A call booked for the programme that
// was sold needs no explanation, and printing it everywhere would bury the one
// case that matters.
export const describeBookedVsSold = (
  salesCall: Pick<SalesCall, "acuity_appointment_type_id"> | null | undefined,
  currentOfferId: Offer["id"] | null | undefined,
  offers: Pick<Offer, "id" | "name" | "acuity_appointment_type_id">[],
): { bookedFor: string; sold: string } | null => {
  const bookedFor = bookedProgrammeName(salesCall, offers);
  if (bookedFor == null) return null;
  const sold = offers.find(
    (candidate) => String(candidate.id) === String(currentOfferId),
  );
  if (!sold || sold.name === bookedFor) return null;
  return { bookedFor, sold: sold.name };
};
