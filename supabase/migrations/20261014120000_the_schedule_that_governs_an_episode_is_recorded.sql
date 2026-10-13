-- WHICH CALENDAR GOVERNS THIS EPISODE.
--
-- Phase 2A gave an Application Outreach attempt a `step` and a
-- `next_action_at` but never said what schedule those belong to. One global
-- schedule forever was an assumption, not a recorded fact: the moment Leif
-- changes the sequence, every historical attempt would be reinterpreted
-- under the new calendar and the record of what was actually planned for
-- somebody would be gone.
--
-- So the governing schedule becomes provenance, like `source` and
-- `started_at` before it.
--
-- WHY A CHECKED KEY RATHER THAN A VERSION TABLE. The calendar is four day
-- offsets and a terminal rule. It is not row data: nobody edits it at
-- runtime, nothing joins to it, and execution will live in a Gmail worker
-- that reads `step` and `started_at`. A table would add a join and an FK to
-- protect no invariant this CHECK does not already protect, while giving the
-- calendar a second home to drift in. The database owns schedule IDENTITY;
-- `applicationOutreachSchedule.ts` owns the arithmetic, and
-- contracts/outreach/oneOutreachScheduleAuthority.test.ts keeps it the only
-- place that does.
--
-- WHY THERE IS NO DEFAULT. A default is how a v2 writer silently records v1.
-- Every writer must say which schedule governs the episode it is creating.
-- The table holds 0 rows today, so this costs nothing and fails closed
-- forever after.
alter table public.application_outreach_attempts
    add column if not exists schedule_key text not null;

comment on column public.application_outreach_attempts.schedule_key is
    'Which Application Outreach calendar governs this episode (immutable after insert). application_outreach_v1 is Day 0 invitation, Day 3 / 10 / 24 reminders, Day 31 close to Nurture. Offsets are absolute from started_at. The arithmetic lives in src/components/atomic-crm/outreach/applicationOutreachSchedule.ts.';

-- A new calendar is a deliberate, reviewed act: adding a version means a
-- migration, and an unknown value is refused rather than guessed at.
alter table public.application_outreach_attempts
    drop constraint if exists application_outreach_attempts_schedule_key_check;

alter table public.application_outreach_attempts
    add constraint application_outreach_attempts_schedule_key_check
        check (schedule_key in ('application_outreach_v1'));

-- The guard gains one column. A historical attempt must never change from v1
-- to v2 because the current default moved on; that is precisely the
-- reinterpretation this column exists to prevent.
create or replace function public.guard_outreach_attempt_mutation()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  -- The backfill of the 11 Oct invitations runs as a migration and may need
  -- to correct what it wrote; the same hatch every other guard here uses.
  if current_setting('app.migration_mode', true) = 'true' then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.opportunity_id is distinct from old.opportunity_id
     or new.source is distinct from old.source
     or new.started_at is distinct from old.started_at
     or new.schedule_key is distinct from old.schedule_key
     or new.waitlist_invitation_id is distinct from old.waitlist_invitation_id
     or new.created_at is distinct from old.created_at
  then
    raise exception
      'application_outreach_attempts: identity and provenance are immutable'
      using hint = 'id, opportunity_id, source, started_at, schedule_key, waitlist_invitation_id and created_at describe an episode that already happened. A different Opportunity, source, schedule or invitation is a different episode: insert a new attempt.';
  end if;

  if old.status = 'closed' then
    raise exception
      'application_outreach_attempts: a closed attempt is history and cannot be changed'
      using hint = 'Re-inviting somebody starts a NEW attempt beside this one. Closed attempts are never reopened, so the record of what was tried before survives.';
  end if;

  -- Set by the database, never taken from the caller.
  new.updated_at := now();
  return new;
end;
$$;
