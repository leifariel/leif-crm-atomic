# HANDOFF — where Atomic CRM is right now

**Current state, not history.** [MEMORY.md](MEMORY.md) is the durable knowledge
ledger — why each sealed slice decided what it decided. This file is the other
half: what is true today, where the rules live in code, and what is waiting.

Written 2026-09-20 at `451f0af0`, updated 2026-09-26 at the cross-offer
transfer checkpoint. **The repository, the database and production are the
authority. Where this prose disagrees with them, they win — say so rather than
quietly picking one.**

**Where things stand right now (2026-09-27).** `origin/main` is at
`1c1ef676`, production holds 142 migrations, and **Jenna Smith's repair is
human-accepted** (§8b-next). The lightbox UX pass is deployed, with **one
branch human-accepted and two still open** (§8b-ux). One commit sits locally and
is **not pushed**: the `legacy_untracked` fix that deployment verification
found (§8b-ux-fix). The Application Form Builder is restored to the working
tree, still uncommitted.

**The next action is Leif's: push the legacy_untracked fix — and until it is
deployed, do not click Repair on any client.** Then the queue is the client
start-week / capacity UX, Kit, and only then the builder. The Kit requirement
that Applications cannot be called finished without is §8b-kit.

---

## 1. Principles

**RIGOR #1.** Prove it, or say you have not.

**ATOMIC HANDLES CERTAINTY. LEIF HANDLES AMBIGUITY.**

- Deterministic automation may act on its own. Exact provider identity, exact
  normalized email, arithmetic on stored facts — these are certainties, and the
  CRM is allowed to write them.
- Genuine ambiguity escalates. Two defensible readings of the same evidence is
  Leif's decision, not a default. Daniel Alexander's $500 was either a deposit
  or a separate payment, and the CRM refused both readings until he said.
- **Never fabricate business truth to clean up the UI.** A warning that is
  materially true stays visible. "Mark reviewed" may not silence a missing fact.
  An absent value is recorded as absent — four Contacts hold `first_seen = NULL`
  because nothing truthful is known, and that is the correct state.
- **Tasks are projections, not truth.** A Task points at a business fact and
  says what needs doing. Deleting one must never delete the condition; the
  condition recreates it while it still holds. And the converse, learned the
  hard way: **a fact is not a Task.** A Task means Leif has something to do, so
  an appointment that merely exists is not one — see §4's accepted task
  semantics.

---

## 2. Engineering framework

Rigor first, without perfection paralysis.

### The acceptance loop — the governing rule

**A feature is not complete until Leif has actually used it.** Every meaningful
feature runs this loop, in order:

1. **Build.**
2. **Automated proof** — unit, integration, contract.
3. **Deploy to a usable environment.**
4. **LEIF HUMAN TRY-RUN, while the feature is still OPEN.**
5. **Repair** anything confusing, incorrect or operationally incoherent.
6. **Repeat the try-run** as needed.
7. **Only then ACCEPT / SEAL.**
8. **Post-deploy smoke verifies deployment identity and critical invariants.**
   It is *not* the first time product behavior is discovered.

> **No large batch of hidden work between human acceptance points.**

A feature is **not** complete merely because unit and integration tests pass,
migrations replay, or Claude reports internal consistency. Those establish that
the code does what it was written to do. They cannot establish that what it was
written to do is what Leif needs — and for important workflows, that gap is
where the real defects live.

This rule was written after the Acuity booking regression (§5), where every
test was green, every migration replayed, the reports were internally
consistent, and four real bookings still reached the Dashboard asking what had
happened on calls five weeks away. **One session of ordinary human use found
three distinct defects** — the false attendance question, the matching Task
that would not close, and the appointment Tasks cluttering Later — **and no
automated check in the repository was positioned to see any of them.**

The corollary: keep the batch between acceptance points small. A workflow Leif
has not exercised is not evidence of anything, however much of it there is.

### Supporting rules

- A substantial feature closes by proving a real operational workflow end to
  end, not by counting unit tests.
- **Every critical schema migration must identify and exercise ALL supported
  production write paths touching the changed schema.** This rule exists
  because of §5's `scheduled_on` regression.
- **A rule hand-mirrored into a second runtime will drift, and nothing will
  tell you.** The Acuity Edge Function runs on Deno and cannot import from
  `src/`, so its copy of a task type silently outlived the migration that split
  it. Where a rule must exist twice, the database holds the authority and
  reconciles both directions on a schedule — see §4's Tasks section.
- Critical workflows get contract / end-to-end coverage.
- Production errors should surface on their own rather than waiting for Leif to
  trip over them.
- High-risk operations get a small post-deploy canary or smoke.
- Truth-breaking and workflow defects are fixed immediately. Cosmetic UX is
  bundled into small cleanup passes.
- After Gmail and Instagram, run a dedicated maturity/stabilization sprint
  before any larger feature.

**Intended sequence:** (1) finish current small workflow UX loose ends →
(2) ~~tight reliability layer~~ **SEALED 2026-09-21, see §8** →
(3) ~~Capacity + Waitlist~~ **SEALED 2026-09-24, see §8** →
(4) ~~the sale repair~~ **SEALED 2026-09-25, see §5** →
(5) ~~post-Won payment setup~~ **COMMITTED 2026-09-26 at `b12fb3b8`,
awaiting deployment + acceptance, see §8b** →
(5b) **Jenna Smith cross-offer conversion, then the Dashboard sales-call
resolution lightbox — CURRENT, see §8b-next** →
(6) Waitlist quick-create, then Applications cleanup — see §8c →
(7) Gmail → (8) Gmail production acceptance → (9) Instagram/Meta →
(10) Instagram production acceptance → (11) accumulated UX + maturity
sprint → (12) Openings Planner.

Capacity + Waitlist moved ahead of Gmail deliberately: Gmail will want to say
something true about openings, and neither the Living Example capacity maths
nor the waitlist was operational yet. Build the truth before the thing that
announces it. That truth now exists, and §8c carries the two waitlist and
applications gaps the try-run exposed — both of which Gmail will also lean
on — ahead of Gmail for the same reason.

Post-Won payment setup jumped ahead of both: Becky is a real client, sold
and unpaid, and the CRM currently has no action that can take her money.

---

## 3. Production state

| | |
|---|---|
| repo | `git@github.com:leifariel/leif-crm-atomic.git`, branch `main` |
| HEAD | `71c3de94` on `origin/main`; **two local commits not yet pushed** — `41182451`, `052c22dd`, both migration repairs made during the deployment below |
| frontend | Vercel project `leif-ariel/leif-crm` → **crm.leifariel.com** |
| database | Supabase `xlyywsguftyvomeretju` ("leif-crm", us-west-2) |
| migrations | **136** local files, **0 pending on MAIN**, 0 remote-only |
| boundary | **112 deterministic + 24 MAIN-only** (`node scripts/historical-import/replayBoundary.mjs` exits 0) |
| CI | `✅ Check` **green** on the real runner at `71c3de94`. `🚀 Deploy` red in `demo` and `supabase`, identically to `f64d986a` before it — pre-existing, see below |

**The `Deploy (supabase)` job blocks Edge Function deployment.** It fails at
*Push supabase migrations*, and *Deploy supabase functions* runs after it in
the same job — so no function has shipped from CI since that job started
failing. Migrations reach MAIN by hand (`npx supabase db push`), so the gap
is invisible until a function changes. It did:
`sync_year_planning_calendar` was deployed on 2026-09-20 and the Capacity
slice rewrote it on 2026-09-21, replacing append-only assignment with a
rebuild and adding the JWT path Sync Calendar needs. Deployed by hand on
2026-09-22 (version 15). **Check this job before believing any Edge Function
change is live.**

**Two independent deploy paths, and confusing them costs a slice.** Vercel
builds the frontend on push to `main`. **Supabase Edge Functions deploy from
the GitHub Actions `deploy-supabase` job** (`npx supabase functions deploy`) —
*not* from Vercel.

**Prove a deploy by comparison, not by inference.** Both halves can be shown
exactly, and grepping for a hopeful string is the weaker version of each:

- *Frontend.* Fetch `/sw.js` from the live host — its precache manifest lists
  every asset — then fetch those chunks and diff them against a local
  `npm run build` of the deployed commit. They are byte-identical **except**
  the `BUILD_ID` timestamp `vite.config.ts` stamps in, and the content hashes
  that one timestamp cascades into. Normalise those two values and the
  comparison is exact. (Kanban/Decision/Ghosted code lives in a lazily-loaded
  `DealList-*.js` chunk, so absence from the entry bundle is code-splitting,
  not a failed deploy.)
- *Edge Functions.* `npx supabase functions list --project-ref <ref>` gives the
  live version and `updated_at`; an `entrypoint_path` under
  `/home/runner/work/...` proves it came from a GitHub Actions runner rather
  than someone's laptop. Then `npx supabase functions download <slug>
  --project-ref <ref>` retrieves the **deployed source**, which you diff
  against the repo. Only the modules a function imports are bundled, so
  unrelated `_shared/` files missing from the download are not drift.

### Integrity baseline (read-only, 2026-09-20 at `451f0af0`)

These must all be **0**. They are the invariants; the counts below them drift
as Leif works.

`broken_contact_fks` · `app_opportunity_mismatches` ·
`duplicate_structured_identities` · `duplicate_paid_intents` ·
`duplicate_plan_objects` · `task_completion_disagreements` ·
`enrollments_missing_onboarding` · `active_stage_contradictions` ·
`scheduled_on_disagreements` · `tasks_with_iso_dates` ·
`backfill_prompt_eligible` · `stranded_unmatched_calls`

Three joined them with the Acuity seal, and they are the ones that would have
caught that regression:

`wrong_question_tasks` — no open sales-call Task asks a question its own
booking does not pose · `open_appointment_tasks` — no Task exists merely
because an appointment does · `future_attendance_tasks` — nothing asks what
happened on a call that has not happened.

At time of writing: 310 Contacts · 161 Applications / 832 responses ·
**157 Opportunities** (44 active: 34 call_booked, 9 decision, 1
application_received) · 32 Won · 33 Enrollments (25 active) · **200 Sales
Calls** · **5 open Tasks** (1 follow-up, 4 onboarding) · 127 Stripe relations
(plan objects + customers) · 0 external identities · **$71,648.00** collected ·
4 open payment reviews · **28 unmatched Acuity calls, all historical, none in
the future, none awaiting triage**.

The Opportunity count rose by three and open Tasks fell from twelve during
Leif's try-run of the matching workflow — that is the workflow working, not
drift.

---

## 4. Domain invariants, and where they live

### Contact / identity
A Contact is a **person**, separate from Opportunity, Application, Enrollment
and Task. External identities are provider-neutral:
`contact_external_identities` with an **immutable `external_user_id`** (NOT
NULL) as identity, a **mutable `display_identifier`** (nullable) as search
metadata only, and provider-account scoping via two partial unique indexes.
**A handle is never identity** — a rename keeps one person; the same handle on
two provider accounts stays two people.

Matching is deterministic only: exact provider identity, or an exact normalized
email naming exactly **one** Contact. `record_external_identity()` answers
known / linked_by_email / ambiguous / unresolved, and never merges, never
matches on a name or handle, never creates an Opportunity.

`merge_contacts_safely()` repoints ten child tables explicitly and **never
deletes** — the source keeps its row plus `merged_into_contact_id`. It refuses
while `contact_merge_conflicts()` reports anything unacknowledged, and combines
no Opportunity, Enrollment or payment.

**Contact deletion and merge remain disabled in the app** —
[contactSafety.ts](src/components/atomic-crm/contacts/contactSafety.ts),
`CONTACT_DELETE_ENABLED` / `CONTACT_MERGE_ENABLED` both `false`.

Display name: [contactDisplayName.ts](src/components/atomic-crm/contacts/contactDisplayName.ts)
— returns `null` rather than inventing a name (33 people have only one name).

### Applications
**Applications are not complete work yet — see §8b-kit.** Everything below
stops at the CRM's boundary; the applicant's email still reaches them because
Leif syncs them into Kit and tags them by hand.

One Application links to an Opportunity **only when deterministic**. Exact
question wording and exact answer are preserved per response
(`application_responses`, 832 rows, immutable). Review queue is
`applications_awaiting_review`; the SLA is **3 calendar days in America/Denver**
— [applicationReviewSla.ts](src/components/atomic-crm/applications/applicationReviewSla.ts).
**99 historical pending Applications are not a review backlog** — only
genuinely actionable ones surface.

**The Applications page is grouped by Programme/Cohort first**, then by what
each record needs: Needs Review, Reviewed, Pre-CRM — Active Sales,
Historical — [classifyApplication.ts](src/components/atomic-crm/applications/classifyApplication.ts).
Reviewed means `reviewed_at IS NOT NULL`; an imported decision with a null
timestamp stays a historical fact and is never promoted. Programme and person
come from the Application's **own** `offer_id` / `intended_cohort_id` /
`contact_id` — the Opportunity is context, never identity, so an Application
with `opportunity_id` NULL neither disappears from the list nor renders a
blank Show page.

**Three origins:** `public_form`, `historical_import`, `manual`. A manual
Application is one Leif entered herself; it borrows neither other name,
carries no questionnaire answers, and starts pending.

**A current-funnel Application entails an Opportunity.** Creating one by hand
writes the Application and its canonical `application_received` Opportunity in
**one transaction** (`create_manual_application()`), because every review
outcome writes to both. `entry_path` is `'other'` — no public form produced
it. Reuse of a live Opportunity is allowed only up to `approved`; at
`call_booked`, `decision`, legacy `onboarding` or any unknown stage the create
is **refused** and the live sale is shown instead, because approving would
otherwise drag the sale backward. A concluded prior sale correctly begins a
new cycle. Pinned across runtimes by
[oneReviewableStageRule.test.ts](contracts/applications/oneReviewableStageRule.test.ts).

### Opportunities / sales
**One Opportunity per sales attempt.** Active means `archived_at IS NULL AND
stage <> 'won' AND outcome IS NULL` — [dealActivity.ts](src/components/atomic-crm/deals/dealActivity.ts).
Stage order: interested → application_received → approved → call_booked →
decision → won. **Later authoritative human truth supersedes earlier process
facts**, never the reverse.

### Sales calls
- **A legitimate linked Sales Call proves the Opportunity reached
  `call_booked`** — booked, completed, attended, missed or cancelled all
  require that somebody booked it first. A missing stage-event row is not
  evidence the stage never happened.
  [callProvesCallBooked.ts](src/components/atomic-crm/deals/callProvesCallBooked.ts)
  states this and refuses to drag a Decision/Won/terminal Opportunity backwards.
- **Cancellation and no-show never demote to `approved`.** They are factual
  call states. The open question ("what next?") is *derived* —
  [needsNextSalesStep.ts](src/components/atomic-crm/deals/needsNextSalesStep.ts)
  — from active + latest call cancelled/no-show + nothing booked since, so it
  cannot be deleted, only resolved.
- **Exiting an Opportunity is always an explicit human action.**
- **Historical backfill:** a past-dated call is created with
  `resolution_requested_at` set, which produces the single "what happened on
  this call?" question rather than inventing attendance. A future-dated call
  keeps ordinary booked semantics.
  [bookSalesCall.ts](src/components/atomic-crm/sales-calls/bookSalesCall.ts).
- **`scheduled_on` is derived centrally**, in America/Denver, by trigger
  `derive_sales_call_scheduled_on` (migration `20260920020000`). Callers state
  the instant; the calendar day is not their job.
- **All call-creation write paths must be exercised after any schema change** —
  the app (`bookSalesCall.ts`) and the Acuity webhook
  (`supabase/functions/acuity_webhook/acuitySalesCallHandlers.ts`).
- **A booking creates no Task for itself**, and an unattributable one asks
  *whose it is*, never *what happened*. See the Tasks section below — that
  distinction is the accepted semantics, not an implementation detail.

### Decision column
Ordering, one canonical comparator —
[pipelineOrdering.ts](src/components/atomic-crm/deals/pipelineOrdering.ts):

1. **overdue** follow-up — oldest due first
2. **due today**
3. **no follow-up scheduled** — longest in Decision first
4. **upcoming** follow-up — soonest first

Band 3 above band 4 is deliberate: a future follow-up means the attempt already
has a next action; none means nobody has chosen one. Subtitle reads **"Needs
action first"**. Only `deals.follow_up_date` is read — the follow-up Task
projects it, so no Task can influence order. Days compare in America/Denver.

**Ghosted is explicit and distinct from No.** Its own button, its own dialog,
never inferred from elapsed time or a missed call. Stores
`outcome='lost'` + `exit_reason='ghosted'` + `prospect_decision='ghosted'` plus
a Contact tag — [pipelineExit.ts](src/components/atomic-crm/deals/pipelineExit.ts),
[removeFromPipeline.ts](src/components/atomic-crm/deals/removeFromPipeline.ts).
No's reason list is narrowed to what a prospect can actually say.

### Tasks — ACCEPTED SEMANTICS (sealed 2026-09-20, human try-run passed)

**A Task means Leif has something to do.** That sentence settles every question
this section used to get wrong.

| concept | what it is |
|---|---|
| **Sales Call** | A **factual appointment** — scheduled or occurred. **Never itself a Task.** |
| **Matching Task** (`sales_call_needs_matching`) | *Which Opportunity owns this booking?* |
| **Attendance-resolution Task** (`resolve_sales_call`) | *What happened on this **past** call?* |
| **Follow-up Task** (`follow_up`) | An actual future action Leif promised. |

The rules, all now enforced rather than remembered:

- **A future appointment alone never appears in Tasks.** A booked call is
  carried by the Call Booked stage, `deals.sales_call_at`, the Opportunity's own
  Sales Call section and the calendar. The `sales_call` type is **retired** —
  nothing creates one, and the reconciler closes any that appear.
- **Deterministic Acuity ownership auto-links.** Exact normalized email for the
  Contact, the effective-dated appointment-type map for the Offer/Cohort, and
  exactly **one** compatible active Opportunity → attach, advance Approved →
  Call Booked, ask nothing.
- **Zero or multiple compatible Opportunities require explicit human matching.**
  Both are escalations; neither is guessed. Creating a new sales attempt from a
  booking is a human action on `/sales-calls/:id/resolve` — **Acuity never
  creates an Opportunity and never reopens a terminal one.**
- **Completing a match closes the matching Task**, by whatever route the
  Opportunity got attached — the resolution page, a backfill, a hand-written
  UPDATE. A database trigger and the reconciler both enforce it.
- **No open Task may route to a state that says it is already resolved.** That
  is an invariant violation, not a cosmetic one.
- Attendance is **never** derived from `attendance IS NULL`. It is asked only
  when somebody deliberately set `sales_calls.resolution_requested_at` **and**
  the scheduled time has passed. 109 imported calls have no attendance because
  their result was recorded as pipeline stage; they are not open questions.

**Where the rule lives.** `public.sales_call_open_question()` returns
`matching` / `attendance` / `none` and is the authority.
`public.reconcile_sales_call_tasks()` enforces it **in both directions** —
refile a Task filed under the wrong question, close one whose question has been
answered, create one whose question is open — hourly via cron
`reconcile-sales-call-tasks`, for every writer including ones that never run
app code. [salesCallTaskTypes.ts](src/components/atomic-crm/sales-calls/salesCallTaskTypes.ts)
mirrors it app-side, the way `isActiveDeal` mirrors `deal_is_active`.
Migration `20260920100000`.

It deliberately **creates no matching Task wholesale**: 28 calls have no
Opportunity, nearly all pre-CRM history, and manufacturing 28 alerts would
invent a backlog — the same trap `20260919050000` avoided with Applications.
A matching Task is created by the flow that notices the ambiguity: a live
booking arriving unattributable.

Other live types: `review_application`, `onboarding_item`, `offboarding_item`,
`resolve_client_session_cadence`, `other`. Retired and readable but never
created: `sales_call`, `nurture_follow_up`, `sales_call_cancelled`,
`sales_call_no_show`, `check_payment`. The complete inventory — what each row
asks, what closes it, where it routes, what verb it offers — is
[needsAttentionInventory.ts](src/components/atomic-crm/tasks/needsAttentionInventory.ts),
and the Dashboard's words come from it, so a row and its destination cannot
disagree.

### Enrollment
`onboarding_tracking` is **`tracked`** or **`legacy_untracked`** — an empty
checklist used to mean three different things and no longer does. Lifecycle:
onboarding → active → offboarding → completed. **Won is a sales fact and is
never gated on payment.**

### Payment / Stripe
Payment is a separate dimension from sales truth.
[paymentTruth.ts](src/components/atomic-crm/deals/paymentTruth.ts) is the single
assessment; both the Opportunity panel and the Client page render the same
`PaymentPanel`, so they cannot disagree.

- `collected` = money actually received. `remaining` = agreed − collected.
- An agreed total is written only when **provable**: `owner_confirmed` (Leif
  said it) or `stripe_derived` (a finite schedule proves it).
  [stripeAgreedTerms.ts](supabase/functions/stripe_webhook/stripeAgreedTerms.ts)
  derives from finite phases and **refuses** an open-ended plan, a phase with no
  end, a multiplied interval, an unreadable price, multiple line items, or **any
  money collected outside the plan**.
- **`owner_confirmed` is never overwritten by derivation** — it only ever fills
  a gap.
- Payment review: [paymentReview.ts](src/components/atomic-crm/deals/paymentReview.ts)
  decides whether a review can be *acknowledged* (a human raised it and terms
  are known) or *needs the missing fact* (then the panel asks for the agreed
  total instead of offering a button that cannot work).
- Sync Stripe is idempotent and reports each dimension separately — plan
  linked / agreed total from Stripe / payments recorded / plan details updated
  / already up to date.

### Migrations
Deterministic by default; a migration that repairs named production records is
listed in [replay-manifest.json](supabase/migrations/replay-manifest.json).
A migration that does both must be split. Every migration asserts its own
preconditions and refuses a row that has drifted.
**MAIN-only historical repairs must never quietly become deterministic seed
data.** The clean room replays the deterministic chain from empty and must
match MAIN's structure exactly (last proof: 2457 structural facts each side,
0 drift).

A migration's verification block runs as the **migration role**, which has no
DML on business tables — run probes under `set local role authenticated` inside
a subtransaction that raises to roll back. PL/pgSQL variables survive the
rollback; rows do not.

---

## 5. Recently closed defects — the invariant, not the story

| defect | what prevents recurrence |
|---|---|
| Cancel/no-show demoted `call_booked` → `approved` | Both DB functions and both app mirrors leave the stage alone; migration `20260919160000` asserts **no function** may combine `set stage = 'approved'` with a no-show/cancellation. `callBookedIsNotUndone.test.ts`. |
| Remove-from-pipeline returned 403 and **logged Leif out** | `record_deal_outcome_event()` is SECURITY DEFINER (`20260919180000`); `deal_outcome_events` still grants no client INSERT. [isSessionFailure.ts](src/components/atomic-crm/providers/supabase/isSessionFailure.ts) stops treating a 403 carrying a **5-char SQLSTATE** as a dead session. `pipelineExitRoutes.test.ts` covers all ten exit reasons. |
| Decision ordering looked arbitrary | One banded comparator + `pipelineOrdering.test.ts`. The real cause was that 8 of 9 rows had no follow-up date — a data shape, not a comparator bug. |
| Ghosted conflated with No | Separate button, separate dialog, distinct stored values. `GhostedDecision.test.tsx`. |
| Stripe plan linked but agreed total never derived; "Mark reviewed" looped forever | Derivation in the reconciler + `reviewResolution()`: a review about a **missing fact** is never acknowledgeable. `stripeAgreedTerms.test.ts`, `paymentReview.test.ts`, `stripeLaterSubscription.test.ts`. |
| Dax's historical call — "Server communication error" | See next row; plus past-dated calls now set `resolution_requested_at`. `logHistoricalSalesCall.test.ts`. |
| Aurelie: `approved` while holding a `cancelled` call | `callProvesCallBooked.ts` + an assertion in `20260920030000` that **no active Opportunity** contradicts its own call. |
| **`scheduled_on` NOT NULL broke every Sales Call INSERT for three days** | Column is now **derived** by trigger, not a payload obligation. FakeRest does not enforce NOT NULL, so the entire app suite passed while production rejected every insert — this is the origin of §2's write-path rule. |
| **Four future bookings asked "What happened on this call?", and matching them left the Task open forever** | The Acuity webhook kept the `resolve_sales_call` literal from *before* `20260918030000` split the type in two, so an unattributable booking became an attendance question about a call weeks away — and both closers key on the matching type, so the Task survived being answered and its own destination then said "This call is already resolved." Fixed at the source *and* made unrepeatable: `sales_call_open_question()` + a two-directional `reconcile_sales_call_tasks()` (`20260920100000`). Three new invariants in §3 would each have caught it. `aBookingIsNotAQuestion.test.ts` (21), plus ingestion-contract tests for the deterministic, ambiguous, terminal-prior and future-call shapes. **This is the defect that produced §2's acceptance loop.** |
| **A rebuilt database was more permissive than MAIN** | MAIN's privilege posture had been applied by hand and never written down: 23 table over-grants across 12 relations, 23 sequences, 5 privileged functions. Now transcribed into the deterministic chain (`20260919175000`, `20260920120000`) and asserted from the outside by [securityPosture.spec.ts](e2e/securityPosture.spec.ts), which asks what a signed-in client and `anon` can actually do by **trying it**. |
| **Writing a Contact required the right to read identity rows** | `clamp_contact_last_seen()` read `contact_external_identities` as the caller while repairing a future `last_seen`, and `service_role` cannot — so an Edge Function creating a first-time caller's Contact could fail with 42501, intermittently. The trigger is SECURITY DEFINER with a pinned `search_path` (`20260920130000`); nothing else was elevated. |
| **Deleting a round erased its waiting list** | `waitlist_entries.cohort_id` was `ON DELETE CASCADE`, so a round whose only link was its waiting list deleted cleanly and took every membership with it — fifty-one for January 2027 — with one application code path the only thing in the way. The audit that followed found five more of the same class on the Programme itself, all reachable only when no Opportunity exists (an Opportunity already refused through `deals.offer_id`): `waitlist_entries.offer_id`, `cohorts.offer_id`, `client_sessions.offer_id` (`enrollment_id` is nullable, so a session booked by somebody who never enrolled has nothing else holding it up), and the two scholarship tables. All six are `NO ACTION` as of `20260921180000`, which keeps `ON UPDATE CASCADE` — only the destruction was wrong — and ends by asserting the **exact** remaining set, so a new table hung off `offers` or `cohorts` fails the chain rather than being found by somebody losing rows. Four cascades are allowed and named: the price list, two configuration templates, and the Google Calendar mirror. Defence in depth is deliberate: the database refuses whoever is asking, the app says what is linked and offers Archive. `programDeleteSafety.ts` therefore has to ask about everything the database refuses — a shorter list means a confirmation dialog followed by a raw 23503. |
| **The dashboard read "[object Object] openings"** | Openings became a ledger *answer* — `{status:"known"…}` or `{status:"unknown", reason:"calendar_too_short"}` — and both program cards went on interpolating the object into `%{count} openings`. One [OpeningsLine](src/components/atomic-crm/capacity/OpeningsLine.tsx) now renders the answer for the dashboard card and the hub card alike, and its typed prop makes a raw number unpassable. The `unknown` case is the reason the shape changed and must never read as zero: a practice whose Year Tracking calendar cannot seat a new client's twelve weeks has no openings *count*. Asserted on both surfaces, including "not `[object Object]`". |
| **A new group round showed a duration unit it was not using** | `SelectInput defaultValue="weeks"` filled the dropdown without filling the form, so a round typed as "8" derived no end date and would have been refused on save by `cohorts_duration_is_complete_check` — naming a field Leif could see was already set. [CohortScheduleInputs](src/components/atomic-crm/cohorts/CohortScheduleInputs.tsx) now owns the number/unit pair itself, including the detail that a cleared `NumberInput` reports **0**, not empty (`?? 0`), which `cohorts_duration_value_check` also refuses. |
| **"Edit program" on a 1:1 card landed on Not Found** | The mobile shell registered no `offers` resource at all, so the new card menu routed to a dead path — the desktop shell had one and hid it. `<Resource name="offers" show edit />` now mirrors the `cohorts` precedent (reached from a hub card, never a nav item or a list route). `ProgramForms.test.tsx` opens the 1:1 edit form and reads its values. |
| **The Add Task dialog called people by their job title** | `useGetRecordRepresentation("contacts")` fell through ra-core's chain (`name → title → label → reference → #id`) before the resource registry filled in, said *"Create task for CTO"*, and never corrected itself because the representation is captured in a `useCallback`. [AddTask](src/components/atomic-crm/tasks/AddTask.tsx) now names the Contact it already holds via `contactDisplayName`, and says plain "Create task" rather than inventing one. [AddTaskTitleName.test.tsx](src/components/atomic-crm/tasks/AddTaskTitleName.test.tsx) mounts it with **no resource definitions registered at all** — the state the old code could not survive, and the state the ordinary `<CRM>` harness could never reproduce. |

---

### Sealed by human try-run

**Acuity booking / matching workflow — ACCEPTED / SEALED 2026-09-20** at
`451f0af0`. Leif exercised the real production path after deploy:

- **Celia → Opportunity 267**, **Samantha Herold → 268**, **Anna Howard → 269**
  — three unattributable bookings matched through
  `/sales-calls/:id/resolve` in under fifteen seconds, each creating the
  Opportunity the appointment type authoritatively determines, each landing at
  Call Booked with `sales_call_at` set, **each closing its own matching Task**.
- **Dax Kara's attendance question resolved** — call 327 `completed` /
  `attended`, Task 207 closed. The other half of the pair, exercised too.
- Mihaela Petrova's 266/331 from the repair itself.

Afterwards: 0 wrong-question Tasks, 0 appointment Tasks, 0 future attendance
Tasks, 200 Sales Calls unchanged. **The loop that could not close now closes,
proven by use rather than by assertion.**

**The sale repair — ACCEPTED / SEALED 2026-09-25** at `eab821bb`
(`2a1eab80` + `56577ab0` + `9ffac974` + `eab821bb`). Becky Schmauch's own
sale, recorded by Leif in production and then verified read-only:

- Opportunity 192 `won`, `owner_decision = would_work_with`,
  `prospect_decision = yes`, `outcome` null
- exactly **one** Enrollment (91), status `onboarding`, tracking `tracked`
- exactly **four** onboarding items, all pending
- exactly **one** `attendance_recorded` event, still carrying its ORIGINAL
  `2026-09-25 02:24:34` timestamp — the convergence finished the decision
  without restamping the observation
- agreed terms `$4,000 / 1 installment`, `selected_payment_total_source =
  owner_confirmed`; **$0 collected**, no Stripe object, no fabricated
  payment truth
- synthetic Onboarding placement derived, not stored

Two defects in the repair itself were found and fixed before acceptance:
the client result type carried neither `converged` nor
`conflicting-outcome` (so a converged save would have shown a connection
error while succeeding), and the after-attended work ran only for
`completed` (so a late sale got no Offer Page token). Both are asserted in
[wonIsWritableByItsOwnWriter.test.ts](contracts/deals/wonIsWritableByItsOwnWriter.test.ts)
and in `winningASale.spec.ts` against real Postgres as `authenticated`.

**What it exposed, and what became the next slice:** Becky is now Won with
terms recorded and no way to create the payment arrangement. See §8b.

**Reliability Pass 1 — ACCEPTED / SEALED 2026-09-21** at `7bb47194`. Not a
try-run: this pass built no product surface for Leif to exercise, so acceptance
rested on the evidence instead — the real GitHub runner green on the pushed
commit, zero privilege divergences between MAIN and a database rebuilt from
empty, and RED/GREEN proofs against real Postgres for both historical failure
classes. **Full record, and the tooling debt carried forward, in §8.**

---

## 6. Waiting on Leif — do not guess these

**KIT INTEGRATION IS BLOCKED ON SIX ANSWERS — top of this list, 2026-09-28.**
The audit is done and the architecture is largely settled (§8b-kit), but
nothing in the repository, the database, the environment or the deployed
secrets names a single Kit tag, list, form or credential. Applying a guessed
tag fires a real automation and emails a real applicant, and **five real
applicants are pending right now**. The exact inputs needed — the API
credential, the two receipt tags, the four decision tags, whether Do Not
Engage should be subscribed at all, whether a decision tag supersedes the
application tag, and whether the automations key on tags or on a form —
are written out in full in §8b-kit.


**Historical payment totals** (each has collected money and no agreed figure;
the panel offers "Record agreed terms"):
Kerri Fukui (opp 147) · Samantha Putkunz (166) · Sarah McNurlin (181) ·
Nicole Fielding (183).

**Possible duplicate Contact pairs**, classified
`possible_duplicate_owner_review` and deliberately untouched — recorded in
[contactSafety.ts](src/components/atomic-crm/contacts/contactSafety.ts):
**106/344 · 133/364 · 142/341 · 161/349**. Each is one side with a real email
and full history against one side with a single Application and no email at
all; no shared email, no shared Stripe customer, and no address anywhere in the
orphan's answers. Nothing deterministic can settle them.

**Living Example Start Weeks — settled 2026-09-21.** A Start Week is Leif’s
decision. An Acuity booking is a usage fact that follows from it and never
establishes or moves it: someone may commit and then deliberately wait weeks
before booking, especially when Leif is booked ahead.

The CRM had this backwards. Migration `20260918180000` set
`enrollments.start_date` to each client’s earliest booked session, and 19 of
22 Living Example Enrollments carried exactly that date. Leif has now stated
all eighteen live Start Weeks (`20260921140000`), and
`enrollments.start_date_source` records the provenance of every one — a
constraint makes a start date without a source impossible.

**Four of the inferred dates were wrong**, which is the whole argument
against inferring them: Jules Litman-Cleper 24 Jun → **20 May**, Gigi George
19 Jul → 20 Jul, Mackenzie Stabler 29 Jul → **3 Aug**, Denise Cormier 30 Sep
→ **5 Oct**. Shipped on the imported values, the openings board would have
promised two December openings that do not exist.

**Still open, and it is the live question:**

- **A projected end must never retire a client.** Jules started 20 May;
  four months ran out on 20 September and Leif still considers him current.
  He keeps his slot until a real end date or a terminal status is recorded,
  and the Upcoming Openings section names him. **He is the single reason
  December shows no opening** — record his end and December becomes one.
- **The operational end-date rule is not defined yet.** `Start Week + 4
  months` is a projection, labelled “expected” and reported by month. Nothing
  in the repository may close a container on arithmetic alone.
- **No Living Example Enrollment has ever carried a real end date.**

**Two waitlist Contacts named "Terra Israd"** (Contacts 212 and 213), both
waiting on the January 2027 GYU cohort. Distinct Contact records, so the
duplicate-membership guard cannot see them as the same person. Same class as
the pairs above: merging them is a Leif decision, and merge never deletes.
All are non-blocking.

---

## 7. Deferred UX

- **Remove from pipeline should offer explicit `Cancelled` and `No-show` exit
  reasons**, near the bottom of the reason list where appropriate. Semantic
  constraint that must survive the change: **a Cancelled or No-show Sales Call
  does NOT automatically exit the Opportunity.** These would be convenient
  explicit reasons Leif may choose *afterward*, never an automatic consequence.
- Small visual polish previously deferred on purpose (Pete/Jules cadence Task
  presentation is **closed and deployed** — do not re-list it).
- The local test runner's browser mode is unstable on long serial runs; stop
  stale Vite dev servers before a full suite or Chromium gets starved and dies
  mid-run. Even with a clean machine a full app run (~1320 tests, ~12 minutes)
  will occasionally drop **one** timing-sensitive submit/save test.
  **Re-run the file in isolation before believing it** — and if it passes
  there, say so with the evidence rather than either ignoring it or calling it
  a regression.
- Six agent-harness worktree hook tests under `.claude/hooks/test/` fail on
  this machine and **pass on CI's Linux runner** (`cleanup-worktree` ×4,
  `setup-worktree` ×1, `cleanup-session` ×1). Byte-identical to `origin/main`
  and unrelated to application code, so this is local noise in a full-suite
  run, not a red CI. `cleanup-worktree.mjs` removes a fresh commit-less
  worktree the test says must be preserved, and the rest of that stateful
  file falls over behind it; suspect the git version's `worktree list
  --porcelain` output or macOS's `/var` → `/private/var` symlink. Out of
  scope until somebody chooses to look at the harness itself.

**Deferred out of the Capacity + Waitlist slice, deliberately** — the maths
and the waitlist had to become trustworthy before anything acted on them:

- Mass-select + email waitlist people; automated waitlist email sequences;
  a "spot opened" automatic send. The bulk-invite UI already exists behind
  `waitlistInviteFeature.ts` and stays hidden until Gmail delivery is real —
  a prepared batch must never be presented as though people were invited.
- Automated prioritisation of which waitlisted person gets an opening.
  **Opening availability is a fact; inviting someone is Leif's decision**, and
  nothing in this slice narrows that.
- The full Openings Planner. This slice built the arithmetic it will read.
- Gmail and Instagram integration.
- Broader application-page cleanup; the Application Received pipeline
  lightbox.
- Reliability Pass 2.

---

## 8. Reliability Pass 1 — ACCEPTED / SEALED 2026-09-21

Sealed at `7bb47194` on Leif's acceptance, after the real GitHub runner went
green. **Do not redo this work.**

**Why it existed.** Two failures of the same family reached production with a
fully green suite behind them. The 2026-09-17 `scheduled_on` migration broke
*every* Sales Call INSERT for three days, app and Acuity webhook alike, and
nothing saw it because FakeRest enforces no database constraint. Then a rule
that lived in two runtimes drifted — the Acuity handler kept a task-type
literal a migration had split — and four real bookings asked what had happened
on calls weeks away. Everything green, production wrong, both times.

### The accepted guarantees

1. **Rebuild safety.** The repository rebuilds a database from empty using
   legitimate environment prerequisites and the deterministic chain only, with
   **no hidden manual security configuration**. Proven by comparison against
   MAIN: zero privilege divergences across table grants, function EXECUTE,
   effective sequence privileges and default ACLs.
2. **Write-path safety.** A `scheduled_on`-class schema break is caught by
   real-Postgres writer contracts — every supported Sales Call writer replayed
   with its real payload under its real role — locally **and in CI**.
3. **Cross-runtime safety.** Drift between the app, the database and the
   Acuity Edge Function is caught by one checked-in set of vectors driven
   through all three arms, locally **and in CI**.
4. **Healthy code produces a green Check workflow.** That property is the
   point: a permanently red pipeline is not a reliability signal.
5. **The clean-room / e2e CI path works on the real runner.** It had been dead
   since 2026-09-06 and nobody knew.
6. **MAIN is aligned with the repository**, and production is healthy.

### Where it lives

| | |
|---|---|
| `contracts/sales-calls/writers.json` | every supported Sales Call **creation** path, machine-checked: each writer is executed and the payload it really sends is compared against what it claims |
| `contracts/sales-calls/openQuestionVectors.json` | the canonical cross-runtime vectors — one set of cases, three runtimes, one fixed instant |
| `contracts/sales-calls/creationSchemaContract.json` | the pinned creation contract, with **what fills each NOT NULL column**: writer / identity / default / trigger |
| `e2e/salesCallWriteContracts.spec.ts` | the writers replayed against real Postgres |
| `e2e/securityPosture.spec.ts` | what a signed-in client and `anon` can actually do, asked by trying it |
| `scripts/cleanRoomBootstrap.mjs` | `make start-supabase-e2e` — prerequisites, deterministic-only replay, throwaway secrets |
| `20260919175000`, `20260920120000` | MAIN's privilege posture, transcribed into the chain |
| `20260920130000` | the Contact-write fix (below) |

### What it found on the way

Reliability work is supposed to find things, and it did:

- **MAIN carried security configuration the repository did not.** An
  `ALTER DEFAULT PRIVILEGES` applied by hand, never written down. A rebuilt
  database was more permissive than production in 23 table grants across 12
  relations, 23 sequences and 5 functions — a client could have forged outcome
  history, rewritten immutable Application answers and called
  `merge_contacts_safely()` directly. MAIN was never exposed; the *rebuild*
  was, and AGENTS.md promises the rebuild.
- **Writing a Contact required the right to read identity rows.**
  `clamp_contact_last_seen()` repaired a future `last_seen` by reading
  `contact_external_identities` as the caller, and `service_role` cannot. Any
  Edge Function creating a first-time caller's Contact could fail with 42501,
  intermittently. Fixed by elevating the trigger and nothing else.
- **The Add Task dialog called people by their job title.** Before the resource
  registry filled in, ra-core's fallback chain reached `record.title` — so the
  dialog said *"Create task for CTO"*, or *"Create task for #1"*. It never
  corrected itself.
- **The e2e substrate had been unrunnable since 2026-09-06** — missing
  environment prerequisites, MAIN-only repairs replayed into an empty database,
  and Postgres pinned to 15 while MAIN runs 17.
- **A guard demanded a flag that does not exist**, making every Playwright
  command unwritable, which is part of why nobody noticed the suite was dead.
- **`commands.setTimezone` never changed the timezone** — the CDP session was
  detached immediately, reverting the override. Every test that "forced" a zone
  ran in whatever zone the machine had, so results depended on the hour.

### Carried forward as non-blocking tooling debt

- Occasional local **browser-process death** on repeated long serial runs
  (`[birpc] rpc is closed`, zero test failures) — a machine-resource artifact;
  stop the disposable stack before a full suite.
- The dedicated **Functions step is redundant** — `Unit Tests on App` already
  runs every project. `if: always()` would make it independently observable.
- **Supabase CLI is pinned nowhere**; `npx supabase` resolves whatever is
  newest. A dependency-management decision, not a blocker.
- **GitHub Pages deploy fails** in the demo/supabase jobs, and has on every run
  since well before this pass. Unrelated to CRM production.
- **`ClientShow.tasks` CI timeout — root cause found and closed 2026-09-22.**
  It was never product timing and never really a flake. The fake data provider
  simulates **300ms of latency on every call** (`latency = 300` in
  `createDataProvider`), and the file waited for the created Task with
  `expect.poll`, whose default budget is **1000ms** — five times shorter than
  `expect.element`'s 5s. So every poll attempt spent 300ms of a 1s budget
  inside the harness's own artificial delay. Measured: 301ms from Save to the
  row on an idle machine and 300ms under a deliberately saturated one — a
  fixed timer, not work, which is why CPU load never reproduced it locally and
  why a runner at ~2× this machine's wall clock crossed the line. With
  `latency: 0` (what 74 other tests already pass) the same measurement is 0ms.
  Applied to `ClientShow.tasks` and to `ClientShow.sessions`, which polls the
  provider the same way and had the trap armed without having fired yet.
  **The general rule: a test that reads the fake provider directly passes
  `latency: 0`.** `expect.poll`'s 1s default cannot absorb even two simulated
  round trips.
- **`SB_PUBLISHABLE_KEY` is not set in the deployed Edge Function
  environment.** It lives in `supabase/functions/.env` (local only) and as a
  GitHub secret used for the *frontend* build (`VITE_SB_PUBLISHABLE_KEY`);
  nothing ever runs `supabase secrets set` for it, and `supabase secrets
  list` confirms its absence. So `Deno.env.get("SB_PUBLISHABLE_KEY")` is
  undefined in production, and any code building a publishable-key client
  from it authenticates *nobody*. This is what refused the owner's first
  Sync Stripe. Fixed for `reconcile-all` by using `verifySupabaseJWT`
  (JWKS, needs only `SUPABASE_URL`) — the mechanism the rest of
  `stripe_webhook` already uses. **`_shared/authentication.ts`'s
  `UserMiddleware` still reads that variable**, so the `users` Edge
  Function (invites, account disabling) is very likely refusing every
  caller in production for the same reason. Not yet confirmed against a
  real signed-in session, and not fixed here.
- **The harness worktree hook is not idempotent on macOS** (6 failures in the
  `claude` project, `setup-worktree` + `cleanup-worktree`, reproducible in
  isolation and unrelated to CRM code). `git worktree list` reports
  `/private/var/...` while the hook computes `/var/...`, so
  `getWorktreePaths().includes(worktreePath)` misses, the hook deletes the live
  worktree directory as an "orphan", and `git branch -D` then cannot remove a
  branch git still considers checked out — so the retry dies on *a branch named
  … already exists*. Linux CI is unaffected (no `/var` symlink). Harness
  infrastructure, not product.

### Capacity + Waitlist — SEALED 2026-09-24

**Accepted at `7258bd8a6beb6909e6974fb3ae2d8a7f7c4d3eed`**, after Leif used
each part of it on production. Deployed 2026-09-22, open for eleven days
of try-run, repaired four times against what that try-run found, and
sealed only once he had accepted the last of it (§2).

Main CI green. 137/137 migrations aligned, **0 pending**, latest
`20260922100000`.

**What was accepted**

- **Current Clients** — `start_date DESC`, newest start to oldest.
- **Upcoming / Starting Later** — `start_date DESC` as well. It used to
  read forwards as a queue; Leif asked for the two lists to agree so he is
  not changing how he reads the page halfway down it. The within-date
  tie-break differs between the two surfaces — the Clients page ties by
  id, the Program page by name, because `ClientRow` has no name to sort on
  without a contacts fetch — and that difference is **accepted, not a
  blocker**. It is visible on real data: four clients share 8 November.
- **The month / openings breakdown stays chronological ASC**, deliberately.
  It is a timeline of who frees up and who starts inside one month, sitting
  beside `freeing`, and a timeline reads forwards. A contract test pins it
  so nobody flips it later out of symmetry.
- Projected-opening UX, the lightbox, and the confidence signal.
- Final-session-week occupancy and release semantics.
- Duplicate Year Tracking windows deduped.
- Sync Calendar, Sync Stripe, and the compact Dashboard header controls.
- Stale retired cadence alerts reconciled — six to zero on one press.
- **Ambiguity is never auto-classified.** Nothing guesses on Leif's behalf.

**Five live unresolved cadence issues, intentionally waiting for Leif**

- Jules Litman-Cleper ×4 — ordinals 1, 2, 6 and 7, raised 2026-09-22.
- Sarah Monast ×1 — ordinal 4, the week of 20–24 September, raised
  `2026-09-24 00:00`.

Sarah's is **new, and is the system working rather than a regression**.
Her week closed overnight with no fulfilling session, so the hourly pass
raised exactly one question and left it unclassified. A seal taken from a
stale count would have said four; it says five because it was re-measured.

#### PASSED human acceptance: owner Stripe sync from the Dashboard (2026-09-23)

Leif pressed Sync Stripe on production and it ran. So the owner-gated
whole-account sweep is human-accepted end to end: his real signed-in
session -> a JWT verified against Supabase's JWKS -> his own `sales` row
read server-side with the service role -> `administrator` true, not
disabled -> the same canonical `reconcileStripe` pg_cron runs.

The bug that preceded it is the lesson worth keeping. He was told *"only
an account administrator can sync"*, and he **was** the administrator: one
`sales` row, `administrator = true`, `disabled = false`, correctly linked
to the only `auth.users` row. The server had never reached the
administrator check. It answered **401**, because authentication was built
on a publishable-key client reading `SB_PUBLISHABLE_KEY` — set in the local
`supabase/functions/.env` and as a GitHub secret for the *frontend* build,
but never pushed to the deployed Edge Function environment. Two separate
faults compounded: a dependency on a variable that does not exist in
production, and a UI that collapsed 401 and 403 into one message, so a
configuration fault was reported as a missing permission and sent the
reader to audit a role that was already correct. **A message naming the
wrong cause is worse than a vague one.** The two are now distinct, with
tests holding them apart.

The remaining work after this was presentation only: the header's two
controls sat unevenly because a "Last synced" caption hung under one of
them.

#### PASSED human acceptance: stale cadence alert reconciliation (2026-09-23)

Leif pressed Sync Calendar once on production. Measured on MAIN before and
after, read-only:

| | before | after |
|---|---|---|
| open alerts on retired/noncanonical weeks | **6** | **0** |
| open alerts on live canonical weeks | 4 | **4** |
| `retired` audit events | 0 | **6** |
| open `resolve_client_session_cadence` Tasks | 10 | **4** |
| issues auto-classified without a human | 0 | **0** |

The six were the Aug 30 – Sep 3 week Leif had deleted (Jess Beauchamp,
Adriano Castro, Gigi George, Jules Litman-Cleper, Mackenzie Stabler) plus
Jules's duplicate May 17 – 21 window. The four that remain are Jules's
real unresolved weeks on live slots (ordinals 1, 2, 6, 7) — untouched, and
his to classify.

So the whole chain is proven end to end in production, by a human:
calendar correction -> canonical rebuild -> derived slot retired -> stale
issue ceases to be actionable -> linked Dashboard Task completed -> audit
history preserved (the rows are kept, never deleted) -> genuinely
unresolved live issues left alone. One button, no manual classification,
and the Dashboard count refreshed from the same rebuild rather than from
any Dashboard-only calculation. **Preserve this behavior.**

Six migrations on MAIN: `20260921130000`, `140000` (MAIN-only owner Start
Weeks), `150000`, `170000`, `180000`, `190000`. All eighteen live 1:1
Enrollments carry the owner-stated Start Week with `start_date_source =
'owner'`.

Two defects were found *by checking production after the push*, neither
reachable by any clean-room replay, and both are the same lesson in
different clothes — **an empty database cannot tell you whether a
migration works**:

- `20260921130000` added the constraint binding `start_date` to
  `start_date_source` **before** backfilling the source. Empty: passes.
  Production: refused on the first of 22 dated rows. Repaired in
  `41182451`; the order is column, then data, then the rule that binds
  them.
- `20260921150000` installed the rebuild trigger **after** `140000` had
  already corrected the Start Weeks, and nothing called the full rebuild —
  so MAIN came out of the push holding the owner's dates in `enrollments`
  and the imported dates' schedule in `enrollment_expected_sessions`. Two
  timelines for one Enrollment, the exact condition the slice exists to
  remove. `20260921190000` runs the rebuild and asserts it as a fixed
  point. With no Enrollments to rebuild, a missing rebuild and a completed
  one are the same empty table.

#### Human acceptance FAILED on Upcoming Openings — 2026-09-22

The first acceptance failure this project has had that was not an
arithmetic fault. Every number on the screen was correct. Leif's review:

> "I don't understand if I have any openings available or not, what
> unknown means, what 11 out of 12 means, or whether peak 14 means I have
> 14 people enrolled."

What the screen was doing wrong, itemised, because each of these is a
separate habit worth not repeating:

- **`unknown` was published as the answer.** It is the engine's word for
  its own state. It was technically accurate and operationally opaque, and
  it is not a synonym for "no openings" — one is "I can't see far enough",
  the other is "you are full", and they need opposite actions.
- **"11 of 12 session weeks" was the headline.** That is the mechanism.
  Leif should never need to know it to operate the CRM; it belongs under
  the answer, not in place of it.
- **"Peak 14 in the programme" had no unit and no ceiling.** Read as "do I
  have 14 people enrolled?".
- **No action.** The one thing that fixes most of these — add 1:1 weeks to
  Year Tracking, then Sync Calendar — was not on the screen at all.
- **The month calculation was not inspectable.** "I need to be able to
  click on one of those boxes and see a full breakdown of that
  calculation."

The repair is comprehension only: no capacity rule, ceiling, Start Date,
session count or reschedule rule changed. What changed is that the answer
comes first and the mechanism sits under it, and that candidate starts are
now evaluated per `1:1s` WEEK rather than only on the 1st of each month —
which is what lets the screen say "week of Dec 7" instead of "December",
and stops a month reading as full because its first day happened to be.

**The general lesson, and it is the third time this project has met it:**
passing tests prove the code does what it was written to do. Only Leif can
say whether what it was written to do is legible. See §2.

#### Year Tracking is a plan, not a log — settled 2026-09-22

Owner clarification, now an invariant. The `1:1s` weeks are the weeks
Leif INTENDED to work. They are not a record of where sessions happened.
He was ill the week before 30 August and moved five sessions into 30 Aug
– 2 Sep; that week was never a 1:1 week and must never become an
entitlement week, or every client he moved silently gains a session.

So: **a make-up session is evidence, never eligibility.** The empty
original week is a cross-week reschedule and extends the container by one
week — once Leif says so. The CRM shows him the appointment and stops.

**The stale Dashboard alert Leif found had two causes, both now fixed.**
He deleted the bad week, synced, the Program page followed and the
Dashboard did not. (1) The rebuild retired the slot but left its cadence
issue open and its Task pending, so Needs Attention kept asking about a
week the schedule no longer had — and no honest answer existed. (2) The
detection pass scanned retired slots, so even a closed one came back.
`20260922100000` closes the issue and the Task on retirement, logging a
`retired` event so the history still reads; the detection pass now skips
retired slots. The slot itself is kept: something historical points at it.

**A week Leif is open counts once, however many calendar events describe
it** — now deduped in the canonical SQL schedule, not only in the app.

#### The week-boundary invariant — settled 2026-09-22

Leif's second review found three surfaces that could not all be right:

> "Erik Amundson — expected final session week Nov 29, 2026" ·
> "Week of Nov 29 — 11 active — No finishes" ·
> "Earliest safe start: week of Nov 29"

**Nov 29 was correct.** The canonical rule, now asserted rather than
implied:

> A client occupies their slot **through the whole of their final session
> week**. The slot is released at `finalWeek.end` — the exclusive end,
> i.e. the first day after that week. `lastDay` is the last day they hold
> it; `freesOn` is the first day they do not.

So Erik and Sarah *were* two of the eleven in their own final week, and a
twelfth client genuinely fits beside them.

What was broken was the display. A finish was bucketed by `freesOn`, which
by construction is never inside the week it belongs to — and because Year
Tracking has gaps between weeks, it usually fell inside no week at all.
**"Finishing" was empty on every single week of the forecast.** Fixed by
bucketing on `lastDay`. Two further boundary faults came out with it: the
safe-start copy printed `holdsSlotUntil` (the day after the final week) as
though it were a week, and duplicate `1:1s` events were each counted as an
eligible week — production holds two for the week of 17 May 2026, which
spent two of Jules' twelve sessions on one real week and ended him early.

**Three rules to keep straight, because all three sit on one screen:**
occupancy needs the release DATE; anything shown to a person needs the
WEEK; and a week Leif is open counts once however many calendar events
describe it.

**Rehearse against production in a rolled-back transaction** before any
migration that touches existing rows. Both repairs were proven that way
first, and the Won path and the January-2027 delete refusal were proven the
same way afterwards, leaving no synthetic data behind.

---

## 8b. POST-WON PAYMENT SETUP / OFFER PAGE TRUTH — DEPLOYED, NOT YET ACCEPTED

**Committed 2026-09-26 at `b12fb3b8`** (*fix(payments): separate accepted
sales from payment setup*), 31 files, **deployed to production and verified
healthy there**.

**Still unaccepted by a human — and that now waits on a sale, not on
engineering.** The owner-facing path this slice built, *Send payment link →
agreed terms → Stripe Checkout*, has not been walked end to end by Leif with a
real client.

**Becky is no longer the acceptance candidate.** A legitimate Stripe
reconciliation found the plan she already had and moved her to
`paid_in_full`, so there is nothing left for her to set up. That is the
correct answer about her, not a regression: **do not treat it as an open
engineering defect and do not go looking for a way to put her back into
`setup_pending`.** The next clean candidate will most likely arrive on its
own, out of the next real sale that needs payment arranged.

Proven before commit, against real Stripe TEST rather than against request
construction: a real `cs_test_` Session with `mode=payment`,
`amount_total=400000`, the Opportunity on `client_reference_id` and in
metadata, no catalog substitution; the subscription-mode Session with one
**$1,000/month line item reconstructing $4,000 exactly**; five refusals that
created **zero** Sessions in the account. Then a real hosted TEST payment,
its **signed `checkout.session.completed` accepted by the local webhook**,
collected **0 → 4000** from actual payment evidence, `paid_in_full` reached,
stage still Won, terms still `owner_confirmed`, one Enrollment — and a replay
of the same signed event changing nothing, while a forged signature is still
refused.

**Non-blocking TEST follow-up, not a defect:** adopting the subscription and
its Architecture B schedule needs a *second* completed hosted checkout,
because a subscription only exists once a payment succeeds and Stripe has no
API to pay a Session. The Session shape is proven and the metadata that path
reads (`total_installments`, `deal_id`, `pricing_mode`) is contract-pinned in
[postWonPaymentSetup.test.ts](contracts/deals/postWonPaymentSetup.test.ts).
Close it with one more test-mode checkout whenever convenient.

**Audit complete 2026-09-25.** Opened by Becky's own
acceptance: the CRM reached *Won → agreed total recorded →
Payment setup pending → Next: Create payment plan*, and **there was no
action behind that sentence.**

Two independent blocks, both dating from when Won meant paid:

- `publicOfferPageContext.alreadyWon = deal.stage === 'won'` (2026-09-04)
  hides every Pay button and shows **"Payment received ✓"** to somebody who
  has paid nothing.
- `stripe_checkout` refuses `{status: "already-won"}` on `deal.stage ===
  'won'` (2026-09-04), so the server would refuse even if the button were
  restored. `resolveAuthorizedCheckoutTerms` carries the same guard.

Both predate `20260918180000` ("Won is a sales fact, not a payment fact")
by two weeks. **Neither is still required:** `handle_deal_won()` is
idempotent, `recordDealPaymentSucceeded` already returns `already-won` and
writes nothing, and the reconciler deliberately includes Won deals. The
guards are legacy replay-protection that has since been implemented
properly one layer down.

**No new stored state is needed.** `paymentTruth.ts` already derives all
five states (terms unknown → setup pending → scheduled → active → paid in
full) and already owns the right predicate: **`paymentSetupComplete`**
(paid in full, or a live plan, or `payment_setup_confirmed_at`). The repair
is to make the Offer Page and the checkout ask *that* instead of `stage`.

`payment_setup_confirmed_at` / `payment_setup_source` already exist
(`20260918310000`) with **no writer anywhere** — the second missing action.

Requirements to hold:

- Leif takes Becky from her exact current state to a real arrangement
  without changing Won, fabricating paid status, duplicating the
  Enrollment, or rewriting the agreed terms.
- Checkout authorization is derived from the **owner-confirmed agreed
  terms**, not from the catalog. Real agreements already include structures
  absent from `offer_payment_options` (8 of 29).
- An owner-confirmed total is never silently replaced by a list price.
- `pricing_mode = 'scholarship'` stays an explicit owner fact; a material
  conflict with the agreed total asks Leif rather than substituting.
- Stripe cannot represent every agreement deterministically — unequal
  splits, non-monthly cadence, a total that does not divide evenly. Those
  escalate to the outside-Stripe arrangement, never to an approximation.

Full audit, root causes, state table, Stripe-representability rules, the
minimal UX proposal and the required proofs: see the audit report of
2026-09-25 (this slice's opening report).

### ACCEPTED product decisions (2026-09-25) — built, awaiting Leif's try-run

**`paymentSetupComplete` answers "offer another checkout?", NOT "payment
received."** It is true for a live plan that has collected nothing and for
an arrangement made outside the CRM. The public page therefore states four
situations separately, and only one of them mentions money arriving:

| derived state | what the buyer is told |
|---|---|
| `paidInFull` | **Payment received ✓** |
| live plan, not paid in full | **Payment plan set up ✓** + what has actually been collected and what is still to come |
| owner-confirmed elsewhere | **Payment arranged ✓** — no claim about money |
| sold, terms known, nothing arranged | the agreed terms, and one **Pay** button |
| sold, terms unrecorded or unchargeable | **Nothing to pay here yet** — the CRM's problem, not the buyer's |

1. **Post-sale terms are fixed.** A sold client is not shopping: the catalog
   is not consulted at all, and the only thing the page will execute is the
   owner-confirmed agreement. Becky sees `$4,000 once`, never the real public
   `4 × $1,000` option her Offer also has.
2. **Non-exact division is refused, never rounded.** The STORED installment
   amount is the agreement; it must multiply to the total to the cent.
   $4,000 / 3 = 3 × $1,333.33 = $3,999.99 → refused, because a cent short of
   the agreement reads "$0.01 remaining" forever. Daniel Alexander's
   $3,998 in 6 × $583 is refused for the same reason. No remainder-installment
   support in this slice.
3. **Out of scope structures escalate**, they are never approximated: unequal
   splits, deposit + balance, non-monthly cadence, delayed first payment,
   currency mismatch.
4. **The panel says "Send payment link", not "Create payment plan"** —
   nothing canonical exists to create before the client goes through
   Checkout. Actions: **Open payment page** / **Copy payment link** (the Offer
   Page token that has existed since the sale — never a second token system)
   / **Payment setup handled elsewhere**. Emailing the link waits for Gmail.
5. **"Payment setup handled elsewhere"** writes only
   `payment_setup_confirmed_at` + `payment_setup_source = 'owner_confirmed'`
   (the pair the database enforces), after an explicit confirmation whose
   helper text says *"This does not mark anything paid."* It touches no
   stage, no terms, no Enrollment, and writes no ledger row.
6. **"Payment option" was the wrong name for the sealed agreed numbers** —
   the display now says **Agreed terms**. The editable catalog control keeps
   its capability (it narrows the public page and cross-validates
   `pricing_mode`) and is relabelled **Catalog plan (optional)**; post-sale
   checkout does not use it. No new "authorized at checkout" workflow.
7. **Scholarship stays an explicit owner fact and so does the agreed total**;
   neither derives the other. A material disagreement between
   `pricing_mode = 'scholarship'` and the agreed total **blocks checkout
   server-side** until Leif has stated which number governs — it never
   substitutes, and never blocks a historically valid custom total.

   **The authority is a canonical fact, not a click:**
   `selected_payment_total_source = 'owner_confirmed'`, written by exactly one
   app path (Leif typing the total into the payment panel). A
   `stripe_derived` total is a machine inference and a null one is an import;
   neither is an assertion, so both wait for her. The block reason is
   `scholarship-unconfirmed`, applied by **both** the page and
   `stripe_checkout` through the shared rules — so the warning cannot be
   bypassed by opening the Offer Page token directly, a refresh re-blocks an
   unconfirmed conflict, and a confirmed one is never re-asked. The
   prospect can never make this confirmation: `anon` has no grant on
   `deals` at all (asserted in `winningASale.spec.ts`). The three historical
   scholarships are untouched by the rule — their totals equal their
   scholarship price, so no conflict exists.
8. **Generic, not Becky-shaped.** Every rule above derives from canonical
   facts and applies to any Opportunity that is Won with terms known and
   payment setup incomplete.

**The webhook defect this found.** `recordDealPaymentSucceeded` correctly
no-ops for a Deal already Won — but the handler then RETURNED, so a payment
from somebody sold to before paying left the ledger empty until the nightly
sweep happened to run. The same Won=Paid assumption one layer up: the stage
deciding whether payment truth gets recorded. The handler now reconciles that
contact's Stripe state immediately after the sale step, inside a try/catch so
a reconciliation failure can never fail a delivery whose sale already landed.

**A third: "Scheduled payment plan" for an arrangement the CRM cannot see.**
`payment_setup_confirmed_at` makes setup complete without any plan existing
here, and the panel still announced a schedule — implying installments that
may not exist, for what could be a transfer, an invoice, or a plan Leif built
by hand in Stripe. The derived state is unchanged (it answers "offer another
checkout?", the same answer either way); the PRESENTATION now reads the
subfact `setupConfirmedElsewhere` and says **"Payment setup handled
elsewhere · Arranged outside the CRM"**, with money stated as
"$X recorded here". A real live plan still reads "Scheduled payment plan",
and when both are true the plan the CRM can see wins. Pinned by three tests.

**Two further defects this slice's own proofs found.**

- **`stripe_checkout` could not boot without a Stripe key.** `new Stripe("")`
  throws at construction, and it was constructed at module scope — so a
  missing or mid-rotation `STRIPE_SECRET_KEY` turned every request, including
  the refusals this function exists to answer, into an opaque `WORKER_ERROR`.
  The client is built on first use now, after every CRM-side decision, and a
  genuinely absent key is one clear 503. Found by trying to prove the
  refusals happen before Stripe: without a key nothing could be proven,
  because nothing could run.
- **The FakeRest mirror was stricter than production on scholarship slots.**
  `transitionScholarshipSlotToEnrollment` raised "reached Won as scholarship
  but held no scholarship slot" whenever a Won scholarship Opportunity was
  saved without an Enrollment — while `handle_deal_won()` only reaches that
  raise on a genuine transition INTO Won. In demo mode that made **any** edit
  to a Mel/Sam/Gigi-shaped record fail. A missing slot is now nothing to hand
  over (the historical import shape); a slot held by a *different* Deal still
  raises, which is the half worth keeping.

**Where it lives.** [postSaleCheckout.ts](src/components/atomic-crm/deals/postSaleCheckout.ts)
is the logic of record;
[postSaleCheckoutRules.ts](supabase/functions/_shared/postSaleCheckoutRules.ts)
is the deliberately pure Edge mirror that **both** `offer_page` and
`stripe_checkout` share, so the page can never offer a payment the server
refuses. The mirror is asserted equal to the logic of record over eleven real
cases in [postWonPaymentSetup.test.ts](contracts/deals/postWonPaymentSetup.test.ts),
which also fails if any eligibility surface goes back to reading
`deal.stage`.

## 8b-next. CROSS-OFFER TRANSFER + RECONCILIATION — ACCEPTED / SEALED 2026-09-27

**Human-accepted in production, 2026-09-27.** Leif repaired Jenna Smith through
the real UI: the dialog proposed Growing Yourself Up, he confirmed it, and the
repair completed. Verified read-only in production afterwards, all of it:

- Opportunity 188 still **The Living Example**, still **won**, **one** Enrollment
- **4 live requirements** — Contract signed `done` (its completion timestamp
  intact, its provenance still null), Notion access, Living Example curriculum
  access and Meditation library access all `pending` with `source_offer_id` = LE
- **Slack access and Google Calendar access `retired`**, both stamped
  `retired_from_offer_id` = GYU — not deleted, not marked done
- their Tasks (279, 280) **`cancelled` with `done_date`**; Task 281 was
  **re-titled** to "Grant jenna smith Living Example curriculum access" rather
  than duplicated; Task 321 added for Notion; **one pending Task per pending
  requirement**, no duplicates, no stale Slack/Calendar Tasks
- **one** `deal_offer_events` row (id 4): GYU → LE, `source = 'reconstructed'`,
  **`occurred_at` null**, `recorded_at` = 2026-09-27 18:51:42Z, note present —
  the only row in the table anywhere
- her **Application 109 still Growing Yourself Up** (approved, submitted
  2026-08-01) and her **sales call 189 still GYU** by its own Acuity appointment
  type — both untouched
- `enrollment_onboarding_matches_offer(93, 1)` now returns **true**, so the
  repair action no longer appears for her

Everything below is kept as the record of what was built and why.

## 8b-next-detail. THE TWO AUTHORITIES

**Deployed 2026-09-27.** `origin/main` = `3418f3b8`: `c36ba6eb` (transfer),
`75cdfa67` (declarative schema), `f419a552` (test hygiene), `ae9a4c14` and
`3418f3b8` (docs). Production holds **141 migrations**, newest
`20260926010000`, and Vercel's production build is that commit. CI applied the
migration itself — the `Deploy (supabase)` job's *Push supabase migrations*
step succeeded, which it had not done for some time (§3); the only red step is
the long-standing GitHub Pages one.

**Two authorities, because there are two different facts.** Deploying the first
one exposed the gap:

| | when | what moves |
|---|---|---|
| `transfer_enrolled_opportunity_offer()` | the programme itself changes, A → B | the Opportunity's offer **and** everything downstream, in one transaction |
| `reconcile_enrollment_to_current_offer()` | the Opportunity **already** carries the intended offer and the projection does not | only the projection — the Opportunity is not written |

**Jenna needs the second one, and the first correctly refuses her.** Her
Opportunity 188 already says The Living Example (it was edited three minutes
after the sale, before the guard existed), so
`transfer_enrolled_opportunity_offer(188, LE)` answers `already-on-offer` and
writes nothing. Routing her through GYU is refused too, by design: GYU is a
group programme and nothing here picks somebody's cohort. **An earlier version
of this section said the normal transfer would repair her. It would not.**

Both share one body — `apply_enrollment_onboarding_projection()` — so a later
change to how a shared key is re-pointed, or how an obsolete pending
requirement retires, cannot make them disagree.

**Committed locally 2026-09-27, not pushed:** `fix(enrollments): reconcile a
client's onboarding to the programme they are on`, with migration
`20260926020000_onboarding_can_be_reconciled_to_its_programme.sql`.

Migration ordering, still leaving the builder's slot free: `20260925120000` →
`20260926010000` (transfer, live) → **`20260926020000`** (reconcile) →
`20260926090000` (builder, parked). `replay-manifest.json` is **142** in the
commits and **143** in the working tree while the builder sits there.

**Queue after Jenna's production acceptance, owner-set 2026-09-27:**

1. ~~**Finish the operational UX acceptance**~~ — the `legacy_untracked` fix
   is **accepted** (§8b-ux-fix); the unmatched-sales-call resolution in §8b-ux
   is still open and waiting on a real unmatched booking
2. ~~**Client start-week / capacity UX**~~ — **deployed 2026-09-28, edit
   lightbox accepted** (§8b-startweek-built); three branches wait on real
   production events
3. **Kit / Applications integration** — §8b-kit. **Audited 2026-09-28 and
   BLOCKED on six answers from Leif** (§6). A *completion requirement* for
   Applications, not optional polish.
4. **Resume the Application Form Builder** — §8b-builder
5. **Gmail** — §9, after the above

### A. Jenna Smith — the production acceptance case

**Her production records are untouched.** No production writes were made while
building or proving either half; every case ran against the disposable clean
room on its own fixture rows. **Do not repair her locally, and do not repair
her by migration** — she is the acceptance case, and the repair is a click Leif
makes in production with the result in front of him.

**What he clicks:** her client page now offers **"Repair onboarding to current
programme"**, and only when the requirement keys deterministically disagree with
the programme. It asks which programme the setup came from before it does
anything. Growing Yourself Up will be proposed, because GYU's template is the
one her checklist matches — but it is a proposal he confirms, not an inference,
because the answer becomes her history. The repair records one
`deal_offer_events` row, GYU → LE, `source = 'reconstructed'` with
**`occurred_at` null**: the change itself predates the guard and nothing
anywhere records which day it was, so the repair does not lend it its own
clock.

Moving her with the canonical transfer should leave exactly this:

| Requirement | State after the move |
|---|---|
| Contract signed | ✓ done — and it keeps the unknown provenance it already has |
| Notion access | pending |
| Living Example curriculum access | pending |
| Meditation library | pending |
| | **1 / 4** |

- Her GYU-only pending items (**Slack**, **Calendar**) **retire**, and their
  Tasks **cancel**. Nothing is deleted, and nothing is quietly marked *done*.
- Her **GYU Application stays historical**, and stays writable: the
  Application-agreement guard accepts an offer a transfer moved away from.
- Her **GYU sales call stays historical**. A booking is a fact about a meeting
  that happened; buying something else later does not restate it.
- Her current Opportunity and client record read **The Living Example**.
- **Ordinary offer edits are unavailable once an Enrollment exists.** The
  database refuses that edit and names
  `transfer_enrolled_opportunity_offer()`, so the mismatch this repairs
  cannot be recreated through the form that created it.

### B. Dashboard sales-call resolution should not navigate away — NEXT AFTER JENNA

"No matching Opportunity" currently leaves the Dashboard for
`/sales-calls/:id/resolve`. Normal Dashboard interaction should instead open a
**lightbox/modal over the Dashboard** — the pattern the Opportunity and
Application lightboxes already use — while **preserving the underlying route**
so a direct link or a reload still lands on a working page.

Automatic matching stays automatic wherever it is unambiguous. The exception UI
exists only for genuine ambiguity or for no matching Opportunity at all; it is
not a step to put in front of Leif on the ordinary path.

## 8b-startweek. CLIENT START-WEEK / CAPACITY UX — QUEUE POSITION 2

**Found in production, 2026-09-27.** From a Client page, **Edit navigates away
to a separate full page**, and that page currently looks like the only obvious
place to set an LE client's **Start week**. Start week materially drives LE
capacity and openings — so a newly sold LE client with no start week can leave
**the openings count wrong until Leif happens to find that edit page and set it
by hand**. The number is not lying on purpose; nothing ever asked him for the
fact it needs.

**1. Client Edit should be a lightbox.** Normal interaction from the Client page
opens a **modal/lightbox over it**, the same pattern the Opportunity,
Application and (queued) sales-call resolution use, while **preserving the
underlying route** so a direct link or a reload still lands on a working page.
Status / Start week / End may stay editable there.

**2. Start week belongs in sale acceptance.** For The Living Example, when a
person moves out of Decision into an accepted sale — Won, operationally
committed — **surface Start week as part of that workflow**, with an obvious
place to set it before or while completing the transition. Leif should not have
to go hunting for the Client edit page afterwards to make capacity correct.

**3. An unknown start week is a state, not a blank.** When it genuinely is not
known yet, allow an explicit **"Set later" / "Start week needed"**, and surface
it **visibly as unresolved operational work**. Capacity and openings must not
present confident-looking certainty that rests on a missing fact.

**Audit before choosing the arithmetic:** read the existing openings/capacity
semantics first and decide deliberately how an unset start week affects the
counts. This area has already been wrong twice in ways that looked right (§8's
"18 / 12 active", and the "Can't calculate" versus "0 openings" distinction),
and the honest answers there were about *naming what is not known* rather than
picking a number.

**4. End date is an open product question.** Audit whether LE End should
**derive from Start week + programme duration** or **stay independently
editable/overrideable**. Do not decide it from the outside: inspect the existing
duration, session-cadence and capacity semantics first — the twelve-session
model and the Year Tracking week rules already constrain what an "end" can
honestly mean (§8, and the derived-schedule functions in §4).

**5. It stays editable later.** Changing Start week afterwards from the Client
page, through the same lightbox, must remain possible. Setting it during a sale
is a prompt, not a one-way door.

## 8b-ux. OPERATIONAL LIGHTBOX UX — DEPLOYED, PARTLY ACCEPTED

**Deployed 2026-09-27 at `1c1ef676`.** The durable rule is now in
[AGENTS.md](AGENTS.md) → *Operational UX conventions*: a bounded operational
action asked from a Dashboard / Client / Opportunity / Application context opens
as a **modal over that page**, the full-page route survives as a **thin wrapper
around the same component**, persistent status uses the **card** language, and
copy answers first and explains mechanism second.

Two workflows brought into line with it:

- **Matching a sales call** no longer navigates away. `SalesCallResolutionModal`
  is the one implementation; a Task row (Dashboard, Contact page, mobile list)
  opens it over the page, and `/sales-calls/:id/resolve` is a 25-line wrapper
  that closes by going back in history. The ⋮ menu's Edit opens the same modal
  instead of navigating, which it used to do. An already-attached booking renders
  its "attached ✓ / View the Opportunity" state inside the modal.
- **Repairing onboarding** is a compact card — *"Onboarding needs repair / This
  client is in X, but their onboarding is still set up for Y"* — with the
  workflow in a modal. The mechanism language is gone; the plan lists only what
  changes, so a requirement called the same thing in both programmes no longer
  claims to be updated.

**Human acceptance, 2026-09-27 — one branch accepted, two open.**

- **ACCEPTED: the modal over the page, and the already-attached state.** Leif
  clicked Aurora Basso's completed matching Task; the modal opened over the
  Dashboard, the Dashboard stayed put, and it read "This booking is already
  attached to an Opportunity." with **View the Opportunity**. No navigation, no
  write.
- **OPEN: resolving a genuinely unmatched booking from the Dashboard.**
  Production has **no open matching Task** (8 exist, all closed; 28 unmatched
  bookings are historical and surface nothing). This waits on the next real
  Acuity booking that cannot be matched to exactly one active Opportunity.
- **OPEN: the repair-onboarding card and modal.** Deployed, but there is no
  legitimately stale tracked client in production to try it on, and the
  `legacy_untracked` defect (§8b-ux-fix) must ship first. **Do not click Repair
  on any client until that is deployed.**

**The Aurora audit found no invariant defect.** Her call 509 is attached to
Opportunity 292 and its matching Task is **closed**; across all of production
there are **8** matching Tasks and **0 open**, 0 open-while-attached, and 0 with
a null `sales_call_id`. What Leif saw was the resolve page's already-attached
state, which is now a modal. One latent gap is worth knowing: the
`complete_sales_call_matching_task` trigger keys on `sales_call_id = new.id`,
so a Task with a null `sales_call_id` would not be closed by it — there are
none, and every creator sets the column, so it is history-only.

## 8b-ux-fix. ONBOARDING OUTSIDE TRACKING IS NOT A REPAIR — COMMITTED LOCALLY 2026-09-27

**Deployed and HUMAN ACCEPTED 2026-09-27.** Leif checked Daniel Alexander
and Sarah Monast in production: no "Onboarding needs repair" card, the
historical onboarding still presented as not tracked, and no checklist or
Tasks created. Read-only re-check after deployment: **0 of 28** live clients
are repair candidates (20 legacy that would have been offered it before, and
all 7 tracked clients aligned).

Found by verifying the deployed repair UI against real production data rather
than by a test: it offered **"Onboarding needs repair" to
20 real clients** — Daniel Alexander, Sarah Monast, Pete Bassett, Gina
McNamara, Heidi Elias and 15 more — whose `onboarding_tracking` is
`legacy_untracked`. Clicking it would have seeded four requirements and four
pending Tasks for people who finished onboarding before the CRM modelled it.

**The invariant.** `legacy_untracked` is a statement, not a gap: this client's
onboarding was deliberately never tracked here, so the absence of a checklist is
the recorded fact. Every other consumer already said so —
`computeOnboardingProgress` returns `isLegacyUntracked` with
**`isMissingChecklist: false`**, "legacy onboarding makes no claim either
way". Repair eligibility now says the same thing: **a repair requires
`onboarding_tracking = 'tracked'`**, and the database refuses anything else
independently of the UI (`onboarding-not-tracked`, writing nothing).

**The semantic boundary, chosen deliberately.** `enrollment_onboarding_matches_offer()`
and `onboardingMatchesOffer()` keep their narrow meaning — do the live
requirement keys equal the programme's active template keys? For a legacy client
the honest answer is **no**, and teaching them to answer *yes* would leave every
future caller reading "untracked" as "aligned tracked onboarding". Eligibility is
therefore a separate layer, `onboardingRepairState()` →
`not-tracked | aligned | stale`, and tracking is checked **first**, in both the
SQL and the mirror, so a legacy client is never described as aligned.

Migration `20260926030000_onboarding_outside_tracking_is_not_a_repair.sql`
(deterministic; the builder's `20260926090000` slot untouched). Its self-proof
covers: tracked+stale still repairs to 1 of 4 · tracked+aligned still answers
`already-aligned` · legacy with no checklist refused · legacy with a partial
historical checklist refused · both refusals byte-compared to **zero writes** ·
the transfer unchanged · the ordinary offer-edit guard unchanged.

**Read-only production proof:** under the new rule **0 of 28** live clients are
repair candidates — 20 legacy that would have been offered it before, now 0, and
all 7 tracked clients aligned. Jenna stays `tracked` + aligned, her accepted
repair untouched.

## 8b-startweek-built. CLIENT START WEEK / CAPACITY UX — DEPLOYED, PARTLY ACCEPTED

**Pushed as `e8373f81` and deployed 2026-09-28.** CI fully green (build,
typecheck, ESLint/Prettier, app + functions unit tests, Playwright e2e); the
previously clock-sensitive `Dashboard.comingUp.test.tsx` passes on CI on its
own clock, which is what `d4fb08c6` pinned it for. No `supabase/` file is in
the commit, so nothing was migrated — production stayed at 143 applied
migrations, newest `20260926030000`. The live frontend was confirmed to be
this commit by byte comparison against a clean `git archive e8373f81` build.

### HUMAN ACCEPTED 2026-09-28 — the Client Edit lightbox

Leif ran it in production on **Linda Turner** (enrollment 68, active Living
Example, start week 8 Nov 2026):

- **Edit** opened **as a lightbox over her Client page**, not as a navigation
  away from it
- Status **Active**, Start Week **Nov 8 2026**, End date **blank** — all read
  correctly
- **Cancel** returned to the Client page and **nothing changed**

That is the AGENTS.md operational-UX rule holding on a real record, and the
edit form now having exactly one implementation behind two entry points.

### Still pending — they need a real production event, not a test

**None of these has a legitimate candidate today, and none may be
manufactured.** Every live LE client already has an owner-stated Start Week
(19 active + 1 onboarding, all `owner`), which is the correct outcome of the
earlier owner-statement work, not a gap:

- **"Start week not set" card** — needs a client with no Start Week. Zero
  exist among live clients; the only dateless row is a completed client the
  card deliberately excludes.
- **"Start week needs confirming" card** — needs a live `session_derived`
  date. All three `session_derived` rows are completed/ended.
- **Sale-acceptance "When do they start?" dialog** — appears only when a
  *new* individual-offer Opportunity is marked Yes. It will be accepted
  naturally on the next real Living Example sale.

They do **not** block anything behind them in the queue.

### What the audit found, before anything was designed

- **Start Week already has a source of truth**, and it is good:
  `enrollments.start_date` with `start_date_source` ∈ `owner |
  session_derived | unknown`, both-or-neither by constraint, where **only
  `owner` is canonical for capacity** (20260921130000, which found 19 of 22
  LE start dates back-filled from a booked session and stopped trusting all of
  them). `ClientEdit`'s transform was already the owner-statement path. This
  slice adds no column and no second field.
- **End is an ACTUAL end, not a projection.** The capacity engine says a
  recorded `end_date` "is somebody's decision and outranks the calendar
  arithmetic entirely"; `endEnrollment` deliberately does **not** set one
  ("the date somebody stopped is not the date the CRM was told"); the
  *projected* end is `computeExpectedEnd()`, derived at read time from Year
  Tracking and **never stored**. `accept_sale` copies only a Cohort's
  published `program_end_at`. Production agrees: of 24 LE Enrollments exactly
  **one** has an end date, and it is `ended`. **No ambiguity, so nothing was
  changed here** — and nothing derives an end into the column.
- **A missing Start Week was already conservative, and already mis-labelled.**
  `slotOccupancy` counts an Enrollment with no start date as **occupied**,
  and `computeExpectedEnd(null)` returns null, so they hold a slot for the
  whole horizon — openings can only be a floor, never overstated. But they were
  folded into `unknownEnd`, whose copy blames the calendar ("Year Tracking
  doesn't reach their 12th session week"), and `isStartWeekConfirmed` returns
  **true** for a null date, so they were absent from `unconfirmedStartWeek`
  too. A client nobody had given a start week to was reported as a calendar
  problem, sending Leif to sync a calendar that was already long enough.

### What changed

- **`missingStartWeek`** is now its own list on the capacity result, beside
  `needsCalendar` (the calendar-runs-out subset) and `unconfirmedStartWeek`
  (a date Leif did not state). The Program page names them separately: *"No
  start week yet for X — they hold a place until you set one, so these numbers
  are a minimum."* The arithmetic is unchanged; only the honesty about it is.
- **Client Edit is a lightbox** (`ClientEditModal`) over the client's own
  page, with `/enrollments/:id/edit` reduced to a thin wrapper around the same
  component. Status, Start Week and End, and nothing else.
- **Sale acceptance asks for the Start Week**, for an individual programme
  only — a group round already publishes one when Leif creates the Cohort. Yes
  opens *"When do they start?"* with a date and a **Set later**. The sale is
  recorded first and on its own; the Start Week is a separate statement about
  the Enrollment the database has just created, so a failure there leaves the
  sale standing and the client's page saying the week is unset.
- **"Set later" writes nothing** — no date, no source, no placeholder. An
  Enrollment with no `start_date` already says exactly that, and a second
  field would be a second source of truth for the same fact.
- **The unresolved work is a card on the client's page**: *"Start week not set
  — The Living Example openings count this client as taking a place from now
  on, and can only be a minimum until you set the week they start"*, with **Set
  start week** opening the same edit modal. A second card, *"Start week needs
  confirming"*, covers a date the CRM inferred.

**A Needs Attention Task was considered and deliberately not added.**
`tasks.type` is constrained in SQL, so a new kind needs a migration and an
entry in the Needs Attention inventory, whose rule is that a system Task means
a business condition exists elsewhere. The condition here is already visible
where the decision is made (the acceptance dialog) and where the consequence
lands (the client page and the Program page). If Leif finds he still misses it,
a `set_start_week` system Task is the natural next step — recorded here rather
than guessed at now.

### Production, read-only

Every **live** LE client already has an **owner-stated** Start Week: 19 active
+ 1 onboarding (Jenna, 2026-12-06), all `owner`. The three `session_derived`
rows and the one with no date are all completed/ended. So **no live capacity
number changes**, and there is no client to try the unset-week card on today.

## 8b-kit. KIT / CONVERTKIT — AUDITED 2026-09-28, BLOCKED ON LEIF

**This must not be lost.** Applications are **not** finished work until Kit
integration exists. Everything built so far (native forms, responses, the
review queue, the decisions) stops at the CRM's own boundary, and the person
on the other end still gets their email because **Leif is doing that part by
hand**: he reviews the application, records the decision in the CRM, adds or
syncs the person into Kit himself, applies the right existing Kit tag, and
lets the current emails go out. Anything built here has to replace that
sequence, not sit beside it.

**Kit is not Gmail, and the two must not be collapsed.** Kit is email-list and
marketing-automation infrastructure: subscribers, lists, tags, automations.
The future Gmail integration is individualized operational follow-up with one
person. Separate integrations, separate jobs.

**The CRM stays the source of truth** for Approved / Needs Higher Care / Not
Fit / Do Not Engage. Kit is never asked what somebody's status is.

### AUDIT — what actually exists today (2026-09-28, read-only)

Done before designing anything, as the slice required.

**1. How an Application enters the CRM — three origins, and `source` already
separates them.** `applications.source` is constrained to `public_form |
historical_import | manual`, and its column comment already states exactly why
it exists: *"the durable distinction between a live submission that represents
outstanding work and an imported historical record that represents what
already happened"*. That is the discriminator a Kit sync must key on, and it
is already there — no new column is needed to keep history out.

- **`public_form`** — the public `/apply/...` pages POST to the
  `public_application` Edge Function (no auth; an applicant has no CRM
  account), which validates and then makes **one** call to
  `submit_public_application()`. That function is a single Postgres
  transaction over Contact / Deal / waitlist conversion / Application, taking
  `pg_advisory_xact_lock(hashtext('submit_public_application:' || email))`
  first, and it **normalizes the email itself** (`lower(trim(...))`). **This is
  the one honest transactional boundary a durable Kit intent can be written
  in.**
- **`manual`** — `create_manual_application()`, also one transaction, also
  advisory-locked, called from the Applications page dialog. It writes
  `entry_path = 'other'`, never `'application_form'`, precisely so it does not
  claim a submission that never happened.
- **`historical_import`** — **161 rows in production**, of which **98 are
  still `status = 'pending'`**. These are exactly the rows that must never be
  subscribed or tagged by deploying this feature. Their pending status is
  historical truth, not outstanding work.
- **Do Not Engage is decided AT RECEIPT.** If the matched Contact is
  `do_not_engage`, `submit_public_application()` writes the Application
  straight to `status = 'do_not_engage'`, `reviewed_at = now()`, and the Deal
  to lost — with deliberately no differentiated response to the submitter. So
  "receipt" and "decision" are not always two moments, and a receipt sync must
  not subscribe somebody the CRM has just refused.

**2. How a decision is recorded — and the boundary problem it creates.** All
four live outcomes go through **one** domain action,
`applications/reviewApplication.ts` (`ApplicationReviewOutcome = approved |
needs_higher_care | not_fit | do_not_engage`; `denied` and `waitlist` are
historical-import-only and deliberately excluded from the live type). It
re-fetches the Application, refuses if it is no longer `pending`, then writes
Application status, the Opportunity update, the Contact's DNE flag where
relevant, and completes the review Task.

**The finding that matters: that is four separate PostgREST writes from the
browser, not one transaction.** There is no existing server-side boundary a
decision-time Kit intent could be enqueued in atomically. A trigger on
`applications` status change is the obvious durable enqueue point — it runs
inside the same single-statement transaction as the write that caused it —
but that is a design choice to confirm, not a fact the repo already states.

**3. Existing Kit setup: NONE.** Exhaustively searched and confirmed empty:

- no Kit / ConvertKit client, module, webhook, type or helper anywhere in the
  repo (tracked or untracked), and no Zapier-era remnant
- **no `KIT_*` secret exists in the production Supabase project** (names
  listed, values never read)
- nothing in `.env.example`, `.env.development`, `.env.e2e`
- the `configuration` singleton row is **empty (`{}`)**
- the CRM's own `tags` table holds exactly two rows, *Ghosted* and *No-show*,
  both sales-pipeline tags with nothing to do with Kit

**4. What the repo DOES already have, and what should be reused.** The
patterns exist; they just have never been pointed at Kit.

- **External API credentials** — `ACUITY_API_KEY`, `STRIPE_SECRET_KEY` as
  Edge Function secrets, read via `Deno.env.get()`, server-side only, never
  `VITE_`. `KIT_API_KEY` is the obvious name; the value is Leif's to set with
  `npx supabase secrets set`.
- **Scheduled server-side work** — `pg_cron` + `pg_net` calling an Edge
  Function over HTTP with an `x-cron-secret` header taken from the Vault
  secret `cron_invoke_secret`, and migrations that **fail closed** rather than
  schedule an unauthenticated call (`20260918130000`). This is the retry
  processor, already solved.
- **Person ↔ external system identity** —
  `contact_external_identities` + `record_external_identity()`, whose
  `provider` check currently allows `instagram | gmail | email | stripe |
  acuity | notion` and whose own comment says *"adding one is a one-line
  migration and a deliberate act"*. A Kit subscriber id belongs there, not in
  a new bespoke table.
- **Delivery that can fail, stay visible and be retried** —
  `waitlist_invitations` is the canonical shape already in this schema: a
  per-person row with `status ∈ prepared | sent | failed | cancelled`,
  `sent_at` / `failed_at` / `failure_reason`, one failure never marking anyone
  else done, and a **structural constraint that a `sent` row must carry real
  delivery evidence**. A Kit sync row should look like this, not like a
  generic job queue.
- **Provider truth stays out of core columns** — `contact_stripe_customers`
  and `deal_stripe_plan_objects` already keep provider facts in their own
  narrow tables beside the business record.

**5. Production shape, read-only.** **Five** live `public_form` Applications
exist, all still `pending`, submitted 2026-09-21 → 2026-09-28: Michelle Smith
(LE), Ruth Kirschenbaum (LE), Kseniya Prudyus (GYU, cohort 4), Kara Blossom
(GYU, cohort 4), Carey Christian (LE, today). Every one is a real person
Leif is currently handling by hand. Against them sit the 161 historical rows.
**That ratio is the whole deployment-safety problem in one number**, and it
is why receipt sync must be gated on `source = 'public_form'` (plus a
not-before timestamp), never on `status = 'pending'`.

### WHY THIS STOPPED — the mapping cannot be derived, only guessed

The architecture above is nearly all determinable from the repo. **The thing
Kit actually does is not.** There is no tag name, no tag id, no automation
description and no list identity anywhere in the repository, the database, the
environment or the deployed secrets. Every one of those is a fact about Leif's
Kit account.

And getting it wrong is not a test failure — **applying a wrong tag fires a
real automation and sends a real email to a real applicant.** Five of them are
sitting in the queue right now. That is exactly the class of decision this
project hands to Leif rather than guessing at.

**The smallest exact inputs needed to proceed:**

1. **Credential.** Which Kit API, and a key for it. Kit v4 authenticates with
   an `X-Kit-Api-Key` header; the legacy v3 takes an `api_secret` query
   parameter. They are different clients, so this is a real fork, not a
   detail. Set it as the Edge Function secret `KIT_API_KEY` — **never** paste
   it into chat, a file, or a `VITE_` variable.
2. **The receipt tags.** The exact tag Leif applies today when a Living
   Example application arrives, and the exact tag for a Growing Yourself Up
   application — by **name and id**. Plus: does a GYU applicant get a
   **cohort-specific** tag as well, or is the programme tag enough?
3. **The decision tags.** The exact tag for each of **Approved**, **Needs
   Higher Care**, **Not Fit**, **Do Not Engage** — by name and id. If Leif
   does not tag one of them today, say so; that maps to "no Kit work", which
   is an answer, not a gap.
4. **Do Not Engage.** Should a DNE person be **subscribed to Kit at all**?
   The CRM already refuses them at receipt without telling them. Subscribing
   somebody in order to tag them "do not engage" may be the opposite of what
   is wanted.
5. **Superseding.** When a decision tag is applied, must the **application
   tag (or a previous decision tag) be removed**, or do the automations
   tolerate both being present? This decides whether the sync model is
   append-only or has a removal step, and it cannot be inferred.
6. **List / form membership.** Do the automations trigger on the tag alone,
   or does the person also need to be on a particular Kit **form or
   sequence**? If it is a form, the whole model keys on forms, not tags.

**Nothing is built until these are answered.** A config-shaped placeholder was
deliberately not shipped either: a mapping table with no real values is an
invitation for the next session to fill it in with plausible-looking guesses,
and the failure mode is an email to a real person.

**Not started, and still queued behind this:** the Application Form Builder
(§8b-builder), then Gmail (§9).

## 8b-builder. APPLICATION FORM BUILDER — PARKED

Still **uncommitted**, parked in a stash while the three commits above were
made, and **restored to the working tree afterwards**. Its migration is
`20260926090000_a_form_leif_can_edit.sql`, and with it the local
`replay-manifest.json` total is **142**.

**One thing it needs on resumption, found 2026-09-27:** its own
`src/test/StoryWrapper.tsx` edit was separated out when it was parked, so the
restored tree has no `application_form_versions` collection and **25 of its
tests fail with `Undefined collection "application_form_versions"`**. Nothing
else is wrong with them. The two lines it needs — the
`liveApplicationFormSeed` import and the `...liveApplicationFormSeed(),`
spread in `createCrmDb` — are in `storywrapper-both.patch` in the parking
backup. Put them back first, before reading anything into a red builder suite.

**Do not resume it** until everything ahead of it in the queue is done:
Jenna's production acceptance, the Dashboard sales-call lightbox, the client
start-week / capacity UX, and the Kit integration. And when Applications are
eventually called finished,
**the Kit requirement above is part of that judgement** — a form Leif can edit
does not complete Applications on its own.

## 8b-schema. DECLARATIVE SCHEMA DEBT — MEASURED, RECORDED, NOT REPAIRED

`75cdfa67` repaired everything that stopped `supabase/schemas/` from
building a database at all, and everything the transfer needed. What is left is
**measured, not guessed**, and each piece needs a decision about *which side is
right* — so none of it was touched:

- `deal_payment_schedule_items_deal_id_fkey` — a **foreign key** the database
  has and the declaration does not
- stale/missing check constraints: `deals_prospect_decision_check` missing
  `'ghosted'`; `client_session_cadence_issue_events_kind_check` missing
  `'retired'`; two cadence `classification_check`s missing their
  `is null or` allowance; `deal_payment_schedule_items_stripe_provenance_check`
  **stricter** in the declaration than in reality;
  `enrollment_expected_sessions_ordinal_check` says `1..12` where the
  database says `>= 1`
- **15 indexes** absent (contacts ×4, deal_payment_schedule_items ×3, tasks ×2,
  and one each on applications, deals, enrollment_offboarding_items,
  enrollment_status_events, offboarding_requirement_templates, sales_calls)
- **3 functions + 1 trigger** of the derived-session-schedule family absent
- **4 stale function bodies**: `handle_enrollment_offboarding_started`,
  `reconcile_sales_call_tasks`, `record_sales_call_cancelled`,
  `record_sales_call_no_show`
- **RLS / policy discrepancies**: the declaration never enables RLS on
  `contact_external_identities` or `contact_merges` (and lacks their two read
  policies); it *does* enable it on `deal_outcome_events`, where the database
  has it off
- **function privilege / ACL drift**: `06_grants.sql` models only the 4
  callable RPCs, so from the declaration alone **7 functions would end up
  PUBLIC-executable** — including `merge_contacts_safely` and
  `record_external_identity` — and **44** lack the role grants the database
  has. The `proacl = NULL` trap again.
- **`comment on` is not modelled at all**

**Production is unaffected.** MAIN and every clean room are rebuilt from
**migrations**, which stay the authority; `supabase/schemas/` is authoring and
reference material, and this CLI does not even read it (`db diff` excludes it,
and `config.toml` sets no `schema_paths`). Two contract tests do read it as
authority, which is where the gap has teeth.

**Backlog — DECLARATIVE SCHEMA PARITY GUARD.** Turn the throwaway proof used
for `75cdfa67` into a durable gate: build a database from
`supabase/schemas/` alone and compare it catalog-by-catalog against one built
from the migration chain, failing on any difference. Migrations remain
production authority; the declaration gets continuously checked against them
instead of drifting for four slices at a time. Not built — recorded on purpose.

## 8c. NEXT SLICE — Waitlist quick-create

**Start with diagnosis, not implementation.** The seal audit found that
inline Contact creation already exists in the code:
`WaitlistPersonInput.tsx` has `handleCreatePerson` wired to the
autocomplete's `onCreate`, and `AddToWaitlistSheet.tsx` — the
`+ Add to Waitlist` entry point — uses that input.

And yet Leif's production try-run could not create a new person and get
them onto the waitlist in one flow. So something built does not work, and
building it a second time would leave two half-working paths instead of
one working one. **Find out why the existing path fails before writing
anything.**

One unverified suspicion to test first, not to trust: the input reads
through `ReferenceInput source="contact_id" reference="contacts_summary"`
— a VIEW — while `handleCreatePerson` creates into `contacts`. A freshly
created person may simply not resolve back through the view.

Desired behavior:

    + Add to Waitlist
      -> search existing person
      -> if no match, create the person inline
      -> save Contact + Waitlist Entry together
      -> the new person is on the waitlist immediately

Requirements to hold:

- Reuse the existing Contact when one is found.
- Inline-create only a genuinely new one.
- No navigating to Contacts first.
- The Do Not Engage guard survives.
- No duplicate Contacts.
- Desired timing and Notes stay Waitlist Entry fields, not Contact fields.
- **No fake placeholder email.** A person Leif met once may not have one.
- Fast enough to add a batch of people back to back.

### Then, in order

1. **Applications page cleanup** — the January 2027 GYU applications must
   surface as real Needs Review; stop using Historical as the catch-all;
   separate the current funnel from pre-CRM questionnaire history; give
   the page top-level All Applications / + New Application access.
   *Built and committed; **not sealed** — awaiting deployment and Leif's
   try-run. See §4 Applications for what it settled.*
2. **Pipeline Application Received → full application lightbox.**
3. **Gmail** (§9).
4. **Gmail reliability / human acceptance.**
5. **Remaining Waitlist email / batch management.**
6. **Instagram** (§10).

### SCHOLARSHIP CAPACITY MODEL REBUILD — recorded 2026-09-25, not this slice

The scholarship audit found the capacity model contradicted by real data.
Recorded here so it is not rediscovered; **deliberately not solved with the
payment slice**, and **no historical slot events are to be fabricated.**

- 3 active scholarship clients (Mel Yacovelli 75, Sam Milz 184, Gigi George
  125) and **0 slots held**. Both `scholarship_slots` rows read free.
- **Growing Yourself Up has two concurrent scholarship clients**, which
  `scholarship_slots`' `offer_id primary key` + unique-holder design cannot
  represent at all.
- `scholarship_slot_events` is empty. Migration `20260917170000` says why
  and means it: under migration mode the slot machinery is skipped, because
  *"claiming it from an import would invent an operational side effect the
  historical path exists to suppress."* That decision stands.
- Slot 2 (The Living Example) carries a stale `reserved_at = 2026-09-10`
  with no holder — residue of a development grant/release cycle.

So today, granting the LE scholarship reports the slot as free: correct per
the table, wrong about the world. The open questions are Leif's: how many
scholarships per Offer, whether the historical three should enter live
capacity at all, and whether the discount ($4,000 − $3,000) is ever a
stored fact rather than arithmetic nobody records.

Also recorded, unresolved and **not** to be auto-fixed: `deals.pricing_mode
= 'scholarship'` currently constrains nothing about money. `dealAmount.ts`
reads only `Offer.current_price`, so editing a scholarship Opportunity with
no option selected would write the **standard** price into Potential Value
(harmless today — all three have `amount = null`).

### APPLICATION STATUS VS SALES OUTCOME — separate axes, by decision

Becky's Application 171 is still `pending` while her sale is Won. **This is
not to be auto-closed.** Application review history and sales outcome stay
independent until reconciliation semantics are deliberately designed.

### PUBLIC APPLICATION RESUBMISSION / LATER-STAGE OPPORTUNITY SAFEGUARD — open debt

**Not a proven production incident. Not repaired in the Applications Program
Review Inbox slice, on purpose.**

`submit_public_application()` reuses an active Opportunity at **any** active
stage. So a public-form resubmission can attach a new pending Application to
an Opportunity already at `call_booked` or `decision`; approving that
Application later writes `stage = 'approved'` onto it and would regress the
sale.

Manual Application creation already refuses exactly this
([createManualApplication.ts](src/components/atomic-crm/applications/createManualApplication.ts)
and `create_manual_application()`, cut at `approved`). The public-form path
deliberately kept its broader behaviour: the manual safeguard was scoped to
the owner-only action being added, and widening a live anonymous intake path
was out of scope.

**The future repair should evaluate whether the public-form path needs the
same later-stage protection**, and if so whether refusing an anonymous
submission is acceptable or whether the Application should attach without the
approval being allowed to move the stage. No production row was found in this
state; nothing here says one exists.

### Infrastructure debt — tracked separately, blocks nothing above

- `users` Edge Function `SB_PUBLISHABLE_KEY` auth issue (§7).
- GitHub Pages deploy failure — the only red step in every Deploy run.
- macOS `.claude/hooks` worktree-test debt (§7).
- The broader `authenticated` TRUNCATE grant: 52 public tables grant it,
  Supabase's default `grant all` pattern. Not reachable through PostgREST,
  wider than intended.
- A pre-existing alternating pass/fail flake in **partial** test selections
  (`enrollments/` plus the capacity file). Measured on both the changed and
  unchanged tree and identical on each, so it predates the sort change. The
  full app project and the four-project CI command are green. The
  alternating pattern hints at state carried between consecutive runs.

---

## 9. Gmail (after Capacity + Waitlist)

**Must be communication-provider-neutral so Instagram reuses it.** Model a
communication fact with: provider · direction · **immutable external message
id** · Contact · related Opportunity when known · `occurred_at` ·
delivery/send state · idempotency key.

Workflow that must be provable end to end:

> Application approved → **exactly one** approval email → the correct
> Offer-specific sales-call link → send result logged → **retries do not
> duplicate**.

Also: sales-call reminders, post-call follow-ups.

Constraints: communication facts are **not Tasks**. Failures must be visible.
**Gmail-specific state must not become the universal communication model.**

---

## 10. Instagram / Meta (after Gmail acceptance)

- **Immutable Meta external user id is identity.** Username/handle is mutable
  display metadata only.
- Provider-account scoping. **Tokens and secrets never stored on a Contact** —
  they belong in secure integration secret storage.
- Webhook inbox with idempotency; **Meta retries never duplicate a message or
  an action**.
- DMs are communication facts, not Tasks. **A DM alone does not create an
  Opportunity.**
- `application_link_sent` is a meaningful CRM event.
- A later Application reconciles to an existing IG identity **only when
  deterministic**; ambiguity escalates to Leif.
- No duplicate Opportunities through DM → Application → call.
- DM activity reaches Last Activity through the provider-neutral communications
  path — `contact_last_occurred_activity()` already reads
  `contact_external_identities`, so no provider-specific branch is needed.

Phase 1 scope and the researched Meta platform facts are in
[MEMORY.md](MEMORY.md) under "Instagram Intake — Approved Architecture".

---

## 11. Working protocol

**Sound.** Active work makes no sound. Stopping needs exactly one:

```bash
afplay /System/Library/Sounds/Ping.aiff    # STOPPED + NEED LEIF
afplay /System/Library/Sounds/Glass.aiff   # STOPPED + NEED NOTHING
```

Human verification always requires **Ping**. The sound plays *before* the final
report.

**Do not make Leif do technical work Claude can safely do.**

**Git: agents never push.** Leif owns `git push`. Agents commit locally and
hand over the exact command.

---

## FRESH SESSION STARTUP

The next Claude session should, in order:

1. **Read this handoff**, then [MEMORY.md](MEMORY.md) for any slice it touches.
2. `git status` and `git log --oneline -10`.
3. `node scripts/historical-import/replayBoundary.mjs` — confirm the migration
   boundary and that local file count matches the remote version count.
4. Check the deployed state: `npx vercel ls`, and prove both halves by the
   comparison method in §3 — not by grepping for a hopeful string.
5. Read the canonical files named in §4 for whatever the next task touches —
   not the whole tree.
6. Run a small **read-only** integrity baseline and compare against §3's
   zeros.
7. **Treat the repository, the database and production as stronger evidence
   than this prose.**
8. **Surface disagreements rather than silently resolving them.**
9. **STOP before implementation and report readiness.**

**The exact next action as of 2026-09-27:** `origin/main` = `1c1ef676`,
production at 142 migrations, Jenna sealed, the sales-call modal accepted for the
already-attached branch. Push the local `legacy_untracked` fix (§8b-ux-fix) and
confirm production reaches **143** migrations; **until then do not click Repair
on any client**, because 20 legacy clients are currently offered it wrongly.
Two acceptances stay open and neither can be forced: an unmatched Acuity booking
for the Dashboard resolution branch, and a genuinely stale tracked client for the
repair card. Then the queue is the client start-week / capacity UX, Kit, and only
then the Application Form Builder.

And before calling anything finished, re-read §2's acceptance loop. **Leif's
try-run is a step in the work, not a formality after it** — schedule it while
the feature is still open to change, and keep the batch before it small.

Useful facts for step 6: `npx supabase db query --linked` runs SQL against
production and only returns the **last statement's** result; feed it SQL on
**stdin** (`< file.sql`), because `--file` hangs. `python3` is OOM-killed on
this machine — use `node`. Run the app suite serially
(`--maxWorkers=1 --fileParallelism=false`).

The reliability tooling from §8 is part of the baseline now:
`make start-supabase-e2e` builds a clean room from empty and
`make test-e2e-ci` runs the real-Postgres contracts against it. Stop that
stack (`make stop-e2e`) before running the
full browser suite — ten containers and a serial browser run compete for the
same machine.
