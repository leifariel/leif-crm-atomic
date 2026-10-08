import type { ApplicationQuestion } from "./PublicApplicationForm";

// THE core application questions, asked by every programme.
//
// Leif was getting short, low-information Growing Yourself Up applications
// while The Living Example produced much richer answers. The cause was not
// the applicants: LE asks five questions, each carrying a little description
// underneath it ("(Be specific—what keeps happening?)"), and GYU asked four
// bare ones with no descriptions at all. So GYU now asks LE's own questions.
//
// This module is the single source of that wording. It exists because the two
// forms were separate hardcoded arrays, and the next change to LE would
// otherwise leave GYU behind again exactly as it did this time.
//
// WORDING IS LEIF'S OWN AND CANONICAL. It was taken from
// LivingExampleApplicationPage.tsx by extracting its string literals rather
// than retyping them, so the curly apostrophes, the en dash in –1–10 and the
// curly quotes around "support" are byte-identical to what LE has always
// asked. Do not reword either form here without Leif asking for it.
//
// WHAT IS SHARED IS THE QUESTION SET, NOT THE PROGRAMME. Keys stay
// offer-namespaced — le_main_pattern, gyu_main_pattern — because a Growing
// Yourself Up application answering a key called le_* would misreport which
// programme it belongs to, and because raw_answers is keyed by exactly these
// strings. The prefix is the only thing that differs between the two forms.
const CORE_QUESTIONS: readonly {
  slug: string;
  label: string;
  helperText: string;
  required: boolean;
}[] = [
  {
    slug: "main_pattern",
    label:
      "What's the main pattern, emotion, or relationship dynamic you're struggling with right now?",
    helperText: "(Be specific—what keeps happening?)",
    required: true,
  },
  {
    slug: "prior_attempts",
    label: "What have you already tried to change or shift this?",
    helperText: "(Working with a therapist, meditation, personal work, etc.)",
    required: true,
  },
  {
    slug: "hoped_change",
    label: "How are you hoping to change through working together?",
    helperText: "(Be as real as possible)",
    required: true,
  },
  {
    slug: "hoped_support",
    label: "How are you hoping I will support you?",
    helperText: "(What does “support” mean to you?)",
    required: true,
  },
  {
    slug: "commitment_scale",
    label:
      "On a scale of 1–10, how committed are you to changing this pattern/way-of-being?",
    helperText: "(Time commitment, financial commitment, personal commitment)",
    required: true,
  },
];

/**
 * The core questions, keyed for one programme.
 *
 * `prefix` is that offer's own key namespace: "le" reproduces The Living
 * Example's existing keys exactly, so no LE answer key churns.
 */
export const coreApplicationQuestions = (
  prefix: string,
): ApplicationQuestion[] =>
  CORE_QUESTIONS.map((question) => ({
    key: `${prefix}_${question.slug}`,
    label: question.label,
    helperText: question.helperText,
    required: question.required,
  }));

/** The question keys a programme writes into raw_answers, in order. */
export const coreApplicationQuestionKeys = (prefix: string): string[] =>
  CORE_QUESTIONS.map((question) => `${prefix}_${question.slug}`);
