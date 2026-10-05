import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { CoreAdminContext } from "ra-core";

import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import { createCrmDb } from "@/test/StoryWrapper";
import { ApplicationAnswerSections } from "./ApplicationAnswerSections";

// Olivia Arms (application 211) and Terry Robinson Whitney (204), as
// production holds them: 4 materialised responses and the SAME 4 raw keys.
// The page rendered both layers unconditionally, so every answer appeared
// twice.
//
// Identity is the question key, never the displayed text. Two different
// questions are allowed to have the same answer.

const APP = 211;

const buildCrm = ({
  responses,
  rawAnswers,
}: {
  responses: Array<{
    position: number;
    question_key: string | null;
    question_text: string;
    answer_text: string | null;
    answered?: boolean;
  }>;
  rawAnswers: Record<string, unknown>;
}) => {
  const dataProvider = createDataProvider({
    db: createCrmDb({
      application_responses: responses.map((response, index) => ({
        id: index + 1,
        application_id: APP,
        answered: response.answered ?? true,
        source_snapshot_id: null,
        materialized_at: "2026-10-01T00:00:00.000Z",
        ...response,
      })),
    } as never),
    silent: true,
    latency: 0,
  });

  return (
    <CoreAdminContext
      dataProvider={dataProvider}
      i18nProvider={testI18nProvider}
    >
      <ApplicationAnswerSections applicationId={APP} rawAnswers={rawAnswers} />
    </CoreAdminContext>
  );
};

const occurrences = (body: string, text: string) => body.split(text).length - 1;

const GYU_RESPONSES = [
  {
    position: 1,
    question_key: "gyu_biggest_challenge",
    question_text: "What is your biggest challenge right now?",
    answer_text: "The long challenge answer.",
  },
  {
    position: 2,
    question_key: "gyu_why_now",
    question_text: "Why are you ready for this now?",
    answer_text: "Because of the timing.",
  },
  {
    position: 3,
    question_key: "gyu_hoped_outcome",
    question_text: "What are you hoping for?",
    answer_text: "More clarity.",
  },
  {
    position: 4,
    question_key: "gyu_commitment_scale",
    question_text: "How ready are you, one to ten?",
    answer_text: "9",
  },
];

const GYU_RAW = {
  gyu_biggest_challenge: "The long challenge answer.",
  gyu_why_now: "Because of the timing.",
  gyu_hoped_outcome: "More clarity.",
  gyu_commitment_scale: "9",
};

describe("an Application carrying both storage layers", () => {
  it("renders each logical question exactly once", async () => {
    const screen = await render(
      buildCrm({ responses: GYU_RESPONSES, rawAnswers: GYU_RAW }),
    );
    await expect
      .element(screen.getByText("What is your biggest challenge right now?"))
      .toBeVisible();

    const body = screen.container.textContent ?? "";
    for (const answer of Object.values(GYU_RAW)) {
      expect(occurrences(body, answer)).toBe(1);
    }
    for (const response of GYU_RESPONSES) {
      expect(occurrences(body, response.question_text)).toBe(1);
    }
  });

  it("still renders a raw key no response covers", async () => {
    // The whole reason this is keyed rather than "drop raw_answers when
    // responses exist": an imported record can carry a field the
    // materialisation never made a slot for, and losing it silently would
    // be worse than the duplicate.
    const screen = await render(
      buildCrm({
        responses: GYU_RESPONSES,
        rawAnswers: { ...GYU_RAW, referral_source: "A friend told me" },
      }),
    );
    await expect.element(screen.getByText("A friend told me")).toBeVisible();

    const body = screen.container.textContent ?? "";
    expect(occurrences(body, "A friend told me")).toBe(1);
    expect(occurrences(body, "More clarity.")).toBe(1);
  });

  it("keeps the same answer twice when it belongs to two real questions", async () => {
    // Text equality is not identity. Collapsing these would delete one of
    // this person's two answers to tidy the page.
    const screen = await render(
      buildCrm({
        responses: [
          {
            position: 1,
            question_key: "gyu_why_now",
            question_text: "Why are you ready for this now?",
            answer_text: "Yes",
          },
          {
            position: 2,
            question_key: "gyu_commitment_scale",
            question_text: "Are you able to commit to every session?",
            answer_text: "Yes",
          },
        ],
        rawAnswers: {},
      }),
    );
    await expect
      .element(screen.getByText("Why are you ready for this now?"))
      .toBeVisible();

    const body = screen.container.textContent ?? "";
    expect(occurrences(body, "Yes")).toBe(2);
  });
});

describe("an Application with only one layer", () => {
  it("renders a legacy raw-only Application in full", async () => {
    const screen = await render(
      buildCrm({
        responses: [],
        rawAnswers: {
          why_this_program: "The older native payload.",
          gyu_why_now: "Still readable.",
        },
      }),
    );
    await expect
      .element(screen.getByText("The older native payload."))
      .toBeVisible();

    const body = screen.container.textContent ?? "";
    expect(occurrences(body, "The older native payload.")).toBe(1);
    expect(occurrences(body, "Still readable.")).toBe(1);
  });

  it("renders a materialised-only Application in full", async () => {
    const screen = await render(
      buildCrm({ responses: GYU_RESPONSES, rawAnswers: {} }),
    );
    await expect.element(screen.getByText("More clarity.")).toBeVisible();

    const body = screen.container.textContent ?? "";
    for (const response of GYU_RESPONSES) {
      expect(occurrences(body, response.answer_text!)).toBe(1);
    }
  });

  it("keeps an asked-but-blank response visible rather than empty", async () => {
    const screen = await render(
      buildCrm({
        responses: [
          {
            position: 1,
            question_key: "gyu_why_now",
            question_text: "Why are you ready for this now?",
            answer_text: null,
            answered: false,
          },
        ],
        rawAnswers: {},
      }),
    );
    await expect.element(screen.getByText("No answer given")).toBeVisible();
  });
});
