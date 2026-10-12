-- "ON WAITLIST" MEANS STILL WAITING TO BE INVITED.
--
-- §4b Phase 1, the Contact half. The programme pages were repaired first:
-- their active waitlist now means status = waiting, because somebody who has
-- been invited is no longer waiting for Leif to invite them. The Contacts
-- "Waitlist" relationship filter still read waiting+invited, so it returned
-- 115 people where 61 were genuinely waiting -- the 54 invited on 11 Oct
-- among them.
--
-- "On waitlist" is CURRENT operational state. Invited is not on the
-- waitlist. Converted is not. Removed is not. Historical participation stays
-- fully visible through the Contact waitlist history, which reads the rows
-- themselves and is untouched by this; if a HISTORICAL filter is wanted
-- later it needs its own name, such as "has waitlist history", rather than
-- overloading this one.
--
-- This changes a DERIVED READ only. No waitlist row is written, deleted or
-- reclassified: every entry keeps its status, its joined_at, its invited_at
-- and its batch. The place-held set {waiting, invited} that mirrors the
-- partial unique index is deliberately NOT touched -- an invited person
-- still holds their place and still blocks a duplicate.
--
-- Deterministic and replay-safe: it replaces a view definition and asserts
-- nothing about any row, so it rebuilds identically into an empty database.
--
-- The body below is supabase/schemas/03_views.sql verbatim, which is the
-- source of truth; only the is_on_waitlist expression differs from what
-- production held before this migration.

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
