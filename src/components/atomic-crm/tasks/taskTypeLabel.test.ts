import { describe, expect, it } from "vitest";

import { resolveTaskTypeLabel } from "./taskTypeLabel";
import { defaultTaskTypes } from "../root/defaultConfiguration";
import { NEEDS_ATTENTION_KINDS } from "./needsAttentionInventory";

// The regression for the production failure: Leif read "collect_testimonial"
// on Enrollment 48 while the deployed bundle demonstrably contained "Ask for
// testimonial".
//
// This is the layer the previous suite was missing, and the only layer that
// can express the broken state. The runtime vocabulary is the SAVED
// configuration, and a configuration saved before a release simply has no
// entry for a type added by it. No component test in this codebase can
// produce that state — the harness replaces the Layout that
// useConfigurationLoader lives in, and neither a <CRM taskTypes> prop nor a
// pre-seeded store reaches useConfigurationContext under it (measured: the
// context reports this release's full 16 types either way). Here the
// vocabulary is simply an argument.

/** The vocabulary as saved before the testimonial stages existed. */
const SAVED_BEFORE_THIS_RELEASE = defaultTaskTypes.filter(
  (t) => !t.value.includes("testimonial"),
);

const TESTIMONIAL_STAGES = [
  ["collect_testimonial", "Ask for testimonial"],
  ["testimonial_followup_1", "Testimonial follow-up"],
  ["testimonial_followup_2", "Final testimonial follow-up"],
] as const;

describe("resolveTaskTypeLabel", () => {
  it("the fixture really is missing the three stages", () => {
    // Guards the reproduction. If this ever passes vacuously, everything
    // below stops meaning anything.
    for (const [type] of TESTIMONIAL_STAGES) {
      expect(
        SAVED_BEFORE_THIS_RELEASE.some((t) => t.value === type),
        type,
      ).toBe(false);
    }
    expect(SAVED_BEFORE_THIS_RELEASE.length).toBeGreaterThan(5);
  });

  it("names a stage the saved configuration has never heard of", () => {
    // THE regression. Before the repair every one of these returned the
    // stored identifier, which is exactly what reached Leif's screen.
    for (const [type, label] of TESTIMONIAL_STAGES) {
      expect(resolveTaskTypeLabel(type, SAVED_BEFORE_THIS_RELEASE)).toBe(label);
    }
  });

  it("never returns a raw identifier for any type the codebase describes", () => {
    // The general form of the same bug, so the next type added to the
    // engine cannot repeat it. An empty vocabulary is the worst case a
    // saved configuration can present.
    const described = new Set([
      ...defaultTaskTypes.map((t) => t.value),
      ...NEEDS_ATTENTION_KINDS.map((k) => k.type),
    ]);
    for (const type of described) {
      const label = resolveTaskTypeLabel(type, []);
      expect(label, type).toBeTruthy();
      expect(label, type).not.toBe(type);
      expect(label, type).not.toContain("_");
    }
  });

  it("lets Leif's own relabelling win", () => {
    // The fallback must never override a label the saved configuration
    // actually defines, including for the testimonial stages themselves.
    expect(
      resolveTaskTypeLabel("follow_up", [
        { value: "follow_up", label: "Chase it up" },
      ]),
    ).toBe("Chase it up");
    expect(
      resolveTaskTypeLabel("collect_testimonial", [
        { value: "collect_testimonial", label: "Request a quote" },
      ]),
    ).toBe("Request a quote");
  });

  it("still falls back to the stored value for a genuinely unknown type", () => {
    // The only case the raw value was ever meant for: a custom type no
    // vocabulary in the codebase describes.
    expect(resolveTaskTypeLabel("bespoke_tenant_type", [])).toBe(
      "bespoke_tenant_type",
    );
  });

  it("says nothing for a task with no type", () => {
    expect(resolveTaskTypeLabel(null, defaultTaskTypes)).toBeNull();
    expect(resolveTaskTypeLabel(undefined, defaultTaskTypes)).toBeNull();
    expect(resolveTaskTypeLabel("", defaultTaskTypes)).toBeNull();
  });
});
