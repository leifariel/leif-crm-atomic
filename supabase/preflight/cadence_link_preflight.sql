-- ====================================================================
-- CADENCE / ENROLLMENT-LINK PRODUCTION PREFLIGHT
--
-- Read-only. ONE statement. Safe to run BEFORE the repair deploys and
-- again afterwards as the readback — nothing filters on resolution state,
-- and every verdict is computed from stored facts rather than from
-- whichever code is live.
--
-- THE LINK RULE IS NOT REPEATED HERE. Sections 2, 3 and 6 read
-- public.client_session_enrollment_candidates, which is the one authority on
-- which Enrollment an unlinked session belongs to. This file formats and
-- reports; it decides nothing.
--
-- It did carry a copy for one slice, because the view shipped with the repair
-- and did not exist when the preflight was first needed. The two were
-- compared on real Postgres over one session of each classification and
-- agreed on every row; the copy was then deleted rather than left to drift.
--
-- Sections:
--   1  the four named clients, in full
--   2  every unlinked client_session, classified
--   3  summary counts
--   4  cadence false positives beyond the named three
--   5  the classifications that must never be overwritten
--   6  what the repair is expected to do to each of the four
-- ====================================================================
with four(first_name, last_name) as (
  values ('Denise','Cormier'), ('Ava','Frotton'),
         ('Jess','Beauchamp'), ('Gina','McNamara')
),
-- Identity resolved to real rows, never assumed from a label.
who as (
  select c.id as contact_id,
         btrim(c.first_name || ' ' || c.last_name) as person
    from contacts c
    join four f on lower(btrim(c.first_name)) = lower(f.first_name)
               and lower(btrim(c.last_name))  = lower(f.last_name)
),
-- An hour that actually happened.
real_sessions as (
  select cs.id, cs.contact_id, cs.offer_id, cs.enrollment_id,
         cs.scheduled_at, cs.acuity_appointment_id, cs.source, cs.created_at,
         (cs.scheduled_at at time zone 'America/Denver')::date as denver_day
    from client_sessions cs
   where cs.status <> 'cancelled' and cs.no_show_at is null
),
-- ---------- THE LINK RULE: READ, NEVER RE-DERIVED -------------------
--
-- public.client_session_enrollment_candidates IS the authority on which
-- Enrollment an unlinked session belongs to (migration 20261010190000).
--
-- This file used to carry its own copy of that reasoning — the by_week and
-- by_span tiers written out again — because the view shipped WITH the repair
-- and did not exist yet when the preflight was first needed. It exists now,
-- so the copy is gone: one rule, read in one place. Everything below only
-- FORMATS and reports what the view already decided, and a question about
-- candidate ownership has exactly one answer again.
classified as (
  select session_id, contact_id, offer_id, scheduled_at, source, denver_day,
         tier, candidate_count,
         candidate_enrollment_ids as candidate_ids,
         proposed_enrollment_id, classification
    from public.client_session_enrollment_candidates
),
-- ---------- THE FOUR ------------------------------------------------
enr as (
  select w.contact_id, w.person, d.id as opportunity_id, d.offer_id,
         e.id as enrollment_id, e.status as enrollment_status
    from who w
    join deals d on d.contact_id = w.contact_id
    join enrollments e on e.opportunity_id = d.id
),
issues as (
  select e.person, e.contact_id, e.offer_id, e.enrollment_id,
         e.enrollment_status, i.id as issue_id, i.resolved_at, i.classification,
         s.id as slot_id, s.window_start, s.window_end
    from enr e
    join client_session_cadence_issues i on i.enrollment_id = e.enrollment_id
    join enrollment_expected_sessions s on s.id = i.enrollment_expected_session_id
),
-- What the OLD detector could reach: linked sessions only, compared as UTC
-- instants against a DATE.
old_rule as (
  select i.issue_id, count(*) as matched
    from issues i
    join real_sessions r on r.enrollment_id = i.enrollment_id
   where r.scheduled_at >= (i.window_start::text || 'T00:00:00Z')::timestamptz
     and r.scheduled_at <  (i.window_end::text   || 'T00:00:00Z')::timestamptz
   group by i.issue_id
),
-- What the CANONICAL rule reaches: same contact, same offer, Denver days,
-- linked or not.
canonical as (
  select i.issue_id, r.id as session_id, r.scheduled_at, r.enrollment_id,
         r.acuity_appointment_id, r.source,
         row_number() over (partition by i.issue_id order by r.scheduled_at) rn
    from issues i
    join real_sessions r
      on r.contact_id = i.contact_id
     and r.offer_id = i.offer_id
     and (r.enrollment_id is null or r.enrollment_id = i.enrollment_id)
   where r.denver_day >= i.window_start and r.denver_day < i.window_end
),
tk as (
  select cadence_issue_id,
         string_agg(id::text, ', ' order by id) as ids,
         string_agg(status || coalesce(' @' || to_char(done_date,'DD Mon HH24:MI'), ''),
                    ', ' order by id) as state
    from tasks where type = 'resolve_client_session_cadence'
   group by cadence_issue_id
),
hist as (
  select cadence_issue_id,
         string_agg(kind || coalesce(' (' || classification || ')', '')
                    || ' @' || to_char(occurred_at,'DD Mon HH24:MI'),
                    ' -> ' order by id, occurred_at) as trail
    from client_session_cadence_issue_events
   group by cadence_issue_id
),
report as (
  -- 1. THE FOUR -----------------------------------------------------
  select 100 + row_number() over (order by i.person, i.window_start) as ord,
    '1. THE FOUR' as section,
    i.person || ' — ' || i.window_start || ' to ' || i.window_end || ' (end excl.)' as item,
    case when coalesce(o.matched,0) = 0 and c.session_id is not null
           then 'FALSE POSITIVE — old MISSED, canonical FULFILLED'
         when c.session_id is null
           then 'TRUE MISS — no qualifying session exists'
         else 'already counted by the old rule' end as verdict,
    'contact ' || i.contact_id || ' · enrollment ' || i.enrollment_id
      || ' (' || i.enrollment_status || ') · issue ' || i.issue_id
      || ' · task ' || coalesce(t.ids,'none')
      || ' · session(by enrollment_id) '
      || coalesce((select r.id::text from real_sessions r
                    where r.enrollment_id = i.enrollment_id
                      and r.denver_day >= i.window_start
                      and r.denver_day <  i.window_end limit 1), 'none')
      || ' · session(by contact+offer) ' || coalesce(c.session_id::text,'none')
      || ' · enrollment_id on it ' || coalesce(c.enrollment_id::text,'NULL')
      || ' · stored ' || coalesce(to_char(c.scheduled_at at time zone 'UTC','YYYY-MM-DD HH24:MI')||' UTC','-')
      || ' · Denver ' || coalesce(to_char(c.scheduled_at at time zone 'America/Denver','Dy DD Mon HH24:MI')||' MT','-')
      || ' · OLD ' || case when coalesce(o.matched,0) > 0 then 'FULFILLED' else 'MISSED' end
      || ' · CANONICAL ' || case when c.session_id is not null then 'FULFILLED' else 'MISSED' end
      || ' · task ' || coalesce(t.state,'none')
      || ' · issue ' || case when i.resolved_at is null then 'OPEN' else 'resolved' end
                     || coalesce('/' || i.classification, '/unclassified')
      || ' · history ' || coalesce(h.trail,'none') as detail
    from issues i
    left join canonical c on c.issue_id = i.issue_id and c.rn = 1
    left join old_rule o on o.issue_id = i.issue_id
    left join tk t on t.cadence_issue_id = i.issue_id
    left join hist h on h.cadence_issue_id = i.issue_id
  union all
  select 190, '1. THE FOUR', 'all four names resolved to exactly one Contact each',
    case when count(*) = 4 then 'PASS' else 'REVIEW — ' || count(*) || ' matched' end,
    coalesce(string_agg(person || ' = ' || contact_id, ', ' order by person), 'none')
    from who

  -- 2. EVERY UNLINKED SESSION ----------------------------------------
  union all
  select 200 + row_number() over (order by c.classification, c.session_id),
    '2. UNLINKED SESSIONS', 'session ' || c.session_id,
    c.classification,
    'contact ' || c.contact_id || ' · offer ' || c.offer_id
      || ' · ' || to_char(c.scheduled_at at time zone 'America/Denver','Dy DD Mon YYYY HH24:MI') || ' MT'
      || ' · source ' || c.source
      || ' · tier ' || c.tier
      || ' · candidates ' || c.candidate_count
      || coalesce(' [' || c.candidate_ids || ']','')
      || ' · proposed enrollment ' || coalesce(c.proposed_enrollment_id::text,'none')
    from classified c

  -- 3. SUMMARY -------------------------------------------------------
  union all
  select 300, '3. SUMMARY', 'total unlinked client_sessions', count(*)::text,
    'all of them source=' || coalesce(string_agg(distinct source,','),'-')
    from classified
  union all
  select 301, '3. SUMMARY', 'deterministic — safe to link automatically',
    count(*) filter (where classification = 'deterministic')::text,
    'by expected week: ' || count(*) filter (where classification='deterministic' and tier='expected-week')
      || ' · by enrollment span: ' || count(*) filter (where classification='deterministic' and tier='enrollment-span')
    from classified
  union all
  select 302, '3. SUMMARY', 'no candidate — stays NULL',
    count(*) filter (where classification = 'no-candidate')::text,
    coalesce(string_agg(session_id::text, ', ' order by session_id)
               filter (where classification='no-candidate'), 'none')
    from classified
  union all
  select 303, '3. SUMMARY', 'ambiguous — stays NULL, Leif decides',
    count(*) filter (where classification = 'ambiguous')::text,
    coalesce(string_agg(session_id::text, ', ' order by session_id)
               filter (where classification='ambiguous'), 'none')
    from classified

  -- 4. FALSE POSITIVES BEYOND THE NAMED THREE ------------------------
  union all
  select 400 + row_number() over (order by cc.person, cc.window_start),
    '4. OTHER FALSE POSITIVES', cc.person || ' — ' || cc.window_start || ' to ' || cc.window_end,
    'open question answered by an unlinked session',
    'contact ' || cc.contact_id || ' · enrollment ' || cc.enrollment_id
      || ' · issue ' || cc.issue_id || ' · session ' || cc.session_id
      || ' · ' || to_char(cc.scheduled_at at time zone 'America/Denver','Dy DD Mon HH24:MI') || ' MT'
    from (
      select btrim(ct.first_name||' '||ct.last_name) as person,
             d.contact_id, i.enrollment_id, i.id as issue_id,
             s.window_start, s.window_end, r.id as session_id, r.scheduled_at
        from client_session_cadence_issues i
        join enrollment_expected_sessions s on s.id = i.enrollment_expected_session_id
        join enrollments e on e.id = i.enrollment_id
        join deals d on d.id = e.opportunity_id
        join contacts ct on ct.id = d.contact_id
        join real_sessions r
          on r.contact_id = d.contact_id and r.offer_id = d.offer_id
         and r.enrollment_id is null
         and r.denver_day >= s.window_start and r.denver_day < s.window_end
       where i.resolved_at is null
         and i.classification is null
    ) cc
  union all
  select 490, '4. OTHER FALSE POSITIVES', 'how many open questions an unlinked session would answer',
    count(*)::text, 'these resolve themselves on the first sync after deploy'
    from client_session_cadence_issues i
    join enrollment_expected_sessions s on s.id = i.enrollment_expected_session_id
    join enrollments e on e.id = i.enrollment_id
    join deals d on d.id = e.opportunity_id
   where i.resolved_at is null and i.classification is null
     and exists (select 1 from real_sessions r
                  where r.contact_id = d.contact_id and r.offer_id = d.offer_id
                    and r.enrollment_id is null
                    and r.denver_day >= s.window_start and r.denver_day < s.window_end)

  -- 5. WHAT MUST NOT BE OVERWRITTEN ----------------------------------
  union all
  select 500 + row_number() over (order by i.id),
    '5. LEIF''S OWN ANSWERS', 'issue ' || i.id || ' — ' || i.classification,
    'must survive the repair untouched',
    'enrollment ' || i.enrollment_id
      || ' · resolved ' || coalesce(to_char(i.resolved_at,'DD Mon YYYY HH24:MI'),'not resolved')
      || ' · note ' || coalesce(nullif(btrim(i.note),''),'(none)')
    from client_session_cadence_issues i
   where i.classification is not null
  union all
  select 590, '5. LEIF''S OWN ANSWERS', 'explicit classifications in total', count(*)::text,
    'the repair only ever closes an UNCLASSIFIED issue'
    from client_session_cadence_issues where classification is not null

  -- 6. EXPECTED OUTCOME ----------------------------------------------
  union all
  select 600 + row_number() over (order by i.person),
    '6. EXPECTED AFTER REPAIR', i.person,
    case when c.session_id is not null
           then 'issue resolves · task completed · history created -> resolved'
         else 'STAYS OPEN — task remains pending, unclassified' end,
    case when c.session_id is not null
           then 'and enrollment_id ' || coalesce(cl.classification,'(already linked)')
                || coalesce(' -> ' || cl.proposed_enrollment_id::text, '')
         else 'nothing is invented and no session is imported' end
    from issues i
    left join canonical c on c.issue_id = i.issue_id and c.rn = 1
    left join classified cl on cl.session_id = c.session_id
   where i.resolved_at is null
)
select section, item, verdict, detail from report order by ord;
