-- THE WRITER HAS TO KNOW EVERY EVENT THE TABLE ALLOWS.
--
-- Leif set "Invited from the waitlist" on The Living Example, got a toast
-- saying it was saved, navigated away, came back — and the row said
-- "Not set". It had never been written.
--
-- `kit_tag_mappings_event_check` allows EIGHT events; `20261010120000` added
-- `waitlist_invited` to it, and to the picker in OfferKitSection.tsx. The
-- WRITER's own list was never extended, so `set_program_kit_tag` still
-- answered
--
--   {"status": "event-invalid"}
--
-- for `waitlist_invited` — proved against production, rolled back. And it
-- answers that as a NAMED STATUS rather than an exception, by design ("a
-- named answer rather than a raised exception, so the picker can say what
-- happened"). PostgREST therefore returned 200, the client checked only for
-- an `error`, and the toast said saved. The picker never looked at the
-- status it was given.
--
-- Two things were wrong and both are fixed in this commit: the list here,
-- and the client's belief that "no error" means "persisted".
--
-- Only this function needed it. `enqueue_kit_application_decision`,
-- `review_application` and `enforce_bespoke_kit_separation` carry
-- similar-looking lists, but those are application STATUSES and review
-- OUTCOMES — a different question, and `waitlist_invited` is correctly
-- absent from all three. This is the one function that validates a MAPPING
-- EVENT, so it is the one that must agree with the table's constraint.
--
-- The duplication is deliberate rather than removed: deriving the set from
-- the constraint at runtime would mean catching `check_violation` and
-- guessing which constraint raised it, and this table has six. So the list
-- stays explicit and `contracts/applications/kitMappingEvents.test.ts`
-- asserts it equals the constraint's set — drift fails a test instead of a
-- silent refusal.
--
-- Deterministic and replay-safe: it replaces a function body and asserts
-- nothing about any row.
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
  -- Every event kit_tag_mappings_event_check allows, and nothing else.
  if p_event not in (
    'applicant', 'approved', 'needs_higher_care', 'not_fit',
    'offered_other_programme', 'bespoke_accepted', 'bespoke_denied',
    'waitlist_invited'
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
         (p_event in ('bespoke_accepted', 'bespoke_denied')
            and m.event in ('approved', 'not_fit', 'offered_other_programme'))
         or (p_event in ('approved', 'not_fit', 'offered_other_programme')
            and m.event in ('bespoke_accepted', 'bespoke_denied'))
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
