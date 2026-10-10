-- Inviting the oldest people waiting, through the same Kit worker as
-- everything else.
--
-- Leif's real workflow: the sales-call calendar fills, she stops inviting;
-- when capacity reopens she invites a large batch off a waitlist to go and
-- apply. The invitation RECORDS already existed — waitlist_invitation_batches
-- and waitlist_invitations, built so that nobody is marked Invited because a
-- checkbox was ticked. What they lacked was a way to actually deliver one.
--
-- This gives them one, and reuses rather than rebuilds:
--
--   kit_tag_mappings      says which tag a programme means by an event, so
--                         no tag string is ever written into runtime code.
--   kit_sync_operations   the durable outbox, with its evidence rules, its
--                         failure classes and its retry policy already
--                         proven by the applicant and decision paths.
--   enqueue_kit_operation the one place an operation is created, including
--                         the rule for which address a person is reached at.
--
-- The one genuinely new rule: a person stops being Waiting only when Kit has
-- confirmed the tag. That is a trigger below rather than something the
-- worker remembers to do, because "the CRM said invited and Kit never heard"
-- is the failure this whole design exists to make impossible.

-- ---------------------------------------------------------------------------
-- 1. The event
-- ---------------------------------------------------------------------------
-- An invitation to apply is a programme-level fact, exactly like an
-- application or a decision, so it is an event on the same mapping table.
-- Deliberately NOT seeded with tag ids: the ids are Leif's, they live in Kit,
-- and she sets them from the programme's own Kit box like every other event.
alter table public.kit_tag_mappings
    drop constraint if exists kit_tag_mappings_event_check;
alter table public.kit_tag_mappings
    add constraint kit_tag_mappings_event_check
    check (event in ('applicant', 'approved', 'needs_higher_care', 'not_fit',
                     'offered_other_programme', 'bespoke_accepted',
                     'bespoke_denied', 'waitlist_invited'));

-- ---------------------------------------------------------------------------
-- 2. A tag is a way of delivering an invitation
-- ---------------------------------------------------------------------------
alter table public.waitlist_invitations
    drop constraint if exists waitlist_invitations_delivery_method_check;
alter table public.waitlist_invitations
    add constraint waitlist_invitations_delivery_method_check
    check (delivery_method in ('manual', 'gmail', 'kit_tag'));

-- ---------------------------------------------------------------------------
-- 3. The outbox learns a third subject
-- ---------------------------------------------------------------------------
-- It already carries two: an application's automatic tags, and a tag Leif
-- asked for by hand. An invitation is the third, and the shape check keeps
-- each origin honest about which subject it must have.
alter table public.kit_sync_operations
    add column if not exists waitlist_invitation_id bigint;
alter table public.kit_sync_operations
    drop constraint if exists kit_sync_operations_waitlist_invitation_id_fkey;
alter table public.kit_sync_operations
    add constraint kit_sync_operations_waitlist_invitation_id_fkey
    foreign key (waitlist_invitation_id)
    references public.waitlist_invitations(id) on update cascade on delete cascade;

alter table public.kit_sync_operations
    drop constraint if exists kit_sync_operations_kind_check;
alter table public.kit_sync_operations
    add constraint kit_sync_operations_kind_check
    check (kind in ('applicant', 'cohort', 'decision', 'manual', 'waitlist_invited'));

alter table public.kit_sync_operations
    drop constraint if exists kit_sync_operations_origin_check;
alter table public.kit_sync_operations
    add constraint kit_sync_operations_origin_check
    check (origin in ('automatic_application', 'manual_owner', 'waitlist_invitation'));

alter table public.kit_sync_operations
    drop constraint if exists kit_sync_operations_origin_shape_check;
alter table public.kit_sync_operations
    add constraint kit_sync_operations_origin_shape_check
    check (
        (origin = 'automatic_application'
            and application_id is not null
            and waitlist_invitation_id is null
            and kind in ('applicant', 'cohort', 'decision'))
     or (origin = 'manual_owner'
            and waitlist_invitation_id is null
            and kind = 'manual')
     or (origin = 'waitlist_invitation'
            and waitlist_invitation_id is not null
            and application_id is null
            and kind = 'waitlist_invited')
    );

-- ONE Kit operation per invitation, forever. This is what makes a retry a
-- retry: asking again for a batch that already ran reaches the same rows
-- instead of tagging anybody twice.
create unique index if not exists kit_sync_operations_waitlist_invitation_idx
    on public.kit_sync_operations (waitlist_invitation_id)
    where origin = 'waitlist_invitation';

-- The enqueue authority gains the new subject and nothing else: same email
-- rule, same conflict behaviour, same single place an operation is born.
--
-- Dropped and recreated rather than replaced: a new DEFAULTED parameter
-- makes a second function rather than a new version of the first, and every
-- existing seven-argument caller then fails to choose between them. There is
-- one enqueue authority, so there is one function.
drop function if exists public.enqueue_kit_operation(
  bigint, bigint, text, text, bigint, text, text);

create or replace function public.enqueue_kit_operation(
  p_contact_id bigint,
  p_application_id bigint,
  p_kind text,
  p_origin text,
  p_kit_tag_id bigint,
  p_kit_tag_name text,
  p_requested_by text default null,
  p_waitlist_invitation_id bigint default null
) returns bigint
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_email text;
  v_id bigint;
begin
  if p_kit_tag_id is null or p_kit_tag_id <= 0 then
    return null;
  end if;

  -- The CRM's canonical address for this person, by the same rule the receipt
  -- path uses, so every operation for them is addressed identically.
  select a.normalized_email into v_email
    from contact_email_addresses a
   where a.contact_id = p_contact_id
   order by a.normalized_email
   limit 1;
  if v_email is null then
    return null;
  end if;

  insert into kit_sync_operations
    (application_id, contact_id, kind, origin, email, kit_tag_id, kit_tag_name,
     requested_by, waitlist_invitation_id)
  values
    (p_application_id, p_contact_id, p_kind, p_origin, v_email, p_kit_tag_id,
     coalesce(nullif(btrim(p_kit_tag_name), ''), 'tag ' || p_kit_tag_id),
     p_requested_by, p_waitlist_invitation_id)
  on conflict do nothing
  returning id into v_id;

  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Who may be invited, and why somebody may not
-- ---------------------------------------------------------------------------
-- One function answers both the preview and the run, so the list Leif
-- confirms is produced by the same rules that do the work. An exclusion is
-- NAMED rather than filtered away: "25 of 61 are eligible" is not an answer
-- anybody can act on, and the twelve reasons below are.
--
-- Precedence matters. A person can be several kinds of ineligible at once,
-- and the first reason is the one that would still be true if the others
-- were fixed.
create or replace function public.waitlist_invitation_candidates(
  p_offer_id bigint,
  p_cohort_id bigint default null
) returns table (
  waitlist_entry_id bigint,
  contact_id bigint,
  contact_name text,
  email text,
  joined_at timestamp with time zone,
  cohort_id bigint,
  eligible boolean,
  exclusion_reason text,
  rank_if_eligible bigint
)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  with waiting as (
    select w.*
      from waitlist_entries w
     where w.offer_id = p_offer_id
       and (p_cohort_id is null or w.cohort_id = p_cohort_id)
       and w.status in ('waiting', 'invited')
  ),
  -- A person may hold more than one place for the same programme: a general
  -- one and a round's. That is two records of intent and one person, and
  -- inviting both would tag them twice. The oldest place is the one that
  -- carries the invitation.
  oldest_per_person as (
    select distinct on (w.contact_id) w.*
      from waiting w
     order by w.contact_id, w.joined_at asc, w.id asc
  ),
  judged as (
    select
      w.id as waitlist_entry_id,
      w.contact_id,
      btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))
        as contact_name,
      (select a.normalized_email
         from contact_email_addresses a
        where a.contact_id = w.contact_id
        order by a.normalized_email
        limit 1) as email,
      w.joined_at,
      w.cohort_id,
      case
        -- Already holding an invitation for this programme. Re-inviting is a
        -- real workflow, but it is a decision rather than part of "the
        -- oldest N who have not been asked".
        when w.status = 'invited' then 'already-invited'
        when exists (
          select 1 from waitlist_invitations i
           where i.waitlist_entry_id = w.id and i.status = 'sent'
        ) then 'already-invited'
        -- An invitation already on its way. Asking again before Kit has
        -- answered is how somebody gets tagged twice.
        when exists (
          select 1 from waitlist_invitations i
            join kit_sync_operations o on o.waitlist_invitation_id = i.id
           where i.waitlist_entry_id = w.id
             and o.status in ('pending', 'processing')
        ) then 'invitation-in-flight'
        when c.id is null then 'contact-missing'
        when c.sales_eligibility = 'do_not_engage' then 'do-not-engage'
        when not exists (
          select 1 from contact_email_addresses a where a.contact_id = w.contact_id
        ) then 'no-email'
        -- Inviting somebody to apply who has already applied is nonsense,
        -- whatever became of the application afterwards.
        when exists (
          select 1 from applications ap
           where ap.contact_id = w.contact_id and ap.offer_id = p_offer_id
        ) then 'already-applied'
        -- Sold, or in the programme. Either way they are past being asked.
        when exists (
          select 1 from deals d
           where d.contact_id = w.contact_id and d.offer_id = p_offer_id
             and (d.stage = 'won' or exists (
                   select 1 from enrollments e
                    where e.opportunity_id = d.id
                      and e.status in ('onboarding', 'active', 'offboarding')))
        ) then 'already-a-client'
        -- Kit refused this address before. 'rejected' is the class that means
        -- Kit will say the same thing again — a suppression, a bounce, a
        -- complaint — so repeating the call is not a retry, it is the same
        -- refusal twice.
        when exists (
          select 1 from kit_sync_operations o
           where o.contact_id = w.contact_id
             and o.status = 'failed'
             and o.failure_class = 'rejected'
        ) then 'kit-refused-this-address-before'
        else null
      end as exclusion_reason
    from oldest_per_person w
    left join contacts c on c.id = w.contact_id
  )
  select
    j.waitlist_entry_id,
    j.contact_id,
    j.contact_name,
    j.email,
    j.joined_at,
    j.cohort_id,
    j.exclusion_reason is null as eligible,
    j.exclusion_reason,
    case
      when j.exclusion_reason is null
      then row_number() over (
             partition by (j.exclusion_reason is null)
             order by j.joined_at asc, j.waitlist_entry_id asc)
    end as rank_if_eligible
  from judged j
  order by j.joined_at asc, j.waitlist_entry_id asc;
$fn$;

revoke all on function public.waitlist_invitation_candidates(bigint, bigint) from public;
grant execute on function public.waitlist_invitation_candidates(bigint, bigint) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Claiming a batch
-- ---------------------------------------------------------------------------
-- The SERVER decides who the oldest eligible N are. What the browser had on
-- screen is a display, and a display can be stale, filtered, collapsed, or
-- simply from five minutes ago — none of which may decide who gets an email.
--
-- Everything here is one transaction: the entries are locked, the batch and
-- its invitations are written, and an outbox row is created per person. Kit
-- is not called. If this function returns, the work is durable and the
-- worker will do it; if it throws, nothing happened at all.
create or replace function public.invite_oldest_waiting(
  p_offer_id bigint,
  p_cohort_id bigint default null,
  p_limit integer default null,
  p_entry_ids bigint[] default null,
  p_label text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_mapping kit_tag_mappings%rowtype;
  v_batch_id bigint;
  v_row record;
  v_invitation_id bigint;
  v_operation_id bigint;
  v_requested_by text;
  v_invited jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_taken integer := 0;
begin
  if p_limit is null and p_entry_ids is null then
    return jsonb_build_object('status', 'nothing-asked-for');
  end if;
  if p_limit is not null and p_limit <= 0 then
    return jsonb_build_object('status', 'nothing-asked-for');
  end if;

  -- No mapping, no invitation. A programme that has not been told which tag
  -- it means by an invitation is not ready to send one, and guessing a tag
  -- id is the one thing this architecture exists to prevent.
  select * into v_mapping from kit_tag_mappings
   where offer_id = p_offer_id and event = 'waitlist_invited';
  if not found then
    return jsonb_build_object('status', 'not-configured', 'offer_id', p_offer_id);
  end if;

  select coalesce(s.email, btrim(s.first_name || ' ' || s.last_name))
    into v_requested_by
    from sales s where s.user_id = auth.uid();

  -- Lock the places being considered, so two people clicking Invite at once
  -- cannot both claim the same person.
  perform 1 from waitlist_entries w
   where w.offer_id = p_offer_id
     and (p_cohort_id is null or w.cohort_id = p_cohort_id)
     and w.status in ('waiting', 'invited')
   order by w.id
   for update;

  insert into waitlist_invitation_batches (offer_id, cohort_id, label, status)
  values (p_offer_id, p_cohort_id,
          coalesce(nullif(btrim(p_label), ''), 'Invite to apply'), 'prepared')
  returning id into v_batch_id;

  for v_row in
    select c.*
      from waitlist_invitation_candidates(p_offer_id, p_cohort_id) c
     where (p_entry_ids is null or c.waitlist_entry_id = any (p_entry_ids))
     order by c.joined_at asc, c.waitlist_entry_id asc
  loop
    -- An asked-for person who cannot be invited is REPORTED, never silently
    -- dropped; and they do not consume one of the requested N, because the
    -- request was for N people to be invited rather than N rows to be read.
    if not v_row.eligible then
      v_skipped := v_skipped || jsonb_build_object(
        'waitlist_entry_id', v_row.waitlist_entry_id,
        'contact_id', v_row.contact_id,
        'name', v_row.contact_name,
        'email', v_row.email,
        'joined_at', v_row.joined_at,
        'reason', v_row.exclusion_reason);
      continue;
    end if;

    exit when p_limit is not null and v_taken >= p_limit;

    insert into waitlist_invitations
      (batch_id, waitlist_entry_id, contact_id, status, prepared_at)
    values (v_batch_id, v_row.waitlist_entry_id, v_row.contact_id,
            'prepared', now())
    returning id into v_invitation_id;

    v_operation_id := public.enqueue_kit_operation(
      v_row.contact_id, null, 'waitlist_invited', 'waitlist_invitation',
      v_mapping.kit_tag_id, v_mapping.kit_tag_name,
      coalesce(v_requested_by, 'owner'), v_invitation_id);

    if v_operation_id is null then
      -- enqueue refuses without a usable address. The candidate list already
      -- checks that, so reaching here means the address disappeared between
      -- the two — recorded as a skip rather than an invitation nobody can
      -- deliver.
      update waitlist_invitations
         set status = 'failed', failed_at = now(),
             failure_reason = 'No usable email address at the moment of sending'
       where id = v_invitation_id;
      v_skipped := v_skipped || jsonb_build_object(
        'waitlist_entry_id', v_row.waitlist_entry_id,
        'contact_id', v_row.contact_id,
        'name', v_row.contact_name,
        'reason', 'no-email');
      continue;
    end if;

    v_taken := v_taken + 1;
    v_invited := v_invited || jsonb_build_object(
      'waitlist_entry_id', v_row.waitlist_entry_id,
      'contact_id', v_row.contact_id,
      'name', v_row.contact_name,
      'email', v_row.email,
      'joined_at', v_row.joined_at,
      'invitation_id', v_invitation_id,
      'operation_id', v_operation_id);
  end loop;

  -- A batch that claimed nobody is not a batch. Removing it keeps the
  -- history readable: every row in it is an invitation somebody actually
  -- made.
  if v_taken = 0 then
    delete from waitlist_invitation_batches where id = v_batch_id;
    v_batch_id := null;
  end if;

  return jsonb_build_object(
    'status', case when v_taken = 0 then 'nobody-eligible' else 'queued' end,
    'batch_id', v_batch_id,
    'offer_id', p_offer_id,
    'cohort_id', p_cohort_id,
    'kit_tag_id', v_mapping.kit_tag_id,
    'kit_tag_name', v_mapping.kit_tag_name,
    'requested', coalesce(p_limit, coalesce(array_length(p_entry_ids, 1), 0)),
    'queued', v_taken,
    'invited', v_invited,
    'skipped', v_skipped);
end;
$fn$;

revoke all on function public.invite_oldest_waiting(bigint, bigint, integer, bigint[], text) from public;
grant execute on function public.invite_oldest_waiting(bigint, bigint, integer, bigint[], text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Waiting ends when Kit says so
-- ---------------------------------------------------------------------------
-- Not when the row was written, not when the worker returned 2xx locally —
-- when the operation carries the subscriber id Kit gave back, which the
-- outbox's own success-evidence constraint already refuses to record
-- without. A trigger rather than worker code, so there is no version of
-- "the tag landed and the CRM forgot" and no version of "the CRM said
-- invited and Kit never heard".
create or replace function public.apply_waitlist_invitation_result()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_entry_id bigint;
begin
  if new.origin <> 'waitlist_invitation' then
    return new;
  end if;

  if new.status = 'succeeded' and old.status is distinct from 'succeeded' then
    update waitlist_invitations
       set status = 'sent',
           sent_at = coalesce(new.succeeded_at, now()),
           delivery_method = 'kit_tag',
           failed_at = null,
           failure_reason = null
     where id = new.waitlist_invitation_id
       and status <> 'sent'
    returning waitlist_entry_id into v_entry_id;

    -- Only a still-waiting place moves. An already-invited one is simply
    -- invited again, and its status is already what it should be.
    if v_entry_id is not null then
      update waitlist_entries
         set status = 'invited', invited_at = coalesce(new.succeeded_at, now())
       where id = v_entry_id and status = 'waiting';
    end if;

  elsif new.status = 'failed' and old.status is distinct from 'failed' then
    -- Recorded against the invitation so the batch can say who to try again,
    -- and NOBODY's waitlist place moves.
    update waitlist_invitations
       set status = 'failed',
           failed_at = coalesce(new.failed_at, now()),
           failure_reason = left(coalesce(new.failure_reason, new.failure_class,
                                          'Kit did not accept this'), 300)
     where id = new.waitlist_invitation_id
       and status <> 'sent';
  end if;

  return new;
end;
$fn$;

drop trigger if exists apply_waitlist_invitation_result on public.kit_sync_operations;
create trigger apply_waitlist_invitation_result
    after update on public.kit_sync_operations
    for each row execute function public.apply_waitlist_invitation_result();

-- ---------------------------------------------------------------------------
-- 7. The same person, on both lists
-- ---------------------------------------------------------------------------
-- Leif invites 25 off one waitlist and 30 off the other in the same sitting.
-- Somebody can legitimately be waiting for both programmes, and sending them
-- two invitations to apply to two different things on the same morning is
-- not a decision a batch may make quietly.
--
-- Matched on the CONTACT and on the ADDRESS, because the same person can
-- reach the CRM as two contacts and Kit only knows the address — two
-- invitations to one inbox is the thing being prevented, not two rows.
create or replace function public.waitlist_invitation_overlap(
  p_offer_a bigint,
  p_limit_a integer,
  p_offer_b bigint,
  p_limit_b integer
) returns table (
  contact_id_a bigint,
  contact_id_b bigint,
  name text,
  email text,
  joined_a timestamp with time zone,
  joined_b timestamp with time zone
)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  with a as (
    select * from waitlist_invitation_candidates(p_offer_a, null)
     where eligible and rank_if_eligible <= p_limit_a
  ),
  b as (
    select * from waitlist_invitation_candidates(p_offer_b, null)
     where eligible and rank_if_eligible <= p_limit_b
  )
  select a.contact_id, b.contact_id, a.contact_name, a.email,
         a.joined_at, b.joined_at
    from a
    join b on b.contact_id = a.contact_id
           or (a.email is not null and b.email is not null and b.email = a.email)
   order by a.joined_at asc;
$fn$;

revoke all on function public.waitlist_invitation_overlap(bigint, integer, bigint, integer) from public;
grant execute on function public.waitlist_invitation_overlap(bigint, integer, bigint, integer) to authenticated, service_role;
