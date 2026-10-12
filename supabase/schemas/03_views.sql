--
-- Views
-- This file declares all views in the public schema.
--

create or replace view public.activity_log with (security_invoker = on) as
select
    ('company.' || c.id || '.created') as id,
    'company.created' as type,
    c.created_at as date,
    c.id as company_id,
    c.sales_id,
    to_json(c.*) as company,
    null::json as contact,
    null::json as deal,
    null::json as contact_note,
    null::json as deal_note
from public.companies c
union all
select
    ('contact.' || co.id || '.created') as id,
    'contact.created' as type,
    co.first_seen as date,
    co.company_id,
    co.sales_id,
    null::json as company,
    to_json(co.*) as contact,
    null::json as deal,
    null::json as contact_note,
    null::json as deal_note
from public.contacts co
union all
select
    ('contactNote.' || cn.id || '.created') as id,
    'contactNote.created' as type,
    cn.date,
    co.company_id,
    cn.sales_id,
    null::json as company,
    null::json as contact,
    null::json as deal,
    to_json(cn.*) as contact_note,
    null::json as deal_note
from public.contact_notes cn
    left join public.contacts co on co.id = cn.contact_id
union all
select
    ('deal.' || d.id || '.created') as id,
    'deal.created' as type,
    d.created_at as date,
    d.company_id,
    d.sales_id,
    null::json as company,
    null::json as contact,
    to_json(d.*) as deal,
    null::json as contact_note,
    null::json as deal_note
from public.deals d
union all
select
    ('dealNote.' || dn.id || '.created') as id,
    'dealNote.created' as type,
    dn.date,
    d.company_id,
    dn.sales_id,
    null::json as company,
    null::json as contact,
    null::json as deal,
    null::json as contact_note,
    to_json(dn.*) as deal_note
from public.deal_notes dn
    left join public.deals d on d.id = dn.deal_id;

create or replace view public.companies_summary with (security_invoker = on) as
select
    c.id,
    c.created_at,
    c.name,
    c.sector,
    c.size,
    c.linkedin_url,
    c.website,
    c.phone_number,
    c.address,
    c.zipcode,
    c.city,
    c.state_abbr,
    c.sales_id,
    c.context_links,
    c.country,
    c.description,
    c.revenue,
    c.tax_identifier,
    c.logo,
    count(distinct d.id) as nb_deals,
    count(distinct co.id) as nb_contacts
from public.companies c
    left join public.deals d on c.id = d.company_id
    left join public.contacts co on c.id = co.company_id
group by c.id;

create or replace view public.contacts_summary with (security_invoker = on) as
select
    co.id,
    co.first_name,
    co.last_name,
    co.gender,
    co.title,
    co.background,
    co.avatar,
    co.first_seen,
    co.last_seen,
    co.has_newsletter,
    co.status,
    co.tags,
    co.company_id,
    co.sales_id,
    co.linkedin_url,
    co.email_jsonb,
    co.phone_jsonb,
    (jsonb_path_query_array(co.email_jsonb, '$[*]."email"'))::text as email_fts,
    (jsonb_path_query_array(co.phone_jsonb, '$[*]."number"'))::text as phone_fts,
    c.name as company_name,
    count(distinct t.id) filter (where t.done_date is null) as nb_tasks,
    -- Trailing position matches the migration chain exactly (Postgres's
    -- CREATE OR REPLACE VIEW forbids reordering an existing column — see
    -- 20260831110000_application_review_outcomes.sql's own comment on this
    -- same column) — kept here too so a fresh `db reset` produces the
    -- identical column order and `db diff` never sees a phantom difference.
    co.sales_eligibility,
    -- CRM-domain relationship filters (Contacts UX cleanup pass): derived
    -- from real Deal/Application/Enrollment/Waitlist rows, the same
    -- "computed column on this view" pattern nb_tasks above already
    -- established — never a new persisted concept, never mutated data.
    -- Distinct Offer ids across every one of this Contact's Opportunities,
    -- for an "Offer History" filter via the same array-containment
    -- operator (@cs) the existing `tags` filter already uses.
    coalesce(array_agg(distinct d.offer_id) filter (where d.offer_id is not null), '{}') as offer_ids,
    -- Has an Enrollment currently in progress (enrollments_status_check:
    -- 'onboarding'/'active' vs 'offboarding'/'completed').
    bool_or(e.status in ('onboarding', 'active')) as is_current_client,
    -- Has an Enrollment that has since ended — independent of
    -- is_current_client, so someone enrolled again after a past
    -- completed program still correctly shows as both.
    bool_or(e.status in ('offboarding', 'completed')) as is_past_client,
    -- Has ever submitted an Application (any review status) via any of
    -- their Opportunities.
    bool_or(app.id is not null) as has_applied,
    -- STILL WAITING to be invited — the Contacts "Waitlist" filter, and a
    -- question about now. Invited, converted and removed are all people who
    -- have left the waitlist, whatever happened next; their entries keep
    -- every bit of their history, they are simply not waiting any more.
    -- This read waiting+invited until 2026-10-11 and so returned 115
    -- Contacts where 61 were genuinely waiting. A HISTORICAL filter is a
    -- different question and would need a different name ("has waitlist
    -- history") rather than overloading this one. See HANDOFF §4b.
    bool_or(w.status = 'waiting') as is_on_waitlist,
    -- Has a non-archived Opportunity currently exited into nurture.
    bool_or(d.outcome = 'nurture' and d.archived_at is null) as has_nurture_deal,
    -- The legacy free-text identifiers note, so search can reach it.
    co.identifiers,
    -- So a merged-away Contact can be kept out of lists without a second
    -- query. The row survives a merge; it just stops being a person you
    -- work with.
    co.merged_into_contact_id,
    -- The display handles/addresses providers know this person by — for
    -- SEARCH ONLY. Identity lives on the immutable provider id in
    -- contact_external_identities; a handle is a label that can change.
    (select string_agg(distinct i.display_identifier, ' ')
       from public.contact_external_identities i
      where i.contact_id = co.id and i.display_identifier is not null) as external_identifiers_fts
from public.contacts co
    left join public.tasks t on co.id = t.contact_id
    left join public.companies c on co.company_id = c.id
    left join public.deals d on d.contact_id = co.id
    left join public.enrollments e on e.opportunity_id = d.id
    left join public.applications app on app.opportunity_id = d.id
    left join public.waitlist_entries w on w.contact_id = co.id
group by co.id, c.name;

-- The addresses a Contact is reachable at, as rows rather than jsonb, so
-- "who owns this address" is one query. The placeholder addresses the
-- historical import minted for emailless applicants are page ids, not
-- addresses, and are excluded.
create or replace view public.contact_email_addresses as
select c.id as contact_id,
       public.normalize_email(e->>'email') as normalized_email,
       e->>'email' as email,
       e->>'type' as email_type
  from public.contacts c,
       lateral jsonb_array_elements(coalesce(c.email_jsonb, '[]'::jsonb)) e
 where public.normalize_email(e->>'email') is not null
   and (e->>'email') not like 'le-standalone:%';

create or replace view public.init_state with (security_invoker = off) as
select count(sub.id) as is_initialized
from (
    select sales.id from public.sales limit 1
) sub;

-- Tracked Enrollments carrying no required onboarding items. Empty is the
-- healthy state. A row here means seeding did not run, or the Offer has no
-- active onboarding templates — either way the checklist is missing rather
-- than finished, and activation will refuse.
CREATE OR REPLACE VIEW public.enrollments_missing_onboarding AS
 SELECT e.id AS enrollment_id,
    e.opportunity_id,
    e.status,
    e.onboarding_tracking,
    d.offer_id,
    ( SELECT count(*) AS count
           FROM onboarding_requirement_templates t
          WHERE t.offer_id = d.offer_id AND t.is_active) AS active_templates
   FROM enrollments e
     JOIN deals d ON d.id = e.opportunity_id
  WHERE e.onboarding_tracking = 'tracked'::text AND NOT (EXISTS ( SELECT 1
           FROM enrollment_onboarding_items i
          WHERE i.enrollment_id = e.id AND i.is_required AND i.status <> 'retired'::text));

-- Applications that are current review work: pending, on a live sales
-- attempt still at Application Received. Never merely status = pending.
CREATE OR REPLACE VIEW public.applications_awaiting_review AS
 SELECT a.id AS application_id,
    a.contact_id,
    a.opportunity_id,
    a.offer_id,
    a.submitted_at,
    (a.submitted_at AT TIME ZONE 'America/Denver'::text)::date AS submitted_on,
    (now() AT TIME ZONE 'America/Denver'::text)::date - (a.submitted_at AT TIME ZONE 'America/Denver'::text)::date AS days_elapsed,
    (a.submitted_at AT TIME ZONE 'America/Denver'::text)::date + 3 AS review_due_on,
    ((now() AT TIME ZONE 'America/Denver'::text)::date - (a.submitted_at AT TIME ZONE 'America/Denver'::text)::date) > 3 AS is_overdue
   FROM applications a
     JOIN deals d ON d.id = a.opportunity_id
  WHERE a.status = 'pending'::text AND deal_is_active(d.archived_at, d.stage, d.outcome) AND d.stage = 'application_received'::text;;

-- A MISSING LINK IS NOT AN ABSENT SESSION.
--
-- `client_sessions.enrollment_id` is provenance, and it is nullable: the
-- Acuity webhook resolved it once, when the appointment arrived, and wrote
-- null whenever the Enrollment was not findable yet. Nothing revisited it.
-- 62 of 255 production sessions carried null, and three real clients were
-- each told they had skipped a week they had attended, because the cadence
-- detector asked for sessions by enrollment_id alone.
--
-- Two things close that. The cadence rule itself now accepts an unlinked
-- session as evidence when it can say truthfully which week it belongs to
-- (see _shared/cadenceFulfillment.ts). And the provenance converges, here.
--
-- THIS VIEW IS THE ONE LINK AUTHORITY. The runtime reconciler, the Acuity
-- webhook and Leif's own preflight all read it, so what the backfill does
-- and what an audit predicts can never disagree.
--
-- IT NEVER GUESSES. Deterministic means exactly one Enrollment can
-- truthfully own the session; zero or several leave the column null with
-- the reason recorded, for Leif. In particular it does NOT reason from
-- "this contact has one active Enrollment today" — the matcher that did is
-- what produced these nulls, since a historical session may predate the
-- current Enrollment or belong to a previous one.
create or replace view public.client_session_enrollment_candidates
with (security_invoker = on) as
with unlinked as (
  select cs.id as session_id,
         cs.contact_id,
         cs.offer_id,
         cs.scheduled_at,
         cs.source,
         -- The CRM's own calendar day. Comparing a date column against a
         -- UTC instant is the sibling bug this slice also fixed.
         (cs.scheduled_at at time zone 'America/Denver')::date as denver_day
    from public.client_sessions cs
   where cs.enrollment_id is null
),
-- Same person, same programme. Never one without the other: a Growing
-- Yourself Up booking can never own a Living Example session.
candidate_enrollments as (
  select u.session_id,
         e.id as enrollment_id,
         e.start_date,
         e.end_date
    from unlinked u
    join public.deals d
      on d.contact_id = u.contact_id
     and d.offer_id = u.offer_id
    join public.enrollments e
      on e.opportunity_id = d.id
),
-- TIER 1, the strongest fact available: the day the session happened on is
-- one of the days that Enrollment was expecting a session on.
by_week as (
  select c.session_id, c.enrollment_id
    from candidate_enrollments c
    join unlinked u
      on u.session_id = c.session_id
    join public.enrollment_expected_sessions s
      on s.enrollment_id = c.enrollment_id
     and s.retired_at is null
     and u.denver_day >= s.window_start
     and u.denver_day <  s.window_end
   group by c.session_id, c.enrollment_id
),
-- TIER 2, consulted only when no expected week contains the day (a make-up
-- hour, or a session from before the schedule was built): the Enrollment
-- was running on that day. Status is deliberately NOT required to be
-- 'active' — a session that happened while an Enrollment was running
-- belongs to it even if that Enrollment has since ended.
by_span as (
  select c.session_id, c.enrollment_id
    from candidate_enrollments c
    join unlinked u
      on u.session_id = c.session_id
   where c.start_date is not null
     and u.denver_day >= c.start_date
     and (c.end_date is null or u.denver_day <= c.end_date)
   group by c.session_id, c.enrollment_id
),
tiered as (
  select u.session_id,
         case
           when exists (select 1 from by_week w where w.session_id = u.session_id)
             then 'expected-week'
           else 'enrollment-span'
         end as tier
    from unlinked u
),
picked as (
  select t.session_id,
         t.tier,
         case when t.tier = 'expected-week'
              then (select count(*) from by_week w where w.session_id = t.session_id)
              else (select count(*) from by_span p where p.session_id = t.session_id)
         end as candidate_count,
         case when t.tier = 'expected-week'
              then (select min(w.enrollment_id) from by_week w where w.session_id = t.session_id)
              else (select min(p.enrollment_id) from by_span p where p.session_id = t.session_id)
         end as first_candidate,
         case when t.tier = 'expected-week'
              then (select string_agg(w.enrollment_id::text, ',' order by w.enrollment_id)
                      from by_week w where w.session_id = t.session_id)
              else (select string_agg(p.enrollment_id::text, ',' order by p.enrollment_id)
                      from by_span p where p.session_id = t.session_id)
         end as candidate_enrollment_ids
    from tiered t
)
select u.session_id,
       u.contact_id,
       u.offer_id,
       u.scheduled_at,
       u.denver_day,
       u.source,
       p.tier,
       coalesce(p.candidate_count, 0) as candidate_count,
       coalesce(p.candidate_enrollment_ids, '') as candidate_enrollment_ids,
       case when coalesce(p.candidate_count, 0) = 1 then p.first_candidate end
         as proposed_enrollment_id,
       case
         when coalesce(p.candidate_count, 0) = 1 then 'deterministic'
         when coalesce(p.candidate_count, 0) = 0 then 'no-candidate'
         else 'ambiguous'
       end as classification,
       case
         when coalesce(p.candidate_count, 0) = 1 and p.tier = 'expected-week'
           then 'the session''s Denver day falls inside exactly one Enrollment''s expected week'
         when coalesce(p.candidate_count, 0) = 1
           then 'no expected week contains that day, and exactly one Enrollment of this programme was running on it'
         when coalesce(p.candidate_count, 0) = 0
           then 'no Enrollment of this contact and programme can own that day'
         else 'more than one Enrollment could own it — Leif decides'
       end as reason
  from unlinked u
  join picked p on p.session_id = u.session_id;

comment on view public.client_session_enrollment_candidates is
  'The one authority on which Enrollment an unlinked client_session belongs to. Deterministic means exactly one Enrollment can truthfully own it; zero or several stay null with the reason recorded. Read by the runtime reconciler, the Acuity webhook and the production preflight.';
