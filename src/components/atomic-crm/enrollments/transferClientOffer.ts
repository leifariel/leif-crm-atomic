import type { DataProvider, Identifier } from "ra-core";

import type {
  Deal,
  Enrollment,
  EnrollmentOnboardingItem,
  Offer,
  OnboardingRequirementTemplate,
} from "../types";

// Moving a client from one programme to another.
//
// Jenna Smith booked a Growing Yourself Up call and bought The Living Example.
// Her Opportunity was edited to LE three minutes after the sale, and her
// onboarding stayed GYU: "Invite jenna smith to GYU Slack", a GYU curriculum
// item, four pending Tasks to match. Nothing was wrong with either write —
// there was simply no such thing as changing programmes, so nothing reconciled
// the half that follows the sale.
//
// Production runs transfer_enrolled_opportunity_offer() in ONE transaction, so
// there is never a moment where the Opportunity says The Living Example and the
// checklist still says GYU. This is the FakeRest mirror plus the typed result;
// the ordering is mirrored, the atomicity comes from the real function.
//
// What happens to each requirement is decided by its stable KEY, never by its
// label — "curriculum_access" exists in both programmes and means a different
// thing in each, which is exactly why the label cannot be the identity.

export type TransferClientOfferResult =
  | {
      status: "transferred";
      fromOfferId: Identifier;
      toOfferId: Identifier;
      retired: number;
      relabelled: number;
      added: number;
      keptDone: number;
    }
  // The client is already on that programme. A second click, or a stale tab.
  | { status: "already-on-offer" }
  | { status: "not-found" }
  | { status: "invalid-offer" }
  // Nothing downstream exists yet, so an ordinary offer edit is still the
  // right tool and is still allowed.
  | { status: "no-enrollment" }
  // A group programme needs its round chosen, and this never picks one.
  | { status: "needs-cohort"; reason: string };

type TransferCapableProvider = DataProvider & {
  transferEnrolledOpportunityOffer?: (
    opportunityId: Identifier,
    toOfferId: Identifier,
  ) => Promise<Record<string, unknown>>;
};

export const transferClientOffer = async (
  dataProvider: DataProvider,
  {
    opportunityId,
    toOfferId,
  }: { opportunityId: Identifier; toOfferId: Identifier },
): Promise<TransferClientOfferResult> => {
  const rpc = (dataProvider as TransferCapableProvider)
    .transferEnrolledOpportunityOffer;
  if (rpc) {
    const result = await rpc(opportunityId, toOfferId);
    const status = String(result.status ?? "");
    if (status === "transferred") {
      return {
        status: "transferred",
        fromOfferId: result.from_offer_id as Identifier,
        toOfferId: result.to_offer_id as Identifier,
        retired: Number(result.retired ?? 0),
        relabelled: Number(result.relabelled ?? 0),
        added: Number(result.added ?? 0),
        keptDone: Number(result.kept_done ?? 0),
      };
    }
    if (status === "needs-cohort") {
      return { status, reason: String(result.reason ?? "") };
    }
    if (
      status === "already-on-offer" ||
      status === "not-found" ||
      status === "invalid-offer" ||
      status === "no-enrollment"
    ) {
      return { status };
    }
    return { status: "not-found" };
  }

  return transferMirror(dataProvider, { opportunityId, toOfferId });
};

// The FakeRest mirror of the real function, step for step.
const transferMirror = async (
  dataProvider: DataProvider,
  {
    opportunityId,
    toOfferId,
  }: { opportunityId: Identifier; toOfferId: Identifier },
): Promise<TransferClientOfferResult> => {
  const { data: deal } = await dataProvider
    .getOne<Deal>("deals", { id: opportunityId })
    .catch(() => ({ data: null as Deal | null }));
  if (!deal) return { status: "not-found" };

  const { data: offer } = await dataProvider
    .getOne<Offer>("offers", { id: toOfferId })
    .catch(() => ({ data: null as Offer | null }));
  if (!offer) return { status: "invalid-offer" };

  if (String(deal.offer_id) === String(toOfferId)) {
    return { status: "already-on-offer" };
  }

  const { data: enrollments } = await dataProvider.getList<Enrollment>(
    "enrollments",
    {
      filter: { opportunity_id: opportunityId },
      pagination: { page: 1, perPage: 5 },
      sort: { field: "id", order: "ASC" },
    },
  );
  if (enrollments.length === 0) return { status: "no-enrollment" };
  const enrollment = enrollments[0];

  if (offer.type === "group") {
    return {
      status: "needs-cohort",
      reason: `${offer.name} is a group programme: choose the round before moving a client into it`,
    };
  }

  const fromOfferId = deal.offer_id;

  const { data: templates } =
    await dataProvider.getList<OnboardingRequirementTemplate>(
      "onboarding_requirement_templates",
      {
        filter: { offer_id: toOfferId, is_active: true },
        pagination: { page: 1, perPage: 100 },
        sort: { field: "sort_order", order: "ASC" },
      },
    );

  const { data: items } = await dataProvider.getList<EnrollmentOnboardingItem>(
    "enrollment_onboarding_items",
    {
      filter: { enrollment_id: enrollment.id },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "sort_order", order: "ASC" },
    },
  );

  await dataProvider.update("deals", {
    id: opportunityId,
    data: {
      offer_id: toOfferId,
      // Only an individual programme can be reached here (a group target was
      // refused above), and an individual Opportunity has no round to keep.
      cohort_id: null,
    },
    previousData: deal,
  });

  const targetKeys = new Set(templates.map((t) => t.key));
  let retired = 0;
  let relabelled = 0;
  let added = 0;
  let keptDone = 0;

  // Requirements the new programme does not have.
  for (const item of items) {
    if (targetKeys.has(item.requirement_key) || item.status === "retired") {
      continue;
    }
    if (item.status === "done") {
      // Completed work under the old programme is history, not a requirement
      // of the new one.
      await dataProvider.update("enrollment_onboarding_items", {
        id: item.id,
        data: { source_offer_id: item.source_offer_id ?? fromOfferId },
        previousData: item,
      });
      continue;
    }
    await dataProvider.update("enrollment_onboarding_items", {
      id: item.id,
      data: {
        status: "retired",
        retired_at: new Date().toISOString(),
        retired_from_offer_id: fromOfferId,
        source_offer_id: item.source_offer_id ?? fromOfferId,
      },
      previousData: item,
    });
    retired += 1;
    await cancelTasksFor(dataProvider, item.id);
  }

  // Requirements the new programme shares or adds.
  for (const template of templates) {
    const existing = items.find((i) => i.requirement_key === template.key);
    if (existing) {
      if (existing.status === "done") {
        keptDone += 1;
        // Provenance is LEFT ALONE, including null. A shared requirement that
        // is already finished is the same requirement in both programmes, so
        // the Opportunity having once been GYU says nothing about where this
        // row came from — stamping it would invent a fact about completed work.
        await dataProvider.update("enrollment_onboarding_items", {
          id: existing.id,
          data: {
            is_required: template.is_required,
            sort_order: template.sort_order,
          },
          previousData: existing,
        });
        continue;
      }
      // Pending: only a request, so it becomes the new programme's request.
      await dataProvider.update("enrollment_onboarding_items", {
        id: existing.id,
        data: {
          label: template.label,
          task_text_template: template.task_text_template,
          is_required: template.is_required,
          sort_order: template.sort_order,
          status: "pending",
          retired_at: null,
          retired_from_offer_id: null,
          source_offer_id: toOfferId,
        },
        previousData: existing,
      });
      relabelled += 1;
      await retitleTaskFor(dataProvider, existing.id, template, deal);
      continue;
    }
    const { data: created } = await dataProvider.create(
      "enrollment_onboarding_items",
      {
        data: {
          enrollment_id: enrollment.id,
          requirement_key: template.key,
          label: template.label,
          task_text_template: template.task_text_template,
          is_required: template.is_required,
          sort_order: template.sort_order,
          status: "pending",
          source_offer_id: toOfferId,
        },
      },
    );
    added += 1;
    if (template.is_required) {
      await dataProvider.create("tasks", {
        data: {
          contact_id: deal.contact_id,
          type: "onboarding_item",
          text: template.task_text_template.replace("{name}", deal.name ?? ""),
          due_date: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          status: "pending",
          enrollment_id: enrollment.id,
          onboarding_item_id: created.id,
        },
      });
    }
  }

  await dataProvider.create("deal_offer_events", {
    data: {
      opportunity_id: opportunityId,
      enrollment_id: enrollment.id,
      from_offer_id: fromOfferId,
      to_offer_id: toOfferId,
      occurred_at: new Date().toISOString(),
      source: "app",
    },
  });

  return {
    status: "transferred",
    fromOfferId,
    toOfferId,
    retired,
    relabelled,
    added,
    keptDone,
  };
};

const openTasksFor = async (
  dataProvider: DataProvider,
  onboardingItemId: Identifier,
) => {
  const { data } = await dataProvider.getList("tasks", {
    filter: { onboarding_item_id: onboardingItemId },
    pagination: { page: 1, perPage: 20 },
    sort: { field: "id", order: "ASC" },
  });
  return data.filter((task) => task.status !== "completed");
};

const cancelTasksFor = async (
  dataProvider: DataProvider,
  onboardingItemId: Identifier,
) => {
  for (const task of await openTasksFor(dataProvider, onboardingItemId)) {
    await dataProvider.update("tasks", {
      id: task.id,
      data: {
        status: "cancelled",
        // done_date is when a Task CLOSED, which a cancellation also is —
        // tasks_completion_agreement_check refuses a closed Task without one.
        done_date: task.done_date ?? new Date().toISOString(),
      },
      previousData: task,
    });
  }
};

const retitleTaskFor = async (
  dataProvider: DataProvider,
  onboardingItemId: Identifier,
  template: OnboardingRequirementTemplate,
  deal: Deal,
) => {
  const open = (await openTasksFor(dataProvider, onboardingItemId)).filter(
    (task) => task.status === "pending",
  );
  for (const task of open) {
    await dataProvider.update("tasks", {
      id: task.id,
      data: {
        text: template.task_text_template.replace("{name}", deal.name ?? ""),
      },
      previousData: task,
    });
  }
};

// What the transfer will do, worked out from the same stable keys the server
// uses — so the preview cannot promise something different from the act.
export const describePlan = (
  items: EnrollmentOnboardingItem[],
  templates: OnboardingRequirementTemplate[],
): {
  keptDone: string[];
  relabelled: string[];
  retired: string[];
  added: string[];
} => {
  const live = items.filter((item) => item.status !== "retired");
  const targetKeys = new Set(templates.map((t) => t.key));
  const existingKeys = new Set(live.map((i) => i.requirement_key));

  return {
    keptDone: live
      .filter((i) => i.status === "done" && targetKeys.has(i.requirement_key))
      .map((i) => i.label),
    relabelled: live
      .filter((i) => i.status !== "done" && targetKeys.has(i.requirement_key))
      .map(
        (i) =>
          templates.find((t) => t.key === i.requirement_key)?.label ?? i.label,
      ),
    retired: live
      .filter((i) => i.status !== "done" && !targetKeys.has(i.requirement_key))
      .map((i) => i.label),
    added: templates
      .filter((t) => !existingKeys.has(t.key))
      .map((t) => t.label),
  };
};
