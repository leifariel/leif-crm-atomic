// Application questions live in a free-form `raw_answers` jsonb blob (no
// fixed schema — see 01_tables.sql) and evolve per Offer, so this can never
// be a fixed enum. Known keys get an explicit, human-phrased question;
// anything else is safely humanized rather than dropped or shown raw
// (Native Applications slice, §2: never show "why_this_program").
//
// THIS IS A LEGACY COMPATIBILITY PATH, NOT AN AUTHORITY.
//
// A key can outlive the question it asked. gyu_commitment_scale asked "On a
// scale from 1–10, how ready are you…" under the old Growing Yourself Up form
// and "On a scale of 1–10, how committed are you…" under the shared question
// set, so no single entry here can be true for both generations. A map keyed
// only by question_key therefore cannot be the source of truth for what
// somebody was asked.
//
// The authority is application_responses.question_text — the words snapshotted
// at submission, immutable afterwards. ApplicationAnswerSections consults this
// map ONLY for an application with no form_key, meaning no registry wording
// ever existed for it: a recovered Notion record, or a native submission whose
// Offer had no registered form version. A versioned submission waits for its
// own recorded words rather than borrowing a guess from here.
//
// WHICH IS WHY THE SHARED QUESTION SET IS DELIBERATELY ABSENT BELOW.
// gyu_main_pattern, gyu_prior_attempts, gyu_hoped_change and gyu_hoped_support
// only exist on versioned submissions, which never reach this map. Adding them
// would be dead entries that also imply, falsely, that they can appear on a
// legacy record. And gyu_commitment_scale KEEPS ITS OLD WORDING here on
// purpose: the only applications that can still reach this map are the old
// ones, and that is the question those applicants actually answered.
//
// Reviewers must see the actual question, never a cryptic key (Phase 6). The
// text below reflects human-acceptance round 1's corrections; keys are
// unchanged from the first pass — wording changes alone don't warrant
// answer-key churn. Entries are always plain strings even where the public
// form rendered part of a question in italics (gyu_why_now): a visual
// treatment, not a content difference a reviewer needs.
const KNOWN_ANSWER_LABELS: Record<string, string> = {
  // Legacy placeholder keys — kept so any already-submitted Application
  // predating this slice still renders a real question, not a raw key.
  why_this_program: "Why this program?",
  why_this_cohort: "Why this cohort?",
  availability: "Availability",

  // The Living Example Application
  le_main_pattern:
    "What's the main pattern, emotion, or relationship dynamic you're struggling with right now?",
  le_prior_attempts: "What have you already tried to change or shift this?",
  le_hoped_change: "How are you hoping to change through working together?",
  le_hoped_support: "How are you hoping I will support you?",
  le_commitment_scale:
    "On a scale of 1–10, how committed are you to changing this pattern/way-of-being?",

  // Growing Yourself Up Application — the OLD four-question form. These are
  // the questions those applicants actually answered.
  gyu_biggest_challenge:
    "What's the biggest challenge you're facing in your personal growth and healing?",
  gyu_why_now: "Why are you ready for support and change now?",
  gyu_hoped_outcome:
    "What are you hoping this program with Leif helps you create in your life and relationships?",
  gyu_commitment_scale:
    "On a scale from 1–10, how ready are you to make a time, financial, and personal commitment to the change you want?",
};

// snake_case or kebab-case -> "Title Case" — the generic fallback for any
// key not in the map above, so a future question never renders as a raw
// database key.
const humanizeKey = (key: string): string =>
  key
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

export const labelForAnswerKey = (key: string): string =>
  KNOWN_ANSWER_LABELS[key] ?? humanizeKey(key);
