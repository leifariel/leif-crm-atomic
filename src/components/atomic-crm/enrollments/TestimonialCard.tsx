import { useState } from "react";
import { useDataProvider, useNotify, useRefresh, useTranslate } from "ra-core";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import { formatTimestampString } from "../deals/dealUtils";
import type { Enrollment, Offer } from "../types";

// Did the testimonial arrive, and does Leif need to ask again?
//
// Deliberately one line of truth plus one action. The task system already
// carries "ask them", "ask again 1/2" and "ask again 2/2"; this card
// answers the question those tasks cannot — whether it ever came — so Leif
// never has to read a task title to find out.
//
// Receipt is NOT an offboarding requirement. The Enrollment completes
// without it, because Leif controls whether he asks and the client
// controls whether they answer, and the CRM must not strand a client's
// offboarding on somebody who may never reply.
export const TestimonialCard = ({
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
  // engine but is deliberately not switched on.
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
    // The same shape as StartWeekCard directly beneath it: one Card, one
    // CardContent with no extra padding of its own (Card already carries
    // py-6, so the py-3 this used to add made it taller than its
    // neighbours, which is what read as an empty slab), a two-line stack on
    // the left and the action on the right — stacking on a narrow screen
    // rather than wrapping mid-row.
    <Card>
      <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">
            {translate("resources.enrollments.testimonial.title", {
              _: "Testimonial",
            })}
          </span>
          <span className="text-sm text-muted-foreground">
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
      </CardContent>
    </Card>
  );
};
