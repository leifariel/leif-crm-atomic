import type { DataProvider, Identifier } from "ra-core";

import { describePlan } from "./transferClientOffer";
import type {
  Deal,
  Enrollment,
  EnrollmentOnboardingItem,
  Offer,
  OnboardingRequirementTemplate,
} from "../types";

// Bringing a client's setup into line with the programme their Opportunity
// already names.
//
// This is NOT a transfer, and the distinction is the whole point. A transfer
// changes the programme: offer A becomes offer B, and everything downstream
// follows in one transaction. A reconcile changes nothing about the programme —
// the Opportunity already says the right thing — and moves only the projection
// that was left behind.
//
// Jenna Smith is why it exists. Her Opportunity was edited from Growing
// Yourself Up to The Living Example three minutes after the sale, before any
// guard existed, so transfer_enrolled_opportunity_offer() correctly answers
// 'already-on-offer' for her: there is no programme change left to make. What
// is stale is her checklist.
//
// The rules that decide what happens to each requirement live in ONE place —
// apply_enrollment_onboarding_projection() in Postgres, and this mirror's
// shared use of describePlan() for the preview — so the repair and the transfer
// cannot promise different things.

// Which programme a stale checklist came FROM is never inferred silently. The
// dialog may propose an answer when exactly one programme's template accounts
// for it, but Leif states it, and the server refuses a claim the requirements
// themselves contradict.
export type ReconcileClientOnboardingResult =
  | {
      status: "reconciled";
      fromOfferId: Identifier | null;
      toOfferId: Identifier;
      retired: number;
      relabelled: number;
      added: number;
      keptDone: number;
      eventRecorded: boolean;
    }
  // The checklist already matches the programme. A second click, a stale tab,
  // or a client who was never wrong: all three get this.
  | { status: "already-aligned" }
  | { status: "not-found" }
  | { status: "invalid-offer" }
  | { status: "no-enrollment" }
  | { status: "ambiguous-enrollment" }
  // A finished client's record is history and is not reopened.
  | { status: "terminal-enrollment"; enrollmentStatus: string }
  // This client's onboarding is deliberately outside tracking, so there is
  // nothing for it to be reconciled to.
  | { status: "onboarding-not-tracked"; tracking: string }
  // "It came from the programme it is already on" says nothing.
  | { status: "same-offer" }
  // Requirements from another programme are present and nobody has named it.
  | { status: "needs-source-offer"; foreignKeys: string[] }
  // Nothing foreign is present, so there is no programme change to record.
  | { status: "source-offer-not-applicable" }
  // The named programme cannot account for what would be retired.
  | { status: "source-offer-mismatch"; unmatchedKeys: string[] };

type ReconcileCapableProvider = DataProvider & {
  reconcileEnrollmentToCurrentOffer?: (
    opportunityId: Identifier,
    fromOfferId: Identifier | null,
  ) => Promise<Record<string, unknown>>;
};

// The same question the database asks in enrollment_onboarding_matches_offer():
// the live requirement keys and the programme's active template keys are the
// same set. Retired rows are history and do not count; labels and ordering do
// not enter into it, because the key is the identity.
export const onboardingMatchesOffer = (
  items: EnrollmentOnboardingItem[],
  templates: OnboardingRequirementTemplate[],
): boolean => {
  const live = items.filter((item) => item.status !== "retired");
  const liveKeys = new Set(live.map((item) => item.requirement_key));
  const templateKeys = new Set(templates.map((template) => template.key));
  if (liveKeys.size !== templateKeys.size) return false;
  for (const key of liveKeys) {
    if (!templateKeys.has(key)) return false;
  }
  return true;
};

// Whether a repair is even a question for this client, which is not the same
// question as whether their checklist matches the template.
//
// 'legacy_untracked' means their onboarding was deliberately not modelled here
// (Slice 2): they were already working with Leif before the CRM tracked it, and
// the absence of a checklist is the recorded fact rather than a gap.
// computeOnboardingProgress already says so — isLegacyUntracked true,
// isMissingChecklist FALSE — and this says the same thing about repairing.
//
// onboardingMatchesOffer() keeps its own narrow meaning on purpose: for a
// legacy client the honest answer to "do these keys equal that template's?" is
// no, and making it answer yes would leave every future caller reading
// "untracked" as "aligned tracked onboarding". So eligibility is a separate
// layer, and it is checked FIRST — a legacy client is never described as
// aligned, only as not tracked.
export type OnboardingRepairState = "not-tracked" | "aligned" | "stale";

export const onboardingRepairState = ({
  tracking,
  items,
  templates,
}: {
  tracking: string | null | undefined;
  items: EnrollmentOnboardingItem[];
  templates: OnboardingRequirementTemplate[];
}): OnboardingRepairState => {
  // Anything that is not explicitly 'tracked' is not repaired by this path. A
  // write authority refuses what it cannot be sure about; assessOnboarding's
  // opposite default (unknown reads as tracked) is right for SHOWING a missing
  // checklist and wrong for seeding one.
  if (tracking !== "tracked") return "not-tracked";
  return onboardingMatchesOffer(items, templates) ? "aligned" : "stale";
};

// The live requirements this programme does not have. These are the evidence
// that another programme's template is in play — and the thing a named source
// programme has to be able to account for.
export const foreignRequirementKeys = (
  items: EnrollmentOnboardingItem[],
  templates: OnboardingRequirementTemplate[],
): string[] => {
  const templateKeys = new Set(templates.map((template) => template.key));
  return items
    .filter(
      (item) =>
        item.status !== "retired" && !templateKeys.has(item.requirement_key),
    )
    .map((item) => item.requirement_key)
    .sort();
};

// A proposal, never a decision. Exactly one programme whose active template
// accounts for every foreign requirement, and only when there is no second
// candidate — otherwise null, and Leif picks.
export const proposePreviousOffer = (
  foreignKeys: string[],
  candidates: { offerId: Identifier; keys: string[] }[],
): Identifier | null => {
  if (foreignKeys.length === 0) return null;
  const accounting = candidates.filter((candidate) => {
    const keys = new Set(candidate.keys);
    return foreignKeys.every((key) => keys.has(key));
  });
  return accounting.length === 1 ? accounting[0].offerId : null;
};

export const reconcileClientOnboarding = async (
  dataProvider: DataProvider,
  {
    opportunityId,
    fromOfferId,
  }: { opportunityId: Identifier; fromOfferId: Identifier | null },
): Promise<ReconcileClientOnboardingResult> => {
  const rpc = (dataProvider as ReconcileCapableProvider)
    .reconcileEnrollmentToCurrentOffer;
  if (rpc) {
    const result = await rpc(opportunityId, fromOfferId);
    return readResult(result);
  }
  return reconcileMirror(dataProvider, { opportunityId, fromOfferId });
};

const readResult = (
  result: Record<string, unknown>,
): ReconcileClientOnboardingResult => {
  const status = String(result.status ?? "");
  if (status === "reconciled") {
    return {
      status: "reconciled",
      fromOfferId: (result.from_offer_id as Identifier | null) ?? null,
      toOfferId: result.to_offer_id as Identifier,
      retired: Number(result.retired ?? 0),
      relabelled: Number(result.relabelled ?? 0),
      added: Number(result.added ?? 0),
      keptDone: Number(result.kept_done ?? 0),
      eventRecorded: Boolean(result.event_recorded),
    };
  }
  if (status === "terminal-enrollment") {
    return {
      status,
      enrollmentStatus: String(result.enrollment_status ?? ""),
    };
  }
  if (status === "onboarding-not-tracked") {
    return { status, tracking: String(result.onboarding_tracking ?? "") };
  }
  if (status === "needs-source-offer") {
    return { status, foreignKeys: asKeys(result.foreign_keys) };
  }
  if (status === "source-offer-mismatch") {
    return { status, unmatchedKeys: asKeys(result.unmatched_keys) };
  }
  if (
    status === "already-aligned" ||
    status === "not-found" ||
    status === "invalid-offer" ||
    status === "no-enrollment" ||
    status === "ambiguous-enrollment" ||
    status === "same-offer" ||
    status === "source-offer-not-applicable"
  ) {
    return { status };
  }
  return { status: "not-found" };
};

const asKeys = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((key) => String(key)) : [];

// The FakeRest mirror of reconcile_enrollment_to_current_offer(), refusal for
// refusal and step for step. The atomicity comes from the real function.
const reconcileMirror = async (
  dataProvider: DataProvider,
  {
    opportunityId,
    fromOfferId,
  }: { opportunityId: Identifier; fromOfferId: Identifier | null },
): Promise<ReconcileClientOnboardingResult> => {
  const { data: deal } = await dataProvider
    .getOne<Deal>("deals", { id: opportunityId })
    .catch(() => ({ data: null as Deal | null }));
  if (!deal) return { status: "not-found" };

  if (fromOfferId != null) {
    const { data: fromOffer } = await dataProvider
      .getOne<Offer>("offers", { id: fromOfferId })
      .catch(() => ({ data: null as Offer | null }));
    if (!fromOffer) return { status: "invalid-offer" };
    if (String(fromOfferId) === String(deal.offer_id)) {
      return { status: "same-offer" };
    }
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
  if (enrollments.length > 1) return { status: "ambiguous-enrollment" };
  const enrollment = enrollments[0];

  if (["completed", "withdrawn", "ended"].includes(enrollment.status)) {
    return {
      status: "terminal-enrollment",
      enrollmentStatus: enrollment.status,
    };
  }

  if (enrollment.onboarding_tracking !== "tracked") {
    return {
      status: "onboarding-not-tracked",
      tracking: String(enrollment.onboarding_tracking ?? ""),
    };
  }

  const { data: templates } =
    await dataProvider.getList<OnboardingRequirementTemplate>(
      "onboarding_requirement_templates",
      {
        filter: { offer_id: deal.offer_id, is_active: true },
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

  if (onboardingMatchesOffer(items, templates)) {
    return { status: "already-aligned" };
  }

  const foreignKeys = foreignRequirementKeys(items, templates);
  if (foreignKeys.length === 0) {
    if (fromOfferId != null) return { status: "source-offer-not-applicable" };
  } else {
    if (fromOfferId == null) {
      return { status: "needs-source-offer", foreignKeys };
    }
    const { data: fromTemplates } =
      await dataProvider.getList<OnboardingRequirementTemplate>(
        "onboarding_requirement_templates",
        {
          filter: { offer_id: fromOfferId, is_active: true },
          pagination: { page: 1, perPage: 100 },
          sort: { field: "sort_order", order: "ASC" },
        },
      );
    const fromKeys = new Set(fromTemplates.map((template) => template.key));
    const unmatchedKeys = foreignKeys.filter((key) => !fromKeys.has(key));
    if (unmatchedKeys.length > 0) {
      return { status: "source-offer-mismatch", unmatchedKeys };
    }
  }

  // The Opportunity is deliberately not written. Its offer is already what it
  // should be, which is the premise of the whole operation.
  const plan = describePlan(items, templates);
  let retired = 0;
  let relabelled = 0;
  let added = 0;
  let keptDone = 0;

  for (const item of items) {
    if (item.status === "retired") continue;
    const template = templates.find((t) => t.key === item.requirement_key);
    if (!template) {
      if (item.status === "done") {
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
  }

  for (const template of templates) {
    const existing = items.find((i) => i.requirement_key === template.key);
    if (existing) {
      if (existing.status === "done") {
        keptDone += 1;
        // Provenance is left alone, including null: a finished shared
        // requirement is the same requirement in both programmes.
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
          source_offer_id: deal.offer_id,
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
          source_offer_id: deal.offer_id,
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

  if (fromOfferId != null) {
    // occurred_at stays null: the programme change predates the guard and
    // nothing records which day it was. 'reconstructed' is what makes that
    // readable instead of looking like something that happened at repair time.
    await dataProvider.create("deal_offer_events", {
      data: {
        opportunity_id: opportunityId,
        enrollment_id: enrollment.id,
        from_offer_id: fromOfferId,
        to_offer_id: deal.offer_id,
        occurred_at: null,
        recorded_at: new Date().toISOString(),
        source: "reconstructed",
        note: "Onboarding reconciled to the programme the Opportunity already carried. The programme change itself happened before transfer_enrolled_opportunity_offer() existed and its date is not recorded anywhere.",
      },
    });
  }

  return {
    status: "reconciled",
    fromOfferId,
    toOfferId: deal.offer_id,
    retired,
    relabelled,
    added,
    keptDone: keptDone || plan.keptDone.length,
    eventRecorded: fromOfferId != null,
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
