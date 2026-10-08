import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { CoreAdminContext } from "ra-core";

import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import { createCrmDb } from "@/test/StoryWrapper";
import { ApplicationAnswerSections } from "./ApplicationAnswerSections";
import { coreApplicationQuestions } from "../public-application/coreApplicationQuestions";

// WHERE A QUESTION'S WORDING IS ALLOWED TO COME FROM.
//
// application_responses.question_text is the words snapshotted at submission,
// immutable afterwards. answerLabels.ts is a map keyed only by question_key —
// and a key can outlive the question it asked: gyu_commitment_scale asked "On
// a scale from 1–10, how ready are you…" under the old Growing Yourself Up
// form and "On a scale of 1–10, how committed are you…" under the shared set.
// One entry cannot be true for both generations, so the map is a compatibility
// path, never an authority.
//
// The discriminator is applications.form_key, which
// materialize_native_application_responses() writes in the SAME transaction
// as the responses. Non-null means this submission's own wording is recorded
// and reachable; null means none was ever registered (a recovered Notion
// record, or a native submission whose Offer had no form version) and the map
// is all there is.
//
// So: a versioned submission WAITS for its own words. A raw-only one never
// does — that gate used to be unconditional and it hid a person's answers
// behind a query that had nothing to say about them.
//
// The slow window is reproduced with a provider that never answers for
// application_responses, so none of this is race-dependent.

const APP = 4242;

const NEW_GYU = coreApplicationQuestions("gyu");

const OLD_GYU_RESPONSES = [
  {
    position: 1,
    question_key: "gyu_biggest_challenge",
    question_text:
      "What's the biggest challenge you're facing in your personal growth and healing?",
    answer_text: "Old answer one",
  },
  {
    position: 2,
    question_key: "gyu_why_now",
    question_text: "Why are you ready for support and change now?",
    answer_text: "Old answer two",
  },
  {
    position: 3,
    question_key: "gyu_hoped_outcome",
    question_text:
      "What are you hoping this program with Leif helps you create in your life and relationships?",
    answer_text: "Old answer three",
  },
  {
    position: 4,
    question_key: "gyu_commitment_scale",
    question_text:
      "On a scale from 1–10, how ready are you to make a time, financial, and personal commitment to the change you want?",
    answer_text: "Old answer four",
  },
];

const NEW_GYU_RESPONSES = NEW_GYU.map((question, index) => ({
  position: index + 1,
  question_key: question.key,
  question_text: String(question.label),
  answer_text: `New answer ${index + 1}`,
}));

type Response = (typeof OLD_GYU_RESPONSES)[number];

const buildProvider = (responses: Response[]) =>
  createDataProvider({
    db: createCrmDb({
      application_responses: responses.map((response, index) => ({
        id: index + 1,
        application_id: APP,
        answered: response.answer_text != null,
        source_snapshot_id: null,
        materialized_at: "2026-10-01T00:00:00.000Z",
        ...response,
      })),
    } as never),
    silent: true,
    latency: 0,
  });

/** The same provider, but application_responses never comes back. */
const neverAnswering = (base: ReturnType<typeof buildProvider>) => ({
  ...base,
  getList: async (resource: string, params: never) =>
    resource === "application_responses"
      ? (new Promise(() => {}) as never)
      : base.getList(resource, params),
});

const renderSections = async ({
  provider,
  rawAnswers,
  formKey,
}: {
  provider: unknown;
  rawAnswers: Record<string, unknown>;
  formKey: string | null;
}) =>
  render(
    <CoreAdminContext
      dataProvider={provider as never}
      i18nProvider={testI18nProvider}
    >
      <ApplicationAnswerSections
        applicationId={APP}
        rawAnswers={rawAnswers}
        formKey={formKey}
      />
    </CoreAdminContext>,
  );

const bodyText = () => document.body.innerText.replace(/\s+/g, " ");

describe("a versioned submission never shows a guessed question", () => {
  it("a NEW Growing Yourself Up application shows no humanised key while its words load", async () => {
    // The defect this closes: the four new keys are absent from
    // answerLabels.ts (deliberately — they can only ever exist on a versioned
    // submission), so the map would have rendered "Gyu Main Pattern" against
    // somebody's answer until the responses query returned.
    const rawAnswers = Object.fromEntries(
      NEW_GYU.map((question, index) => [
        question.key,
        `New answer ${index + 1}`,
      ]),
    );
    await renderSections({
      provider: neverAnswering(buildProvider(NEW_GYU_RESPONSES)),
      rawAnswers,
      formKey: "gyu_application_core",
    });

    const body = bodyText();
    for (const humanised of [
      "Gyu Main Pattern",
      "Gyu Prior Attempts",
      "Gyu Hoped Change",
      "Gyu Hoped Support",
    ]) {
      expect(body, humanised).not.toContain(humanised);
    }
    // And not the superseded commitment wording, which the map still holds
    // for the old generation.
    expect(body).not.toContain("On a scale from 1–10");
  });

  it("the same application shows its recorded words once they arrive", async () => {
    const rawAnswers = Object.fromEntries(
      NEW_GYU.map((question, index) => [
        question.key,
        `New answer ${index + 1}`,
      ]),
    );
    const screen = await renderSections({
      provider: buildProvider(NEW_GYU_RESPONSES),
      rawAnswers,
      formKey: "gyu_application_core",
    });

    await expect.element(screen.getByText("New answer 1")).toBeVisible();
    const body = bodyText();
    for (const question of NEW_GYU) {
      expect(body, question.key).toContain(String(question.label));
    }
    // Each answer exactly once: the raw layer must not double up on the
    // recorded one.
    for (let index = 1; index <= NEW_GYU.length; index += 1) {
      expect(body.split(`New answer ${index}`).length - 1).toBe(1);
    }
  });

  it("an OLD four-question application is never relabelled with the new wording", async () => {
    // Its key gyu_commitment_scale is reused by the shared set. While its own
    // words load, nothing may stand in for them — least of all the newer
    // question that shares the key.
    const rawAnswers = {
      gyu_biggest_challenge: "Old answer one",
      gyu_why_now: "Old answer two",
      gyu_hoped_outcome: "Old answer three",
      gyu_commitment_scale: "Old answer four",
    };
    await renderSections({
      provider: neverAnswering(buildProvider(OLD_GYU_RESPONSES)),
      rawAnswers,
      formKey: "gyu_application",
    });

    expect(bodyText()).not.toContain("On a scale of 1–10");
  });

  it("the OLD application then shows exactly its own four snapshotted questions", async () => {
    const rawAnswers = {
      gyu_biggest_challenge: "Old answer one",
      gyu_why_now: "Old answer two",
      gyu_hoped_outcome: "Old answer three",
      gyu_commitment_scale: "Old answer four",
    };
    const screen = await renderSections({
      provider: buildProvider(OLD_GYU_RESPONSES),
      rawAnswers,
      formKey: "gyu_application",
    });

    await expect.element(screen.getByText("Old answer one")).toBeVisible();
    const body = bodyText();
    for (const response of OLD_GYU_RESPONSES) {
      expect(body, response.question_key!).toContain(response.question_text);
      expect(body.split(response.answer_text!).length - 1).toBe(1);
    }
    // None of the shared set is injected into a submission that never saw it.
    for (const question of NEW_GYU) {
      if (question.key === "gyu_commitment_scale") continue;
      expect(body, question.key).not.toContain(String(question.label));
    }
    expect(body).not.toContain("On a scale of 1–10");
  });
});

describe("a raw-only submission still reads", () => {
  it("renders its labels immediately, with no recorded wording to wait for", async () => {
    // form_key null: a recovered record, or a native one whose Offer had no
    // registered form version. There is no authority to wait for, and waiting
    // is what once hid an imported applicant's words behind an empty section.
    const screen = await renderSections({
      provider: neverAnswering(buildProvider([])),
      rawAnswers: {
        why_this_program: "I have children — the biggest mirror.",
        gyu_biggest_challenge: "A legacy answer.",
      },
      formKey: null,
    });

    await expect
      .element(screen.getByText("I have children — the biggest mirror."))
      .toBeVisible();

    const body = bodyText();
    // Real questions, not raw keys.
    expect(body).toContain("Why this program?");
    expect(body).not.toContain("why_this_program");
    // And the legacy key keeps the wording that generation was asked.
    expect(body).toContain(
      "What's the biggest challenge you're facing in your personal growth and healing?",
    );
  });
});
