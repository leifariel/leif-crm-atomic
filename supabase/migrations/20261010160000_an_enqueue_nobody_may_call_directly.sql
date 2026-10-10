-- Restoring a revoke that a DROP silently threw away.
--
-- enqueue_kit_operation() creates an outbox row carrying any tag id for any
-- contact. It is SECURITY DEFINER, and 20260929120000 therefore revoked it
-- from public, anon, authenticated and service_role: the only legitimate
-- callers are the other SECURITY DEFINER functions that have already decided
-- the request is allowed.
--
-- 20261010120000 added a defaulted parameter to it. A new default makes a
-- SECOND function rather than a new version of the first, so that migration
-- dropped the old signature and created the new one — and a created function
-- starts with no ACL at all, which in Postgres means EXECUTE to PUBLIC. The
-- revoke was undone by a drop that had nothing to do with it.
--
-- Found by the production preflight query, which asks of every function in
-- this pathway whether its EXECUTE was granted explicitly or left open. That
-- check is the reason this is a two-line migration rather than an incident:
-- `proacl is null` is easy to read past and impossible to miss once asked.
revoke all on function public.enqueue_kit_operation(
  bigint, bigint, text, text, bigint, text, text, bigint) from public;
revoke all on function public.enqueue_kit_operation(
  bigint, bigint, text, text, bigint, text, text, bigint) from anon;
revoke all on function public.enqueue_kit_operation(
  bigint, bigint, text, text, bigint, text, text, bigint) from authenticated;
revoke all on function public.enqueue_kit_operation(
  bigint, bigint, text, text, bigint, text, text, bigint) from service_role;

-- The same for the trigger function added alongside it. Nothing calls a
-- trigger function by name — the trigger does — so an EXECUTE grant on it is
-- surface with no purpose, and this repository's posture is that a function
-- states who may call it.
revoke all on function public.apply_waitlist_invitation_result() from public;
revoke all on function public.apply_waitlist_invitation_result() from anon;
revoke all on function public.apply_waitlist_invitation_result() from authenticated;
revoke all on function public.apply_waitlist_invitation_result() from service_role;
