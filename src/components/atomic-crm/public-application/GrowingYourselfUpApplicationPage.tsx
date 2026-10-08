import { useParams } from "react-router";

import type { PublicApplicationDataSource } from "./publicApplicationDataSource";
import type { PublicOfferContext } from "./publicOfferContext";
import { PublicApplicationLayout } from "./PublicApplicationLayout";
import { ApplicationUnavailableNotice } from "./ApplicationUnavailableNotice";
import { usePublicOfferContext } from "./usePublicOfferContext";
import { PublicApplicationForm } from "./PublicApplicationForm";
import { NotFoundNotice } from "./NotFoundNotice";
import { coreApplicationQuestions } from "./coreApplicationQuestions";

// Real Growing Yourself Up Application copy (Real LE + GYU Application
// Forms slice, Phase 4; corrected in human-acceptance round 1). Wording is
// Leif's own; round 1 corrected "your facing" -> "you're facing" and "with
// program with Leif" -> "this program with Leif", and asked for "now" to
// render in italics within Question 2's otherwise-unchanged text (plain
// <em>, not raw HTML — see PublicApplicationForm.tsx's ApplicationQuestion
// type). Keys are prefixed gyu_ so they can never collide with a Living
// Example key (Phase 6: "no collisions between offer question sets") and
// stay stable across round 1's wording corrections — no unnecessary
// answer-key churn.
// The core questions, now shared with The Living Example
// (coreApplicationQuestions.ts).
//
// This form used to ask four bare questions of its own with no descriptions
// under them, and it produced short, low-information applications while LE's
// five described questions produced much richer ones. Leif's decision: ask
// LE's questions, exactly.
//
// GYU IS STILL GYU. The "gyu" prefix keeps the keys offer-namespaced, and
// everything around the questions — the cohort route, intended_cohort_id,
// the destination, the decision workflow, Kit, the cohort-specific Copy
// Application Link — is untouched. What is shared is the question set, not
// the programme.
//
// The four retired keys (gyu_biggest_challenge, gyu_why_now,
// gyu_hoped_outcome) keep their historical answers and their own snapshotted
// wording in application_responses; nothing rewrites them. gyu_commitment_scale
// is reused, because it is the same question reworded — which is how round 1's
// wording corrections were handled too.
const QUESTIONS = coreApplicationQuestions("gyu");

// /apply/growing-yourself-up/:cohortId — route-driven Cohort context
// (§2B): a new Cohort never needs a new hardcoded page, only a new row.
// The Cohort's own numeric id is the route param — it isn't sensitive
// (a sequential identifier for an offering, not personal data) and
// reusing it avoids inventing a separate public-slug schema field beyond
// what §1 calls "the smallest durable schema change needed" (none, here).
export const GrowingYourselfUpApplicationPage = ({
  dataSource,
}: {
  dataSource: PublicApplicationDataSource;
}) => {
  const { cohortId } = useParams();
  // A link with no cohort in it is a bad link, not a failure to load —
  // the same "not-found" answer the effect gave before, kept so the page
  // still explains itself rather than offering a pointless retry.
  const state = usePublicOfferContext(() =>
    cohortId
      ? dataSource.getGroupCohortContext(cohortId)
      : Promise.resolve({ kind: "not-found" } as PublicOfferContext),
  );

  // Never an unbounded wait: a failure is a visible, retryable state.
  if (state.status === "loading") return null;
  if (state.status === "failed") {
    return <ApplicationUnavailableNotice onRetry={state.retry} />;
  }
  const context = state.context;

  if (context.kind === "not-found") {
    return (
      <PublicApplicationLayout
        title="Apply"
        orientation="This application isn't available right now."
      >
        <NotFoundNotice />
      </PublicApplicationLayout>
    );
  }

  if (context.kind === "group-closed") {
    return (
      <PublicApplicationLayout
        title={context.offerName}
        orientation={`Applications for this cohort are closed.`}
      >
        <NotFoundNotice message="Applications for this cohort aren't open right now. Please check back later, or reach out if you'd like to be considered for a future cohort." />
      </PublicApplicationLayout>
    );
  }

  if (context.kind !== "group-open") return null;

  return (
    <PublicApplicationLayout
      title="Growing Yourself Up Application"
      orientation={
        <>
          Take your time and answer as honestly as you can.
          <br />
          This helps me get a sense of where you’re looking for support and if
          Growing Yourself Up is the right fit!
        </>
      }
      cover
    >
      <PublicApplicationForm
        questions={QUESTIONS}
        onSubmit={async (values) => {
          const result = await dataSource.submitApplication({
            offerId: context.offerId,
            cohortId: context.cohortId,
            firstName: values.firstName,
            lastName: values.lastName,
            email: values.email,
            // Round 1: phone removed entirely — see LivingExampleApplicationPage.tsx's
            // identical comment for why this needs no backend change.
            phone: null,
            answers: values.answers,
          });
          if (result.status === "submitted") return { ok: true };
          if (result.status === "validation-error") {
            return { ok: false, formError: result.message };
          }
          if (result.status === "cohort-closed") {
            return {
              ok: false,
              formError: "Applications for this cohort just closed.",
            };
          }
          return {
            ok: false,
            formError: "This application isn't available right now.",
          };
        }}
      />
    </PublicApplicationLayout>
  );
};

GrowingYourselfUpApplicationPage.path = "/apply/growing-yourself-up/:cohortId";
