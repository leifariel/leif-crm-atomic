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

-- Deciding provenance is the CRM''s own server-side work. A browser never
-- asks this question, and a new view holds no privileges until one is
-- granted, so anon and authenticated are simply never given any.
revoke all on public.client_session_enrollment_candidates from public;
revoke all on public.client_session_enrollment_candidates from anon;
revoke all on public.client_session_enrollment_candidates from authenticated;
grant select on public.client_session_enrollment_candidates to service_role;

-- THE HISTORICAL REPAIR, through that same authority and nothing else.
--
-- Deterministic by construction: it derives every link from rows already
-- present, so replaying it into an empty database links nothing and
-- asserts nothing. It is therefore NOT a production-data repair and does
-- not belong in replay-manifest.json.
--
-- `enrollment_id is null` in the WHERE clause is the guard that matters:
-- this can only ever fill a blank, never overwrite provenance that already
-- exists.
update public.client_sessions cs
   set enrollment_id = c.proposed_enrollment_id,
       updated_at = now()
  from public.client_session_enrollment_candidates c
 where c.session_id = cs.id
   and cs.enrollment_id is null
   and c.classification = 'deterministic'
   and c.proposed_enrollment_id is not null;
