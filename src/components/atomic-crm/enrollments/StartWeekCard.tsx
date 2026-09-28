import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import { ClientEditModal } from "./ClientEditModal";
import type { Enrollment, Offer } from "../types";
import { formatISODateString } from "../deals/dealUtils";

// When a client's start week is a question rather than a fact.
//
// A Start Week is Leif's decision — never inferred from a booking, a
// payment, a Won date or an onboarding date (20260921130000). A client can
// commit now and deliberately begin in six weeks. The capacity ledger can
// only plan around a week he has actually stated.
//
// Until then the client still holds a place: the occupancy model counts an
// Enrollment with no start date as occupying a slot from today with no end
// it can compute, because not knowing when somebody starts cannot free
// capacity. So openings stay a floor rather than an answer, and the fix is
// one field away — which is why it is said here, on the client's own page,
// rather than left to be discovered inside an edit screen.
//
// Two different questions, two different cards: a date Leif never stated is
// "set one", a date the CRM inferred from a booked session is "is this
// right?".

const TERMINAL = ["completed", "withdrawn", "ended"];

export const StartWeekCard = ({
  enrollment,
  offer,
}: {
  enrollment: Enrollment;
  offer: Offer;
}) => {
  const [editing, setEditing] = useState(false);

  // A group round publishes its own start when Leif creates it, so this is
  // only ever a question for an individual programme.
  if (offer.type !== "individual") return null;
  if (TERMINAL.includes(enrollment.status)) return null;

  const startDate = enrollment.start_date ?? null;
  const missing = startDate == null;
  const inferred =
    startDate != null && enrollment.start_date_source !== "owner";
  if (!missing && !inferred) return null;

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">
              {missing ? "Start week not set" : "Start week needs confirming"}
            </span>
            <span className="text-sm text-muted-foreground">
              {missing
                ? `${offer.name} openings count this client as taking a place from now on, and can only be a minimum until you set the week they start.`
                : `This date came from their first booked session, not from you — ${formatISODateString(startDate ?? "")}. Confirm it or change it.`}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            className="self-start sm:self-auto"
            onClick={() => setEditing(true)}
          >
            {missing ? "Set start week" : "Confirm start week"}
          </Button>
        </CardContent>
      </Card>

      {editing && (
        <ClientEditModal
          enrollmentId={enrollment.id}
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
        />
      )}
    </>
  );
};
