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
}: {
  applicationId: Identifier;
  rawAnswers: Record<string, unknown> | null | undefined;
}) => {
  const { data: responses, isPending } = useGetList<ApplicationResponse>(
    "application_responses",
    {
      filter: { application_id: applicationId },
      pagination: { page: 1, perPage: 100 },
      sort: { field: "position", order: "ASC" },
    },
  );

  // Until the responses are known, rendering raw_answers would show the
  // duplicate for a moment and then remove it. Waiting is the honest
  // version of the same page.
  if (isPending) return null;

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
