import { useGetList, type Identifier } from "ra-core";

import type { ApplicationResponse } from "../types";
import { ApplicationAnswers } from "./ApplicationAnswers";
import { ApplicationResponses } from "./ApplicationResponses";

// Every logical question, rendered exactly once.
//
// An Application can carry its answers in TWO layers. `application_responses`
// is the materialised one — one row per asked slot, carrying the question's
// own wording — and `raw_answers` is the older native jsonb payload. The page
// rendered BOTH, unconditionally, directly beside each other:
//
//     <ApplicationResponses applicationId={record.id} />
//     <ApplicationAnswers answers={record.raw_answers} />
//
// while the comment above those two lines described the intention correctly —
// raw_answers renders "for Applications that have no materialised responses".
// That condition was never written. So any Application holding both layers
// showed every answer twice. Confirmed in production: Olivia Arms
// (application 211) and Terry Robinson Whitney (204) each have 4 responses
// and the same 4 raw keys — gyu_biggest_challenge, gyu_why_now,
// gyu_hoped_outcome, gyu_commitment_scale.
//
// The rule, by canonical identity and never by displayed text:
//
//   a materialised response is authoritative for its question_key
//   raw_answers renders ONLY the keys no response already covers
//
// Text equality is deliberately not identity. Two genuinely different
// questions may have the same answer — "Yes" twice is two real answers — and
// collapsing them would delete one person's words to tidy a page.
//
// Nothing is dropped. A raw key with no materialised response still renders,
// which is what keeps imported and legacy form versions readable: the
// recovered Notion records and the native public form do not carry the same
// keys, and an Application predating the materialisation has only the jsonb.
export const ApplicationAnswerSections = ({
  applicationId,
  rawAnswers,
  formKey,
}: {
  applicationId: Identifier;
  rawAnswers: Record<string, unknown> | null | undefined;
  /**
   * `applications.form_key`, which decides whether an authoritative wording
   * for this submission exists at all.
   *
   * It is written in exactly one place: materialize_native_application_
   * responses(), in the SAME transaction that writes application_responses.
   * So a non-null form_key means this submission's own question wording is
   * recorded and reachable, and a guessed label is never acceptable for it.
   * Null means no registry wording ever existed — a recovered Notion record,
   * or a native submission whose Offer had no registered form version — and
   * the key-label map is the only thing that can name those questions.
   */
  formKey?: string | null;
}) => {
  const { data: responses, isPending } = useGetList<ApplicationResponse>(
    "application_responses",
    {
      filter: { application_id: applicationId },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "position", order: "ASC" },
    },
  );

  // A VERSIONED submission waits for its own words. Never guesses them.
  //
  // The key-label map (answerLabels.ts) is keyed only by question_key, and a
  // key can outlive the question it asked: gyu_commitment_scale asked "On a
  // scale from 1–10, how ready are you…" under the old Growing Yourself Up
  // form and "On a scale of 1–10, how committed are you…" under the shared
  // set. One map entry cannot be true for both generations. So for an
  // application whose wording IS recorded, the map is not an authority and is
  // not consulted while the recorded wording is still loading — a moment of
  // nothing is better than a moment of the wrong question against somebody's
  // answer.
  //
  // This is deliberately NOT the blanket isPending gate that was here before.
  // That gate hid a person's words: CI caught an imported Application whose
  // answers live ONLY in raw_answers rendering an empty section, because it
  // waited on a query that had nothing to say about it. The branch is the
  // point — versioned submissions wait, raw-only ones never do.
  const versioned = formKey != null && formKey !== "";
  if (versioned && isPending) {
    return <ApplicationResponses applicationId={applicationId} />;
  }

  // While the responses are still unknown, every raw answer renders.
  //
  // This gated on isPending first, and that was wrong in a way local runs
  // could not see: CI caught an imported Application whose answers live ONLY
  // in raw_answers rendering an empty "Application Answers" section, because
  // it was waiting on a query that had nothing to say about it. Hiding a
  // person's words behind a second round trip is a worse failure than
  // briefly showing one of them twice — and the duplicate, when it happens
  // at all, lasts only until the same query the responses already needed
  // resolves.
  //
  // So nothing here can make an answer disappear: an unknown response set
  // covers nothing, and a failed one covers nothing either.
  const covered = new Set(
    (responses ?? [])
      .map((response) => response.question_key)
      .filter((key): key is string => typeof key === "string" && key !== ""),
  );

  const uncovered = Object.fromEntries(
    Object.entries(rawAnswers ?? {}).filter(([key]) => !covered.has(key)),
  );

  return (
    <>
      <ApplicationResponses applicationId={applicationId} />
      <ApplicationAnswers answers={uncovered} />
    </>
  );
};
