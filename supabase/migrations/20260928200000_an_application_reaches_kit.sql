-- ===========================================================================
-- An application reaches Kit
-- ===========================================================================
--
-- Until now the CRM stopped at its own boundary. Leif reviewed an application
-- here, then went to Kit by hand: find or add the person, apply the right tag,
-- let his existing automations send the email. This is that hand-work, made
-- durable.
--
-- Three rules shape everything below.
--
-- 1. KIT NEVER HOLDS CRM TRUTH. The application, the decision, the Opportunity
--    and the review Task commit exactly as they do today. What this adds is a
--    row saying "Kit still owes us one tag", written INSIDE the same
--    transaction as the fact that caused it. Kit being down delays an email;
--    it can never make the CRM look undecided, and it can never fail an
--    applicant's submission.
--
-- 2. THE CRM APPLIES TAGS AND NOTHING ELSE. It upserts a subscriber and adds a
--    tag. It never adds anybody to a form, a sequence or an automation, and it
--    never recreates an email. Which tag triggers which email is Kit's
--    business, changed in Kit, with no code change here.
--
-- 3. NOTHING IS BACKFILLED. kit_integration_settings.not_before is stamped
--    with now() as this migration runs, and the enqueue refuses anything older.
--    The 161 historical_import rows and the five real public_form applicants
--    already in MAIN predate it by construction — proven below rather than
--    asserted — so deploying this integration emails nobody. Adopting one of
--    those five is a later, deliberate act.
--
-- Tagging is ADDITIVE. The applicant tag stays when a decision tag is added:
-- the live review action only ever reviews a pending application and refuses a
-- second review, so there is no supported decision-churn path to model, and
-- inventing a tag-removal step for one would be inventing the churn too.

-- ---------------------------------------------------------------------------
-- Settings: the boundary, and the only thing that makes this integration live
-- ---------------------------------------------------------------------------
create table if not exists public.kit_integration_settings (
    id integer not null default 1 primary key,
    -- Applications created at or after this instant are Kit-managed. Stamped
    -- once, at deployment, with the moment this migration ran — which is
    -- exactly "from when the integration existed", and is the one value that
    -- cannot accidentally include a row that already existed.
    not_before timestamp with time zone not null,
    created_at timestamp with time zone not null default now(),
    constraint kit_integration_settings_singleton check (id = 1)
);

insert into public.kit_integration_settings (id, not_before)
values (1, now())
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Tag mapping: Leif's real Kit tags, per programme, per event
-- ---------------------------------------------------------------------------
--
-- Configuration, seeded by migration, keyed on the literal offer ids the
-- chain itself creates (20260830130000 seeds offer 1 = The Living Example,
-- offer 2 = Growing Yourself Up) — the same shape and the same posture as
-- onboarding_requirement_templates' own seed (20260904220000): no admin UI,
-- and a new tag is a migration like this one.
--
-- A programme with no row here is simply not Kit-managed, and nothing is
-- guessed on its behalf. That is how the third offer, 1:1 Coaching (Legacy),
-- and any future programme stay out of Kit until Leif says otherwise.
--
-- 'do_not_engage' is deliberately ABSENT as an event. The CRM's Do Not Engage
-- truth stays entirely inside the CRM: no subscriber is created, no tag is
-- applied, nothing existing in Kit is removed, and no email is triggered.
create table if not exists public.kit_tag_mappings (
    offer_id bigint not null,
    event text not null,
    kit_tag_id bigint not null,
    -- Carried for the operator-facing audit trail, so a row can say
    -- "MiniDD_Approved" rather than a bare number. Never matched on.
    kit_tag_name text not null,
    created_at timestamp with time zone not null default now(),
    primary key (offer_id, event),
    constraint kit_tag_mappings_event_check
        check (event in ('applicant', 'approved', 'needs_higher_care', 'not_fit')),
    constraint kit_tag_mappings_name_check check (btrim(kit_tag_name) <> ''),
    constraint kit_tag_mappings_tag_id_check check (kit_tag_id > 0)
);

alter table public.kit_tag_mappings
    drop constraint if exists kit_tag_mappings_offer_id_fkey;
alter table public.kit_tag_mappings
    add constraint kit_tag_mappings_offer_id_fkey foreign key (offer_id) references public.offers(id) on update cascade on delete cascade;

insert into public.kit_tag_mappings (offer_id, event, kit_tag_id, kit_tag_name)
values
  -- The Living Example (offer_id = 1) — Kit calls it MiniDD.
  (1, 'applicant',          24082722, 'MiniDD_Applicant'),
  (1, 'approved',           21784073, 'MiniDD_Approved'),
  (1, 'needs_higher_care',  24082725, 'MiniDD_NeedsHigherCare'),
  (1, 'not_fit',            21784076, 'MiniDD_Denied'),
  -- Growing Yourself Up (offer_id = 2)
  (2, 'applicant',          24082724, 'GYU-Applicant'),
  (2, 'approved',           21481248, 'GYU-Approved'),
  (2, 'needs_higher_care',  24082732, 'GYU-NeedsHigherCare'),
  (2, 'not_fit',            21481382, 'GYU-Denied')
on conflict (offer_id, event) do nothing;

-- ---------------------------------------------------------------------------
-- The outbox: one row per logical Kit operation this application still owes
-- ---------------------------------------------------------------------------
--
-- Shaped after waitlist_invitations, which is this schema's existing answer to
-- "delivery that can fail, must stay visible, and must be retryable": per-item
-- status, real evidence required before a row may call itself done, and one
-- person's failure never marking anyone else finished.
--
-- Narrow on purpose. This is not a job queue and not an integration platform:
-- it holds the two operations an application can owe Kit, and a generic third
-- would need its own design rather than a new value here.
create table if not exists public.kit_sync_operations (
    id bigint generated always as identity primary key,
    application_id bigint not null,
    -- Denormalized so a person's Kit history is one filter away, exactly as
    -- waitlist_invitations denormalizes contact_id for the same reason.
    contact_id bigint not null,
    -- 'applicant'  the programme tag, owed from the moment they applied.
    -- 'decision'   the outcome tag, owed from the moment Leif decided.
    kind text not null,
    -- Normalized at enqueue time by the same rule the receipt path uses
    -- (public.normalize_email), so Kit is addressed by exactly the string the
    -- CRM considers canonical, and a later edit to the Contact cannot silently
    -- retarget an operation that was already owed.
    email text not null,
    -- Resolved at enqueue time and then FROZEN. If Leif retags a programme in
    -- Kit tomorrow, what this row already sent stays truthfully recorded.
    kit_tag_id bigint not null,
    kit_tag_name text not null,
    status text not null default 'pending',
    attempts integer not null default 0,
    last_attempt_at timestamp with time zone,
    succeeded_at timestamp with time zone,
    failed_at timestamp with time zone,
    -- A class, not a provider payload: 'auth', 'rejected', 'rate_limited',
    -- 'provider_unavailable', 'network', 'not_configured', 'unknown'. Enough
    -- to decide whether retrying helps, with nothing of Kit's response body
    -- and nothing of the key stored.
    failure_class text,
    failure_reason text,
    -- Evidence, not identity. The canonical person-to-Kit link is
    -- contact_external_identities (provider = 'kit'); this column is what THIS
    -- operation observed, the same way waitlist_invitations.sent_at is
    -- evidence of that send rather than a second delivery model.
    kit_subscriber_id text,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),
    constraint kit_sync_operations_kind_check
        check (kind in ('applicant', 'decision')),
    constraint kit_sync_operations_status_check
        check (status in ('pending', 'processing', 'succeeded', 'failed')),
    constraint kit_sync_operations_email_check
        check (email = lower(btrim(email)) and email <> ''),
    constraint kit_sync_operations_failure_class_check
        check (failure_class is null or failure_class in (
            'auth', 'rejected', 'rate_limited', 'provider_unavailable',
            'network', 'not_configured', 'unknown')),
    -- Nothing may call itself done without the subscriber Kit actually
    -- returned. This is the structural guarantee that a green sync state in
    -- the UI means a real Kit round-trip happened.
    constraint kit_sync_operations_success_evidence_check
        check (status <> 'succeeded'
               or (succeeded_at is not null and kit_subscriber_id is not null)),
    constraint kit_sync_operations_failure_evidence_check
        check (status <> 'failed'
               or (failed_at is not null and failure_class is not null))
);

alter table public.kit_sync_operations
    drop constraint if exists kit_sync_operations_application_id_fkey;
alter table public.kit_sync_operations
    add constraint kit_sync_operations_application_id_fkey foreign key (application_id) references public.applications(id) on update cascade on delete cascade;
alter table public.kit_sync_operations
    drop constraint if exists kit_sync_operations_contact_id_fkey;
alter table public.kit_sync_operations
    add constraint kit_sync_operations_contact_id_fkey foreign key (contact_id) references public.contacts(id) on update cascade on delete cascade;

-- THE idempotency anchor. One applicant operation and one decision operation
-- per application, forever. Every replay — a resubmitted form, a double-
-- clicked decision, a cron overlap, a retry — collides here and writes
-- nothing, so duplicate durable work is impossible rather than merely
-- unlikely.
create unique index if not exists kit_sync_operations_application_kind_idx
    on public.kit_sync_operations using btree (application_id, kind);

create index if not exists kit_sync_operations_contact_idx
    on public.kit_sync_operations using btree (contact_id);
-- The worker's claim query: the outstanding work, oldest first.
create index if not exists kit_sync_operations_outstanding_idx
    on public.kit_sync_operations using btree (status, created_at)
    where status in ('pending', 'processing');

-- ---------------------------------------------------------------------------
-- Kit is a place a person can be, so it is an external identity
-- ---------------------------------------------------------------------------
-- The deliberate one-line extension contact_external_identities' own comment
-- describes. A Kit subscriber id is the provider's immutable id, global to the
-- account, so it needs no provider_account_id scoping — the same shape as
-- Stripe's.
alter table public.contact_external_identities
    drop constraint if exists contact_external_identities_provider_check;
alter table public.contact_external_identities
    add constraint contact_external_identities_provider_check check (
      provider in ('instagram', 'gmail', 'email', 'stripe', 'acuity', 'notion', 'kit')
    );

-- ---------------------------------------------------------------------------
-- Enqueue: one body, called from receipt and from decision
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER because the two callers are different principals — the
-- public receipt path writes as service_role, an application decision writes as
-- Leif's own authenticated browser session — and NEITHER may hold write
-- privilege on kit_sync_operations directly. If the browser could insert here
-- it could name any Kit tag id it liked; it can't, and this is why. The tag is
-- resolved from the mapping table inside this function or there is no row.
--
-- Returns the operation id, or null when the application is not Kit-managed.
-- Not-managed is a silent, deliberate answer, not a failure: an unmapped
-- programme, an imported row, a row that predates the integration and an
-- application with no usable email address all mean "Kit was never going to
-- hear about this", and inventing a failed row for them would fill the
-- operator's attention with work nobody ever intended.
create or replace function public.enqueue_kit_application_sync(
  p_application_id bigint,
  p_kind text,
  p_event text
) returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_app applications%rowtype;
  v_email text;
  v_tag kit_tag_mappings%rowtype;
  v_not_before timestamp with time zone;
  v_id bigint;
begin
  select * into v_app from applications where id = p_application_id;
  if not found then
    return null;
  end if;

  -- Origin. An imported record is what already happened, not work; it must
  -- never subscribe or tag anybody merely because this integration exists.
  if v_app.source not in ('public_form', 'manual') then
    return null;
  end if;

  -- The deployment boundary. Absent settings fail closed.
  select not_before into v_not_before from kit_integration_settings where id = 1;
  if v_not_before is null or v_app.created_at < v_not_before then
    return null;
  end if;

  if v_app.offer_id is null then
    return null;
  end if;

  select * into v_tag from kit_tag_mappings
   where offer_id = v_app.offer_id and event = p_event;
  if not found then
    -- No mapping is a refusal, never a guess.
    return null;
  end if;

  select a.normalized_email into v_email
    from contact_email_addresses a
   where a.contact_id = v_app.contact_id
   order by a.normalized_email
   limit 1;
  if v_email is null then
    return null;
  end if;

  insert into kit_sync_operations
    (application_id, contact_id, kind, email, kit_tag_id, kit_tag_name)
  values
    (v_app.id, v_app.contact_id, p_kind, v_email, v_tag.kit_tag_id, v_tag.kit_tag_name)
  on conflict (application_id, kind) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Receipt
-- ---------------------------------------------------------------------------
-- Fires inside submit_public_application()'s and create_manual_application()'s
-- own transactions — the only honest boundary either path has — so the durable
-- Kit intent and the application that owes it commit together or not at all.
--
-- status <> 'pending' is the Do Not Engage gate. A submission from somebody
-- already marked do_not_engage is written straight to that status by
-- submit_public_application(), and that receipt creates no Kit work at all:
-- no subscriber, no tag, nothing removed. The submitter still gets the same
-- undifferentiated response they get today.
create or replace function public.enqueue_kit_application_receipt()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status = 'pending' then
    perform public.enqueue_kit_application_sync(new.id, 'applicant', 'applicant');
  end if;
  return null;
end;
$$;

drop trigger if exists on_application_kit_receipt on public.applications;
create trigger on_application_kit_receipt
  after insert on public.applications
  for each row execute function public.enqueue_kit_application_receipt();

-- ---------------------------------------------------------------------------
-- Decision
-- ---------------------------------------------------------------------------
-- reviewApplication.ts records a decision as four separate browser writes, so
-- there is no shared transaction to hook. There is, however, one write that
-- IS the decision — applications.status leaving 'pending' — and a trigger on
-- it runs inside that statement's own transaction. That is the boundary.
--
-- The Kit intent is created AFTER the decision row is written, by the same
-- statement, so a Kit failure cannot roll it back: nothing in this path ever
-- raises. The worst case is a pending row in the outbox and a card asking Leif
-- to retry.
--
-- Guarded on the application already being Kit-managed — that is, on its
-- applicant operation existing. One condition carries all of it: right origin,
-- after the boundary, mapped programme, usable email. It is also what keeps
-- the five real applicants who predate this integration from being tagged the
-- moment Leif reviews them: their receipt was never Kit-managed, so their
-- decision is not either, and adopting them stays a deliberate act.
--
-- do_not_engage is absent from the list for the same reason it is absent from
-- the mapping: that decision stays inside the CRM.
create or replace function public.enqueue_kit_application_decision()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.status = 'pending'
     and new.status in ('approved', 'needs_higher_care', 'not_fit')
     and exists (
       select 1 from kit_sync_operations
        where application_id = new.id and kind = 'applicant'
     )
  then
    perform public.enqueue_kit_application_sync(new.id, 'decision', new.status);
  end if;
  return null;
end;
$$;

drop trigger if exists on_application_kit_decision on public.applications;
create trigger on_application_kit_decision
  after update of status on public.applications
  for each row
  when (old.status is distinct from new.status)
  execute function public.enqueue_kit_application_decision();

-- ---------------------------------------------------------------------------
-- Owner retry
-- ---------------------------------------------------------------------------
-- What the "Retry Kit sync" button reaches, through the Edge Function that
-- holds the credential. It only ever returns failed work to pending; it cannot
-- create an operation, cannot choose a tag, and cannot touch a succeeded row,
-- so pressing it twice — or pressing it after it worked — is safe.
create or replace function public.retry_kit_application_sync(p_application_id bigint)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
begin
  update kit_sync_operations
     set status = 'pending',
         failure_class = null,
         failure_reason = null,
         failed_at = null,
         updated_at = now()
   where application_id = p_application_id
     and status = 'failed';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
alter table public.kit_integration_settings enable row level security;
alter table public.kit_tag_mappings enable row level security;
alter table public.kit_sync_operations enable row level security;

-- The boundary and the mapping are deployment configuration, not app data.
-- Nothing in a browser needs to read them, and nothing in a browser may.
revoke all on public.kit_integration_settings from anon, authenticated;
revoke all on public.kit_tag_mappings from anon, authenticated;
grant select, insert, update, delete on public.kit_integration_settings to service_role;
grant select, insert, update, delete on public.kit_tag_mappings to service_role;

-- The operations ARE app data: the Application page shows whether Kit is done,
-- so Leif can read them. He cannot write them — every write is a trigger or
-- the worker, both running as the owner. Read-only is what makes "the browser
-- cannot name a tag id" true rather than merely intended.
revoke all on public.kit_sync_operations from anon;
grant select on public.kit_sync_operations to authenticated;
grant select, insert, update, delete on public.kit_sync_operations to service_role;
grant usage, select on sequence public.kit_sync_operations_id_seq to service_role;

drop policy if exists "Kit sync operations are readable" on public.kit_sync_operations;
create policy "Kit sync operations are readable" on public.kit_sync_operations
  for select to authenticated using (true);
-- No insert/update/delete policy exists, deliberately.

-- The enqueue is internal. Not even service_role: on its own it would create
-- a tag operation with no application event to justify one.
revoke all on function public.enqueue_kit_application_sync(bigint, text, text) from public;
revoke all on function public.enqueue_kit_application_sync(bigint, text, text) from anon;
revoke all on function public.enqueue_kit_application_sync(bigint, text, text) from authenticated;
revoke all on function public.enqueue_kit_application_sync(bigint, text, text) from service_role;

revoke all on function public.enqueue_kit_application_receipt() from public;
revoke all on function public.enqueue_kit_application_receipt() from anon;
revoke all on function public.enqueue_kit_application_receipt() from authenticated;
revoke all on function public.enqueue_kit_application_decision() from public;
revoke all on function public.enqueue_kit_application_decision() from anon;
revoke all on function public.enqueue_kit_application_decision() from authenticated;

-- Retry belongs to the Edge Function, which is the only thing holding the Kit
-- credential. The browser asks it; it does not ask the database.
revoke all on function public.retry_kit_application_sync(bigint) from public;
revoke all on function public.retry_kit_application_sync(bigint) from anon;
revoke all on function public.retry_kit_application_sync(bigint) from authenticated;
grant execute on function public.retry_kit_application_sync(bigint) to service_role;

-- ---------------------------------------------------------------------------
-- The worker's claim
-- ---------------------------------------------------------------------------
-- `for update skip locked` so two overlapping runs — the five-minute cron and
-- Leif pressing Retry — cannot both take the same operation, and so a row one
-- worker is holding never blocks the other from getting on with someone else's.
--
-- A 'processing' row whose attempt started more than ten minutes ago is
-- reclaimed: the only way to be there that long is a worker that died mid-call,
-- and an operation stuck forever in processing is invisible work, which is the
-- failure mode this whole slice exists to end.
create or replace function public.claim_kit_sync_operations(p_limit integer default 25)
returns setof public.kit_sync_operations
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  return query
  update kit_sync_operations o
     set status = 'processing',
         attempts = o.attempts + 1,
         last_attempt_at = now(),
         updated_at = now()
   where o.id in (
     select c.id from kit_sync_operations c
      where c.status = 'pending'
         or (c.status = 'processing' and c.last_attempt_at < now() - interval '10 minutes')
      order by c.created_at
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning o.*;
end;
$$;

revoke all on function public.claim_kit_sync_operations(integer) from public;
revoke all on function public.claim_kit_sync_operations(integer) from anon;
revoke all on function public.claim_kit_sync_operations(integer) from authenticated;
grant execute on function public.claim_kit_sync_operations(integer) to service_role;

-- ---------------------------------------------------------------------------
-- The worker's schedule
-- ---------------------------------------------------------------------------
-- Same posture as every other scheduled call here: fail closed rather than
-- schedule an unauthenticated one. Every five minutes, because the tag that
-- matters most — an outcome — is followed by an email Leif expects to go out
-- shortly after he decides, and because a shorter loop buys nothing when the
-- work is usually one or two rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is not installed; the Kit sync cannot be scheduled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'pg_net is not installed; the Kit sync cannot be scheduled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'cron_invoke_secret'
  ) THEN
    RAISE EXCEPTION 'vault secret cron_invoke_secret is missing; refusing to schedule an unauthenticated call';
  END IF;
END $$;

SELECT cron.unschedule('kit-sync')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'kit-sync');

SELECT cron.schedule(
  'kit-sync',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://xlyywsguftyvomeretju.supabase.co/functions/v1/kit_sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_invoke_secret')
    ),
    body := '{"action":"process"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'kit-sync') THEN
    RAISE EXCEPTION 'kit-sync was not scheduled';
  END IF;
  RAISE NOTICE 'kit sync scheduled every five minutes';
END $$;

-- ---------------------------------------------------------------------------
-- The cascade allow-list, restated with its new member
-- ---------------------------------------------------------------------------
-- 20260921180000 asserted the exact set of foreign keys permitted to cascade
-- from a Programme or a round, and said in its own error message what to do
-- when a new one is justified: "Either it holds no fact about a person (add it
-- to the allowed list here, with the reason) or it must be NO ACTION."
--
-- kit_tag_mappings is the fifth, and it is the first kind: which Kit tag a
-- programme's applications and decisions mean is deployment configuration
-- ABOUT the programme, holds nothing about any person, and is re-seeded by a
-- migration like this one. Deleting a Programme that no longer exists should
-- not leave its tag mapping behind.
--
-- Restated here rather than only in the older migration, because that one runs
-- before this table exists and can no longer speak for the current catalogue.
DO $$
DECLARE
    offending text;
    allowed text[] := array[
        'offer_payment_options',
        'onboarding_requirement_templates',
        'offboarding_requirement_templates',
        'expected_session_windows',
        'kit_tag_mappings'
    ];
BEGIN
    SELECT string_agg(c.conrelid::regclass::text || '.' || c.conname, ', ' ORDER BY c.conname)
      INTO offending
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confdeltype = 'c'
       AND c.confrelid IN ('public.cohorts'::regclass, 'public.offers'::regclass)
       AND c.conrelid::regclass::text <> ALL (allowed);

    IF offending IS NOT NULL THEN
        RAISE EXCEPTION
            'deleting a Program or round would cascade into: %. Either it holds no fact about a person (add it to the allowed list here, with the reason) or it must be NO ACTION.',
            offending;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Proof
-- ---------------------------------------------------------------------------
-- Two things are asserted about the database this migration just ran against,
-- and the rest is exercised on throwaway rows inside a subtransaction that is
-- always unwound. Nothing here survives, and nothing here touches a real
-- person.
DO $proof$
DECLARE
  v_not_before timestamp with time zone;
  v_would_backfill integer;
  v_mappings integer;
  v_contact bigint;
  v_deal bigint;
  v_app bigint;
  v_ops integer;
  v_tag bigint;
  v_refused boolean := false;
  v_result jsonb;
  v_outstanding integer;
  v_retry_contact bigint;
  v_retry_app bigint;
  v_manual_contact bigint;
  v_dne_contact bigint;
  v_le constant bigint := 1;
BEGIN
  SELECT not_before INTO v_not_before FROM kit_integration_settings WHERE id = 1;
  IF v_not_before IS NULL THEN
    RAISE EXCEPTION 'the integration has no not-before boundary';
  END IF;

  -- The whole deployment-safety claim, as an assertion rather than a promise:
  -- every application that already exists predates the boundary, so this
  -- migration enqueues nothing for anybody.
  SELECT count(*) INTO v_would_backfill FROM applications WHERE created_at >= v_not_before;
  IF v_would_backfill <> 0 THEN
    RAISE EXCEPTION 'the boundary would backfill % existing application(s)', v_would_backfill;
  END IF;
  IF EXISTS (SELECT 1 FROM kit_sync_operations) THEN
    RAISE EXCEPTION 'deploying the integration created Kit work';
  END IF;

  SELECT count(*) INTO v_mappings FROM kit_tag_mappings;
  IF v_mappings <> 8 THEN
    RAISE EXCEPTION 'expected eight tag mappings, found %', v_mappings;
  END IF;
  IF (SELECT kit_tag_id FROM kit_tag_mappings WHERE offer_id = 1 AND event = 'applicant') <> 24082722
     OR (SELECT kit_tag_id FROM kit_tag_mappings WHERE offer_id = 1 AND event = 'approved') <> 21784073
     OR (SELECT kit_tag_id FROM kit_tag_mappings WHERE offer_id = 1 AND event = 'needs_higher_care') <> 24082725
     OR (SELECT kit_tag_id FROM kit_tag_mappings WHERE offer_id = 1 AND event = 'not_fit') <> 21784076
     OR (SELECT kit_tag_id FROM kit_tag_mappings WHERE offer_id = 2 AND event = 'applicant') <> 24082724
     OR (SELECT kit_tag_id FROM kit_tag_mappings WHERE offer_id = 2 AND event = 'approved') <> 21481248
     OR (SELECT kit_tag_id FROM kit_tag_mappings WHERE offer_id = 2 AND event = 'needs_higher_care') <> 24082732
     OR (SELECT kit_tag_id FROM kit_tag_mappings WHERE offer_id = 2 AND event = 'not_fit') <> 21481382 THEN
    RAISE EXCEPTION 'a tag mapping is not the one Leif gave';
  END IF;
  IF EXISTS (SELECT 1 FROM kit_tag_mappings WHERE event = 'do_not_engage') THEN
    RAISE EXCEPTION 'Do Not Engage has a Kit tag; it must not';
  END IF;

  BEGIN
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Kit', 'Proof',
            jsonb_build_array(jsonb_build_object('email', '  KIT.Proof@Example.COM ', 'type', 'Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_contact;

    INSERT INTO deals (contact_id, offer_id, stage, amount, entry_path, description, index)
    VALUES (v_contact, v_le, 'application_received', 4000, 'application_form', '', 0)
    RETURNING id INTO v_deal;

    -- ---- a live application is Kit-managed, with the programme's tag -------
    INSERT INTO applications (contact_id, opportunity_id, offer_id, raw_answers,
                              submitted_at, status, source)
    VALUES (v_contact, v_deal, v_le, '{}'::jsonb, now(), 'pending', 'public_form')
    RETURNING id INTO v_app;

    SELECT count(*) INTO v_ops FROM kit_sync_operations WHERE application_id = v_app;
    IF v_ops <> 1 THEN
      RAISE EXCEPTION 'a live application produced % Kit operation(s), expected 1', v_ops;
    END IF;
    SELECT kit_tag_id INTO v_tag FROM kit_sync_operations
     WHERE application_id = v_app AND kind = 'applicant';
    IF v_tag <> 24082722 THEN
      RAISE EXCEPTION 'the Living Example applicant tag was %, expected 24082722', v_tag;
    END IF;
    -- The email is the CRM's canonical form, not what the form happened to
    -- carry: trimmed, lower-cased, and the same string every later operation
    -- for this person will use.
    IF (SELECT email FROM kit_sync_operations WHERE application_id = v_app AND kind = 'applicant')
       <> 'kit.proof@example.com' THEN
      RAISE EXCEPTION 'the queued email was not normalized';
    END IF;

    -- ---- deciding adds the outcome tag and keeps the applicant tag --------
    UPDATE applications SET status = 'approved', reviewed_at = now() WHERE id = v_app;
    SELECT count(*) INTO v_ops FROM kit_sync_operations WHERE application_id = v_app;
    IF v_ops <> 2 THEN
      RAISE EXCEPTION 'deciding produced % operation(s), expected 2', v_ops;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM kit_sync_operations
                    WHERE application_id = v_app AND kind = 'applicant') THEN
      RAISE EXCEPTION 'the applicant tag was removed; tagging is additive';
    END IF;
    SELECT kit_tag_id INTO v_tag FROM kit_sync_operations
     WHERE application_id = v_app AND kind = 'decision';
    IF v_tag <> 21784073 THEN
      RAISE EXCEPTION 'the Living Example approved tag was %, expected 21784073', v_tag;
    END IF;

    -- ---- replay writes nothing new ---------------------------------------
    PERFORM public.enqueue_kit_application_sync(v_app, 'applicant', 'applicant');
    PERFORM public.enqueue_kit_application_sync(v_app, 'decision', 'approved');
    UPDATE applications SET status = 'approved' WHERE id = v_app;
    SELECT count(*) INTO v_ops FROM kit_sync_operations WHERE application_id = v_app;
    IF v_ops <> 2 THEN
      RAISE EXCEPTION 'replaying the enqueue produced % operation(s), expected 2', v_ops;
    END IF;

    -- ---- an imported record stays history --------------------------------
    INSERT INTO applications (contact_id, offer_id, raw_answers, submitted_at, status, source)
    VALUES (v_contact, v_le, '{}'::jsonb, now(), 'pending', 'historical_import')
    RETURNING id INTO v_app;
    IF EXISTS (SELECT 1 FROM kit_sync_operations WHERE application_id = v_app) THEN
      RAISE EXCEPTION 'an imported application was queued for Kit';
    END IF;

    -- ---- Do Not Engage at receipt creates no Kit work at all --------------
    INSERT INTO applications (contact_id, offer_id, raw_answers, submitted_at,
                              status, reviewed_at, source)
    VALUES (v_contact, v_le, '{}'::jsonb, now(), 'do_not_engage', now(), 'public_form')
    RETURNING id INTO v_app;
    IF EXISTS (SELECT 1 FROM kit_sync_operations WHERE application_id = v_app) THEN
      RAISE EXCEPTION 'a Do Not Engage receipt was queued for Kit';
    END IF;

    -- ---- an application that predates the integration is left alone ------
    INSERT INTO applications (contact_id, offer_id, raw_answers, submitted_at,
                              status, source, created_at)
    VALUES (v_contact, v_le, '{}'::jsonb, now(), 'pending', 'public_form',
            v_not_before - interval '1 second')
    RETURNING id INTO v_app;
    IF EXISTS (SELECT 1 FROM kit_sync_operations WHERE application_id = v_app) THEN
      RAISE EXCEPTION 'an application from before the boundary was queued for Kit';
    END IF;
    -- And deciding it still queues nothing, because it was never managed.
    UPDATE applications SET status = 'approved', reviewed_at = now() WHERE id = v_app;
    IF EXISTS (SELECT 1 FROM kit_sync_operations WHERE application_id = v_app) THEN
      RAISE EXCEPTION 'deciding a pre-boundary application queued Kit work';
    END IF;

    -- ---- an unmapped programme is refused, never guessed ------------------
    IF EXISTS (SELECT 1 FROM offers WHERE id = 3) THEN
      INSERT INTO applications (contact_id, offer_id, raw_answers, submitted_at, status, source)
      VALUES (v_contact, 3, '{}'::jsonb, now(), 'pending', 'public_form')
      RETURNING id INTO v_app;
      IF EXISTS (SELECT 1 FROM kit_sync_operations WHERE application_id = v_app) THEN
        RAISE EXCEPTION 'an unmapped programme was given a guessed Kit tag';
      END IF;
    END IF;

    -- ---- a browser cannot name a tag --------------------------------------
    BEGIN
      SET LOCAL role authenticated;
      INSERT INTO kit_sync_operations
        (application_id, contact_id, kind, email, kit_tag_id, kit_tag_name)
      VALUES (v_app, v_contact, 'decision', 'kit.proof@example.com', 999999, 'Anything');
      RESET role;
    EXCEPTION WHEN others THEN
      RESET role;
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'an authenticated session inserted its own Kit tag operation';
    END IF;

    -- ---- nothing may call itself done without Kit's own answer ------------
    v_refused := false;
    BEGIN
      UPDATE kit_sync_operations SET status = 'succeeded', succeeded_at = now()
       WHERE kit_tag_id = 24082722;
    EXCEPTION WHEN check_violation THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'an operation was marked succeeded with no subscriber to show for it';
    END IF;

    -- ---- the REAL receipt paths, not a raw insert -------------------------
    -- submit_public_application() and create_manual_application() are what
    -- actually create an application in production, each inside its own
    -- transaction. Proving the intent appears there is proving it commits
    -- with the application rather than beside it.
    v_result := public.submit_public_application(
      v_le, null, 'Grace', 'Hopper', '  Grace.Hopper@Example.COM ', null,
      '{"why_this_program":"proof"}'::jsonb);
    IF v_result ->> 'status' <> 'submitted' THEN
      RAISE EXCEPTION 'the public submission did not succeed: %', v_result;
    END IF;
    v_app := (v_result ->> 'application_id')::bigint;
    SELECT count(*) INTO v_ops FROM kit_sync_operations WHERE application_id = v_app;
    IF v_ops <> 1 THEN
      RAISE EXCEPTION 'a real public submission produced % Kit operation(s)', v_ops;
    END IF;
    IF (SELECT email FROM kit_sync_operations WHERE application_id = v_app)
       <> 'grace.hopper@example.com' THEN
      RAISE EXCEPTION 'the real path queued an un-normalized email';
    END IF;
    -- Resubmitting the same form adds nothing.
    PERFORM public.submit_public_application(
      v_le, null, 'Grace', 'Hopper', 'grace.hopper@example.com', null,
      '{"why_this_program":"proof"}'::jsonb);
    SELECT count(*) INTO v_ops FROM kit_sync_operations WHERE application_id = v_app;
    IF v_ops <> 1 THEN
      RAISE EXCEPTION 'resubmitting produced % operation(s), expected 1', v_ops;
    END IF;

    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Manual', 'Entry',
            jsonb_build_array(jsonb_build_object('email','manual.proof@example.com','type','Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_manual_contact;
    v_result := public.create_manual_application(v_manual_contact, v_le, null);
    IF v_result ->> 'status' <> 'created' THEN
      RAISE EXCEPTION 'the manual application did not create: %', v_result;
    END IF;
    IF (SELECT kit_tag_id FROM kit_sync_operations
         WHERE application_id = (v_result ->> 'application_id')::bigint) <> 24082722 THEN
      RAISE EXCEPTION 'a manual application did not get the programme applicant tag';
    END IF;

    -- ---- Do Not Engage, through the real path, reaches Kit not at all ----
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Refused', 'Person',
            jsonb_build_array(jsonb_build_object('email','refused.proof@example.com','type','Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'do_not_engage')
    RETURNING id INTO v_dne_contact;
    v_result := public.submit_public_application(
      v_le, null, 'Refused', 'Person', 'refused.proof@example.com', null, '{}'::jsonb);
    -- The submitter is told exactly what anybody else is told.
    IF v_result ->> 'status' <> 'submitted'
       OR NOT (v_result ->> 'dne_auto_resolved')::boolean THEN
      RAISE EXCEPTION 'the Do Not Engage receipt changed shape: %', v_result;
    END IF;
    IF EXISTS (SELECT 1 FROM kit_sync_operations
                WHERE application_id = (v_result ->> 'application_id')::bigint) THEN
      RAISE EXCEPTION 'a Do Not Engage receipt reached Kit';
    END IF;

    -- ---- claiming, failing, retrying, and succeeding ----------------------
    -- One application of its own, so the assertions below name a row rather
    -- than a tag id that several proof applications now share.
    INSERT INTO contacts (first_name, last_name, email_jsonb, phone_jsonb, tags,
                          has_newsletter, first_seen, last_seen, sales_eligibility)
    VALUES ('Retry', 'Proof',
            jsonb_build_array(jsonb_build_object('email','retry.proof@example.com','type','Other')),
            '[]'::jsonb, ARRAY[]::bigint[], false, now(), now(), 'normal')
    RETURNING id INTO v_retry_contact;
    v_result := public.create_manual_application(v_retry_contact, v_le, null);
    v_retry_app := (v_result ->> 'application_id')::bigint;
    UPDATE applications SET status = 'approved', reviewed_at = now() WHERE id = v_retry_app;
    SELECT count(*) INTO v_ops FROM kit_sync_operations WHERE application_id = v_retry_app;
    IF v_ops <> 2 THEN
      RAISE EXCEPTION 'the retry fixture owes % operation(s), expected 2', v_ops;
    END IF;

    SELECT count(*) INTO v_outstanding FROM kit_sync_operations WHERE status = 'pending';
    SELECT count(*) INTO v_ops FROM public.claim_kit_sync_operations(100);
    IF v_ops <> v_outstanding OR v_outstanding = 0 THEN
      RAISE EXCEPTION 'the claim took % of % outstanding operation(s)', v_ops, v_outstanding;
    END IF;
    -- A second worker starting while the first still holds them gets nothing,
    -- rather than a duplicate of the same tag call.
    SELECT count(*) INTO v_ops FROM public.claim_kit_sync_operations(100);
    IF v_ops <> 0 THEN
      RAISE EXCEPTION 'a second claim took % already-claimed operation(s)', v_ops;
    END IF;
    IF (SELECT min(attempts) FROM kit_sync_operations WHERE application_id = v_retry_app) <> 1 THEN
      RAISE EXCEPTION 'claiming did not record the attempt';
    END IF;

    -- Kit refused the decision tag. The CRM decision is untouched by that.
    UPDATE kit_sync_operations
       SET status = 'failed', failed_at = now(), failure_class = 'provider_unavailable',
           failure_reason = 'Kit returned 503', updated_at = now()
     WHERE application_id = v_retry_app AND kind = 'decision';
    IF (SELECT status FROM applications WHERE id = v_retry_app) <> 'approved' THEN
      RAISE EXCEPTION 'a Kit failure changed the CRM decision';
    END IF;

    -- Retry returns only the failed work, and is safe to press again.
    IF public.retry_kit_application_sync(v_retry_app) <> 1 THEN
      RAISE EXCEPTION 'retry did not re-queue exactly the failed operation';
    END IF;
    IF public.retry_kit_application_sync(v_retry_app) <> 0 THEN
      RAISE EXCEPTION 'retry re-queued something that was not failed';
    END IF;

    -- With the subscriber Kit actually returned, the applicant tag may call
    -- itself done — and a succeeded row is never re-queued by a later retry.
    UPDATE kit_sync_operations
       SET status = 'succeeded', succeeded_at = now(), kit_subscriber_id = '987654',
           failure_class = null, failure_reason = null, failed_at = null, updated_at = now()
     WHERE application_id = v_retry_app AND kind = 'applicant';
    IF public.retry_kit_application_sync(v_retry_app) <> 0 THEN
      RAISE EXCEPTION 'retry re-queued work that had already succeeded';
    END IF;
    IF (SELECT status FROM kit_sync_operations
         WHERE application_id = v_retry_app AND kind = 'applicant') <> 'succeeded' THEN
      RAISE EXCEPTION 'retry disturbed an operation that had already succeeded';
    END IF;

    RAISE NOTICE 'kit proof: live receipt tags, decision adds without removing, replay is a no-op, import/DNE/pre-boundary/unmapped all queue nothing, the real submit/manual paths enqueue inside their own transactions, the browser cannot tag, claim/fail/retry/succeed hold, and success needs evidence';

    RAISE EXCEPTION 'kit proof complete' USING ERRCODE = 'restrict_violation';
  EXCEPTION
    WHEN restrict_violation THEN
      NULL;
  END;
END
$proof$;
