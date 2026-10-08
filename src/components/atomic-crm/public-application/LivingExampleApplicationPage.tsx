import type { PublicApplicationDataSource } from "./publicApplicationDataSource";
import { PublicApplicationLayout } from "./PublicApplicationLayout";
import { ApplicationUnavailableNotice } from "./ApplicationUnavailableNotice";
import { usePublicOfferContext } from "./usePublicOfferContext";
import { PublicApplicationForm } from "./PublicApplicationForm";
import { NotFoundNotice } from "./NotFoundNotice";
import { coreApplicationQuestions } from "./coreApplicationQuestions";

// Real Living Example / "The Living Example Application" copy (Real LE +
// GYU Application Forms slice, Phase 3; corrected in human-acceptance
// round 1). Wording is Leif's own, preserved exactly for his own visual
// review except where he's explicitly corrected it (round 1: "mediation"
// -> "meditation", Question 4 reworded). Keys are prefixed le_ so they can
// never collide with a Growing Yourself Up key even though the two forms'
// raw_answers live in unrelated rows regardless (Phase 6: "no collisions
// between offer question sets"). Keys stay stable across round 1's
// wording corrections — no unnecessary answer-key churn.
// The core questions, which LE has always asked and which are now shared
// with Growing Yourself Up (coreApplicationQuestions.ts). The "le" prefix
// reproduces this form's existing keys exactly — le_main_pattern and the
// rest — so no stored answer key changes.
//
// Previous rounds of Leif's own corrections are preserved in that module,
// because the strings there were extracted from this file rather than
// retyped: round 1's "mediation" -> "meditation" and reworded Question 4,
// and round 4's decision that the commitment-scale question renders as a
// normal Textarea so an applicant can answer "10 — but I'm scared of the
// money!" and have room for it.
const QUESTIONS = coreApplicationQuestions("le");

// /apply/living-example — the native public application form for the
// individual 1:1 Offer (§2A). The Offer is discovered the same way the
// rest of the app already does (no hardcoded id/name — see
// publicOfferContext.ts), so this page keeps working if the Offer is ever
// renamed or recreated.
export const LivingExampleApplicationPage = ({
  dataSource,
}: {
  dataSource: PublicApplicationDataSource;
}) => {
  const state = usePublicOfferContext(() =>
    dataSource.getLivingExampleContext(),
  );

  // Never an unbounded wait: a failure is a visible, retryable state.
  if (state.status === "loading") return null;
  if (state.status === "failed") {
    return <ApplicationUnavailableNotice onRetry={state.retry} />;
  }
  const context = state.context;
  if (context.kind !== "individual") {
    return (
      <PublicApplicationLayout
        title="Apply"
        orientation="This application isn't available right now."
      >
        <NotFoundNotice />
      </PublicApplicationLayout>
    );
  }

  return (
    <PublicApplicationLayout
      // What this page is FOR, from the applicant's side: a conversation,
      // not a purchase. It deliberately names no programme, no duration
      // and no offer — somebody applying has not chosen one yet, and
      // saying otherwise up front asks them to commit before the chat
      // that decides whether there is anything to commit to.
      title="Apply to Chat with Leif"
      orientation={
        <>
          Take your time and answer as honestly as you can.
          {/* The instruction and the promise are two different thoughts,
              so they get their own lines rather than running together. */}
          <br />
          {/* Only this sentence is italicised: it is the promise about
              what happens next, and it reads as an aside to the
              instruction before it. */}
          <em>
            If it looks like I can help, I’ll invite you to book a free
            30-minute chat so we can explore working together.
          </em>
        </>
      }
      cover
    >
      <PublicApplicationForm
        questions={QUESTIONS}
        onSubmit={async (values) => {
          const result = await dataSource.submitApplication({
            offerId: context.offerId,
            firstName: values.firstName,
            lastName: values.lastName,
            email: values.email,
            // Round 1: phone removed entirely (Leif doesn't want it on
            // either form). Passed as null, not omitted — matches the
            // existing PublicApplicationInput type (`phone?: string |
            // null`) and the Edge Function/RPC's own existing null-safe
            // handling; no backend change needed since phone was already
            // optional/null-capable end to end.
            phone: null,
            answers: values.answers,
          });
          if (result.status === "submitted") return { ok: true };
          if (result.status === "validation-error") {
            return { ok: false, formError: result.message };
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

LivingExampleApplicationPage.path = "/apply/living-example";
