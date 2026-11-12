-- A STAGE EDIT CANNOT CONTRADICT THE CALL.
--
-- Porsche Brown, Opportunity 217, 2026-10-29. Her call was completed as
-- "they said yes": accept_sale() moved her to Won and created Enrollment
-- 130. Twenty-three seconds later the Opportunity's stage was changed by
-- hand to Decision, to fix the result. The stage moved and nothing else
-- did, leaving
--
--   stage = decision · prospect_decision = yes · follow_up_date = null
--   · no Decision follow-up Task · Enrollment 130 withdrawn
--
-- a sale at Decision whose own record says the prospect already said yes.
-- Every canonical writer of a call result keeps prospect_decision and stage
-- in step (accept_sale() writes won + yes together; the correction command
-- writes thinking + decision + the follow-up together). A raw stage edit is
-- the only path that can split them.
--
-- So the split is refused, with a message naming the right tool -- Edit
-- call result, correct_completed_sales_call() -- rather than inferred into a
-- correction. A stage field must not quietly become a second way to rewrite
-- what happened on a call.
--
-- A row already in contradiction (Porsche, until her result is corrected)
-- may still have unrelated fields saved; what is refused is ENTERING the
-- contradiction, or moving the stage while in it. The correction command
-- itself takes her out of it. Historical/migration-mode writes are exempt,
-- like every other deals guard.
--
-- Deterministic: one function and one trigger, no rows touched. The app
-- mirror and the refusal's wording live in deals/stageEditRefusal.ts.

begin;

CREATE OR REPLACE FUNCTION public.guard_deal_stage_against_call_result()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if current_setting('app.migration_mode', true) = 'true' then
    return new;
  end if;

  if new.prospect_decision = 'yes'
     and new.outcome is null
     and new.archived_at is null
     and new.stage <> 'won'
     and not (
       tg_op = 'UPDATE'
       and old.prospect_decision = 'yes'
       and old.outcome is null
       and old.archived_at is null
       and old.stage <> 'won'
       and new.stage is not distinct from old.stage
     )
  then
    raise exception
      'call_result_owns_stage: Opportunity % records that the prospect said yes, so it cannot be at stage "%". Change the call result with correct_completed_sales_call (Edit call result), not the stage.',
      new.id, new.stage
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$
;

drop trigger if exists guard_deal_stage_against_call_result on public.deals;
CREATE TRIGGER guard_deal_stage_against_call_result BEFORE INSERT OR UPDATE OF stage, prospect_decision, outcome, archived_at ON public.deals FOR EACH ROW EXECUTE FUNCTION guard_deal_stage_against_call_result();

-- A trigger function is never an API: same posture as the other deals guards.
revoke all on function public.guard_deal_stage_against_call_result() from public, anon, authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = 'deals' and t.tgname = 'guard_deal_stage_against_call_result'
       and not t.tgisinternal
  ) then
    raise exception 'the call-result stage guard is not attached to deals';
  end if;
end;
$$;

commit;
