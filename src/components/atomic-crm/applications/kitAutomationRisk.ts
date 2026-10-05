import type { KitTagMapping } from "../types";

// What adding a tag is likely to DO, so the CRM can say it before it happens.
//
// Kit decides which automation a tag triggers, and the CRM cannot read that.
// What it CAN read is which event a tag is configured for, and Leif has told
// us what each event's automation does today:
//
//   applicant           no email automation attached
//   approved / not_fit  an existing automation can send an email
//   needs_higher_care   the tag exists, but he has not written its automation
//
// So this never claims an email was sent, and never invents provider evidence.
// It reports the risk the configuration implies, and nothing more.

export type KitTagRisk =
  // An outcome tag whose automation can send a real email. Worth one concise
  // confirmation before it goes.
  | "sends-email"
  // Configured, but Leif has not attached an automation yet. The tag will
  // land; the email is still his to send.
  | "no-automation-yet"
  // An applicant or cohort tag: nothing is connected to it today.
  | "quiet";

const SENDS_EMAIL: string[] = ["approved", "not_fit"];

// A required tag already knows which event it is for, so the two surfaces that
// offer "Add required tags" can ask about it without re-reading the mappings.
export const kitEventRisk = (event: string): KitTagRisk => {
  if (SENDS_EMAIL.includes(event)) return "sends-email";
  if (event === "needs_higher_care") return "no-automation-yet";
  return "quiet";
};

export const kitTagRisk = (
  kitTagId: number,
  mappings: KitTagMapping[],
): KitTagRisk => {
  const events = mappings
    .filter((mapping) => Number(mapping.kit_tag_id) === Number(kitTagId))
    .map((mapping) => mapping.event);
  if (events.some((event) => kitEventRisk(event) === "sends-email"))
    return "sends-email";
  if (events.includes("needs_higher_care")) return "no-automation-yet";
  return "quiet";
};

// What any confirmation says before provider work, for however many risky
// tags are going. The CRM reads which EVENT a tag is mapped to and never
// Kit's automation topology, so this says "may trigger" and asserts neither
// the connection nor an email. Both confirmations say it through here, so
// there is one sentence to keep honest rather than three.
export const kitRiskWarning = (tagNames: string[]): string | null => {
  if (tagNames.length === 0) return null;
  if (tagNames.length === 1)
    return `${tagNames[0]} may trigger a Kit automation connected to that tag.`;
  return "These tags may trigger Kit automations connected to them.";
};

export const kitRiskSentence = (risk: KitTagRisk, tagName: string): string => {
  switch (risk) {
    case "sends-email":
      // Same claim the shared confirmation makes, from the same authority:
      // the CRM reads which EVENT a tag is mapped to, never Kit's automation
      // topology, so it says "may trigger" and asserts no connection.
      return kitRiskWarning([tagName]) ?? "";
    case "no-automation-yet":
      return `${tagName} does not currently have an email automation attached, so that email still needs to be sent by hand.`;
    default:
      return "";
  }
};

// What happens after this tag lands, said only where the configuration
// actually says it.
//
// This used to be one hard-coded sentence — "Needs Higher Care email still
// needs to be sent manually" — printed on every Needs Higher Care decision
// for every programme. It was true when Kit Core shipped and became false
// the day Leif wrote the automations: GYU-NeedsHigherCare now hands off to
// GYU_NeedsHigherCare, and MiniDD_NeedsHigherCare to its own. A sentence
// that outlives its fact is worse than no sentence, because Leif acts on it.
//
// So it reads kit_tag_mappings.followup_mode, per (offer, event), and says
// nothing at all for a mapping nobody has characterised.
//
// The three claims are deliberately different sizes:
//
//   DELIVERED        kit_sync_operations proves it. The CRM may say so.
//   HANDED OFF       this tag is CONFIGURED to trigger an automation. The
//                    CRM may say that, because Leif told it so.
//   ENROLLED / SENT  Kit's own facts. The CRM may never claim either, and
//                    nothing here does — Terry's actual enrollment in
//                    GYU_NeedsHigherCare was verified by Leif in Kit, not
//                    by this CRM.
export const followupNote = (
  mapping:
    | Pick<KitTagMapping, "followup_mode" | "automation_name">
    | null
    | undefined,
  delivered: boolean,
): string | null => {
  if (!mapping) return null;
  if (mapping.followup_mode === "manual_email") {
    return "That email still needs to be sent by hand.";
  }
  if (mapping.followup_mode === "kit_automation") {
    // Only once the tag has actually landed. Before that the status line
    // already says what is happening, and "handed off" would be a claim
    // about work that has not happened.
    return delivered ? "Handed off to Kit automation." : null;
  }
  return null;
};
