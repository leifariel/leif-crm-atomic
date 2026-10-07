import { defaultTaskTypes } from "../root/defaultConfiguration";
import { describeTaskKind } from "./needsAttentionInventory";
import type { LabeledValue } from "../types";

/**
 * What Leif reads for a task's type, or null when the task has none at all
 * (nullable at the DB level — see supabase/schemas/01_tables.sql's
 * tasks.type).
 *
 * Three sources, in order, and the second exists because of a production
 * failure.
 *
 * The vocabulary this receives is the SAVED configuration, not the one this
 * release ships. useConfigurationContext reads `app.configuration` out of
 * the persisted store and merges it over defaultConfiguration ONE KEY DEEP;
 * `taskTypes` is one of those keys, and useConfigurationLoader fills that
 * store from a `configuration` database row. So a vocabulary saved before a
 * release replaces that release's wholesale, and every type added since is
 * missing from it — not relabelled, absent.
 *
 * That is how production showed "collect_testimonial" on Jules's Enrollment
 * page while the deployed bundle demonstrably contained "Ask for
 * testimonial": the card polish in the very same deploy landed, because it
 * is markup, and the label did not, because it is configuration.
 *
 * Leif's own relabelling still wins — a type the saved configuration
 * defines is read from there, exactly as before. Only a type it has never
 * heard of falls through to this release's vocabulary, then to the Needs
 * Attention inventory. Reaching the stored identifier now means a type NO
 * vocabulary in the codebase describes, which is the only case the raw
 * value was ever meant for.
 *
 * This lives in its own module so the decision can be tested against a
 * vocabulary chosen by the test. It cannot be reached that way through the
 * component: the test harness replaces the Layout that
 * useConfigurationLoader lives in, and neither a <CRM taskTypes> prop nor a
 * pre-seeded store reaches useConfigurationContext under it — measured, not
 * assumed. A test that cannot express the broken state cannot prove the
 * repair.
 */
export const resolveTaskTypeLabel = (
  type: string | null | undefined,
  taskTypes: LabeledValue[],
): string | null => {
  if (!type) return null;
  const configured = taskTypes.find((t) => t.value === type)?.label;
  if (configured) return configured;
  const shipped = defaultTaskTypes.find((t) => t.value === type)?.label;
  if (shipped) return shipped;
  return describeTaskKind(type)?.label ?? type;
};
