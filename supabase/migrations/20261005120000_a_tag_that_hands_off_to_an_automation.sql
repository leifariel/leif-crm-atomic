-- What happens after a Needs Higher Care tag lands.
--
-- The CRM told Leif, on every Needs Higher Care decision: "Needs Higher Care
-- email still needs to be sent manually." That was true when Kit Core
-- shipped and is now false for both programmes. He has written the
-- automations:
--
--   Growing Yourself Up   tag GYU-NeedsHigherCare     -> GYU_NeedsHigherCare
--   The Living Example    tag MiniDD_NeedsHigherCare  -> MiniDD_NeedsHigherCare
--
-- Mini Deep Dive is The Living Example's sales pathway, not a separate
-- offer. The MiniDD_* names are Kit's; the mapping belongs to offer 1.
--
-- The tag name and the automation name are DIFFERENT external identifiers —
-- note GYU's hyphen against its automation's underscore. Both are correct.
-- Nothing here renames, recreates or normalizes a tag: kit_tag_id and
-- kit_tag_name are untouched, and the automation name is stored beside them.

alter table public.kit_tag_mappings
    add column if not exists followup_mode text not null default 'none';
alter table public.kit_tag_mappings
    drop constraint if exists kit_tag_mappings_followup_mode_check;
alter table public.kit_tag_mappings
    add constraint kit_tag_mappings_followup_mode_check
    check (followup_mode in ('none', 'manual_email', 'kit_automation'));

alter table public.kit_tag_mappings
    add column if not exists automation_name text;
alter table public.kit_tag_mappings
    drop constraint if exists kit_tag_mappings_automation_name_check;
alter table public.kit_tag_mappings
    add constraint kit_tag_mappings_automation_name_check
    check (
        (automation_name is null or btrim(automation_name) <> '')
        and (automation_name is null or followup_mode = 'kit_automation')
    );

-- Only the two mappings Leif has characterised. Every other mapping keeps
-- the 'none' default, because nobody has said what happens after those tags
-- and inventing an answer is how a CRM starts lying quietly.
--
-- Matched on the TAG the mapping already holds, not on the offer alone, so
-- this cannot land on a row that has been repointed at a different tag since
-- this was written.
update public.kit_tag_mappings
   set followup_mode = 'kit_automation',
       automation_name = 'GYU_NeedsHigherCare'
 where offer_id = 2
   and event = 'needs_higher_care'
   and kit_tag_name = 'GYU-NeedsHigherCare';

update public.kit_tag_mappings
   set followup_mode = 'kit_automation',
       automation_name = 'MiniDD_NeedsHigherCare'
 where offer_id = 1
   and event = 'needs_higher_care'
   and kit_tag_name = 'MiniDD_NeedsHigherCare';

-- Self-proving. These two mappings are themselves seeded by migration
-- (20260929120000), so they exist in any correctly replayed database and
-- this may assert rather than hope. It asserts the SHAPE, never a count of
-- rows written, so it replays into an empty database unchanged.
do $$
declare
  v_configured int;
  v_leaked int;
begin
  select count(*) into v_configured
    from public.kit_tag_mappings
   where event = 'needs_higher_care'
     and followup_mode = 'kit_automation'
     and automation_name is not null;
  if v_configured <> 2 then
    raise exception
      'expected both Needs Higher Care mappings to hand off to an automation, found %',
      v_configured;
  end if;

  -- Nothing else was touched: no other mapping may have acquired a
  -- follow-up mode from this migration.
  select count(*) into v_leaked
    from public.kit_tag_mappings
   where event <> 'needs_higher_care'
     and followup_mode <> 'none';
  if v_leaked <> 0 then
    raise exception
      'this migration must only characterise Needs Higher Care, but % other mapping(s) are configured',
      v_leaked;
  end if;

  -- The tags themselves are untouched, by id and by exact name.
  if not exists (
    select 1 from public.kit_tag_mappings
     where offer_id = 2 and event = 'needs_higher_care'
       and kit_tag_id = 24082732 and kit_tag_name = 'GYU-NeedsHigherCare'
       and automation_name = 'GYU_NeedsHigherCare'
  ) then
    raise exception 'Growing Yourself Up Needs Higher Care mapping is not as expected';
  end if;

  if not exists (
    select 1 from public.kit_tag_mappings
     where offer_id = 1 and event = 'needs_higher_care'
       and kit_tag_id = 24082725 and kit_tag_name = 'MiniDD_NeedsHigherCare'
       and automation_name = 'MiniDD_NeedsHigherCare'
  ) then
    raise exception 'The Living Example Needs Higher Care mapping is not as expected';
  end if;
end $$;
