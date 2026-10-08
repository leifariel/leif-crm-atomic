-- Growing Yourself Up asks The Living Example's questions.
--
-- DETERMINISTIC. Canonical configuration, not a repair: it must replay into an
-- empty database, where 20260919090000 has already registered each offer's
-- first form version.
--
-- WHY. Leif was getting short, low-information Growing Yourself Up
-- applications while The Living Example produced much richer ones. The cause
-- was the questions, not the applicants: LE asks five, each with a little
-- description under it, and GYU asked four bare ones with no descriptions at
-- all. Leif's decision is that GYU asks LE's questions, exactly.
--
-- A NEW VERSION, NEVER AN EDIT OF THE OLD ONE. application_form_versions
-- exists so wording can change prospectively: materialize_native_application_
-- responses() stamps each submission from the version current AT THAT MOMENT,
-- and application_responses is immutable afterwards. So every Growing Yourself
-- Up application already submitted keeps the four questions it was actually
-- asked, with its own answers against them. Nothing historical is rewritten,
-- and this migration touches no application_responses row.
--
-- The retired keys (gyu_biggest_challenge, gyu_why_now, gyu_hoped_outcome)
-- simply stop being asked. gyu_commitment_scale is reused, because it is the
-- same question reworded — the same treatment round 1's wording corrections
-- got — and its historical rows keep their own snapshotted text regardless.
--
-- IT ALSO ALIGNS THE LIVING EXAMPLE'S RECORDED WORDING WITH WHAT IT ASKS.
-- The registry stored curly apostrophes ("What's") while the form has always
-- rendered straight ones ("What's"), so question_text was not quite "the exact
-- words, as asked". No applicant-visible copy changes — the rendered form is
-- untouched — and only FUTURE snapshots are affected; historical
-- application_responses rows are immutable and keep exactly what they have.

do $$
declare
  v_gyu bigint;
  v_le bigint;
  v_le_version bigint;
  v_version bigint;
  v_count int;
begin
  select id into v_gyu from public.offers
   where name = 'Growing Yourself Up' and type = 'group';
  select id into v_le from public.offers
   where name = 'The Living Example';

  -- ---------------------------------------------------------------
  -- Growing Yourself Up: a new current version asking LE's questions
  -- ---------------------------------------------------------------
  if v_gyu is not null and not exists (
    select 1 from public.application_form_versions
     where form_key = 'gyu_application_core'
  ) then
    -- Demote first: application_form_versions_one_current_per_offer is a
    -- unique index on (offer_id) where is_current, so two current versions
    -- for one offer can never exist even momentarily.
    update public.application_form_versions
       set is_current = false
     where offer_id = v_gyu and is_current;

    insert into public.application_form_versions
      (form_key, form_label, offer_id, is_current)
    values ('gyu_application_core',
            'Growing Yourself Up application (core questions)',
            v_gyu, true)
    returning id into v_version;

    insert into public.application_form_questions
      (form_version_id, position, question_key, question_text)
    values
      (v_version, 1, 'gyu_main_pattern', 'What''s the main pattern, emotion, or relationship dynamic you''re struggling with right now?'),
      (v_version, 2, 'gyu_prior_attempts', 'What have you already tried to change or shift this?'),
      (v_version, 3, 'gyu_hoped_change', 'How are you hoping to change through working together?'),
      (v_version, 4, 'gyu_hoped_support', 'How are you hoping I will support you?'),
      (v_version, 5, 'gyu_commitment_scale', 'On a scale of 1–10, how committed are you to changing this pattern/way-of-being?');
  end if;

  -- ---------------------------------------------------------------
  -- The Living Example: recorded wording matches what it asks
  -- ---------------------------------------------------------------
  if v_le is not null then
    select id into v_le_version from public.application_form_versions
     where offer_id = v_le and is_current;

    if v_le_version is not null then
  update application_form_questions
     set question_text = 'What''s the main pattern, emotion, or relationship dynamic you''re struggling with right now?'
   where form_version_id = v_le_version and position = 1;
  update application_form_questions
     set question_text = 'What have you already tried to change or shift this?'
   where form_version_id = v_le_version and position = 2;
  update application_form_questions
     set question_text = 'How are you hoping to change through working together?'
   where form_version_id = v_le_version and position = 3;
  update application_form_questions
     set question_text = 'How are you hoping I will support you?'
   where form_version_id = v_le_version and position = 4;
  update application_form_questions
     set question_text = 'On a scale of 1–10, how committed are you to changing this pattern/way-of-being?'
   where form_version_id = v_le_version and position = 5;
    end if;
  end if;

  -- ---------------------------------------------------------------
  -- Prove it landed
  -- ---------------------------------------------------------------
  if v_gyu is not null then
    select count(*) into v_count
      from public.application_form_versions
     where offer_id = v_gyu and is_current;
    if v_count <> 1 then
      raise exception 'Growing Yourself Up must have exactly one current form version, found %', v_count;
    end if;

    select count(*) into v_count
      from public.application_form_questions q
      join public.application_form_versions v on v.id = q.form_version_id
     where v.offer_id = v_gyu and v.is_current;
    if v_count <> 5 then
      raise exception 'the current Growing Yourself Up form must ask 5 questions, found %', v_count;
    end if;

    -- Keys stay offer-namespaced: a GYU answer must never report itself as a
    -- Living Example one.
    select count(*) into v_count
      from public.application_form_questions q
      join public.application_form_versions v on v.id = q.form_version_id
     where v.offer_id = v_gyu and v.is_current
       and q.question_key not like 'gyu\_%';
    if v_count <> 0 then
      raise exception '% current Growing Yourself Up question(s) are not gyu_-prefixed', v_count;
    end if;
  end if;

  -- And both offers now ask the same words in the same order.
  if v_gyu is not null and v_le is not null then
    select count(*) into v_count
      from public.application_form_questions g
      join public.application_form_versions gv
        on gv.id = g.form_version_id and gv.offer_id = v_gyu and gv.is_current
      full join (
        select q.position, q.question_text
          from public.application_form_questions q
          join public.application_form_versions v
            on v.id = q.form_version_id and v.offer_id = v_le and v.is_current
      ) l on l.position = g.position and l.question_text = g.question_text
     where g.id is null or l.position is null;
    if v_count <> 0 then
      raise exception
        'the two forms do not ask the same words in the same order (% mismatched position(s))',
        v_count;
    end if;
  end if;
end $$;
