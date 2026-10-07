import { useState } from "react";
import { useDataProvider, useNotify, useRefresh, useTranslate } from "ra-core";

import { Button } from "@/components/ui/button";

import { formatTimestampString } from "../deals/dealUtils";
import type { Enrollment, Offer } from "../types";

// Did the testimonial arrive, and does Leif need to ask again?
//
// A ROW INSIDE the Offboarding checklist, not a card beside it. It was its
// own card, which read as a slab floating under the real offboarding work
// and said — wrongly — that asking for a testimonial is a separate concern
// from winding a client down. It is the same concern; it is simply not a
// requirement.
//
// WHICH IS WHY THERE IS NO CHECKBOX. Every other row in this container has
// one, and ticking those moves the x/y count and gates completion. This row
// deliberately has none: it is not an enrollment_offboarding_item, it is
// not required, it never enters the denominator, and it can never hold a
// client's completion. Receipt is recorded by its own action instead.
// Visual grouping does not change domain semantics.
//
// Leif controls whether he asks and the client controls whether they
// answer, so the CRM must not strand an offboarding on somebody who may
// never reply.
export const TestimonialRow = ({
  enrollment,
  offer,
}: {
  enrollment: Enrollment;
  offer: Offer | undefined;
}) => {
  const translate = useTranslate();
  const notify = useNotify();
  const refresh = useRefresh();
  const dataProvider = useDataProvider();
  const [saving, setSaving] = useState(false);

  // Only programmes that ask. Growing Yourself Up shares the offboarding
  // engine and is switched on per Offer, never by name.
  if (!offer?.collects_testimonial) return null;

  const received = enrollment.testimonial_received_at ?? null;

  const markReceived = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { data } = await dataProvider.update<Enrollment>("enrollments", {
        id: enrollment.id,
        data: { testimonial_received_at: new Date().toISOString() },
        previousData: enrollment,
      });
      // Truthful success: the toast reports what came BACK, not the fact
      // that the request did not throw. If the row somehow came back
      // without a timestamp, nothing is claimed.
      if (data?.testimonial_received_at) {
        notify(
          translate("resources.enrollments.testimonial.recorded", {
            _: "Testimonial recorded as received.",
          }),
          { type: "info" },
        );
      } else {
        notify(
          translate("resources.enrollments.testimonial.not_recorded", {
            _: "That did not save. The testimonial is still marked not received.",
          }),
          { type: "warning", autoHideDuration: 0 },
        );
      }
      refresh();
    } catch {
      notify(
        translate("resources.enrollments.testimonial.failed", {
          _: "That could not be saved just now. Nothing was changed.",
        }),
        { type: "error" },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    // The same row rhythm as OffboardingItemRow beside it — py-2.5 with the
    // first/last padding collapsed, so the container's own divide-y draws
    // the separator and nothing adds a second border or a nested card.
    // Stacks on a phone rather than wrapping mid-row.
    <div
      data-testid="testimonial-row"
      className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-col min-w-0">
        <span className="text-sm">
          {translate("resources.enrollments.testimonial.title", {
            _: "Testimonial",
          })}
        </span>
        <span className="text-xs text-muted-foreground">
          {received
            ? translate("resources.enrollments.testimonial.received_on", {
                _: "Received %{date}",
                date: formatTimestampString(received),
              })
            : translate("resources.enrollments.testimonial.not_received", {
                _: "Not received",
              })}
        </span>
      </div>
      {!received && (
        <Button
          variant="outline"
          size="sm"
          className="self-start sm:self-auto"
          disabled={saving}
          onClick={() => void markReceived()}
        >
          {translate("resources.enrollments.testimonial.mark", {
            _: "Mark testimonial received",
          })}
        </Button>
      )}
    </div>
  );
};
