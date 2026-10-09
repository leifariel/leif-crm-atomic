# HANDOFF — where Atomic CRM is right now

**Current state, not history.** [MEMORY.md](MEMORY.md) is the durable knowledge
ledger — why each sealed slice decided what it decided. This file is the other
half: what is true today, where the rules live in code, and what is waiting.

Written 2026-09-20 at `451f0af0`, updated 2026-09-26 at the cross-offer
transfer checkpoint. **The repository, the database and production are the
authority. Where this prose disagrees with them, they win — say so rather than
quietly picking one.**

**Where things stand right now (2026-10-09).** `origin/main` is at
`a703303a` and production holds **157 migrations**, with nothing unpushed.
**GYU APPLICATION QUESTION PARITY is production-accepted** (§8e), after
Applications + Clients information architecture (§8d) and the testimonial /
offboarding work (§8b-testimonial-built). Two things stay deliberately parked
and must not be touched, committed, pushed or deployed: the payment commit
`c9dcc918` on `capacity-waitlist`, and the Application Form Builder, which
lives uncommitted in the main checkout's working tree (§8b-builder).

**Application decision expansion is PRODUCTION ACCEPTED** (§8f), with all six
Kit tags mapped. **The queue after it:** (1) programme configuration polish —
real payment-option configuration, "Edit cohort" naming, and waitlist
quick-add scroll preservation; (2) sales-call workflow polish — passed-but-unlogged calls stay at the
top reading "Call passed", a call-impressions / reminders field saved
atomically with the outcome as call-specific history rather than a loose note,
and editing a completed outcome including No-show → Attended with its
downstream consequences reconciled safely; (3) Gmail (§9).

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
- **Vitest is not authoritative about layout. Playwright is.** The "app"
  Vitest browser project is configured with `plugins: [react()]` and no
  `tailwindcss()`, so `@import "tailwindcss"` is never processed and every
  Tailwind utility class is **inert** in those tests. Measured: `grid` and
  `flex` compute to `display: block`, `max-w-lg` has no effect, a date
  input is 143px because that is its intrinsic size with no CSS, and an
  `absolute inset-0` stretched link has **zero size and cannot be clicked**.
  - Vitest MAY assert semantic structure, text, hrefs, ARIA, state and
    contracts.
  - Vitest MUST NOT be treated as authoritative for CSS geometry, sizing,
    click hitboxes, overlap or layout — and must not CLICK anything whose
    hitbox depends on a utility class.
  - Playwright against the real built stylesheet is authoritative for all
    of that.
  This cost three rounds of assertions that were measuring the user agent,
  and then a second round of click timeouts in a different guise. It is a
  documented test boundary, not a defect to fix in passing: adding Tailwind
  to the test project would change rendering for ~300 files and needs to be
  its own prioritised piece of work. Worked examples in §8b-stabilize.
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

**Immutable means the database refuses, not that we are careful.**
`reject_application_response_mutation` fires BEFORE UPDATE OR DELETE on
`application_responses` and refuses both — including a cascading delete
arriving from its own Application. So anything that clears Applications
has to delete children first and in order, which is why
[e2e/fixtures.ts](e2e/fixtures.ts) carries an explicit child-first table list
rather than relying on cascade. Do not weaken this for fixture convenience.

**An answer carries its own identity, and sometimes has none.**
`question_key` is the form's own key for a native submission and is NULL for
recovered history, where only the wording ever existed. Answers are therefore
deduped against `raw_answers` by `question_key` only — never by displayed
text, because two different questions may have the same answer and collapsing
them would delete a person's words
— [ApplicationAnswerSections.tsx](src/components/atomic-crm/applications/ApplicationAnswerSections.tsx).
A response set that is unknown or failed covers nothing, so a slow query can
never hide an answer.

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

### Kit identifiers are external, and are never normalized — 2026-10-05

**A Kit TAG name and a Kit AUTOMATION name are two separate external
identifiers.** They may differ in punctuation, and that difference is real
rather than a typo to tidy.

```
Growing Yourself Up   tag  GYU-NeedsHigherCare     automation  GYU_NeedsHigherCare
The Living Example    tag  MiniDD_NeedsHigherCare  automation  MiniDD_NeedsHigherCare
```

Note the GYU pair: hyphen in the tag, underscore in the automation. Both are
correct as written.

So the CRM **preserves `kit_tag_id` and `kit_tag_name` exactly as Kit holds
them**, and stores an automation name separately when it needs one. Never
rename a tag, never recreate one to match an automation, never normalize
hyphens to underscores or the reverse, and never infer one identifier from
the other. If an automation is not firing from the tag the CRM records, the
automation is configured against the existing tag — the tag is not changed to
suit the CRM.

The general rule this is an instance of: an identifier that belongs to
another system is data to carry, not a string to improve.

### Mini Deep Dive is not an Offer — SETTLED 2026-10-05

**The Living Example is the offer / programme. Mini Deep Dive is the name of
its sales call and sales pathway.** It is not a second programme, and the CRM
must never model it as one.

```
THE LIVING EXAMPLE          <- the Offer
    ↳ Mini Deep Dive        <- its sales call / application pathway

GROWING YOURSELF UP         <- a separate Offer
```

So: an LE Opportunity carries `offer = The Living Example`. An LE Application
carries the same. A Mini Deep Dive sales call still belongs to The Living
Example. And `MiniDD_*` names **in Kit** — including
`MiniDD_NeedsHigherCare`, the Needs Higher Care automation — refer to The
Living Example's pathway. The Kit name is historical naming, not evidence of
a second programme.

Never create a separate Mini Deep Dive offer row, programme, enrollment type,
pricing model, reporting category or Kit mapping namespace. Its Kit mappings
belong to The Living Example's `offer_id`, under the ordinary decision
events.

This holds everywhere the CRM reasons about Applications, Opportunities,
sales calls, Kit tags and automations, payment pages, Enrollments, reporting,
lifecycle state, and historical imports.

**If code, data or a future requirement appears to treat Mini Deep Dive as a
third offer, stop and reconcile against this before implementing.** The names
diverging between Kit and the CRM is expected; the model diverging is not.

### Client navigation — SETTLED 2026-10-04

**When a person is presented in a client-management context, navigation
opens the canonical client/enrollment profile. A Contact page is not a
substitute for a client profile.**

The route is `/enrollments/:id/show`. The reason is the one the Clients
page already recorded: the generic Contact page shows no start or end
dates, no payment state, no onboarding and no sessions.

Applies to every client list:

- **Clients** — was always correct
- **Individual programme** — Current Clients, Starting Later, Needs Start
  Week
- **Group / cohort** — the enrolled-client list on a Cohort

It does **not** apply to people who are not clients. People Deciding are
prospects with no Enrollment, and Applications route to the Application.
There is nothing to open, and inventing a destination would be worse than
the Contact page.

**Never infer the Enrollment.** Each of those lists already holds the one
it is describing: the programme lists carry `enrollmentId` on the slot
holder, and a cohort row cannot be built before `useCohortPageData` has
found its Enrollment. The database holds
`enrollments_opportunity_id_key unique (opportunity_id)` — at most one per
Opportunity — so there is exactly one and no ambiguity to resolve. A list
that genuinely could not identify one would have to say so, not fall back
to the Contact page.

Mechanically: `PersonCard`'s `rowLinkTo` makes the whole row the target,
matching the Clients page. `to` is a different prop and links only the
name — Applications use it, and overloading it turned their rows into
links and their Approve button into decoration. In a row with a
destination, everything in `trailing` is decoration unless it opts back in
with `pointer-events-auto`; without that the trailing area intercepts the
tap at the row's centre and a narrow screen cannot open the row at all.

### Start week and capacity — SETTLED 2026-10-03

Six rules. They are one domain rule stated six ways, because every page that
guessed at its own version of it produced a different number from the same
rows.

**A. A start week is Leif's decision, and only his.** Nothing infers one —
not an onboarding date, a Won date, a payment, or a booked session. Saving
the edit modal IS the owner statement, which is what promotes it to
`start_date_source = 'owner'`. Clearing it returns the Enrollment to having
no week and no source, the only honest way to say "not decided yet".

**B. No start week means no dated capacity consumption.** A commitment with
no week consumes neither an active slot nor a dated one, because there is no
date at which it could consume one. [slotOccupancy.ts](src/components/atomic-crm/capacity/slotOccupancy.ts)
calls that phase `unscheduled`.

**C. This reverses an earlier deliberate choice, and the reversal is the
point.** The old rule counted an unplaced commitment as occupying today — a
conservative floor, so openings could never over-promise. Todd Jacobsen made
a twelve-client programme read **13 / 12**, a number true of nobody, and
because an active count above the ceiling leaves nothing to offer it also
erased a genuinely open week. The floor was protecting a number at the cost
of concealing the answer.

**D. So openings may now be too generous, and the risk is carried in the
open.** Every commitment with no week is NAMED — `capacity.missingStartWeek`,
rendered by [UpcomingOpeningsSection](src/components/atomic-crm/programs/UpcomingOpeningsSection.tsx)
and by [StartWeekCard](src/components/atomic-crm/enrollments/StartWeekCard.tsx)
on the client's own page. Both used to say the opposite ("they hold a place,
so these numbers are a minimum") and now say what is true. If that copy ever
disagrees with the rule again, the copy is the bug.

**E. Capacity and the Clients list answer DIFFERENT questions, and for one
row they honestly differ.** `classifyEnrollment` answers "is this a current
client?" — a commitment with no week is live work, so yes. `slotPhaseOf`
answers "is this consuming a dated slot?" — no. Folding the two back together
is what produced 13 / 12.
[oneSourceOfTruth.test.ts](src/components/atomic-crm/capacity/oneSourceOfTruth.test.ts)
records the exception rather than asserting the two must always agree.

**F. One rule, one module, every reader.** `slotPhaseOf` has exactly one
production caller (`computeIndividualCapacity`), and the dashboard card,
the programme page and the openings ledger all derive from it. There is no
page-specific capacity arithmetic anywhere, and adding one is the regression.

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

**KIT — DEPLOYED AND OPERATIONALLY ACCEPTED 2026-09-28 (§8b-kit-live).**
**(1) CLOSED 2026-10-05 (§8b-apps-accepted).** Leif has written both
automations and the CRM records the hand-off: a delivered Needs Higher Care
tag now reads "Handed off to Kit automation." instead of claiming an email
still needs sending by hand. Verified in production on Terry Robinson
Whitney. The tag names and the automation names are different external
identifiers and both are correct — see §4 "Kit identifiers are external".
**(2)** Five live applicants predate the integration boundary and
are **manual Kit handling** — Michelle Smith, Ruth Kirschenbaum, Kseniya
Prudyus, Kara Blossom, Carey Christian. Their Application pages now say
`Kit: Not synced — email manually` so this cannot be missed. Original note:

**KIT — ANSWERED AND BUILT 2026-09-28 — SUPERSEDED, kept as the record of
what was true then.** All six questions were answered and
the integration is built, proved and committed locally (§8b-kit). **One thing
is still Leif's alone:** the two Needs Higher Care tags exist and the CRM will
apply them, but **no Kit automation is attached to either yet**, so nothing is
emailed when they land. Until he writes and attaches those in Kit, Needs
Higher Care email delivery cannot be accepted — and nothing in this repository
changes when he does.


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
3. ~~**Kit / Applications integration**~~ — **deployed and operationally
   accepted 2026-09-28** (§8b-kit-live). Delivery acceptance still waits on the
   next genuine application; Needs Higher Care email stays pending on Leif
   attaching those automations in Kit.
4. **Adopting a pre-integration applicant into Kit** — **deliberately not
   built.** The five stay manual and their pages now say so. Revisit only
   *after* a real post-boundary application has proved the live path.
5. **Resume the Application Form Builder** — §8b-builder
6. **Gmail** — §9, after the above

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

## 8b-kit. KIT / CONVERTKIT — BUILT 2026-09-28 (see §8b-kit-live for the deployed state)

**Applications are not finished work until the person reaches Kit.** Until
now the CRM stopped at its own boundary and Leif did the rest by hand: find or
add the applicant in Kit, apply the right tag, let his existing automations
send the email. This slice is that hand-work, made durable.

**Migration `20260928200000_an_application_reaches_kit.sql`.** Not pushed, not
deployed, no production row touched.

### The three rules everything else follows from

1. **Kit never holds CRM truth.** The application, the decision, the
   Opportunity and the review Task commit exactly as they did before. What is
   added is a row saying "Kit still owes us one tag", written inside the same
   transaction as the fact that caused it. Kit being down delays an email; it
   cannot make the CRM look undecided and it cannot fail a submission.
2. **The CRM applies tags and nothing else.** Subscriber upsert, tag add. It
   never adds anybody to a Kit form, sequence or automation and never
   recreates an email. Which tag triggers which email is decided in Kit, by
   Leif, with no code change here.
3. **Nothing is backfilled.** The boundary is stamped with `now()` as the
   migration runs, and the enqueue refuses anything older. The 161
   `historical_import` rows and the five real `public_form` applicants already
   in MAIN predate it by construction.

### Tag mapping — Leif's real tags, and the only ones

| Programme | Event | Tag | Id |
|---|---|---|---|
| The Living Example (offer 1) | applicant | `MiniDD_Applicant` | 24082722 |
| | approved | `MiniDD_Approved` | 21784073 |
| | needs higher care | `MiniDD_NeedsHigherCare` | 24082725 |
| | not fit | `MiniDD_Denied` | 21784076 |
| Growing Yourself Up (offer 2) | applicant | `GYU-Applicant` | 24082724 |
| | approved | `GYU-Approved` | 21481248 |
| | needs higher care | `GYU-NeedsHigherCare` | 24082732 |
| | not fit | `GYU-Denied` | 21481382 |

Seeded by the migration into `kit_tag_mappings`, keyed on the literal offer ids
the chain itself creates (`20260830130000` seeds offers 1 and 2) — the same
shape and posture as `onboarding_requirement_templates`' own seed. **A
programme with no row is simply not Kit-managed and nothing is guessed on its
behalf**, which is how the third offer, 1:1 Coaching (Legacy), stays out of
Kit. `contracts/applications/kitIntegration.test.ts` pins all eight ids.

**Do Not Engage has no tag, and that is structural.** `do_not_engage` is not
a permitted `event` value, so a mapping for it cannot exist. No subscriber is
created, no tag applied, nothing existing in Kit removed, no email triggered.
The submitter still receives the same undifferentiated response.

### The model

- **`kit_integration_settings`** — one row, `not_before`.
- **`kit_tag_mappings`** — `(offer_id, event) -> (kit_tag_id, kit_tag_name)`.
- **`kit_sync_operations`** — the outbox, shaped after `waitlist_invitations`:
  per-item status, real evidence required before a row may call itself done,
  one person's failure never marking anyone else finished. `unique
  (application_id, kind)` is the idempotency anchor — one applicant operation
  and one decision operation per application, forever, so every replay
  collides and writes nothing.
- **`contact_external_identities`** gains `provider = 'kit'`, the deliberate
  one-line extension its own comment describes. That is the canonical
  person-to-Kit link; `kit_sync_operations.kit_subscriber_id` is evidence of
  one operation, not a second identity system.

**Enqueue points.** Two triggers on `applications`:

- **receipt** — `after insert`, when `source in ('public_form','manual')` and
  `status = 'pending'`. It therefore fires inside
  `submit_public_application()`'s and `create_manual_application()`'s own
  transactions, which is the only honest boundary either path has. `status <>
  'pending'` is the Do Not Engage gate: a submission from somebody already
  refused is written straight to `do_not_engage` and creates no Kit work.
- **decision** — `after update of status`, when it leaves `pending` for
  `approved | needs_higher_care | not_fit`, **and the application already has
  an applicant operation**. `reviewApplication.ts` records a decision as four
  separate browser writes with no shared transaction; the one write that IS
  the decision is the `applications.status` update, and a trigger on it runs
  inside that statement's transaction. The applicant-operation guard carries
  all of eligibility in one condition — right origin, after the boundary,
  mapped programme, usable email — and it is also what stops the five
  pre-integration applicants being tagged the moment Leif reviews them.

**Email** is normalized at enqueue by `public.normalize_email` through the
`contact_email_addresses` view, so Kit is addressed by exactly the string the
CRM considers canonical and a later Contact edit cannot retarget work already
owed. **The tag id is resolved at enqueue and then frozen**, so retagging a
programme in Kit tomorrow does not rewrite what a row already sent.

### The worker

`pg_cron` every five minutes -> `pg_net` -> `kit_sync` Edge Function (with
`x-cron-secret` from the Vault `cron_invoke_secret`) -> Kit v4. The migration
**fails closed** if pg_cron, pg_net or the secret is absent, exactly as
`20260918130000` does.

`claim_kit_sync_operations()` takes work `for update skip locked`, so the cron
pass and Leif pressing Retry cannot take the same row, and one held row never
blocks somebody else's. A `processing` row whose attempt began more than ten
minutes ago is reclaimed — a worker that died mid-call must not leave an
applicant stuck forever, since that is the invisible work this whole slice
exists to end.

Each operation runs in its own `try`: **one person's failure never stops the
queue.** A failure records a class and a short reason, redacted of the key and
capped at 200 characters. **No credential and no provider payload is stored.**

**A bad minute at Kit does not need a human.** Three classes mean the next
pass is the fix — `rate_limited`, `provider_unavailable`, `network` — so the
operation goes **back to pending** and is simply retried, up to five attempts
(a little over twenty minutes at the five-minute cadence). The other three
mean the opposite: `auth` is a key that will be refused identically,
`rejected` is Kit saying no on purpose, `unknown` is something nobody has a
name for. Those stop as `failed` and raise the card. The class and reason are
written either way, so what happened stays legible while it is still being
retried, and the UI stays quiet about a row that is merely on its way.

### Security

`KIT_API_KEY` exists only in the Edge Function's environment, read with
`Deno.env.get`. Never a `VITE_` variable, never in `src/`, never logged, and
passed into the client as an argument so no module can reach an environment
for it. Two callers and neither may impersonate the other: the cron secret, or
a real Supabase JWT. **Retry requires a signed-in user** — checked before the
application id is even read.

`kit_sync_operations` is **SELECT-only to `authenticated`** and closed to
`anon`, with a read policy and deliberately no write policy.
`enqueue_kit_application_sync()` is revoked from everyone including
`service_role` (it is reached only through the two SECURITY DEFINER triggers),
and `retry_kit_application_sync()` / `claim_kit_sync_operations()` are granted
to `service_role` alone. **The browser cannot create Kit work and cannot name
a Kit tag id** — proved in real Postgres, not merely intended.
`public_application/index.ts` contains no reference to Kit at all.

### The UI

`KitSyncCard`, on the Application review page. Silent when there is no Kit
work. One muted line when it is done — *"Added to Kit — MiniDD_Applicant,
MiniDD_Approved."* A rounded operational card only when somebody has to do
something, saying what is true, what it costs, and offering **Retry Kit sync**.
No status codes or payloads in the primary copy; the provider's own words sit
behind a closed `<details>`. Work that is merely late gets the card but no
button, because there is nothing to re-queue. No Kit admin page.

### NEEDS HIGHER CARE — EMAIL DELIVERY IS NOT YET ACCEPTED

**The two Needs Higher Care tags exist, but Leif has not written or attached
their Kit automations yet.** So:

- the CRM **does** apply `MiniDD_NeedsHigherCare` / `GYU-NeedsHigherCare`
- a successfully applied tag **is** a successful Kit sync, and the card will
  go quiet
- that does **not** mean an email was sent, and the CRM never claims it did
- the CRM must never start a Kit sequence directly to compensate
- **human acceptance of Needs Higher Care email delivery stays open** until
  Leif creates and attaches those automations in Kit. Nothing in this
  repository changes when he does.

The new Applicant tags likewise trigger no email today. That is intentional.

### Proof

- **Real Postgres, in the migration itself**, so it runs again on every deploy
  and every clean-room replay: the boundary backfills nothing (asserted
  against the live table, not promised); the eight mappings are Leif's;
  `do_not_engage` has none; a live receipt enqueues the programme tag with a
  normalized email; a decision adds the outcome tag **without removing the
  applicant tag**; replay is a no-op; imported / pre-boundary / Do Not Engage /
  unmapped-programme receipts queue nothing; **the real
  `submit_public_application()` and `create_manual_application()` paths each
  enqueue inside their own transaction**; resubmitting is a no-op; an
  authenticated session cannot insert its own tag operation; claim / fail /
  retry / succeed transitions hold, a Kit failure leaves the decision
  `approved`, and a succeeded row is never re-queued; and nothing may call
  itself succeeded without the subscriber Kit returned.
- **Kit v4 client contract, mocked** (19 tests): the `X-Kit-Api-Key` header,
  both request shapes, success parsing, 4xx/429/5xx/network classification,
  no form / sequence / broadcast endpoint is ever called, and the key never
  reaches a stored reason even when the provider echoes it back.
- **Worker** (11 tests): subscriber before tag, the tag the row carries and
  never one it works out, failure recorded with class and reason, **one
  person's failure does not stop the queue**, an identity-bookkeeping failure
  does not undo a tag that landed.
- **State + UI** (17 tests): silence for an unmanaged application, one quiet
  line when done, the card and its copy when not, the detail disclosure stays
  shut, retry re-queues only the failed operation and leaves a succeeded one
  alone.
- **Repository contracts** (33 tests): every tag id, additive tagging, the
  boundary, origin-not-status eligibility, the credential's confinement, and
  the grant posture.
- **No automated test calls Kit.** A real call would tag a real person.

### Production acceptance plan — the next real application

**Do not sync an existing applicant to prove this works.** The acceptance case
is the next genuine submission after deployment:

1. it appears in the CRM as it does today
2. the applicant exists in Kit and carries the programme tag
   (`MiniDD_Applicant` or `GYU-Applicant`)
3. the Application page shows *"Added to Kit — …"* and no card

then, when Leif makes the real decision:

- **Approved / Not Fit** — the matching existing tag reaches Kit and **his
  existing automation sends today's email**. This is the part that proves the
  whole slice.
- **Needs Higher Care** — the tag reaches Kit and the CRM goes quiet;
  **email behaviour stays separately pending**, per the section above.
- **Do Not Engage** — nothing happens in Kit at all, which is the correct
  observation.

**Five real `public_form` applicants predate the boundary** and are therefore
NOT Kit-managed: Michelle Smith (LE, 21 Sep), Ruth Kirschenbaum (LE, 23 Sep),
Kseniya Prudyus (GYU cohort 4, 24 Sep), Kara Blossom (GYU cohort 4, 27 Sep),
Carey Christian (LE, 28 Sep). Deciding any of them will produce **no Kit work
and no card** — the CRM will stay exactly as silent about Kit as it is today,
and Leif keeps handling them by hand. **Reported only; none was synced.**
Adopting one is a deliberate act and the mechanism for it is not built: that
is the natural next Kit slice, and it should refuse `historical_import` and
Do Not Engage by construction.

### Deployment

`KIT_API_KEY` is already set in the production project. `kit_sync` deploys
with the rest (`supabase functions deploy` takes no arguments) and is
registered `verify_jwt = false` in `config.toml` because it authenticates both
its callers itself. The cron job is created by the migration.

### Recorded, not fixed — three things found on the way

- **`TRUNCATE` is granted to `authenticated` on every read-only table in this
  project**, including `application_responses`, `deal_offer_events` and
  `contact_external_identities` — a project-wide default-privilege residue,
  not something this slice introduced, and `kit_sync_operations` matches the
  existing posture exactly. RLS does not protect against TRUNCATE. Worth a
  deliberate pass across all 47 tables; out of scope here.
- **`npm run test:unit:scripts` has one failing test at HEAD**, unrelated to
  Kit: manifest entry `20260921140000` is missing `owns_durable_schema`, which
  `replayBoundary.test.mjs` asserts is `false`. That suite is **not run in
  CI**, which is why it went unnoticed. One field fixes it.
- **Migration ordering vs the parked builder.** This slice is
  `20260928200000`; the builder still holds `20260926090000`, which is now
  BELOW it. When the builder resumes, **renumber its migration above this
  one** before pushing, or `db push` will see an out-of-order version.

Queue behind this: the Application Form Builder (§8b-builder), then Gmail (§9).

## 8b-kit-live. KIT — DEPLOYED AND OPERATIONALLY ACCEPTED 2026-09-28

**Pushed as `797a4366` and deployed.** Production verified read-only: migration
`20260928200000` applied (144 total, newest, builder's `20260926090000` absent),
`kit_sync` Edge Function v1 ACTIVE, the `kit-sync` cron job scheduled `*/5`
reading the Vault secret, **two healthy authenticated worker runs** returning
`{"claimed":0,"succeeded":0,"failed":0,"requeued":0}` at 23:10 and 23:15, the
**eight tag mappings matching the contract exactly with zero mismatches**,
`not_before = 2026-09-28 23:04:40.659+00`, **zero `kit_sync_operations` rows**,
**zero Kit identities**, the five pre-boundary applicants untouched, the live
frontend byte-identical to a clean build of the commit, and **no Kit credential
anywhere in the browser bundle**. `KIT_API_KEY` exists in the production project
by name only.

**One thing was not green and is deliberately closed:** the CI `e2e-test` job
failed on this commit (run `36495902229`; every other job green, including the
app unit project). Its log is unreadable without repository admin rights. The
**exact clean commit was run twice with the same command CI runs**
(`make test-e2e-ci`, clean-room rebuild then Playwright) and passed **161/161,
exit 0, both times**. The same job also failed once before on an unrelated
commit (`2a1eab80`). **Treated as an isolated CI flake and closed — do not
reopen it without new evidence**, such as a second failure or a readable log.

### THE MANUAL DECISION EMAIL WORKLOAD — read-only, 2026-09-28

Every application whose CRM decision will **not** create Kit decision work,
and whose decision email is therefore still Leif's to send by hand. Criteria:
`source in ('public_form','manual')`, created before `not_before`, still
`pending`. There are **exactly five**, and **no `manual`-source application
exists at all**.

| Name | Programme | Cohort | Submitted | Status | Source |
|---|---|---|---|---|---|
| Michelle Smith | The Living Example | — | 2026-09-21 | pending | public_form |
| Ruth Kirschenbaum | The Living Example | — | 2026-09-23 | pending | public_form |
| Kseniya Prudyus | Growing Yourself Up | January 2027 | 2026-09-24 | pending | public_form |
| Kara Blossom | Growing Yourself Up | January 2027 | 2026-09-27 | pending | public_form |
| Carey Christian | The Living Example | — | 2026-09-28 | pending | public_form |

**MANUAL DECISION EMAIL LIST**

- Michelle Smith — The Living Example
- Ruth Kirschenbaum — The Living Example
- Kseniya Prudyus — Growing Yourself Up / January 2027
- Kara Blossom — Growing Yourself Up / January 2027
- Carey Christian — The Living Example

All five: `pending`, pre-boundary, **0 applicant operations, 0 decision
operations, 0 Kit identities**. Their Opportunities all sit at
`application_received`.

**JANUARY GYU — MANUAL DECISION EMAIL LIST**

The upcoming January cohort is **cohort 4**, proved from production dates
rather than its name: `program_start_at = 2027-01-19`, `program_end_at =
2027-03-09`, applications open until `2027-01-17`, `status =
applications_open`. The only other GYU cohort (3, Fall 2026) started
2026-09-22 and is `applications_closed`.

- Kseniya Prudyus — Growing Yourself Up / January 2027
- Kara Blossom — Growing Yourself Up / January 2027

Cohort 4 holds 13 applications in total; the other **eleven are
`historical_import`** (5 approved, 6 preserving a `pending` status that is
history, not work) and are deliberately excluded.

### THE COMPACT KIT STATUS LINE

One question, answered at a glance on the Application: **is Kit handling this,
or is the decision email mine?** One shared derivation,
`applications/kitStatus.ts`, rendered by `applications/KitStatusLine.tsx`. It
reads **only durable CRM evidence** — the application's own `source` and
`status`, and the `kit_sync_operations` rows — and **never calls Kit**, which a
test proves with a `fetch` spy.

| Line | When |
|---|---|
| `Kit: Tagged ✓` | everything the **current** CRM state requires has succeeded |
| `Kit: Syncing…` | required work is pending or processing |
| `Kit: Needs attention` | a required operation failed, or has waited over 30 minutes |
| `Kit: Not synced — email manually` | a live `public_form`/`manual` application Kit is not handling |
| `Kit: Not used` | `do_not_engage` — the CRM refused them and Kit is deliberately out of it |
| *(nothing)* | `historical_import` — finished history, no work for anyone |

**What "the current state requires" means.** A pending application owes only
its programme tag. One Leif has decided (`approved`, `needs_higher_care`,
`not_fit`) owes the outcome tag as well — so **an approved applicant whose
outcome tag never reached Kit does not read as finished**, which is the whole
point. `do_not_engage` requires nothing.

**Two precedence rules, both deliberate.** A failure outranks everything,
including `do_not_engage`: in the ordinary refusal case there is no failed row
so nothing untrue is implied, but a row that failed *before* the refusal must
not be buried, because a buried row is exactly the invisible work this
integration exists to end. And an imported record and a live applicant both
have **no** Kit operations while meaning opposite things — `source` is the
discriminator, and **`historical_import` can never be presented as current
unsynced work** (98 of them carry a `pending` status; showing them as manual
email work would teach Leif to ignore the line that matters).

**Healthy is now one muted line, not a card.** The old `Added to Kit —
MiniDD_Applicant, MiniDD_Approved.` exposed tag names in primary copy; they
now sit behind a closed **Kit detail** disclosure, still there for debugging a
sync. The rounded card and **Retry Kit sync** survive unchanged for the one
actionable state. Work that is merely late gets the card with no button,
because there is nothing to re-queue.

**When the Application Form Builder resumes, its review lightbox MUST reuse
this exact shared `kitStatus` derivation and `KitStatusLine`** — not a second
opinion. A contract test refuses any other production module that decides
these labels.

**No adoption button exists, on purpose.** Nothing offers to Add to Kit, adopt
or backfill an old applicant, and a contract test holds that. The live Kit path
has not yet been human-accepted on a real post-boundary application; until it
has, the five above stay manual. Whether a tiny explicit adoption path is worth
building is a decision for **after** that acceptance.

### STILL THE HUMAN ACCEPTANCE EVENT: THE NEXT GENUINE NEW APPLICATION

Nothing here changes it. On the next real submission: it appears in the CRM →
the applicant exists in Kit with the programme tag → the Application reads
`Kit: Tagged ✓`. Then on the real decision: **Approved / Not Fit** → the
outcome tag lands and Leif's existing automation sends today's email (the part
that proves the slice); **Needs Higher Care** → the tag lands and the CRM goes
quiet, but **email delivery stays separately pending** because Leif has not yet
written or attached those two Kit automations; **Do Not Engage** → nothing in
Kit at all.

### FIRST GENUINE AUTOMATIC ACCEPTANCE — TERRY ROBINSON WHITNEY, 2026-09-29

**The automatic path proved itself in production, on a real person, unaided.**

At **16:59:22Z** a real application arrived: **Terry Robinson Whitney**, Growing
Yourself Up · January 2027, `public_form`, post-boundary. The receipt trigger
enqueued his programme tag in the same transaction. The five-minute worker
picked it up and at **17:00:02Z — forty seconds later — it succeeded**:

```
application 204 → subscriber 4315021388 → GYU-Applicant (24082724)
status succeeded · attempts 1 · no failure
```

**Application → Kit subscriber → correct programme tag is accepted.** Nobody
intervened; it is provider-confirmed; and it happened on `797a4366`'s code.

**Acceptance remains partially open** on two counts, and neither undoes the
above:

1. **The canonical identity defect** found in the same verification pass, fixed
   in `20260929230000` and **not yet deployed**. Until it is, Terry has no
   `contact_external_identities(provider='kit')` row, so **Manage Kit tags**
   reports him as "not in Kit yet" even though Kit demonstrably knows him.
2. **Outcome/decision tag acceptance**, which still waits for a real decision
   on a post-boundary application. Approved and Not Fit tags fire live email
   automations, so that event is Leif's to create in the ordinary course of
   work, never a test.

### THE IDENTITY DEFECT, AND WHY IT WAS INVISIBLE

Two causes, both real, both fixed.

1. **The grant.** `20260919130000` revoked `record_external_identity()` from
   `public` and `anon` and **never granted it to `service_role`**. Its live ACL
   was `postgres=X` and nothing else, so the worker — which runs as
   `service_role` — was refused every time.
2. **The worker never read the answer.** `supabaseAdmin.rpc()` **returns** an
   error rather than throwing one, so the `try/catch` around the call never
   fired and the refusal was simply discarded. This is the more important half:
   the first cause would have been obvious within minutes if the second had not
   hidden it.

Nothing about the provider was wrong. The tag landed; only the bookkeeping
failed. Diagnosis was confirmed rather than assumed: Terry's address resolves
to exactly one Contact (463), the provider check already allows `'kit'`, and
the subscriber id was recorded on the operation all along.

### THE FIX

- **`grant execute on function public.record_external_identity(...) to
  service_role;`** — `anon` and `authenticated` stay refused. Recording an
  external identity is the CRM's own server-side work, never a browser's.
- **`reconcile_kit_identities()`** — one query, one authority, one purpose. It
  finds people whose succeeded Kit operation carries a subscriber id but who
  have no Kit identity, and records it through `record_external_identity()`.
  **It never calls Kit**, never writes a tag operation, and never re-tags
  anybody. `service_role` only.
- **The worker now reads the identity answer**, counts a refusal as
  `identityProblems` in the pass summary — which lands in the cron response
  body and so in durable evidence — and **still marks the tag succeeded**,
  because Kit really did apply it. Failing the operation would ask Leif to
  retry work that already worked.
- The sweep runs **once at the start of every pass**, before any tag work.

**An address two Contacts share is left alone.** `record_external_identity()`
answers `ambiguous` there, and the sweep counts nothing and writes nothing — a
shared address is a decision for a person, and a sweep that resolved it would
be inventing an identity rather than recording one.

### TERRY REPAIRS HIMSELF

**No manual action, and no second Kit call.** Once `20260929230000` deploys,
the next five-minute pass finds his succeeded operation, reads the subscriber
id `4315021388` already stored on it, and records the identity. His address
maps to exactly one Contact, so it resolves. The tag operation is untouched.

Proved on a fixture in the exact same state: succeeded operation with a
subscriber id and no identity → repaired, once, with no provider call and no
second operation; repeating the sweep forks nothing; and a deliberately shared
address is left unresolved.

**Watch for it in the cron response body:** the pass that repairs him will
report `"identitiesRepaired":1`.

### THE FIRST DEPLOY ATTEMPT FAILED, AND THE PROOF WAS AT FAULT

`e6d703ad` was pushed on 2026-09-29 and **did not deploy**. `📡 Push supabase
migrations` failed, so the function deploy and everything after it were
skipped; the whole migration rolled back in its own transaction. Production
stayed on **145** applied migrations, newest `20260929120000`, `kit_sync` on
the previous build. No partial state, no second Kit operation, and Terry
still unrepaired. The Check run was green throughout, e2e included.

**Nothing was wrong with the repair. The fixture was wrong.** The proof block
built its fixture with Terry's *real* subscriber id, `4315021388`. On MAIN the
sweep does its job and records that id against the real Terry first, so when it
reached the fixture, `contact_external_identities_global_key` — `unique
(provider, external_user_id) where provider_account_id is null`, one provider
identity naming at most one human — made `record_external_identity()` answer
`'known'` about *Terry*, and no row appeared for the fixture. The assertion
then raised a plain error, which is not the `restrict_violation` sentinel the
block catches, so it escaped and aborted the push.

The correction is the fixture and nothing else: synthetic subscriber ids
(`proof-kit-subscriber-20260929230000`, `proof-kit-shared-20260929230000`) that
cannot name a real person, because Kit only ever issues decimal integer ids and
these carry a hyphen. The idempotency check is also now counted on the
fixture's own identity rather than on every Kit identity in the database —
counting rows real people legitimately own was what made a fixture answerable
to production data in the first place.

**The lesson, which outlives this migration:** a self-proving migration runs
against MAIN's real rows, so a fixture that borrows a real identifier is not a
fixture — it is a collision waiting for the one environment that matters. Test
data must be unmistakably synthetic *by construction*, not merely unused.

Proved against the production shape the first clean room failed to model: a
seeded Terry-like row carrying `4315021388` with no identity, at the exact
pre-state (`record_external_identity` ACL `postgres=X` only, no sweep). The old
file fails there with the identical error and line; the corrected file applies,
and the real row then repairs to `4315021388` while the fixture repairs to its
own synthetic id, neither colliding, the operation untouched, no provider call.

## 8b-kit-gmail. GMAIL TAKEOVER — A SEQUENCE THAT MUST NOT BE IMPROVISED

**This is a hard prerequisite for the Gmail integration (§9) and it must
survive every future chat.**

**The situation it protects against.** A population of older applicants were
never reliably added or tagged in Kit — the 161 imported records, and the five
live applicants above. Any future backfill that adds them to Kit *with outcome
tags* would, with today's configuration, **fire Leif's existing
application-decision automations and email people about decisions made months
ago**.

**So the order is fixed, and the first step is not optional:**

1. **FIRST, make the email automations safe.** Disable, detach, or otherwise
   prevent the existing Kit application-decision automations from firing off
   historical or backfill tags. Nothing else in this sequence may begin until
   that is done and verified in Kit.
2. **ONLY THEN, perform the deliberate one-time backfill.** Upsert the missing
   subscribers, apply the correct programme/applicant tags, and apply
   historical outcome tags **only where they are deliberately useful** — never
   as a reflex, and never in a way that sends a historical decision email as a
   side effect.
3. **Then Gmail becomes authoritative** for individualized
   application-decision sending: the CRM composes and Gmail sends, with the
   send logged and idempotent (§9). **Kit stays what it is** — subscriber,
   list and tag infrastructure — and stops being the thing that sends a
   decision email.

**Do not reorder these. Do not fold the backfill into the Gmail build. Do not
let a later session "just backfill the tags first" —** that is precisely the
mistake this section exists to prevent, and its cost is real email to real
people about decisions they already heard about.

**Also still true and unchanged:** the two Needs Higher Care tags
(`MiniDD_NeedsHigherCare` 24082725, `GYU-NeedsHigherCare` 24082732) exist and
the CRM applies them, but **Leif has not written or attached their Kit email
automations**, so a green sync there does not mean an email went out and the
CRM never claims it did. Nothing in this repository changes when he attaches
them.

## 8b-kit-owner. KIT OWNER CONTROLS — BUILT 2026-09-29

**Five commits, none pushed.** `288da40b` schema and authorities, `36aadfef`
the Kit v4 catalog, then the manual-mode status and presentation fix, and the
owner-facing surfaces on top of them.
**The owner-facing surfaces are now built** — see the end of this section for
the one that was deliberately deferred.

### Why this slice exists

`b207c04b` put `Kit: Not synced — email manually` on the Application. Leif
confirmed it on Michelle Smith: **the information was right, in the right
place, and the presentation was wrong** — naked text floating between two
cards. And it told him to act without giving him any way to.

Underneath that were two bigger gaps: which tag a programme applies was a
number only a migration could change, and the five people who predate the
integration had no route into Kit at all.

### Three concerns, kept apart

Collapsing them is how a "Kit status" stops meaning anything.

| | Question | Where it lives |
|---|---|---|
| **Configuration** | which tag should a FUTURE event apply? | `kit_tag_mappings`, `cohorts.kit_tag_id` |
| **Manual work** | which tag does Leif want on THIS human? | an operation with `origin = 'manual_owner'` |
| **Operational** | who needs Kit attention right now? | derived, never stored |

### The rule that makes configuration safe to hand over

**Changing a mapping changes nothing that already happened.** Every operation
freezes its tag id at enqueue, so a new tag reaches new events and nothing
else — no historical retagging, no rewriting a pending row, no backfill. The
migration asserts exactly that, and that **clearing** a mapping stops new work
rather than falling back to a guess. Contract tests pin it too.

`set_program_kit_tag(offer, event, tag_id, tag_name)` is the only way in, and
it never touches `kit_sync_operations`.

### The outbox learned three things without losing what it guaranteed

- **a cohort tag** — `cohorts.kit_tag_id` is optional and **additive**: the
  round's applicant gets the programme's tag AND the round's, as two separate
  auditable operations, not one that quietly did two things. Configuring it
  afterwards does not reach back.
- **a manual tag** — an operation about a person, with **no application at
  all** (it may merely *mention* the one it was started from).
- **who asked** — `requested_by`.

The deployed guarantee survives exactly: `unique (application_id, kind)`
becomes **partial**, scoped to `origin = 'automatic_application'`. Manual work
gets its own anchor beside it: `unique (contact_id, kit_tag_id) where origin =
'manual_owner'` — one operation per person per tag, which is also what Kit
itself does, so the two agree. **Asking twice is the same request.**

`request_kit_manual_tag()` runs through the same worker, evidence and retry as
everything automatic. It is not a button that calls an API and hopes. It
**refuses somebody marked Do Not Engage**, because a manual route around that
decision would make the refusal decorative.

### The browser reads configuration and writes nothing

`kit_tag_mappings` and `kit_integration_settings` became **readable** by
`authenticated` (the Programme page has to show its tags; the Application has
to know whether it predates the boundary) and stay **unwritable** — no
insert/update/delete policy, both authorities are validating RPCs. Proved by
attempting both writes as `authenticated` and requiring the refusal.

### Kit v4, confirmed against the real contract

Checked against Kit's own published reference, not assumed:

| Need | Endpoint | Behaviour |
|---|---|---|
| list tags | `GET /v4/tags` | cursor-paginated, ≤1000/page |
| create tag | `POST /v4/tags` | **idempotent on name, case-insensitive** — 200 returns the existing tag |
| tag a person | `POST /v4/tags/{id}/subscribers` `{email_address}` | **200 when already tagged** |
| a person's tags | `GET /v4/subscribers/{id}/tags` | cursor-paginated, with `tagged_at` |

**This also confirms the already-deployed worker's endpoints are correct**,
which de-risks the pending automatic acceptance. Creating a tag attaches it to
nobody. All four new Edge Function actions are **owner-only**, checked in one
place: the cron secret proves a schedule, and a schedule has no business
creating a tag or tagging a person.

### Manual mode, and the status that tells the truth about it

`kitStatus` is one shared derivation, now taking the application, its
operations, the mappings, the round's tag and the boundary.

| Line | When |
|---|---|
| `Kit: Tagged ✓` | automatic, and every tag the CURRENT state needs has landed |
| `Kit: Syncing…` | automatic, on its way |
| `Kit: Needs attention` | a refusal, or work waiting over 30 minutes — card + Retry |
| `Kit: Manual — action needed` | predates the integration; the named tags are Leif's |
| `Kit: Manual — up to date ✓` | every tag the CURRENT state needs is provider-confirmed |
| `Kit: Automation not configured` | this programme has no Kit tags |
| `Kit: Not used` | Do Not Engage |
| *(nothing)* | `historical_import` — finished history |

**Manual is never called Tagged.** "Tagged" claims the automatic integration is
following that person's lifecycle; for a pre-boundary application it is not,
and a later decision makes the work manual again — Michelle pending needs
`MiniDD_Applicant`; Michelle approved needs `MiniDD_Approved` as well and she
**re-enters the queue**. The strip names the tags, with `✓` / `○`, because
"add the tags" is not an instruction until it says which.

### The presentation fix

The strip now lives **inside the Application's own card, at the foot of Review
Decision** — where Leif looks straight after deciding — in the CRM's bordered
container language (`rounded-md border px-3 py-2`), not naked text between two
cards. The actionable failure state still expands into the existing rounded
card with **Retry Kit sync**. Two tests assert the housing and the placement,
so the floating version cannot come back.

### THE OWNER-FACING SURFACES — BUILT 2026-09-29

The seven surfaces the foundation existed for. **Leif can now configure and
operate Kit from the CRM without a code change.**

**Shared tag picker** (`applications/KitTagPicker.tsx`). Loads his real tag
catalog through the Edge Function, searches it by name, selects **by provider
id**, and creates a tag without leaving the CRM. Kit's create is idempotent on
name, case-insensitively, so an existing name comes back as the existing tag
and is simply selected — the button is offered only when nothing already
carries that exact name, because otherwise it would describe something that is
not about to happen. Loading and provider-failure states are explicit; a failed
catalog says so rather than showing an empty list. **No numeric tag id is ever
typed again.**

**Contact — Manage Kit tags** (`contacts/ManageKitTagsButton.tsx` →
`applications/ManageKitTagsModal.tsx`). A lightbox over the Contact. Shows what
**Kit reports** for that person — fetched on demand, only while the modal is
open, so no ordinary page render depends on the provider being up — alongside
what the **CRM has queued or failed to deliver**. Those two are named
separately rather than blended. Adding a tag creates a durable manual
operation; the modal **stays open**, because the tag is queued and not yet
done. The button is absent for a Do Not Engage contact, whose manual tag the
database refuses anyway.

**Application — the same manager.** Not a second tag universe: the Application
reaches the identical modal with its own id attached for provenance. A manual
tag belongs to the human either way.

**Programme Kit configuration** (`offers/OfferKitSection.tsx`) in the existing
Offer form. Four events, each through the picker, saved by
`set_program_kit_tag` — change, choose, or clear. Incomplete configuration
says **"Kit automation not fully configured"** rather than looking finished,
and the section carries the rule in one line: *"Changes apply to future Kit
actions. Existing applicants are not retagged."* On a programme that does not
exist yet it says to save first and configure immediately after, rather than
contorting the create transaction into a multi-write illusion.

**Cohort Kit tag** (`cohorts/CohortKitTagInput.tsx`), optional, both-or-neither,
with the same future-only sentence. Empty is normal.

**One aggregate Dashboard item** (`dashboard/KitNeedsAttention.tsx` +
`useKitWorkQueue.ts`) — **`Kit needs attention · N`**, derived, never stored.
**No Task row per person:** five people needing a tag is one thing to do, and a
Task each would bury the rest of Needs Attention under work that resolves
itself. It disappears at zero. Clicking opens a modal **over** the Dashboard
with two sections — **Manual Kit work** (name, programme/cohort, application
status, each required tag as `✓` or `○`, and **Add required tags**) and **Sync
problems** (reusing the existing retry authority, no duplicated retry code).

**Add required tags** is deterministic, not a checkbox. It enqueues exactly the
tags the application's **current** state calls for and has not had confirmed —
never a tag that already succeeded, and Leif never picks a decision tag from
it. Rows leave the queue because the evidence changed, not because anything was
ticked.

**Automation safety** (`applications/kitAutomationRisk.ts`). The CRM cannot read
Kit's automations, so it reports what the *configuration* implies and never
invents provider evidence: an **approved** or **not fit** tag gets one concise
confirmation — *"Add MiniDD_Denied? This tag is connected to one of your Kit
email automations."* — and applicant and cohort tags add silently. **Needs
Higher Care** says the opposite out loud: the tag lands and
**"Needs Higher Care email still needs to be sent manually."** appears on the
Application, because Leif has not written that automation. Tag success is never
presented as email success.

**One derivation everywhere.** The Application strip, the Dashboard queue and
Add required tags all ask `kitStatus` / `requiredKitTags`; a contract test
refuses any second production module that decides those labels.

**Manual Application creation — DEFERRED, deliberately.** The dialog is
builder-clean, but the slice was already at its limit and this is the one
surface whose value is smallest (Leif creates few manual applications, and the
programme's Kit configuration is inherited automatically either way). When it
is wired it must reuse `KitTagPicker` for the optional extra tags and
`addKitTag` for the durable operations — **not** a new mechanism, and **not** a
programme-mapping editor inside Application Create.

**Still not in scope:** bulk tagging, tag removal, renaming or deleting tags in
Kit, and any automatic adoption or backfill. **Manual tagging is not automatic
adoption:** tagging Michelle by hand records provider-confirmed manual evidence
and does **not** make her Application eligible for the automatic decision
trigger.

**The automatic path is now accepted** — see "First genuine automatic
acceptance" below for Terry Robinson Whitney, and for the one defect that
acceptance exposed. **Unchanged:** the Gmail takeover sequence
(§8b-kit-gmail) — make Kit's decision automations safe FIRST, only then
backfill.

## 8b-kit-manual. MANUAL KIT TAGGING — HUMAN ACCEPTED 2026-09-30

**Michelle Smith, and she was the right person for it.** Leif pressed **Add
required tags** on her Application before finishing the look/cancel sequence —
ahead of schedule, but this was exactly the safe first case: a pre-boundary
applicant, still `pending`, owing one applicant tag and no decision at all.

Verified read-only in production, and every part of it is what it should be:

| | |
|---|---|
| operation | `id=22`, `application_id=187`, `contact_id=423` |
| kind / origin | `manual` / `manual_owner`, `requested_by='owner'` |
| tag | `24082722 MiniDD_Applicant` — **the applicant tag only** |
| status | `succeeded`, `attempts=1`, 16:14:12 → 16:14:13 |
| provider evidence | `kit_subscriber_id = '4294987335'` |
| canonical identity | `contact_external_identities id=10`, `provider='kit'`, same subscriber |

**No decision tag was applied, and none could have been:** her Application is
still `pending`, and a pending application has no decision event to map. There
is exactly one manual operation for her, no duplicate, and **no
`automatic_application` row was fabricated** — manual tagging does not make a
pre-boundary applicant eligible for the automatic trigger, which is the
distinction §8b-kit-owner exists to protect.

Her Application now derives **`Kit: Manual — up to date ✓`** with **✓
MiniDD_Applicant** and no `Add required tags` button, because nothing is owed.
She is gone from the actionable queue, which is why the aggregate went **5 →
4** — the right reason, not a filter change. The other four pre-boundary
applicants (applications 188, 189, 192, 195) are untouched and still `pending`.

**Outcome/decision-tag automation acceptance remains OPEN.** It needs a real
post-boundary decision, and no post-boundary application has been decided yet.

### AUTOMATIC KIT RECEIPT — ACCEPTED / SEALED

Proved three times over by real people, not once: applications **204** (Terry
Robinson Whitney), **211** and **212**, each public application → durable
receipt operation → Kit subscriber → correct `GYU-Applicant` → succeeded
operation → canonical Kit identity → owner UI resolving provider state.

## 8b-kit-ux. KIT OWNER-CONTROL UX REPAIR — COMMITTED LOCALLY 2026-09-30

Human acceptance found four presentation faults. None of them touched
architecture, provider semantics, eligibility, mappings or the worker; all four
were about where things sat on the page.

**1. Kit had a strip of its own.** `Kit needs attention · 4` was a full-width
band below every task card, which made Kit read as a separate system Leif had
to remember to check. It is now **one derived row inside the existing Needs
Attention box** — `Kit` / `4 applicants need attention` / `Open`.

**The count distinction, which is the part worth protecting:** Needs Attention
counts **rows of work**, and Kit contributes **exactly one** however long its
queue is. The row states the **people**. Two Tasks plus Kit is **3**, never
2 + 4 = 6. `useKitNeedsAttentionCount` returns `{ rows, people }` precisely so
the two can never be confused, and the test that pins it fails on 6. Still no
persisted Task per applicant — placement changed, derivation did not.

**2. The work modal laid every row out differently.** Each row was
`flex-wrap` + `justify-between`, so the action sat on the right when the text
beside it was short and dropped under it when it was long: Ruth right, Kseniya
and Kara left, Carey right again. It looked accidental because it was. One
`KitWorkRow` component now decides the layout for every entry from the
container — `minmax(0,1fr) auto` — and stacks identically below the small
breakpoint. Sync problems use the same row, so the two sections read as one
list.

**3. Program Kit mappings floated as loose labels** inside the larger form.
They are now in a small bordered `KitConfigBox`, the same rounded-border
language `KitStatusLine` already uses.

**4. Cohort Edit printed a list of Kit tags merely because it had opened.**

### The Cohort tag list was a picker defect, not a Cohort defect

`KitTagPicker` fetched the catalog in a `useEffect` **on mount**, and with an
empty search box rendered `catalog.slice(0, 8)` — the unfiltered head of the
list. Mounted on a passive configuration form with nothing configured, that
printed GYU-NeedsHigherCare, MiniDD_Applicant, "Imported September 13th…" under
a heading that had asked for nothing. It looked random. It was alphabetical-ish
catalog order.

**Fixed at the root, not with CSS.** The picker takes an explicit `active`
selection mode, **off by default**: inactive, it fetches nothing and renders
nothing. Rendering a catalog is now something a caller has to ask for, so the
defect cannot return by somebody reusing the picker on a new form.

Both configuration surfaces now follow the CRM's bounded-action convention:
current value (or `Not set`) plus **Choose/Change**, opening a small
`ChooseKitTagDialog` that hosts the picker. Cancel writes nothing. The
Contact/Application **Manage Kit tags** modal passes `active` and is unchanged
— it *is* the act of choosing.

**Acceptance cases pinned in tests:** Fall 2026 and January 2027 both render no
catalog on load; January 2027's real production value is **Not set**; the
catalog and its search appear only inside the lightbox; cancel writes nothing;
a configured tag renders as a value rather than a search box; create-tag
survives; future-only semantics unchanged.

**No migration.** Production behaviour, eligibility and tag mappings are
untouched — this slice moves and contains UI, and repairs one component's API.

## 8b-import. `historical_import` IS PROVENANCE, NOT LIFECYCLE — 2026-09-30

**Read this before touching anything that branches on `source`.**

`source = 'historical_import'` says **how a record arrived**: through the
Notion migration. It has never said **when it belongs to**. Conflating the two
is a defect that has now cost real work twice.

Taylor Carr applied to Growing Yourself Up — January 2027 on 28 August. Her
four answers are real, current and on the screen. Her cohort is still taking
applications. And her Application page could only say *"No sales opportunity is
linked to this application, so a decision cannot be recorded here yet"* —
because the import never gave her the Opportunity that every review outcome
writes to alongside the Application (`reviewApplication.ts`).

`reviewApplication` has **no source check at all**. Nothing was gatekeeping her
on provenance. The single missing thing was the Opportunity.

### The app already knew she was current work

`classifyApplication()` puts an imported **pending** Application aimed at a
cohort **still taking applications** into `needs-review`, and its own comment
names the case: *"the six January 2027 records"*. That classification is
reused here rather than replaced — it is the canonical current-vs-historical
distinction and it is correct.

### What was genuinely missing: `applications.crm_adopted_at`

One nullable timestamp, and it is **not** a second classification. It answers
the one question nothing else could: **has the owner deliberately brought this
imported record into current operations?**

- *"Has an Opportunity"* cannot answer it — four already-approved January
  imports have one and must stay out of today's queues.
- *"Is classified needs-review"* cannot either — that is already true of Taylor
  **before** anybody decides anything. It is the condition for OFFERING the
  act, not evidence of it.

**`source` stays `historical_import` forever.** Rewriting it to `manual` would
claim Leif typed answers the applicant wrote herself.

### The authority — `adopt_imported_application(application_id)`

`20260930120000`. One transaction, SECURITY INVOKER, advisory lock, mirroring
`create_manual_application()`'s invariants rather than its signature: same
`deal_is_active()` predicate, same reviewable-stage rule, same
`application_received` stage, same `entry_path = 'other'`.

Eligible only when: imported · `pending` · not already adopted · no Opportunity
· intended cohort `applications_open`.

| Situation | What it does |
|---|---|
| no active Opportunity for this person+programme | **creates** one at `application_received` |
| exactly one, at `interested`/`application_received`/`approved` | **links** it, never duplicates |
| one at `call_booked`/`decision` | **refuses** `later-stage` |
| an active sale on another footing (e.g. no cohort) | **refuses** `other-active-sale` |
| more than one active | **refuses** `ambiguous-opportunity` |
| replay / double click | **`already-adopted`**, writes nothing |

**Stricter than `create_manual_application` on purpose:** an Application
already carries the person, programme and round, so nothing has to be inferred
— and anything not certain is refused rather than guessed. *Atomic handles
certainty; Leif handles ambiguity.*

### Adoption reaches NO provider, and that is structural

Not remembered — guaranteed by triggers that already exist:
`on_application_kit_receipt` fires **AFTER INSERT** only (adoption updates),
and `on_application_kit_decision` fires only **when status changes** and only
when an applicant operation already exists. Adoption does neither.

The Kit migration's own comment says why this is right: an imported receipt was
never Kit-managed, so *"adopting them stays a deliberate act"*.

**After adoption Kit is MANUAL**, never automatic: `Manual — action needed`,
requiring `GYU-Applicant` (plus the cohort tag only if one is configured — both
live cohorts have none). Approve her later and `GYU-Approved` joins the
requirement, with the existing automation warning. She joins the **one
aggregate** Kit needs-attention row; no Task is created for her.

### January 2027 census — 16 applications, 11 imported

| | |
|---|---|
| **CURRENT IMPORTED — PENDING, adoptable now (4)** | **Taylor Carr (148)**, Jessie (96), Lena (145), Cristina Luca (147) |
| **CURRENT IMPORTED — PENDING, refused pending Leif (2)** | Samantha Herold (97) → live GYU deal 268 at `call_booked`, no cohort · Celia (146) → live GYU deal 267 at `call_booked`, no cohort |
| **CURRENT IMPORTED — ALREADY APPROVED, already in pipeline (4)** | Lara Spagnola (72, deal 149 `won`), Brea Burkard (95, deal 210), Lena Bosnjakovic (99, deal 214), Raghavan Narasimhan (100, deal 213) — **not blocked, no adoption needed** |
| **AMBIGUOUS — DEFERRED (1)** | **Elin Hilgemann (144)** — approved, no Opportunity, no deals at all |
| Live public-form applicants in the same cohort (5) | 189, 192, 204, 211, 212 — unaffected |

### Approved imports: explicitly deferred, and why

`reviewed_at` is **null on all 59** imported approvals — types.ts is explicit
that *"a decided status with no timestamp is valid history, never 'not
reviewed'"*. So adopting an approved import would need a live pipeline stage
for a decision made outside this system at an unknown time. That is a business
question, not a derivation, so `status-unsupported` refuses it by name.

**Only Elin Hilgemann (144) is actually blocked by this.** The other four
approved January imports already have their Opportunity and can be reviewed
today. Leif decides what Elin's stage should be; nothing is guessed.

`waitlist` and `denied` are refused for the same reason — old vocabulary is
never translated into a modern outcome.

### Taylor's production acceptance plan

1. Open Taylor Carr's Application · 2. answers intact · 3. **Bring into CRM**
offered · 4. click · 5. modal over the page · 6. confirm · 7. same page ·
8. Review Decision now works · 9. exactly one Opportunity · 10. pipeline shows
her at Application Received · 11. she is in the normal review surface ·
12. `source` still `historical_import` · 13. cohort still January 2027 ·
14. Kit reads **Manual — action needed** · 15. `○ GYU-Applicant` required ·
16. Dashboard Kit underlying count **+1** (4 → 5) · 17. **no** Kit operation,
identity or tag created by adoption.

**No bulk adoption.** One explicit click per real current applicant. Leif is
opening these to read them anyway. Batch can later call the same authority
unchanged, once this is proven — recorded as a convenience, not a blocker.

### One process note, recorded because it cost a red main

`f6b4663a` shipped with a red **Typecheck** job: a test fixture used
`type: "cohort"` where `OfferType` is `"individual" | "group"`. I had verified
with `tsc -p tsconfig.json`; CI runs `npm run typecheck`, which is
`tsconfig.app.json`, and only that config includes the test files. **Run
`npm run typecheck`, never a hand-rolled tsc.** Fixed in this slice.

## 8b-signup. PUBLIC SIGNUP WAS OPEN — CONTAINED 2026-09-30

**Found during the adversarial pre-use gate on the adoption authority, and it
had nothing to do with adoption.**

Production Auth reported `disable_signup: false`. Anyone on the internet could
sign up, confirm an email, and receive an `authenticated` JWT. That role holds
`GRANT ALL` on `deals`, `applications`, `contact_notes`, `tasks`, `enrollments`
and `sales`, plus `SELECT/INSERT/UPDATE` on `contacts`, and **every RLS policy
reads `USING (true) WITH CHECK (true)`**. `handle_new_user()` gates nobody: it
inserts a `sales` row for any new auth user, `administrator = false` after the
first — and `administrator` is an **application** flag the database does not
enforce.

So a stranger could have read and written every client record through
PostgREST without ever loading the app. `anon` was correctly blocked
throughout (verified: 401 on every table and on the RPC).

### Containment

`supabase config push` from the repo root would have been a disaster — the
repo's `config.toml` is a LOCAL config, and a push would have set `site_url` to
`localhost`, dropped the production redirect URL, turned email confirmations
OFF and set `db.major_version` to 15. **Twenty-nine changes.**

Instead: a throwaway workdir containing a config declaring **only**
`[auth] enable_signup = false`. `config push` writes only what a file
*declares*, so `config diff` showed exactly one update and the push reported
`1 property pushed`, auth only.

Verified after: `disable_signup: true`; a signup attempt returns
`422 signup_disabled` and creates nothing; existing sign-in still answers
`400 invalid_credentials` to a wrong password, so login is untouched; the one
CRM account is unchanged; `anon` still blocked; the CRM still serves 200.

### The repo can no longer put it back

All three `enable_signup` occurrences in `supabase/config.toml` are now
`false`, each saying why. CI never pushes auth config — only `db push`,
`secrets set` and `functions deploy` — so the drift risk was a human running
`config push`, and that is now closed at the source.

`contracts/security/publicSignupIsForbidden.test.ts` fails if any of them
returns to `true`, if the rule stops being stated in the file, or if a workflow
starts pushing auth config. Proven to fail on the old state before being
accepted.

**Local first run:** the first admin is normally created through the sign-up
page (`handle_new_user` makes the first account administrator). With signup off
that path is gone, so on a fresh local stack set `[auth] enable_signup = true`,
create your admin, and set it back.

### HIGH PRIORITY — NOT DONE: authenticated-role least privilege + real RLS

Closing signup is **containment, not the fix**. It works because Leif is the
sole account. The underlying posture is unchanged: any account that reaches
`authenticated` still holds near-total access.

Deliberately not attempted in that slice — [a missing grant once signed Leif
out](403-from-the-database-is-not-a-logout.md), and the CRM had to stay
working. It needs, in order:

1. a complete frontend/data-provider operation census
2. a table + function permission matrix
3. staged policy replacement, not a big-bang revoke
4. a lockout/recovery plan before any of it is applied
5. tests under owner vs non-owner principals
6. production acceptance

## 8b-adopt-gate. ADVERSARIAL PRE-USE GATE ON ADOPTION — 2026-09-30

Run before any human used `adopt_imported_application()`. It found one real
defect, which is the whole reason for running it.

### BLOCKER (found, fixed): two claims on one decision

The authority reused an existing reviewable Opportunity — correct — but never
asked whether that Opportunity **already carried a pending Application**. Two
pending Applications could therefore point at one Opportunity. Since
`reviewApplication.ts` writes the outcome to the Application AND its
Opportunity, approving either would move the shared Opportunity and leave the
other reading `pending` against a decision already made.

`create_manual_application()` refuses exactly this, in exactly these words:
*"a second pending Application against one live sale is two claims on the same
decision."* Adoption did not. `20260930180000` makes it refuse
`already-pending`, naming the Application already waiting, with zero writes —
and the Opportunity becomes reusable again once that one is decided.

**Not reachable in production today:** the branch needs an existing active deal
at the same offer+cohort scope, and all four adoptable January applicants have
no deals at all. Found by the gate, not by a person.

### IMPORTANT (fixed): the page offered what the data would refuse

Samantha Herold and Celia each have a live GYU conversation at `call_booked`
carrying no cohort. The page offered them **Bring into CRM** and only explained
the refusal after the click. It now names the conflict instead of offering the
action. A refusal caused by state changing *after* render is still a race and
still acceptable; offering a button for a conflict visible on screen was not.

### IMPORTANT (reported, NOT fixed): the review path is not transactional

`reviewApplication.ts` is check-then-act across four separate writes with no
transaction: it re-reads the Application and returns `already-reviewed` if it
is no longer pending, then updates the Application, then the Opportunity. Two
genuinely concurrent reviews could interleave and leave the Application and its
Opportunity disagreeing about the outcome.

**Pre-existing, not introduced by adoption, and not touched here.** One
operator, one browser, buttons disabled during the mutation — the window is
milliseconds. Worth making transactional when the review path is next opened.

### MINOR (mine, fixed): a test asserted absolute zero for pg_net

The Kit side-effect check asserted `net._http_response = 0`. The clean room
runs its own cron jobs, which legitimately answer HTTP. Corrected to measure
the **delta** around adoption, which is 0 queued and 0 responses.

### What passed

| | |
|---|---|
| Authorization | `anon` refused everywhere; function is SECURITY INVOKER with pinned `search_path`, no dynamic SQL, no `SET ROLE`, writes scoped to one id — it grants nothing the caller lacks |
| Concurrency | 3-way and 4-way bursts: one `adopted`, the rest `already-adopted`, exactly one Opportunity, no deadlock |
| Rollback | fault injected after the Opportunity insert: zero orphan deals, `crm_adopted_at` null, no Kit work; retry then succeeds |
| Stale state | approved / denied / waitlist / closed cohort / do-not-engage all refuse under the lock, zero writes |
| Collision matrix | 10 shapes: create, reuse, later-stage, other-offer, lost-sale, ambiguous, already-pending, cohort mismatch |
| Integrity | source, status, `submitted_at`, `reviewed_at`, cohort, answers and all `application_responses` unchanged; no duplicate Application or Contact |
| Review tasks | a cron-reconciled projection; adoption never touches them; reconciling three times created 2, then 0, then 0 |
| Kit | zero operations, zero identities, zero queued HTTP — measured, not inferred |
| Property matrix | **45 shapes** (3 sources × 5 statuses × 3 cohort states): only imported + pending + open-cohort may transition; every other shape refuses with zero writes |

**Residual security model, stated plainly:** only provisioned CRM users can
become `authenticated` now — but `authenticated` remains highly privileged.

## 8b-adopt-accepted. IMPORTED CURRENT APPLICATION ADOPTION — HUMAN ACCEPTED 2026-10-01

**Taylor Carr, application 148.** Leif pressed Bring into CRM; verified
read-only afterwards, and every part is what it should be.

| | |
|---|---|
| provenance | `source = historical_import` — **unchanged, forever** |
| decision | `status = pending`, `reviewed_at` still null — none fabricated |
| adoption | `crm_adopted_at = 2026-10-01 00:45:35Z` |
| Opportunity | **exactly one**, id 323, `application_received`, offer GYU, cohort January 2027 |
| ownership | belongs to contact 337; no Opportunity stolen or shared — 1 Application points at it |
| answers | all **four** `application_responses` byte-identical before and after |
| totals | applications 169 → 169 (no duplicate), deals 170 → **171** (exactly one new) |
| Kit | operations 4 → 4, identities 4 → 4, **zero** for Taylor |
| derived | **Manual — action needed**, `○ GYU-Applicant`, queue **4 → 5**, still ONE aggregate row, no per-person Task |

Neither January cohort has a Kit tag configured, which is why she owes the
programme tag only.

**Ready for the same single click, not yet done:** Jessie (96), Lena (145),
Cristina Luca (147).

**Intentionally unresolved:** Samantha Herold (97) and Celia (146) — each has a
live `call_booked` GYU Opportunity carrying no cohort, so whether that
conversation IS their January application is Leif's call. The page names the
conflict rather than offering the action.

**Deferred:** Elin Hilgemann (144) — approved import with no Opportunity, and
the live stage for a decision made elsewhere at an unknown time is a business
question.

## 8b-decision. A DECISION IS ALL OF IT, OR NONE OF IT — 2026-10-01

**The adoption gate found this, and it was not about adoption.**

Recording a review was four separate browser writes with nothing holding them
together: `applications.status`+`reviewed_at`, then the Opportunity's
stage/outcome, then the Contact on Do Not Engage, then the review Task. The
pending check was also check-then-act — two reviewers could both read
`pending` and both proceed.

**Proven, not theorised.** A test injected one failure between the Application
write and the Opportunity write; the Application came back `approved` while its
Opportunity sat at `application_received`, with nothing able to tell. It needs
one interruption — a dropped connection, a refused request, a closed tab — not
a race.

### `review_application(application_id, outcome)` — 20261001090000

One transaction, SECURITY INVOKER, pinned `search_path`, granting nothing the
caller does not already hold. `FOR UPDATE` on the Application **and** its
Opportunity is what turns "is this still pending" from a guess into a decision:
the second caller waits, re-reads under the lock, and is told which decision
already won.

The Opportunity is no longer a parameter. It is resolved from the Application
under the lock, because a copy the page is holding is exactly as stale as the
status check it was meant to accompany.

Refuses by name, writing nothing: `already-reviewed` (with the status that
won), `no-opportunity`, `opportunity-mismatch`, `opportunity-invalid`,
`outcome-invalid` — the last covering `denied` and `waitlist`, which are
historical-import vocabulary and not decisions anybody makes here.

### Concurrency, proved with real sessions

| pair | result |
|---|---|
| approved vs approved | one `reviewed`, one `already-reviewed` |
| approved vs not_fit | one winner |
| approved vs needs_higher_care | one winner |
| not_fit vs do_not_engage | one winner, Contact gate set correctly |

In every case the Application and its Opportunity **AGREE**, and exactly one
review Task closed. Rollback: a fault injected after the Application decision
left status `pending`, `reviewed_at` null, Opportunity untouched, Contact
untouched, no Task closed, no Kit operation — then retried clean.

### Kit, and the distinction that matters

`on_application_kit_decision` fires inside this transaction, exactly once, with
its existing guard intact — and that guard is what keeps the two modes apart.

| | |
|---|---|
| automatic (an applicant operation exists) | approved → **exactly one** decision operation; replay, including a conflicting outcome, does not duplicate |
| **adopted import** (never had one) | approved → **zero** Kit operations. No automatic work is invented; the outcome tag becomes MANUAL required work |
| needs_higher_care / not_fit | exactly one each, correct tag |
| do_not_engage | **zero** |

**Email:** nothing in this path sends anything, and nothing was added.
Approved and Not Fit reach Leif's Kit automations through the tag via the
outbox, exactly as they did before. Individualised decision email stays
Leif's by hand until Gmail is deliberately built.

**Not yet accepted by a human.** Built and proved; Leif has not recorded a real
decision through it.

## 8b-accepted. THE FIRST REAL APPLICATION DECISION — HUMAN ACCEPTED 2026-10-02

**Taylor Carr → Approved**, by the owner, in production, at
`2026-10-02T15:55:16.119Z`. The transactional decision authority
(`review_application`, §8b-decision) is now **HUMAN ACCEPTED**.

The proof that it was one transaction, not three writes that happened to
agree: `applications.reviewed_at` and `tasks.done_date` are the **same
instant to the millisecond** — both `15:55:16.119` — because both come from
the single `v_reviewed_at` the function computes once.

| | after the click |
|---|---|
| Application 148 | `approved`, `reviewed_at` set once, still `historical_import`, `crm_adopted_at` preserved, cohort still January 2027 |
| Opportunity 323 | `stage = approved`, `outcome` null, `owner_decision` null, exactly one Opportunity |
| Task 352 | `completed`, `done_date` = `reviewed_at`, no duplicate |
| Contact 337 | `sales_eligibility` still `normal` |
| Kit | **zero** operations — production still holds exactly the same 4 rows (ids 9, 18, 19, 22) it held before |

So the approval sent **no email** and created **no Kit identity or tag**, by two
independent gates: `enqueue_kit_application_decision` only enqueues when an
`applicant` operation already exists for that Application (Taylor has none),
and `enqueue_kit_application_sync` returns null for any `source` outside
`public_form`/`manual` **and** for anything created before the boundary
(`not_before` 2026-09-28; Taylor's Application is 2026-09-17).

**Still OPEN: automatic post-boundary Kit-decision acceptance.** It needs a
genuine post-boundary automatic applicant to receive a real decision. Do not
manufacture one.

### The UX gap the acceptance exposed — and what it actually was

The reported symptom was that after deciding, the page offered no way to do the
Kit work the decision creates. **The audit did not support that.** Rendering an
Application in Taylor's exact shape (adopted import, approved, pre-boundary,
zero operations) produces the Kit box with "Kit: Manual — action needed",
"2 tags still to add", both required tags listed, and **both** buttons —
`Add required tags` and `Manage Kit tags` — already inside the Review
Decision card. All of those strings are in the deployed bundle, and
`authenticated` can read all three Kit tables (permissive SELECT policies).
So no second Kit panel was built: there was already a working one, and adding
another would have created exactly the duplicate work this slice forbids.

What was genuinely wrong were two different things:

**1. The decision line contradicted the Kit box.** `already_reviewed` read
"Reviewed — no further action needed." and rendered immediately above
"Manual — action needed · 2 tags still to add". One of the two was always
false, and `ApplicationReviewActions` cannot know whether anything else is
outstanding. It now says **"Decision recorded."** — the decision, and nothing
more. Whatever Kit still needs is said by the component that actually knows.
The sentence lives in `englishCrmMessages.ts`/`frenchCrmMessages.ts`, not in
the inline default, which is why changing the default alone did nothing.

**2. `Add required tags` performed a provider write with no confirmation.**
`kitAutomationRisk.ts` already classified `approved`/`not_fit` as
`sends-email`, and `ManageKitTagsModal` already confirmed before a
hand-picked tag — but the required-tags button enqueued straight away. For
Taylor it would have queued `GYU-Approved`, which may trigger the approval
automation, with no warning at all. **Both doors** now ask first: the
Application's button and the Dashboard's Kit modal, which had the same
unguarded path. Cancel queues nothing; confirming uses the existing manual
authority exactly once per missing tag.

The gate is risk-based, not blanket: a quiet tag (applicant, cohort) is still
added in one click. `kitEventRisk(event)` is the shared authority — a
required tag already carries its own event, so neither surface re-reads the
mappings, and both keep deriving from the one `kitStatus`.

## 8b-kit-manual-accepted. MANUAL POST-DECISION KIT TAGGING — HUMAN ACCEPTED 2026-10-02

**Taylor Carr → Approved → GYU-Applicant + GYU-Approved**, by the owner, in
production, at `17:23:51`–`17:23:53Z`. Exactly two `manual_owner`
operations, one per tag, each `succeeded` on its first attempt, both carrying
the same Kit subscriber id `4267946624` — one canonical identity, no
duplicate. No `automatic_application` decision operation was invented for
Application 148, and the manual unique index
(`contact_id, kit_tag_id` where `origin = 'manual_owner'`) makes a second
request for either tag impossible. The Dashboard manual queue moved **5 → 4**:
Ruth, Kseniya, Kara and Carey remain, each with zero operations. No Kit task
type exists anywhere.

**No email delivery is claimed.** `succeeded` means Kit accepted the tag.
The CRM has no delivery evidence and never asserts one.

**The first attempt silently did nothing**, which is what produced the next
slice. Every refusal branch in `request_kit_manual_tag` passed for Taylor,
and no row was created — the request never reached the database. The likeliest
cause was the confirmation's own shape: it was an inline block *below* the
buttons, leaving the original `Add required tags` live directly above it, so
the obvious second click just re-opened the question and queued nothing.

### The queued state the state machine did not have

`kitStatus` had no way to say "asked for, on its way". Manual operations
count as done only once `succeeded`, so between the click and the worker's
pass the card still read `Manual — action needed`, `○` tags and
`Add required tags` — identical to before the click, which is precisely how
the same tag gets asked for twice. Added **`manual-syncing`**, reusing the
existing `Kit: Syncing…` line, when every still-missing tag already has an
outstanding manual operation. A partially-asked state deliberately stays
`manual-action`, because part of it genuinely is. Failure needed nothing new:
`failed`/`stuck` is checked at the top across all operations, so a failed
manual request already reaches **Needs attention** with its retry.

`useKitWorkQueue` filters on `kind === "manual-action"`, so queued work
leaves the Dashboard queue by itself — the same way automatic work in flight
always has.

### One lightbox, two doors

`ConfirmKitTagsDialog` is now the single confirmation, used by the
Application and the Dashboard. It names the tags, warns **once**, and offers
Cancel or Add. Because it is a real modal, the action behind it is not merely
disabled — Radix takes the page out of the accessibility tree, so the button
cannot be reached or clicked at all while the question stands. That is
asserted, not assumed.

**Wording is deliberately weaker than it was.** The old sentence claimed
"GYU-Approved is connected to one of your Kit email automations". The CRM
reads which EVENT a tag is mapped to; it cannot read Kit's automation
topology. It now says `<tag> may trigger a Kit automation connected to that
tag`, or "These tags may trigger Kit automations connected to them" for
several — and the second, generic line underneath was removed, because saying
it twice made the dense case denser and the quiet case alarming.

**Quiet tags still skip the question entirely.** Audited rather than changed:
all four remaining queue entries are applicant-only, Leif tags them routinely,
and a confirmation there would be friction with no safety to buy. Only an
outcome tag (`approved`, `not_fit`) opens the lightbox.

## 8b-kit-operational. PROVENANCE IS NOT LIFECYCLE, FOR KIT TOO — 2026-10-02

**Courtney Foregger (application 181) was approved in production and her Kit
section vanished instead of appearing.** Not a presentation bug: a domain
classification bug, and both surfaces were wrong together.

Her row: `source = historical_import`, `crm_adopted_at = NULL`,
`opportunity_id = 218` (created by the import, same microsecond as the
Application), `status = approved`, `reviewed_at = 2026-10-02T19:37:27Z`,
`intended_cohort_id = NULL`, zero Kit operations. The approval itself is
transactionally correct — deal 218 `approved`, review Task 226 completed at
exactly `reviewed_at`.

She was reviewable without ever being adopted, because the import had already
given her a canonical Opportunity. Taylor needed `crm_adopted_at` only
because she had none.

### The first predicate where she diverged

```
operational = TERMINAL_SOURCES.includes(source) || crm_adopted_at != null
```

`historical_import` is not in `["public_form","manual"]`, and
`crm_adopted_at` is null — so `operational = false`, `kitStatus` returned
`historical`, and `KitStatusLine` returns `null` for `historical`. The
whole section, both buttons included, simply was not rendered.
`useKitWorkQueue` held a SECOND copy of the rule in a different shape
(`source !== "historical_import"`), so the Dashboard excluded her too.

**The CRM already knew better.** `classifyApplication.ts` rule 1 is
*"A real decision was recorded here. Nothing else can outrank that"* —
`reviewed_at` is written only by `review_application()`, so it is the sole
evidence of a decision made IN this CRM. All 58 imported `approved` rows
carry a status with **no** timestamp, and types.ts is explicit that a decided
status with no timestamp is valid history, never "not reviewed". The
Applications inbox used that; Kit asked the cruder question. Two notions of
"current", and Courtney was the first person to be decided here without having
been adopted, so she was the first to fall through.

### The repair

`isOperationalApplication` now lives in `kitStatus.ts`, is exported, and is
the only copy — `useKitWorkQueue` imports it instead of restating it. Three
separate kinds of evidence: the CRM's own funnel (`public_form`/`manual`),
an explicit adoption (`crm_adopted_at`), or **a decision recorded here**
(`reviewed_at`). Provenance alone decides currentness in neither direction.

**Measured blast radius on production: exactly two rows** — application 181
(Courtney) and application 107 (**Anu Nandyala, approved in the CRM on
2026-09-25**, invisible to Kit for a week before Courtney exposed the same
bug). The manual queue goes 4 → 6. All 58 archive approvals stay out, because
their decisions carry no timestamp. Nothing else moves.

Courtney owes `GYU-Applicant` + `GYU-Approved` and no cohort tag, because
`intended_cohort_id` is null.

### Worth knowing

Courtney has **two** completed `review_application` Tasks (161, completed
2026-09-19 during the import era; 226, completed by the real decision today).
`review_application` closes the oldest OPEN one, so it closed 226 correctly.
Why the import left a completed review Task behind is unexamined and is not
this slice.

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

**Two things the Kit slice (2026-09-28) leaves for it**, both small and both
better known now than discovered later:

- **Renumber its migration.** Kit is `20260928200000`; the builder still holds
  `20260926090000`, which is now below it. Move the builder's above this one
  before pushing, or `db push` sees an out-of-order version.
- **`src/test/StoryWrapper.tsx` gained one line** (`kit_sync_operations: []`),
  in the same `createCrmDb` block `storywrapper-both.patch` touches. Expect a
  small conflict there and keep both.
- The builder's own `ApplicationReviewDialog.tsx` is a second review surface.
  When it lands it **MUST reuse the shared `kitStatus` derivation and
  `KitStatusLine`** (§8b-kit-live) rather than deciding those labels itself — a
  contract test refuses any second production module that does. `KitStatusLine`
  is wired into `ApplicationShow.tsx` only; the lightbox needs the same line.
- `KitSyncCard.tsx` is now **presentational** — it takes a status and a retry
  handler and reads nothing for itself, so both surfaces can render it.

**Do not resume it** until everything ahead of it in the queue is done:
Jenna's production acceptance, the Dashboard sales-call lightbox, the client
start-week / capacity UX, and the Kit integration. And when Applications are
eventually called finished,
**the Kit requirement above is part of that judgement** — a form Leif can edit
does not complete Applications on its own.

## 8b-stabilize. TWO FRAMEWORK TRAPS, FOUND BY ONE MISSING START WEEK — 2026-10-03

Leif set Todd Jacobsen's start week. The CRM said **"Client updated"**. The
week was not there afterwards. Everything at the database layer came back
clean, repeatedly, because nothing at the database layer was wrong.

### The write was never sent

`EditBase` defaults to **`mutationMode="undoable"`**. In that mode ra-core
patches its own cache, calls `onSuccess` with the OPTIMISTIC record, and
QUEUES the real `dataProvider.update` to be run by whichever notification is
raised next. [notification.tsx](src/components/admin/notification.tsx) pops
that queued write with `takeMutation()` and then runs it only `if (undoable)`.

`ClientEditModal`'s `onSuccess` raised a plain `notify("Client updated")`. So
the queued write was taken off the queue by a toast that did not know it was
holding one, and **discarded**. Not delayed — gone. Proven directly:
`dataProvider.update` was never called, not after nine seconds, and the record
still read null.

**The invariant:** an edit form either asks the database first
(`mutationMode="pessimistic"`) or every `notify` it raises declares
`undoable: true`. Nothing in between is safe. `TaskEdit` has the identical
construction and survives *only* because its notify happens to pass
`undoable: true` — a trap, not a pattern, which is why
[aSaveIsNotAClaim.test.ts](contracts/enrollments/aSaveIsNotAClaim.test.ts)
sweeps **every** edit form in the app for it. Verified sensitive: with the fix
removed it flags exactly `ClientEditModal`.

### A success message is a claim about the database

The missing write is one bug. The sentence is the worse one, because it is
what sent Leif away believing the decision was recorded — and it would have
said the same about any field, in any form, for any reason a write did not
take.

[savedWhatWasStated.ts](src/components/atomic-crm/enrollments/savedWhatWasStated.ts)
reads the record that came back and looks for Leif's statement in it. Absent,
the CRM says so, names the field and the real outcome in his words, stays
open, and does not auto-dismiss. Dates compare **by day**, so a value that
round-tripped through a different shape is still a save — crying wolf on every
save would be the same sin in the other direction.

### The fortnightly CI failure was the wrong offer

`IndividualProgramPage.capacity` lost three assertions at a time in CI while
passing 10/10 alone. It read like a slow page, because that page renders
`null` while loading, so a slow query and a wrong answer look identical.

It was a wrong answer. The page said **"Growing Yourself Up"** and
"12 active" with no "/ 12" — a group programme, which has no
`max_active_clients`, so there was no ceiling, no availability line and no
openings it could calculate. Three failures, one record.

On a mobile-width viewport `CRM.tsx` renders `MobileAdmin`, which wraps Admin
in a `PersistQueryClientProvider` backed by **localStorage** (`gcTime` 24h,
`networkMode: "offlineFirst"`). Vitest browser mode runs every file in ONE
browser context on one origin, so that cache is shared by all of them and
nothing cleared it. An earlier file left its own Offer 1 under
`REACT_QUERY_OFFLINE_CACHE`, and "offlineFirst" answered
`useGetOne("offers", { id: 1 })` from it without ever asking the provider.

Repaired at the cause: [isolateBrowserStorage.ts](src/test/isolateBrowserStorage.ts),
wired as the app project's `setupFiles`, gives every browser test empty
storage. No timeout raised, no assertion weakened, no retry added, no
production path touched. The previously-failing selection now runs 8/8 green,
having failed 3 times in 11 attempts before.

**Carried forward, not repaired:** that persisted cache is real in
production too. A mobile user holds a 24h `offlineFirst` cache, so a stale
Offer can render after it changes, until revalidation lands. That is the
intended offline-first design and is listed here only so nobody rediscovers
it as a bug.

### The second way to lose a queued write

The same audit turned up a second, independent instance, in a different
shape.

ra-core's undoable mode does not send the write. It pushes the mutation onto
`UndoableMutationsContextProvider`'s FIFO queue, which drains only when a
notification is **displayed and then dismissed**, and then only
`if (undoable)`. Two ways to lose a write follow:

1. **raise a plain `notify()` over a queued mutation** — a toast that does
   not know it is holding one pops it and discards it. That was
   `ClientEditModal`, and it is why Todd's start week vanished.
2. **raise NO notification at all** — the mutation stays queued and is never
   sent. That was [Task.tsx](src/components/atomic-crm/tasks/Task.tsx)'s
   reopen path, whose `onSuccess` returns before notifying when
   `completing` is false.

So **un-ticking a plain Task did nothing**. Measured on the real component
path: `dataProvider.update` was never called and the Task was still
`completed` eight seconds later, while the box looked un-ticked the whole
time because the optimistic patch is local. And because the queue is global
and FIFO, the next unrelated undoable action would have popped that stale
mutation instead of its own.

Repaired as `mutationMode: completing ? "undoable" : "pessimistic"`.
Pessimistic is also the honest mode: un-ticking a box IS the undo, and
offering an undo window on an undo is a second way to get the same answer
wrong. Regression:
[reopeningATaskIsSent.test.tsx](src/components/atomic-crm/tasks/reopeningATaskIsSent.test.tsx)
pins both halves — the mechanism (undoable + no notification = never sent)
and the repair.

### Edit-form audit — every form, classified

Every `EditBase` / `Edit` construction in `src/components/atomic-crm`,
checked for the exact dangerous pattern. **Not** made pessimistic wholesale:
an undoable list edit is a deliberate, good UX, and changing it for
consistency would be cargo cult.

| Form | Consequence | Mode | Why it is safe |
|---|---|---|---|
| `enrollments/ClientEditModal` | **A: start week, lifecycle status** | pessimistic | REPAIRED. Was the bug. Success now earned from the saved record. |
| `enrollments/ClientEdit` | **A** (same component) | pessimistic | Thin route wrapper around the modal; one implementation, two doors. |
| `tasks/Task` (checkbox) | **A: task completion, which mirrors lifecycle items** | undoable on complete, pessimistic on reopen | REPAIRED. Completing raises an undoable toast that drains the queue; reopening raised none and was lost. |
| `tasks/Task` (delete) | **A** | pessimistic | Already explicit, with its own non-undoable `onSuccess`. |
| `tasks/TaskEdit` | **A: a Task's text, type and due date** | undoable (EditBase default) | Its custom `onSuccess` notifies with `undoable: true`, so the queue drains. Verified by running a real desktop task edit: the provider was asked and the text persisted. **Left alone deliberately.** |
| `deals/DealEdit` | **A: commercial truth** | pessimistic | Already explicit. |
| `settings/SettingsPage` | **A: account settings** | pessimistic | Already explicit. |
| `waitlist/WaitlistEntryEditSheet` | **A: eligibility / waiting position** | pessimistic | Already explicit. |
| `applications/ApplicationEditDialog` | **A: application record** | pessimistic | Already explicit. |
| `misc/EditDialog`, `misc/EditSheet` | depends on caller | caller's, default undoable | Their own `handleSuccess` notifies with `undoable: mutationMode === "undoable"`, so the declaration tracks the mode. A caller passing its own `onSuccess` takes over the obligation; today's callers pass none. |
| `contacts/ContactEdit`, `contacts/ContactEditSheet` | B: contact details | undoable | No custom `onSuccess`; ra-core's own undoable notification drains the queue. |
| `companies/CompanyEdit`, `cohorts/CohortEdit`, `offers/OfferEdit` | B | undoable | Same. |
| `notes/Note`, `notes/NoteEditSheet` | B: note text | `useUpdate` / explicit undoable with an undoable notify | `useUpdate` defaults to pessimistic; the delete path declares `undoable: true`. |
| `contacts/TagsListEdit` | B: tags | `useUpdate` (pessimistic default) | Not an edit form at all — the `Edit` match is the lucide icon. |

The sweep is mechanised in
[aSaveIsNotAClaim.test.ts](contracts/enrollments/aSaveIsNotAClaim.test.ts):
any form that is not pessimistic and hands `EditBase` its own `onSuccess`
must have every `notify` declare `undoable`. Verified sensitive — with the
`ClientEditModal` fix removed it flags exactly that file, and nothing as
committed. Variant 2 is a PATH through an `onSuccess`, which no static rule
can see honestly, so the one place it was found is pinned by name instead.

### The Golden Journey — what SYSTEM GREEN means here

[startWeekGoldenJourney.spec.ts](e2e/startWeekGoldenJourney.spec.ts), on its
own synthetic fixture
([goldenJourneyFixture.ts](e2e/goldenJourneyFixture.ts)). Eight cases, run on
both Playwright projects — desktop Chrome and Pixel 5, the second being the
one that renders `MobileAdmin` and its persisted cache.

The chain, with nothing stubbed in it: **real browser → real production
build → real UI interaction → real data provider → real Postgres clean room
→ independent SQL read-back → fresh browser context → rendered truth
again.**

The fixture is twelve genuinely active clients against a ceiling of twelve —
activated through the real path, because the database refuses to activate an
Enrollment whose required onboarding items are not done — plus one
Todd-shaped commitment: Won, enrolled by the live trigger, `start_date` null,
`start_date_source` null, nothing inferred. One of the twelve started nine
weeks ago, so their twelfth session week frees a genuine opening three weeks
out: the week the old rule erased.

Every date derives from the most recent Monday, so the scenario has a fixed
SHAPE on any day it runs. A real browser against real Postgres cannot have
its clock frozen without lying to the auth client, so the arithmetic is
pinned rather than the calendar.

**Sensitivity proven, not assumed.** With `mutationMode="pessimistic"`
removed and the app rebuilt, five of the eight fail, and the decisive one
fails for the right reason: the browser sent **zero** PATCH requests to
PostgREST while the CRM said "Client updated". The broken variant was never
committed.

### LE LIFECYCLE STABILIZATION — PRODUCTION ACCEPTED, 2026-10-04

Accepted by Leif on production, by doing the thing the slice existed to
make possible.

He opened Programs → The Living Example, found Todd Jacobsen under **Needs
Start Week**, clicked **Set start week**, chose **13 December 2026**, and
saved once. Then the authoritative read, from production Postgres rather
than the browser:

```
Deal 202            rows 1, stage won
Enrollment 115      opportunity_id 202, status onboarding
                    start_date 2026-12-13, start_date_source owner
                    end_date NULL
Duplicate guards    1 enrollment for deal 202; 1 across his whole contact
```

Then Cmd+R, and the page still said it: Todd under **Starting Later**,
"Starts Dec 13, 2026", absent from Needs Start Week, **12 / 12 active**,
**9 starting later**, named exactly once, next opening **Week of Jan 10 ·
2 clients can start** — the same after a full reload as immediately after
the save.

**The silent-save defect is closed in production:** real UI save → durable
Postgres write → fresh reload preserves it. That is the whole chain that
failed, verified end to end on a real record.

Two invariants demonstrated on that record rather than argued:

- **`end_date = NULL`** while the row renders "expected final session
  week Apr 11, 2027". The projection is arithmetic and never forges the
  operational end.
- **`status = onboarding` and he is under Starting Later.** Not a
  contradiction: `classifyEnrollment` answers from dates, so a
  non-terminal enrollment starting in the future is *upcoming* whatever
  its status column says. That is the same distinction that fixed
  18-vs-12.

The openings answer moved the right way: 3 January was offerable while
Todd consumed nothing, and is not once he consumes a dated slot from 13
December — so the earliest safe week slid to 10 January. An opening that
had stayed put, or moved earlier, would have meant he was still consuming
nothing.

### The start week says what it means — 2026-10-04

The Edit client modal put Start week and End side by side. At this dialog
width the End column collapsed until its own `mm/dd/yyyy` placeholder
clipped its border — but the worse half was the implication: two date
inputs sharing a row read as two of the same kind of thing.

They are not, and the audit settled it rather than assuming.
**`enrollments.end_date` is operational truth** — "a recorded end date is
somebody's decision and outranks the calendar arithmetic entirely"
([individualCapacity.ts](src/components/atomic-crm/capacity/individualCapacity.ts)).
Nothing in the app invents one: `endEnrollment` explicitly refuses,
because the day somebody stopped is not the day the CRM was told. Only
group enrollments inherit a cohort's `program_end_at`. So the projection
is **never** written into it.

The modal is now one field per row: Status, Start week, the projected final
session week (read-only), then the actual end date — kept, because this
modal is its **only** editor in the app, and now labelled "Actual end date"
with "Leave it empty to use the projection above."

[useProjectedFinalWeek.ts](src/components/atomic-crm/enrollments/useProjectedFinalWeek.ts)
calculates nothing. It gathers the same three inputs the capacity model
gathers — the offer's live `1:1s` weeks, the start week, one extension per
cross-week reschedule — and calls the same `computeExpectedEnd`. It is
**not** start + 12 calendar weeks: between 2 July and 13 September 2026
Leif's calendar has no eligible week at all. When the calendar cannot reach
twelve eligible weeks it says so and invents nothing.

**A testing trap worth knowing before it costs somebody else three runs.**
`vitest.config.ts` gives the "app" project `plugins: [react()]` — **no
`tailwindcss()`**. So `@import "tailwindcss"` in `index.css` is never
processed and **every Tailwind utility class is inert in vitest browser
tests**. Measured: with the stylesheet imported, `grid` and `flex`
still compute to `display: block`, `max-w-lg` has no effect, and a date
input is 143px because that is its intrinsic size with no CSS. Any width,
position or visibility assertion that depends on a utility class is
measuring the user agent. (`ClientShow.checkboxCursor.test.tsx` works
because `button:disabled { cursor: not-allowed }` is a literal rule in
`index.css`, not a utility.)

So: **structure in vitest, geometry in Playwright.** The modal's layout is
asserted structurally in
[projectedFinalWeekUx.test.tsx](src/components/atomic-crm/enrollments/projectedFinalWeekUx.test.tsx)
(no shared row wrapper, projection between the two dates) and measured for
real in the Golden Journey against the production bundle, on desktop and on
a Pixel 5 — which also proves the modal's projection and the Programme
row's "expected final session week" are the same string, because they are
the same function.

### A phase and a home arrive together — 2026-10-04

Found by Leif on the real production page, during acceptance, which is
exactly what acceptance is for.

The capacity arithmetic was right: **12 / 12 active**, Todd no longer
counted. And Todd had vanished. He was not under Current Clients, not
under Starting Later, and the only trace of him anywhere on the page was
one grey sentence beneath the whole openings forecast: *"No start week yet
for Todd Jacobsen — they aren't counted here until you set one…"*. No row,
nothing to click, no path from the programme page to the thing the
sentence was asking for.

The cause is mine and it is simple. The page had two client sections,
`capacity.occupied` and `capacity.committed`. Giving an unplaced
commitment its own phase was correct — it consumes no dated slot — but a
third phase with only two sections renders nowhere. **Correct arithmetic
is not the same as a correct page**, and the failure mode is quiet: no
error, no wrong number, just a person who stopped existing.

Repaired as a third client section,
[NeedsStartWeekSection](src/components/atomic-crm/programs/NeedsStartWeekSection.tsx),
between Starting Later and Upcoming Openings — with the client sections,
because it is a client section and not a caveat about a projection. The
row carries the name (linking to `/enrollments/:id/show`), the status
badge, "Start week not set", and a **Set start week** button that opens
`ClientEditModal`: the same component StartWeekCard opens and
`/enrollments/:id/edit` wraps. There is still exactly one start-week
editor and one save path — the one repaired after it silently discarded
Todd's first save. The header gained "1 needs a start week".

The openings footnote is now a **count with no names and no action**
("1 client still needs a start week, so future availability may change"),
because the forecast genuinely does depend on it — but it is a caveat
about numbers, not where those people live. Naming them there is what
made it their only representation.

**The rule, generalised:** a capacity phase and a place to render it ship
together. [everyClientHasAHome.test.ts](contracts/programs/everyClientHasAHome.test.ts)
enforces it — the page must render a section per non-released phase, the
model must still have exactly those phases (a fourth fails the contract
and forces the author to decide where those people appear), the section
must sit above the forecast, and the row may not grow a second editor
(no `useUpdate`, no `dataProvider`, no `DateInput`, no
`start_date_source` anywhere in it).

### What this says about proving things in Postgres

Neither trap is reachable from the database. Both live in the browser,
between the form and the provider — one in ra-core's mutation queue, one in a
persisted query cache. A real-Postgres journey would have replayed the
migration, found the column writable, and reported green over a CRM that
could not save a start week. **Where a bug can live decides where the proof
has to run.**

## 8b-e2e. resetDb COULD ONLY CLEAR ONE PAGE OF USERS — 2026-10-03

`e2e/fixtures.ts`'s `resetDb` deleted auth users from
`listUsers()` — which returns ONE PAGE, fifty by default. For a long time
the clean room never held fifty users, so nothing noticed.

The Golden Journey makes a fresh user per test, which pushed the pool past
the limit. The leftovers then outlived the reset, and every spec that signs
in as a fixed address started failing with "A user with this email address
has already been registered" — thirteen failures, in four spec files nobody
had touched. Measured at the time: page 1 and page 2 both full, and
`john@doe.com` on neither.

Fixed by paginating until the list comes back empty, and deleting five at a
time rather than the whole page at once: two hundred concurrent deletes took
the local auth service down with ECONNRESET, also measured. The 242-user
backlog was cleared directly in the disposable clean room.

A pre-existing defect that only a new spec could expose, and worth keeping
written down: a fixture that cleans up incompletely reports failures in
other people's files.

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

## 8b-testimonial-built. TESTIMONIAL SEQUENCE — LE PRODUCTION ACCEPTED 2026-10-06, GYU AWAITING ITS FIRST OFFBOARDING

Day 0 at `active -> offboarding`: collect the testimonial. Day 7 and Day 14:
ask again, each only if it has not arrived and the previous ask is done.
Then stop.

    CODE GREEN                   YES
    SYSTEM GREEN                 YES
    DEPLOYED                     YES  (441cd2d9)
    PRODUCTION DATABASE VERIFIED YES
    LE HUMAN ACCEPTANCE          YES  — on Jules (48) and Adriano (50)
    GYU HUMAN ACCEPTANCE         PENDING its first real offboarding
    TASK LABEL REPAIR            PRODUCTION ACCEPTED 2026-10-07 (02b12a1e)
    OFFBOARDING CONTAINER UX     PRODUCTION ACCEPTED 2026-10-07 (7478f8ff)

**TESTIMONIAL TASK LABEL REPAIR — PRODUCTION ACCEPTED** (2026-10-07, tip
`02b12a1e`). Jules's Enrollment page reads "Ask for testimonial" rather
than `collect_testimonial`. The three stage labels and the Enrollment
destination are settled and must not be reopened:

    collect_testimonial     -> Ask for testimonial
    testimonial_followup_1  -> Testimonial follow-up
    testimonial_followup_2  -> Final testimonial follow-up

Why it needed a repair at all is the durability note at the end of this
section — a configuration saved before a release shadows what the release
ships.

**TESTIMONIAL / OFFBOARDING UNIFIED LAYOUT — PRODUCTION ACCEPTED**
(2026-10-07, tip `7478f8ff`). The testimonial was its own card floating
beneath the offboarding checklist; it is now a row inside that one container,
divided from the requirements by the container's own row rule. Accepted on
Jules (48) — one container, shared divider, no standalone card, denominator
still 0/1, no checkbox on the row — and on Adriano (50), still Completed,
with the row visible inside the history container without reopening anything
or inventing a requirement. The domain rule it keeps is that visual grouping
changes nothing: the row is not an
`enrollment_offboarding_item`, carries no checkbox, never enters the x/y
count (LE stays 0/1 on `notes_archived`, GYU 0/2 on Slack + Calendar) and
can never hold a completion. On a completed Enrollment the requirements fold
away but the row stays visible outside the fold — Adriano is why.

**Accepted on the two real clients the boundary had excluded.** Jules
(Enrollment 48) is still Offboarding with Session notes archived unchanged,
the Testimonial card visible, Not received, and exactly one Collect
testimonial task. Adriano (50) is still **Completed** — the Enrollment was
not reopened — with the card visible after completion, Not received, and
exactly one ask. That second case is the one worth remembering: the card and
the sequence both keep working after ordinary offboarding has finished,
which is the whole reason a testimonial was never made a requirement.

**Production, read back by Leif:** 154 migrations, both testimonial
migrations applied once, the old global boundary gone, **LE activation
2026-10-06 21:59 and GYU 22:54 — independent**, exactly LE + GYU collecting,
testimonial not a requirement on either, GYU's Slack and Calendar
requirements and LE's notes_archived all unchanged, opt-ins limited to 48
and 50, no other pre-boundary client eligible, security PASS, one cron at
:53, and 2 open testimonial tasks — Jules's and Adriano's. 17 active LE and
7 active GYU clients will enter prospectively.

**GYU is deliberately untested in production.** Nobody will force a GYU
lifecycle transition to exercise it; its acceptance is the next genuine GYU
offboarding.

**Production evidence, read back by Leif:** 152 migrations with
`20261006120000` applied exactly once and nothing newer;
`testimonial_received_at` present; all three stage types accepted; the
stage uniqueness index, the reconciler and `testimonial_person()` all
present; **The Living Example only**, GYU off; the full ACL posture green
(anon cannot drive reconciliation or probe a client name, the owner can
still Start offboarding, service_role can reconcile); cron hourly at :53;
zero parked payment tables.

**The boundary, as deployed: 2026-10-06 21:59.** 17 active LE enrollments
will enter the sequence prospectively when they offboard. **2 enrollments
began offboarding before the boundary and are deliberately excluded** —
nothing was backfilled, and whether either should be enrolled by hand is
Leif's call. 0 testimonials recorded and 0 open testimonial tasks
immediately after deploy, which is what a prospective boundary should look
like on day one.

**Not human accepted.** The cadence is system-proved against real Postgres,
but nobody has yet watched a real client go through it. The next genuine LE
offboarding is the acceptance.

**It is NOT an offboarding requirement, and that is the design.**
`enforce_enrollment_completion_requirements()` refuses
`offboarding -> completed` while any `is_required` item is undone. A
testimonial depends on the CLIENT replying, so a required item would strand
the Enrollment on somebody who may never answer. Leif controls whether he
ASKS; he does not control whether they ANSWER.

| | |
|---|---|
| Authority | `enrollments.testimonial_received_at` (nullable) |
| Anchor | `enrollment_status_events.entered_at` of the `offboarding` event |
| Stage identity | task types `collect_testimonial`, `testimonial_followup_1`, `testimonial_followup_2` |
| Idempotency | unique index on `(enrollment_id, type)` — NOT scoped to open tasks, so a spent stage never returns |
| Suppression | `status = 'cancelled'` with a `done_date` — never a false "completed" |
| Boundary | `testimonial_sequence_settings.not_before` singleton |
| Schedule | `reconcile-testimonial-tasks`, hourly at :53 |

**Outreach done is not a testimonial received.** Completing a stage means
Leif asked. Only the timestamp means it arrived, and exhausting both
follow-ups never sets it — "asked twice, never received" is a state the CRM
holds truthfully.

### Both programmes now ask, each from its own moment — 2026-10-06

Growing Yourself Up was switched on the same day, which broke the single
global boundary: one `not_before` could only have dragged The Living
Example's activation forward (silently un-enrolling its clients) or handed
GYU every client it had ever offboarded. **So the boundary moved onto the
Offer**, beside the flag:

| | |
|---|---|
| Enabled + boundary | `offers.collects_testimonial` + `offers.testimonial_activated_at` |
| Explicit per-client inclusion | `enrollments.testimonial_sequence_opted_in_at` |
| One definition of "in the sequence" | `testimonial_sequence_enrollments()` |
| Retired | the `testimonial_sequence_settings` singleton — its value was carried onto LE's row to the second |

**This also closed the name fragility.** Enablement used to be a flag
seeded by exact Offer name, so a recreated Offer would quietly never ask.
Configuration now lives on the canonical row, both fields defaulting to
"no", and the one-time seeding is scoped to the row the offboarding
requirement templates themselves point at — not to a name. A new Offer is
never enabled by inheriting one.

GYU's ordinary offboarding is unchanged and still what completes it:
`slack_removed` and `calendar_removed`, both required. A testimonial is
still not a requirement on either programme.

### Two clients who offboarded three hours too early

Jules Litman-Cleper (Enrollment 48, still offboarding) and Adriano Castro
(50, completed) both entered offboarding at 2026-10-06 16:56 — about three
hours before LE's activation at 21:59. Leif decided they should still be
asked.

**Moving LE's boundary backwards was refused**, because a boundary that
moves to catch two people also catches everyone earlier, which is the broad
backfill this design exists to prevent. They are opted in individually by
`20261006160100`, a MAIN-ONLY migration listed in the replay manifest: it
owns no structure, asserts the two records' real shape, and proves that
nothing else became eligible and neither status changed. Their Day 0 task
is raised by the engine, not written by hand.

**No GYU backfill.** GYU is prospective from its own activation; whether any
historical GYU client should be opted in is a separate decision, like these
two were.

### Two security bugs found by building it

`reconcile_testimonial_tasks` is SECURITY DEFINER, which Postgres creates
with EXECUTE to PUBLIC — anon could have driven reconciliation through
PostgREST. Locked to `postgres` + `service_role`, matching both sibling
reconcilers.

Then locking `testimonial_person()` down the same way **broke Start
offboarding outright** ("permission denied for function
testimonial_person"), because the offboarding trigger runs as whoever
pressed the button. It keeps EXECUTE for `authenticated` and
`service_role` and is revoked from `anon`. The migration asserts BOTH
halves, because only asserting the lockdown is how the first fix broke the
product. **The Golden Journey is what caught it** — the migration's own
assertions run as `postgres` and could not have.

### A saved configuration shadows newly-shipped defaults (durability note, NON-BLOCKING)

Found by a production acceptance failure, not by a test. Leif read
`collect_testimonial` on Enrollment 48 while the deployed bundle
demonstrably contained "Ask for testimonial" — both true at once.

`useConfigurationContext` merges the stored `app.configuration` over
`defaultConfiguration` **one key deep**, and `useConfigurationLoader` fills
that store from the `configuration` singleton row. So **any persisted
configuration ARRAY replaces its shipped counterpart wholesale**: a value
added to a default array by a later release is not relabelled, it is
absent. `taskTypes` is the instance that bit; `companySectors`,
`dealCategories`, `dealStages` and `noteStatuses` have the same shape. It
also explains why exactly one of two changes in one deploy landed — the
card polish is markup, the label was configuration.

`tasks/taskTypeLabel.ts` closes it **for task labels only**: a saved
vocabulary falls through to this release's own, then to the Needs
Attention inventory, and only then to the stored identifier. Leif's own
relabelling still wins. Deliberately not generalised into a configuration
merge change — that would resurrect entries he may have removed on
purpose, and the Add Task picker is driven by
`MANUALLY_CREATABLE_TASK_TYPES` (derived from the inventory's `origin`),
so the three stages stay **unavailable for manual creation**, which is
correct. They are system projections.

Consequence to expect, and it is fine: Settings still lists only the saved
vocabulary, so the three stages do not appear there to edit.

**The testing lesson is the larger half.** Every component fixture builds a
fresh `memoryStore` over a `configuration` row of `{}`, so the loader's
non-empty guard skipped it and shipped defaults always won — and the
harness passes a custom `layout` prop, which REPLACES the Layout that
`useConfigurationLoader` lives in, so no component test in this codebase
can load a saved configuration at all. Measured, not assumed: with a
`<CRM taskTypes>` prop and with a pre-seeded store, the context still
reported this release's full vocabulary. The green runs were honest; they
described a browser nobody uses. The repair is therefore covered at the
one layer that can state the broken state (`taskTypeLabel.test.ts`, where
the vocabulary is an argument) and at the one environment that can run the
whole chain (`e2e/testimonialTaskLabels.spec.ts`, which writes a
pre-release vocabulary into the `configuration` row and loads the built
app with the real Layout, loader and store).

## 8b-testimonial. HIGH PRIORITY — CLIENT OFFBOARDING TESTIMONIAL SEQUENCE (NOT YET DECIDED)

**Not built. Not to be built inside an Applications slice.** Recorded
2026-10-06 at Leif's instruction, with the design traps already found so
that whoever picks it up does not rediscover them.

### What offboarding is today, and why it is not enough

Offboarding a Living Example client raises exactly ONE requirement:

    offer 1  notes_archived  "Move {name}'s session notes to Past Clients"

(Growing Yourself Up has two: `slack_removed`, `calendar_removed`.) They
live in `offboarding_requirement_templates`, are SNAPSHOTTED into
`enrollment_offboarding_items` by `handle_enrollment_offboarding_started()`
at the moment an Enrollment genuinely moves `active -> offboarding`, and
each item gets one Task pointing at it through `tasks.offboarding_item_id`.

Archiving the notes is not the end of offboarding. The sequence Leif wants:

1. Archive client notes page
2. Collect testimonial
3. Testimonial follow-up #1 — **only if no testimonial yet**
4. Testimonial follow-up #2 — **only if still no testimonial**

### The rule that shapes the whole design

**#3 and #4 are NOT unconditional reminders.** There must be a durable
"testimonial received" authority, and once it is true:

- pending testimonial follow-ups stop surfacing
- Leif stops being nagged
- the FACT that a testimonial was received is preserved as history

Either shape is acceptable, and whichever is chosen has to be proved:

- **pre-created** follow-ups must be cancellable/suppressed the moment
  received becomes true, or
- **conditionally generated** follow-ups must be proved to appear only
  when due AND received is false.

### The precedent to copy

This CRM already has exactly this pattern, and it works:
`schedule_application_review_escalations()` creates a task only while its
condition holds and CLOSES it when the condition stops — which is why
§4 Tasks records that a system Task reappears if deleted while its
condition is live. A testimonial follow-up is the same kind of object: a
projection of "no testimonial yet, and it is time to ask again", not a
row somebody remembered to tick off.

### Two obstacles that are already known

**1. `tasks_one_open_per_offboarding_item` allows ONE open task per item.**
So follow-up #1 and #2 cannot both be open against the same offboarding
item. Either they are separate items, or that index needs exactly the
treatment `tasks_one_open_review_per_application` just received in
§8b-appnotes — narrow the predicate to the type it is really about. Do not
simply drop it.

**2. The requirement set is snapshotted at the START of offboarding.** A
follow-up that becomes due WEEKS later does not fit "create every item at
transition". Adding it to `offboarding_requirement_templates` would raise
all three testimonial steps at once, on day one, which is the nagging the
rule above forbids. That is the crux of the design, and it is why this is
not a seed-data migration.

**3. There is no admin UI for requirements by design** — "a future
requirement is a migration like this one, not a schema change". A new
durable `testimonial_received_at` (or equivalent) IS a schema change, and
needs the same deliberateness as any other.

### WAITING ON LEIF — do not invent it

**The follow-up cadence is TBD by Leif.** How long after offboarding
starts does #3 fire, and how long after that #4, and is there a point at
which the CRM stops asking entirely? Nothing should be built until he
says, because a guessed cadence is indistinguishable from a bug to the
person being nagged.

## 8b-buffer. HIGH PRIORITY — LE SAFE-OPENING BUFFER (NOT YET DECIDED)

**Recorded 2026-10-04. Do not implement without Leif's decision.**

The Living Example is twelve client sessions, and the openings engine
currently treats the twelfth session week as the moment the slot frees. In
practice that **overbooks Leif**. People skip, reschedule, miss weeks and
run long, so a container that is nominally finished often is not, and a new
client advertised for the following week lands on top of the old one.

The desired model is **12 session weeks + an owner safety buffer** before
another client may start. Likely one eligible working week, possibly two.
**The exact policy is not decided**, and 13-vs-14 is Leif's call, not an
implementation detail to guess at.

Two concepts that must not be conflated when this is built:

- **Projected final session week** — still counts the actual 12 sessions
  (plus one eligible week per cross-week reschedule). This is what the
  client row and the edit modal show, and it does not change.
- **Next safe opening** — adds the owner buffer AFTER that container.
  This is the openings forecast, and it is the only thing the buffer
  touches.

Where it would go: `capacity/weekCapacity.ts` / `occupancyLedger.ts`
decide when a slot frees; `computeExpectedEnd` must be left alone.

Priority order from here: (1) finish LE lifecycle production acceptance,
(2) start/end modal UX and the shared projection — both done,
(3) the parked Payment Pages (real-Postgres concurrency, Stripe TEST
proof), (4) **this buffer policy**, (5) Applications-page UX cleanup.

## 8b-apps-accepted. APPLICATIONS STABILIZATION — PRODUCTION ACCEPTED 2026-10-05

Accepted by the owner in production at `8ec9afe3`, against the real
database and the real deployed bundle. Three defects closed, and one
regression this slice itself introduced and closed before acceptance.

### What the production audit proved

| | verdict |
|---|---|
| 150 migrations, `20261005120000` applied, nothing newer | PASS |
| parked payment work absent (0 tables, 0 columns) | PASS |
| GYU: offer 2, tag `24082732` `GYU-NeedsHigherCare` → `GYU_NeedsHigherCare` | PASS |
| LE: offer 1, tag `24082725` `MiniDD_NeedsHigherCare` → `MiniDD_NeedsHigherCare` | PASS |
| exactly 2 automation hand-offs, no other event configured | PASS |
| Application 97 → Deal 268, 146 → 267, same person, same programme | PASS |
| no duplicate live Opportunity | PASS |
| Terry 204 and Olivia 211: 4 responses, 4 raw keys, **0 uncovered** | PASS |
| residual keyless-response + non-empty `raw_answers` class | **0 rows** |
| `reject_application_response_mutation` present | PASS |

Human UI acceptance, all four: Terry's answers render once and Kit reads
"Handed off to Kit automation." with no manual-email warning; Olivia's
answers render once; Samantha and Celia both show normal Review Decision
controls with the unlinked message **and** the Resolve card gone.

Those last two vanish as a pair by one mechanism, which is why both were
checked: with `opportunity_id` set, `applicationAdoption` returns
`already-linked` so `BringIntoCrmCard` renders nothing, and `deal` is
truthy so `ApplicationReviewActions` replaces the explanation. One without
the other would mean something is still wrong.

### A row count is not an invariant

The acceptance SQL first asserted `application_responses = 832`, the number
measured when the table was built. By acceptance day it was **888** — real
Applications had arrived. Leif caught it before the audit ran: an invariant
that a legitimate new Application breaks would have reported FAIL on a clean
database and taught everyone to ignore the audit.

What is durable is the **trigger**, not the count, so that is what is
asserted now. The same test applies to any future acceptance query: assert
what the database refuses, never a number that ordinary business changes.

### The regression this slice produced, and the rule it leaves behind

The duplicated-answer fix shipped with `if (isPending) return null` on
`ApplicationAnswerSections` — reasoning that waiting was more honest than
showing a duplicate for a moment. It is not. An imported Application whose
answers live **only** in `raw_answers` then rendered nothing at all until a
query that had nothing to say about it resolved.

It passed locally three times and failed in CI, which is slower. **Local
timing is not evidence about a loading state**: the only honest test is one
whose query never answers, which is what
`applicationAnswersRenderOnce.test.tsx` now does.

The rule: **a second query may remove a duplicate, never withhold a
person's words.** An unknown response set covers nothing; a failed one
covers nothing either. Fixed in `e80d11bc`.

### Still open

- **Residual duplicate class is empty today, which is not a guarantee.**
  `question_key` is NULL for recovered history, so an Application with
  keyless responses beside a non-empty `raw_answers` could still show an
  answer twice. Production has none. Dedupe is by `question_key` only —
  never by displayed text, because two different questions can share an
  answer and collapsing them would delete someone's words.
- **LE historical Needs Higher Care cases: none.** No automatic
  post-boundary Kit decision has been accepted yet (§8b-accepted). Do not
  manufacture one.
- **Harness hook tests fail on macOS only**, in `.claude/hooks/test/`
  (6 tests). `os.tmpdir()` is `/var/folders/…` while its realpath is
  `/private/var/folders/…`, so the hook sanitizes git's resolved path
  while the test computes from the unresolved one. Linux CI has no such
  divergence and is green. Tooling debt, no product impact.

## 8b-appnotes. APPLICATION EMAIL HEADER + NOTES & FOLLOW-UP — PRODUCTION ACCEPTED 2026-10-06

A private working area at the foot of every Application: what Leif is
thinking while reviewing it, and what he must do before deciding — plus
the applicant's email under their name, so writing to someone he is
reading about costs no navigation.

**Accepted in production on Carey Christian** (Application 195). The
header shows his canonical Contact email beneath his name and the mailto
opens; notes and a follow-up task both survived a full reload; and adding
either left the Application's decision state untouched. Production SQL
confirmed all of it independently: 151 migrations, `application_notes`
with RLS and four policies, **anon DML = 0**, `application_id` NOT NULL,
the review-task index scoped to `type = 'review_application'`, and no
parked payment tables.

A presentation pass followed acceptance: saved notes floated under the
composer with a generic "You added a note" and read as loose text rather
than records. They now sit in their own bordered rows under a **Private
notes** subsection, each with a truthful byline — the note's own
`sales_id`, resolved through `useGetSalesName`, beside the time — and the
note's words as the primary content. The shared `Note` component gained a
`variant="compact"` for this; every other caller keeps `"default"`,
unchanged.

**Notes are scoped to ONE Application.** `application_notes` is a sibling
of `contact_notes` and `deal_notes` — same shape, same semantics, the same
`Note` component rendering, editing and deleting each one. It exists
because a Contact may apply more than once, and reasoning about one
application must never surface on another, which a Contact-scoped note
cannot express. `anon` is revoked outright and the table is listed in the
posture spec: these are notes ABOUT an applicant and must never be
reachable BY one.

**Tasks reuse the task system**, pointed at the Application through the
`application_id` the table already carried, with type `other` — which the
schema already calls "Leif's own note" and already exempts from the
machinery that cancels sales-driven tasks when an Opportunity ends. No new
type, no second task engine.

### The index was stricter than its own name

`tasks_one_open_review_per_application` keyed on `application_id` alone,
so it allowed one open task of ANY type. Since an Application awaiting
review HAS an open `review_application` task, adding a follow-up was
refused outright. The predicate now includes `type = 'review_application'`.
Nothing relied on the broader reading:
`schedule_application_review_escalations()` guards with its own
`not exists (... and t.type = 'review_application' ...)` and uses no
`ON CONFLICT`, and `review_application()` closes the review task by type.
Migration `20261005140000`, whose assertions run against rows inside a
subtransaction it always rolls back — so it proves behaviour without
writing data, and without a cleanup DELETE that would have to succeed in a
database where contact deletion is closed on purpose.

### Two things the e2e work taught, both worth keeping

**`resetDb` is an automatic fixture: it empties every table before EVERY
test.** So seeded rows cannot be shared across tests in a journey. A
journey split into "add a note", then "add another", then "check
isolation" has its fixture deleted underneath it between steps, and the
symptom is not an empty table — it is the page's own honest "That note
could not be saved", because the Application the note points at no longer
exists. **A multi-step database journey belongs in ONE test.** It is why
[applicationNotesAndTasks.spec.ts](e2e/applicationNotesAndTasks.spec.ts)
does the whole write journey in a single test, on the desktop project
only, with the mobile project proving layout and writing nothing.

**A `getByText` assertion can be satisfied by the textarea the text was
just typed into.** An earlier version of that spec passed while nothing
had been saved at all. Assertions about saved notes are scoped to
`data-testid="application-notes"`, and the reload step additionally
asserts the composer is empty, so typed text cannot satisfy them.

### BACKLOG — the shared note composer takes only one note per page load

**Not this slice, and not caused by it.** `notes/NoteCreate.tsx` can
reliably add only ONE note per page load: the first saves, the box keeps
its text, and the next is dropped. `CreateBase` holds the record it just
created and the form re-seeds from it, landing after the handler's own
`reset()`. **Reproduced on the Opportunity drawer with every file of this
slice reverted**, so Opportunities have this today.

This is why the Application page owns its own small composer
([ApplicationNoteComposer.tsx](src/components/atomic-crm/applications/ApplicationNoteComposer.tsx))
rather than depending on the shared one — the file says so. The repair
deserves a bounded slice with the Opportunity and Contact pages in scope
and their own acceptance.

One real fix WAS taken here, because it is a correctness bug rather than a
lifecycle one: the shared composer wrote the note's status back onto its
parent record for every reference. For a deal that was a no-op; for any
parent with a meaningful status — an Application — it would have sent a
status to the record itself, so a private note could reach its own
decision state. It now says which record it is for.

## 8f. Application decision expansion — PRODUCTION ACCEPTED 2026-10-09

Leif can offer an applicant the other programme, or answer one personally,
and both decisions behave truthfully end to end. Production tip `a703303a`;
migration `20261008140000`, deterministic, **157 total**.

**Production verification, read back by Leif.** Migration total 157 and the
decision migration applied exactly once. New-event mappings = 6, all with
real Kit ids. Bespoke mappings in the wrong mode = 0, bespoke mappings
claiming an automation = 0, Offered mappings incorrectly manual = 0. The
eight original mappings preserved, Do Not Engage still unmapped, duplicate
tag decisions = 0.

**The six production Kit mappings, as they now stand:**

| Programme | Event | Tag |
|---|---|---|
| The Living Example | offered_other_programme | `LE_Offered_GYU` |
| | bespoke_accepted | `LE_Bespoke_Accepted` |
| | bespoke_denied | `LE_Bespoke_Denied` |
| Growing Yourself Up | offered_other_programme | `GYU_Offered_LE` |
| | bespoke_accepted | `GYU_Bespoke_Accepted` |
| | bespoke_denied | `GYU_Bespoke_Denied` |

**Human acceptance.** An LE application offers *Offer Growing Yourself Up*,
*Bespoke Accepted* and *Bespoke Denied*; a GYU application offers *Offer The
Living Example* and the same two. The LE → GYU cohort-selection dialog was
verified in production and cancelled — **no real applicant was mutated.**

### What this cost, and the two rules it leaves

Six commits, three of them repairs to the same mistake made in different
places. Both are worth more than the feature.

**A UX claim is proved by walking the user's route, in the built app, or it
is not proved.** The Kit mapping box existed the whole time and had no door:
first for the group programme on the Programs hub, then — after I "fixed" it
— for BOTH programmes on the detail pages, which is where Leif actually
manages a programme. In between I reported the affordance as "live and
reachable" on the strength of counting a prop name in the production bundle.
That proved which build was deployed and nothing whatever about reachability,
and a screenshot refuted it. Deployment identity and reachability are
different questions and a bundle answers only the first.

**A stale bundle argues both ways.** Walking the repaired route the first
time, the menu was absent — and the page was right; the browser tab was
holding the previous build. One more step and that would have been reported
as a broken repair, which is the same error with the sign flipped. The app is
a PWA; hard-refresh before judging it, and check which asset actually loaded
before believing either answer.

**OFFERING THE OTHER PROGRAMME IS NOT A REJECTION.** Leif is willing to work
with this person; she thinks the other programme suits them better. The two
halves that have to coexist:

- **The Application keeps saying what they applied for** — `offer_id`,
  `intended_cohort_id`, the questions, the answers, `submitted_at`, `source`.
  None of them is in any UPDATE the decision performs, and a contract test
  says so.
- **The sales path moves, on the SAME Opportunity.** `deals.offer_id` becomes
  the recommended programme, stage `approved`, outcome cleared — that
  programme's approved path, **including its round**. Nothing creates a second
  Opportunity.

**The invariant was already there.** `enforce_application_opportunity_agreement()`
refuses an Application whose offer disagrees with its Opportunity's **unless a
`deal_offer_events` row records the Opportunity moving AWAY from it**; its own
hint says a recorded programme change is what "makes the original application
legal history". So this reuses that escape clause rather than building a second
redirect architecture. Without the event row, "Correct application" on a
redirected record would have failed with a raw database exception — proved in a
clean-room probe before the UI existed.

`deal_offer_events` is **closed to `authenticated`** (forging offer history is
how a disagreement could be made to look legal), so the row is written by a
SECURITY DEFINER trigger on `deals` as a consequence of a decision that is
already recorded — the same posture as `enqueue_kit_application_decision()`, and
revoked from every role the same way. The two programme-change authorities stay
**disjoint by construction**: `transfer_enrolled_opportunity_offer()` requires
an Enrollment and this refuses to run beside one.

**Direction is never asked for.** The destination is the one OTHER `is_active`
programme — so `1:1 Coaching (Legacy)` is never a candidate — and both layers
**refuse rather than guess** if that is ever not exactly one
(`recommendation-ambiguous`, and the button simply is not offered). A
destination becomes part of somebody's history the moment it is recorded.

Three refusals, all checked **before the first write**, so a refusal still
means nothing happened: `recommendation-ambiguous`, `already-enrolled` (moving
an enrolled client carries a checklist and is the client page's job), and
`scholarship-held` (`handle_deal_saved()` refuses an offer change while a
scholarship place is held — named here so the page can say why instead of
showing a raised exception).

**BESPOKE IS A COMMUNICATION MODE, NOT A NEW ELIGIBILITY MEANING.**
`bespoke_accepted` writes the same shape `approved` does (stage `approved`,
outcome cleared, the operational approved path untouched); `bespoke_denied`
writes `outcome = 'not_fit'` and leaves the stage where it is. Two values
rather than one, because "bespoke" on its own would be an unresolved state
sitting in a queue that only knows decided from undecided.

### The queue was not taught a new vocabulary

Everything new leaves Needs Review because it sets a status that is not
`pending` and stamps `reviewed_at` — which is all `classifyApplication()` and
`applications_awaiting_review` have ever asked. Neither mentions the new
names, and a contract test asserts they do not. The processed set is therefore
Approved, Needs Higher Care, Not a Fit, Do Not Engage, Offered the other
programme, Bespoke Accepted, Bespoke Denied.

### A group destination needs a round — the defect, and the rule

**The first version left the Opportunity on Growing Yourself Up with
`cohort_id` NULL.** The LE Opportunity it moved had no round to carry, the
`CASE WHEN group THEN cohort_id` kept that null, and nothing refused it.
Nothing downstream would have either: **Enrollments have no cohort of their
own — the Deal's round IS the client's round** — so winning that sale produced
a GYU client with no round, no start date (`handle_deal_won` reads
`program_start_at` from the Deal's cohort, and
`enrollments_start_date_has_a_source_check` is satisfied by a null pair), and
no presence in any round's capacity, which counts by `cohort_id`. Quiet,
legal, wrong.

**There was no existing cohort-selection authority to reuse, and that is a
finding rather than a gap: nothing in this CRM infers a round.** The public
form takes it from the URL; adoption takes it from the Application's own
`intended_cohort_id`; a waitlist batch and a Deal edit take it from Leif. Every
path is given a round by somebody. So this does not start inferring one.

**What IS reused is the predicate.** "Still taking people" already had a
canonical definition in the public application path — `status =
'applications_open'` AND the Denver-date window — while
`classifyApplication` asked only about the status. The public form's is the
honest one: a round whose applications closed yesterday is not open, whatever
its status column has not yet been changed to say. It now lives in
`cohorts/cohortEligibility.ts` (TypeScript) and
`public.offer_accepting_cohorts()` (SQL), and `publicOfferContext.ts` imports
it rather than keeping its own copy. `classifyApplication` is deliberately
left alone: its clause decides whether an IMPORTED record is still review
work, which is a question about Leif's attention rather than about selling a
place, and narrowing it would quietly send old questionnaires back to history.

**The rule, at both layers:**

| Rounds of the destination taking applications | What happens |
|---|---|
| exactly one | assigned automatically — there is nothing to choose between |
| none | **refused**, `no-eligible-cohort`, nothing written |
| more than one | **asked**, `cohort-choice-required` with the candidates |
| destination has no rounds at all | round cleared — The Living Example has none |

`review_application` takes a third parameter, `p_cohort_id`, defaulting to
null. The two-argument form is **dropped** rather than kept beside it: two
overloads where one has a default makes a two-argument call ambiguous, and
PostgREST would start failing on every decision. A round Leif names is still
checked against the programme AND against still being open, so a stale tab
cannot place somebody in a round that closed while it was sitting there
(`cohort-invalid`).

`RecommendProgrammeDialog` carries all four cases: it names the only round, or
asks which with one bordered row per round in `ResolveOpportunityDialog`'s
existing language, or says no round is open and offers nothing to click. There
is no single confirm button in the choose-one case, because confirming without
choosing would be a guess.

### The inverse, proved

GYU → The Living Example: the Application keeps `offer_id` = GYU **and
`intended_cohort_id` = its original round**; the Opportunity becomes LE with
`cohort_id` NULL, because LE has no rounds. Asserted side by side in the same
test, in both the domain suite and against real Postgres — the kept round and
the cleared one are the pair this decision turns on.

### A bespoke decision cannot send the standard email — twice over

1. **Its own Kit event.** `kit_tag_mappings` is keyed `(offer_id, event)` and
   the event name IS the status, so `enqueue_kit_application_decision()` passes
   `new.status` straight through: there is no mapping step where a bespoke
   decision could be translated into `approved`. The approved / not_fit tags an
   automation may hang off are simply not the tags it applies.
2. **It may not share a tag either.** Forcing `followup_mode = 'manual_email'`
   says what the CRM will TELL Leif; it does not stop the TAG being the one an
   approval automation hangs off. Mapping `bespoke_accepted` to
   `MiniDD_Approved` would have sent the standard letter to somebody she meant
   to answer personally while `followup_mode` sat there reading "manual_email".
   **Found by probing the first implementation, not by reasoning about it.**
   Kit's topology is unreadable from here, so `enforce_bespoke_kit_separation()`
   refuses what the CRM CAN see: a bespoke decision sharing a tag with the same
   programme's `approved`, `not_fit` or `offered_other_programme` event — in
   **both** directions, so the order the two mappings are configured in cannot
   decide whether the rule holds. `set_program_kit_tag()` returns the readable
   `tag-already-used-by-another-decision`; the trigger is the last word even
   for `service_role`.

`do_not_engage` still has no Kit event at all, and still reaches no tag.

### Decisions are NOT editable, and this slice did not make them so

Audited and reported rather than built. `review_application()` refuses a
non-pending Application (`already-reviewed`), and `ApplicationEditDialog`
deliberately excludes `status` and `reviewed_at` — its own comment says a
status changed there "would be a decision with no moment attached". There is
no reconciliation behaviour to extend, so the new decisions inherit the same
one-way door. **Correcting a decision is its own slice** and is not started
here.

### Kit tags — all six exist; only the mapping is left

Nothing automated creates these: the CRM applies tags, it never invents them,
and `kit_tag_mappings` needs a real `kit_tag_id`. **No tag name is in the
migration or in any runtime constant** — they are owner data, which is why
settling the names twice touched one spec fixture and this file and nothing
else.

| Programme | Event | Tag | Remote Kit state |
|---|---|---|---|
| The Living Example | Offered the other programme | `LE_Offered_GYU` | tag **and** automation |
| | Bespoke Accepted | `LE_Bespoke_Accepted` | **tag only — no automation, deliberately** |
| | Bespoke Denied | `LE_Bespoke_Denied` | **tag only — no automation, deliberately** |
| Growing Yourself Up | Offered the other programme | `GYU_Offered_LE` | tag **and** automation |
| | Bespoke Accepted | `GYU_Bespoke_Accepted` | **tag only — no automation, deliberately** |
| | Bespoke Denied | `GYU_Bespoke_Denied` | **tag only — no automation, deliberately** |

One convention throughout: `SOURCE_Decision[_Destination]`. The redirect pair
names where somebody is being sent; the bespoke four name the decision. No
legacy `MiniDD_*` tag is renamed — `MiniDD_Applicant`, `MiniDD_Approved`,
`MiniDD_NeedsHigherCare` and `MiniDD_Denied` are untouched and still the
tags the four original decisions apply.

**The four bespoke tags must stay automation-free, and the database enforces
the half of that it can see.** `kit_tag_mappings_bespoke_is_manual_check`
refuses a bespoke mapping whose `followup_mode` is anything but
`manual_email`, and `enforce_bespoke_kit_separation()` refuses a bespoke
mapping that shares a tag with the same programme's `approved`, `not_fit` or
`offered_other_programme` event — in both directions, so configuration order
cannot decide whether the rule holds. Neither can be bypassed by
`service_role`. What the CRM cannot see is Kit's own automation topology, so
"attach nothing to these four" remains an instruction rather than a check.

**Until a tag is mapped, that decision enqueues no Kit work at all.**
`enqueue_kit_application_sync()` returns null on an unmapped event — the
existing "no mapping is a refusal, never a guess" posture. The decision still
records correctly and still leaves Needs Review; only the tag is absent.

### The Kit box existed and had no door — found at configuration time

Leif could not map the six tags, and the instruction I gave was wrong about
where to go.

**The box is on the Offer's own EDIT form** (`OfferInputs` →
`OfferKitSection`), not on the programme page and not on the Offer SHOW page.
On the Programs hub a **1:1** programme renders an `IndividualProgramCard`
whose "⋯" menu carries **Edit program** → `/offers/:id`, so The Living Example
was always configurable. A **group** programme rendered as a bare text link to
its own page. Its ROUNDS had menus, and those route to `/cohorts/:id` — a
different form with a different, round-level Kit field. `GroupProgramPage` has
no edit affordance either.

So **Growing Yourself Up's programme-level Kit mapping had no route anywhere
in the Programs UI.** The only way in was the avatar menu's Offers list, which
its own code describes as "administrative/reference UI: low-prominence by
design". That is a product defect, not a documentation slip — my navigation
was wrong, and the destination was unreachable for the programme that needed
it.

**The repair is the sibling's own affordance, not a new one.** The group
programme's heading row now carries the same `ProgramCardMenu` the 1:1 card
has, pointing at `/offers/:id`. One component, one menu, one answer to the
same question about the same kind of record — no Kit settings redesign.

Verified in the real built app against real Postgres: Programs → Growing
Yourself Up → ⋯ → Edit program → `#/offers/2`, name filled in, the **Kit
automation** box showing Applicant, Approved, Needs Higher Care and Not Fit
already mapped and **Offered the other programme**, **Bespoke Accepted** and
**Bespoke Denied** reading "Not set" with a **Choose** button, under the
honest aside "Kit automation not fully configured".

**Two things the tests taught, both kept.**

- A structural assertion I wrote first — "the programme's heading row has an
  actions menu" — PASSED with the repair reverted, because the heading's
  parent also contains the round cards and a round has a menu of its own. It
  was the exact confusion it was written to guard against. Removed rather than
  left: a test that cannot fail for its own reason is worse than none, and the
  behavioural test beside it does fail without the repair.
- `GroupProgramUX.test.tsx` reached the Fall round's menu as `menus[1]`, and
  every index shifted when the programme gained one. Those three tests now
  find a menu by the card's NAME and derive the index from it, so what comes
  before them on the page cannot move them again. The click still goes through
  the framework, because a raw `element.click()` does not open a Radix
  dropdown.

### …and then had the wrong door — the proof that was not a proof

The hub repair above was real and is kept. **It was not the gap Leif hit.** She
manages a programme from its own DETAIL page — `/#/programs/individual/1` —
which showed the heading, Copy Application Link and capacity, and offered no
way to edit the programme at all. Neither did the group one.

**And the proof I gave for the first repair was worthless for the question
being asked.** I counted a prop name in the production bundle and concluded
the affordance was "live and reachable". A call site existing somewhere says
nothing about whether the route somebody walks exposes it. Deployment identity
is what a bundle can prove; reachability is not, and I used one for the other.
The rule this leaves: **a UX claim is proved by walking the user's route, in
the built app, or it is not proved.**

**The repair:** both programme detail pages now carry one programme-level menu
in their header — The Living Example's beside the Copy Application Link it
already had, Growing Yourself Up's alone — wrapped in
`data-testid="programme-header-actions"`. It is the same `ProgramCardMenu` the
hub cards use, and **Edit program** opens the same Offer edit form. No second
settings form, nothing on a client row, no change to capacity, clients or
applications.

The test hook earns its place: a group programme's page also lists its rounds,
and a round card carries a menu of its own that goes to the round's form.
Reaching for "the first Program actions on the page" found that one and proved
nothing — which is how the regression caught itself before the repair existed.

`e2e/programmeConfiguration.spec.ts` walks the real route in the built app
against real Postgres: nav → Programs → the programme → Edit program → the
Offer form with its name filled in → the Kit automation box carrying **Offered
the other programme**, **Bespoke Accepted** and **Bespoke Denied**. Both
programmes, both browser projects. With the two pages reverted, all three
tests fail.

### Where the mapping lives, now that it is done

**Programs → the programme → its header "⋯" → Edit program → the Kit
automation box**, for both programmes, from the page Leif actually manages
them on. All six are mapped in production (the table in §8f above).

The picker reads Leif's real Kit catalogue, so each one is chosen rather than
typed, and the id stored is Kit's own. **Each Choose writes its mapping
immediately** — `set_program_kit_tag` is called there and then, and the form's
Save persists only the Offer's own fields. Cancel does not undo a mapping. A bespoke mapping sets its own
`followup_mode = 'manual_email'`; attempting to give a bespoke event a tag
already used by a sending decision answers
`tag-already-used-by-another-decision` and writes nothing.

### What the runtime actually requires — audited, not assumed

**Only the tag mapping.** `enqueue_kit_application_sync()` reads
`kit_tag_mappings.kit_tag_id` and `kit_tag_name` and copies them onto the
operation; the worker applies the tag by id. Nothing else is needed for a
decision to reach Kit.

- `followup_mode` is **optional**, and changes exactly one sentence
  (`followupNote()`): "That email still needs to be sent by hand." for
  `manual_email`, "Handed off to Kit automation." for `kit_automation` once
  delivered, and nothing at all for `none`. A mapping nobody has characterised
  stays silent, which is correct.
- `automation_name` is **never rendered anywhere**. It is declared on the type
  and named in one `Pick<>`, and no surface prints it. **So the two Kit
  automation names are not needed, and asking for them would have been asking
  for metadata to put in a field nothing reads.**

The two redirect mappings will therefore read `followup_mode = 'none'` and say
nothing after the tag lands. That is silent, not wrong. If Leif wants the
"Handed off to Kit automation." line on redirect decisions, it is a one-line
migration setting `followup_mode = 'kit_automation'` on those two rows — and
still no automation name, since the column's only job today is to exist.
`followup_mode` has no editing UI; that gap is pre-existing and recorded in
§8b-kit.

### The next step in those two emails — the CRM holds no link, by audit

Settled by Leif: a redirected person is **not** sent to another application.
They have applied and been reviewed. Each redirect automation takes them
straight to the destination programme's ordinary approved next step — the GYU
approved-lead call, or the LE Private Deep Dive.

**None of that is CRM code, and the audit is the reason.** There is no booking
or scheduling URL anywhere in this repository — no Acuity link, no
`scheduling_url`, nothing. What the CRM holds about a sales call is
`offers.acuity_appointment_type_id` and `cohorts.acuity_appointment_type_id`,
which are **inbound matchers**: they identify which appointment type's bookings
belong to which programme or round (`sales-calls/offerCohortAcuityMapping.ts`).
An ordinary Approved applicant's booking link lives in Kit's own approval
email, and so does a redirected one's. Nothing was duplicated into the CRM for
documentation's sake.

**One dependency, if the LE → GYU email should NAME the round.** The CRM sends
Kit one programme-level tag per decision, so Kit cannot know which round was
assigned. The mechanism to tell it already exists — `cohorts.kit_tag_id` /
`kit_tag_name`, applied as the `'cohort'` kind — but **no production cohort
carries a Kit tag today**, and wiring the DESTINATION round's tag would also
have to settle the `unique (application_id, kind)` collision with an
applicant's own round tag. Not built, because whether that email names a round
or simply invites the call is Leif's decision about his own copy, not an
inference to make here.

### The two cross-programme emails — Kit's, and Kit's alone

The drafts below were written from the only applicant-facing copy this
repository holds (the two public application pages), because **the existing
Approved / Not Fit / Needs Higher Care copy lives in Kit, not here, and could
not be read.** They are kept as a record of what was proposed; the live copy is
whatever Leif wrote into the two automations, and it is not mirrored here.

Both drafts PREDATE the settled next step and still send the reader to an
application form. **That is wrong now** — a redirected person has already
applied and been reviewed, and goes straight to the destination programme's
ordinary approved call. Read them for voice only.

**The Living Example → Growing Yourself Up**

> Subject: Your Living Example application — a thought
>
> Hi {{ subscriber.first_name }},
>
> Thank you for applying for The Living Example, and for answering as openly
> as you did. I read everything you sent.
>
> After sitting with it, one-to-one isn't where I'd start you. What you
> described tends to shift fastest alongside other people doing the same work —
> being seen while you change, rather than only talking about changing. That's
> what Growing Yourself Up is built for, and it's where I think working with me
> would do the most for you right now.
>
> This isn't a smaller version of what you applied for. It's a different way
> in, and for what you're carrying I believe it's the better one.
>
> Here's where you can read about it and apply for the current round:
> [link to the current cohort's application]
>
> If you'd rather talk it through first, just reply and tell me — I'm glad to.
>
> Leif

**Growing Yourself Up → The Living Example**

> Subject: Your Growing Yourself Up application — a thought
>
> Hi {{ subscriber.first_name }},
>
> Thank you for applying for Growing Yourself Up, and for answering as openly
> as you did. I read everything you sent.
>
> What stands out is how particular this is to you — its shape, and the pace it
> will want to move at. A group round is built to hold a shared arc, and I
> don't think that's where this gets the attention it deserves.
>
> So rather than place you in the cohort, I'd like to offer you my one-to-one
> work instead: The Living Example. That's where I can give this the room it
> needs, and I believe I can meet you there.
>
> Here's where you can read about it and apply:
> https://crm.leifariel.com/#/apply/living-example
>
> If you'd like to talk it through first, just reply and we'll find a time.
>
> Leif

**One operational consequence:** the GYU application link is **per cohort**
(`/#/apply/growing-yourself-up/<cohortId>`), so the LE → GYU email has to be
re-pointed each round. LE's link is stable. Copy Application Link on the cohort
gives the current one.

### Proof

- `applicationDecisionExpansion.test.ts` — 18 tests on the domain action,
  including every refusal leaving the record untouched and all four
  cohort cases.
- `applicationDecisionUx.test.tsx` — 10 tests: the button names the
  destination, says nothing when the destination is ambiguous, confirms before
  recommending, names the only open round, asks WHICH when two are open and
  offers no single confirm, says no round is open rather than offering a sale
  with none, offers bespoke as one menu with two endings, and prints
  "Applied for" beside "Decision" only where the two differ.
- `contracts/applications/aBespokeDecisionSendsNothing.test.ts` — 20 pinned
  assertions against the repository's own text, including that the round comes
  from the resolver and never from the Opportunity being moved.
- `e2e/applicationDecisionExpansion.spec.ts` — **12 tests, real built app,
  real Postgres, independent SQL read-back, fresh browser**: both directions,
  zero / one / chosen rounds, all four bespoke combinations, and Approved /
  NHC / Not Fit / DNE unchanged. The round cases ask the database directly as
  well as through the page, so a refusal is proved at the authority and not
  only at the button.
  **No real Kit call is possible** — `KIT_API_KEY` does not exist in the clean
  room and `kit_sync` returns before claiming work without it, so every
  operation stays exactly as the database enqueued it, which is what makes the
  intent readable.

**One finding worth keeping.** The suite went green on chromium and those two
recommendation tests failed on **Mobile Chrome**, which runs after every
chromium file, with the "Offer …" button simply absent. Nothing was wrong with
the page: `offers` is reference data resetDb deliberately does not clear, so
another spec's programme was still active and the product correctly stopped
offering a recommendation it could no longer resolve unambiguously. The spec
now OWNS that premise — foreign active programmes AND foreign open rounds are
set aside for its duration and restored afterwards — and asserts it with the
offending programmes named, so a future failure says what it found. A viewport
cannot change a decision; a shared catalogue can.

Sensitivity proved by breaking it three ways: letting the recommendation
rewrite `applications.offer_id` (2 tests fail), collapsing bespoke into the
ordinary risk class (2 tests fail), and disabling the normalising trigger so
the constraint has to speak for itself (`REFUSED by constraint:
kit_tag_mappings_bespoke_is_manual_check`).

## 8e. Growing Yourself Up asks The Living Example's questions — PRODUCTION ACCEPTED 2026-10-08

Growing Yourself Up asked four bare questions while The Living Example asked
five, each with a description underneath, and the GYU applications came back
short. Leif's decision: LE's set is canonical, word for word. GYU now asks the
same five questions, in the same order, with the same descriptions, the same
multi-line inputs and the same requiredness.

`public-application/coreApplicationQuestions.ts` is the single source, extracted
from LE's own string literals rather than paraphrased, and parameterised by
prefix — so the two forms share wording while keeping their own key identity
(`le_main_pattern`, `gyu_main_pattern`). **Programme identity is untouched**:
the offer, the per-cohort application URL, `intended_cohort_id`, the
destination, the decision workflow, Kit and Copy Application Link all behave
exactly as before. Only the substantive questions moved.

`20261007170000` (deterministic) demotes the old GYU version and inserts
`gyu_application_core` with the five shared questions. It also realigns LE's
own current rows from curly to straight apostrophes so the two forms are
byte-identical; the *historical* rows were left exactly as they were.

### A key can outlive the question it asked

The defect that nearly shipped, and the most useful thing this slice found.
`gyu_commitment_scale` was used by BOTH generations with DIFFERENT wording:

    OLD  "On a scale from 1-10, how ready are you to make a time, financial,
          and personal commitment to the change you want?"
    NEW  "On a scale of 1-10, how committed are you to changing this
          pattern/way-of-being?"

`answerLabels.ts` is keyed only by `question_key`, so no single entry can be
true for both. The tempting fix — derive every `gyu_*` entry from
`coreApplicationQuestions` and call the class closed — would have relabelled
old applicants with a question they never saw. Leif refused it, correctly: **a
key-only map cannot truthfully label two generations, so it cannot be an
authority at all.**

**The authority order, now explicit in code:**

1. `application_responses.question_text` — the words snapshotted at submission,
   immutable afterwards.
2. the key-label map, ONLY where no recorded wording ever existed.

**The discriminator is `applications.form_key`, and it is exact rather than
heuristic.** It is written in exactly one place —
`materialize_native_application_responses()` — in the SAME transaction as the
`application_responses` rows. Non-null therefore means this submission's own
wording is recorded and *will* arrive; null means none was ever registered (a
recovered Notion record, or a native submission whose Offer had no form
version) and the map is the only thing that can name those questions.

So a versioned submission **waits** for its own words and never borrows a
guess; a raw-only one never waits. This is deliberately NOT the blanket
`isPending` gate that used to sit there — that gate hid an imported applicant's
answers behind a query that had nothing to say about them. The branch is the
point.

`answerLabels.ts` is now documented as a legacy compatibility path, keeps
`gyu_commitment_scale`'s **OLD** wording on purpose (the only applications that
can still reach it are the old ones), and **deliberately omits** the four new
shared keys: they can only exist on a versioned submission, which never reaches
the map, so entries would be dead *and* would falsely imply they can appear on
a legacy record.

### Two things the proofs had to work around

- **The slow window had to stop being a race.**
  `applicationAnswerAuthority.test.tsx` uses a provider that NEVER answers for
  `application_responses`, so the unresolved window is deterministic rather than
  timing-dependent. Sensitivity was proved by restoring the old behaviour: the
  new-GYU test fails with `expected 'Gyu Main Pattern New answer 1 ...' not to
  contain 'Gyu Main Pattern'`, and the second test fails too — revealing that
  the raw layer *wins* that render, so the authoritative wording never appeared
  at all while the window was open.
- **A real submission permanently poisons `resetDb`.**
  `application_responses` refuses UPDATE and DELETE
  (`reject_application_response_mutation`, `before update or delete`), and
  INSERT is allowed. A submitted Application with materialized answers is
  therefore undeletable, which broke every later spec. The write path moved to
  `e2e/applicationQuestionParity.submission.spec.ts` in its own terminal
  `submission` Playwright project, on base `@playwright/test` with no `resetDb`
  at all. The immutability invariant was NOT weakened to make the fixture
  tidy.

Read-only parity is proved on the real built forms in
`e2e/applicationQuestionParity.spec.ts`, and the recorded-question contract in
`contracts/applications/theQuestionAskedIsTheQuestionRecorded.test.ts`.

### Production, read back by Leif

156 migrations; `20261007170000` applied exactly once; LE current questions 5,
GYU current questions 5; wording parity PASS; key prefixes correct; routing
checks pass. **Historical truth intact**: the 910 `application_responses` that
predate the deploy are all still present, any growth above that is fully
accounted for by newer submissions, and the immutability trigger remains
enabled — so a rewrite is not merely absent, it is impossible.

Human acceptance: both forms ask the same five questions with the same
descriptions, order, requiredness and inputs, with GYU's programme and cohort
framing intact; and one real old four-question application still shows only the
questions it was actually asked, in their original wording, each answer once,
with none of the shared set injected and no transient raw-key labels.

Commits: `b4d5c5dd` (question set + migration), `278c60d9` (registry),
`89f92678` (answer-label authority repair — no migration, zero `supabase/`
changes).

## 8d. Applications + Clients information architecture — PRODUCTION ACCEPTED 2026-10-07

**ONE PROGRAMME = ONE CLEARLY BOUNDED CONTAINER.** Both list pages rendered
loose sections with floating headings: Applications grouped one section per
cohort-or-offer, so Growing Yourself Up's cohorts read as peer programmes
beside The Living Example, and Clients rendered a Card per group, so one
programme was three boxes with Past drifting below the last. Each programme is
now one bordered container with its cohorts and sections inside it, divided by
the container's own rule. Grouping nests the existing sections without
re-sorting, so the priority `useApplicationsGrouped` established still decides
programme and cohort order.

One deliberate count correction, approved: "waiting for you across N
programmes" counted cohort SECTIONS, so three GYU cohorts with review work
read as three programmes. It counts programmes now.

**A cohort is not a section.** First acceptance pass failed on this: cohort and
section headings were both `text-sm font-medium`. `misc/programmeHierarchy.tsx`
is now the single ladder used by BOTH pages — programme 18px semibold, cohort
16px semibold, section 14px medium — ordered by size as well as weight,
because weight alone would not have caught it. Clients also stopped repeating
"Growing Yourself Up — " in each cohort heading by using `humanizeCohortName`,
which Applications had used all along.

**Fifty-one applications that were always Fall 2026** (MAIN-only
`20261007120000`, applied once). They carried no `intended_cohort_id` and no
Opportunity cohort, so the page grouped them under "No cohort recorded". Leif's
decision: all 51 are Fall 2026. Repaired the data rather than adding a
`GYU + no cohort -> pretend Fall 2026` renderer rule, which would have hidden a
permanent exception.

Two findings worth keeping:

- **Only `intended_cohort_id` was written.** It is a snapshot of intent AT
  APPLICATION TIME; `deals.cohort_id` is a separate later fact, and
  `01_tables.sql` says outright the two are never kept in sync and may
  legitimately differ. Every target had no Deal cohort, so there was nothing
  to reconcile and no authority to claim one.
- **`classifyApplication` reads the cohort in exactly one clause**: a
  `historical_import` application still `pending` is lifted into Needs Review
  when its cohort is `applications_open`. So a cohort assignment can only
  reclassify a record if that cohort is open. The migration asserts Fall 2026
  is NOT open and refuses if it is — which is what makes "every bucket
  preserved" provable rather than hoped for.

Proved by `scripts/historical-import/proveFall2026Repair.mjs` (independent SQL
read-back, idempotence, and refusal on three broken premises) and
`e2e/fall2026CohortRepair.spec.ts` (migration through psql, then a fresh
browser on the built app).

**Production, read back by Leif:** migration applied exactly once, 155
migrations, one canonical Fall 2026 cohort, 51 applications on it, **zero**
cohortless GYU applications, January 2027 at 22 unchanged, The Living Example
at 100 untouched, zero conflicting Deal cohorts.

## 8c. Applications UX cleanup + Waitlist entry redesign — PRODUCTION ACCEPTED 2026-10-05

Scoped, built and accepted 2026-10-05, after §8b-apps-accepted.

**Accepted on a real person, not a fixture.** Leif added **Lau Iglesia**
through the new flow in production: pasted the address, typed the name,
one action. Independent SQL read-back afterwards — exactly one Contact
(499) owns the normalized email, exactly one waitlist place (entry 113,
`waiting`, `manual`) points at that Contact, one programme only (offer
1), no duplicate Contact and no duplicate membership. The row survived a
full reload.

So the whole chain is proven end to end: paste email → enter name →
Contact created WITH the address → membership created → durable in
Postgres → nothing duplicated.

**One self-inflicted deployment break, fixed in `bf7fdff3`.**
`registry.json` is generated by a pre-commit hook, and **that hook does
not run from a git worktree** — so deleting two components left the
committed registry pointing at files that no longer existed and CI's
`🔨 Build Registry` failed with ENOENT. Every Check gate was green, so it
surfaced only in the `Deploy (doc)` job. **Regenerate `registry.json`
whenever a component file is added or removed from a worktree commit.**

### The diagnosis, done — including one dead end not to re-enter

The earlier note suspected that `ReferenceInput reference="contacts_summary"`
(a VIEW) could not resolve a Contact created into `contacts`. **That is
false.** The view is `from public.contacts` with only LEFT JOINs and no
WHERE, so a brand-new empty Contact appears in it. Do not spend time there
again.

What is actually wrong is the **interaction order**, not a broken write:

- `WaitlistPersonInput` asks for the PERSON first, through an autocomplete,
  with creation buried in the dropdown as "+ Add new person".
- `handleCreatePerson` creates the Contact with `email_jsonb: []` — no
  email at all — splitting a typed string on whitespace into first/last.
- The email is then asked for by a SECOND field,
  `WaitlistContactEmailInput`, which only appears once a person without an
  email is already chosen.

So the one fact that identifies a person is asked for last, and the
operation most often needed is hidden. That is why a try-run could not get
a new person onto a waitlist in one flow.

There was also a genuine defect here, already fixed, that the redesign must
not reintroduce: creating the Contact mid-form invalidated the `contacts`
query, re-rendered the sheet, and ra-core's `useAugmentedForm` reset the
whole form — silently wiping the just-selected Person. It was contained by
freezing `joined_at` for the sheet's open lifecycle. **Creating the
Contact as part of the save, rather than during the form, removes that
hazard structurally instead of relying on a stable `defaultValues` string.**

### Desired behavior — Leif, 2026-10-05

    + Add to Waitlist
      -> opens with Email (focused, ready to paste) then Name
      -> exact normalized email match -> show that Contact, ask whether to use them
      -> no match -> create Contact + Waitlist Entry in one action
      -> name similarity is advisory, never blocking

The search-first workflow and the buried "+ Add new person" are **removed**,
not kept alongside.

### Reuse, do not rebuild

- `findContactByEmail` + `normalizeEmail` already implement the exact
  normalized match. One matcher, not two.
- `checkEmailOwnership` already returns `free` / `already-theirs` /
  `belongs-to-another`, and already refuses rather than merging two people
  or moving an address off someone else. That refusal stays.
- `isContactDoNotEngage` is the single DNE authority.
- `findActiveWaitlistEntry` is the duplicate-active-entry guard.
- **Name similarity has no helper anywhere — it is net new.** Advisory
  only: it may warn, it may never block or auto-merge.

### Requirements that carry forward unchanged

- Reuse the existing Contact when one is found; never create a duplicate.
- No navigating to Contacts first.
- Desired timing and Notes stay Waitlist Entry fields, not Contact fields.
- Source is stamped `manual`, never asked.
- **No fake placeholder email.**
- Fast enough to add a batch of people back to back — so the email match
  runs on blur or debounced, never per keystroke. `findContactByEmail`
  reads up to 1000 Contacts per call; that is fine at today's scale, and
  the real hardening is still a normalized indexed column.

### SETTLED 2026-10-05 — an email is required, and the two rules were never in conflict

Leif's decision, and it draws the line at the right place:

- a **CONTACT** may exist without an email
- an **ACTIVE WAITLIST ENTRY** may not

Because a place opening up is only worth holding for somebody who can be
told about it. So there is no "skip email" path in the modal: a person
Leif has only a name for can be recorded as a Contact, which is a
different act on a different page. No placeholder address is ever
invented, and nothing in the CRM fabricates one.

**This rule now holds on both doors.** Adding a known Contact to a
waitlist from their own page required no email at all, so the rule was
true from the programme page and false from the Contact page. Both now
run the same `applyTypedContactEmail` transform, which also refuses an
address that already belongs to somebody else rather than merging two
people or moving it off the other one.

### What was built

| | where |
|---|---|
| Email-first modal, focused and paste-ready | [AddToWaitlistModal.tsx](src/components/atomic-crm/waitlist/AddToWaitlistModal.tsx) |
| Lookup + the two save paths, as one owner action | [waitlistQuickCreate.ts](src/components/atomic-crm/waitlist/waitlistQuickCreate.ts) |
| Advisory name similarity — never a gate | [contactNameSimilarity.ts](src/components/atomic-crm/waitlist/contactNameSimilarity.ts) |
| The email rule on the Contact-page door too | [waitlistContactEmail.ts](src/components/atomic-crm/waitlist/waitlistContactEmail.ts) |
| Real browser, real Postgres, phone width | [e2e/waitlistQuickAdd.spec.ts](e2e/waitlistQuickAdd.spec.ts) |

Removed, not left alongside: `AddToWaitlistSheet.tsx` and
`WaitlistPersonInput.tsx`. Keeping the search-first path beside the new
one would have left two half-flows instead of one.

**A created Contact whose entry fails is reported, not hidden.** The
person IS in the CRM at that point, and saying "nothing happened" would
send Leif to create them a second time.

**Timing and notes are not asked in the quick-add.** They are still
Waitlist Entry fields and still editable on the entry itself; asking for
them here would slow down the one thing this modal exists to make fast.
Say so if that is wrong — it is a deliberate omission, not an oversight.

**Phone width is tested in Playwright, never in vitest.** The vitest app
project has no Tailwind plugin, so every utility class is inert there and
a layout assertion measures the user agent instead. Proven by breaking it:
shrinking the modal failed the e2e geometry check at 128px against a
required 200px, in both chromium and Mobile Chrome.

### Applications page cleanup — what was found, and what was done

- `ApplicationList` did `if (isPending) return null`, so the page was
  blank while loading. Same shape as the regression closed in
  §8b-apps-accepted, milder consequence — its own primary query, not a
  second layer withholding a first. **Fixed:** the header and New
  Application stay usable and the sections say they are loading.
- **Fixed:** each programme carried three separate Accordion roots for its
  history buckets. They are one `type="multiple"` group now — each still
  opens independently and each keeps its own name, because Reviewed,
  Pre-CRM and Historical are genuinely different things.
- **Fixed:** Review Decision printed "No sales opportunity is linked…"
  beneath the card that already named the situation and offered the
  action. That pair of true sentences was the contradiction itself. The
  explanation now appears only when the card renders nothing, reusing the
  card's own condition.
- The page is `max-w-3xl`; left alone, worth revisiting with Leif rather
  than widened on a guess.
- **Verified NOT broken, do not "fix" it:** the apply link is
  `${origin}/#${path}`, which is correct for this hash-routed app, on both
  the list and `CohortShow`.
- The earlier item 1 requirements are already built: this page IS All
  Applications, and "+ New Application" exists. Deployed and in daily use;
  whether that counts as sealed is Leif's call.

### Then, in order

1. ~~**Applications page cleanup**~~ — the structural half is **built and
   deployed**: January 2027 GYU applications surface as real Needs Review,
   Historical is no longer the catch-all, the current funnel is separated
   from pre-CRM questionnaire history, and the page carries All
   Applications / + New Application. See §4 Applications for what it
   settled. What remains is the **visual/interaction** cleanup now scoped
   at the top of this section.
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

### SESSION ↔ ENROLLMENT RECONCILIATION — recorded 2026-10-01, not this slice

**Production holds session rows with `enrollment_id` NULL even where a
canonical Enrollment does exist.** Measured on 2026-10-01 across all 220
`client_sessions`:

- 22 Contacts have sessions; **20 of them have an Enrollment**, 2 do not
- 13 Contacts have every session linked
- **6 Contacts have every session unlinked** — including Denise Cormier
  (Contact 106: Enrollment 66 active via won Opportunity 97, yet all 10
  sessions carry `enrollment_id` NULL)
- 3 Contacts are mixed
- 47 of 220 session rows are unlinked in total

**Why it matters.** ClientShow is enrollment-scoped and filters sessions by
`enrollment_id`, so its cadence view is blind to those 47 rows. Contact
History is contact-scoped and sees them. That divergence is exactly why
"Sessions · N" opens a lightbox instead of routing to ClientShow
([ContactSessionsDialog.tsx](src/components/atomic-crm/contacts/ContactSessionsDialog.tsx))
— the repair works correctly over the data as it stands, and does not depend
on this debt being cleared.

**A future slice should determine whether and how those rows can be safely
linked. NOT backfilled today, and no link inferred casually**: a session and
an Enrollment overlapping in time is not proof they belong together, and a
wrong link would silently move real appointments onto the wrong container.
ATOMIC HANDLES CERTAINTY. LEIF HANDLES AMBIGUITY.

### Infrastructure debt — tracked separately, blocks nothing above

- `users` Edge Function `SB_PUBLISHABLE_KEY` auth issue (§7).
- GitHub Pages deploy failure — the only red step in every Deploy run.
- macOS `.claude/hooks` worktree-test debt (§7).
- **`e2e-test` has only ~5 minutes of real headroom, and an install hiccup
  spends it.** `timeout-minutes: 10` covers the whole job — `npm ci`, the
  Playwright browser download, `npm install -g wait-on serve` AND
  `make test-e2e-ci` (which itself replays 125 migrations). Measured
  2026-10-01 on `787e3a9a`: the suite ran at its normal speed (Playwright
  step 262s, against 263s on the last green run) but was guillotined,
  because **Install Playwright Browsers took 288s instead of its usual 24s**
  — a browser-download cache miss. 351s of installs + 263s of suite = 614s
  = the cap, reported by GitHub as `cancelled`. Nothing to do with the
  shipped commit; a fresh local run of the same commit was 149s end to end,
  161 passed. **The fix is to stop the installs competing with the suite**:
  cache the Playwright browsers, or raise `timeout-minutes`, or give the
  suite its own step budget. Until then a green e2e is partly luck.
- `make test-e2e-ci` is **not safe against a stale listener on 5175**. If
  anything already holds that port, `serve` silently falls back to a random
  one and `wait-on http-get://localhost:5175` can never succeed, so the job
  burns its entire budget with Playwright never starting. Harmless on a
  fresh CI runner; it cost a confusing local reproduction here (a `serve`
  left over from 2026-09-28). Worth making the target fail loudly instead.
- The broader `authenticated` TRUNCATE grant: 52 public tables grant it,
  Supabase's default `grant all` pattern. Not reachable through PostgREST,
  wider than intended.
- **`IndividualProgramPage.capacity.test.tsx` — CI flake, mechanism still
  UNKNOWN. Investigated 2026-10-02; do not re-tread these.** It failed the CI
  Test job once, on `33714d30` (three of its ten tests, each burning its full
  45s timeout: `12 / 12 active` absent, `Full — 12 of 12 slots filled.`
  absent, and a 44.8s click timeout waiting for the `November 2026` openings
  button). It is the only CI Test failure this file has had in the runs
  inspectable without admin log access, and it passes 10/10 in isolation.

  **Eliminated, each by a forced reproduction rather than by repetition:**

  1. *Persisted query-cache pollution.* `CRM.tsx` wraps the app in
     `PersistQueryClientProvider` with a `localStorage` persister
     (`REACT_QUERY_OFFLINE_CACHE`, 1s throttle), nothing clears it, there are
     no `setupFiles`, and **42 app test files render `<CRM>`** — so one
     file's cache really is restored into the next. Measured: it is written.
     But mounting the same route twice in one file with *different* fixtures,
     with the first mount's cache persisted and restored, still rendered the
     second fixture's answer correctly. `staleTime` is 0, so restored data is
     stale on arrival and refetched. **Not the cause.**
  2. *Viewport leak into the mobile layout.* `page.viewport()` is a page
     setting, Vitest reuses pages across files, `CRM.tsx` picks
     `MobileAdmin` purely from `useIsMobile()` (breakpoint 768), six call
     sites across four files set a mobile width without restoring it, eight
     `<CRM>`-rendering files never state one — and CI's DOM dump *did* show
     the mobile `<nav>`. Measured: the leak does persist across tests, and
     the layout does switch. But the real capacity file run at a forced
     600px passes **10/10**. A width matrix (375/600/700/1280) showed
     `12 / 12 active` present at every width. **Not the cause** — and note
     the first read of that matrix was misread as implicating the viewport,
     when the absent strings were absent at 1280 too, for fixture reasons.

  **Also not reproducible by load on an 8-core machine:** the exact CI command
  (`CI=1 npm run test:unit:app -- --run`, all four projects) and the app
  project at 2, 8 and 16 workers are all green — 1824 passed every time.

  **Still open and worth trying next:** the failing job's own log, which needs
  admin rights this session does not have. It would name the other files in
  that worker and carry the full DOM and console output. A cascade is also
  plausible but unproven: the file's `afterEach` restores the clock and then
  awaits a CDP timezone call, so if one test fails mid-flight the rest of the
  file may inherit a half-restored state — which would explain three failures
  clustered in one file without explaining the first.

  **What was deliberately NOT done:** no timeout raised (it is already 45s and
  CI burned 44.8s of it), no sleep, no assertion weakened, no test skipped or
  marked flaky, and no speculative repair committed for a mechanism that is
  not yet understood.
- A pre-existing alternating pass/fail flake in **partial** test selections
  (`enrollments/` plus the capacity file). Measured on both the changed and
  unchanged tree and identical on each, so it predates the sort change. The
  full app project and the four-project CI command are green. The
  alternating pattern hints at state carried between consecutive runs.

---

## 9. Gmail (after Capacity + Waitlist)

**READ §8b-kit-gmail FIRST.** Gmail cannot become authoritative for
application-decision emails until Kit's existing decision automations are made
safe and the deliberate one-time Kit backfill has happened, **in that order**.
That sequencing is a hard prerequisite, not a nicety, and improvising it emails
real people about decisions they already heard about.


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

**Technical guidance for Leif must be operationally explicit.** When a step
genuinely has to be his — a credential Claude must not handle, a decision only
he can make, a click only he can perform — the instruction is not finished
until it says where to click, what to look for, and what to send back.

Never say, on their own:

- "run this in Supabase"
- "check Vercel"
- "use Terminal"
- "run the SQL"
- "open the logs"

Each of those assumes a workflow. Say instead, in order: the exact place to
go, the exact control to click (by its label and where on screen it sits),
what he should expect to see when it worked, and exactly what to copy back.
Number the steps. One action per step.

Assume **no** familiarity with developer tooling unless Leif has already done
that exact workflow in front of you. Having run one SQL query is not evidence
he knows where the SQL editor is the next time, and a tool he used a month ago
is not a tool he remembers.

The cost of getting this wrong is not confusion, it is a stall: the work stops
and he cannot say why. The cost of over-explaining is a few extra lines he can
skip.

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
