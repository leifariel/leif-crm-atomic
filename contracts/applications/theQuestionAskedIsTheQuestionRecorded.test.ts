import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { coreApplicationQuestions } from "../../src/components/atomic-crm/public-application/coreApplicationQuestions";

// TWO THINGS MUST NEVER DRIFT APART, and nothing used to hold them together.
//
// 1. What the two public forms ASK. They were separate hardcoded arrays, so
//    Leif's Growing Yourself Up form slowly fell behind The Living Example's
//    until it was asking four bare questions against LE's five described ones
//    — which is what produced the short, low-information GYU applications.
//
// 2. What gets RECORDED as having been asked.
//    materialize_native_application_responses() stamps every submission from
//    application_form_questions, and application_responses is immutable
//    afterwards. If the registry says something different from the rendered
//    form, every future submission records a question the applicant never saw.
//    That was already true in a small way: the registry stored curly
//    apostrophes while the form rendered straight ones.
//
// This contract pins both. It reads the migration SQL as text rather than
// querying a database, so it runs in the ordinary contracts project with no
// Postgres — the live behaviour is proved separately in
// e2e/applicationQuestionParity.spec.ts against the real thing.

const MIGRATIONS = resolve(import.meta.dirname, "../../supabase/migrations");

const read = (file: string) => readFileSync(resolve(MIGRATIONS, file), "utf8");

/** The question_text values a migration inserts, in position order. */
const insertedQuestions = (sql: string, keyPrefix: string) =>
  [
    ...sql.matchAll(
      new RegExp(
        `\\(v_version, (\\d+), '(${keyPrefix}_[a-z_]+)', '((?:[^']|'')*)'\\)`,
        "g",
      ),
    ),
  ]
    .map((m) => ({
      position: Number(m[1]),
      key: m[2],
      text: m[3].replace(/''/g, "'"),
    }))
    .sort((a, b) => a.position - b.position);

const CORE = read(
  "20261007170000_growing_yourself_up_asks_the_living_example_questions.sql",
);

/**
 * Leif's approved copy, pinned.
 *
 * Sharing one module makes LE and GYU agree with each other by construction,
 * which means a parity test can no longer catch a reworded question — it would
 * reword both identically and still pass. And the registry carries no
 * description column, so the DB comparison below cannot see helper text at
 * all. Measured: changing a helperText failed nothing.
 *
 * So the words themselves are pinned here. This is a copy-approval gate, not a
 * style preference: the questions are Leif's own and are not to be improved
 * without him asking. If a change is deliberate, update this block in the same
 * commit and say so.
 */
const APPROVED = [
  {
    slug: "main_pattern",
    label:
      "What's the main pattern, emotion, or relationship dynamic you're struggling with right now?",
    helperText: "(Be specific—what keeps happening?)",
  },
  {
    slug: "prior_attempts",
    label: "What have you already tried to change or shift this?",
    helperText: "(Working with a therapist, meditation, personal work, etc.)",
  },
  {
    slug: "hoped_change",
    label: "How are you hoping to change through working together?",
    helperText: "(Be as real as possible)",
  },
  {
    slug: "hoped_support",
    label: "How are you hoping I will support you?",
    helperText: "(What does “support” mean to you?)",
  },
  {
    slug: "commitment_scale",
    label:
      "On a scale of 1–10, how committed are you to changing this pattern/way-of-being?",
    helperText: "(Time commitment, financial commitment, personal commitment)",
  },
] as const;

describe("the question asked is the question recorded", () => {
  it("asks Leif's approved words, and only those", () => {
    for (const prefix of ["le", "gyu"] as const) {
      const asked = coreApplicationQuestions(prefix);
      expect(asked, prefix).toHaveLength(APPROVED.length);
      for (const [index, approved] of APPROVED.entries()) {
        expect(asked[index].key, `${prefix} key ${index + 1}`).toBe(
          `${prefix}_${approved.slug}`,
        );
        expect(asked[index].label, `${prefix} wording ${index + 1}`).toBe(
          approved.label,
        );
        expect(
          asked[index].helperText,
          `${prefix} description ${index + 1}`,
        ).toBe(approved.helperText);
        expect(asked[index].required, `${prefix} required ${index + 1}`).toBe(
          true,
        );
      }
    }
  });

  it("every core question is registered for Growing Yourself Up, in order", () => {
    const rendered = coreApplicationQuestions("gyu");
    const registered = insertedQuestions(CORE, "gyu");

    expect(registered).toHaveLength(rendered.length);
    for (const [index, question] of rendered.entries()) {
      expect(registered[index].position, `position ${index + 1}`).toBe(
        index + 1,
      );
      expect(registered[index].key, `key ${index + 1}`).toBe(question.key);
      // Byte-for-byte: the apostrophes, the en dash, all of it.
      expect(registered[index].text, `wording ${index + 1}`).toBe(
        question.label,
      );
    }
  });

  it("The Living Example's registered wording is realigned to what it asks", () => {
    // The migration rewrites LE's current rows so the recorded words match
    // the rendered ones. Asserted against the same shared source the form
    // renders from.
    const rendered = coreApplicationQuestions("le");
    const updates = [
      ...CORE.matchAll(
        /set question_text = '((?:[^']|'')*)'\n\s*where form_version_id = v_le_version and position = (\d+);/g,
      ),
    ]
      .map((m) => ({
        position: Number(m[2]),
        text: m[1].replace(/''/g, "'"),
      }))
      .sort((a, b) => a.position - b.position);

    expect(updates).toHaveLength(rendered.length);
    for (const [index, question] of rendered.entries()) {
      expect(updates[index].position).toBe(index + 1);
      expect(updates[index].text, `LE wording ${index + 1}`).toBe(
        question.label,
      );
    }
  });

  it("the two forms ask the same words, in the same order, differing only by key prefix", () => {
    const le = coreApplicationQuestions("le");
    const gyu = coreApplicationQuestions("gyu");

    expect(gyu).toHaveLength(le.length);
    for (const [index, leQuestion] of le.entries()) {
      expect(gyu[index].label).toBe(leQuestion.label);
      expect(gyu[index].helperText).toBe(leQuestion.helperText);
      expect(gyu[index].required).toBe(leQuestion.required);
      expect(gyu[index].inputType).toBe(leQuestion.inputType);
      expect(gyu[index].key.replace(/^gyu_/, "")).toBe(
        leQuestion.key.replace(/^le_/, ""),
      );
    }
  });

  it("keeps the retired Growing Yourself Up questions out of the current form", () => {
    // Their rows stay in the registry under the demoted version — that is
    // how an old application keeps the wording it was actually asked — but
    // the new version must not re-ask them.
    const registered = insertedQuestions(CORE, "gyu").map((q) => q.key);
    for (const retired of [
      "gyu_biggest_challenge",
      "gyu_why_now",
      "gyu_hoped_outcome",
    ]) {
      expect(registered, retired).not.toContain(retired);
    }
    // gyu_commitment_scale IS reused: the same question, reworded.
    expect(registered).toContain("gyu_commitment_scale");
  });

  it("never rewrites a recorded answer", () => {
    // The one thing this migration must not do. application_responses is the
    // immutable record of what each applicant was asked and said.
    expect(CORE).not.toMatch(/\bupdate\s+(public\.)?application_responses\b/i);
    expect(CORE).not.toMatch(
      /\bdelete\s+from\s+(public\.)?application_responses\b/i,
    );
    expect(CORE).not.toMatch(
      /\binsert\s+into\s+(public\.)?application_responses\b/i,
    );
    // Nor an application's own submitted payload.
    expect(CORE).not.toMatch(/\bset\s+raw_answers\b/i);
    expect(CORE).not.toMatch(/\bset\s+submitted_at\b/i);
  });

  it("creates a new version rather than editing the old one", () => {
    // Prospective-only is the whole mechanism: a new current version, the
    // previous one demoted, its question rows untouched.
    expect(CORE).toMatch(/insert into public\.application_form_versions/);
    expect(CORE).toMatch(/set is_current = false/);
    expect(CORE).not.toMatch(
      /delete\s+from\s+(public\.)?application_form_questions/i,
    );
  });
});
