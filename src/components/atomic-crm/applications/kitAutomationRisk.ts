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

export const kitRiskSentence = (risk: KitTagRisk, tagName: string): string => {
  switch (risk) {
    case "sends-email":
      return `${tagName} is connected to one of your Kit email automations, which may send an email.`;
    case "no-automation-yet":
      return `${tagName} does not currently have an email automation attached, so that email still needs to be sent by hand.`;
    default:
      return "";
  }
};

// The one thing a Needs Higher Care decision must never let anybody assume.
export const NEEDS_HIGHER_CARE_EMAIL_NOTE =
  "Needs Higher Care email still needs to be sent manually.";

// What the confirmation says before provider work, for however many risky
// tags are going. Deliberately weaker than kitRiskSentence: the CRM reads
// which EVENT a tag is mapped to, never Kit's automation topology, so it says
// "may trigger" and never asserts the connection or an email.
export const kitRiskWarning = (tagNames: string[]): string | null => {
  if (tagNames.length === 0) return null;
  if (tagNames.length === 1)
    return `${tagNames[0]} may trigger a Kit automation connected to that tag.`;
  return "These tags may trigger Kit automations connected to them.";
};
