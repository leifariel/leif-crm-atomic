import { describe, expect, it } from "vitest";

import { followupNote } from "./kitAutomationRisk";
import type { KitTagMapping } from "../types";

// What the CRM is entitled to say after a decision tag lands.
//
// It said one hard-coded sentence on every Needs Higher Care decision —
// "Needs Higher Care email still needs to be sent manually" — true when Kit
// Core shipped, false the day Leif wrote the automations. Terry Robinson
// Whitney was tagged GYU-NeedsHigherCare, succeeded, subscriber
// 4315021388, and the page was still telling Leif to go and email him.
//
// Three claims of different sizes, and the CRM may only make two:
//   DELIVERED   kit_sync_operations proves it.
//   HANDED OFF  this tag is configured to trigger an automation.
//   ENROLLED    Kit's own fact. Terry's enrollment in GYU_NeedsHigherCare
//               was verified by Leif IN KIT, never by this CRM.

const mapping = (over: Partial<KitTagMapping> = {}): KitTagMapping =>
  ({
    offer_id: 2,
    event: "needs_higher_care",
    kit_tag_id: 24082732,
    kit_tag_name: "GYU-NeedsHigherCare",
    followup_mode: "kit_automation",
    automation_name: "GYU_NeedsHigherCare",
    created_at: "2026-10-05T00:00:00.000Z",
    ...over,
  }) as unknown as KitTagMapping;

describe("a tag wired to an automation", () => {
  it("says it was handed off, once the tag has actually landed", () => {
    expect(followupNote(mapping(), true)).toBe("Handed off to Kit automation.");
  });

  it("says nothing before the tag lands", () => {
    // There is no "next" yet, and the status line already says what is
    // happening.
    expect(followupNote(mapping(), false)).toBeNull();
  });

  it("never claims the email was sent or the person enrolled", () => {
    const note = followupNote(mapping(), true) ?? "";
    for (const forbidden of ["sent", "enrolled", "completed", "received"]) {
      expect(note.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("holds for The Living Example too, under its own Kit name", () => {
    // Mini Deep Dive is LE's sales pathway, not a second offer: this is
    // offer 1 with a MiniDD_* Kit tag.
    expect(
      followupNote(
        mapping({
          offer_id: 1,
          kit_tag_id: 24082725,
          kit_tag_name: "MiniDD_NeedsHigherCare",
          automation_name: "MiniDD_NeedsHigherCare",
        }),
        true,
      ),
    ).toBe("Handed off to Kit automation.");
  });
});

describe("a tag that is still Leif's to follow up", () => {
  it("says the email is his to send", () => {
    const note = followupNote(
      mapping({ followup_mode: "manual_email", automation_name: null }),
      true,
    );
    expect(note).toBe("That email still needs to be sent by hand.");
  });
});

describe("a mapping nobody has characterised", () => {
  it("says nothing, rather than inventing an obligation", () => {
    // The default is 'none' precisely so an unconfigured mapping cannot
    // manufacture a manual task Leif never agreed to.
    expect(
      followupNote(
        mapping({ followup_mode: "none", automation_name: null }),
        true,
      ),
    ).toBeNull();
    expect(followupNote(undefined, true)).toBeNull();
    expect(followupNote(null, true)).toBeNull();
  });

  it("says nothing for a mapping that predates the column", () => {
    // followup_mode absent entirely — an older row read before the
    // migration reaches a given environment.
    expect(
      followupNote({ automation_name: null } as unknown as KitTagMapping, true),
    ).toBeNull();
  });
});
