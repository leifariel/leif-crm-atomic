-- A decision can recommend the other programme, or answer by hand
-- ===========================================================================
--
-- Two decisions an Application review could not record before.
--
-- OFFER THE OTHER PROGRAMME. Leif is willing to work with this person; she
-- thinks the other programme suits them better. That is not a rejection, and
-- the shapes it must not take are the reason this is a migration rather than a
-- UI change:
--
--   * The Application keeps saying what they applied for. Its offer_id, its
--     intended_cohort_id, its questions, its answers and its submitted_at are
--     what happened and are never rewritten.
--   * The SALES path moves. The existing Opportunity is re-pointed at the
--     recommended programme — never duplicated, because two Opportunities for
--     one person's one decision is the duplicate this CRM already refuses
--     everywhere else.
--   * The recommendation is recorded in its own right:
--     applications.recommended_offer_id says which programme, status says the
--     decision, reviewed_at says when.
--
-- The invariant that makes the first two coexist already exists.
-- enforce_application_opportunity_agreement() refuses an Application whose
-- offer disagrees with its Opportunity's — UNLESS a deal_offer_events row
-- records that the Opportunity moved AWAY from the Application's offer. Its
-- own hint says it: a recorded programme change is what "makes the original
-- application legal history". So this reuses that escape clause rather than
-- inventing a second redirect architecture, and the event row is written by a
-- trigger the browser cannot forge — the same posture as
-- enqueue_kit_application_decision().
--
-- BESPOKE ACCEPTANCE / BESPOKE REJECTION. The application IS processed and the
-- outcome IS accepted or rejected; what differs is that Leif answers this one
-- personally. So:
--
--   * Both leave Needs Review, because both set a status that is not 'pending'
--     and both stamp reviewed_at. classifyApplication() and
--     applications_awaiting_review already key on exactly those two facts, so
--     nothing had to learn a new vocabulary to stop asking.
--   * Neither may trigger an automatic reply. That is structural here, not a
--     promise: a bespoke decision has its OWN kit_tag_mappings event, so the
--     approved / not_fit tags that an automation may hang off are never the
--     tags it applies, and a bespoke mapping is REFUSED unless its
--     followup_mode says the email is Leif's to send.

begin;

-- ---------------------------------------------------------------------------
-- 1. The recommendation, recorded as its own fact
-- ---------------------------------------------------------------------------
-- Which programme was recommended. Null for every other decision, including
-- every row that exists today.
alter table public.applications
  add column if not exists recommended_offer_id bigint;

alter table public.applications
  drop constraint if exists applications_recommended_offer_id_fkey;
alter table public.applications
  add constraint applications_recommended_offer_id_fkey
  foreign key (recommended_offer_id) references public.offers(id) on update cascade;

create index if not exists applications_recommended_offer_id_idx
  on public.applications using btree (recommended_offer_id);

alter table public.applications
  drop constraint if exists applications_status_check;
alter table public.applications
  add constraint applications_status_check check (status in (
    'pending',
    'approved',
    'needs_higher_care',
    'not_fit',
    'do_not_engage',
    -- Willing to work with them, in the other programme.
    'offered_other_programme',
    -- Processed, with the reply written by hand.
    'bespoke_accepted',
    'bespoke_rejected',
    -- Historical-import-only vocabulary; no live action sets either.
    'denied',
    'waitlist'
  ));

-- A recommendation names a programme, and nothing else carries one. Without
-- the second half, a corrected decision could leave a stale recommendation
-- pointing somewhere the record no longer says.
alter table public.applications
  drop constraint if exists applications_recommended_offer_agrees_check;
alter table public.applications
  add constraint applications_recommended_offer_agrees_check check (
    (status = 'offered_other_programme') = (recommended_offer_id is not null)
    and (recommended_offer_id is null or recommended_offer_id is distinct from offer_id)
  );

-- ---------------------------------------------------------------------------
-- 2. Kit: three new events, and one of them may never send an email
-- ---------------------------------------------------------------------------
-- The event names are the status names, so enqueue_kit_application_decision()
-- keeps passing new.status straight through and there is no second vocabulary
-- to keep in step.
--
-- One event per decision, per programme — not one tag naming a destination.
-- kit_tag_mappings is keyed (offer_id, event), so (The Living Example,
-- offered_other_programme) and (Growing Yourself Up, offered_other_programme)
-- are already two different tags, which is exactly the two cross-programme
-- messages Leif wants.
alter table public.kit_tag_mappings
  drop constraint if exists kit_tag_mappings_event_check;
alter table public.kit_tag_mappings
  add constraint kit_tag_mappings_event_check check (event in (
    'applicant',
    'approved',
    'needs_higher_care',
    'not_fit',
    'offered_other_programme',
    'bespoke_accepted',
    'bespoke_rejected'
  ));

-- A bespoke reply is Leif's to write, by definition. followup_mode is what
-- every surface reads to decide whether to tell her an email is still owed, so
-- a bespoke mapping that claimed a Kit automation would be the CRM telling her
-- somebody had already been answered. Refused.
alter table public.kit_tag_mappings
  drop constraint if exists kit_tag_mappings_bespoke_is_manual_check;
alter table public.kit_tag_mappings
  add constraint kit_tag_mappings_bespoke_is_manual_check check (
    event not in ('bespoke_accepted', 'bespoke_rejected')
    or followup_mode = 'manual_email'
  );

-- And set it, rather than making Leif know to. set_program_kit_tag() is the
-- only door onto this table, and this trigger covers the migration and
-- service-role paths too.
--
-- It also closes the one footgun the constraint above cannot see. Forcing
-- followup_mode says what the CRM will TELL Leif; it does not stop the tag
-- itself from being the one an approval automation hangs off. Mapping
-- bespoke_accepted to MiniDD_Approved would send the standard letter to
-- somebody she meant to answer personally, and followup_mode would sit there
-- reading "manual_email" while it happened.
--
-- Kit's automation topology is unreadable from here, so this does not claim to
-- know which tags send. It refuses the thing it CAN see: a bespoke decision
-- sharing a tag with the same programme's approved, not_fit or
-- offered_other_programme event. A dedicated tag is the whole point of giving
-- these decisions their own event.
create or replace function public.enforce_bespoke_kit_separation()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_bespoke constant text[] := array['bespoke_accepted', 'bespoke_rejected'];
  v_sending constant text[] := array['approved', 'not_fit', 'offered_other_programme'];
  v_clash text;
begin
  if new.event = any (v_bespoke) then
    new.followup_mode := 'manual_email';
    new.automation_name := null;

    select m.event into v_clash
      from kit_tag_mappings m
     where m.offer_id = new.offer_id
       and m.event = any (v_sending)
       and m.kit_tag_id = new.kit_tag_id
     limit 1;
    if v_clash is not null then
      raise exception
        'Tag % is already this programme''s % tag, so a bespoke decision cannot use it',
        new.kit_tag_name, v_clash
        using hint = 'A bespoke decision must apply a tag of its own, because an automation attached to the shared one would send the standard reply to somebody you meant to answer yourself.';
    end if;
  end if;

  -- And the same refusal from the other direction, so the order the two
  -- mappings are configured in cannot decide whether the rule holds.
  if new.event = any (v_sending) then
    select m.event into v_clash
      from kit_tag_mappings m
     where m.offer_id = new.offer_id
       and m.event = any (v_bespoke)
       and m.kit_tag_id = new.kit_tag_id
     limit 1;
    if v_clash is not null then
      raise exception
        'Tag % is already this programme''s % tag, so it cannot also be the % tag',
        new.kit_tag_name, v_clash, new.event
        using hint = 'A bespoke decision must apply a tag of its own, because an automation attached to the shared one would send the standard reply to somebody you meant to answer yourself.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists on_kit_tag_mapping_bespoke_followup on public.kit_tag_mappings;
create trigger on_kit_tag_mapping_bespoke_followup
  before insert or update on public.kit_tag_mappings
  for each row execute function public.enforce_bespoke_kit_separation();

create or replace function public.set_program_kit_tag(
  p_offer_id bigint,
  p_event text,
  p_kit_tag_id bigint,
  p_kit_tag_name text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (select 1 from offers where id = p_offer_id) then
    return jsonb_build_object('status', 'offer-invalid');
  end if;
  if p_event not in (
    'applicant', 'approved', 'needs_higher_care', 'not_fit',
    'offered_other_programme', 'bespoke_accepted', 'bespoke_rejected'
  ) then
    return jsonb_build_object('status', 'event-invalid');
  end if;

  -- Clearing is legitimate: a programme may stop being Kit-managed, and the
  -- honest way to say that is to have no mapping rather than a wrong one.
  if p_kit_tag_id is null then
    delete from kit_tag_mappings where offer_id = p_offer_id and event = p_event;
    return jsonb_build_object('status', 'cleared', 'offer_id', p_offer_id, 'event', p_event);
  end if;

  if p_kit_tag_id <= 0 or btrim(coalesce(p_kit_tag_name, '')) = '' then
    return jsonb_build_object('status', 'tag-invalid');
  end if;

  -- A named answer rather than a raised exception, so the picker can say what
  -- happened. enforce_bespoke_kit_separation() refuses it either way — this is
  -- the readable version of the same rule, not a softer one.
  if exists (
    select 1 from kit_tag_mappings m
     where m.offer_id = p_offer_id
       and m.kit_tag_id = p_kit_tag_id
       and m.event <> p_event
       and (
         (p_event in ('bespoke_accepted', 'bespoke_rejected')
            and m.event in ('approved', 'not_fit', 'offered_other_programme'))
         or (p_event in ('approved', 'not_fit', 'offered_other_programme')
            and m.event in ('bespoke_accepted', 'bespoke_rejected'))
       )
  ) then
    return jsonb_build_object(
      'status', 'tag-already-used-by-another-decision',
      'offer_id', p_offer_id, 'event', p_event);
  end if;

  insert into kit_tag_mappings (offer_id, event, kit_tag_id, kit_tag_name)
  values (p_offer_id, p_event, p_kit_tag_id, btrim(p_kit_tag_name))
  on conflict (offer_id, event) do update
    set kit_tag_id = excluded.kit_tag_id,
        kit_tag_name = excluded.kit_tag_name;

  return jsonb_build_object(
    'status', 'set', 'offer_id', p_offer_id, 'event', p_event,
    'kit_tag_id', p_kit_tag_id, 'kit_tag_name', btrim(p_kit_tag_name));
end;
$$;

-- Which decisions reach Kit at all. do_not_engage stays absent for the reason
-- it always was: that decision stays inside the CRM. The two bespoke outcomes
-- are present because Leif asked for their own tags — a tag is a record of
-- what was decided, and it is the mapping, not the tag's existence, that
-- decides whether anything is sent.
create or replace function public.enqueue_kit_application_decision()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.status = 'pending'
     and new.status in (
       'approved', 'needs_higher_care', 'not_fit',
       'offered_other_programme', 'bespoke_accepted', 'bespoke_rejected'
     )
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

-- ---------------------------------------------------------------------------
-- 3. The programme change, recorded where the existing invariant looks
-- ---------------------------------------------------------------------------
-- deal_offer_events is deliberately not writable by a browser: forging offer
-- history is how an Application's disagreement with its Opportunity could be
-- made to look legal. So the row is written by the database, as a consequence
-- of a decision that is already recorded, and only then.
--
-- Disjoint from transfer_enrolled_opportunity_offer() by construction: that
-- one requires an Enrollment and this one refuses to exist alongside one, so
-- the two authorities can never both write a row for the same move.
create or replace function public.record_recommended_programme_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not exists (
    select 1 from applications a
     where a.opportunity_id = new.id
       and a.status = 'offered_other_programme'
       and a.recommended_offer_id = new.offer_id
  ) then
    return null;
  end if;

  if exists (select 1 from enrollments where opportunity_id = new.id) then
    return null;
  end if;

  -- A replay cannot double the history.
  if exists (
    select 1 from deal_offer_events e
     where e.opportunity_id = new.id
       and e.from_offer_id = old.offer_id
       and e.to_offer_id = new.offer_id
  ) then
    return null;
  end if;

  insert into deal_offer_events
    (opportunity_id, enrollment_id, from_offer_id, to_offer_id, source, note)
  values
    (new.id, null, old.offer_id, new.offer_id, 'app',
     'The sales path moved because their application was answered with a recommendation to the other programme. The application itself still records the programme they applied for.');

  return null;
end;
$$;

drop trigger if exists on_deal_recommended_programme_change on public.deals;
create trigger on_deal_recommended_programme_change
  after update of offer_id on public.deals
  for each row
  when (old.offer_id is distinct from new.offer_id)
  execute function public.record_recommended_programme_change();

-- ---------------------------------------------------------------------------
-- 4. review_application(), with three more answers
-- ---------------------------------------------------------------------------
-- Same lock, same refusals, same one transaction. Everything that can refuse
-- the new outcomes is checked BEFORE the first write, so a refusal is still a
-- state in which nothing happened.
create or replace function public.review_application(
  p_application_id bigint,
  p_outcome text
) returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  v_app applications%rowtype;
  v_deal deals%rowtype;
  v_task_id bigint;
  v_reviewed_at timestamptz;
  v_recommended_offer_id bigint;
  v_recommended offers%rowtype;
  v_candidates int;
begin
  -- The decisions a live review can record. 'denied' and 'waitlist' are
  -- historical-import vocabulary and are not decisions anybody makes here.
  IF p_outcome NOT IN (
    'approved', 'needs_higher_care', 'not_fit', 'do_not_engage',
    'offered_other_programme', 'bespoke_accepted', 'bespoke_rejected'
  ) THEN
    RETURN jsonb_build_object('status', 'outcome-invalid', 'outcome', p_outcome);
  END IF;

  -- The lock, and the whole point of this function. Everything below decides
  -- from state nobody else can move until this transaction ends.
  SELECT * INTO v_app FROM applications WHERE id = p_application_id FOR UPDATE;
  IF v_app.id IS NULL THEN
    RETURN jsonb_build_object('status', 'application-invalid');
  END IF;

  -- Re-read under the lock. A second reviewer arriving at the same moment
  -- waits here, then finds the decision already recorded and is told which —
  -- rather than both reading 'pending' and the last writer silently winning.
  IF v_app.status <> 'pending' THEN
    RETURN jsonb_build_object(
      'status', 'already-reviewed',
      'application_id', v_app.id,
      'application_status', v_app.status,
      'reviewed_at', v_app.reviewed_at
    );
  END IF;

  -- Every outcome writes to the Application AND its Opportunity, so there is
  -- nothing to record a decision against without one.
  IF v_app.opportunity_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no-opportunity', 'application_id', v_app.id);
  END IF;

  SELECT * INTO v_deal FROM deals WHERE id = v_app.opportunity_id FOR UPDATE;
  IF v_deal.id IS NULL THEN
    RETURN jsonb_build_object('status', 'opportunity-invalid', 'opportunity_id', v_app.opportunity_id);
  END IF;

  IF v_deal.contact_id IS DISTINCT FROM v_app.contact_id THEN
    RETURN jsonb_build_object(
      'status', 'opportunity-mismatch',
      'opportunity_id', v_deal.id,
      'opportunity_contact_id', v_deal.contact_id,
      'application_contact_id', v_app.contact_id
    );
  END IF;

  -- ---- what recommending the other programme needs before it writes -------
  IF p_outcome = 'offered_other_programme' THEN
    -- Direction is not asked, because there is only one other programme to
    -- move to. If that ever stops being true this refuses rather than
    -- guessing which one Leif meant.
    SELECT count(*), min(id) INTO v_candidates, v_recommended_offer_id
      FROM offers WHERE is_active AND id IS DISTINCT FROM v_deal.offer_id;
    IF v_candidates <> 1 THEN
      RETURN jsonb_build_object(
        'status', 'recommendation-ambiguous',
        'candidates', v_candidates
      );
    END IF;
    SELECT * INTO v_recommended FROM offers WHERE id = v_recommended_offer_id;

    -- An enrolled client's programme is not an application decision. That
    -- move is transfer_enrolled_opportunity_offer()'s, because it has to
    -- carry an onboarding checklist and its Tasks with it.
    IF EXISTS (SELECT 1 FROM enrollments WHERE opportunity_id = v_deal.id) THEN
      RETURN jsonb_build_object('status', 'already-enrolled', 'opportunity_id', v_deal.id);
    END IF;

    -- handle_deal_saved() refuses an offer change while a scholarship slot is
    -- held. Named here so the page can say why instead of showing a raised
    -- exception.
    IF v_deal.pricing_mode = 'scholarship' THEN
      RETURN jsonb_build_object('status', 'scholarship-held', 'opportunity_id', v_deal.id);
    END IF;
  END IF;

  v_reviewed_at := now();

  -- 1. The decision itself. This UPDATE is what fires
  --    on_application_kit_decision, inside this transaction, once.
  UPDATE applications
     SET status = p_outcome,
         reviewed_at = v_reviewed_at,
         recommended_offer_id = v_recommended_offer_id
   WHERE id = v_app.id;

  -- 2. The Opportunity, aligned with it.
  IF p_outcome = 'approved' THEN
    -- "Qualified enough for a sales call" — the pipeline moves forward; final
    -- personal fit is still undecided. outcome is explicitly re-cleared in
    -- case a prior review round set one.
    UPDATE deals SET stage = 'approved', outcome = NULL WHERE id = v_deal.id;
  ELSIF p_outcome = 'bespoke_accepted' THEN
    -- Accepted is accepted. The only thing bespoke changes is who writes the
    -- reply, so the operational approved path stays exactly as available.
    UPDATE deals SET stage = 'approved', outcome = NULL WHERE id = v_deal.id;
  ELSIF p_outcome = 'offered_other_programme' THEN
    -- The sales path moves to the recommended programme and behaves like that
    -- programme's approved path. The SAME Opportunity: nothing here creates a
    -- second one.
    --
    -- A round belongs to the programme that has rounds. Moving into an
    -- individual programme leaves any cohort behind, exactly as
    -- transfer_enrolled_opportunity_offer() does, and moving into a group
    -- programme does not pick one — that is a later conversation, and
    -- handle_deal_saved() is content with a group Opportunity that has no
    -- cohort yet.
    UPDATE deals
       SET offer_id = v_recommended_offer_id,
           cohort_id = CASE WHEN v_recommended.type = 'group' THEN cohort_id ELSE NULL END,
           stage = 'approved',
           outcome = NULL
     WHERE id = v_deal.id;
  ELSIF p_outcome = 'needs_higher_care' THEN
    UPDATE deals SET outcome = 'needs_higher_care' WHERE id = v_deal.id;
  ELSIF p_outcome = 'not_fit' THEN
    UPDATE deals SET outcome = 'not_fit' WHERE id = v_deal.id;
  ELSIF p_outcome = 'bespoke_rejected' THEN
    -- Rejected is rejected, and reads as the same exit everywhere that counts
    -- exits. Only the reply is different.
    UPDATE deals SET outcome = 'not_fit' WHERE id = v_deal.id;
  ELSE
    UPDATE deals SET outcome = 'lost', owner_decision = 'do_not_engage' WHERE id = v_deal.id;
    -- The durable Contact-level gate. Never erases the Contact, never touches
    -- unrelated history.
    UPDATE contacts SET sales_eligibility = 'do_not_engage' WHERE id = v_app.contact_id;
  END IF;

  -- 3. The Review Application task closes because the review happened — never
  --    the reverse. Same heuristic as reviewApplicationTask.ts: the oldest
  --    still-open review_application task for this Contact.
  SELECT t.id INTO v_task_id
    FROM tasks t
   WHERE t.contact_id = v_app.contact_id
     AND t.type = 'review_application'
     AND t.done_date IS NULL
   ORDER BY t.id ASC
   LIMIT 1;

  IF v_task_id IS NOT NULL THEN
    UPDATE tasks
       SET done_date = v_reviewed_at,
           status = 'completed'
     WHERE id = v_task_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'reviewed',
    'application_id', v_app.id,
    'application_status', p_outcome,
    'opportunity_id', v_deal.id,
    'reviewed_at', v_reviewed_at,
    'recommended_offer_id', v_recommended_offer_id,
    'completed_task_id', v_task_id
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Nobody may call the trigger bodies
-- ---------------------------------------------------------------------------
-- record_recommended_programme_change() is SECURITY DEFINER because
-- deal_offer_events is deliberately closed to a browser. A SECURITY DEFINER
-- function a browser may EXECUTE is the escalation that closure exists to
-- prevent, so it is revoked the same way enqueue_kit_application_decision()
-- already is.
revoke all on function public.record_recommended_programme_change() from public;
revoke all on function public.record_recommended_programme_change() from anon;
revoke all on function public.record_recommended_programme_change() from authenticated;
revoke all on function public.enforce_bespoke_kit_separation() from public;
revoke all on function public.enforce_bespoke_kit_separation() from anon;
revoke all on function public.enforce_bespoke_kit_separation() from authenticated;

commit;
